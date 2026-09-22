/* Tool Launcher · 前端逻辑 v0.0.2 */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  scripts: [],
  selectedId: null,
  script: null,          // 当前脚本详情（含 schema / presets / env）
  activePresetId: null,
  currentExecId: null,
  runningByScript: {},   // script_id -> running 执行列表（卡片徽章 / 任务 popover）
  popoverScriptId: null, // 当前打开的 popover 对应脚本
  detailExec: null,      // 当前打开的详情记录（running 时用于实时输出/终止）
  lineCount: 0,
  ws: null,
  running: false,
  uvOk: null,
  selectedTags: new Set(), // 标签过滤（多选）
};

/* ================= UI 偏好持久化（重启后保留） ================= */
const PREFS_KEY = "launcher_prefs";
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
}
function savePrefs() {
  const p = {
    tags: [...state.selectedTags],
    hideEmpty: $("#opt-hide-empty").checked,
    historyScope,
    autoscroll: $("#opt-autoscroll").checked,
    mono: $("#opt-mono").checked,
  };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}
function applyPrefs() {
  const p = loadPrefs();
  if (Array.isArray(p.tags)) state.selectedTags = new Set(p.tags);
  if (p.hideEmpty !== undefined) $("#opt-hide-empty").checked = !!p.hideEmpty;
  if (p.historyScope === "script" || p.historyScope === "all") historyScope = p.historyScope;
  if (p.autoscroll !== undefined) $("#opt-autoscroll").checked = !!p.autoscroll;
  if (p.mono !== undefined) $("#opt-mono").checked = !!p.mono;
  // 同步按钮与控制台样式
  const scopeBtn = $("#btn-history-scope");
  if (scopeBtn) {
    scopeBtn.textContent = historyScope === "script" ? "当前脚本" : "全部";
    scopeBtn.classList.toggle("active", historyScope === "all");
  }
  const consoleEl = $("#console");
  if (consoleEl) consoleEl.classList.toggle("mono", $("#opt-mono").checked);
}

/* ================= 基础工具 ================= */

