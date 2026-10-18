import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/core.js", import.meta.url), "utf8");
const context = { globalThis: {}, URL, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout };
context.globalThis = context;
vm.runInNewContext(source, context);
const { extractShareKey, normalizeDestination, parseSharePage, encodePath, BaiduPanTransfer } = context.BaiduTransferCore;

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

function directoryHarness(maxFilesPerFolder, listItems) {
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
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: listItems || [
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

test("setting maxFilesPerFolder expands directories whose direct files exceed the limit", async () => {
  fastTimers();
  const files = Array.from({ length: 3 }, (_, index) => ({ fs_id: 11 + index, server_filename: `f${index + 1}.txt`, isdir: 0, path: `/share/dir/f${index + 1}.txt` }));
  const { transfer, urls, posted } = directoryHarness(2, files);
  await transfer.transferDirectories([{ id: 10, name: "dir", isDirectory: true, path: "/share/dir" }], "/目标");
  assert.equal(urls.filter((url) => url.includes("/share/list")).length, 1, "探明与展开应复用同一次目录列表");
  assert.deepEqual(posted, ["/目标/dir/批1", "/目标/dir/批2"], "超过上限的文件应拆分到子文件夹");
});

test("maxFilesPerFolder = 0 transfers directories whole without listing", async () => {
  fastTimers();
  const { transfer, urls, posted } = directoryHarness(0);
  await transfer.transferDirectories([{ id: 10, name: "dir", isDirectory: true, path: "/share/dir" }], "/目标");
  assert.ok(!urls.some((url) => url.includes("/share/list")), "整包转存不应调用 /share/list");
  assert.deepEqual(posted, ["/目标"], "目录应整包提交到目标目录");
});

test("directories under the limit are merged into a single transfer request", async () => {
  fastTimers();
  const listCalls = [];
  const transferBodies = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    fetch: async (url, options) => {
      if (url.includes("/share/list")) {
        listCalls.push(url);
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [
          { fs_id: 100 + listCalls.length, server_filename: "f.txt", isdir: 0 }
        ]}) };
      }
      if (url.includes("/share/transfer")) {
        const body = new URLSearchParams(options.body);
        transferBodies.push({ ids: JSON.parse(body.get("fsidlist")), path: body.get("path") });
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2;
  await transfer.transferDirectories([
    { id: 10, name: "d1", isDirectory: true, path: "/share/d1" },
    { id: 20, name: "d2", isDirectory: true, path: "/share/d2" }
  ], "/目标");
  assert.equal(listCalls.length, 2, "每个目录探明一次");
  assert.equal(transferBodies.length, 1, "两个小目录应合并为一次提交");
  assert.deepEqual(transferBodies[0].ids, [10, 20]);
  assert.equal(transferBodies[0].path, "/目标");
});

test("recon cache and directory dedupe avoid repeated requests", async () => {
  fastTimers();
  const urls = [];
  const posted = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    folderPrefix: "批",
    requestDelay: 0,
    fetch: async (url, options) => {
      urls.push(url);
      if (url.includes("/share/list")) {
        const dir = new URL(url).searchParams.get("dir");
        const list = dir === "/share/dir"
          ? [
              { fs_id: 11, server_filename: "a.txt", isdir: 0, path: "/share/dir/a.txt" },
              { fs_id: 12, server_filename: "sub", isdir: 1, path: "/share/dir/sub" }
            ]
          : [{ fs_id: 13, server_filename: "b.txt", isdir: 0, path: "/share/dir/sub/b.txt" }];
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list }) };
      }
      if (options?.method === "POST") posted.push(new URLSearchParams(options.body).get("path"));
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2; transfer.shareRoot = "/share";
  await transfer.transferDirectories([{ id: 10, name: "dir", isDirectory: true, path: "/share/dir" }], "/目标");
  assert.equal(urls.filter((url) => url.includes("/share/list")).length, 2, "dir 与 sub 各探明一次，展开阶段复用缓存");
  const probes = urls.filter((url) => url.includes("/api/list") && url.includes(`dir=${encodePath("/目标/dir")}`));
  assert.equal(probes.length, 1, "同一目标目录只应探测一次");
  assert.equal(posted.length, 2, "子目录与直接文件各转存一次");
});

