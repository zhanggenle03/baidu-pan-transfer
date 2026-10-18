// ==UserScript==
// @name         百度网盘批量转存助手（跨浏览器版）
// @namespace    https://github.com/kola-official/baidu-transfer-helper
// @version      1.1.3
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

  // 任务被用户取消——调用方应停止后续操作（已完成的转存保留）
  class TransferCancelledError extends Error {
    constructor(message = "转存已取消") {
      super(message);
      this.name = "TransferCancelledError";
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
        .map((item) => ({ id: item.fs_id, name: item.server_filename, isDirectory: true, path: item.path, size: Number(item.size) || 0 })),
      files: files
        .filter((item) => Number(item.isdir) !== 1)
        .map((item) => ({ id: item.fs_id, name: item.server_filename, isDirectory: false, path: item.path, size: Number(item.size) || 0 }))
    };
  }

  class BaiduPanTransfer {
    constructor(options = {}) {
      this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
      this.onProgress = options.onProgress || (() => {});
      this.rootUrl = options.rootUrl || ROOT_URL;
      this.batchSize = options.batchSize || 100;
      this.maxRetries = options.maxRetries ?? 16;
      this.destination = normalizeDestination(options.destination || "");
      // 每个目标文件夹最多保存的文件数；0 表示不限制（沿用百度自动拆分逻辑）
      this.maxFilesPerFolder = Math.max(0, Math.floor(Number(options.maxFilesPerFolder) || 0));
      // 分批子文件夹名前缀（会剔除路径分隔符），实际名称为 `${前缀}${序号}`
      this.folderPrefix = String(options.folderPrefix == null ? "" : options.folderPrefix).replace(/[/\\]/g, "");
      // 只转存勾选的项目：fs_id 数字数组（顶层）或 { id, name, isDirectory, path, parentRelative } 对象数组（支持深层）
      this.selection = Array.isArray(options.selection) ? options.selection.slice() : null;
      // 展开目录失败（如列表接口受限）时，是否降级为整体转存该目录，避免整个任务中断（默认开启）
      this.fallbackOnExpandError = options.fallbackOnExpandError === undefined ? true : !!options.fallbackOnExpandError;
      // 分批之间的间隔毫秒数，用于降低触发百度限流（请求超时/过快的概率）
      this.requestDelay = options.requestDelay === undefined ? 600 : Math.max(0, Number(options.requestDelay) || 0);
      // 探明（逐层侦察）阶段的请求间隔毫秒数，默认与 requestDelay 一致
      this.reconDelay = options.reconDelay === undefined ? this.requestDelay : Math.max(0, Number(options.reconDelay) || 0);
      // 探明后合并整体转存的单批文件数上限；触发百度限制时按返回值自动收敛
      this.mergeLimitFiles = Math.max(1, Math.floor(Number(options.mergeLimitFiles) || 400));
      // 探明模式：auto = 每夹上限>0 时先逐层侦察、合规目录合并整体转存；off = 沿用旧的逐层展开行为
      this.reconMode = options.reconMode === "off" ? "off" : "auto";
      // 分享目录列表缓存（按目录 fs_id），探明与展开阶段共用，避免重复请求
      this.shareListCache = new Map();
      // 已确认存在的目标目录（实例级），避免 createDirectory 重复探测
      this.confirmedDirectories = new Set();
      // 探明阶段无法列出的目录（执行阶段改为整体转存兜底）
      this.reconFailed = new Set();
      // 用户取消标志（cancel() 置位，在请求前与等待分片间检查）
      this.cancelled = false;
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

    // 遇限流时自动降速：探明与批间间隔翻倍（封顶 4800ms），降低再次触发风控的概率
    slowDown() {
      if (this.requestDelay > 0) this.requestDelay = Math.min(this.requestDelay * 2, 4800);
      if (this.reconDelay > 0) this.reconDelay = Math.min(this.reconDelay * 2, 4800);
    }

    // 取消任务：在当前请求结束后、下一个检查点生效（已转存的内容保留）
    cancel() {
      this.cancelled = true;
    }

    // 可取消的等待：长退避拆成小段轮询，取消可在 ~0.5 秒内生效
    async wait(ms) {
      let remaining = Math.max(0, Number(ms) || 0);
      while (remaining > 0) {
        if (this.cancelled) throw new TransferCancelledError();
        const chunk = Math.min(500, remaining);
        await sleep(chunk);
        remaining -= chunk;
      }
      if (this.cancelled) throw new TransferCancelledError();
    }

    async request(path, options = {}, retry = 0) {
      if (this.cancelled) throw new TransferCancelledError();
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
          this.slowDown();
          const delay = Math.min(30000, 5000 * (retry + 1));
          this.progress(`网络请求失败（HTTP ${response.status}），已自动降速，${Math.ceil(delay / 1000)} 秒后重试…`);
          await this.wait(delay);
          return this.request(path, options, retry + 1);
        }
        throw new BaiduPanError(`网络请求失败：HTTP ${response.status}`, { response: data });
      }
      if (options.checkErrno && data && typeof data === "object" && Number(data.errno || 0) !== 0) {
        const errno = Number(data.errno);
        const message = data.show_msg || data.errmsg || `百度网盘错误 ${errno}`;
        if (retry < this.maxRetries && this.isRetryableError({ errno, message })) {
          // 限流时自动降速并按更长退避等待（5s 起步、30s 封顶），给风控留出冷却时间
          this.slowDown();
          const delay = Math.min(30000, 5000 * (retry + 1));
          this.progress(`请求受限（${message}），已自动降速，${Math.ceil(delay / 1000)} 秒后重试…`);
          await this.wait(delay);
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

    // 确保目标目录存在；已确认存在的目录不再重复探测（实例级缓存）
    async createDirectory(path) {
      if (!path) return;
      if (this.confirmedDirectories.has(path)) return;
      try {
        await this.listDestination(path);
        this.confirmedDirectories.add(path);
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
        this.confirmedDirectories.add(path);
      } catch (error) {
        // -8：目录已存在，视为创建成功
        if (error.errno !== -8) throw error;
        this.confirmedDirectories.add(path);
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
        this.slowDown();
        const delay = Math.min(30000, 5000 * (retry + 1));
        this.progress(`请求受限（${message}），已自动降速，${Math.ceil(delay / 1000)} 秒后重试…`);
        await this.wait(delay);
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
        if (index > 0 && this.requestDelay) await this.wait(this.requestDelay);
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
          if (index > 0 && this.requestDelay) await this.wait(this.requestDelay);
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
          // 子项路径必须以「本次成功列出的 dir」为基准续接。
          // 接口返回的 item.path 在部分分享里是分享者空间路径（或相对路径），
          // 深层直接拿它当 dir 会返回 -9/2，表现为「到一定深度就打不开」。
          result.push({
            id: item.fs_id,
            name: item.server_filename,
            isDirectory: Number(item.isdir) === 1,
            path: `${dirValue}/${item.server_filename}`.replace(/\/+/g, "/")
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

    // 这些 errno 都表示「这个路径写法不对」，可以换下一个候选再试；
    // 其余错误（未登录、限流等）与路径无关，直接抛出，避免白白多发请求。
    isDirCandidateMiss(error) {
      return [2, -3, -7, -9].includes(Number(error && error.errno));
    }

    // 依次尝试目录路径候选，取第一个可用的
    async listShareChildren(relative, name, apiPath) {
      let lastError;
      for (const { value, raw } of this.shareDirCandidates(relative, name, apiPath)) {
        try {
          return await this.listShareDirectory(value, raw);
        } catch (error) {
          if (!this.isDirCandidateMiss(error)) throw error;
          lastError = error;
        }
      }
      const label = String(name || "").slice(0, 40);
      throw new ShareListError(lastError ? `无法读取目录「${label}」：${lastError.message}` : `无法读取目录「${label}」`, {
        errno: lastError && lastError.errno,
        response: lastError && lastError.response
      });
    }

    // 列出分享内某目录的子项；结果按目录 fs_id 缓存，探明与执行阶段共用
    async reconDirectory(directory, relative) {
      const cached = this.shareListCache.get(directory.id);
      if (cached) return cached;
      const children = await this.listShareChildren(relative, directory.name, directory.path);
      this.shareListCache.set(directory.id, children);
      return children;
    }

    // 递归展开单个目录，逐层应用每夹上限
    async expandDirectory(directory, destination) {
      const relative = destination.slice(this.destination.length);
      const children = await this.reconDirectory(directory, relative);
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
      // 设置了每夹上限时：探明后合规目录合并整体转存，其余逐层展开（reconMode = off 时为旧的逐层展开行为）
      if (this.maxFilesPerFolder > 0) {
        if (this.reconMode === "off") {
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
        await this.transferDirectoriesRecon(directories, destination);
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

    // 整体探明：转存前只读遍历全部分享目录（结果进缓存），执行阶段零重复请求、失败零副作用前置
    async reconAll(entries) {
      this.progress("正在探明分享结构…");
      const queue = entries.map((entry) => {
        const directory = entry && entry.directory ? entry.directory : entry;
        const relative = entry && typeof entry.relative === "string" ? entry.relative : "";
        return { directory, relative };
      });
      let head = 0;
      let requests = 0;
      while (head < queue.length) {
        const { directory, relative } = queue[head];
        head += 1;
        if (this.shareListCache.has(directory.id) || this.reconFailed.has(directory.id)) continue;
        if (requests > 0 && this.reconDelay) await this.wait(this.reconDelay);
        requests += 1;
        let children;
        try {
          children = await this.reconDirectory(directory, relative);
        } catch (error) {
          // 纯读阶段失败：记入整体转存名单（零写入，无重复风险）；关闭降级时直接中止
          if (!(error instanceof ShareListError)) throw error;
          if (!this.fallbackOnExpandError) throw error;
          this.reconFailed.add(directory.id);
          this.progress(`⚠️ 无法列出目录「${directory.name}」（${error.message}），将改为整体转存`);
          continue;
        }
        if (requests % 10 === 0) {
          const label = directory.name.length > 14 ? `${directory.name.slice(0, 14)}…` : directory.name;
          this.progress(`正在探明结构（已扫描 ${requests} 个目录，当前：${label}）…`);
        }
        const childRelative = this.joinPath(relative, directory.name);
        for (const item of children) {
          if (item.isDirectory && !this.shareListCache.has(item.id)) {
            queue.push({ directory: item, relative: childRelative });
          }
        }
      }
    }

    // 汇总探明结果，供转存前的计划预览
    summarizeRecon(directories) {
      const seen = new Set();
      const queue = [...directories];
      let head = 0;
      let scanned = 0;
      let mergeable = 0;
      let expandable = 0;
      let files = 0;
      while (head < queue.length) {
        const directory = queue[head];
        head += 1;
        if (seen.has(directory.id)) continue;
        seen.add(directory.id);
        const children = this.shareListCache.get(directory.id);
        if (!children) continue;
        scanned += 1;
        const childDirectories = children.filter((item) => item.isDirectory);
        const fileCount = children.length - childDirectories.length;
        files += fileCount;
        if (!childDirectories.length && fileCount <= this.maxFilesPerFolder) {
          mergeable += 1;
        } else {
          expandable += 1;
        }
        for (const item of childDirectories) queue.push(item);
      }
      return { scanned, mergeable, expandable, files };
    }

    // 逐层执行 + 同层合批：判定结果来自前置的整体探明（缓存），内容不超上限的目录合并整体转存，其余逐层展开
    async transferDirectoriesRecon(directories, destination) {
      const mergeable = [];
      const expandable = [];
      const relative = destination.slice(this.destination.length);
      for (let index = 0; index < directories.length; index += 1) {
        const directory = directories[index];
        // 探明阶段确认「列不出」的目录：从未转存过任何内容，直接整体转存兜底
        if (this.reconFailed.has(directory.id)) {
          await this.transferIds([directory.id], destination);
          this.progress(`已整体转存目录 ${this.joinPath(destination, directory.name)}`);
          continue;
        }
        if (index > 0 && this.reconDelay) await this.wait(this.reconDelay);
        let children;
        try {
          children = await this.reconDirectory(directory, relative);
        } catch (error) {
          // 兜底防线：正常情况下目录已在探明阶段全部列出，此处仅防御
          const canFallback = error instanceof ShareListError && this.fallbackOnExpandError && !this.transferredAny;
          if (!canFallback) throw error;
          this.progress(`⚠️ 无法列出目录「${directory.name}」（${error.message}），已改为整体转存该目录`);
          await this.transferIds([directory.id], destination);
          continue;
        }
        const fileCount = children.filter((item) => !item.isDirectory).length;
        const hasChildDirectory = children.some((item) => item.isDirectory);
        // 子树合规判定：无子目录且直接文件数不超上限，整体转存才不会绕过每夹上限
        if (!hasChildDirectory && fileCount <= this.maxFilesPerFolder) {
          mergeable.push({ directory, fileCount });
        } else {
          expandable.push(directory);
        }
      }
      if (mergeable.length || expandable.length) {
        this.progress(`本层处理：${mergeable.length} 个目录合并转存，${expandable.length} 个目录逐层展开`);
      }
      if (mergeable.length) await this.transferMergeable(mergeable, destination);
      for (let index = 0; index < expandable.length; index += 1) {
        if (index > 0 && this.requestDelay) await this.wait(this.requestDelay);
        await this.expandDirectory(expandable[index], destination);
      }
    }

    // 将合规目录按「单批文件数」分组合并提交；触发百度限制时按返回值收敛并二分重试
    async transferMergeable(items, destination) {
      const groups = [];
      let current = [];
      let currentFiles = 0;
      for (const item of items) {
        if (current.length && currentFiles + item.fileCount > this.mergeLimitFiles) {
          groups.push(current);
          current = [];
          currentFiles = 0;
        }
        current.push(item);
        currentFiles += item.fileCount;
      }
      if (current.length) groups.push(current);
      for (let index = 0; index < groups.length; index += 1) {
        if (index > 0 && this.requestDelay) await this.wait(this.requestDelay);
        await this.transferMergeableGroup(groups[index], destination);
      }
    }

    async transferMergeableGroup(group, destination) {
      if (!group.length) return;
      try {
        await this.transferIds(group.map((item) => item.directory.id), destination);
        if (group.length === 1) {
          this.progress(`已转存目录 ${this.joinPath(destination, group[0].directory.name)}`);
        } else {
          this.progress(`已合并转存 ${group.length} 个目录到 ${destination || "/"}`);
        }
      } catch (error) {
        if (error.errno !== 12) throw error;
        const limit = Number(error.response && error.response.target_file_nums_limit);
        if (Number.isFinite(limit) && limit > 0) this.mergeLimitFiles = Math.min(this.mergeLimitFiles, limit);
        if (group.length > 1) {
          const middle = Math.ceil(group.length / 2);
          await this.transferMergeableGroup(group.slice(0, middle), destination);
          await this.transferMergeableGroup(group.slice(middle), destination);
          return;
        }
        // 单目录仍超限：降级为逐层展开（文件会按 batchSize 分批转存）
        this.progress(`目录「${group[0].directory.name}」超过单次转存限制，改为逐层展开`);
        await this.expandDirectory(group[0].directory, destination);
      }
    }

    // 按勾选过滤顶层项目（未指定 selection 时转存全部分享）
    applySelection() {
      if (!this.selection) return;
      const selected = new Set(this.selection.filter((id) => typeof id !== "object").map((id) => Number(id)));
      this.directories = this.directories.filter((item) => selected.has(Number(item.id)));
      this.files = this.files.filter((item) => selected.has(Number(item.id)));
      if (!this.directories.length && !this.files.length) {
        throw new BaiduPanError("未选择任何要转存的内容");
      }
    }

    // 是否为深层选择（对象数组，可选中任意层级的目录或文件）
    deepSelection() {
      return Array.isArray(this.selection) && this.selection.some((item) => item && typeof item === "object");
    }

    // 归一化深层选择：过滤无效项，并去掉被祖先项覆盖的子项
    normalizeDeepSelection() {
      const items = (this.selection || []).filter((item) => item && typeof item === "object" && item.id != null && item.name);
      const sorted = items
        .slice()
        .sort((a, b) => String(a.parentRelative || "").length - String(b.parentRelative || "").length);
      const picked = [];
      for (const item of sorted) {
        const parentRelative = String(item.parentRelative || "").replace(/\/+$/, "");
        const full = this.joinPath(parentRelative, item.name);
        const covered = picked.some((other) => {
          if (!other.node.isDirectory) return false;
          const otherFull = this.joinPath(other.parentRelative, other.node.name);
          return full === otherFull || full.startsWith(`${otherFull}/`);
        });
        if (covered) continue;
        picked.push({
          node: {
            id: Number(item.id),
            name: String(item.name),
            isDirectory: Boolean(item.isDirectory),
            path: item.path || ""
          },
          parentRelative
        });
      }
      return picked;
    }

    // 逐级创建目标目录链（深层勾选时中间父目录可能尚未创建）
    async createDirectoryChain(relative) {
      const parts = String(relative || "").split("/").filter(Boolean);
      let current = this.destination;
      for (const part of parts) {
        current = this.joinPath(current, part);
        await this.createDirectory(current);
      }
    }

    // 深层勾选：只转存选中项，各自落到其父路径下
    async transferDeepSelection(totalDirectories, totalFiles) {
      const items = this.normalizeDeepSelection();
      if (!items.length) throw new BaiduPanError("未选择任何要转存的内容");
      this.progress(`分享共 ${totalDirectories} 个目录、${totalFiles} 个文件，已勾选 ${items.length} 项`);
      const groups = new Map();
      for (const item of items) {
        if (!groups.has(item.parentRelative)) groups.set(item.parentRelative, []);
        groups.get(item.parentRelative).push(item);
      }
      const selectedDirectories = items.filter((item) => item.node.isDirectory);
      if (this.maxFilesPerFolder > 0 && this.reconMode !== "off" && selectedDirectories.length) {
        this.progress(`每个文件夹最多保存 ${this.maxFilesPerFolder} 个文件（目录会先整体探明再合并转存）`);
        await this.reconAll(selectedDirectories.map((item) => ({ directory: item.node, relative: item.parentRelative })));
        const summary = this.summarizeRecon(selectedDirectories.map((item) => item.node));
        const failedHint = this.reconFailed.size ? `，${this.reconFailed.size} 个目录无法列出将整体转存` : "";
        this.progress(`探明完成：共 ${summary.scanned} 个目录（${summary.mergeable} 个将合并转存，${summary.expandable} 个需逐层展开${failedHint}），合计 ${summary.files} 个文件`);
      }
      for (const [parentRelative, groupItems] of groups) {
        await this.createDirectoryChain(parentRelative);
        const target = parentRelative ? this.joinPath(this.destination, parentRelative) : this.destination;
        const directories = groupItems.filter((item) => item.node.isDirectory).map((item) => item.node);
        const files = groupItems.filter((item) => !item.node.isDirectory).map((item) => item.node);
        if (directories.length) await this.transferDirectories(directories, target);
        if (files.length) await this.transferFiles(files, target);
      }
    }

    async run(input, password = "") {
      this.transferredAny = false;
      this.cancelled = false;
      this.progress("正在读取分享信息…");
      await this.loadShare(input, password);
      const totalDirectories = this.directories.length;
      const totalFiles = this.files.length;
      const firstDir = this.directories[0];
      this.progress(`分享标识：shareid=${this.shareId}，uk=${this.userId}，shareRoot=${this.shareRoot}${firstDir ? `，首个目录 path=${firstDir.path}` : ""}`);
      if (this.deepSelection()) {
        await this.transferDeepSelection(totalDirectories, totalFiles);
      } else {
        this.applySelection();
        if (this.selection) {
          this.progress(`分享共 ${totalDirectories} 个目录、${totalFiles} 个文件，已按勾选保留 ${this.directories.length} 个目录、${this.files.length} 个文件`);
        } else {
          this.progress(`发现 ${totalDirectories} 个目录、${totalFiles} 个文件`);
        }
        if (this.maxFilesPerFolder > 0) {
          const expandHint = this.reconMode === "off" ? "目录会逐层展开" : "目录会先整体探明再合并转存";
          this.progress(`每个文件夹最多保存 ${this.maxFilesPerFolder} 个文件（${expandHint}）`);
          if (this.reconMode !== "off" && this.directories.length) {
            await this.reconAll(this.directories);
            const summary = this.summarizeRecon(this.directories);
            const failedHint = this.reconFailed.size ? `，${this.reconFailed.size} 个目录无法列出将整体转存` : "";
            this.progress(`探明完成：共 ${summary.scanned} 个目录（${summary.mergeable} 个将合并转存，${summary.expandable} 个需逐层展开${failedHint}），合计 ${summary.files} 个文件`);
          }
        }
        if (this.directories.length) await this.transferDirectories(this.directories, this.destination);
        if (this.files.length) await this.transferFiles(this.files, this.destination);
      }
      this.progress("全部转存完成");
      return { directories: this.directories.length, files: this.files.length, destination: this.destination || "/" };
    }
  }

  return {
    BaiduPanError,
    TransferCancelledError,
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
  let currentTransfer = null;
  let shareReader = null;
  const picker = { ready: false, nodes: [] };

  const style = document.createElement("style");
  style.textContent = `
    #bpth-launcher{position:fixed;right:22px;bottom:92px;z-index:2147483646;width:52px;height:52px;border:0;border-radius:50%;background:linear-gradient(135deg,#2878ff,#74a9ff);color:#fff;font:700 15px/1 sans-serif;box-shadow:0 10px 28px #1c5fdc66;cursor:pointer}
    #bpth-panel{all:initial;position:fixed;right:22px;bottom:155px;z-index:2147483647;width:660px;max-height:calc(100vh - 180px);overflow:auto;box-sizing:border-box;padding:16px;border:1px solid #d9e1ed;border-radius:15px;background:#f7f9fc;color:#172033;box-shadow:0 18px 55px #15244744;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
    #bpth-panel *{box-sizing:border-box}
    #bpth-panel[hidden]{display:none}
    #bpth-panel h2{margin:0 28px 3px 0;font-size:16px}
    #bpth-panel .sub{margin:0 0 12px;color:#7b8698;font-size:11.5px}
    #bpth-close{position:absolute;right:12px;top:8px;padding:2px 6px;border:0;background:transparent;color:#647087;font-size:23px;line-height:1;cursor:pointer}
    #bpth-panel .bpth-board{display:grid;grid-template-columns:322px minmax(0,1fr);gap:12px;align-items:stretch}
    #bpth-panel .bpth-card{display:flex;flex-direction:column;min-width:0;padding:11px 12px;border:1px solid #e4eaf3;border-radius:11px;background:#fff}
    #bpth-panel .bpth-card-title{margin:0;font-size:12px;font-weight:700;color:#344057}
    #bpth-panel .bpth-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
    #bpth-panel label{display:block;margin:8px 0 0;color:#344057;font-size:11.5px;font-weight:650}
    #bpth-panel textarea,#bpth-panel input{display:block;width:100%;margin-top:5px;padding:7px 9px;border:1px solid #cdd6e4;border-radius:8px;background:#fff;color:#172033;font:12px/1.45 inherit;font-weight:400;outline:none}
    #bpth-panel textarea{height:50px;resize:none}
    #bpth-panel input{height:32px}
    #bpth-panel textarea:focus,#bpth-panel input:focus{border-color:#2878ff;box-shadow:0 0 0 3px #2878ff18}
    #bpth-panel .row{display:grid;grid-template-columns:1fr 1.45fr;gap:8px}
    #bpth-panel .bpth-tips{margin-top:9px;padding:7px 9px;border:1px solid #e8eef8;border-radius:8px;background:#f6f9fe;color:#7c8799;font-size:11px;line-height:1.5}
    #bpth-panel .bpth-tips summary{cursor:pointer;color:#5d6a80;font-weight:650;outline:none}
    #bpth-panel .bpth-tips p{margin:4px 0 0}
    #bpth-panel button:focus-visible,#bpth-panel summary:focus-visible{outline:2px solid #2878ff;outline-offset:2px}
    #bpth-panel .hint{margin:6px 0 0;color:#8b95a7;font-size:11px;line-height:1.5}
    #bpth-read{flex:none;padding:6px 10px;border:1px solid #b9d0f0;border-radius:7px;background:#fff;color:#2878ff;font:650 11.5px/1 inherit;cursor:pointer}
    #bpth-read:hover:not(:disabled){background:#f2f7ff}
    #bpth-read:disabled{border-color:#e2e8f1;background:#f7f9fc;color:#9bacbf;cursor:not-allowed}
    #bpth-read-status:empty{display:none}
    #bpth-pick-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:5px;margin-top:8px;padding:14px;border:1px dashed #d8e0ec;border-radius:9px;background:#fafcff;text-align:center;line-height:1.6}
    #bpth-pick-empty strong{color:#5d6a80;font-size:12px;font-weight:650}
    #bpth-pick-empty span{color:#97a1b2;font-size:11px}
    #bpth-pick-empty[hidden]{display:none}
    #bpth-pick{display:flex;flex:1;flex-direction:column;min-height:0;margin-top:6px}
    #bpth-pick[hidden]{display:none}
    #bpth-pick .bpth-pick-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}
    #bpth-pick .bpth-pick-all{display:flex;align-items:center;gap:6px;margin:0;color:#5d6a80;font-size:11.5px;font-weight:400}
    #bpth-pick .bpth-pick-all input,#bpth-pick .bpth-pick-row input{width:auto;height:auto;margin:0;padding:0;border:0;accent-color:#2878ff}
    #bpth-pick-count{color:#8b95a7;font-size:11px}
    #bpth-pick-items{flex:1;min-height:110px;max-height:240px;overflow:auto;padding:4px 6px;border:1px solid #e8eef7;border-radius:8px;background:#fff}
    #bpth-pick .bpth-pick-row{display:flex;align-items:center;gap:6px;margin:0;padding:3px 4px;border-radius:6px;color:#344057;font-size:12px;font-weight:400}
    #bpth-pick .bpth-pick-row:hover{background:#f4f8ff}
    #bpth-pick .bpth-pick-toggle{flex:none;width:15px;height:15px;padding:0;border:0;background:transparent;color:#8b95a7;font-size:11px;line-height:1;cursor:pointer}
    #bpth-pick .bpth-pick-toggle:disabled{color:#c9d1de;cursor:default}
    #bpth-pick .bpth-pick-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #bpth-pick .bpth-pick-tag{flex:none;color:#9aa4b5;font-size:10.5px}
    #bpth-status{margin-top:10px;max-height:108px;overflow:auto;border:1px solid #dbe3ef;border-radius:9px;padding:9px 10px;background:#fff;color:#536178;font:11.5px/1.55 inherit;white-space:pre-wrap}
    #bpth-status:empty{display:none}
    #bpth-panel .bpth-actions{display:flex;gap:9px;margin-top:11px}
    #bpth-start{flex:1;padding:10px;border:0;border-radius:9px;background:#2878ff;color:#fff;font:700 13px/1 inherit;cursor:pointer;box-shadow:0 4px 12px #2878ff30}
    #bpth-start:hover:not(:disabled){background:#1a6bf0}
    #bpth-start:disabled{background:#9bacbf;box-shadow:none;cursor:not-allowed}
    #bpth-cancel{flex:none;width:104px;padding:10px;border:1px solid #ccd5e3;border-radius:9px;background:#fff;color:#344057;font:650 12.5px/1 inherit;cursor:pointer}
    #bpth-cancel[hidden]{display:none}
    #bpth-cancel:hover:not(:disabled){background:#f6f8fb}
    #bpth-cancel:disabled{color:#9bacbf;cursor:not-allowed}
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
    <h2>百度网盘批量转存</h2><p class="sub">自动递归拆分超过数量限制的分享目录，支持按文件夹勾选</p>
    <div class="bpth-board">
      <section class="bpth-card bpth-col-form">
        <div class="bpth-card-title">转存设置</div>
        <label>分享链接<textarea id="bpth-url" rows="2" placeholder="https://pan.baidu.com/s/1..."></textarea></label>
        <div class="row"><label>提取码<input id="bpth-password" maxlength="8" placeholder="可留空"></label><label>保存目录<input id="bpth-destination" placeholder="/ 或 /资料"></label></div>
        <div class="row"><label>每夹最多文件数<input id="bpth-max-files" type="number" min="0" step="1" placeholder="0 = 不限制"></label><label>分批文件夹前缀<input id="bpth-prefix" maxlength="20" placeholder="留空则为 1、2、3"></label></div>
        <details class="bpth-tips">
          <summary>每夹最多文件数怎么填？</summary>
          <p>· 填 0：不限制，转存速度最快。</p>
          <p>· 填个数（如 100）：每个文件夹最多存这么多，超出的自动分到新文件夹，名字为「前缀+序号」（填「批」得 批1、批2，留空得 1、2），所有层级的文件夹都按此处理。</p>
          <p>· 分享中的文件夹总数超过 40 个时，不建议填写——转存前会先扫描所有文件夹，速度明显更慢，还容易触发百度限流。</p>
        </details>
      </section>
      <section class="bpth-card bpth-col-pick">
        <div class="bpth-card-head"><span class="bpth-card-title">选择转存内容</span><button id="bpth-read" type="button">读取分享内容</button></div>
        <p id="bpth-read-status" class="hint"></p>
        <div id="bpth-pick-empty">
          <strong>尚未读取分享内容</strong>
          <span>不读取也可以直接转存全部；<br>读取后可只勾选需要的文件夹或文件。</span>
        </div>
        <div id="bpth-pick" hidden>
          <div class="bpth-pick-head"><label class="bpth-pick-all"><input id="bpth-pick-all" type="checkbox" checked>全选</label><span id="bpth-pick-count"></span></div>
          <div id="bpth-pick-items"></div>
          <p class="hint">点 ▸ 展开文件夹；勾选文件夹即转存整个文件夹</p>
        </div>
      </section>
    </div>
    <div id="bpth-status"></div>
    <div class="bpth-actions"><button id="bpth-start" type="button">开始转存</button><button id="bpth-cancel" type="button" hidden>取消转存</button></div>
  `;
  document.documentElement.append(launcher, panel);

  const byId = (id) => panel.querySelector(`#${id}`);
  const urlInput = byId("bpth-url");
  const passwordInput = byId("bpth-password");
  const destinationInput = byId("bpth-destination");
  const maxFilesInput = byId("bpth-max-files");
  const prefixInput = byId("bpth-prefix");
  const startButton = byId("bpth-start");
  const cancelButton = byId("bpth-cancel");
  const status = byId("bpth-status");
  const readButton = byId("bpth-read");
  const readStatus = byId("bpth-read-status");
  const pickEmpty = byId("bpth-pick-empty");
  const pickBox = byId("bpth-pick");
  const pickAll = byId("bpth-pick-all");
  const pickCount = byId("bpth-pick-count");
  const pickItems = byId("bpth-pick-items");
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  // 当前页就是分享页时以它为准（历史记录只作为回退），否则自动填充会被旧链接一直压住
  const pageShareLink = /\/s\/1|surl=/.test(location.href) ? location.href : "";
  const pagePwd = pageShareLink ? new URL(location.href).searchParams.get("pwd") || "" : "";
  urlInput.value = pageShareLink || saved.url || "";
  // 提取码以当前分享页为准：本页 URL 没有 pwd 参数就留空，绝不沿用上一次分享的提取码
  passwordInput.value = pageShareLink ? pagePwd : saved.password || "";
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
  for (const input of [urlInput, passwordInput]) input.addEventListener("change", resetPicker);
  function isPickerEmpty() {
    return picker.ready && collectPicked(picker.nodes).length === 0;
  }

  function syncStart() {
    startButton.disabled = running || isPickerEmpty();
  }

  function syncPickSummary(count) {
    pickAll.checked = picker.nodes.length > 0 && picker.nodes.every((node) => node.checked);
    pickCount.textContent = `已选 ${count} 项`;
  }

  function joinRelative(parentRelative, name) {
    return `${parentRelative || ""}/${name}`.replace(/\/+/g, "/");
  }

  function makeNode(item, parentRelative, level) {
    return {
      id: item.id,
      name: item.name,
      isDirectory: Boolean(item.isDirectory),
      path: item.path || "",
      parentRelative: String(parentRelative || "").replace(/\/+$/, ""),
      level,
      children: null,
      expanded: false,
      loading: false,
      checked: false,
      disabled: false
    };
  }

  function visibleNodes(nodes, out = []) {
    for (const node of nodes) {
      out.push(node);
      if (node.expanded && node.children) visibleNodes(node.children, out);
    }
    return out;
  }

  function setSubtreeChecked(node, value) {
    if (!node.children) return;
    for (const child of node.children) {
      child.checked = value;
      child.disabled = value;
      setSubtreeChecked(child, value);
    }
  }

  function collectPicked(nodes, out = []) {
    for (const node of nodes) {
      if (node.checked) {
        out.push({ id: node.id, name: node.name, isDirectory: node.isDirectory, path: node.path, parentRelative: node.parentRelative });
        continue;
      }
      if (node.children) collectPicked(node.children, out);
    }
    return out;
  }

  async function ensureShareReader() {
    const url = urlInput.value.trim();
    const password = passwordInput.value.trim();
    if (shareReader && shareReader.url === url && shareReader.password === password) return shareReader.transfer;
    const transfer = new BaiduPanTransfer({});
    await transfer.loadShare(url, password);
    shareReader = { transfer, url, password };
    return transfer;
  }

  async function toggleNode(node) {
    if (!node.isDirectory || node.loading) return;
    if (node.expanded) {
      node.expanded = false;
      renderPicker();
      return;
    }
    if (!node.children) {
      node.loading = true;
      renderPicker();
      try {
        const transfer = await ensureShareReader();
        const children = await transfer.listShareChildren(node.parentRelative || "", node.name, node.path);
        const childParent = joinRelative(node.parentRelative, node.name);
        node.children = children.map((item) =>
          makeNode({ id: item.id, name: item.name, isDirectory: item.isDirectory, path: item.path }, childParent, node.level + 1)
        );
        if (node.checked) setSubtreeChecked(node, true);
      } catch (error) {
        node.loading = false;
        readStatus.textContent = `读取子目录失败：${error.message}`;
        renderPicker();
        return;
      }
      node.loading = false;
    }
    node.expanded = true;
    renderPicker();
  }

  function renderPicker() {
    pickItems.textContent = "";
    for (const node of visibleNodes(picker.nodes)) {
      const row = document.createElement("div");
      row.className = "bpth-pick-row";
      row.style.paddingLeft = `${node.level * 12}px`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "bpth-pick-toggle";
      toggle.textContent = node.isDirectory ? (node.loading ? "…" : node.expanded ? "▾" : "▸") : "";
      toggle.disabled = !node.isDirectory || node.loading;
      if (node.isDirectory) toggle.addEventListener("click", () => { void toggleNode(node); });
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = node.checked;
      box.disabled = node.disabled;
      box.addEventListener("change", () => {
        node.checked = box.checked;
        setSubtreeChecked(node, box.checked);
        renderPicker();
      });
      const name = document.createElement("span");
      name.className = "bpth-pick-name";
      name.textContent = node.name;
      name.title = node.name;
      const tag = document.createElement("span");
      tag.className = "bpth-pick-tag";
      tag.textContent = node.isDirectory ? (node.children ? `${node.children.length} 项` : "文件夹") : "文件";
      row.append(toggle, box, name, tag);
      pickItems.append(row);
    }
    syncPickSummary(collectPicked(picker.nodes).length);
    syncStart();
  }

  function resetPicker() {
    picker.ready = false;
    picker.nodes = [];
    pickBox.hidden = true;
    pickEmpty.hidden = false;
    readStatus.textContent = "";
    syncStart();
  }

  readButton.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return urlInput.focus();
    readButton.disabled = true;
    readButton.textContent = "正在读取…";
    readStatus.textContent = "";
    try {
      const transfer = await ensureShareReader();
      const items = [
        ...transfer.directories.map((item) => ({ id: Number(item.id), name: item.name, isDirectory: true, path: item.path || "" })),
        ...transfer.files.map((item) => ({ id: Number(item.id), name: item.name, isDirectory: false, path: item.path || "" }))
      ];
      if (!items.length) throw new Error("分享中没有可转存的内容");
      picker.nodes = items.map((item) => makeNode(item, "", 0));
      picker.ready = true;
      pickEmpty.hidden = true;
      pickBox.hidden = false;
      renderPicker();
      readStatus.textContent = `已读取 ${items.length} 项，可展开文件夹继续选择`;
    } catch (error) {
      picker.ready = false;
      picker.nodes = [];
      pickBox.hidden = true;
      pickEmpty.hidden = false;
      readStatus.textContent = `读取失败：${error.message}`;
    } finally {
      readButton.disabled = false;
      readButton.textContent = "读取分享内容";
      syncStart();
    }
  });

  pickAll.addEventListener("change", (event) => {
    for (const node of picker.nodes) {
      node.checked = event.target.checked;
      node.disabled = false;
      setSubtreeChecked(node, event.target.checked);
    }
    renderPicker();
  });

  startButton.addEventListener("click", async () => {
    if (running) return;
    if (!urlInput.value.trim()) return urlInput.focus();
    if (isPickerEmpty()) return;
    save();
    running = true;
    startButton.disabled = true;
    startButton.textContent = "正在转存…";
    cancelButton.hidden = false;
    cancelButton.disabled = false;
    cancelButton.textContent = "取消转存";
    status.textContent = "";
    try {
      const maxFiles = Math.max(0, Math.floor(Number(maxFilesInput.value) || 0));
      const transfer = new BaiduPanTransfer({
        destination: destinationInput.value,
        maxFilesPerFolder: maxFiles,
        folderPrefix: prefixInput.value,
        selection: picker.ready ? collectPicked(picker.nodes) : undefined,
        onProgress: log
      });
      currentTransfer = transfer;
      await transfer.run(urlInput.value, passwordInput.value);
      log("✅ 转存成功，请刷新百度网盘文件列表");
      urlInput.value = "";
      passwordInput.value = "";
      save();
    } catch (error) {
      console.error("[百度网盘批量转存]", error);
      if (error && error.name === "TransferCancelledError") {
        log("已取消转存，已转存的文件会保留");
      } else {
        log(`❌ ${error.message}`);
        if (error && error.response !== undefined) {
          const detail = typeof error.response === "string"
            ? error.response.replace(/\s+/g, " ").trim().slice(0, 300)
            : JSON.stringify(error.response).slice(0, 300);
          if (detail && !String(error.message).includes(detail.slice(0, 40))) log(`↳ 百度返回：${detail}`);
        }
      }
    } finally {
      running = false;
      currentTransfer = null;
      startButton.textContent = "开始转存";
      syncStart();
      cancelButton.hidden = true;
    }
  });

  cancelButton.addEventListener("click", () => {
    cancelButton.disabled = true;
    cancelButton.textContent = "正在取消…";
    if (currentTransfer) currentTransfer.cancel();
  });
})();
