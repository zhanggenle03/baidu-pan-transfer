(function () {
  "use strict";
  if (window.top !== window.self || document.getElementById("bpth-launcher")) return;
  const { BaiduPanTransfer } = globalThis.BaiduTransferCore;
  const STORAGE_KEY = "bpth-form-v1";
  let running = false;
  let currentTransfer = null;
  let shareReader = null;
  const picker = { ready: false, nodes: [] };

  const style = document.createElement("style");
  style.textContent = `
    #bpth-launcher{position:fixed;right:22px;bottom:92px;z-index:2147483646;width:52px;height:52px;border:0;border-radius:50%;background:linear-gradient(135deg,#2878ff,#74a9ff);color:#fff;font:700 15px/1 sans-serif;box-shadow:0 10px 28px #1c5fdc66;cursor:pointer}
    #bpth-panel{all:initial;position:fixed;right:22px;bottom:155px;z-index:2147483647;width:660px;max-height:calc(100vh - 180px);overflow:auto;box-sizing:border-box;padding:16px;border:1px solid #d9e1ed;border-radius:15px;background:#f7f9fc;color:#172033;box-shadow:0 18px 55px #15244744;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
    #bpth-panel *{box-sizing:border-box}
    #bpth-panel[hidden]{display:none}
    #bpth-panel h2{margin:0 28px 3px 0;font-size:16px}
    #bpth-panel .sub{margin:0 0 12px;color:#7b8698;font-size:11.5px}
    #bpth-close{position:absolute;right:12px;top:8px;padding:2px 6px;border:0;background:transparent;color:#647087;font-size:23px;line-height:1;cursor:pointer}
    #bpth-panel .bpth-board{display:grid;grid-template-columns:322px minmax(0,1fr);gap:12px;align-items:stretch}
    #bpth-panel .bpth-card{display:flex;flex-direction:column;min-width:0;padding:11px 12px;border:1px solid #e4eaf3;border-radius:11px;background:#fff}
    #bpth-panel .bpth-card-title{margin:0;font-size:12px;font-weight:700;color:#344057}
    #bpth-panel .bpth-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
    #bpth-panel label{display:block;margin:8px 0 0;color:#344057;font-size:11.5px;font-weight:650}
    #bpth-panel textarea,#bpth-panel input{display:block;width:100%;margin-top:5px;padding:7px 9px;border:1px solid #cdd6e4;border-radius:8px;background:#fff;color:#172033;font:12px/1.45 inherit;font-weight:400;outline:none}
    #bpth-panel textarea{height:50px;resize:none}
    #bpth-panel input{height:32px}
    #bpth-panel textarea:focus,#bpth-panel input:focus{border-color:#2878ff;box-shadow:0 0 0 3px #2878ff18}
    #bpth-panel .row{display:grid;grid-template-columns:1fr 1.45fr;gap:8px}
    #bpth-panel .bpth-tips{margin-top:9px;padding:7px 9px;border:1px solid #e8eef8;border-radius:8px;background:#f6f9fe;color:#7c8799;font-size:11px;line-height:1.5}
    #bpth-panel .bpth-tips summary{cursor:pointer;color:#5d6a80;font-weight:650;outline:none}
    #bpth-panel .bpth-tips p{margin:4px 0 0}
    #bpth-panel button:focus-visible,#bpth-panel summary:focus-visible{outline:2px solid #2878ff;outline-offset:2px}
    #bpth-panel .hint{margin:6px 0 0;color:#8b95a7;font-size:11px;line-height:1.5}
    #bpth-read{flex:none;padding:6px 10px;border:1px solid #b9d0f0;border-radius:7px;background:#fff;color:#2878ff;font:650 11.5px/1 inherit;cursor:pointer}
    #bpth-read:hover:not(:disabled){background:#f2f7ff}
    #bpth-read:disabled{border-color:#e2e8f1;background:#f7f9fc;color:#9bacbf;cursor:not-allowed}
    #bpth-read-status:empty{display:none}
    #bpth-pick-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:5px;margin-top:8px;padding:14px;border:1px dashed #d8e0ec;border-radius:9px;background:#fafcff;text-align:center;line-height:1.6}
    #bpth-pick-empty strong{color:#5d6a80;font-size:12px;font-weight:650}
    #bpth-pick-empty span{color:#97a1b2;font-size:11px}
    #bpth-pick-empty[hidden]{display:none}
    #bpth-pick{display:flex;flex:1;flex-direction:column;min-height:0;margin-top:6px}
    #bpth-pick[hidden]{display:none}
    #bpth-pick .bpth-pick-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}
    #bpth-pick .bpth-pick-all{display:flex;align-items:center;gap:6px;margin:0;color:#5d6a80;font-size:11.5px;font-weight:400}
    #bpth-pick .bpth-pick-all input,#bpth-pick .bpth-pick-row input{width:auto;height:auto;margin:0;padding:0;border:0;accent-color:#2878ff}
    #bpth-pick-count{color:#8b95a7;font-size:11px}
    #bpth-pick-items{flex:1;min-height:110px;max-height:240px;overflow:auto;padding:4px 6px;border:1px solid #e8eef7;border-radius:8px;background:#fff}
    #bpth-pick .bpth-pick-row{display:flex;align-items:center;gap:6px;margin:0;padding:3px 4px;border-radius:6px;color:#344057;font-size:12px;font-weight:400}
    #bpth-pick .bpth-pick-row:hover{background:#f4f8ff}
    #bpth-pick .bpth-pick-toggle{flex:none;width:15px;height:15px;padding:0;border:0;background:transparent;color:#8b95a7;font-size:11px;line-height:1;cursor:pointer}
    #bpth-pick .bpth-pick-toggle:disabled{color:#c9d1de;cursor:default}
    #bpth-pick .bpth-pick-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #bpth-pick .bpth-pick-tag{flex:none;color:#9aa4b5;font-size:10.5px}
    #bpth-status{margin-top:10px;max-height:108px;overflow:auto;border:1px solid #dbe3ef;border-radius:9px;padding:9px 10px;background:#fff;color:#536178;font:11.5px/1.55 inherit;white-space:pre-wrap}
    #bpth-status:empty{display:none}
    #bpth-panel .bpth-actions{display:flex;gap:9px;margin-top:11px}
    #bpth-start{flex:1;padding:10px;border:0;border-radius:9px;background:#2878ff;color:#fff;font:700 13px/1 inherit;cursor:pointer;box-shadow:0 4px 12px #2878ff30}
    #bpth-start:hover:not(:disabled){background:#1a6bf0}
    #bpth-start:disabled{background:#9bacbf;box-shadow:none;cursor:not-allowed}
    #bpth-cancel{flex:none;width:104px;padding:10px;border:1px solid #ccd5e3;border-radius:9px;background:#fff;color:#344057;font:650 12.5px/1 inherit;cursor:pointer}
    #bpth-cancel[hidden]{display:none}
    #bpth-cancel:hover:not(:disabled){background:#f6f8fb}
    #bpth-cancel:disabled{color:#9bacbf;cursor:not-allowed}
  `;
  document.documentElement.appendChild(style);

  const launcher = document.createElement("button");
  launcher.id = "bpth-launcher";
  launcher.type = "button";
  launcher.textContent = "批存";
  launcher.title = "百度网盘批量转存";

  const panel = document.createElement("section");
  panel.id = "bpth-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <button id="bpth-close" type="button" aria-label="关闭">×</button>
    <h2>百度网盘批量转存</h2><p class="sub">自动递归拆分超过数量限制的分享目录，支持按文件夹勾选</p>
    <div class="bpth-board">
      <section class="bpth-card bpth-col-form">
        <div class="bpth-card-title">转存设置</div>
        <label>分享链接<textarea id="bpth-url" rows="2" placeholder="https://pan.baidu.com/s/1..."></textarea></label>
        <div class="row"><label>提取码<input id="bpth-password" maxlength="8" placeholder="可留空"></label><label>保存目录<input id="bpth-destination" placeholder="/ 或 /资料"></label></div>
        <div class="row"><label>每夹最多文件数<input id="bpth-max-files" type="number" min="0" step="1" placeholder="0 = 不限制"></label><label>分批文件夹前缀<input id="bpth-prefix" maxlength="20" placeholder="留空则为 1、2、3"></label></div>
        <details class="bpth-tips">
          <summary>每夹最多文件数怎么填？</summary>
          <p>· 填 0：不限制，转存速度最快。</p>
          <p>· 填个数（如 100）：每个文件夹最多存这么多，超出的自动分到新文件夹，名字为「前缀+序号」（填「批」得 批1、批2，留空得 1、2），所有层级的文件夹都按此处理。</p>
          <p>· 分享中的文件夹总数超过 40 个时，不建议填写——转存前会先扫描所有文件夹，速度明显更慢，还容易触发百度限流。</p>
        </details>
      </section>
      <section class="bpth-card bpth-col-pick">
        <div class="bpth-card-head"><span class="bpth-card-title">选择转存内容</span><button id="bpth-read" type="button">读取分享内容</button></div>
        <p id="bpth-read-status" class="hint"></p>
        <div id="bpth-pick-empty">
          <strong>尚未读取分享内容</strong>
          <span>不读取也可以直接转存全部；<br>读取后可只勾选需要的文件夹或文件。</span>
        </div>
        <div id="bpth-pick" hidden>
          <div class="bpth-pick-head"><label class="bpth-pick-all"><input id="bpth-pick-all" type="checkbox" checked>全选</label><span id="bpth-pick-count"></span></div>
          <div id="bpth-pick-items"></div>
          <p class="hint">点 ▸ 展开文件夹；勾选文件夹即转存整个文件夹</p>
        </div>
      </section>
    </div>
    <div id="bpth-status"></div>
    <div class="bpth-actions"><button id="bpth-start" type="button">开始转存</button><button id="bpth-cancel" type="button" hidden>取消转存</button></div>
  `;
  document.documentElement.append(launcher, panel);

  const byId = (id) => panel.querySelector(`#${id}`);
  const urlInput = byId("bpth-url");
  const passwordInput = byId("bpth-password");
  const destinationInput = byId("bpth-destination");
  const maxFilesInput = byId("bpth-max-files");
  const prefixInput = byId("bpth-prefix");
  const startButton = byId("bpth-start");
  const cancelButton = byId("bpth-cancel");
  const status = byId("bpth-status");
  const readButton = byId("bpth-read");
  const readStatus = byId("bpth-read-status");
  const pickEmpty = byId("bpth-pick-empty");
  const pickBox = byId("bpth-pick");
  const pickAll = byId("bpth-pick-all");
  const pickCount = byId("bpth-pick-count");
  const pickItems = byId("bpth-pick-items");
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  // 当前页就是分享页时以它为准（历史记录只作为回退），否则自动填充会被旧链接一直压住
  const pageShareLink = /\/s\/1|surl=/.test(location.href) ? location.href : "";
  const pagePwd = pageShareLink ? new URL(location.href).searchParams.get("pwd") || "" : "";
  urlInput.value = pageShareLink || saved.url || "";
  // 提取码以当前分享页为准：本页 URL 没有 pwd 参数就留空，绝不沿用上一次分享的提取码
  passwordInput.value = pageShareLink ? pagePwd : saved.password || "";
  destinationInput.value = saved.destination || "";
  maxFilesInput.value = saved.maxFiles || "";
  prefixInput.value = saved.prefix || "";

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      url: urlInput.value.trim(),
      password: passwordInput.value.trim(),
      destination: destinationInput.value.trim(),
      maxFiles: maxFilesInput.value.trim(),
      prefix: prefixInput.value.trim()
    }));
  }
  function log(message) {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    status.textContent += `${status.textContent ? "\n" : ""}[${time}] ${message}`;
    status.scrollTop = status.scrollHeight;
  }

  launcher.addEventListener("click", () => { panel.hidden = !panel.hidden; });
  byId("bpth-close").addEventListener("click", () => { panel.hidden = true; });
  for (const input of [urlInput, passwordInput, destinationInput, maxFilesInput, prefixInput]) input.addEventListener("change", save);
  for (const input of [urlInput, passwordInput]) input.addEventListener("change", resetPicker);
  function isPickerEmpty() {
    return picker.ready && collectPicked(picker.nodes).length === 0;
  }

  function syncStart() {
    startButton.disabled = running || isPickerEmpty();
  }

  function syncPickSummary(count) {
    pickAll.checked = picker.nodes.length > 0 && picker.nodes.every((node) => node.checked);
    pickCount.textContent = `已选 ${count} 项`;
  }

  function joinRelative(parentRelative, name) {
    return `${parentRelative || ""}/${name}`.replace(/\/+/g, "/");
  }

  function makeNode(item, parentRelative, level) {
    return {
      id: item.id,
      name: item.name,
      isDirectory: Boolean(item.isDirectory),
      path: item.path || "",
      parentRelative: String(parentRelative || "").replace(/\/+$/, ""),
      level,
      children: null,
      expanded: false,
      loading: false,
      checked: false,
      disabled: false
    };
  }

  function visibleNodes(nodes, out = []) {
    for (const node of nodes) {
      out.push(node);
      if (node.expanded && node.children) visibleNodes(node.children, out);
    }
    return out;
  }

  function setSubtreeChecked(node, value) {
    if (!node.children) return;
    for (const child of node.children) {
      child.checked = value;
      child.disabled = value;
      setSubtreeChecked(child, value);
    }
  }

  function collectPicked(nodes, out = []) {
    for (const node of nodes) {
      if (node.checked) {
        out.push({ id: node.id, name: node.name, isDirectory: node.isDirectory, path: node.path, parentRelative: node.parentRelative });
        continue;
      }
      if (node.children) collectPicked(node.children, out);
    }
    return out;
  }

  async function ensureShareReader() {
    const url = urlInput.value.trim();
    const password = passwordInput.value.trim();
    if (shareReader && shareReader.url === url && shareReader.password === password) return shareReader.transfer;
    const transfer = new BaiduPanTransfer({});
    await transfer.loadShare(url, password);
    shareReader = { transfer, url, password };
    return transfer;
  }

  async function toggleNode(node) {
    if (!node.isDirectory || node.loading) return;
    if (node.expanded) {
      node.expanded = false;
      renderPicker();
      return;
    }
    if (!node.children) {
      node.loading = true;
      renderPicker();
      try {
        const transfer = await ensureShareReader();
        const children = await transfer.listShareChildren(node.parentRelative || "", node.name, node.path);
        const childParent = joinRelative(node.parentRelative, node.name);
        node.children = children.map((item) =>
          makeNode({ id: item.id, name: item.name, isDirectory: item.isDirectory, path: item.path }, childParent, node.level + 1)
        );
        if (node.checked) setSubtreeChecked(node, true);
      } catch (error) {
        node.loading = false;
        readStatus.textContent = `读取子目录失败：${error.message}`;
        renderPicker();
        return;
      }
      node.loading = false;
    }
    node.expanded = true;
    renderPicker();
  }

  function renderPicker() {
    pickItems.textContent = "";
    for (const node of visibleNodes(picker.nodes)) {
      const row = document.createElement("div");
      row.className = "bpth-pick-row";
      row.style.paddingLeft = `${node.level * 12}px`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "bpth-pick-toggle";
      toggle.textContent = node.isDirectory ? (node.loading ? "…" : node.expanded ? "▾" : "▸") : "";
      toggle.disabled = !node.isDirectory || node.loading;
      if (node.isDirectory) toggle.addEventListener("click", () => { void toggleNode(node); });
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = node.checked;
      box.disabled = node.disabled;
      box.addEventListener("change", () => {
        node.checked = box.checked;
        setSubtreeChecked(node, box.checked);
        renderPicker();
      });
      const name = document.createElement("span");
      name.className = "bpth-pick-name";
      name.textContent = node.name;
      name.title = node.name;
      const tag = document.createElement("span");
      tag.className = "bpth-pick-tag";
      tag.textContent = node.isDirectory ? (node.children ? `${node.children.length} 项` : "文件夹") : "文件";
      row.append(toggle, box, name, tag);
      pickItems.append(row);
    }
    syncPickSummary(collectPicked(picker.nodes).length);
    syncStart();
  }

  function resetPicker() {
    picker.ready = false;
    picker.nodes = [];
    pickBox.hidden = true;
    pickEmpty.hidden = false;
    readStatus.textContent = "";
    syncStart();
  }

  readButton.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return urlInput.focus();
    readButton.disabled = true;
    readButton.textContent = "正在读取…";
    readStatus.textContent = "";
    try {
      const transfer = await ensureShareReader();
      const items = [
        ...transfer.directories.map((item) => ({ id: Number(item.id), name: item.name, isDirectory: true, path: item.path || "" })),
        ...transfer.files.map((item) => ({ id: Number(item.id), name: item.name, isDirectory: false, path: item.path || "" }))
      ];
      if (!items.length) throw new Error("分享中没有可转存的内容");
      picker.nodes = items.map((item) => makeNode(item, "", 0));
      picker.ready = true;
      pickEmpty.hidden = true;
      pickBox.hidden = false;
      renderPicker();
      readStatus.textContent = `已读取 ${items.length} 项，可展开文件夹继续选择`;
    } catch (error) {
      picker.ready = false;
      picker.nodes = [];
      pickBox.hidden = true;
      pickEmpty.hidden = false;
      readStatus.textContent = `读取失败：${error.message}`;
    } finally {
      readButton.disabled = false;
      readButton.textContent = "读取分享内容";
      syncStart();
    }
  });

  pickAll.addEventListener("change", (event) => {
    for (const node of picker.nodes) {
      node.checked = event.target.checked;
      node.disabled = false;
      setSubtreeChecked(node, event.target.checked);
    }
    renderPicker();
  });

  startButton.addEventListener("click", async () => {
    if (running) return;
    if (!urlInput.value.trim()) return urlInput.focus();
    if (isPickerEmpty()) return;
    save();
    running = true;
    startButton.disabled = true;
    startButton.textContent = "正在转存…";
    cancelButton.hidden = false;
    cancelButton.disabled = false;
    cancelButton.textContent = "取消转存";
    status.textContent = "";
    try {
      const maxFiles = Math.max(0, Math.floor(Number(maxFilesInput.value) || 0));
      const transfer = new BaiduPanTransfer({
        destination: destinationInput.value,
        maxFilesPerFolder: maxFiles,
        folderPrefix: prefixInput.value,
        selection: picker.ready ? collectPicked(picker.nodes) : undefined,
        onProgress: log
      });
      currentTransfer = transfer;
      await transfer.run(urlInput.value, passwordInput.value);
      log("✅ 转存成功，请刷新百度网盘文件列表");
      urlInput.value = "";
      passwordInput.value = "";
      save();
    } catch (error) {
      console.error("[百度网盘批量转存]", error);
      if (error && error.name === "TransferCancelledError") {
        log("已取消转存，已转存的文件会保留");
      } else {
        log(`❌ ${error.message}`);
        if (error && error.response !== undefined) {
          const detail = typeof error.response === "string"
            ? error.response.replace(/\s+/g, " ").trim().slice(0, 300)
            : JSON.stringify(error.response).slice(0, 300);
          if (detail && !String(error.message).includes(detail.slice(0, 40))) log(`↳ 百度返回：${detail}`);
        }
      }
    } finally {
      running = false;
      currentTransfer = null;
      startButton.textContent = "开始转存";
      syncStart();
      cancelButton.hidden = true;
    }
  });

  cancelButton.addEventListener("click", () => {
    cancelButton.disabled = true;
    cancelButton.textContent = "正在取消…";
    if (currentTransfer) currentTransfer.cancel();
  });
})();