async function api(path, opts = {}) {
  const conf = { method: opts.method || "GET", headers: {} };
  if (opts.body !== undefined) {
    conf.headers["Content-Type"] = "application/json";
    conf.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, conf);
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

// 顶部通知：多 toast 堆叠（各自独立计时与动画，连续触发可同时存在多个）
const TOAST_ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="m7.8 12.4 2.9 2.9 5.5-6"/></svg>';
const TOAST_ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const TOAST_ICON_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5"/><path d="M12 16.2h.01"/></svg>';
function toast(msg, type = "ok", duration = 2400) {
  // 兼容旧调用：toast(msg, true) 视为错误
  if (type === true) type = "err";
  const kind = type === "warn" ? "warn" : type === "err" ? "err" : "ok";
  const icon = kind === "warn" ? TOAST_ICON_WARN : kind === "err" ? TOAST_ICON_ERR : TOAST_ICON_OK;
  let box = $("#toast-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "toast-box";
    document.body.appendChild(box);
  }
  // 旧 toast 立即退场：上移淡出（明显），动画结束再移除
  document.querySelectorAll("#toast-box .toast-item:not(.out)").forEach(el => {
    el.classList.remove("in");
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  });
  const el = document.createElement("div");
  el.className = "toast-item " + kind;
  el.innerHTML = '<span class="t-ic">' + icon + '</span><span class="t-txt"></span>';
  el.querySelector(".t-txt").textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
  setTimeout(() => {
    el.classList.remove("in");
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, duration);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch { return false; }
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ================= Modal ================= */

function openModal({ title, bodyHTML, footHTML, onMount, hideTitle } = {}) {
  const mask = $("#modal");
  $("#modal-title").textContent = title || "";
  mask.classList.toggle("no-title", !!hideTitle);
  $("#modal-body").innerHTML = bodyHTML || "";
  $("#modal-foot").innerHTML = footHTML || "";
  mask.hidden = false;
  if (onMount) onMount(mask);
}
function closeModal() { $("#modal").hidden = true; }
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

/** 删除等危险操作的二次确认弹窗 */
function confirmModal({ title = "确认操作", message, confirmText = "删除", onConfirm, onCancel } = {}) {
  const mask = $("#modal");
  // 清理上一次挂载的遮罩监听，避免回调残留
  if (mask._confirmCleanup) { try { mask._confirmCleanup(); } catch {} mask._confirmCleanup = null; }
  const handleMask = (e) => {
    if (e.target.id === "modal") {
      closeModal();
      if (onCancel) onCancel();
    }
  };
  openModal({
    title,
    bodyHTML: `<div class="result-tip err" style="margin-bottom:0">${escapeHtml(message)}</div>`,
    footHTML: `<button class="btn ghost" data-close>取消</button><button class="btn danger primary" id="confirm-ok">${confirmText}</button>`,
    onMount: (mask) => {
      mask._confirmCleanup = () => mask.removeEventListener("click", handleMask);
      $$("[data-close]", mask).forEach((b) => b.addEventListener("click", () => { closeModal(); if (onCancel) onCancel(); }));
      $("#confirm-ok", mask).addEventListener("click", async () => {
        closeModal();
        try { await onConfirm(); } catch (e) { toast(e.message, true); }
      });
      mask.addEventListener("click", handleMask);
    },
  });
}

/* ================= 顶部：导入 / 扫描 ================= */

function openAddModal() {
  const lastDir = localStorage.getItem("last_scan_dir") || "";
  openModal({
    title: "脚本导入",
    bodyHTML: `
      <div class="m-field">
        <div class="m-radio">
          <label><input type="radio" name="add-mode" value="file" checked> 导入单个脚本</label>
          <label><input type="radio" name="add-mode" value="scan"> 扫描目录</label>
        </div>
        <div class="m-hint">导入模式可填路径或选择本地 .py 文件；扫描模式递归查找并自动导入</div>
      </div>
      <div class="m-field" id="path-field">
        <div class="m-label">路径</div>
        <div class="path-row">
          <input class="f-input mono" id="add-path" placeholder="/path/to/scripts 或 /path/to/script.py" value="${escapeHtml(lastDir)}" autocomplete="off">
          <button class="btn ghost" id="add-browse" title="打开文件选择器">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>
            选择文件…
          </button>
        </div>
        <div class="m-hint" id="path-hint">选择文件会把脚本复制到启动器管理目录（imported/）</div>
        <input type="file" id="add-file" accept=".py" style="display:none">
      </div>
      <div class="m-field" id="name-field">
        <div class="m-label">显示名称（可选，留空使用脚本名）</div>
        <input class="f-input" id="add-name" placeholder="例如：数据清洗工具" autocomplete="off">
      </div>
      <div class="m-field" id="desc-field">
        <div class="m-label">描述（可选，留空自动取脚本内 description）</div>
        <input class="f-input" id="add-desc" placeholder="这个脚本用来做什么…" autocomplete="off">
      </div>
      <div class="m-field" id="recursive-wrap">
        <label class="chk"><input type="checkbox" id="add-recursive" checked> 递归扫描子目录</label>
      </div>
    `,
    footHTML: `<button class="btn ghost" id="add-cancel">取消</button><button class="btn primary" id="add-confirm">确定</button>`,
    onMount: (mask) => {
      $("#add-cancel", mask).addEventListener("click", closeModal);
      $("#add-confirm", mask).addEventListener("click", doAdd);
      const mode = () => $('input[name="add-mode"]:checked').value;
      const syncMode = () => {
        const m = mode();
        $("#recursive-wrap").style.display = m === "scan" ? "" : "none";
        $("#name-field").style.display = m === "scan" ? "none" : "";
        $("#desc-field").style.display = m === "scan" ? "none" : "";
        $("#path-hint").style.display = m === "scan" ? "none" : "";
      };
      $$('input[name="add-mode"]', mask).forEach(r => r.addEventListener("change", syncMode));
      syncMode(); // 初始按当前 radio（扫描）显示正确字段
      // 文件选择器
      $("#add-browse", mask).addEventListener("click", () => { $('input[name="add-mode"][value="file"]').checked = true; syncMode(); $("#add-file", mask).click(); });
      $("#add-file", mask).addEventListener("change", async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        if (await uploadScript(f)) closeModal();
      });
    },
  });
}

async function uploadScript(file) {
  const fd = new FormData();
  fd.append("file", file);
  const name = $("#add-name").value.trim();
  if (name) fd.append("name", name);
  try {
    const res = await fetch("/api/scripts/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "上传失败");
    toast("已导入 " + data.script.name);
    await loadScripts();
    selectScript(data.script.id);
    return true;
  } catch (err) {
    toast("导入失败：" + err.message, true);
    return false;
  }
}

async function doAdd() {
  const mode = $('input[name="add-mode"]:checked').value;
  const confirmBtn = $("#add-confirm");
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = '<span class="spinner" style="display:inline-block"></span> 处理中…';
  try {
    if (mode === "scan") {
      const path = $("#add-path").value.trim();
      if (!path) return toast("请输入目录路径", true);
      const data = await api("/api/scripts/scan", { method: "POST", body: { directory: path, recursive: $("#add-recursive").checked } });
      localStorage.setItem("last_scan_dir", path);
      const skipped = data.skipped || [];
      openModal({
        title: "扫描完成",
        bodyHTML: `
          <div class="result-tip ok">成功导入 ${data.imported.length} 个脚本（共扫描 ${data.total} 个 .py 文件）</div>
          ${skipped.length ? `<div class="result-tip err">${skipped.length} 个未通过 argparse 约定检查：</div><div class="result-summary">${skipped.map(s => s.path + "\n  └ " + s.error).join("\n")}</div>` : ""}
        `,
        footHTML: `<button class="btn primary" id="add-done">完成</button>`,
        onMount: (mask) => { $("#add-done", mask).addEventListener("click", closeModal); },
      });
      await loadScripts();
    } else {
      const path = $("#add-path").value.trim();
      if (!path) return toast("请输入脚本路径", true);
      const body = { path };
      const name = $("#add-name").value.trim();
      const desc = $("#add-desc").value.trim();
      if (name) body.name = name;
      if (desc) body.description = desc;
      const data = await api("/api/scripts/import", { method: "POST", body });
      closeModal();
      toast("已导入 " + data.script.name);
      await loadScripts();
      selectScript(data.script.id);
    }
  } catch (e) {
    toast("导入失败：" + e.message, true);
    confirmBtn.disabled = false;
    confirmBtn.textContent = "确定";
  }
}

/* ================= 脚本列表（标签过滤） ================= */

async function loadScripts() {
  state.scripts = await api("/api/scripts");
  renderTagFilter();
  renderScriptList();
}

/** 汇总所有脚本的标签，渲染侧边栏多选过滤区 */
function renderTagFilter() {
  const wrap = $("#tag-filter");
  const listEl = $("#tag-filter-list");
  const allTags = [...new Set(state.scripts.flatMap((s) => s.tags || []))].sort((a, b) => a.localeCompare(b, "zh"));
  wrap.hidden = allTags.length === 0;
  listEl.innerHTML = "";
  for (const t of allTags) {
    const chip = document.createElement("button");
    chip.className = "tag-chip" + (state.selectedTags.has(t) ? " active" : "");
    chip.textContent = t;
    chip.onclick = () => {
      state.selectedTags.has(t) ? state.selectedTags.delete(t) : state.selectedTags.add(t);
      renderTagFilter();
      renderScriptList();
      savePrefs();
    };
    listEl.appendChild(chip);
  }
}

function renderScriptList() {
  const list = $("#script-list");
  const empty = $("#sidebar-empty");
  const kw = ($("#script-search").value || "").toLowerCase();
  const filtered = state.scripts.filter((s) => {
    if (state.selectedTags.size && !(s.tags || []).some((t) => state.selectedTags.has(t))) return false;
    if (!kw) return true;
    return s.name.toLowerCase().includes(kw) || s.path.toLowerCase().includes(kw) || (s.tags || []).some((t) => t.toLowerCase().includes(kw));
  });
  list.innerHTML = "";
  empty.hidden = filtered.length > 0;
  if (!filtered.length) return;
  for (const s of filtered) list.appendChild(scriptCard(s));
}

function scriptCard(s) {
  const card = document.createElement("div");
  card.className = "script-card" + (s.id === state.selectedId ? " active" : "");
  card.dataset.id = s.id;
  const nargs = (JSON.parse(s.args_schema || "[]")).length;
  const row1 = document.createElement("div");
  row1.className = "sc-name";
  const nm = document.createElement("span");
  nm.textContent = s.name;
  const runs = state.runningByScript[s.id] || [];
  let runBadge = null;
  if (runs.length) {
    runBadge = document.createElement("span");
    runBadge.className = "sc-running";
    runBadge.textContent = "● " + runs.length;
    runBadge.title = runs.length + " 个任务正在运行，点击查看";
    runBadge.addEventListener("click", (e) => {
      e.stopPropagation();
      openRunningPopover(runBadge, s.id);
    });
  }
  const badge = document.createElement("span");
  badge.className = "sc-arg";
  badge.textContent = nargs + " 参数";
  row1.append(nm);
  if (runBadge) row1.appendChild(runBadge);
  row1.appendChild(badge);
  const row2 = document.createElement("div");
  row2.className = "sc-path";
  row2.textContent = s.path;
  row2.title = s.path;
  card.append(row1, row2);
  if (s.tags && s.tags.length) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "sc-tags";
    for (const t of s.tags.slice(0, 3)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "#" + t;
      tagsRow.appendChild(tag);
    }
    if (s.tags.length > 3) {
      const more = document.createElement("span");
      more.className = "tag more";
      more.textContent = "+" + (s.tags.length - 3);
      tagsRow.appendChild(more);
    }
    card.appendChild(tagsRow);
  }
  card.addEventListener("click", () => selectScript(s.id));
  return card;
}

/* ================= 选中脚本 ================= */

async function selectScript(id) {
  state.selectedId = id;
  state.activePresetId = null;
  renderScriptList();
  try {
    const rec = await api(`/api/scripts/${id}`);
    state.script = rec;
    $("#form-empty").hidden = true;
    $("#form-content").hidden = false;
    renderScriptHead(rec);
    renderEnvBar(rec.env);
    renderPresets(rec.presets);
    renderFields(rec.args_schema, rec.auto_saved_args);
    refreshCmdInput();
    setRunning(false);
    // 若历史面板当前可见，切脚本后同步为当前脚本的记录
    if ($("#history-wrap") && !$("#history-wrap").hidden) refreshHistory();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderScriptHead(rec) {
  const nameEl = $("#script-name");
  nameEl.textContent = rec.name;
  nameEl.title = "点击重命名";
  nameEl.onclick = () => inlineRename(rec);

  const descEl = $("#script-desc");
  descEl.textContent = rec.description || "（无描述，点击添加）";
  descEl.className = "script-desc" + (rec.description ? "" : " empty");
  descEl.onclick = () => editScriptMeta(rec);

  renderScriptTags(rec);

  const p = $("#script-path");
  p.textContent = rec.path;
  p.title = rec.path;
  $("#btn-open-dir").onclick = () => openScriptDir(rec.path);
  $("#btn-copy-path").onclick = async () => {
    if (await copyText(rec.path)) toast("路径已复制");
  };
  $("#btn-reload").onclick = reloadScript;
  $("#btn-delete-script").onclick = () => confirmModal({
    title: "删除脚本",
    message: `确定删除脚本「${rec.name}」吗？该脚本的预设与执行记录会一并删除，脚本文件本身不受影响。`,
    onConfirm: async () => {
      await api(`/api/scripts/${rec.id}`, { method: "DELETE" });
      toast("脚本已删除");
      state.selectedId = null;
      localStorage.removeItem("last_script_id");
      $("#form-empty").hidden = false;
      $("#form-content").hidden = true;
      clearConsole();
      await loadScripts();
      await refreshHistory();
    },
  });
}

/** 重新加载：脚本文件更新后重新解析参数 */
async function reloadScript() {
  if (!state.script) return;
  const btn = $("#btn-reload");
  const label = btn.querySelector("span");
  btn.disabled = true;
  label.textContent = "解析中…";
  try {
    await api(`/api/scripts/${state.script.id}/reload`, { method: "POST" });
    toast("已重新加载，参数已更新");
    await loadScripts();
    await selectScript(state.script.id);
  } catch (e) {
    toast("重新加载失败：" + e.message, true);
  }
  btn.disabled = false;
  label.textContent = "重新加载";
}

/** 原地重命名：点击脚本名称直接变为输入框，Enter/失焦保存，Esc 取消 */
function inlineRename(rec) {
  const nameEl = $("#script-name");
  if (nameEl.dataset.editing === "1") return;
  const input = document.createElement("input");
  input.className = "f-input script-name-input";
  input.value = rec.name;
  input.dataset.editing = "1";
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== rec.name) {
      try {
        await api(`/api/scripts/${rec.id}`, { method: "PUT", body: { name: v } });
        toast("已重命名");
        await loadScripts();
        await selectScript(rec.id);
        return;
      } catch (e) {
        toast("重命名失败：" + e.message, true);
      }
    }
    const next = document.createElement("h2");
    next.id = "script-name";
    next.title = "点击重命名";
    next.textContent = rec.name;
    next.onclick = () => inlineRename(rec);
    input.replaceWith(next);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") commit(false);
  };
  input.onblur = () => commit(true);
}

/** 脚本详情页标签：chips + 输入框（回车添加、✕ 删除，实时保存） */
function renderScriptTags(rec) {
  const row = $("#script-tags");
  if (!row) return;
  row.innerHTML = "";
  const lbl = document.createElement("span");
  lbl.style.cssText = "font-size:11px;color:var(--muted)";
  lbl.textContent = "标签:";
  row.appendChild(lbl);
  const renderTags = () => {
    $$(".tag", row).forEach((t) => t.remove());
    const inp = $("#sc-tag-input", row);
    for (const t of rec.tags || []) {
      const tag = document.createElement("span");
      tag.className = "tag";
      const txt = document.createTextNode("#" + t);
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "✕";
      x.onclick = async () => {
        rec.tags = (rec.tags || []).filter((v) => v !== t);
        await api(`/api/scripts/${rec.id}`, { method: "PUT", body: { tags: rec.tags } });
        renderTags();
        await loadScripts();
      };
      tag.append(txt, x);
      row.insertBefore(tag, inp);
    }
  };
  const inp = document.createElement("input");
  inp.id = "sc-tag-input";
  inp.placeholder = "+ 添加标签，回车确认";
  inp.onkeydown = async (e) => {
    if (e.key === "Enter" && inp.value.trim()) {
      rec.tags = [...new Set([...(rec.tags || []), inp.value.trim()])];
      inp.value = "";
      await api(`/api/scripts/${rec.id}`, { method: "PUT", body: { tags: rec.tags } });
      renderTags();
      await loadScripts();
    }
  };
  row.appendChild(inp);
  renderTags();
}

function editScriptMeta(rec) {
  openModal({
    title: "编辑脚本信息",
    bodyHTML: `
      <div class="m-field">
        <div class="m-label">显示名称</div>
        <input class="f-input" id="meta-name" value="${escapeHtml(rec.name)}" autocomplete="off">
      </div>
      <div class="m-field">
        <div class="m-label">描述</div>
        <textarea class="f-input" id="meta-desc" placeholder="这个脚本用来做什么…" rows="3">${escapeHtml(rec.description || "")}</textarea>
      </div>
      <div class="m-field">
        <div class="m-label">依赖文件路径（可选，默认自动检测脚本目录的 requirements.txt 或 pyproject.toml）</div>
        <input class="f-input mono" id="meta-deps" placeholder="如：/path/to/requirements.txt" value="${escapeHtml(rec.deps_path || "")}" autocomplete="off">
      </div>
      <div class="m-field">
        <div class="m-label">标签（多个用逗号分隔，用于侧边栏过滤）</div>
        <input class="f-input" id="meta-tags" placeholder="如：数据处理, 生产, 测试" value="${escapeHtml((rec.tags || []).join(", "))}" autocomplete="off">
      </div>`,
    footHTML: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="meta-save">保存</button>`,
    onMount: (mask) => {
      $$("[data-close]", mask).forEach((b) => b.addEventListener("click", closeModal));
      $("#meta-save", mask).addEventListener("click", async () => {
        const name = $("#meta-name", mask).value.trim();
        if (!name) return toast("名称不能为空", true);
        const desc = $("#meta-desc", mask).value.trim();
        const deps = $("#meta-deps", mask).value.trim();
        const tags = $("#meta-tags", mask).value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
        await api(`/api/scripts/${rec.id}`, { method: "PUT", body: { name, description: desc, deps_path: deps, tags } });
        closeModal();
        toast("已保存");
        await loadScripts();
        await selectScript(rec.id);
      });
      $("#meta-desc", mask).focus();
    },
  });
}

function openScriptDir(path) {
  api("/api/utils/open-dir", { method: "POST", body: { path } })
    .then(() => toast("已打开脚本所在目录"))
    .catch((e) => toast(e.message, true));
}

/* ================= 环境状态 / uv ================= */

function renderEnvBar(env) {
  const bar = $("#env-bar");
  bar.innerHTML = "";
  if (!env) return;

  const mkDot = (cls) => {
    const d = document.createElement("span");
    d.className = "dot" + (cls ? " " + cls : "");
    return d;
  };
  const mkText = (t, cls) => {
    const s = document.createElement("span");
    s.className = "env-text" + (cls ? " " + cls : "");
    s.textContent = t;
    return s;
  };
  const sep = () => {
    const s = document.createElement("span");
    s.className = "env-sep";
    s.textContent = "·";
    return s;
  };
  const group = (...els) => {
    const g = document.createElement("span");
    g.className = "env-group";
    g.append(...els);
    return g;
  };

  const groups = [];

  // 1. uv 状态
  if (!state.uvOk) {
    if (env.has_venv || env.has_inline_meta) {
      groups.push(group(mkDot(""), mkText("未装 uv · 用项目环境运行")));
    } else {
      groups.push(group(mkDot("err"), mkText("未检测到 uv", "err")));
    }
  } else {
    groups.push(group(mkDot("ok"), mkText("uv " + (env.uv_version || ""), "ok")));
  }

  // 2. 虚拟环境状态 + 更换/初始化 + 路径
  const vels = [];
  if (env.venv_source === "custom") {
    if (env.venv_broken) {
      vels.push(mkDot("err"), mkText("指定环境不可用", "err"));
    } else {
      vels.push(mkDot("ok"), mkText("使用指定环境", "ok"));
    }
  } else if (env.has_inline_meta) {
    const depsN = (env.inline_deps || []).length;
    vels.push(mkDot("ok"), mkText("PEP 723 内联脚本" + (depsN ? " · " + depsN + " 个依赖" : ""), "ok"));
  } else if (env.has_venv) {
    vels.push(mkDot("ok"), mkText("venv 已就绪", "ok"));
  } else {
    vels.push(mkDot("warn"), mkText("未初始化虚拟环境", "warn"));
  }
  if (!env.has_inline_meta) {
    // 更换：纯图标按钮（无胶囊边框）
    const chg = document.createElement("button");
    chg.className = "venv-change";
    chg.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
    chg.title = "更换虚拟环境";
    chg.onclick = openVenvSettings;
    vels.push(chg);
    if (!env.venv_source && !env.has_venv) {
      const initBtn = document.createElement("button");
      initBtn.className = "btn mini primary";
      initBtn.textContent = env.has_deps ? "初始化环境" : "初始化环境";
      initBtn.onclick = () => initEnv();
      vels.push(initBtn);
    }
  }
  groups.push(group(...vels));

  // 3. 依赖状态
  if (env.has_deps) {
    const d = mkText(env.deps_name || "依赖文件", "ok");
    d.title = env.requirements_path || "";
    groups.push(group(mkDot("ok"), d));
  } else {
    groups.push(group(mkDot(""), mkText("无依赖文件")));
  }

  for (let i = 0; i < groups.length; i++) {
    if (i > 0) bar.appendChild(sep());
    bar.appendChild(groups[i]);
  }

  // 依赖文件行：可自定义依赖文件路径并安装
  const depRow = document.createElement("div");
  depRow.className = "env-deps";
  const depDot = document.createElement("span");
  depDot.className = "dot" + (env.has_deps ? " ok" : "");
  const depLbl = document.createElement("span");
  depLbl.className = "dep-lbl";
  depLbl.textContent = "依赖文件";
  depLbl.title = env.has_deps ? ("已检测到 " + env.requirements_path) : "未检测到依赖文件（requirements.txt / pyproject.toml）";
  const depInput = document.createElement("input");
  depInput.className = "f-input dep-input";
  depInput.placeholder = "留空自动检测脚本目录 requirements.txt";
  depInput.value = (state.script && state.script.deps_path) || "";
  depInput.title = depLbl.title;
  const depInstall = document.createElement("button");
  depInstall.className = "btn mini primary";
  depInstall.textContent = "安装依赖";
  depInstall.onclick = () => initEnvDeps(depInput.value.trim());
  depRow.append(depDot, depLbl, depInput, depInstall);
  if (env.has_inline_meta) depRow.style.display = "none"; // PEP 723 内联脚本无需依赖文件
  bar.appendChild(depRow);
}

/* ================= 虚拟环境设置（更换弹窗） ================= */

let _venvScanned = null; // 扫描缓存：{venvs:[...]}，避免每次打开都重复扫描

/** 弹出「更换虚拟环境」设置窗：选择 / 手动输入 双 Tab，底部常显所选路径 */
function openVenvSettings() {
  const rec = state.script;
  if (!rec) return;
  const cur = (rec.venv_path || "").trim();

  openModal({
    title: "",
    hideTitle: true,
    bodyHTML: `
      <div class="venv-top">
        <div class="venv-tabs">
          <span class="venv-pill" id="venv-pill"></span>
          <button class="venv-tab active" data-tab="select">选择环境</button>
          <button class="venv-tab" data-tab="manual">手动输入</button>
        </div>
      </div>
      <div class="venv-sub">选择脚本运行所用的 Python 虚拟环境</div>
      <div class="venv-panel" id="venv-panel-select">
        <select class="f-input venv-sel" id="venv-sel"></select>
        <button class="btn mini ghost venv-scan" id="venv-scan" title="重新扫描本机已管理的虚拟环境">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg><span>扫描</span>
        </button>
      </div>
      <div class="venv-panel" id="venv-panel-manual" style="display:none">
        <input class="f-input venv-manual-input" id="venv-manual-input"
               placeholder="输入虚拟环境路径或 python 可执行文件，例如 /opt/venv 或 /opt/venv/bin/python">
      </div>
      <div class="venv-preview" id="venv-preview"></div>
    `,
    footHTML: `<button class="btn ghost" id="venv-cancel">取消</button><button class="btn primary" id="venv-save">保存</button>`,
    onMount: (mask) => {
      const sel = $("#venv-sel", mask);
      const input = $("#venv-manual-input", mask);
      const preview = $("#venv-preview", mask);
      const scanBtn = $("#venv-scan", mask);
      const tabSel = $$(".venv-tab", mask);
      const panelSelect = $("#venv-panel-select", mask);
      const panelManual = $("#venv-panel-manual", mask);

      function moveVenvPill() {
        const pill = $("#venv-pill", mask);
        const active = mask.querySelector(".venv-tab.active");
        if (!pill || !active) return;
        pill.style.width = active.offsetWidth + "px";
        pill.style.transform = "translateX(" + active.offsetLeft + "px)";
      }
      function setTab(which) {
        tabSel.forEach((t) => t.classList.toggle("active", t.dataset.tab === which));
        panelSelect.style.display = which === "select" ? "flex" : "none";
        panelManual.style.display = which === "manual" ? "block" : "none";
        moveVenvPill();
        updatePreview();
        if (which === "manual") input.focus();
      }
      tabSel.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
      $$("[data-close]", mask).forEach((b) => b.addEventListener("click", closeModal));
      requestAnimationFrame(moveVenvPill);

      function fillOptions(data) {
        const venvs = (data && data.venvs) || [];
        sel.innerHTML = "";
        const d = document.createElement("option");
        d.value = "";
        d.textContent = "默认（脚本目录 .venv）";
        sel.appendChild(d);
        if (venvs.length) {
          const g = document.createElement("optgroup");
          g.label = "已检测到的虚拟环境";
          for (const v of venvs) {
            const o = document.createElement("option");
            o.value = v.path;
            o.textContent = v.name + "（" + v.type + "）";
            o.title = v.python;
            g.appendChild(o);
          }
          sel.appendChild(g);
        }
        const manual = input.value.trim();
        const val = manual || cur;
        if (val) {
          const exists = [...sel.options].some((o) => o.value === val);
          if (!exists) {
            const o = document.createElement("option");
            o.value = val;
            o.textContent = "自定义：" + val;
            o.title = val;
            sel.appendChild(o);
          }
        }
        sel.value = val;
      }

      /** 底部预览：始终显示当前选择的虚拟环境路径 */
      function updatePreview() {
        const manual = input.value.trim();
        const chosen = manual || sel.value;
        if (manual) {
          preview.textContent = "将使用：" + manual;
          preview.className = "venv-preview manual";
          return;
        }
        if (!chosen) {
          preview.textContent = "当前：默认（脚本目录 .venv）" + (rec.env && rec.env.venv_python ? " · " + rec.env.venv_python : "");
          preview.className = "venv-preview";
          return;
        }
        const opt = [...sel.options].find((o) => o.value === chosen);
        const py = opt && opt.title ? opt.title : chosen;
        const isDefault = chosen === "";
        preview.textContent = "当前：" + (opt ? opt.textContent : chosen) + (py && py !== chosen ? " · " + py : "");
        preview.className = "venv-preview";
      }

      // 手动输入联动
      input.addEventListener("input", updatePreview);
      sel.addEventListener("change", updatePreview);

      // 初始填充
      if (_venvScanned) fillOptions(_venvScanned);
      else {
        scanBtn.disabled = true;
        scanBtn.innerHTML = "<span>扫描中…</span>";
      }
      updatePreview();

      // 扫描
      scanBtn.onclick = async () => {
        scanBtn.disabled = true;
        scanBtn.innerHTML = "<span>扫描中…</span>";
        try {
          const data = await api("/api/env/venvs");
          _venvScanned = data;
          fillOptions(data);
          updatePreview();
          toast("已扫描到 " + (data.venvs || []).length + " 个虚拟环境");
        } catch (e) {
          toast("扫描失败：" + e.message, true);
        } finally {
          scanBtn.disabled = false;
          scanBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg><span>扫描</span>';
        }
      };

      $("#venv-cancel", mask).addEventListener("click", closeModal);

      $("#venv-save", mask).addEventListener("click", async () => {
        const manual = input.value.trim();
        const v = manual || sel.value;
        try {
          await api(`/api/scripts/${rec.id}`, { method: "PUT", body: { venv_path: v } });
          rec.venv_path = v;
          toast(v ? "已切换虚拟环境" : "已恢复默认环境");
          closeModal();
          const env = await api(`/api/scripts/${rec.id}/env`);
          rec.env = env;
          renderEnvBar(env);
        } catch (e) {
          toast("保存失败：" + e.message, true);
        }
      });

      // 后台拉取扫描结果
      if (!_venvScanned) {
        api("/api/env/venvs")
          .then((data) => {
            _venvScanned = data;
            fillOptions(data);
            updatePreview();
            scanBtn.disabled = false;
            scanBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg><span>扫描</span>';
          })
          .catch(() => {
            scanBtn.disabled = false;
            scanBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg><span>扫描</span>';
          });
      }
    },
  });
}

/* ================= 预设 ================= *//* ================= 预设 ================= *//* ================= 预设 ================= */

/** 预设展示分组：固定项排最前（不限个数），非固定按最近使用补足到 MAX_SHOWN 个，其余折叠 */
const PRESET_MAX_SHOWN = 6;
function presetDisplayGroups(all) {
  // 尊重后端 sort_order 顺序（固定项在前，其余按添加/手动排序），不再自行排序
  const pinned = all.filter((p) => p.pinned);
  const unpinned = all.filter((p) => !p.pinned);
  const shown = unpinned.slice(0, Math.max(0, PRESET_MAX_SHOWN - pinned.length));
  const rest = unpinned.slice(shown.length);
  return { pinned, shown, rest };
}

function renderPresets(presets) {
  const bar = $("#preset-bar");
  bar.innerHTML = "";
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "预设";
  const chips = document.createElement("div");
  chips.className = "preset-chips";
  const { pinned, shown, rest } = presetDisplayGroups(presets || []);
  for (const p of [...pinned, ...shown]) {
    chips.appendChild(makePresetChip(p));
  }
  if (rest.length > 0) {
    chips.appendChild(makeMoreBubble(rest.length, presets || []));
  } else {
    // 气泡常驻：即使没有更多预设也显示管理入口（固定 / 排序 / 编辑）
    chips.appendChild(makeMoreBubble(0, presets || []));
  }
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn mini ghost";
  saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>';
  saveBtn.appendChild(document.createTextNode(" 保存当前为预设"));
  saveBtn.onclick = saveAsPreset;
  bar.append(lbl, chips, saveBtn);
}

function makePresetChip(p) {
  const chip = document.createElement("span");
  chip.className = "preset-chip" + (p.pinned ? " pinned" : "");
  if (p.pinned) {
    const pin = document.createElement("span");
    pin.className = "pin-mark";
    pin.textContent = "📌";
    pin.title = "已固定，始终排最前";
    chip.appendChild(pin);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = p.name;
  name.title = "点击应用此预设";
  name.onclick = () => applyPreset(p);
  chip.appendChild(name);
  const x = document.createElement("span");
  x.className = "x";
  x.textContent = "✕";
  x.title = "删除预设（再次点击确认）";
  x.onclick = async (e) => {
    e.stopPropagation();
    if (chip.classList.contains("confirm-del")) {
      // 第二次点击：直接删除
      clearTimeout(chip._delTimer);
      chip.classList.remove("confirm-del");
      await api(`/api/presets/${p.id}`, { method: "DELETE" });
      toast("预设已删除");
      reloadDetail();
      return;
    }
    chip.classList.add("confirm-del");
    toast(`再次点击「✕」即可完成删除预设「${p.name}」`, "warn");
    chip._delTimer = setTimeout(() => chip.classList.remove("confirm-del"), 3000);
  };
  chip.appendChild(x);
  return chip;
}

/** 「还有更多」气泡：三个圆形叠加 + 剩余数量（常驻管理入口） */
function makeMoreBubble(count, all) {
  const more = document.createElement("div");
  more.className = "preset-more";
  more.title = count > 0 ? `还有 ${count} 个预设 · 点击管理全部` : "管理全部预设（固定 / 排序 / 编辑）";
  more.appendChild(Object.assign(document.createElement("span"), { className: "pm-b1" }));
  more.appendChild(Object.assign(document.createElement("span"), { className: "pm-b2" }));
  more.appendChild(Object.assign(document.createElement("span"), { className: "pm-b3" }));
  const cnt = document.createElement("span");
  cnt.className = "pm-count";
  cnt.textContent = count > 0 ? "+" + count : "⋯";
  more.appendChild(cnt);
  more.onclick = () => openPresetsModal(all);
  return more;
}

/** 全部预设管理弹窗：固定 / 排序 / 应用 / 删除 */
function openPresetsModal(presets) {
  openModal({
    title: `全部预设 · ${presets.length} 个`,
    bodyHTML: `
      <div class="preset-manage" id="preset-manage"></div>
      <div class="pm-tip">点击名称应用 · 📌 固定后始终排最前 · ↑↓ 手动排序 · 删除需二次确认</div>`,
    footHTML: `<button class="btn ghost" data-close>关闭</button>`,
    onMount: (mask) => {
      $$("[data-close]", mask).forEach((b) => b.addEventListener("click", closeModal));
      renderPresetManager(mask, presets || []);
    },
  });
}

function renderPresetManager(mask, presets) {
  const wrap = $("#preset-manage", mask);
  wrap.innerHTML = "";
  // 直接显示全部（固定在前，其余按当前顺序），不划分分组
  const { pinned, shown, rest } = presetDisplayGroups(presets || []);
  for (const p of [...pinned, ...shown, ...rest]) wrap.appendChild(makeManagerRow(mask, p));
}

function makeManagerRow(mask, p) {
  const row = document.createElement("div");
  row.className = "pm-row" + (p.pinned ? " pinned" : "");
  const name = document.createElement("button");
  name.className = "pm-name";
  name.textContent = p.name;
  name.title = "应用此预设";
  name.onclick = () => {
    applyPreset(p);
    closeModal();
  };
  const pin = document.createElement("button");
  pin.className = "pm-op" + (p.pinned ? " active" : "");
  pin.textContent = "📌";
  pin.title = p.pinned ? "取消固定" : "固定（排最前）";
  pin.onclick = () => patchPresetAndRefresh(mask, p.id, { pinned: !p.pinned });
  const up = document.createElement("button");
  up.className = "pm-op";
  up.textContent = "↑";
  up.title = "上移";
  up.onclick = () => patchPresetAndRefresh(mask, p.id, { order: "up" });
  const down = document.createElement("button");
  down.className = "pm-op";
  down.textContent = "↓";
  down.title = "下移";
  down.onclick = () => patchPresetAndRefresh(mask, p.id, { order: "down" });
  const del = document.createElement("button");
  del.className = "pm-op del";
  del.textContent = "✕";
  del.title = "删除预设（再次点击确认）";
  del.onclick = async () => {
    if (row.classList.contains("confirm-del")) {
      // 第二次点击：直接删除
      clearTimeout(row._delTimer);
      row.classList.remove("confirm-del");
      await api(`/api/presets/${p.id}`, { method: "DELETE" });
      toast("预设已删除");
      await reloadDetail();
      renderPresetManager(mask, (state.script && state.script.presets) || []);
      return;
    }
    row.classList.add("confirm-del");
    toast(`再次点击「✕」即可完成删除预设「${p.name}」`, "warn");
    row._delTimer = setTimeout(() => row.classList.remove("confirm-del"), 3000);
  };
  row.append(name, pin, up, down, del);
  return row;
}

async function patchPresetAndRefresh(mask, id, body) {
  try {
    await api(`/api/presets/${id}`, { method: "PATCH", body });
    await reloadDetail();
    renderPresetManager(mask, (state.script && state.script.presets) || []);
  } catch (e) {
    toast("操作失败：" + e.message, true);
  }
}

async function saveAsPreset() {
  const values = collectValues();
  const presets = state.script.presets || [];
  openModal({
    title: "保存为预设",
    bodyHTML: `
      <div class="m-field">
        <div class="m-label">预设名称（新建）</div>
        <input class="f-input" id="preset-name" placeholder="输入新名称保存新预设" autocomplete="off">
      </div>
      <div class="m-field">
        <div class="m-label">已有预设 · 点击标签两次覆盖</div>
        <div class="preset-overwrite-chips" id="preset-overwrite-chips"></div>
      </div>`,
    footHTML: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="preset-save">保存为新预设</button>`,
    onMount: (mask) => {
      $$("[data-close]", mask).forEach((b) => b.addEventListener("click", closeModal));
      const chips = $("#preset-overwrite-chips", mask);
      let pending = null; // 第一次点击待覆盖的预设名
      for (const p of presets) {
        const chip = document.createElement("span");
        chip.className = "preset-chip";
        chip.textContent = p.name;
        chip.title = "第一次点击进入覆盖确认，再次点击同一标签完成覆盖";
        chip.onclick = () => {
          if (pending === p.name) {
            // 第二次点击同一标签：覆盖保存
            api(`/api/scripts/${state.script.id}/presets`, { method: "POST", body: { name: p.name, args: values } })
              .then(() => { toast(`已覆盖预设「${p.name}」`); closeModal(); reloadDetail(); })
              .catch((e) => toast("覆盖失败：" + e.message, true));
            return;
          }
          pending = p.name;
          $$(".preset-chip", chips).forEach((c) => c.classList.remove("cover-target"));
          chip.classList.add("cover-target");
          toast(`再次点击「${p.name}」即可完成覆盖该预设`, "warn");
        };
        chips.appendChild(chip);
      }
      $("#preset-save", mask).addEventListener("click", async () => {
        const name = $("#preset-name", mask).value.trim();
        if (!name) return toast("请输入预设名称", true);
        if (presets.some((p) => p.name === name)) {
          return toast("已存在同名预设，请点击下方标签两次覆盖，或换个名称", true);
        }
        await api(`/api/scripts/${state.script.id}/presets`, { method: "POST", body: { name, args: values } });
        closeModal();
        toast("预设已保存");
        reloadDetail();
      });
      $("#preset-name", mask).focus();
    },
  });
}

function applyPreset(p) {
  state.activePresetId = p.id;
  fillValues(p.args || {});
  saveArgs(p.args || {});
  toast("已应用预设「" + p.name + "」");
  // 本地立即更新最近使用顺序，同时持久化
  p.last_used_at = new Date().toISOString();
  renderPresets((state.script && state.script.presets) || []);
  api(`/api/presets/${p.id}`, { method: "PATCH", body: { touch: true } }).catch(() => {});
}

/* ================= 参数表单 ================= */

/** 参数类型标签（带颜色区分） */
function typeLabelOf(a) {
  if (a.is_flag) return { cls: "bool", text: "bool" };
  if (a.choices && a.choices.length) return { cls: "choices", text: "enum" };
  const t = a.type || "str";
  if (a.nargs || a.action === "append") return { cls: "list", text: "list" };
  if (t === "int") return { cls: "int", text: "int" };
  if (t === "float") return { cls: "float", text: "float" };
  return { cls: "str", text: "str" };
}

function renderFields(schema, saved) {
  const wrap = $("#fields");
  wrap.innerHTML = "";
  if (!schema || schema.length === 0) {
    const tip = document.createElement("div");
    tip.className = "form-empty";
    tip.style.height = "auto";
    tip.style.padding = "20px";
    tip.textContent = "该脚本没有定义任何命令行参数";
    wrap.appendChild(tip);
    return;
  }
  for (const a of schema) {
    const field = document.createElement("div");
    field.className = "field" + (a.is_flag ? " field-switch" : "");
    field.dataset.dest = a.dest;

    const label = document.createElement("div");
    label.className = "f-label";
    const nm = document.createElement("span");
    nm.textContent = a.dest;
    if (a.required) {
      const req = document.createElement("span");
      req.className = "req";
      req.textContent = "*";
      req.title = "必选参数";
      label.appendChild(req);
    }
    const kind = document.createElement("span");
    kind.className = "f-kind" + (a.required ? " req" : "");
    kind.textContent = a.required ? "必填" : "可选";
    label.appendChild(nm);
    label.appendChild(kind);
    const tl = typeLabelOf(a);
    if (tl) {
      const t = document.createElement("span");
      t.className = "f-type " + tl.cls;
      t.textContent = tl.text;
      t.title = "参数类型：" + tl.text;
      label.appendChild(t);
    }
    field.appendChild(label);

    // 帮助/说明：显示在输入框上方、参数名称下方
    if (a.help || (a.option_strings && a.option_strings.length)) {
      const help = document.createElement("div");
      help.className = "f-help";
      const optStr = a.option_strings ? a.option_strings.join(" / ") : a.name;
      help.textContent = (a.help ? a.help : "") + (a.help && optStr ? " · " : "") + (optStr ? optStr : "");
      field.appendChild(help);
    }

    const defaultVal = a.default;
    const savedVal = saved ? saved[a.dest] : undefined;
    let value = savedVal !== undefined && savedVal !== null ? savedVal : defaultVal;

    let input;
    if (a.is_flag) {
      // 布尔：开关 + 状态文本，与其他字段排版一致（名称在上、开关在下）
      const ctrl = document.createElement("div");
      ctrl.className = "f-control";
      const sw = document.createElement("label");
      sw.className = "switch";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!value;
      const slider = document.createElement("span");
      slider.className = "slider";
      sw.append(cb, slider);
      const val = document.createElement("span");
      val.className = "sw-val";
      val.textContent = cb.checked ? "开启" : "关闭";
      cb.addEventListener("change", () => {
        val.textContent = cb.checked ? "开启" : "关闭";
        autoSave();
      });
      ctrl.append(sw, val);
      field.appendChild(ctrl);
      input = cb;
    } else if (a.choices && a.choices.length) {
      input = document.createElement("select");
      input.className = "f-input";
      const emptyOpt = document.createElement("option");
      emptyOpt.value = "";
      emptyOpt.textContent = a.required ? "请选择…" : "（不传）";
      input.appendChild(emptyOpt);
      for (const c of a.choices) {
        const opt = document.createElement("option");
        opt.value = String(c);
        opt.textContent = String(c);
        input.appendChild(opt);
      }
      input.value = value !== undefined && value !== null ? String(value) : "";
      input.addEventListener("change", autoSave);
      field.appendChild(input);
    } else {
      input = document.createElement("input");
      input.className = "f-input mono";
      const isNum = a.type === "int" || a.type === "float";
      if (isNum) {
        input.type = "number";
        if (a.type === "int") input.step = "1";
      } else {
        input.type = "text";
      }
      const isMulti = a.nargs || a.action === "append";
      if (isMulti) input.placeholder = "多个值用英文逗号分隔";
      if (value !== undefined && value !== null) {
        input.value = Array.isArray(value) ? value.join(", ") : String(value);
      }
      input.addEventListener("input", () => autoSave());
      field.appendChild(input);
    }
    wrap.appendChild(field);
  }
  applyEmptyFilter();
}

/** 开关「仅显示已填参数」：空值参数隐藏，布尔开关始终显示 */
function applyEmptyFilter() {
  const box = $("#opt-hide-empty");
  if (!box) return;
  const hide = box.checked;
  for (const field of $$("#fields .field")) {
    if (!hide || field.classList.contains("field-switch")) {
      field.style.display = "";
      continue;
    }
    const sel = field.querySelector("select");
    const inp = field.querySelector("input");
    const val = sel ? sel.value : (inp ? inp.value : "");
    field.style.display = val !== "" && val !== null && val !== undefined ? "" : "none";
  }
}
$("#opt-hide-empty").addEventListener("change", () => { applyEmptyFilter(); savePrefs(); });

function collectValues() {
  const values = {};
  for (const field of $$("#fields .field")) {
    const dest = field.dataset.dest;
    const arg = (state.script.args_schema || []).find((a) => a.dest === dest);
    if (!arg) continue;
    if (arg.is_flag) {
      const cb = field.querySelector("input[type=checkbox]");
      values[dest] = !!cb.checked;
    } else if (arg.choices && arg.choices.length) {
      const sel = field.querySelector("select");
      values[dest] = sel.value;
    } else {
      const inp = field.querySelector("input");
      const raw = inp.value.trim();
      const isMulti = arg.nargs || arg.action === "append";
      if (isMulti) {
        values[dest] = raw ? raw.split(/[,，\s]+/).filter(Boolean) : [];
      } else if (arg.type === "int") {
        values[dest] = raw === "" ? "" : Number(raw);
      } else if (arg.type === "float") {
        values[dest] = raw === "" ? "" : Number(raw);
      } else {
        values[dest] = raw;
      }
    }
  }
  return values;
}

function openCommandImport() {
  if (!state.script) return toast("请先选择一个脚本", true);
  const schema = state.script.args_schema || [];
  if (!schema.length) return toast("该脚本没有可解析的命令行参数", true);
  const hasPos = schema.some((a) => a.kind === "positional");
  openModal({
    title: "命令行导入参数",
    bodyHTML: `
      <div class="cmd-import-tip">粘贴完整命令或仅参数片段（支持换行、<code>--key value</code>、<code>--key=value</code>），解析后自动回填表单。${hasPos ? "位置参数按声明顺序解析。" : ""}</div>
      <textarea class="f-input cmd-import-input" id="cmd-import-input" rows="6" spellcheck="false" autocomplete="off"
        placeholder="例如：${hasPos ? "input.csv " : ""}--max-workers 3\n--flush-every 5\n或：uv run script.py --max-workers 3"></textarea>
      <div class="cmd-import-result" id="cmd-import-result"></div>
    `,
    footHTML: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="cmd-import-ok">解析并回填</button>`,
    onMount: (mask) => {
      $$("[data-close]", mask).forEach((b) => b.addEventListener("click", closeModal));
      $("#cmd-import-ok", mask).addEventListener("click", async () => {
        const txt = $("#cmd-import-input", mask).value.trim();
        const box = $("#cmd-import-result", mask);
        if (!txt) return toast("请输入命令行", true);
        let res;
        try {
          res = await api(`/api/scripts/${state.script.id}/parse-command`, { method: "POST", body: { command: txt } });
        } catch (e) {
          box.innerHTML = `<div class="result-tip err">请求失败：${escapeHtml(e.message)}</div>`;
          return;
        }
        if (!res.ok) {
          box.innerHTML = `<div class="result-tip err">${escapeHtml(res.error || "解析失败")}</div>`;
          return;
        }
        const filled = Object.keys(res.parsed || {}).length;
        let html = `<div class="result-tip ok">已解析 ${filled} 个参数并回填表单</div>`;
        if (res.missing && res.missing.length) html += `<div class="result-tip warn">缺失必填：${escapeHtml(res.missing.join("、"))}</div>`;
        if (res.unknown && res.unknown.length) html += `<div class="result-tip warn">未识别参数：${escapeHtml(res.unknown.join("、"))}</div>`;
        if (res.extra && res.extra.length) html += `<div class="result-tip warn">多余位置参数：${escapeHtml(res.extra.join("、"))}</div>`;
        if (res.errors && Object.keys(res.errors).length) {
          const errs = Object.entries(res.errors)
            .map(([k, v]) => `${k}：${Array.isArray(v) ? v.join("；") : v}`)
            .join("<br>");
          html += `<div class="result-tip err">${errs}</div>`;
        }
        box.innerHTML = html;
        const hasIssue = !!(res.missing && res.missing.length) || !!(res.unknown && res.unknown.length)
          || !!(res.extra && res.extra.length) || !!(res.errors && Object.keys(res.errors).length);
        if (filled) {
          fillValues(res.parsed);
          saveArgs(collectValues());
          if (!hasIssue) {
            toast("已回填 " + filled + " 个参数");
            closeModal();
          } else {
            toast("已回填 " + filled + " 个参数，请查看下方提示");
          }
        } else {
          toast("未解析到可识别的参数", true);
        }
      });
    },
  });
}

function fillValues(values) {
  for (const field of $$("#fields .field")) {
    const dest = field.dataset.dest;
    const v = values ? values[dest] : undefined;
    if (v === undefined) continue;
    if (field.querySelector("input[type=checkbox]")) {
      field.querySelector("input[type=checkbox]").checked = !!v;
    } else if (field.querySelector("select")) {
      field.querySelector("select").value = String(v);
    } else {
      const inp = field.querySelector("input");
      inp.value = Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  applyEmptyFilter();
}

let saveTimer = null;
function autoSave() {
  const values = collectValues();
  if (!state.script) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveArgs(values);
  }, 500);
}

async function saveArgs(values) {
  try {
    await api(`/api/scripts/${state.script.id}/args`, { method: "PUT", body: { args: values } });
  } catch { /* 忽略保存失败 */ }
  refreshCmdInput();
}

async function reloadDetail() {
  if (state.selectedId) await selectScript(state.selectedId);
}

/* ================= 执行 ================= */

function applyRunState() {
  const btn = $("#btn-run");
  if (!btn) return;
  const running = !!state.running;
  btn.disabled = running;
  btn.classList.toggle("run-active", running);
  const span = btn.querySelector("span");
  if (span) span.textContent = running ? "运行中…" : "执行";
  $("#btn-terminate").hidden = !running;
}

function setRunning(running) {
  state.running = running;
  if (!running) {
    state.currentExecId = null;
  }
  applyRunState();
}

/* 构建当前表单对应的 uv run 命令（与后端 build_arg_list / _build_command_text 保持一致） */
function buildArgList(schema, values) {
  const result = [];
  const positionals = (schema || []).filter((a) => a.kind === "positional");
  const optionals = (schema || []).filter((a) => a.kind === "optional");
  for (const a of positionals) {
    const v = values[a.dest];
    if (v === undefined || v === null || v === "") continue;
    result.push(String(v));
  }
  for (const a of optionals) {
    const flag = a.name;
    const v = values[a.dest];
    if (a.is_flag) {
      const on = v === true || v === "true" || v === 1 || v === "1" || v === "on";
      if (a.action === "store_true" && on) result.push(flag);
      else if (a.action === "store_false" && !on) result.push(flag);
      continue;
    }
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      if (a.action === "append") { for (const it of v) result.push(flag, String(it)); }
      else { result.push(flag); for (const it of v) result.push(String(it)); }
      continue;
    }
    const s = String(v);
    if (s === "") { if (a.required) result.push(flag, ""); continue; }
    result.push(flag, s);
  }
  return result;
}

function shq(s) {
  s = String(s);
  if (s && /^[A-Za-z0-9_\-./@:=+%]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function buildCommandText() {
  const s = state.script;
  if (!s || !s.path) return "";
  try {
    const r = await api("/api/scripts/command", { method: "POST", body: { script_id: s.id, args: collectValues() } });
    if (r.error) return { error: r.error };
    return { command: r.command };
  } catch (e) {
    return { error: e.message };
  }
}

let cmdInputTimer = null;
function userCmdKey() { return "launcher_usercmd_" + (state.script ? state.script.id : 0); }
async function refreshCmdInput() {
  const inp = $("#cmd-edit-input");
  if (!inp || !state.script) return;
  const res = await buildCommandText();
  if (!res || res.error) { inp.value = ""; return; }
  const defaultCmd = res.command;
  const saved = (localStorage.getItem(userCmdKey()) || "").trim();
  if (saved) {
    let merged = "";
    try {
      const mr = await api(`/api/scripts/${state.script.id}/merge-command`, { method: "POST", body: { args: collectValues(), command: saved } });
      merged = (mr.ok && mr.merged) || "";
    } catch (e) {}
    inp.value = merged || saved; // 无法合并时保持整条用户命令
  } else {
    inp.value = defaultCmd;
  }
}
function onCmdInput() {
  clearTimeout(cmdInputTimer);
  cmdInputTimer = setTimeout(() => {
    const v = $("#cmd-edit-input").value.trim();
    if (v) localStorage.setItem(userCmdKey(), v);
    else localStorage.removeItem(userCmdKey());
  }, 600);
}

async function run() {
  if (!state.script || state.running) return;
  const values = collectValues();
  const schema = state.script.args_schema || [];
  const missing = schema.filter((a) => a.required && (
    values[a.dest] === undefined || values[a.dest] === null || values[a.dest] === "" ||
    (Array.isArray(values[a.dest]) && values[a.dest].length === 0)
  ));
  if (missing.length) {
    return toast("缺少必选参数：" + missing.map((a) => a.dest).join(", "), true);
  }
  // 立即保存当前值
  saveArgs(values);
  switchTab("console");
  clearConsole(); // 每次执行都是干净的控制台
  setRunning(true);
  $("#run-state").textContent = "启动中…";
  $("#run-state").className = "run-state run";
  try {
    const cmdInput = $("#cmd-edit-input");
    const customCmd = cmdInput ? cmdInput.value.trim() : "";
    const body = { script_id: state.script.id, args: values, preset_id: state.activePresetId };
    if (customCmd) body.command = customCmd;
    const res = await api("/api/execute", { method: "POST", body });
    state.currentExecId = res.execution_id;
    connectWs(`/ws/run/${res.execution_id}`, {});
  } catch (e) {
    setRunning(false);
    toast("执行失败：" + e.message, true);
  }
}

/* ================= 控制台（流式终端模拟） =================
   pty 模式下后端推送原始字节块（含 \r \r\n ANSI 转义），这里做终端语义还原：
   - \r 覆盖当前行（进度条单行刷新）
   - \n / \r\n 换行（提交一行）
   - ANSI SGR 颜色码渲染为彩色文本
   渲染器可实例化：主控制台与执行记录详情页各持一个，互不干扰 */

function createConsoleRenderer(consoleEl, wrapEl, placeholderEl) {
  const st = { buf: "", cur: null, crPending: false, streamCls: "", lineCount: 0 };
  const autoscroll = () => {
    if (wrapEl && $("#opt-autoscroll").checked) wrapEl.scrollTop = wrapEl.scrollHeight;
  };
  function ensure() {
    if (st.cur) return;
    const lineNo = st.lineCount + 1;
    const line = document.createElement("div");
    line.className = "console-line" + (st.streamCls ? " " + st.streamCls : "");
    const no = document.createElement("div");
    no.className = "line-no";
    no.textContent = lineNo;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "复制";
    btn.onclick = async (e) => {
      e.stopPropagation();
      const txt = line.querySelector(".line-text").textContent || "";
      if (await copyText(stripAnsi(txt))) toast("已复制第 " + lineNo + " 行");
    };
    no.appendChild(btn);
    const txt = document.createElement("div");
    txt.className = "line-text";
    line.append(no, txt);
    consoleEl.appendChild(line);
    st.lineCount++;
    st.cur = line;
    // 控制控制台体量：最多保留 5000 行
    while (consoleEl.children.length > 5000) consoleEl.removeChild(consoleEl.firstChild);
  }
  function update() {
    if (!st.buf && !st.cur) return;
    ensure();
    st.cur.querySelector(".line-text").innerHTML = ansiToHtml(st.buf);
    autoscroll();
  }
  function flush() {
    ensure();
    st.cur.querySelector(".line-text").innerHTML = ansiToHtml(st.buf);
    st.cur = null;
    st.buf = "";
    autoscroll();
  }
  return {
    st,
    clear() {
      consoleEl.innerHTML = "";
      st.buf = ""; st.cur = null; st.crPending = false; st.streamCls = ""; st.lineCount = 0;
      if (placeholderEl) placeholderEl.style.display = "flex";
    },
    append(stream, chunk) {
      if (placeholderEl) placeholderEl.style.display = "none";
      st.streamCls = stream === "info" ? "info" : stream === "stderr" ? "stderr" : "";
      let i = 0;
      const len = chunk.length;
      while (i < len) {
        const ch = chunk[i];
        // 上一个块以 \r 结尾：先结算（下个字符决定是覆盖还是换行）
        if (st.crPending) {
          st.crPending = false;
          if (ch === "\n") { flush(); i++; continue; }
          st.buf = ""; // \r 覆盖当前行
        }
        if (ch === "\r") {
          if (i + 1 < len) {
            if (chunk[i + 1] === "\n") { flush(); i += 2; continue; }
            st.buf = ""; // 单行进度条刷新
            i++;
            continue;
          }
          st.crPending = true;
          i++;
          continue;
        }
        if (ch === "\n") { flush(); i++; continue; }
        st.buf += ch;
        i++;
      }
      // 块尾统一刷新当前行（进度条实时可见；\r 结尾时留待下块决定）
      if (st.buf && !st.crPending) update();
    },
  };
}

const mainConsole = createConsoleRenderer($("#console"), $("#console-wrap"), $("#console-placeholder"));
function clearConsole() { mainConsole.clear(); }
function appendStream(stream, chunk) { mainConsole.append(stream, chunk); }

// ANSI SGR 颜色映射（适配浅色控制台）
const ANSI_FG = { 30: "#1a1a1a", 31: "#c62828", 32: "#2e7d32", 33: "#9e7d00", 34: "#1565c0", 35: "#8e24aa", 36: "#00796b", 37: "#424242" };
const ANSI_FG_BRIGHT = { 90: "#757575", 91: "#e53935", 92: "#43a047", 93: "#c0a000", 94: "#1e88e5", 95: "#d81b60", 96: "#00acc1", 97: "#212121" };
const ANSI_BG = { 40: "#1a1a1a", 41: "#c62828", 42: "#2e7d32", 43: "#9e7d00", 44: "#1565c0", 45: "#8e24aa", 46: "#00796b", 47: "#dddddd" };

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function ansiToHtml(text) {
  const re = /\x1b\[([0-9;]*)m/g;
  let html = "";
  let last = 0;
  let fg = "", bg = "", bold = false;
  const push = (t) => {
    if (!t) return;
    const st = [];
    if (fg) st.push("color:" + fg);
    if (bg) st.push("background:" + bg);
    if (bold) st.push("font-weight:700");
    html += st.length ? `<span style="${st.join(";")}">${t}</span>` : t;
  };
  let m;
  while ((m = re.exec(text)) !== null) {
    push(escapeHtml(text.slice(last, m.index)));
    const codes = m[1] ? m[1].split(";") : [];
    for (const c of codes) {
      const n = parseInt(c, 10);
      if (Number.isNaN(n)) continue;
      if (n === 0) { fg = ""; bg = ""; bold = false; }
      else if (n === 1) bold = true;
      else if (n === 22) bold = false;
      else if (n >= 30 && n <= 37) fg = ANSI_FG[n];
      else if (n >= 90 && n <= 97) fg = ANSI_FG_BRIGHT[n];
      else if (n >= 40 && n <= 47) bg = ANSI_BG[n];
    }
    last = m.index + m[0].length;
  }
  push(escapeHtml(text.slice(last)));
  return html;
}

async function connectWs(path, { envInit = false, scriptId = null } = {}) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${path}`);
  state.ws = ws;
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "line") {
      appendStream(m.stream, m.line);
    } else if (m.type === "done") {
      const r = m.result || {};
      if (envInit) {
        if (r.ok) {
          toast("环境初始化完成");
          const env = await api(`/api/scripts/${scriptId}/env`);
          if (state.script && state.script.id === scriptId) renderEnvBar(env);
        } else {
          toast("环境初始化失败：" + (r.message || ""), true);
        }
        const btn = $("#env-bar .btn.primary");
        if (btn) { btn.disabled = false; btn.textContent = "初始化环境"; }
      } else {
        const statusText = { success: "执行成功", failed: "执行失败", terminated: "已终止" }[r.status] || "执行结束";
        $("#run-state").textContent = `${statusText} · 退出码 ${r.exit_code ?? "-"}`;
        $("#run-state").className = "run-state " + (r.status === "success" ? "ok" : r.status === "failed" ? "err" : "warn");
        setRunning(false);
        refreshHistory(); // 后台刷新历史数据，但不自动跳转
      }
    }
  };
  ws.onerror = () => { toast("实时连接断开", true); };
  ws.onclose = () => { state.ws = null; };
}

/* ================= 终止 ================= */

$("#btn-terminate").addEventListener("click", async () => {
  if (!state.currentExecId) return;
  try {
    await api(`/api/executions/${state.currentExecId}/terminate`, { method: "POST" });
    toast("已发送终止信号");
  } catch (e) {
    toast(e.message, true);
  }
});

/* ================= 控制台工具 ================= */

$("#btn-parse-cmd").addEventListener("click", openCommandImport);
$("#cmd-edit-input").addEventListener("input", onCmdInput);
$("#cmd-edit-reset").addEventListener("click", () => {
  localStorage.removeItem(userCmdKey());
  refreshCmdInput();
  toast("已恢复默认命令");
});
$("#btn-copy-command").addEventListener("click", async () => {
  if (!state.script) return toast("请先选择一个脚本", true);
  const res = await buildCommandText();
  if (!res) return toast("当前无脚本可复制", true);
  if (res.error) return toast(res.error, true);
  if (await copyText(res.command)) toast("已复制执行命令");
});
$("#opt-mono").addEventListener("change", (e) => {
  $("#console").classList.toggle("mono", e.target.checked);
  savePrefs();
});
$("#opt-autoscroll").addEventListener("change", savePrefs);

/* 多选复制：拖选跨行后弹出复制按钮 */
function updateMultiCopy() {
  const floatEl = $("#copy-float");
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { floatEl.hidden = true; return; }
  const range = sel.getRangeAt(0);
  const consoleEl = $("#console");
  if (!consoleEl.contains(range.commonAncestorContainer)) { floatEl.hidden = true; return; }
  const lines = $$(".console-line", consoleEl);
  let count = 0;
  for (const ln of lines) {
    if (range.intersectsNode(ln)) count++;
  }
  if (count === 0) { floatEl.hidden = true; return; }
  floatEl.hidden = false;
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "复制选中 " + count + " 行";
  btn.onclick = async () => {
    if (await copyText(sel.toString())) toast("已复制 " + count + " 行");
    floatEl.hidden = true;
  };
  floatEl.innerHTML = "";
  floatEl.appendChild(btn);
}
document.addEventListener("mouseup", updateMultiCopy);
document.addEventListener("keyup", updateMultiCopy);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("#copy-float").hidden = true; $$(".move-menu").forEach((m) => m.remove()); }
});
/* ================= 运行任务轮询 / 脚本卡片徽章 / 任务 popover ================= */