test("recon failure falls back to transferring the directory whole", async () => {
  fastTimers();
  const progress = [];
  const transferredIds = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    onProgress: (message) => progress.push(message),
    fetch: async (url, options) => {
      if (url.includes("/share/list")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 2 }) };
      }
      if (url.includes("/share/transfer")) {
        transferredIds.push(JSON.parse(new URLSearchParams(options.body).get("fsidlist")));
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2;
  await transfer.transferDirectories([{ id: 10, name: "d1", isDirectory: true, path: "/share/d1" }], "/目标");
  assert.deepEqual(transferredIds, [[10]], "列目录失败应降级为整体转存该目录");
  assert.ok(progress.some((message) => message.includes("整体转存")), "应提示降级说明");
});

test("merged transfer splits when Baidu reports the single-transfer limit", async () => {
  fastTimers();
  const transferBodies = [];
  let transfers = 0;
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    fetch: async (url, options) => {
      if (url.includes("/share/list")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [
          { fs_id: 1, server_filename: "f.txt", isdir: 0 }
        ]}) };
      }
      if (url.includes("/share/transfer")) {
        transfers += 1;
        transferBodies.push(JSON.parse(new URLSearchParams(options.body).get("fsidlist")));
        if (transfers === 1) {
          return { ok: true, text: async () => JSON.stringify({ errno: 12, target_file_nums: 2, target_file_nums_limit: 1 }) };
        }
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2;
  await transfer.transferDirectories([
    { id: 10, name: "d1", isDirectory: true, path: "/share/d1" },
    { id: 20, name: "d2", isDirectory: true, path: "/share/d2" }
  ], "/目标");
  assert.deepEqual(transferBodies, [[10, 20], [10], [20]], "超限时应二分重试");
  assert.equal(transfer.mergeLimitFiles, 1, "分组上限应按百度返回值收敛");
});

test("reconMode off keeps the legacy expand-always behavior", async () => {
  fastTimers();
  const { transfer, urls, posted } = directoryHarness(200);
  transfer.reconMode = "off";
  await transfer.transferDirectories([{ id: 10, name: "dir", isDirectory: true, path: "/share/dir" }], "/目标");
  assert.equal(urls.filter((url) => url.includes("/share/list")).length, 1);
  assert.deepEqual(posted, ["/目标/dir"], "off 模式应沿用小目录也展开的旧行为");
});

const RECON_PAYLOAD = {
  share_uk: 10,
  shareid: 20,
  bdstoken: "t",
  file_list: [
    { fs_id: 1, isdir: 1, server_filename: "d1", parent_path: "/share", path: "/share/d1" },
    { fs_id: 2, isdir: 1, server_filename: "d2", parent_path: "/share", path: "/share/d2" }
  ]
};

function reconShareHtml() {
  return `<script>locals.mset(${JSON.stringify(RECON_PAYLOAD)});</script>`;
}

test("run reconnoiters the whole tree before any transfer starts", async () => {
  fastTimers();
  const events = [];
  const progress = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    onProgress: (message) => progress.push(message),
    fetch: async (url) => {
      if (url.includes("/s/1abc")) {
        events.push("share-page");
        return { ok: true, text: async () => reconShareHtml() };
      }
      if (url.includes("/share/list")) {
        const dir = new URL(url).searchParams.get("dir");
        events.push(`list:${dir}`);
        const list = dir === "/share/d1"
          ? [{ fs_id: 11, server_filename: "a.txt", isdir: 0 }]
          : [{ fs_id: 21, server_filename: "b.txt", isdir: 0 }];
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list }) };
      }
      if (url.includes("/share/transfer")) {
        events.push("transfer");
        return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  await transfer.run("https://pan.baidu.com/s/1abc", "");
  const listIndexes = events.map((item, index) => (item.startsWith("list:") ? index : -1)).filter((index) => index >= 0);
  const transferIndex = events.indexOf("transfer");
  assert.equal(listIndexes.length, 2, "两个目录都应被探明");
  assert.ok(Math.max(...listIndexes) < transferIndex, "全部目录列表应在转存请求之前完成");
  assert.ok(progress.some((message) => message.includes("探明完成")), "应输出探明完成摘要");
});

