"use strict";
const hasBrowserNamespace = typeof globalThis.browser !== "undefined";
const ext = globalThis.browser || globalThis.chrome;
const $ = (selector) => document.querySelector(selector);
const fields = {
  url: $("#url"),
  password: $("#password"),
  destination: $("#destination"),
  maxFiles: $("#maxFiles"),
  prefix: $("#prefix")
};

function extCall(api, method, ...args) {
  if (hasBrowserNamespace) return Promise.resolve(api[method](...args));
  return new Promise((resolve, reject) => {
    try {
      api[method](...args, (result) => {
        const error = globalThis.chrome.runtime.lastError;
        error ? reject(new Error(error.message)) : resolve(result);
      });
    } catch (error) { reject(error); }
  });
}

// 从活动标签页取出百度网盘分享链接（非分享页返回空）。
// 不需要 tabs 权限：host_permissions 已覆盖 baidu.com，tab.url 才可读；
// 其他站点的标签页读不到 url，返回空字符串，保持表单原值。
function shareLinkFromTab(tab) {
  const url = tab?.url || tab?.pendingUrl || "";
  if (!/^https:\/\/pan\.baidu\.com\//i.test(url)) return "";
  return /\/s\/1|surl=/i.test(url) ? url : "";
}

// 找当前活动标签页。currentWindow 在弹窗上下文中偶尔取不到，再用 lastFocusedWindow 兜底；
// 失败时输出警告而不是静默吞掉，避免「读不到标签页」被误当成「本页不是分享页」。
async function queryActiveTab() {
  for (const query of [{ active: true, currentWindow: true }, { active: true, lastFocusedWindow: true }]) {
    try {
      const tabs = await extCall(ext.tabs, "query", query);
      if (tabs && tabs.length) return tabs[0];
    } catch (error) {
      console.warn("[百度网盘批量转存] 读取活动标签页失败：", error);
    }
  }
  return null;
}

async function prefillFromActiveTab() {
  const shareUrl = shareLinkFromTab(await queryActiveTab());
  if (!shareUrl) return;
  fields.url.value = shareUrl;
  // 提取码以当前分享页为准：URL 里没有 pwd 就置空，绝不沿用上一次分享的提取码
  const pwd = shareUrl.match(/[?&]pwd=([^&#\s]+)/i);
  if (!pwd) {
    fields.password.value = "";
    return;
  }
  try {
    fields.password.value = decodeURIComponent(pwd[1]);
  } catch (_) {
    fields.password.value = pwd[1];
  }
}

async function restoreForm() {
  const data = await extCall(ext.storage.local, "get", ["transferForm", "transferState"]);
  const form = data.transferForm || {};
  fields.url.value = form.url || "";
  fields.password.value = form.password || "";
  fields.destination.value = form.destination || "";
  fields.maxFiles.value = form.maxFiles || "";
  fields.prefix.value = form.prefix || "";
  renderState(data.transferState || {});
  await prefillFromActiveTab();
}

async function saveForm() {
  await extCall(ext.storage.local, "set", { transferForm: {
    url: fields.url.value.trim(), password: fields.password.value.trim(), destination: fields.destination.value.trim(),
    maxFiles: fields.maxFiles.value.trim(), prefix: fields.prefix.value.trim()
  }});
}

function renderState(state) {
  const visible = state.status && state.status !== "idle";
  $("#status").classList.toggle("hidden", !visible);
  $("#status").classList.toggle("error", state.status === "error");
  $("#statusText").textContent = state.status === "complete" ? "转存完成" : state.status === "error" ? `转存失败：${state.message || "未知错误"}` : state.message || "正在转存…";
  $("#log").textContent = (state.log || []).map((item) => `• ${item.message}`).join("\n");
  $("#start").disabled = state.status === "running";
  $("#start").textContent = state.status === "running" ? "正在后台转存…" : "开始转存";
}

// BDUSS 位于父域 .baidu.com，只有 host_permissions 覆盖 baidu.com 才能读到，
// 因此 manifest 中除了 pan.baidu.com 还声明了 baidu.com / *.baidu.com。
const COOKIE_FILTERS = [{ domain: ".baidu.com" }, { url: "https://pan.baidu.com/" }];

// 返回 Cookie 数组；若两种过滤方式都失败则返回 null 表示「无法判定」
async function readBaiduCookies() {
  const results = await Promise.all(
    COOKIE_FILTERS.map((filter) => extCall(ext.cookies, "getAll", filter).catch(() => null))
  );
  if (!results.some((list) => Array.isArray(list))) return null;
  const seen = new Set();
  const cookies = [];
  for (const list of results) {
    for (const cookie of list || []) {
      const key = `${cookie.domain}|${cookie.name}|${cookie.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(cookie);
    }
  }
  return cookies;
}

async function checkLogin() {
  try {
    const cookies = await readBaiduCookies();
    if (cookies) {
      // Cookie 是权威信号：BDUSS 存在即已登录，不存在即未登录
      $("#login").classList.toggle("hidden", cookies.some((cookie) => cookie.name.includes("BDUSS")));
      return;
    }
    // 读不到 Cookie 时才退回后台接口探测，且只在明确未登录时提示
    const result = await extCall(ext.runtime, "sendMessage", { type: "CHECK_LOGIN" });
    $("#login").classList.toggle("hidden", result?.value !== "no");
  } catch (_) {
    $("#login").classList.add("hidden");
  }
}

$("#start").addEventListener("click", async () => {
  await saveForm();
  if (!fields.url.value.trim()) return fields.url.focus();
  $("#start").disabled = true;
  try {
    await extCall(ext.runtime, "sendMessage", { type: "START_TRANSFER", payload: {
      url: fields.url.value.trim(), password: fields.password.value.trim(), destination: fields.destination.value.trim(),
      maxFilesPerFolder: Math.max(0, Math.floor(Number(fields.maxFiles.value) || 0)),
      folderPrefix: fields.prefix.value.trim()
    }});
  } catch (error) {
    renderState({ status: "error", message: error.message });
  }
});

for (const field of Object.values(fields)) field.addEventListener("change", saveForm);
ext.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.transferState) renderState(changes.transferState.newValue || {});
});
ext.runtime.onMessage.addListener((message) => {
  if (message?.type?.startsWith("TRANSFER_")) restoreForm().catch(console.error);
});

restoreForm().catch(console.error);
checkLogin();
