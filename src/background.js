"use strict";

const hasBrowserNamespace = typeof globalThis.browser !== "undefined";
const ext = globalThis.browser || globalThis.chrome;
const { BaiduPanTransfer } = globalThis.BaiduTransferCore;
let running = false;
let keepAliveTimer = null;

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

async function startTransfer({ url, password, destination, maxFilesPerFolder, folderPrefix }) {
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
