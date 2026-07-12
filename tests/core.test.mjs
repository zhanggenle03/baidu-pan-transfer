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
    { fs_id: 1, isdir: 1, server_filename: "dir", parent_path: "/share-root" },
    { fs_id: 2, isdir: 0, server_filename: "file.txt", parent_path: "/share-root" }
  ]};
  const result = parseSharePage(`<script>locals.mset(${JSON.stringify(payload)});</script>`);
  assert.equal(result.directories[0].name, "dir");
  assert.equal(result.files[0].name, "file.txt");
  assert.equal(result.shareRoot, "/share-root");
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
