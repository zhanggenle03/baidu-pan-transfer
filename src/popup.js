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

async function restoreForm() {
  const data = await extCall(ext.storage.local, "get", ["transferForm", "transferState"]);
  const form = data.transferForm || {};
  fields.url.value = form.url || "";
  fields.password.value = form.password || "";
  fields.destination.value = form.destination || "";
  fields.maxFiles.value = form.maxFiles || "";
  fields.prefix.value = form.prefix || "";
  renderState(data.transferState || {});
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

async function checkLogin() {
  try {
    const cookies = await extCall(ext.cookies, "getAll", { domain: ".baidu.com" });
    $("#login").classList.toggle("hidden", cookies.some((cookie) => cookie.name.includes("BDUSS")));
  } catch (_) {}
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
