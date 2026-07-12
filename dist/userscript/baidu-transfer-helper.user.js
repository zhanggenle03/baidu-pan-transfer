// ==UserScript==
// @name         百度网盘批量转存助手（跨浏览器版）
// @namespace    https://github.com/kola-official/baidu-transfer-helper
// @version      1.0.1
// @description  自动递归拆分并转存超过数量限制的百度网盘分享目录
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
        .map((item) => ({ id: item.fs_id, name: item.server_filename, isDirectory: true })),
      files: files
        .filter((item) => Number(item.isdir) !== 1)
        .map((item) => ({ id: item.fs_id, name: item.server_filename, isDirectory: false }))
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

    async request(path, options = {}) {
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
        throw new BaiduPanError(`网络请求失败：HTTP ${response.status}`, { response: data });
      }
      if (options.checkErrno && data && typeof data === "object" && Number(data.errno || 0) !== 0) {
        throw new BaiduPanError(data.show_msg || data.errmsg || `百度网盘错误 ${data.errno}`, {
          errno: Number(data.errno),
          response: data
        });
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
      await this.request("/api/create", {
        method: "POST",
        query: `a=commit&bdstoken=${encodeURIComponent(this.bdstoken)}`,
        body: `path=${encodeURIComponent(path)}&isdir=1&block_list=[]`,
        checkErrno: true
      });
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
      if (errno === 0) return data;
      if ((errno === 111 || errno === 1504) && retry < this.maxRetries) {
        const delay = errno === 111 ? Math.min(30000, 5000 * (retry + 1)) : 1500;
        this.progress(`请求过快，${Math.ceil(delay / 1000)} 秒后重试…`);
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
      throw new BaiduPanError(data?.show_msg || data?.errmsg || `百度网盘转存错误 ${errno}`, {
        errno,
        response: data
      });
    }

    async transferFiles(files, destination) {
      await this.createDirectory(destination);
      for (let index = 0; index < files.length; index += this.batchSize) {
        const batch = files.slice(index, index + this.batchSize);
        await this.transferIds(batch.map((item) => item.id), destination);
        this.progress(`已转存 ${Math.min(index + batch.length, files.length)}/${files.length} 个文件到 ${destination || "/"}`);
      }
    }

    async listShareDirectory(path) {
      const result = [];
      for (let page = 1; ; page += 1) {
        const data = await this.request("/share/list", {
          query: [
            `uk=${encodeURIComponent(this.userId)}`,
            `shareid=${encodeURIComponent(this.shareId)}`,
            "order=name", "desc=0", "showempty=0",
            `page=${page}`, "num=100", `dir=${encodePath(path)}`
          ].join("&"),
          checkErrno: true
        });
        const list = Array.isArray(data.list) ? data.list : [];
        for (const item of list) {
          result.push({
            id: item.fs_id,
            name: item.server_filename,
            isDirectory: Number(item.isdir) === 1
          });
        }
        if (list.length < 100) return result;
      }
    }

    async transferDirectories(directories, destination) {
      if (!directories.length) return;
      await this.createDirectory(destination);
      try {
        await this.transferIds(directories.map((item) => item.id), destination);
        for (const item of directories) {
          this.progress(`已转存目录 ${destination || ""}/${item.name}`);
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
        const directory = directories[0];
        const relative = destination.slice(this.destination.length);
        const sourcePath = `${this.shareRoot}${relative}/${directory.name}`.replace(/\/+/g, "/");
        const children = await this.listShareDirectory(sourcePath);
        const childDestination = `${destination}/${directory.name}`.replace(/\/+/g, "/");
        const childDirectories = children.filter((item) => item.isDirectory);
        const childFiles = children.filter((item) => !item.isDirectory);
        await this.createDirectory(childDestination);
        if (childDirectories.length) await this.transferDirectories(childDirectories, childDestination);
        if (childFiles.length) await this.transferFiles(childFiles, childDestination);
      }
    }

    async run(input, password = "") {
      this.progress("正在读取分享信息…");
      await this.loadShare(input, password);
      this.progress(`发现 ${this.directories.length} 个目录、${this.files.length} 个文件`);
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
    #bpth-panel .row{display:grid;grid-template-columns:1fr 1.5fr;gap:9px}#bpth-start{width:100%;margin-top:13px;border:0;border-radius:9px;padding:11px;background:#2878ff;color:#fff;font:700 13px/1 inherit;cursor:pointer}#bpth-start:disabled{background:#9bacbf;cursor:not-allowed}#bpth-status{margin-top:11px;max-height:150px;overflow:auto;border:1px solid #dce3ed;border-radius:8px;padding:9px;background:#fff;color:#536178;font:12px/1.55 inherit;white-space:pre-wrap}#bpth-status:empty{display:none}
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
    <h2>百度网盘批量转存</h2><p class="sub">自动递归拆分超过数量限制的分享目录</p>
    <label>分享链接<textarea id="bpth-url" rows="3" placeholder="https://pan.baidu.com/s/1..."></textarea></label>
    <div class="row"><label>提取码<input id="bpth-password" maxlength="8" placeholder="可留空"></label><label>保存目录<input id="bpth-destination" placeholder="/ 或 /资料"></label></div>
    <button id="bpth-start" type="button">开始转存</button><div id="bpth-status"></div>
  `;
  document.documentElement.append(launcher, panel);

  const byId = (id) => panel.querySelector(`#${id}`);
  const urlInput = byId("bpth-url");
  const passwordInput = byId("bpth-password");
  const destinationInput = byId("bpth-destination");
  const startButton = byId("bpth-start");
  const status = byId("bpth-status");
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  urlInput.value = saved.url || (/\/s\/1/.test(location.href) ? location.href : "");
  passwordInput.value = saved.password || new URL(location.href).searchParams.get("pwd") || "";
  destinationInput.value = saved.destination || "";

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      url: urlInput.value.trim(), password: passwordInput.value.trim(), destination: destinationInput.value.trim()
    }));
  }
  function log(message) {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    status.textContent += `${status.textContent ? "\n" : ""}[${time}] ${message}`;
    status.scrollTop = status.scrollHeight;
  }

  launcher.addEventListener("click", () => { panel.hidden = !panel.hidden; });
  byId("bpth-close").addEventListener("click", () => { panel.hidden = true; });
  for (const input of [urlInput, passwordInput, destinationInput]) input.addEventListener("change", save);
  startButton.addEventListener("click", async () => {
    if (running) return;
    if (!urlInput.value.trim()) return urlInput.focus();
    save();
    running = true;
    startButton.disabled = true;
    startButton.textContent = "正在转存…";
    status.textContent = "";
    try {
      const transfer = new BaiduPanTransfer({ destination: destinationInput.value, onProgress: log });
      await transfer.run(urlInput.value, passwordInput.value);
      log("✅ 转存成功，请刷新百度网盘文件列表");
      urlInput.value = "";
      passwordInput.value = "";
      save();
    } catch (error) {
      console.error("[百度网盘批量转存]", error);
      log(`❌ ${error.message}`);
    } finally {
      running = false;
      startButton.disabled = false;
      startButton.textContent = "开始转存";
    }
  });
})();