async function refreshRunningExecs() {
  try {
    const { running } = await api("/api/executions/running");
    window._offlineStreak = 0;
    hideOfflineBanner();
    const map = {};
    for (const r of running) (map[r.script_id] = map[r.script_id] || []).push(r);
    state.runningByScript = map;
    updateRunBadges();   // 局部更新徽章，避免整表重建导致 popover/弹窗频闪
    updateRunningPopover();
    if (state.detailExec && state.detailExec.status === "running") refreshDetailStatus();
  } catch {
    // 连续多次失败才判定离线，避免瞬时抖动误报
    window._offlineStreak = (window._offlineStreak || 0) + 1;
    if (window._offlineStreak >= 2) showOfflineBanner();
  }
}

function showOfflineBanner() {
  const b = $("#offline-banner");
  if (b) b.hidden = false;
}
function hideOfflineBanner() {
  const b = $("#offline-banner");
  if (b && !b.hidden) b.hidden = true;
}

/** 局部更新脚本卡片上的运行徽章（增/删/数字变化），不重建整个列表。 */
function updateRunBadges() {
  const map = state.runningByScript;
  for (const card of $$("#script-list .script-card")) {
    const id = Number(card.dataset.id);
    const runs = map[id] || [];
    const nameRow = card.querySelector(".sc-name");
    const argBadge = card.querySelector(".sc-arg");
    let badge = card.querySelector(".sc-running");
    if (!runs.length) {
      if (badge) badge.remove();
      continue;
    }
    const label = "● " + runs.length;
    if (badge) {
      if (badge.textContent !== label) {
        badge.textContent = label;
        badge.title = runs.length + " 个任务正在运行，点击查看";
      }
      continue;
    }
    badge = document.createElement("span");
    badge.className = "sc-running";
    badge.textContent = label;
    badge.title = runs.length + " 个任务正在运行，点击查看";
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      openRunningPopover(badge, id);
    });
    // 插在"参数"徽章之前，与 scriptCard 中的顺序保持一致
    argBadge.insertAdjacentElement("beforebegin", badge);
    nameRow.appendChild ? null : null;
  }
}

