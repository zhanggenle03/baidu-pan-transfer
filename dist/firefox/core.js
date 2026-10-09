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
