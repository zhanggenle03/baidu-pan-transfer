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

"use strict";

const hasBrowserNamespace = typeof globalThis.browser !== "undefined";
const ext = globalThis.browser || globalThis.chrome;
const { BaiduPanTransfer } = globalThis.BaiduTransferCore;
let running = false;

function call(api, method, ...args) {
  if (hasBrowserNamespace) return Promise.resolve(api[method](...args));
  return new Promise((resolve, reject) => {
    try {
      api[method](...args, (result) => {
        const error = globalThis.chrome.runtime.lastError;
        error ? reject(new Error(error.message)) : resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function setState(patch) {
  await call(ext.storage.local, "set", { transferState: { ...(await getState()), ...patch } });
}

async function getState() {
  const data = await call(ext.storage.local, "get", "transferState");
  return data?.transferState || {};
}

async function broadcast(message) {
  await call(ext.runtime, "sendMessage", message).catch(() => {});
}

async function report(message) {
  const state = await getState();
  const log = [...(state.log || []), { at: Date.now(), message }].slice(-80);
  await setState({ status: "running", message, log, updatedAt: Date.now() });
  await broadcast({ type: "TRANSFER_PROGRESS", message });
}

async function startTransfer({ url, password, destination }) {
  if (running) throw new Error("已有转存任务正在运行");
  running = true;
  let progressQueue = Promise.resolve();
  try {
    await setState({ status: "running", message: "准备开始…", log: [], startedAt: Date.now(), updatedAt: Date.now() });
    const transfer = new BaiduPanTransfer({
      destination,
      onProgress: (message) => { progressQueue = progressQueue.then(() => report(message)); }
    });
    const result = await transfer.run(url, password);
    await progressQueue;
    await setState({ status: "complete", message: "全部转存完成", result, updatedAt: Date.now() });
    await broadcast({ type: "TRANSFER_COMPLETE", result });
  } catch (error) {
    await progressQueue.catch(() => {});
    await setState({ status: "error", message: error.message, error: error.message, updatedAt: Date.now() });
    await broadcast({ type: "TRANSFER_ERROR", error: error.message });
  } finally {
    running = false;
  }
}

async function ensureNetRules() {
  if (!ext.declarativeNetRequest?.updateDynamicRules) return;
  const base = {
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: "https://pan.baidu.com" },
        { header: "Referer", operation: "set", value: "https://pan.baidu.com/disk/main?from=homeFlow" },
        { header: "Sec-Fetch-Site", operation: "set", value: "same-origin" }
      ]
    },
    condition: {
      urlFilter: "||pan.baidu.com/",
      requestDomains: ["pan.baidu.com"],
      resourceTypes: ["xmlhttprequest"]
    }
  };
  try {
    await ext.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{ ...base, condition: { ...base.condition, initiatorDomains: [ext.runtime.id] } }]
    });
  } catch (_) {
    await ext.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: [base] });
  }
}

ext.runtime.onInstalled.addListener(() => ensureNetRules().catch(console.error));
ext.runtime.onStartup?.addListener(() => ensureNetRules().catch(console.error));
ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_TRANSFER") {
    if (running) {
      const response = { ok: false, error: "已有转存任务正在运行" };
      if (hasBrowserNamespace) return Promise.resolve(response);
      sendResponse(response);
      return false;
    }
    void startTransfer(message.payload);
    const response = { ok: true };
    if (hasBrowserNamespace) return Promise.resolve(response);
    sendResponse(response);
    return false;
  }
  if (message?.type === "GET_STATE") {
    const promise = getState().then(
      (state) => ({ ok: true, state }),
      (error) => ({ ok: false, error: error.message })
    );
    if (hasBrowserNamespace) return promise;
    promise.then(sendResponse);
    return true;
  }
  return false;
});

ensureNetRules().catch(console.error);