test("directories that fail recon on run are transferred whole", async () => {
  fastTimers();
  const progress = [];
  const transferredIds = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    onProgress: (message) => progress.push(message),
    fetch: async (url, options) => {
      if (url.includes("/s/1abc")) {
        return { ok: true, text: async () => reconShareHtml() };
      }
      if (url.includes("/share/list")) {
        const dir = new URL(url).searchParams.get("dir");
        if (dir.includes("d1")) return { ok: true, text: async () => JSON.stringify({ errno: 2 }) };
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 21, server_filename: "b.txt", isdir: 0 }] }) };
      }
      if (url.includes("/share/transfer")) {
        transferredIds.push(JSON.parse(new URLSearchParams(options.body).get("fsidlist")));
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  await transfer.run("https://pan.baidu.com/s/1abc", "");
  assert.deepEqual(transferredIds, [[1], [2]], "探明失败的目录应整体转存，成功目录正常合并");
  assert.ok(progress.some((message) => message.includes("无法列出目录「d1」")), "应提示探明失败");
  assert.ok(progress.some((message) => message.includes("1 个目录无法列出将整体转存")), "摘要应包含降级数量");
});

test("run aborts during recon when fallback is disabled", async () => {
  fastTimers();
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    fallbackOnExpandError: false,
    requestDelay: 0,
    fetch: async (url) => {
      if (url.includes("/s/1abc")) {
        return { ok: true, text: async () => reconShareHtml() };
      }
      if (url.includes("/share/list")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 2 }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  await assert.rejects(() => transfer.run("https://pan.baidu.com/s/1abc", ""), /百度网盘错误 2|分享目录列表/);
});

test("rate-limited requests slow down subsequent pacing", async () => {
  fastTimers();
  const responses = [{ errno: 111 }, { errno: 0 }];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    requestDelay: 600,
    maxRetries: 2,
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(responses.shift()) })
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2;
  await transfer.transferIds([1], "/目标");
  assert.equal(transfer.requestDelay, 1200, "遇限流后 requestDelay 应翻倍");
  assert.equal(transfer.reconDelay, 1200, "遇限流后 reconDelay 应翻倍");
});

test("recon visits every directory exactly once", async () => {
  fastTimers();
  const progress = [];
  let listCalls = 0;
  const payload = {
    share_uk: 10, shareid: 20, bdstoken: "t",
    file_list: [
      { fs_id: 1, isdir: 1, server_filename: "d1", parent_path: "/share", path: "/share/d1" },
      { fs_id: 2, isdir: 1, server_filename: "d2", parent_path: "/share", path: "/share/d2" }
    ]
  };
  const tree = {
    "/share/d1": [
      { fs_id: 3, server_filename: "d3", isdir: 1, path: "/share/d1/d3" },
      { fs_id: 4, server_filename: "d4", isdir: 1, path: "/share/d1/d4" }
    ],
    "/share/d2": [{ fs_id: 5, server_filename: "d5", isdir: 1, path: "/share/d2/d5" }],
    "/share/d1/d3": [{ fs_id: 31, server_filename: "f1.txt", isdir: 0 }],
    "/share/d1/d4": [{ fs_id: 41, server_filename: "f2.txt", isdir: 0 }],
    "/share/d2/d5": [{ fs_id: 51, server_filename: "f3.txt", isdir: 0 }]
  };
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    onProgress: (message) => progress.push(message),
    fetch: async (url) => {
      if (url.includes("/s/1abc")) {
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      if (url.includes("/share/list")) {
        listCalls += 1;
        const dir = new URL(url).searchParams.get("dir");
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: tree[dir] || [] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  await transfer.run("https://pan.baidu.com/s/1abc", "");
  assert.equal(listCalls, 5, "5 个目录应各扫描一次，无重复、无遗漏");
  assert.ok(progress.some((message) => message.includes("探明完成：共 5 个目录")), "摘要应统计 5 个目录");
});

test("cancel stops the run before the next request", async () => {
  fastTimers();
  let calls = 0;
  const payload = {
    share_uk: 10, shareid: 20, bdstoken: "t",
    file_list: [
      { fs_id: 1, isdir: 1, server_filename: "d1", parent_path: "/share", path: "/share/d1" },
      { fs_id: 2, isdir: 1, server_filename: "d2", parent_path: "/share", path: "/share/d2" }
    ]
  };
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    fetch: async (url) => {
      calls += 1;
      if (calls === 3) transfer.cancel();
      if (url.includes("/s/1abc")) {
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      if (url.includes("/share/list")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 11, server_filename: "f.txt", isdir: 0 }] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  await assert.rejects(
    () => transfer.run("https://pan.baidu.com/s/1abc", ""),
    (error) => error.name === "TransferCancelledError"
  );
  assert.equal(calls, 3, "取消后不应再发出新请求");
});

test("wait aborts when the task is cancelled", async () => {
  fastTimers();
  const transfer = new BaiduPanTransfer({
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ errno: 0 }) })
  });
  transfer.cancel();
  await assert.rejects(() => transfer.wait(5000), (error) => error.name === "TransferCancelledError");
});