function fmtRunStart(iso) {
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch { return ""; }
}

function fmtRunDuration(startIso, now = Date.now()) {
  try {
    const s = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}h${String(m).padStart(2, "0")}m${String(sec).padStart(2, "0")}s`
      : m > 0 ? `${m}m${String(sec).padStart(2, "0")}s` : `${sec}s`;
  } catch { return "-"; }
}

function openRunningPopover(anchor, scriptId) {
  state.popoverScriptId = scriptId;
  const pop = $("#running-popover");
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 330)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
  renderRunningPopover();
  if (!window._popoverTimer) window._popoverTimer = setInterval(updateRunningPopover, 1000);
}

function closeRunningPopover() {
  state.popoverScriptId = null;
  $("#running-popover").hidden = true;
  if (window._popoverTimer) { clearInterval(window._popoverTimer); window._popoverTimer = null; }
}

function updateRunningPopover() {
  const pop = $("#running-popover");
  if (pop.hidden || !state.popoverScriptId) return;
  // 每秒只刷新运行时长，避免整表重建闪烁
  $$(".rp-time", pop).forEach((el) => {
    if (el.dataset.start) el.textContent = fmtRunStart(el.dataset.start) + " · 已运行 " + fmtRunDuration(el.dataset.start);
  });
}

function renderRunningPopover() {
  const pop = $("#running-popover");
  if (pop.hidden || !state.popoverScriptId) return;
  const runs = state.runningByScript[state.popoverScriptId] || [];
  pop.innerHTML = "";
  const head = document.createElement("div");
  head.className = "rp-head";
  if (runs.length) {
    const dot = document.createElement("span");
    dot.className = "rp-dot";
    head.append(dot, document.createTextNode(` ${runs.length} 个任务运行中`));
  } else {
    head.textContent = "暂无运行任务";
  }
  pop.appendChild(head);
  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "rp-empty";
    empty.textContent = "该脚本当前没有正在运行的任务";
    pop.appendChild(empty);
    return;
  }
  for (const r of runs) {
    const row = document.createElement("div");
    row.className = "rp-item";
    row.title = "点击查看该任务的执行记录";
    const args = summarizeArgs(JSON.stringify(r.args || {}));
    const a1 = document.createElement("div");
    a1.className = "rp-args";
    a1.textContent = args;
    a1.title = args;
    const a2 = document.createElement("div");
    a2.className = "rp-meta";
    const t = document.createElement("span");
    t.className = "rp-time";
    t.textContent = fmtRunStart(r.started_at) + " · 已运行 " + fmtRunDuration(r.started_at);
    t.dataset.start = r.started_at;
    const arrow = document.createElement("span");
    arrow.className = "rp-arrow";
    arrow.textContent = "→";
    a2.append(t, arrow);
    row.append(a1, a2);
    row.addEventListener("click", () => jumpToExecution(r.id));
    pop.appendChild(row);
  }
}

async function jumpToExecution(id) {
  closeRunningPopover();
  switchTab("history");
  await refreshHistory();
  const item = [...$$("#history-list .hist-item")].find((el) => String(el.dataset.id) === String(id));
  await showHistoryDetail(id, item || null);
}

/* ================= 历史记录 ================= */

let historyScope = "all"; // "all"=全部脚本（默认，确保能看到所有记录）| "script"=仅当前脚本

async function updatePageBadge() {
  const el = $("#page-badge");
  if (!el) return;
  try {
    const [s, h] = await Promise.all([api("/api/scripts"), api("/api/executions?limit=200")]);
    el.textContent = `脚本 ${s.length} · 记录 ${Array.isArray(h) ? h.length : 0}`;
    el.classList.add("ok");
  } catch (e) {
    el.textContent = "连接异常";
    el.classList.add("bad");
  }
}

async function refreshHistory() {
  let list = [];
  try {
    list = await api("/api/executions?limit=200");
  } catch (e) {
    renderHistoryError(e.message);
    return;
  }
  renderHistory(list);
  updatePageBadge();
}

function renderHistoryError(msg) {
  const wrap = $("#history-list");
  wrap.innerHTML = `<div class="sidebar-empty" style="padding:20px">无法加载执行记录：${escapeHtml(msg)}</div>`;
}

function renderHistory(list) {
  const wrap = $("#history-list");
  wrap.innerHTML = "";
  const kw = ($("#history-search").value || "").toLowerCase();
  const filtered = list.filter((h) => {
    if (historyScope === "script" && state.selectedId && h.script_id !== state.selectedId) return false;
    if (!kw) return true;
    const tags = JSON.parse(h.tags || "[]").join(" ");
    const statusCN = { success: "成功", failed: "失败", running: "运行中", terminated: "已终止" }[h.status] || h.status;
    return (h.script_name || "").toLowerCase().includes(kw) ||
      h.status.includes(kw) ||
      statusCN.toLowerCase().includes(kw) ||
      tags.toLowerCase().includes(kw);
  });
  if (filtered.length === 0) {
    const hint = historyScope === "script" && state.selectedId
      ? `当前选中的「${state.script ? state.script.name : ""}」暂无执行记录，可点上方「全部」查看所有脚本的记录`
      : "暂无执行记录：运行脚本后，每次执行都会自动记录到这里";
    wrap.innerHTML = `<div class="sidebar-empty" style="padding:20px">${escapeHtml(hint)}</div>`;
    updateHistoryMultiBar();
    return;
  }
  for (const h of filtered) {
    const item = document.createElement("div");
    item.className = "hist-item";
    if (historyMulti && selectedHistory.has(h.id)) item.classList.add("selected");
    const top = document.createElement("div");
    top.className = "hi-top";
    // 多选模式复选框
    if (historyMulti) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "hi-cb";
      cb.checked = selectedHistory.has(h.id);
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => toggleHistorySelect(h.id));
      top.appendChild(cb);
    }
    const nm = document.createElement("span");
    nm.className = "hi-name";
    nm.textContent = h.script_name || "（脚本已删除）";
    nm.title = h.script_name || "";
    const st = document.createElement("span");
    st.className = "status-pill " + h.status;
    st.textContent = { success: "成功", failed: "失败", running: "运行中", terminated: "已终止" }[h.status] || h.status;
    const tm = document.createElement("span");
    tm.className = "hi-time";
    tm.textContent = formatTime(h.started_at);
    top.append(nm, st, tm);
    // 单条快速删除：双态确认（点击一次卡片变红提示，再点一次删除，无弹窗）
    const del = document.createElement("button");
    del.className = "hi-del";
    del.title = "删除这条记录（再次点击确认）";
    del.textContent = "✕";
    let armed = false, armTimer = null;
    const disarm = () => {
      armed = false;
      clearTimeout(armTimer);
      item.classList.remove("confirm-del");
      del.classList.remove("armed");
      del.textContent = "✕";
      del.title = "删除这条记录（再次点击确认）";
    };
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        item.classList.add("confirm-del");
        del.classList.add("armed");
        del.textContent = "再次点击删除";
        del.title = "再次点击确认删除";
        armTimer = setTimeout(disarm, 3000);
        return;
      }
      clearTimeout(armTimer);
      api(`/api/executions/${h.id}`, { method: "DELETE" })
        .then(() => {
          toast("已删除该执行记录");
          refreshHistory();
          if (selectedHistory.has(h.id)) selectedHistory.delete(h.id);
          if (state.detailExec && state.detailExec.id === h.id) closeHistoryDetail(true);
        })
        .catch((err) => {
          toast("删除失败：" + err.message, true);
          disarm();
        });
    });
    top.appendChild(del);

    const argsLine = document.createElement("div");
    argsLine.className = "hi-args";
    argsLine.textContent = summarizeArgs(h.args);
    argsLine.title = h.args;

    const tagsRow = document.createElement("div");
    tagsRow.className = "hi-tags";
    const tags = JSON.parse(h.tags || "[]");
    for (const t of tags) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "#" + t;
      tagsRow.appendChild(tag);
    }

    item.append(top, argsLine, tagsRow);
    item.dataset.id = h.id;
    item.onclick = () => {
      if (item.classList.contains("confirm-del")) { disarm(); return; } // 警告态点击卡片任意处 → 取消确认
      if (historyMulti) toggleHistorySelect(h.id);
      else showHistoryDetail(h.id, item);
    };
    wrap.appendChild(item);
  }
  // 列表渲染完成后刷新操作条（全选/取消全选文字依赖已渲染的条目数）
  updateHistoryMultiBar();
}

/* ================= 执行记录多选删除 ================= */

let historyMulti = false;          // 多选模式开关
let selectedHistory = new Set();   // 已选记录 id 集合

function enterHistoryMulti() {
  historyMulti = true;
  $("#btn-history-multi").textContent = "取消多选";
  $("#btn-history-multi").classList.add("active");
  refreshHistory();
}

function exitHistoryMulti() {
  historyMulti = false;
  selectedHistory.clear();
  const btn = $("#btn-history-multi");
  if (btn) { btn.textContent = "多选"; btn.classList.remove("active"); }
  refreshHistory();
}

function toggleHistorySelect(id) {
  if (selectedHistory.has(id)) selectedHistory.delete(id);
  else selectedHistory.add(id);
  const item = [...$$("#history-list .hist-item")].find((el) => String(el.dataset.id) === String(id));
  if (item) {
    item.classList.toggle("selected", selectedHistory.has(id));
    // 卡片行点击时同步多选框勾选状态
    const cb = item.querySelector(".hi-cb");
    if (cb) cb.checked = selectedHistory.has(id);
  }
  updateHistoryMultiBar();
}

function updateHistoryMultiBar() {
  const bar = $("#history-multi-bar");
  if (!bar) return;
  if (!historyMulti) { bar.hidden = true; return; }
  bar.hidden = false;
  const count = $("#hm-count");
  if (count) count.textContent = `已选 ${selectedHistory.size} 条`;
  const all = $("#hm-select-all");
  if (all) {
    const items = $$("#history-list .hist-item");
    all.textContent = items.length && selectedHistory.size === items.length ? "取消全选" : "全选";
  }
}

function toggleSelectAll() {
  const items = $$("#history-list .hist-item");
  const allSelected = items.length > 0 && items.every((el) => selectedHistory.has(Number(el.dataset.id)));
  if (allSelected) {
    items.forEach((el) => selectedHistory.delete(Number(el.dataset.id)));
  } else {
    items.forEach((el) => selectedHistory.add(Number(el.dataset.id)));
  }
  refreshHistory();
  updateHistoryMultiBar(); // 立即刷新「全选/取消全选」文字，不等网络
}

async function deleteSelectedHistory() {
  if (!selectedHistory.size) return toast("请先勾选要删除的记录", true);
  const ids = [...selectedHistory];
  confirmModal({
    title: "批量删除执行记录",
    message: `确定删除选中的 ${ids.length} 条执行记录吗？运行中的记录会自动跳过。`,
    confirmText: "删除",
    onConfirm: async () => {
      const r = await api("/api/executions/delete", { method: "POST", body: { ids } });
      selectedHistory.clear();
      if (r.skipped_running && r.skipped_running.length) {
        toast(`已删除 ${r.deleted} 条，跳过 ${r.skipped_running.length} 条运行中记录`);
      } else {
        toast(`已删除 ${r.deleted} 条记录`);
      }
      const d = $("#history-detail");
      if (d) closeHistoryDetail(true);
      refreshHistory();
    },
  });
}

function summarizeArgs(argsStr) {
  try {
    const a = JSON.parse(argsStr || "{}");
    const kv = Object.entries(a).filter(([, v]) => v !== "" && v !== null && v !== undefined);
    if (kv.length === 0) return "（无参数）";
    return kv.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join("  ");
  } catch { return ""; }
}

/** 参数胶囊渲染：每个参数一个 chip（键粗体灰、值等宽黑），多参数自动换行 */
function renderArgChips(container, args) {
  container.innerHTML = "";
  const kv = Object.entries(args || {}).filter(([, v]) => v !== "" && v !== null && v !== undefined);
  if (kv.length === 0) {
    const empty = document.createElement("span");
    empty.className = "no-args";
    empty.textContent = "（无参数）";
    container.appendChild(empty);
    return;
  }
  for (const [k, v] of kv) {
    const chip = document.createElement("span");
    chip.className = "arg-chip";
    const kEl = document.createElement("span");
    kEl.className = "ak";
    kEl.textContent = k;
    const eEl = document.createElement("span");
    eEl.className = "ae";
    eEl.textContent = "=";
    const vEl = document.createElement("span");
    vEl.className = "av";
    const raw = Array.isArray(v) ? v.join(", ") : String(v);
    vEl.textContent = raw || "（空）";
    if (!raw) vEl.classList.add("no-val");
    chip.append(kEl, eEl, vEl);
    container.appendChild(chip);
  }
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* 详情页滑入/滑出（右滑进入、左滑返回） */
function openHistoryDetail() {
  const detail = $("#history-detail");
  if (!detail) return;
  detail.hidden = false;
  detail.classList.remove("open");
  // 双 rAF：先让浏览器渲染 translateX(100%) 初始帧，再加 open 触发右滑 transition
  requestAnimationFrame(() => {
    requestAnimationFrame(() => detail.classList.add("open"));
  });
}
function closeHistoryDetail(instant) {
  const detail = $("#history-detail");
  if (!detail) return;
  const done = () => { detail.hidden = true; };
  detail.classList.remove("open");
  if (instant) { done(); return; }
  // 等左滑动画结束后隐藏
  detail._closeTimer && clearTimeout(detail._closeTimer);
  detail._closeTimer = setTimeout(done, 320);
}

async function showHistoryDetail(id, itemEl) {
  $$(".hist-item").forEach((el) => el.classList.remove("active"));
  if (itemEl) itemEl.classList.add("active");
  const rec = await api(`/api/executions/${id}`);
  state.detailExec = rec;
  // 关闭上一次详情页的实时 WS（与主控制台连接相互独立）
  if (state.detailWs) { try { state.detailWs.close(); } catch {} state.detailWs = null; }

  const detail = $("#history-detail");
  detail.hidden = false;
  detail.innerHTML = "";
  openHistoryDetail(); // 详情从右侧滑入
  // 静态输出行复制按钮（事件委托）
  detail.onclick = (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const lineEl = btn.closest(".console-line");
    const txt = lineEl ? lineEl.querySelector(".line-text").textContent : "";
    copyText(stripAnsi(txt)).then((ok) => { if (ok) toast("已复制第 " + (btn.dataset.line || "") + " 行"); });
  };

  // ===== 头部：返回 + 名称 + 状态 + 时间 + 退出码；右侧操作按钮 =====
  const head = document.createElement("div");
  head.className = "hd-head";
  const backBtn = document.createElement("button");
  backBtn.className = "hd-back";
  backBtn.innerHTML = "‹ 返回";
  backBtn.title = "返回执行记录列表";
  backBtn.onclick = () => closeHistoryDetail();
  const titleBox = document.createElement("div");
  titleBox.className = "hd-title";
  const nameRow = document.createElement("div");
  nameRow.className = "hd-name-row";
  const nm = document.createElement("span");
  nm.className = "hd-name";
  nm.textContent = rec.script_name || "（脚本已删除）";
  const st = document.createElement("span");
  st.className = "status-pill " + rec.status;
  st.textContent = { success: "成功", failed: "失败", running: "运行中", terminated: "已终止" }[rec.status] || rec.status;
  const meta = document.createElement("div");
  meta.className = "hd-meta";
  meta.textContent = `${formatTime(rec.started_at)} · 退出码 ${rec.exit_code ?? "-"}`;
  nameRow.append(nm, st);
  titleBox.append(nameRow, meta);
  head.append(backBtn, titleBox);

  const actions = document.createElement("div");
  actions.className = "hd-actions";
  if (rec.status === "running") {
    const term = document.createElement("button");
    term.className = "btn mini danger";
    term.textContent = "终止";
    term.title = "终止该任务（仅影响这一条运行，不影响其他任务）";
    term.onclick = async () => {
      try {
        await api(`/api/executions/${rec.id}/terminate`, { method: "POST" });
        toast("已发送终止信号");
        term.disabled = true;
        term.textContent = "终止中…";
      } catch (e) { toast(e.message, true); }
    };
    actions.appendChild(term);
  }
  const copy = document.createElement("button");
  copy.className = "btn mini ghost";
  copy.textContent = "复制命令";
  copy.title = "复制该次执行对应的 uv run 命令";
  copy.onclick = async () => {
    if (!rec.command) return toast("无法生成命令", true);
    if (await copyText(rec.command)) toast("已复制执行命令");
  };
  const rerun = document.createElement("button");
  rerun.className = "btn mini primary";
  rerun.textContent = "↻ 用此参数重跑";
  rerun.onclick = () => rerunExecution(rec);
  const del = document.createElement("button");
  del.className = "btn mini danger";
  del.textContent = "删除";
  del.onclick = async () => {
    confirmModal({
      title: "删除执行记录",
      message: `确定删除这条执行记录（${rec.script_name || "脚本"} · ${formatTime(rec.started_at)}）吗？`,
      onConfirm: async () => {
        if (state.detailWs) { try { state.detailWs.close(); } catch {} state.detailWs = null; }
        await api(`/api/executions/${rec.id}`, { method: "DELETE" });
        closeHistoryDetail(true); // 详情已删除，直接回到列表
        refreshHistory();
      },
    });
  };
  actions.append(copy, rerun, del);
  head.append(titleBox, actions);

  // ===== 参数 =====
  const argsBlock = document.createElement("div");
  argsBlock.className = "hd-args";
  const argsLbl = document.createElement("span");
  argsLbl.className = "hd-lbl";
  argsLbl.textContent = "参数";
  const argsTxt = document.createElement("div");
  argsTxt.className = "hd-args-txt";
  renderArgChips(argsTxt, rec.args || {});
  argsBlock.append(argsLbl, argsTxt);

  // ===== 标签 =====
  const tagsRow = document.createElement("div");
  tagsRow.className = "hd-tags";
  const tagsLbl = document.createElement("span");
  tagsLbl.style.cssText = "font-size:11px;color:var(--muted)";
  tagsLbl.textContent = "标签:";
  tagsRow.appendChild(tagsLbl);
  const renderTags = () => {
    $$(".hd-tag", tagsRow).forEach((t) => t.remove());
    const inp = $("#hd-tag-input", tagsRow);
    for (const t of rec.tags) {
      const tag = document.createElement("span");
      tag.className = "tag hd-tag";
      const txt = document.createTextNode("#" + t);
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "✕";
      x.onclick = async () => {
        rec.tags = rec.tags.filter((v) => v !== t);
        await api(`/api/executions/${rec.id}/tags`, { method: "PUT", body: { tags: rec.tags } });
        renderTags(); refreshHistory();
      };
      tag.append(txt, x);
      tagsRow.insertBefore(tag, inp);
    }
  };
  const inp = document.createElement("input");
  inp.id = "hd-tag-input";
  inp.placeholder = "+ 添加标签，回车确认";
  inp.onkeydown = async (e) => {
    if (e.key === "Enter" && inp.value.trim()) {
      rec.tags = [...new Set([...rec.tags, inp.value.trim()])];
      inp.value = "";
      await api(`/api/executions/${rec.id}/tags`, { method: "PUT", body: { tags: rec.tags } });
      renderTags(); refreshHistory();
    }
  };
  tagsRow.appendChild(inp);
  renderTags();

  // ===== 输出区：运行中实时流，结束后静态快照 =====
  if (rec.status === "running") {
    const live = document.createElement("div");
    live.className = "hd-live";
    const ph = document.createElement("div");
    ph.className = "console-placeholder";
    ph.style.display = "flex";
    ph.textContent = "任务运行中，标准输出将实时显示在这里";
    const cons = document.createElement("div");
    cons.className = "console mono hd-live-console";
    live.append(ph, cons);
    const tip = document.createElement("div");
    tip.className = "hd-truncated";
    tip.textContent = "· 实时输出 · 结束后仅保留最后 1000 行";
    detail.append(head, argsBlock, tagsRow, live, tip);
    // 滚动容器传 cons（hd-live-console），"自动滚动"开关对所有控制台生效
    const renderer = createConsoleRenderer(cons, cons, ph);
    state.detailWs = connectDetailWs(rec.id, renderer, id, itemEl);
  } else {
    const out = document.createElement("div");
    out.className = "hd-output";
    const outputHtml = renderStaticOutput(rec.output);
    out.innerHTML = outputHtml || "（无输出）";
    const truncated = document.createElement("div");
    truncated.className = "hd-truncated";
    truncated.textContent = "· 仅保留程序结束后最后 1000 行输出";
    detail.append(head, argsBlock, tagsRow, out, truncated);
  }
}

/* 静态输出渲染为带行号 + 复制按钮的行列表（与实时控制台风格一致） */
function renderStaticOutput(text) {
  if (!text) return "";
  const lines = String(text).split("\n");
  // 去掉末尾多余空行（最后一个 \n 产生的空串）
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((ln, i) => {
    const no = i + 1;
    return `<div class="console-line"><div class="line-no">${no}<button class="copy-btn" data-line="${no}">复制</button></div><div class="line-text">${ansiToHtml(ln) || "&nbsp;"}</div></div>`;
  }).join("");
}

function connectDetailWs(execId, renderer, detailId, itemEl) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/run/${execId}`);
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "line") {
      renderer.append(m.stream, m.line);
    } else if (m.type === "done") {
      try { ws.close(); } catch {}
      if (state.detailWs === ws) state.detailWs = null;
      refreshRunningExecs();
      refreshHistory();
      // 任务已结束，详情页切换为静态快照
      const it = [...$$("#history-list .hist-item")].find((el) => String(el.dataset.id) === String(detailId));
      await showHistoryDetail(detailId, it || itemEl);
    }
  };
  ws.onerror = () => {
    try { ws.close(); } catch {}
    if (state.detailWs === ws) state.detailWs = null;
  };
  return ws;
}

