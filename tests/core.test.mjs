import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/core.js", import.meta.url), "utf8");
const context = { globalThis: {}, URL, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout };
context.globalThis = context;
vm.runInNewContext(source, context);
const { extractShareKey, normalizeDestination, parseSharePage, BaiduPanTransfer } = context.BaiduTransferCore;

test("extractShareKey supports normal and surl links", () => {
  assert.equal(extractShareKey("https://pan.baidu.com/s/1abcDEF?pwd=1234"), "abcDEF");
  assert.equal(extractShareKey("https://pan.baidu.com/share/init?surl=xyz987"), "xyz987");
  assert.equal(extractShareKey("not a link"), null);
});

test("normalizeDestination canonicalizes paths", () => {
  assert.equal(normalizeDestination("/"), "");
  assert.equal(normalizeDestination(" 资料//2026/ "), "/资料/2026");
  assert.throws(() => normalizeDestination("/资料/../私密"), /不能包含/);
});

test("parseSharePage extracts files and directories", () => {
  const payload = { share_uk: 10, shareid: 20, bdstoken: "token", file_list: [
    { fs_id: 1, isdir: 1, server_filename: "dir", parent_path: "/share-root", path: "/share-root/dir" },
    { fs_id: 2, isdir: 0, server_filename: "file.txt", parent_path: "/share-root", path: "/share-root/file.txt" }
  ]};
  const result = parseSharePage(`<script>locals.mset(${JSON.stringify(payload)});</script>`);
  assert.equal(result.directories[0].name, "dir");
  assert.equal(result.files[0].name, "file.txt");
  assert.equal(result.shareRoot, "/share-root");
  assert.equal(result.directories[0].path, "/share-root/dir");
  assert.equal(result.files[0].path, "/share-root/file.txt");
});

test("transferIds retries rate limits and encodes destination", async () => {
  const responses = [{ errno: 111 }, { errno: 0 }];
  const calls = [];
  const transfer = new BaiduPanTransfer({
    destination: "/资料",
    maxRetries: 2,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => JSON.stringify(responses.shift()) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2;
  // Avoid waiting in unit tests by making the first retry code use an immediate timer.
  const realSetTimeout = context.setTimeout;
  context.setTimeout = (fn) => realSetTimeout(fn, 0);
  await transfer.transferIds([3, 4], "/资料");
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.body, /path=%2F%E8%B5%84%E6%96%99/);
});

const realSetTimeout = context.setTimeout;
function fastTimers() {
  context.setTimeout = (fn) => realSetTimeout(fn, 0);
}
function jsonResponse(payload, extra = {}) {
  return async () => ({ ok: true, text: async () => JSON.stringify(payload), ...extra });
}

test("isRetryableError only accepts rate-limit style failures", () => {
  const transfer = new BaiduPanTransfer({ fetch: jsonResponse({ errno: 0 }) });
  assert.equal(transfer.isRetryableError({ errno: 111, message: "" }), true);
  assert.equal(transfer.isRetryableError({ errno: 1504, message: "" }), true);
  assert.equal(transfer.isRetryableError({ errno: 2, message: "请求超时，请稍后再试" }), true);
  assert.equal(transfer.isRetryableError({ errno: 12, message: "目录超过单次转存限制" }), false);
  assert.equal(transfer.isRetryableError(null), false);
});

test("request retries transient HTTP failures", async () => {
  fastTimers();
  let attempts = 0;
  const transfer = new BaiduPanTransfer({
    maxRetries: 3,
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 429, text: async () => "too many requests" };
      return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [] }) };
    }
  });
  const data = await transfer.request("/api/list", { checkErrno: true });
  assert.equal(attempts, 2);
  assert.equal(data.errno, 0);
});

test("transferFiles splits oversized batches into prefixed subfolders", async () => {
  fastTimers();
  const posted = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 2,
    folderPrefix: "批",
    requestDelay: 0,
    fetch: async (url, options) => {
      if (options?.method === "POST") posted.push(new URLSearchParams(options.body).get("path"));
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2;
  const files = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, name: `f${index + 1}`, isDirectory: false }));
  await transfer.transferFiles(files, "/目标");
  assert.deepEqual(posted, ["/目标/批1", "/目标/批2", "/目标/批3"]);
});

test("transferFiles keeps a single folder when under the limit", async () => {
  fastTimers();
  const posted = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 10,
    folderPrefix: "批",
    requestDelay: 0,
    fetch: async (url, options) => {
      if (options?.method === "POST") posted.push(new URLSearchParams(options.body).get("path"));
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2;
  const files = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, name: `f${index + 1}`, isDirectory: false }));
  await transfer.transferFiles(files, "/目标");
  assert.deepEqual(posted, ["/目标"]);
});

function directoryHarness(maxFilesPerFolder) {
  const urls = [];
  const posted = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder,
    folderPrefix: "批",
    requestDelay: 0,
    fetch: async (url, options) => {
      urls.push(url);
      if (url.includes("/share/list")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [
          { fs_id: 11, server_filename: "a.txt", isdir: 0, path: "/share/dir/a.txt" }
        ]}) };
      }
      if (options?.method === "POST") posted.push(new URLSearchParams(options.body).get("path"));
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2; transfer.shareRoot = "/share";
  return { transfer, urls, posted };
}

test("setting maxFilesPerFolder expands directories instead of transferring them whole", async () => {
  fastTimers();
  const { transfer, urls, posted } = directoryHarness(2);
  await transfer.transferDirectories([{ id: 10, name: "dir", isDirectory: true, path: "/share/dir" }], "/目标");
  assert.ok(urls.some((url) => url.includes("/share/list")), "应调用 /share/list 逐层展开目录");
  assert.deepEqual(posted, ["/目标/dir"], "目录内的文件应落到同名子文件夹");
});

test("maxFilesPerFolder = 0 transfers directories whole without listing", async () => {
  fastTimers();
  const { transfer, urls, posted } = directoryHarness(0);
  await transfer.transferDirectories([{ id: 10, name: "dir", isDirectory: true, path: "/share/dir" }], "/目标");
  assert.ok(!urls.some((url) => url.includes("/share/list")), "整包转存不应调用 /share/list");
  assert.deepEqual(posted, ["/目标"], "目录应整包提交到目标目录");
});