test("selection limits the transfer to picked top-level items", async () => {
  fastTimers();
  const payload = {
    share_uk: 10, shareid: 20, bdstoken: "t",
    file_list: [
      { fs_id: 1, isdir: 1, server_filename: "d1", parent_path: "/share", path: "/share/d1" },
      { fs_id: 2, isdir: 1, server_filename: "d2", parent_path: "/share", path: "/share/d2" },
      { fs_id: 3, isdir: 0, server_filename: "f1.txt", parent_path: "/share", path: "/share/f1.txt" }
    ]
  };
  const listDirs = [];
  const transferBodies = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    selection: [1],
    fetch: async (url, options) => {
      if (url.includes("/s/1abc")) {
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      if (url.includes("/share/list")) {
        listDirs.push(new URL(url).searchParams.get("dir"));
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 11, server_filename: "a.txt", isdir: 0 }] }) };
      }
      if (url.includes("/share/transfer")) {
        transferBodies.push(JSON.parse(new URLSearchParams(options.body).get("fsidlist")));
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  await transfer.run("https://pan.baidu.com/s/1abc", "");
  assert.deepEqual(listDirs, ["/share/d1"], "只应探明勾选的目录");
  assert.deepEqual(transferBodies, [[1]], "只应转存勾选的目录");
});

test("selection that matches nothing raises a clear error", async () => {
  fastTimers();
  const payload = {
    share_uk: 10, shareid: 20, bdstoken: "t",
    file_list: [
      { fs_id: 1, isdir: 1, server_filename: "d1", parent_path: "/share", path: "/share/d1" }
    ]
  };
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    selection: [999],
    fetch: async (url) => {
      if (url.includes("/s/1abc")) {
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  await assert.rejects(() => transfer.run("https://pan.baidu.com/s/1abc", ""), /未选择任何要转存的内容/);
});

test("deep selection transfers only the picked subdirectory to its parent path", async () => {
  fastTimers();
  const payload = {
    share_uk: 10, shareid: 20, bdstoken: "t",
    file_list: [
      { fs_id: 1, isdir: 1, server_filename: "d1", parent_path: "/share", path: "/share/d1" }
    ]
  };
  const transferBodies = [];
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    maxFilesPerFolder: 200,
    requestDelay: 0,
    selection: [{ id: 21, name: "d2", isDirectory: true, path: "/share/d1/d2", parentRelative: "/d1" }],
    fetch: async (url, options) => {
      if (url.includes("/s/1abc")) {
        return { ok: true, text: async () => `<script>locals.mset(${JSON.stringify(payload)});</script>` };
      }
      if (url.includes("/share/list")) {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 31, server_filename: "a.txt", isdir: 0 }] }) };
      }
      if (url.includes("/share/transfer")) {
        const body = new URLSearchParams(options.body);
        transferBodies.push({ ids: JSON.parse(body.get("fsidlist")), path: body.get("path") });
      }
      return { ok: true, text: async () => JSON.stringify({ errno: 0 }) };
    }
  });
  await transfer.run("https://pan.baidu.com/s/1abc", "");
  assert.deepEqual(transferBodies, [{ ids: [21], path: "/目标/d1" }], "只转存勾选的子目录，落点为其父路径");
});