function refreshDetailStatus() {
  // 轮询发现详情记录已结束但 WS 已断开时，把详情页切回静态快照
  if (!state.detailExec || state.detailWs) return;
  const runs = state.runningByScript[state.detailExec.script_id] || [];
  if (!runs.some((r) => r.id === state.detailExec.id)) {
    const it = [...$$("#history-list .hist-item")].find((el) => String(el.dataset.id) === String(state.detailExec.id));
    showHistoryDetail(state.detailExec.id, it || null);
  }
}

async function rerunExecution(rec) {
  if (!rec.script_id) return toast("原脚本已删除，无法重跑", true);
  if (state.selectedId !== rec.script_id) {
    await selectScript(rec.script_id);
  }
  const args = typeof rec.args === "string" ? JSON.parse(rec.args || "{}") : (rec.args || {});
  fillValues(args); // 填充该次执行的参数
  saveArgs(args); // 立即保存为当前值
  state.activePresetId = rec.preset_id;
  toast("已载入该次执行参数，确认后点击「执行」即可重跑");
}

/* ================= 定时任务 ================= */

async function renderSchedules(silent) {
  const wrap = $("#schedule-list");
  if (!wrap) return;
  // 静默轮询时，若正在编辑定时任务输入框（cron/次数），跳过本次重建，避免打断输入
  if (silent) {
    const ae = document.activeElement;
    if (ae && wrap.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) {
      return;
    }
  }
  let list;
  try {
    list = await api("/api/schedules");
  } catch (e) {
    if (!silent) wrap.innerHTML = `<div class="schedule-empty">加载定时任务失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  // 应用本地补丁（乐观 running 等），让执行状态即时可见
  if (window._schedPatch) {
    for (const s of list) {
      const p = window._schedPatch[s.id];
      if (p) Object.assign(s, p);
    }
  }
  if (!list.length) {
    wrap.innerHTML = `<div class="schedule-empty">还没有定时任务，点击右上角「新建定时任务」添加</div>`;
    return;
  }
  wrap.innerHTML = "";
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "schedule-item";

    // 头部：名称 + 状态徽章 + 启用开关
    const head = document.createElement("div");
    head.className = "si-head";
    const name = document.createElement("span");
    name.className = "si-name";
    name.textContent = s.name;
    const headRight = document.createElement("div");
    headRight.className = "si-head-right";
    const autoDone = !s.enabled && s.max_runs && (s.run_count || 0) >= s.max_runs;
    const status = document.createElement("span");
    status.className = "si-status " + (autoDone ? "done" : (s.enabled ? "on" : "off"));
    status.textContent = autoDone ? `已完成 ${s.run_count}/${s.max_runs} 次` : (s.enabled ? "已启用" : "已停用");
    status.title = autoDone ? "已达执行上限自动停用，重新启用后从 0 重新计数" : "";
    const sw = document.createElement("label");
    sw.className = "switch";
    sw.title = "启用 / 停用";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!s.enabled;
    const slider = document.createElement("span");
    slider.className = "slider";
    cb.addEventListener("change", async () => {
      try {
        await api(`/api/schedules/${s.id}`, { method: "PUT", body: { enabled: cb.checked } });
        toast(cb.checked ? "已启用" : "已停用");
        renderSchedules();
      } catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
    });
    sw.append(cb, slider);
    headRight.append(status, sw);
    head.append(name, headRight);

    // cron 表达式 + 执行次数 + 下次执行
    const cronRow = document.createElement("div");
    cronRow.className = "si-cron-row";
    const cron = document.createElement("input");
    cron.className = "f-input mono si-cron-in";
    cron.value = s.cron;
    cron.title = "编辑 cron 表达式：失焦或回车保存，Esc 取消";
    cron.spellcheck = false;
    bindCronInline(cron, s);
    // 执行次数：已执行/上限（可编辑上限，加粗，与 cron 并列）
    const runsBlock = document.createElement("span");
    runsBlock.className = "si-runs-block";
    const runsLabel = document.createElement("span");
    runsLabel.textContent = "次数";
    const runsCur = document.createElement("span");
    runsCur.className = "si-runs-cur";
    runsCur.textContent = String(s.run_count || 0);
    runsCur.title = "已执行次数";
    const runsSep = document.createElement("span");
    runsSep.className = "si-runs-sep";
    runsSep.textContent = "/";
    const cnt = document.createElement("input");
    cnt.type = "number";
    cnt.className = "si-runs-in";
    cnt.min = -1;
    cnt.value = s.max_runs ? s.max_runs : -1;
    cnt.title = "执行次数上限，-1 表示不限；失焦或回车保存，Esc 取消";
    if (s.max_runs) cnt.style.color = "#2e7d32";
    bindRunsInline(cnt, s);
    runsBlock.append(runsLabel, runsCur, runsSep, cnt);
    const next = document.createElement("div");
    next.className = "si-next";
    const nextLabel = document.createElement("span");
    nextLabel.className = "si-next-label";
    nextLabel.textContent = "下次执行";
    const nextTime = document.createElement("span");
    nextTime.className = "si-next-time";
    if (s.enabled && s.next_run) {
      nextTime.textContent = fmtTime(s.next_run);
      const rel = document.createElement("span");
      rel.className = "si-next-rel";
      rel.textContent = relTime(s.next_run);
      next.append(nextLabel, nextTime, rel);
    } else {
      nextTime.textContent = s.enabled ? "待计算" : "已停用，无计划";
      next.append(nextLabel, nextTime);
    }
    cronRow.append(cron, runsBlock, next);

    // 元信息：脚本 + 上次执行
    const meta = document.createElement("div");
    meta.className = "si-meta";
    const scriptNm = document.createElement("span");
    scriptNm.textContent = "脚本：" + (s.script_name || "（已删除）");
    const last = document.createElement("span");
    last.textContent = "上次：" + (s.last_run ? fmtTime(s.last_run) : "尚未执行");
    if (s.last_status) {
      const st = document.createElement("span");
      const ls = s.last_status.toLowerCase();
      let cls = "info";
      if (ls.includes("running")) cls = "run";
      else if (ls.includes("success") || ls.includes("完成")) cls = "succ";
      else if (ls.includes("fail") || ls.includes("error") || ls.includes("terminated") || ls.includes("无效") || ls.includes("不存在")) cls = "fail";
      st.className = "si-last-status " + cls;
      st.textContent = " · " + s.last_status;
      last.appendChild(st);
    }
    meta.append(scriptNm, last);

    // 操作按钮
    const ops = document.createElement("div");
    ops.className = "si-ops";
    const runBtn = document.createElement("button");
    runBtn.className = "btn mini primary";
    runBtn.textContent = "立即运行";
    runBtn.onclick = async () => {
      // 乐观更新：立即显示 running 状态，避免毫秒级脚本 running 一闪而过
      window._schedPatch = window._schedPatch || {};
      window._schedPatch[s.id] = Object.assign(window._schedPatch[s.id] || {}, { last_status: "running" });
      renderSchedules();
      try {
        await api(`/api/schedules/${s.id}/run`, { method: "POST" });
        toast("已触发「" + s.name + "」");
      } catch (e) { toast(e.message, true); }
      // 3 秒后清除补丁，让真实状态（轮询）接管
      setTimeout(() => {
        if (window._schedPatch) delete window._schedPatch[s.id];
        renderSchedules(true);
      }, 3000);
    };
    const editBtn = document.createElement("button");
    editBtn.className = "btn mini ghost";
    editBtn.textContent = "编辑";
    editBtn.onclick = () => scheduleModal(s);
    const delBtn = document.createElement("button");
    delBtn.className = "btn mini danger";
    delBtn.textContent = "删除";
    delBtn.onclick = () => confirmModal({
      title: "删除定时任务",
      message: `确定删除定时任务「${s.name}」吗？`,
      confirmText: "删除",
      onConfirm: async () => {
        await api(`/api/schedules/${s.id}`, { method: "DELETE" });
        toast("已删除");
        renderSchedules();
      },
    });
    ops.append(runBtn, editBtn, delBtn);
    row.append(head, cronRow, meta, ops);
    wrap.appendChild(row);
  }
}

// 下次执行的相对倒计时（精确到分/秒）
function relTime(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "即将执行";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒后`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒后`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时 ${min % 60} 分后`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小时后`;
}

// 卡片常驻输入：cron 表达式（失焦/回车保存，Esc 取消）
function bindCronInline(input, s) {
  let saving = false;
  input.addEventListener("blur", async () => {
    if (saving) return;
    const cron = input.value.trim();
    if (cron === s.cron) return;
    if (!cron) { input.value = s.cron; return toast("cron 不能为空", true); }
    saving = true;
    try {
      await api(`/api/schedules/${s.id}`, { method: "PUT", body: { cron } });
      toast("执行时间已更新");
      renderSchedules();
    } catch (e) {
      input.value = s.cron;
      toast(e.message, true);
      saving = false;
    }
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") input.blur();
    else if (ev.key === "Escape") { input.value = s.cron; input.blur(); }
  });
}

// 卡片常驻输入：执行次数上限（-1 表示不限；失焦/回车保存，Esc 取消）
function bindRunsInline(input, s) {
  let saving = false;
  input.addEventListener("blur", async () => {
    if (saving) return;
    const shown = s.max_runs ? s.max_runs : -1;
    const raw = input.value.trim();
    let maxRuns = null;
    if (raw && raw !== "-1") {
      maxRuns = parseInt(raw, 10);
      if (isNaN(maxRuns) || maxRuns < 1) { input.value = shown; return toast("执行次数需为不小于 1 的整数或 -1（不限）", true); }
    }
    const next = maxRuns === null ? -1 : maxRuns;
    if (next === shown) return;
    saving = true;
    try {
      await api(`/api/schedules/${s.id}`, { method: "PUT", body: { max_runs: maxRuns } });
      if (!s.enabled && s.max_runs && (s.run_count || 0) >= s.max_runs) {
        toast("该任务已达上限停用，重新启用后将从 0 重新计数", true);
      }
      renderSchedules();
    } catch (e) { toast(e.message, true); saving = false; }
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") input.blur();
    else if (ev.key === "Escape") { input.value = s.max_runs ? s.max_runs : -1; input.blur(); }
  });
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch { return iso; }
}

function renderSchedFields(container, schema, saved) {
  container.innerHTML = "";
  if (!schema || !schema.length) {
    container.innerHTML = `<div class="form-empty" style="height:auto;padding:12px">该脚本没有定义命令行参数</div>`;
    return;
  }
  for (const a of schema) {
    const field = document.createElement("div");
    field.className = "field" + (a.is_flag ? " field-switch" : "");
    field.dataset.dest = a.dest;
    const label = document.createElement("div");
    label.className = "f-label";
    const nm = document.createElement("span");
    nm.textContent = a.dest;
    const kind = document.createElement("span");
    kind.className = "f-kind" + (a.required ? " req" : "");
    kind.textContent = a.required ? "必填" : "可选";
    const tl = typeLabelOf(a);
    label.append(nm, kind);
    if (tl) {
      const t = document.createElement("span");
      t.className = "f-type " + tl.cls;
      t.textContent = tl.text;
      label.appendChild(t);
    }
    field.appendChild(label);
    const savedVal = saved ? saved[a.dest] : undefined;
    const defVal = a.default;
    const value = savedVal !== undefined && savedVal !== null ? savedVal : defVal;
    let input;
    if (a.is_flag) {
      const ctrl = document.createElement("div");
      ctrl.className = "f-control";
      const sw = document.createElement("label");
      sw.className = "switch";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!value;
      const slider = document.createElement("span");
      slider.className = "slider";
      sw.append(cb, slider);
      const val = document.createElement("span");
      val.className = "sw-val";
      val.textContent = cb.checked ? "开启" : "关闭";
      cb.addEventListener("change", () => { val.textContent = cb.checked ? "开启" : "关闭"; });
      ctrl.append(sw, val);
      field.appendChild(ctrl);
      input = cb;
    } else if (a.choices && a.choices.length) {
      input = document.createElement("select");
      input.className = "f-input";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = a.required ? "请选择…" : "（不传）";
      input.appendChild(empty);
      for (const c of a.choices) {
        const opt = document.createElement("option");
        opt.value = String(c);
        opt.textContent = String(c);
        input.appendChild(opt);
      }
      input.value = value !== undefined && value !== null ? String(value) : "";
      field.appendChild(input);
    } else {
      input = document.createElement("input");
      input.className = "f-input mono";
      if (a.type === "int" || a.type === "float") {
        input.type = "number";
        if (a.type === "int") input.step = "1";
      } else {
        input.type = "text";
      }
      if (a.nargs || a.action === "append") input.placeholder = "多个值用英文逗号分隔";
      if (value !== undefined && value !== null) input.value = Array.isArray(value) ? value.join(",") : String(value);
      field.appendChild(input);
    }
    container.appendChild(field);
  }
}

function collectSchedFields(container, schema) {
  const values = {};
  for (const a of (schema || [])) {
    const field = container.querySelector(`[data-dest="${CSS.escape(a.dest)}"]`);
    if (!field) continue;
    const el = field.querySelector("input,select");
    if (!el) continue;
    if (a.is_flag) {
      values[a.dest] = el.checked;
      continue;
    }
    let raw = el.value;
    if (raw === "" && !a.required) continue; // 空值且非必填不传
    if (a.nargs || a.action === "append") {
      const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!items.length && a.required) { values[a.dest] = []; continue; }
      if (items.length) values[a.dest] = a.type === "int" ? items.map(Number) : a.type === "float" ? items.map(Number) : items;
      continue;
    }
    if (a.type === "int") values[a.dest] = raw === "" ? null : parseInt(raw, 10);
    else if (a.type === "float") values[a.dest] = raw === "" ? null : parseFloat(raw);
    else values[a.dest] = raw;
  }
  return values;
}

async function scheduleModal(sched) {
  const scripts = await api("/api/scripts").catch(() => []);
  const editing = !!sched;
  const selId = sched ? sched.script_id : (state.script ? state.script.id : (scripts[0] && scripts[0].id));
  let schema = [];
  let presets = [];
  let savedArgs = sched ? (typeof sched.args === "string" ? JSON.parse(sched.args || "{}") : (sched.args || {})) : {};
  if (selId) {
    const rec = await api(`/api/scripts/${selId}`).catch(() => null);
    if (rec) { schema = rec.args_schema || []; presets = rec.presets || []; }
  }
  openModal({
    title: editing ? "编辑定时任务" : "新建定时任务",
    bodyHTML: `
      <div class="m-field">
        <div class="m-label">任务名称</div>
        <input class="f-input" id="sc-name" placeholder="例如：每日备份 / 每 10 分钟巡检" value="${escapeHtml(sched ? sched.name : "")}" autocomplete="off">
      </div>
      <div class="m-field">
        <div class="m-label">执行脚本</div>
        <select class="f-input" id="sc-script">
          ${scripts.map((s) => `<option value="${s.id}" ${s.id === selId ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
        </select>
      </div>
      <div class="m-field">
        <div class="m-label">cron 表达式</div>
        <input class="f-input mono" id="sc-cron" placeholder="分 时 日 月 周，如 */10 * * * *" value="${escapeHtml(sched ? sched.cron : "")}" autocomplete="off">
        <div class="sc-preview" id="sc-preview">输入 cron 后自动显示下次执行时间</div>
      </div>
      <div class="m-field">
        <div class="m-label">执行次数上限（留空表示不限）</div>
        <input type="number" class="f-input" id="sc-max-runs" min="1" placeholder="例如 3：执行满 3 次后自动停用，重新启用时重置" value="${sched && sched.max_runs ? sched.max_runs : ""}" autocomplete="off">
      </div>
      <div class="m-field">
        <div class="m-label">快速选择（无需懂 cron）</div>
        <div class="sc-quick" id="sc-quick">
          <button class="btn mini ghost" data-cron="* * * * *">每分钟</button>
          <button class="btn mini ghost" data-cron="*/5 * * * *">每5分钟</button>
          <button class="btn mini ghost" data-cron="*/10 * * * *">每10分钟</button>
          <button class="btn mini ghost" data-cron="0 * * * *">每小时</button>
          <button class="btn mini ghost" data-cron="0 */2 * * *">每2小时</button>
          <button class="btn mini ghost" data-cron="0 9 * * *">每天9点</button>
          <button class="btn mini ghost" data-cron="0 9 * * 1-5">工作日9点</button>
          <button class="btn mini ghost" data-cron="0 9 * * 0">每周日9点</button>
          <button class="btn mini ghost" data-cron="0 9 1 * *">每月1号9点</button>
        </div>
      </div>
      <div class="m-field">
        <div class="m-label">可视化构建（修改后自动写入 cron）</div>
        <div class="sc-builder">
          <select class="f-input" id="sc-freq">
            <option value="minute">每 N 分钟</option>
            <option value="hour">每 N 小时</option>
            <option value="daily">每天固定时间</option>
            <option value="weekly">每周固定时间</option>
            <option value="monthly">每月固定日期</option>
          </select>
          <div class="sc-builder-opts" id="sc-builder-opts"></div>
        </div>
      </div>
      <div class="m-field">
        <div class="m-label">参数来源</div>
        <select class="f-input" id="sc-preset">
          <option value="">手动填写</option>
          ${presets.map((p) => `<option value="${p.id}" data-args="${escapeHtml(JSON.stringify(p.args || {}))}">预设：${escapeHtml(p.name)}</option>`).join("")}
        </select>
      </div>
      <div class="m-field">
        <div class="m-label">参数</div>
        <div class="sc-fields" id="sc-fields"></div>
      </div>
      <div class="m-field">
        <label class="chk"><input type="checkbox" id="sc-enabled" ${!sched || sched.enabled ? "checked" : ""}> 启用该定时任务</label>
      </div>`,
    footHTML: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="sc-save">${editing ? "保存修改" : "创建"}</button>`,
    onMount: (mask) => {
      $$("[data-close]", mask).forEach((b) => b.addEventListener("click", closeModal));
      const fieldsBox = $("#sc-fields", mask);
      renderSchedFields(fieldsBox, schema, savedArgs);
      const cronInp = $("#sc-cron", mask);
      const preview = $("#sc-preview", mask);
      let previewTimer = null;
      const updatePreview = async () => {
        const cron = cronInp.value.trim();
        if (!cron) { preview.textContent = "输入 cron 后自动显示下次执行时间"; preview.className = "sc-preview"; return; }
        try {
          const r = await api("/api/schedules/preview", { method: "POST", body: { cron } });
          preview.textContent = "下次执行：" + fmtTime(r.next);
          preview.className = "sc-preview ok";
        } catch (e) {
          preview.textContent = e.message;
          preview.className = "sc-preview err";
        }
      };
      cronInp.addEventListener("input", () => {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(updatePreview, 400);
      });

      // 快速预设：点击直接填充 cron
      $$("[data-cron]", $("#sc-quick", mask)).forEach((b) => {
        b.addEventListener("click", () => { cronInp.value = b.dataset.cron; updatePreview(); });
      });

      // 可视化构建器：打开时按现有 cron 回填；控件变化实时写入 cron 输入框
      const freqSel = $("#sc-freq", mask);
      renderBuilderOpts(freqSel.value, mask);
      parseCronToBuilder(cronInp.value.trim(), mask);
      const syncBuilder = () => {
        const c = buildCronFromBuilder(freqSel.value, mask);
        if (c) { cronInp.value = c; updatePreview(); }
        else { toast("请至少选择一个星期", true); }
      };
      freqSel.addEventListener("change", () => {
        renderBuilderOpts(freqSel.value, mask);
        syncBuilder();
      });
      const builderOpts = $("#sc-builder-opts", mask);
      builderOpts.addEventListener("input", syncBuilder);
      builderOpts.addEventListener("change", syncBuilder);

      // 参数来源：选预设后填充参数表单
      const presetSel = $("#sc-preset", mask);
      presetSel.addEventListener("change", () => {
        const opt = presetSel.selectedOptions[0];
        const args = opt && opt.dataset.args ? JSON.parse(opt.dataset.args) : {};
        renderSchedFields(fieldsBox, schema, args);
      });

      const scriptSel = $("#sc-script", mask);
      const reloadScript = async () => {
        const sid = parseInt(scriptSel.value, 10);
        const rec = await api(`/api/scripts/${sid}`).catch(() => null);
        schema = rec ? (rec.args_schema || []) : [];
        presets = rec ? (rec.presets || []) : [];
        presetSel.innerHTML = `<option value="">手动填写</option>` +
          presets.map((p) => `<option value="${p.id}" data-args="${escapeHtml(JSON.stringify(p.args || {}))}">预设：${escapeHtml(p.name)}</option>`).join("");
        renderSchedFields(fieldsBox, schema, {});
      };
      scriptSel.addEventListener("change", reloadScript);

      if (cronInp.value.trim()) updatePreview();
      $("#sc-save", mask).addEventListener("click", async () => {
        const name = $("#sc-name", mask).value.trim();
        const cron = cronInp.value.trim();
        const enabled = $("#sc-enabled", mask).checked;
        if (!name) return toast("请输入任务名称", true);
        if (!cron) return toast("请输入 cron 表达式", true);
        const maxRunsRaw = $("#sc-max-runs", mask).value.trim();
        let maxRuns = null;
        if (maxRunsRaw) {
          maxRuns = parseInt(maxRunsRaw, 10);
          if (isNaN(maxRuns) || maxRuns < 1) return toast("执行次数需为不小于 1 的整数", true);
        }
        const args = collectSchedFields(fieldsBox, schema);
        const body = { name, cron, enabled, args, max_runs: maxRuns };
        if (editing) {
          await api(`/api/schedules/${sched.id}`, { method: "PUT", body: { name, cron, enabled, args, max_runs: maxRuns } });
          toast("已保存修改");
        } else {
          await api("/api/schedules", { method: "POST", body: { ...body, script_id: parseInt(scriptSel.value, 10) } });
          toast("定时任务已创建");
        }
        closeModal();
        renderSchedules();
      });
    },
  });
}

// 可视化 cron 构建器：渲染频率对应的控件
function renderBuilderOpts(freq, mask) {
  const el = $("#sc-builder-opts", mask);
  const week = ["一", "二", "三", "四", "五", "六", "日"]; // 值 1..6,0
  const timeInp = `<input type="time" class="f-input sc-time" id="sc-time" value="09:00">`;
  if (freq === "minute") {
    el.innerHTML = `每 <input type="number" class="f-input sc-num" id="sc-n" min="1" max="59" value="5"> 分钟执行一次`;
  } else if (freq === "hour") {
    el.innerHTML = `每 <input type="number" class="f-input sc-num" id="sc-nh" min="1" max="23" value="1"> 小时，在第 <input type="number" class="f-input sc-num" id="sc-mh" min="0" max="59" value="0"> 分执行`;
  } else if (freq === "daily") {
    el.innerHTML = `每天 <input type="time" class="f-input sc-time" id="sc-time" value="09:00"> 执行`;
  } else if (freq === "weekly") {
    el.innerHTML = `每周 ${timeInp} 执行，选择星期：` +
      week.map((d, i) => `<label class="chk sc-wd"><input type="checkbox" id="sc-wd${i}" value="${i === 6 ? 0 : i + 1}">${d}</label>`).join("") +
      `<div class="sc-hint">周一至周六选中的天执行；周日对应 cron 的 0</div>`;
  } else if (freq === "monthly") {
    el.innerHTML = `每月第 <input type="number" class="f-input sc-num" id="sc-md" min="1" max="31" value="1"> 号，${timeInp} 执行`;
  }
}

// 根据可视化选择生成 cron 表达式
function buildCronFromBuilder(freq, mask) {
  const get = (id) => $("#" + id, mask).value;
  const num = (id, d) => parseInt(get(id), 10) || d;
  if (freq === "minute") {
    return `*/${Math.min(59, Math.max(1, num("sc-n", 5)))} * * * *`;
  }
  if (freq === "hour") {
    const h = Math.min(23, Math.max(1, num("sc-nh", 1)));
    const m = Math.min(59, Math.max(0, num("sc-mh", 0)));
    return `${m} */${h} * * *`;
  }
  if (freq === "daily") {
    const [h, m] = (get("sc-time") || "09:00").split(":").map(Number);
    return `${m} ${h} * * *`;
  }
  if (freq === "weekly") {
    const [h, m] = (get("sc-time") || "09:00").split(":").map(Number);
    const dow = [];
    for (let i = 0; i < 7; i++) if ($("#sc-wd" + i, mask).checked) dow.push(i === 6 ? 0 : i + 1);
    if (!dow.length) return null;
    return `${m} ${h} * * ${dow.join(",")}`;
  }
  if (freq === "monthly") {
    const [h, m] = (get("sc-time") || "09:00").split(":").map(Number);
    const d = Math.min(31, Math.max(1, num("sc-md", 1)));
    return `${m} ${h} ${d} * *`;
  }
  return null;
}

// 把已有 cron 表达式解析回填到可视化构建器（编辑时让修改立即可见）
function parseCronToBuilder(cron, mask) {
  if (!cron) return;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return;
  const [mi, ho, dom, mon, dow] = parts;
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(ho)}:${pad(mi)}`;
  const freq = $("#sc-freq", mask);
  const render = (f) => { freq.value = f; renderBuilderOpts(f, mask); };
  if (mi.startsWith("*/") && ho === "*" && dom === "*" && mon === "*" && dow === "*") {
    render("minute"); $("#sc-n", mask).value = mi.slice(2);
  } else if (ho.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    render("hour"); $("#sc-nh", mask).value = ho.slice(2); $("#sc-mh", mask).value = mi;
  } else if (dom === "*" && mon === "*" && dow === "*") {
    render("daily"); $("#sc-time", mask).value = time;
  } else if (dom === "*" && mon === "*") {
    render("weekly"); $("#sc-time", mask).value = time;
    const days = dow.split(",").map((x) => x.trim());
    for (let i = 0; i < 7; i++) {
      const v = i === 6 ? 0 : i + 1;
      $("#sc-wd" + i, mask).checked = days.includes(String(v));
    }
  } else if (mon === "*" && dow === "*") {
    render("monthly"); $("#sc-md", mask).value = dom; $("#sc-time", mask).value = time;
  }
}

$("#btn-new-schedule").addEventListener("click", () => scheduleModal(null));

/* ================= Tab ================= */

function moveTabPill() {
  const pill = $("#tab-pill");
  const active = document.querySelector(".tab.active");
  if (!pill || !active) return;
  pill.style.width = active.offsetWidth + "px";
  pill.style.transform = "translateX(" + active.offsetLeft + "px)";
}
function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  moveTabPill();
  $("#console-wrap").style.display = name === "console" ? "" : "none";
  $("#history-wrap").style.display = name === "history" ? "" : "none";
  $("#schedule-wrap").style.display = name === "schedules" ? "" : "none";
  if (name === "schedules") {
    renderSchedules();
    // 定时任务页自动刷新：执行中状态(running/success)与下次执行时间实时更新
    if (!window._schedRefreshTimer) {
      window._schedRefreshTimer = setInterval(() => renderSchedules(true), 3000);
    }
  } else if (window._schedRefreshTimer) {
    clearInterval(window._schedRefreshTimer);
    window._schedRefreshTimer = null;
  }
  applyRunState(); // 切 tab 后按 state 恢复运行按钮状态（呼吸灯/禁用）
}
document.addEventListener("click", (e) => {
  // 点击 popover 外部区域时关闭
  if (state.popoverScriptId && !e.target.closest("#running-popover") && !e.target.closest(".sc-running")) {
    closeRunningPopover();
  }
  const t = e.target.closest(".tab");
  if (!t) return;
  switchTab(t.dataset.tab);
  if (t.dataset.tab === "history") refreshHistory();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.popoverScriptId) closeRunningPopover();
});

/* ================= 导出 / 导入（版本迁移） ================= */

async function exportData() {
  try {
    const data = await api("/api/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tool-launcher-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("已导出 " + data.scripts.length + " 个脚本配置");
  } catch (e) {
    toast("导出失败：" + e.message, true);
  }
}

async function importConfig(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.scripts)) throw new Error("不是有效的启动器导出文件");
    const r = await api("/api/import", { method: "POST", body: { data } });
    toast(`导入完成：新增 ${r.imported}、更新 ${r.updated}${r.skipped.length ? `、跳过 ${r.skipped.length}` : ""}`);
    await loadScripts();
    return true;
  } catch (e) {
    toast("导入失败：" + e.message, true);
    return false;
  }
}

