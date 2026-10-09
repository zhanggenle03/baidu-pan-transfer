// ==UserScript==
// @name         百度网盘批量转存助手（跨浏览器版）
// @namespace    https://github.com/kola-official/baidu-transfer-helper
// @version      1.2.1
// @description  自动递归拆分并转存超过数量限制的百度网盘分享目录，支持自定义每个文件夹保存的文件数量
// @match        https://pan.baidu.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BaiduTransferCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ROOT_URL = "https://pan.baidu.com";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class BaiduPanError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "BaiduPanError";
      this.errno = options.errno;
      this.response = options.response;
    }
  }

  // 列出分享目录失败（所有路径候选都不可用）——此时该目录尚未转存任何文件，可安全降级为整体转存
  class ShareListError extends BaiduPanError {
    constructor(message, options = {}) {
      super(message, options);
      this.name = "ShareListError";
    }
  }

  function normalizeDestination(input = "") {
    const value = String(input).trim();
    if (!value || value === "/") return "";
    const parts = value
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) {
      throw new BaiduPanError("目标目录不能包含 . 或 ..");
    }
    return `/${parts.join("/")}`;
  }

  function extractShareKey(input) {
    if (!input) return null;
    let value = String(input).trim();
    try {
      value = decodeURIComponent(value);
    } catch (_) {}
    const pathMatch = value.match(/\/s\/1([^/?#\s]+)/i);
    if (pathMatch) return pathMatch[1];
    const queryMatch = value.match(/[?&]surl=([^&#\s]+)/i);
    return queryMatch ? queryMatch[1] : null;
  }

  function encodePath(path) {
    return encodeURIComponent(path).replace(/%2F/gi, "/");
  }

  function parseSharePage(html) {
    const marker = "locals.mset(";
    const start = html.indexOf(marker);
    if (start < 0) {
      if (/share\/init|请输入提取码|提取码/.test(html)) {
        throw new BaiduPanError("分享需要提取码，或提取码不正确");
      }
      throw new BaiduPanError("无法解析分享页，链接可能已失效或百度页面结构已更新");
    }
    const jsonStart = start + marker.length;
    const end = html.indexOf("});", jsonStart);
    if (end < 0) throw new BaiduPanError("分享页数据不完整");
    let data;
    try {
      data = JSON.parse(html.slice(jsonStart, end + 1));
    } catch (error) {
      throw new BaiduPanError(`分享页数据解析失败：${error.message}`);
    }
    const files = Array.isArray(data.file_list) ? data.file_list : [];
    if (!data.shareid || !data.share_uk || files.length === 0) {
      throw new BaiduPanError("分享页没有可转存的文件，或分享已失效");
    }
    return {
      userId: data.share_uk,
      shareId: data.shareid,
      bdstoken: data.bdstoken,
      shareRoot: files[0].parent_path || "/",
      directories: files
        .filter((item) => Number(item.isdir) === 1)
        .map((item) => ({ id: item.fs_id, name: item.server_filename, isDirectory: true, path: item.path })),
      files: files
        .filter((item) => Number(item.isdir) !== 1)
        .map((item) => ({ id: item.fs_id, name: item.server_filename, isDirectory: false, path: item.path }))
    };
  }

  class BaiduPanTransfer {
    constructor(options = {}) {
      this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
      this.onProgress = options.onProgress || (() => {});
      this.rootUrl = options.rootUrl || ROOT_URL;
      this.batchSize = options.batchSize || 100;
      this.maxRetries = options.maxRetries ?? 12;
      this.destination = normalizeDestination(options.destination || "");
      // 每个目标文件夹最多保存的文件数；0 表示不限制（沿用百度自动拆分逻辑）
      this.maxFilesPerFolder = Math.max(0, Math.floor(Number(options.maxFilesPerFolder) || 0));
      // 分批子文件夹名前缀（会剔除路径分隔符），实际名称为 `${前缀}${序号}`
      this.folderPrefix = String(options.folderPrefix == null ? "" : options.folderPrefix).replace(/[/\\]/g, "");
      // 展开目录失败（如列表接口受限）时，是否降级为整体转存该目录，避免整个任务中断（默认开启）
      this.fallbackOnExpandError = options.fallbackOnExpandError === undefined ? true : !!options.fallbackOnExpandError;
      // 分批之间的间隔毫秒数，用于降低触发百度限流（请求超时/过快的概率）
      this.requestDelay = options.requestDelay === undefined ? 600 : Math.max(0, Number(options.requestDelay) || 0);
      this.transferredAny = false;
      this.bdstoken = null;
      this.shareId = null;
      this.userId = null;
      this.shareRoot = "/";
      this.directories = [];
      this.files = [];
    }

    progress(message) {
      this.onProgress(String(message));
    }

    // 拼接路径并合并多余斜杠
    joinPath(base, name) {
      return `${base || ""}/${name}`.replace(/\/+/g, "/");
    }

    // 分批子文件夹名称，例如前缀 "批" → "批1"、前缀空 → "1"
    partFolderName(index) {
      return `${this.folderPrefix}${index}`;
    }

    // 判断错误是否属于「可重试」的限流/超时类（其余一律不重试）
    isRetryableError(error) {
      if (!error) return false;
      const errno = Number(error.errno);
      if (errno === 111 || errno === 1504) return true;
      return /请求过快|请求超时|过于频繁|稍后再试|访问频繁|系统繁忙|人数过多|too\s*(frequent|many)|try\s*again/i.test(
        String(error.message || "")
      );
    }

    async request(path, options = {}, retry = 0) {
      const method = options.method || "GET";
      const query = options.query ? `?${options.query}` : "";
      const response = await this.fetch(`${this.rootUrl}${path}${query}`, {
        method,
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        body: options.body || undefined,
        credentials: "include"
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = text;
      }
      if (!response.ok) {
        if (retry < this.maxRetries && (response.status === 429 || response.status >= 500)) {
          const delay = Math.min(30000, 2000 * (retry + 1));
          this.progress(`网络请求失败（HTTP ${response.status}），${Math.ceil(delay / 1000)} 秒后重试…`);
          await sleep(delay);
          return this.request(path, options, retry + 1);
        }
        throw new BaiduPanError(`网络请求失败：HTTP ${response.status}`, { response: data });
      }
      if (options.checkErrno && data && typeof data === "object" && Number(data.errno || 0) !== 0) {
        const errno = Number(data.errno);
        const message = data.show_msg || data.errmsg || `百度网盘错误 ${errno}`;
        if (retry < this.maxRetries && this.isRetryableError({ errno, message })) {
          const delay = Math.min(30000, (errno === 111 ? 5000 : 2000) * (retry + 1));
          this.progress(`请求受限（${message}），${Math.ceil(delay / 1000)} 秒后重试…`);
          await sleep(delay);
          return this.request(path, options, retry + 1);
        }
        throw new BaiduPanError(message, { errno, response: data });
      }
      return data;
    }

    async getBdstoken() {
      if (this.bdstoken) return this.bdstoken;
      const data = await this.request("/api/gettemplatevariable", {
        query: `fields=${encodeURIComponent('["bdstoken"]')}`,
        checkErrno: true
      });
      this.bdstoken = data?.result?.bdstoken;
      if (!this.bdstoken) throw new BaiduPanError("未检测到百度网盘登录状态，请先登录");
      return this.bdstoken;
    }

    async verifyShare(shareKey, password) {
      await this.getBdstoken();
      const data = await this.request("/share/verify", {
        method: "POST",
        query: `surl=${encodeURIComponent(shareKey)}&bdstoken=${encodeURIComponent(this.bdstoken)}`,
        body: `pwd=${encodeURIComponent(password || "")}`,
        checkErrno: true
      });
      if (!data.randsk) throw new BaiduPanError("提取码验证失败");
      return data.randsk;
    }

    async loadShare(input, password = "") {
      const shareKey = extractShareKey(input);
      if (!shareKey) throw new BaiduPanError("无法从输入内容中识别百度网盘分享链接");
      if (password) await this.verifyShare(shareKey, password);
      const html = await this.request(`/s/1${shareKey}`);
      const data = parseSharePage(html);
      Object.assign(this, data);
      return data;
    }

    async listDestination(path) {
      return this.request("/api/list", {
        query: [
          "order=time", "desc=1", "showempty=0", "page=1", "num=1000",
          `dir=${encodePath(path)}`, `bdstoken=${encodeURIComponent(this.bdstoken)}`
        ].join("&"),
        checkErrno: true
      });
    }

    async createDirectory(path) {
      if (!path) return;
      try {
        await this.listDestination(path);
        return;
      } catch (error) {
        if (error.errno !== -9) throw error;
      }
      try {
        await this.request("/api/create", {
          method: "POST",
          query: `a=commit&bdstoken=${encodeURIComponent(this.bdstoken)}`,
          body: `path=${encodeURIComponent(path)}&isdir=1&block_list=[]`,
          checkErrno: true
        });
      } catch (error) {
        // -8：目录已存在，视为创建成功
        if (error.errno !== -8) throw error;
      }
    }

    async transferIds(ids, destination, retry = 0) {
      const data = await this.request("/share/transfer", {
        method: "POST",
        query: [
          `shareid=${encodeURIComponent(this.shareId)}`,
          `from=${encodeURIComponent(this.userId)}`,
          "ondup=newcopy", "channel=chunlei",
          `bdstoken=${encodeURIComponent(this.bdstoken)}`
        ].join("&"),
        body: `fsidlist=${encodeURIComponent(JSON.stringify(ids))}&path=${encodeURIComponent(destination || "/")}`
      });
      const errno = Number(data?.errno || 0);
      if (errno === 0) {
        this.transferredAny = true;
        return data;
      }
      const message = data?.show_msg || data?.errmsg || `百度网盘转存错误 ${errno}`;
      if (retry < this.maxRetries && this.isRetryableError({ errno, message })) {
        const delay = Math.min(30000, (errno === 111 ? 5000 : 2000) * (retry + 1));
        this.progress(`请求受限（${message}），${Math.ceil(delay / 1000)} 秒后重试…`);
        await sleep(delay);
        return this.transferIds(ids, destination, retry + 1);
      }
      if (errno === 12) {
        const limit = data.target_file_nums_limit;
        const count = data.target_file_nums;
        throw new BaiduPanError(
          `目录超过单次转存限制${limit && count ? `（${count}/${limit}）` : ""}`,
          { errno, response: data }
        );
      }
      throw new BaiduPanError(message, {
        errno,
        response: data
      });
    }

    // 把一批文件按 batchSize 转存到某个已确定的目录
    async transferFilesPlain(files, destination) {
      if (!files.length) return;
      await this.createDirectory(destination);
      for (let index = 0; index < files.length; index += this.batchSize) {
        const batch = files.slice(index, index + this.batchSize);
        await this.transferIds(batch.map((item) => item.id), destination);
        this.progress(`已转存 ${Math.min(index + batch.length, files.length)}/${files.length} 个文件到 ${destination || "/"}`);
      }
    }

    // 转存文件列表到目标目录；若设置了每夹上限且文件数超限，则拆分为多个子文件夹
    async transferFiles(files, destination) {
      if (!files.length) return;
      const limit = this.maxFilesPerFolder;
      if (limit > 0 && files.length > limit) {
        const parts = Math.ceil(files.length / limit);
        this.progress(`文件数 ${files.length} 超过每夹上限 ${limit}，拆分为 ${parts} 个子文件夹…`);
        for (let index = 0; index < files.length; index += limit) {
          const part = Math.floor(index / limit) + 1;
          const partDestination = this.joinPath(destination, this.partFolderName(part));
          if (index > 0 && this.requestDelay) await sleep(this.requestDelay);
          await this.transferFilesPlain(files.slice(index, index + limit), partDestination);
        }
        return;
      }
      await this.transferFilesPlain(files, destination);
    }

    async listShareDirectory(dirValue, raw = false) {
      const dirParam = raw ? dirValue : encodePath(dirValue);
      const result = [];
      for (let page = 1; ; page += 1) {
        const data = await this.request("/share/list", {
          query: [
            `uk=${encodeURIComponent(this.userId)}`,
            `shareid=${encodeURIComponent(this.shareId)}`,
            "order=name", "desc=0", "showempty=0",
            "web=1", "channel=chunlei", "clienttype=0", "app_id=250528",
            `bdstoken=${encodeURIComponent(this.bdstoken || "")}`,
            `t=${Date.now()}`,
            `page=${page}`, "num=100", `dir=${dirParam}`
          ].join("&"),
          checkErrno: true
        });
        if (!data || typeof data !== "object" || !Array.isArray(data.list)) {
          const snippet = typeof data === "string"
            ? data.replace(/\s+/g, " ").trim().slice(0, 160)
            : JSON.stringify(data).slice(0, 160);
          throw new BaiduPanError(`分享目录列表返回异常（dir=${dirValue}）：${snippet}`, { response: data });
        }
        const list = data.list;
        for (const item of list) {
          result.push({
            id: item.fs_id,
            name: item.server_filename,
            isDirectory: Number(item.isdir) === 1,
            path: item.path
          });
        }
        if (list.length < 100) return result;
      }
    }

    // 计算分享内目录的路径候选（按可能性排序）；apiPath 为百度接口返回的权威 path
    shareDirCandidates(relative, name, apiPath) {
      const rel = `${relative}/${name}`.replace(/\/+/g, "/");
      const candidates = [];
      const seen = new Set();
      const push = (value, raw) => {
        if (!value || seen.has(`${raw}|${value}`)) return;
        seen.add(`${raw}|${value}`);
        candidates.push({ value, raw });
      };
      if (apiPath) {
        push(apiPath, true); // 接口给的 path 原样使用（可能已 URL 编码）
        let decoded = apiPath;
        try {
          decoded = decodeURIComponent(apiPath);
        } catch (_) {}
        if (decoded !== apiPath) push(decoded, false);
      }
      push(rel, false); // 分享根相对路径
      let root = this.shareRoot || "/";
      try {
        root = decodeURIComponent(root);
      } catch (_) {}
      root = root.replace(/\/+$/, "");
      if (root && root !== "/") push(`${root}${rel}`.replace(/\/+/g, "/"), false);
      if (rel.startsWith("/")) push(rel.slice(1), false); // 去掉前导斜杠
      return candidates;
    }

    // 依次尝试目录路径候选，取第一个可用的（仅针对「链接出错」errno=2 才换候选）
    async listShareChildren(relative, name, apiPath) {
      let lastError;
      for (const { value, raw } of this.shareDirCandidates(relative, name, apiPath)) {
        try {
          return await this.listShareDirectory(value, raw);
        } catch (error) {
          lastError = error;
          if (error.errno !== 2) throw error;
        }
      }
      throw new ShareListError(lastError ? lastError.message : "分享目录列表失败", {
        errno: lastError && lastError.errno,
        response: lastError && lastError.response
      });
    }

    // 递归展开单个目录，逐层应用每夹上限
    async expandDirectory(directory, destination) {
      const relative = destination.slice(this.destination.length);
      const children = await this.listShareChildren(relative, directory.name, directory.path);
      const childDestination = this.joinPath(destination, directory.name);
      await this.createDirectory(childDestination);
      const childDirectories = children.filter((item) => item.isDirectory);
      const childFiles = children.filter((item) => !item.isDirectory);
      if (childDirectories.length) await this.transferDirectories(childDirectories, childDestination);
      if (childFiles.length) await this.transferFiles(childFiles, childDestination);
    }

    async transferDirectories(directories, destination) {
      if (!directories.length) return;
      await this.createDirectory(destination);
      // 设置了每夹上限就必须逐层展开：整目录转存无法约束目录内部的文件数
      if (this.maxFilesPerFolder > 0) {
        for (const item of directories) {
          try {
            await this.expandDirectory(item, destination);
          } catch (error) {
            // 仅当「列出目录就失败」且尚未转存任何文件时，才降级整体转存，避免重复转存
            const canFallback = error instanceof ShareListError && this.fallbackOnExpandError && !this.transferredAny;
            if (!canFallback) throw error;
            this.progress(`⚠️ 无法列出目录「${item.name}」（${error.message}），已改为整体转存该目录`);
            await this.transferIds([item.id], destination);
          }
        }
        return;
      }
      try {
        await this.transferIds(directories.map((item) => item.id), destination);
        for (const item of directories) {
          this.progress(`已转存目录 ${this.joinPath(destination, item.name)}`);
        }
      } catch (error) {
        if (error.errno !== 12) throw error;
        this.progress(`目录数量超过限制，正在拆分处理：${directories.map((item) => item.name).join("、")}`);
        if (directories.length > 1) {
          const middle = Math.floor(directories.length / 2);
          await this.transferDirectories(directories.slice(0, middle), destination);
          await this.transferDirectories(directories.slice(middle), destination);
          return;
        }
        await this.expandDirectory(directories[0], destination);
      }
    }

    async run(input, password = "") {
      this.transferredAny = false;
      this.progress("正在读取分享信息…");
      await this.loadShare(input, password);
      this.progress(`发现 ${this.directories.length} 个目录、${this.files.length} 个文件`);
      const firstDir = this.directories[0];
      this.progress(`分享标识：shareid=${this.shareId}，uk=${this.userId}，shareRoot=${this.shareRoot}${firstDir ? `，首个目录 path=${firstDir.path}` : ""}`);
      if (this.maxFilesPerFolder > 0) {
        this.progress(`每个文件夹最多保存 ${this.maxFilesPerFolder} 个文件（目录会逐层展开）`);
      }
      if (this.directories.length) await this.transferDirectories(this.directories, this.destination);
      if (this.files.length) await this.transferFiles(this.files, this.destination);
      this.progress("全部转存完成");
      return { directories: this.directories.length, files: this.files.length, destination: this.destination || "/" };
    }
  }

  return {
    BaiduPanError,
    BaiduPanTransfer,
    extractShareKey,
    normalizeDestination,
    parseSharePage,
    encodePath
  };
});


(function () {
  "use strict";
  if (window.top !== window.self || document.getElementById("bpth-launcher")) return;
  const { BaiduPanTransfer } = globalThis.BaiduTransferCore;
  const STORAGE_KEY = "bpth-form-v1";
  let running = false;

  const style = document.createElement("style");
  style.textContent = `
    #bpth-launcher{position:fixed;right:22px;bottom:92px;z-index:2147483646;width:52px;height:52px;border:0;border-radius:50%;background:linear-gradient(135deg,#2878ff,#74a9ff);color:#fff;font:700 15px/1 sans-serif;box-shadow:0 10px 28px #1c5fdc66;cursor:pointer}
    #bpth-panel{all:initial;position:fixed;right:22px;bottom:155px;z-index:2147483647;width:390px;box-sizing:border-box;padding:18px;border:1px solid #d9e1ed;border-radius:15px;background:#f7f9fc;color:#172033;box-shadow:0 18px 55px #15244744;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
    #bpth-panel *{box-sizing:border-box}#bpth-panel[hidden]{display:none}#bpth-panel h2{margin:0 28px 4px 0;font-size:17px}#bpth-panel .sub{margin:0 0 13px;color:#6b768a;font-size:12px}#bpth-close{position:absolute;right:12px;top:10px;border:0;background:transparent;color:#647087;font-size:23px;cursor:pointer}
    #bpth-panel label{display:block;margin:10px 0 5px;color:#344057;font-size:12px;font-weight:700}#bpth-panel textarea,#bpth-panel input{display:block;width:100%;margin-top:5px;border:1px solid #cdd6e4;border-radius:8px;padding:9px 10px;background:#fff;color:#172033;font:12px/1.45 inherit;outline:none;resize:vertical}#bpth-panel textarea:focus,#bpth-panel input:focus{border-color:#2878ff;box-shadow:0 0 0 3px #2878ff18}
    #bpth-panel .row{display:grid;grid-template-columns:1fr 1.5fr;gap:9px}
    #bpth-panel .hint{margin:6px 0 0;color:#8b95a7;font-size:11px;line-height:1.45}
    #bpth-start{width:100%;margin-top:13px;border:0;border-radius:9px;padding:11px;background:#2878ff;color:#fff;font:700 13px/1 inherit;cursor:pointer}#bpth-start:disabled{background:#9bacbf;cursor:not-allowed}#bpth-status{margin-top:11px;max-height:150px;overflow:auto;border:1px solid #dce3ed;border-radius:8px;padding:9px;background:#fff;color:#536178;font:12px/1.55 inherit;white-space:pre-wrap}#bpth-status:empty{display:none}
  `;
  document.documentElement.appendChild(style);

  const launcher = document.createElement("button");
  launcher.id = "bpth-launcher";
  launcher.type = "button";
  launcher.textContent = "批存";
  launcher.title = "百度网盘批量转存";

  const panel = document.createElement("section");
  panel.id = "bpth-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <button id="bpth-close" type="button" aria-label="关闭">×</button>
    <h2>百度网盘批量转存</h2><p class="sub">自动递归拆分超过数量限制的分享目录，可自定义每夹文件数</p>
    <label>分享链接<textarea id="bpth-url" rows="3" placeholder="https://pan.baidu.com/s/1..."></textarea></label>
    <div class="row"><label>提取码<input id="bpth-password" maxlength="8" placeholder="可留空"></label><label>保存目录<input id="bpth-destination" placeholder="/ 或 /资料"></label></div>
    <div class="row"><label>每夹最多文件数<input id="bpth-max-files" type="number" min="0" step="1" placeholder="0 = 不限制"></label><label>分批文件夹前缀<input id="bpth-prefix" maxlength="20" placeholder="留空则为 1、2、3"></label></div>
    <p class="hint">每夹最多文件数设为 0 时沿用百度原有自动拆分逻辑；设为大于 0 时，超出部分会拆分到子文件夹，名称为「前缀 + 序号」拼接（填「批」得到 批1、批2，留空得到 1、2），目录内部同样按此上限拆分。</p>
    <button id="bpth-start" type="button">开始转存</button><div id="bpth-status"></div>
  `;
  document.documentElement.append(launcher, panel);

  const byId = (id) => panel.querySelector(`#${id}`);
  const urlInput = byId("bpth-url");
  const passwordInput = byId("bpth-password");
  const destinationInput = byId("bpth-destination");
  const maxFilesInput = byId("bpth-max-files");
  const prefixInput = byId("bpth-prefix");
  const startButton = byId("bpth-start");
  const status = byId("bpth-status");
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  // 当前页就是分享页时以它为准（历史记录只作为回退），否则自动填充会被旧链接一直压住
  const pageShareLink = /\/s\/1|surl=/.test(location.href) ? location.href : "";
  const pagePwd = pageShareLink ? new URL(location.href).searchParams.get("pwd") || "" : "";
  urlInput.value = pageShareLink || saved.url || "";
  passwordInput.value = pagePwd || saved.password || "";
  destinationInput.value = saved.destination || "";
  maxFilesInput.value = saved.maxFiles || "";
  prefixInput.value = saved.prefix || "";

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      url: urlInput.value.trim(),
      password: passwordInput.value.trim(),
      destination: destinationInput.value.trim(),
      maxFiles: maxFilesInput.value.trim(),
      prefix: prefixInput.value.trim()
    }));
  }
  function log(message) {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    status.textContent += `${status.textContent ? "\n" : ""}[${time}] ${message}`;
    status.scrollTop = status.scrollHeight;
  }

  launcher.addEventListener("click", () => { panel.hidden = !panel.hidden; });
  byId("bpth-close").addEventListener("click", () => { panel.hidden = true; });
  for (const input of [urlInput, passwordInput, destinationInput, maxFilesInput, prefixInput]) input.addEventListener("change", save);
  startButton.addEventListener("click", async () => {
    if (running) return;
    if (!urlInput.value.trim()) return urlInput.focus();
    save();
    running = true;
    startButton.disabled = true;
    startButton.textContent = "正在转存…";
    status.textContent = "";
    try {
      const maxFiles = Math.max(0, Math.floor(Number(maxFilesInput.value) || 0));
      const transfer = new BaiduPanTransfer({
        destination: destinationInput.value,
        maxFilesPerFolder: maxFiles,
        folderPrefix: prefixInput.value,
        onProgress: log
      });
      await transfer.run(urlInput.value, passwordInput.value);
      log("✅ 转存成功，请刷新百度网盘文件列表");
      urlInput.value = "";
      passwordInput.value = "";
      save();
    } catch (error) {
      console.error("[百度网盘批量转存]", error);
      log(`❌ ${error.message}`);
      if (error && error.response !== undefined) {
        const detail = typeof error.response === "string"
          ? error.response.replace(/\s+/g, " ").trim().slice(0, 300)
          : JSON.stringify(error.response).slice(0, 300);
        if (detail && !String(error.message).includes(detail.slice(0, 40))) log(`↳ 百度返回：${detail}`);
      }
    } finally {
      running = false;
      startButton.disabled = false;
      startButton.textContent = "开始转存";
    }
  });
})();