test("deep selection drops items covered by a selected ancestor", async () => {
  const transfer = new BaiduPanTransfer({
    destination: "/目标",
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ errno: 0 }) }),
    selection: [
      { id: 1, name: "d1", isDirectory: true, path: "/share/d1", parentRelative: "" },
      { id: 21, name: "d2", isDirectory: true, path: "/share/d1/d2", parentRelative: "/d1" }
    ]
  });
  const picked = transfer.normalizeDeepSelection();
  const ids = Array.from(picked, (item) => item.node.id);
  assert.deepEqual(ids, [1], "被父目录覆盖的子项应被去掉");
  assert.equal(picked[0].parentRelative, "");
});

test("share list falls back on -9 and derives child paths from the accepted dir", async () => {
  const dirs = [];
  const transfer = new BaiduPanTransfer({
    fetch: async (url) => {
      const dir = new URL(url).searchParams.get("dir");
      dirs.push(dir);
      if (dir === "/share-root/dir") {
        return { ok: true, text: async () => JSON.stringify({ errno: 0, list: [
          { fs_id: 11, server_filename: "a.txt", isdir: 0, path: "/owner/space/dir/a.txt" },
          { fs_id: 12, server_filename: "sub", isdir: 1, path: "/owner/space/dir/sub" }
        ]}) };
      }
      return { ok: true, text: async () => JSON.stringify({ errno: -9, errmsg: "文件或目录不存在" }) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2; transfer.shareRoot = "/share-root";
  const items = await transfer.listShareChildren("", "dir", "/owner/space/dir");
  assert.deepEqual(Array.from(items, (item) => item.path), ["/share-root/dir/a.txt", "/share-root/dir/sub"], "子项路径应基于实际可用的 dir 续接");
  assert.equal(dirs.at(-1), "/share-root/dir", "应在 -9 时继续尝试后续候选");
});

test("deep share listing chains child paths and uses one request per level", async () => {
  const tree = {
    "/share-root/A": [{ fs_id: 2, server_filename: "B", isdir: 1, path: "/owner/A/B" }],
    "/share-root/A/B": [{ fs_id: 3, server_filename: "C", isdir: 1, path: "/owner/A/B/C" }],
    "/share-root/A/B/C": [{ fs_id: 4, server_filename: "leaf.txt", isdir: 0, path: "/owner/A/B/C/leaf.txt" }]
  };
  const calls = [];
  const transfer = new BaiduPanTransfer({
    fetch: async (url) => {
      const dir = new URL(url).searchParams.get("dir");
      calls.push(dir);
      if (!tree[dir]) return { ok: true, text: async () => JSON.stringify({ errno: -9, errmsg: "文件或目录不存在" }) };
      return { ok: true, text: async () => JSON.stringify({ errno: 0, list: tree[dir] }) };
    }
  });
  transfer.bdstoken = "t"; transfer.shareId = 1; transfer.userId = 2; transfer.shareRoot = "/share-root";
  const level1 = await transfer.listShareChildren("", "A", "/owner/A");
  const afterLevel1 = calls.length;
  const level2 = await transfer.listShareChildren("/A", "B", level1[0].path);
  const afterLevel2 = calls.length;
  const level3 = await transfer.listShareChildren("/A/B", "C", level2[0].path);
  assert.equal(level1[0].path, "/share-root/A/B");
  assert.equal(level2[0].path, "/share-root/A/B/C");
  assert.equal(level3[0].path, "/share-root/A/B/C/leaf.txt");
  assert.equal(afterLevel2 - afterLevel1, 1, "第二层应一次命中，不再试错");
  assert.equal(calls.length - afterLevel2, 1, "第三层应一次命中，不再试错");
});