/* ================= 事件绑定 ================= */

$("#btn-add").addEventListener("click", openAddModal);
$("#btn-tag-clear").addEventListener("click", () => {
  state.selectedTags.clear();
  renderTagFilter();
  renderScriptList();
});
$("#script-search").addEventListener("input", renderScriptList);
$("#history-search").addEventListener("input", refreshHistory);
$("#btn-run").addEventListener("click", run);
$("#btn-history-scope").addEventListener("click", () => {
  historyScope = historyScope === "script" ? "all" : "script";
  $("#btn-history-scope").textContent = historyScope === "script" ? "当前脚本" : "全部";
  $("#btn-history-scope").classList.toggle("active", historyScope === "all");
  refreshHistory();
  savePrefs();
});
$("#btn-history-multi").addEventListener("click", () => {
  if (historyMulti) exitHistoryMulti();
  else enterHistoryMulti();
});
$("#hm-select-all").addEventListener("click", toggleSelectAll);
$("#hm-delete").addEventListener("click", deleteSelectedHistory);
$("#btn-clear-history").addEventListener("click", () => {
  confirmModal({
    title: "清空全部执行记录",
    message: "确定清空全部执行记录吗？此操作不可恢复。",
    confirmText: "清空",
    onConfirm: async () => {
      const r = await api("/api/executions/clear", { method: "POST", body: {} });
      toast("已清空 " + r.deleted + " 条记录");
      refreshHistory();
    },
  });
});
$("#btn-usage").addEventListener("click", () => {
  window.open("/static/usage.html?v=1", "_blank", "noopener");
});
// ---------- 局域网访问开关 ----------
const lanSwitch = $("#btn-lan");
function applyLanState(lan) {
  lanSwitch.setAttribute("aria-checked", lan ? "true" : "false");
  lanSwitch.title = lan ? "已开启：允许局域网访问，点击关闭" : "已关闭：仅本机访问，点击开启";
}
async function loadLanState() {
  try {
    const r = await fetch("/api/host");
    const d = await r.json();
    applyLanState(!!d.lan);
  } catch (e) { /* 服务未就绪时保持默认 */ }
}
lanSwitch.addEventListener("click", async () => {
  const next = lanSwitch.getAttribute("aria-checked") !== "true";
  lanSwitch.disabled = true;
  try {
    const r = await fetch("/api/host", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lan: next }),
    });
    const d = await r.json();
    toast(next ? "已开启局域网访问，正在重启服务…" : "已关闭局域网访问（仅本机），正在重启服务…");
    // 轮询等待服务重启完成后整页刷新
    const t0 = Date.now();
    (function poll() {
      fetch("/api/health", { cache: "no-store" })
        .then((x) => (x.ok ? location.replace(location.pathname + "?t=" + Date.now()) : retry()))
        .catch(retry);
      function retry() {
        if (Date.now() - t0 > 15000) { lanSwitch.disabled = false; toast("服务重启超时，请手动刷新", true); return; }
        setTimeout(poll, 800);
      }
    })();
  } catch (e) {
    lanSwitch.disabled = false;
    toast("切换失败：请检查服务状态", true);
  }
});
loadLanState();
$("#btn-export").addEventListener("click", exportData);
$("#btn-import-config").addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async (e) => {
    const f = e.target.files[0];
    if (f) await importConfig(f);
    input.remove();
  };
  input.click();
});

