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
    await new BaiduPanTransfer({}).getBdstoken();
    return "yes";
  } catch (error) {
    if (error && (error.errno === -6 || /未登录|未检测到百度网盘登录状态/.test(error.message || ""))) {
      return "no";
    }
    return "unknown";
  }
}

// 分享读取会话：展开子目录时复用已加载的分享状态，避免重复读取分享页
let shareSession = null;

async function getShareSession(url, password) {
  if (shareSession && shareSession.url === url && shareSession.password === password) return shareSession.transfer;
  const transfer = new BaiduPanTransfer({});
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
      await setState({ status: "error", message: error.message, error: error.message, updatedAt: Date.now() });
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
