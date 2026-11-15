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
      // 解析失败时保留页面片段，便于在日志里定位是登录页/验证页还是真的改版
      this.html = options.html;
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

  // 从 start（指向 JSON 起始字符）向后做括号配平，返回 JSON 结束后的下标。
  // 早先版本用 indexOf("});") 截断，一旦字符串值里出现 }); 就会截错，这里改为配平扫描。
  function findJsonEnd(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) return index + 1;
        if (depth < 0) return -1;
      }
    }
    return -1;
  }

  // 收集页面里所有 locals.mset(...) 的数据段：百度会把登录态、分享元信息拆成多段注入，
  // 取「第一个」并不保险，必须按内容挑。
  function collectLocalsSegments(html) {
    const segments = [];
    const pattern = /locals\.mset\s*\(/g;
    let match;
    while ((match = pattern.exec(html))) {
      const jsonStart = match.index + match[0].length;
      const end = findJsonEnd(html, jsonStart);
      if (end < 0) continue;
      try {
        const data = JSON.parse(html.slice(jsonStart, end));
        if (data && typeof data === "object") segments.push(data);
      } catch (_) {
        /* 单段解析失败不影响其它段 */
      }
      pattern.lastIndex = end;
    }
    return segments;
  }

  // 新版分享页把 shareid / share_uk 放到 window.yunData（JS 对象字面量，非严格 JSON）
  function parseYunData(html) {
    const start = html.indexOf("window.yunData");
    if (start < 0) return null;
    const braceStart = html.indexOf("{", start);
    if (braceStart < 0) return null;
    const end = findJsonEnd(html, braceStart);
    if (end < 0) return null;
    const raw = html.slice(braceStart, end);
    try {
      return JSON.parse(raw.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"'));
    } catch (_) {
      // 新版页面这里只是一段模板（shareid: data.shareid），必须只接受纯数字，
      // 否则会把占位符当成真实分享标识，后续列表请求必然 404。
      const pick = (key) => {
        const found = raw.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']?([^"',}]+)`));
        const value = found ? found[1].trim() : "";
        return /^\d+$/.test(value) ? value : "";
      };
      return { shareid: pick("shareid"), share_uk: pick("share_uk") };
    }
  }

  function pageTitle(html) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? match[1].replace(/\s+/g, " ").trim().slice(0, 60) : "";
  }

  // 兜底：新版页面把分享数据挂在 locals.mset 之外（window.yunData / 页面内联对象等），
  // 直接按 "file_list":[{...}] 在全文中定位并配平取出，不依赖外层变量名。
  function findInlinedFileList(html) {
    const pattern = /["']?file_list["']?\s*:\s*/g;
    let match;
    while ((match = pattern.exec(html))) {
      const valueStart = match.index + match[0].length;
      if (html[valueStart] !== "[") continue;
      const end = findJsonEnd(html, valueStart);
      if (end < 0) continue;
      try {
        const list = JSON.parse(html.slice(valueStart, end));
        if (Array.isArray(list) && list.length) return list;
      } catch (_) {}
      pattern.lastIndex = end;
    }
    return null;
  }

  // 兜底：从全文里捞一个数字型字段（shareid / share_uk）
  function findNumericField(html, key) {
    const match = html.match(new RegExp(`["']?${key}["']?\\s*:\\s*"?([0-9]{1,20})"?`));
    return match ? Number(match[1]) : "";
  }

  // 提取码页：说明验证票据（BDCLND）没有生效，页面被打回了验证入口
  function isPasscodePage(html) {
    return typeof html === "string" && /请输入提取码/.test(html);
  }

  // 页面特征摘要：排查「读不到分享内容」时，先确认拿到的是什么页面
  function describeSharePage(html) {
    if (typeof html !== "string") return "分享页返回的不是网页内容";
    const title = pageTitle(html);
    const sizeKb = Math.max(1, Math.round(html.length / 1024));
    const inlined = findInlinedFileList(html);
    const segments = collectLocalsSegments(html).length;
    return `分享页：${title || "无标题"}（${sizeKb} KB，文件列表 ${inlined ? inlined.length : 0} 项，内联数据 ${segments} 段）`;
  }

  // 解析不到分享数据时，按返回页面特征给出可执行的提示，而不是一律「页面结构已更新」
  function diagnoseSharePage(html) {
    const title = pageTitle(html);
    const sizeKb = Math.max(1, Math.round(html.length / 1024));
    if (/请输入提取码|提取码/.test(html)) return "分享需要提取码，或提取码不正确";
    if (/页面不存在|你来晚了|已被取消|已删除|链接错误|分享已失效/.test(html)) {
      return "分享不存在或已被取消，请确认链接是否仍然有效";
    }
    if (/wappass|百度安全验证|安全验证|验证码/.test(html)) {
      return "百度要求安全验证，请在浏览器中打开该分享链接完成验证后再试";
    }
    if (/passport\.baidu\.com|请登录|登录百度账号/.test(html)) {
      return "百度网盘登录状态可能已失效，请重新登录后重试";
    }
    return `无法解析分享页（返回页面标题「${title || "无"}」，${sizeKb} KB），链接可能已失效或百度页面结构已更新`;
  }

  // 从分享页 HTML 里抽出分享标识与文件列表（不校验完整性，供正常解析与兜底复用）
  function readShareData(html) {
    const segments = collectLocalsSegments(html);
    const yunData = parseYunData(html);
    // 优先选真正带文件列表的那一段；否则退到带分享标识的段
    let shareData = null;
    let fallback = null;
    for (const segment of segments) {
      const list = Array.isArray(segment.file_list) ? segment.file_list : null;
      if (list && list.length) {
        shareData = segment;
        break;
      }
      if (!fallback && (segment.shareid || segment.share_uk)) fallback = segment;
    }
    if (!shareData && fallback) shareData = fallback;
    // 文件列表可能根本不在内联段里（新版模板），退到全文搜索
    let files = Array.isArray(shareData && shareData.file_list) ? shareData.file_list : [];
    if (!files.length) files = findInlinedFileList(html) || [];
    const shareId = (shareData && shareData.shareid) || (yunData && yunData.shareid) || findNumericField(html, "shareid");
    const shareUk = (shareData && shareData.share_uk) || (yunData && yunData.share_uk) || findNumericField(html, "share_uk");
    return {
      segment: shareData,
      shareId,
      shareUk,
      bdstoken: shareData && shareData.bdstoken,
      files
    };
  }

  function parseSharePage(html) {
    if (html && typeof html === "object") {
      const errno = Number(html.errno);
      const message = html.show_msg || html.errmsg;
      if (message) throw new BaiduPanError(message, { errno, response: html });
      throw new BaiduPanError("分享页返回格式异常，请稍后重试", { response: html });
    }
    if (typeof html !== "string") {
      throw new BaiduPanError("分享页返回格式异常，请稍后重试");
    }
    const { segment: shareData, shareId, shareUk, files } = readShareData(html);
    if (!shareId || !shareUk) {
      throw new BaiduPanError(diagnoseSharePage(html), { html });
    }
    if (!files.length) {
      // 提取码页同样内联了 shareid/share_uk，但没有文件列表；此时提示提取码才有指导意义
      if (/请输入提取码/.test(html)) {
        throw new BaiduPanError("分享需要提取码，或提取码不正确", { html });
      }
      // 拿到分享标识但没内联文件列表：新版页面可能改为异步拉取，交由调用方用 /share/list 补齐
      return {
        userId: shareUk,
        shareId,
        bdstoken: shareData && shareData.bdstoken,
        shareRoot: "",
        directories: [],
        files: [],
        needsListing: true
      };
    }
    return {
      userId: shareUk,
      shareId,
      bdstoken: shareData && shareData.bdstoken,
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
      // 可选：由宿主（扩展后台）注入的 Cookie 写入能力，用于兜底保存分享验证票据
      this.setShareCookie = typeof options.setShareCookie === "function" ? options.setShareCookie : null;
      // 可选：遇到 errno -6 时由宿主修复登录 Cookie（跨站请求不携带 SameSite=Lax 凭证）
      this.repairSession = typeof options.repairSession === "function" ? options.repairSession : null;
      this.repairedSession = false;
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
      let data;
      try {
        data = await this.request("/api/gettemplatevariable", {
          query: `fields=${encodeURIComponent('["bdstoken"]')}`,
          checkErrno: true
        });
      } catch (error) {
        // errno -6 是百度的「未登录」。扩展后台是跨站请求，BDUSS 这类默认 SameSite=Lax
        // 的凭证可能被浏览器拦下，先让宿主修复一次 cookie 再重试。
        if (Number(error && error.errno) === -6) {
          if (this.repairSession && !this.repairedSession) {
            this.repairedSession = true;
            let repaired = false;
            try {
              repaired = await this.repairSession();
            } catch (_) {}
            if (repaired) return this.getBdstoken();
          }
          throw new BaiduPanError("百度网盘登录状态已失效，请在浏览器登录网盘后重试", { errno: -6 });
        }
        throw error;
      }
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
      // 扩展后台是跨域 fetch，部分浏览器不会保存验证接口返回的 Set-Cookie，
      // 这样后续 GET /s/... 会被打回提取码页，表现为「读取成功但拿不到文件列表」。
      await this.persistShareCookie(data.randsk);
      return data.randsk;
    }

    // 主动写入分享票据 Cookie；写入失败时提示用户手动兜底
    async persistShareCookie(randsk) {
      if (!this.setShareCookie || !randsk) return;
      try {
        const written = await this.setShareCookie("BDCLND", randsk);
        if (written === false) {
          this.progress("⚠️ 未能写入分享验证 Cookie，如仍读取失败请先在浏览器中打开该分享页");
        }
      } catch (_) {}
    }

    async loadShare(input, password = "") {
      const shareKey = extractShareKey(input);
      if (!shareKey) throw new BaiduPanError("无法从输入内容中识别百度网盘分享链接");
      if (password) await this.verifyShare(shareKey, password);
      let html;
      try {
        html = await this.request(`/s/1${shareKey}`);
      } catch (error) {
        // 分享被取消或链接写错时百度直接返回 404 页，此时报「网络请求失败」会误导用户
        if (/HTTP 404/.test(String(error && error.message))) {
          throw new BaiduPanError("分享不存在或已被取消，请确认链接是否仍然有效");
        }
        throw error;
      }
      // 提取码页说明验证票据（BDCLND）没生效：扩展后台的跨域请求有时存不下
      // 验证接口下发的 Set-Cookie。重新验证一次（同时主动写 cookie）再要一次页面。
      if (password && isPasscodePage(html)) {
        this.progress("分享页返回了提取码页，正在重新验证并重试…");
        try {
          await this.verifyShare(shareKey, password);
          const retried = await this.request(`/s/1${shareKey}`);
          if (!isPasscodePage(retried)) html = retried;
        } catch (_) {}
      }
      this.progress(describeSharePage(html));
      let data;
      try {
        data = parseSharePage(html);
      } catch (error) {
        data = await this.loadShareFallback(shareKey, error);
      }
      // 新版页面不含 bdstoken，直接 assign 会把 verifyShare 已取到的值覆盖成空，
      // 导致后续请求全部丢 token，因此只在页面确实带了值时才更新。
      if (data.bdstoken) this.bdstoken = data.bdstoken;
      delete data.bdstoken;
      Object.assign(this, data);
      if (data.needsListing) await this.listShareRoot();
      return data;
    }

    // 主页面认不出来时的兜底：提取码页同样内联了 shareid / share_uk，
    // 拿到标识就能自己列目录，不必依赖页面里的 file_list
    async loadShareFallback(shareKey, cause) {
      let identity = null;
      try {
        const initHtml = await this.request(`/share/init?surl=${encodeURIComponent(shareKey)}`);
        if (typeof initHtml === "string") identity = readShareData(initHtml);
      } catch (_) {}
      if (!identity || !identity.shareId || !identity.shareUk) throw cause;
      return {
        userId: identity.shareUk,
        shareId: identity.shareId,
        bdstoken: identity.bdstoken,
        shareRoot: identity.files.length ? identity.files[0].parent_path || "" : "",
        directories: [],
        files: [],
        needsListing: true
      };
    }

    // 分享页没有内联文件列表时的兜底：主动列一次分享根目录（新版页面可能改为异步加载列表）
    async listShareRoot() {
      const candidates = [this.shareRoot, "/"].filter((value, index, list) => value && list.indexOf(value) === index);
      let lastError = null;
      for (const dir of candidates) {
        try {
          const children = await this.listShareDirectory(dir);
          if (!children.length) continue;
          this.shareRoot = dir;
          this.directories = children.filter((item) => item.isDirectory);
          this.files = children.filter((item) => !item.isDirectory);
          return;
        } catch (error) {
          lastError = error;
          if (!this.isDirCandidateMiss(error)) throw error;
        }
      }
      throw new BaiduPanError(
        lastError
          ? `无法读取分享目录（shareid=${this.shareId}）：${lastError.message}`
          : "分享页没有可转存的文件，或分享已失效",
        { errno: lastError && lastError.errno }
      );
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
      if (!this.bdstoken) await this.getBdstoken();
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
      // 兜底：未取过 token 时先补（否则 URL 里会拼出 bdstoken=null，百度回 -6）
      if (!this.bdstoken) await this.getBdstoken();
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
      // 页数上限是防御性的：接口异常时若始终返回满页，for(;;) 会无限翻页把内存吃光
      for (let page = 1; page <= 1000; page += 1) {
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
      return result;
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
      // 读分享页不需要登录，转存却必须带 bdstoken；这里补一次，
      // 否则 bdstoken=null 会让百度把请求判定为未登录（errno -6）。
      await this.getBdstoken();
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
    diagnoseSharePage,
    describeSharePage,
    isPasscodePage,
    readShareData,
    findJsonEnd,
    collectLocalsSegments,
    parseYunData,
    encodePath
  };
});

"use strict";

const hasBrowserNamespace = typeof globalThis.browser !== "undefined";
const ext = globalThis.browser || globalThis.chrome;
const { BaiduPanTransfer } = globalThis.BaiduTransferCore;
let running = false;
let keepAliveTimer = null;
let currentTransfer = null;

// A transfer can pause for up to 30s while waiting out a Baidu rate limit.
// A pending timer does not keep an MV3 service worker alive, so ping a
// lightweight extension API periodically to reset the idle-termination timer.
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    call(ext.runtime, "getPlatformInfo").catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

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

// 读出 Cookie 时的兜底探测：直接请求百度接口判断登录态，返回 yes / no / unknown。
// 注意「用 cookies.getAll 读不到 BDUSS」不是接口的问题，而是 host 权限未覆盖 baidu.com，
// 该情况已在 manifest 中修正，这里只作为 Cookie API 不可用时的备用路径，因此不做缓存（避免退出登录后仍报已登录）。
async function detectLogin() {
  try {
    await new BaiduPanTransfer({ repairSession: repairSessionCookies }).getBdstoken();
    return "yes";
  } catch (error) {
    if (error && (error.errno === -6 || /未登录|未检测到百度网盘登录状态/.test(error.message || ""))) {
      return "no";
    }
    return "unknown";
  }
}

// 主动写入分享票据 Cookie：MV3 后台是跨域 fetch，部分浏览器不会保存验证接口的
// Set-Cookie（百度下发的 BDCLND 没有 SameSite 属性，跨站上下文会被丢弃），
// 缺了它后续请求会被打回提取码页，所以验证成功后自己写一次并回报是否成功。
async function setBaiduCookie(name, value) {
  const base = { url: "https://pan.baidu.com/", name, value, path: "/" };
  try {
    const cookie = await call(ext.cookies, "set", { ...base, secure: true, sameSite: "no_restriction" });
    if (cookie) return true;
  } catch (_) {}
  try {
    const cookie = await call(ext.cookies, "set", { ...base, secure: true });
    if (cookie) return true;
  } catch (_) {}
  try {
    const cookie = await call(ext.cookies, "set", base);
    if (cookie) return true;
  } catch (_) {}
  return false;
}

// 登录凭证的 SameSite 默认是 Lax，扩展后台发起的是跨站请求，浏览器不会携带，
// 表现为「浏览器里明明已登录，接口却回 errno -6」。这里把它们改写成
// SameSite=None; Secure（值不变），让扩展的请求也能带上；返回是否有改动供重试用。
const SESSION_COOKIE_NAMES = ["BDUSS", "BDUSS_BFESS", "STOKEN", "PANWEB", "PANPSC"];

async function repairSessionCookies() {
  let list;
  try {
    list = await call(ext.cookies, "getAll", { domain: ".baidu.com" });
  } catch (_) {
    return false;
  }
  if (!Array.isArray(list) || !list.length) return false;
  let changed = false;
  for (const cookie of list) {
    if (!SESSION_COOKIE_NAMES.includes(cookie.name)) continue;
    if (cookie.secure && cookie.sameSite === "no_restriction") continue;
    const details = {
      domain: cookie.domain,
      path: cookie.path || "/",
      secure: true,
      name: cookie.name,
      value: cookie.value,
      httpOnly: cookie.httpOnly,
      sameSite: "no_restriction"
    };
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    try {
      await call(ext.cookies, "set", details);
      changed = true;
    } catch (_) {}
  }
  return changed;
}

// 分享读取会话：展开子目录时复用已加载的分享状态，避免重复读取分享页
let shareSession = null;

async function getShareSession(url, password) {
  if (shareSession && shareSession.url === url && shareSession.password === password) return shareSession.transfer;
  const transfer = new BaiduPanTransfer({ setShareCookie: setBaiduCookie, repairSession: repairSessionCookies });
  await transfer.loadShare(url, password);
  shareSession = { transfer, url, password };
  return transfer;
}

// 读取分享清单，供弹窗勾选（只读，不转存）；传入 dir 时读取该目录的子项
async function readShare(url, password, dir) {
  const transfer = await getShareSession(url, password);
  if (dir) {
    const children = await transfer.listShareChildren(dir.relative || "", dir.name, dir.path || "");
    return {
      items: children.map((item) => ({ id: Number(item.id), name: item.name, isDirectory: item.isDirectory, path: item.path || "" }))
    };
  }
  return {
    items: [
      ...transfer.directories.map((item) => ({ id: Number(item.id), name: item.name, isDirectory: true, path: item.path || "", size: Number(item.size) || 0 })),
      ...transfer.files.map((item) => ({ id: Number(item.id), name: item.name, isDirectory: false, path: item.path || "", size: Number(item.size) || 0 }))
    ]
  };
}

async function startTransfer({ url, password, destination, maxFilesPerFolder, folderPrefix, selection }) {
  if (running) throw new Error("已有转存任务正在运行");
  running = true;
  startKeepAlive();
  let progressQueue = Promise.resolve();
  try {
    await setState({ status: "running", message: "准备开始…", log: [], startedAt: Date.now(), updatedAt: Date.now() });
    const transfer = new BaiduPanTransfer({
      destination,
      maxFilesPerFolder,
      folderPrefix,
      selection,
      setShareCookie: setBaiduCookie,
      repairSession: repairSessionCookies,
      onProgress: (message) => { progressQueue = progressQueue.then(() => report(message)); }
    });
    currentTransfer = transfer;
    const result = await transfer.run(url, password);
    await progressQueue;
    await setState({ status: "complete", message: "全部转存完成", result, updatedAt: Date.now() });
    await broadcast({ type: "TRANSFER_COMPLETE", result });
  } catch (error) {
    await progressQueue.catch(() => {});
    if (error && error.name === "TransferCancelledError") {
      await setState({ status: "cancelled", message: "已取消", updatedAt: Date.now() });
      await broadcast({ type: "TRANSFER_CANCELLED" });
    } else {
      const patch = { status: "error", message: error.message, error: error.message, updatedAt: Date.now() };
      // 解析分享页失败时留一份页面片段，方便判断是登录页、验证页还是真的改版
      if (error && typeof error.html === "string" && error.html) {
        patch.sharePageSnippet = error.html.slice(0, 4000);
      }
      await setState(patch);
      await broadcast({ type: "TRANSFER_ERROR", error: error.message });
    }
  } finally {
    running = false;
    currentTransfer = null;
    stopKeepAlive();
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
  if (message?.type === "CANCEL_TRANSFER") {
    const cancelled = Boolean(currentTransfer);
    if (cancelled) currentTransfer.cancel();
    const response = cancelled ? { ok: true } : { ok: false, error: "没有正在运行的转存任务" };
    if (hasBrowserNamespace) return Promise.resolve(response);
    sendResponse(response);
    return false;
  }
  if (message?.type === "READ_SHARE") {
    const payload = message.payload || {};
    const promise = readShare(payload.url || "", payload.password || "", payload.dir || null).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error: error.message })
    );
    if (hasBrowserNamespace) return promise;
    promise.then(sendResponse);
    return true;
  }
  if (message?.type === "CHECK_LOGIN") {
    const promise = detectLogin().then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error: error.message })
    );
    if (hasBrowserNamespace) return promise;
    promise.then(sendResponse);
    return true;
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