/* ================= uv 检测 ================= */

async function checkUv() {
  try {
    const r = await api("/api/system/uv");
    state.uvOk = r.ok;
    if (!r.ok) {
      state.uvHint = r.install_hint || {};
      setTimeout(() => {
        const seen = sessionStorage.getItem("uv_notice");
        if (!seen) {
          showUvInstall();
          sessionStorage.setItem("uv_notice", "1");
        }
      }, 600);
    } else {
      state.uvHint = null;
    }
  } catch {
    state.uvOk = null;
  }
}

/* ================= 三栏拖拽调宽（可伸缩布局） ================= */

const COLS_KEY = "launcher_cols";
let colWidths = { sidebar: 264, panel: null }; // panel: null = 百分比模式

function loadColWidths() {
  try {
    const c = JSON.parse(localStorage.getItem(COLS_KEY) || "{}");
    if (typeof c.sidebar === "number" && c.sidebar >= 200 && c.sidebar <= 380) colWidths.sidebar = c.sidebar;
    if (typeof c.panel === "number" && c.panel >= 400 && c.panel <= 700) colWidths.panel = c.panel;
  } catch {}
}
function saveColWidths() {
  try { localStorage.setItem(COLS_KEY, JSON.stringify(colWidths)); } catch {}
}
function applyColWidths() {
  const sb = $(".sidebar");
  const pn = $(".panel");
  if (sb) sb.style.width = colWidths.sidebar + "px";
  if (pn && colWidths.panel) {
    pn.style.width = colWidths.panel + "px";
    pn.style.flex = "0 0 auto";
  } else if (pn) {
    pn.style.width = "42%";
    pn.style.flex = "";
  }
}

function setupResize() {
  loadColWidths();
  applyColWidths();
  $$(".resize-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const target = handle.dataset.target;
      handle.classList.add("dragging");
      const startX = e.clientX;
      const sb = $(".sidebar");
      const pn = $(".panel");
      const startSb = sb.getBoundingClientRect().width;
      const startPn = pn.getBoundingClientRect().width;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (target === "sidebar") {
          const w = Math.min(380, Math.max(200, startSb + dx));
          sb.style.width = w + "px";
          colWidths.sidebar = w;
        } else {
          const w = Math.min(700, Math.max(400, startPn - dx));
          pn.style.width = w + "px";
          pn.style.flex = "0 0 auto";
          colWidths.panel = w;
        }
      };
      const up = () => {
        handle.classList.remove("dragging");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        saveColWidths();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  });
}

/* ================= 初始化 ================= */

async function init() {
  applyPrefs(); // 恢复上次的 UI 偏好（标签过滤 / 开关等）
  setupResize(); // 三栏可拖拽调宽
  moveTabPill(); // 初始化 tab 胶囊位置
  window.addEventListener("resize", () => moveTabPill());
  await checkUv();
  try {
    await loadScripts();
  } catch (e) {
    // 服务器可能刚重启（旧页面请求失败）：自动刷新一次，最多 2 次避免死循环
    const reloadKey = "launcher_auto_reload";
    const n = Number(sessionStorage.getItem(reloadKey) || 0);
    if (n < 2) {
      sessionStorage.setItem(reloadKey, String(n + 1));
      toast("连接服务失败，正在自动刷新…", true);
      setTimeout(() => location.reload(), 1000);
      return;
    }
    sessionStorage.removeItem(reloadKey);
    toast("无法连接服务，请确认已双击 start.command 启动程序", true);
  }
  updatePageBadge();
  refreshHistory(); // 默认展示执行记录（不依赖点击）
  refreshRunningExecs();
  // 运行任务数 / 徽章 / popover 实时轮询（独立于定时任务页轮询，常驻）
  if (!window._runningTimer) window._runningTimer = setInterval(refreshRunningExecs, 3000);
  const last = localStorage.getItem("last_script_id");
  if (last && state.scripts.some((s) => String(s.id) === last)) {
    selectScript(Number(last));
  }
}

// 记住最后选中的脚本
const origSelect = selectScript;
selectScript = async function (id) {
  localStorage.setItem("last_script_id", String(id));
  return origSelect(id);
};

init();
