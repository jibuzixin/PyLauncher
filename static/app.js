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

let toastTimer = null;
function toast(msg, isErr = false) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
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

function openModal({ title, bodyHTML, footHTML, onMount } = {}) {
  const mask = $("#modal");
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHTML || "";
  $("#modal-foot").innerHTML = footHTML || "";
  mask.hidden = false;
  if (onMount) onMount(mask);
}
function closeModal() { $("#modal").hidden = true; }
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

/** 删除等危险操作的二次确认弹窗（保留：弹窗内辅助确认场景） */
function confirmModal({ title = "确认操作", message, confirmText = "删除", onConfirm } = {}) {
  openModal({
    title,
    bodyHTML: `<div class="result-tip err" style="margin-bottom:0">${escapeHtml(message)}</div>`,
    footHTML: `<button class="btn ghost" data-close>取消</button><button class="btn danger primary" id="confirm-ok">${confirmText}</button>`,
    onMount: (mask) => {
      $$("[data-close]", mask).forEach((b) => b.addEventListener("click", closeModal));
      $("#confirm-ok", mask).addEventListener("click", async () => {
        closeModal();
        try { await onConfirm(); } catch (e) { toast(e.message, true); }
      });
    },
  });
}

/**
 * 双态确认（无弹窗打断）：
 * 第一次点击 → 进入警告态（onArm 视觉，3s 窗口）；窗口内再次点击 → 执行 onConfirm；
 * 3s 超时或点击页面其他区域 → 恢复常态（onDisarm）。
 * 状态与计时器挂在元素属性上，避免重渲染干扰。
 */
function twoStep(el, { onArm, onDisarm, onConfirm, timeout = 3000 } = {}) {
  const armed = () => !!el.__tsArmed;
  const disarm = () => {
    if (!el.__tsArmed) return;
    el.__tsArmed = false;
    clearTimeout(el.__tsTimer);
    if (onDisarm) onDisarm();
  };
  el.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (armed()) {
      disarm();
      try { await onConfirm(ev); } catch (e) { toast(e.message, true); }
      return;
    }
    el.__tsArmed = true;
    if (onArm) onArm();
    el.__tsTimer = setTimeout(disarm, timeout);
  });
  document.addEventListener("click", (ev) => {
    if (armed() && !el.contains(ev.target)) disarm();
  }, true);
  return { disarm };
}

/* ================= 顶部：导入 / 扫描 ================= */

function openAddModal() {
  const lastDir = localStorage.getItem("last_scan_dir") || "";
  openModal({
    title: "导入 / 扫描脚本",
    bodyHTML: `
      <div class="m-field">
        <div class="m-radio">
          <label><input type="radio" name="add-mode" value="scan" checked> 扫描目录</label>
          <label><input type="radio" name="add-mode" value="file"> 导入单个脚本</label>
        </div>
        <div class="m-hint">扫描模式递归查找并自动导入；导入模式可填路径或选择本地 .py 文件</div>
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
  const nargs = (JSON.parse(s.args_schema || "[]")).length;
  const row1 = document.createElement("div");
  row1.className = "sc-name";
  const nm = document.createElement("span");
  nm.textContent = s.name;
  const badge = document.createElement("span");
  badge.className = "sc-arg";
  badge.textContent = nargs + " 参数";
  row1.append(nm, badge);
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
  nameEl.onclick = () => editScriptMeta(rec);

  const descEl = $("#script-desc");
  descEl.textContent = rec.description || "（无描述，点击添加）";
  descEl.className = "script-desc" + (rec.description ? "" : " empty");
  descEl.onclick = () => editScriptMeta(rec);

  const p = $("#script-path");
  p.textContent = rec.path;
  p.title = rec.path;
  $("#btn-open-dir").onclick = () => openScriptDir(rec.path);
  $("#btn-copy-path").onclick = async () => {
    if (await copyText(rec.path)) toast("路径已复制");
  };
  $("#btn-reload").onclick = reloadScript;
  twoStep($("#btn-delete-script"), {
    onArm() {
      const b = $("#btn-delete-script");
      b.classList.add("ts-armed-danger");
      const span = b.querySelector("span");
      if (span) span.textContent = "再次点击删除";
    },
    onDisarm() {
      const b = $("#btn-delete-script");
      b.classList.remove("ts-armed-danger");
      const span = b.querySelector("span");
      if (span) span.textContent = "删除";
    },
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
      $("#meta-name", mask).focus();
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
  const parts = [];
  if (!state.uvOk) {
    const span = document.createElement("span");
    span.innerHTML = '<span class="dot err"></span><span class="env-text err">未检测到 uv</span>';
    parts.push(span);
    const b = document.createElement("button");
    b.className = "btn mini primary";
    b.textContent = "查看安装指引";
    b.onclick = showUvInstall;
    parts.push(b);
  } else {
    const vSpan = document.createElement("span");
    vSpan.innerHTML = `<span class="dot ok"></span><span class="env-text ok">uv ${escapeHtml(env.uv_version || "")}</span>`;
    parts.push(vSpan);
  }

  const venvSpan = document.createElement("span");
  if (env.has_inline_meta) {
    const depsN = (env.inline_deps || []).length;
    venvSpan.innerHTML = `<span class="dot ok"></span><span class="env-text ok">PEP 723 内联脚本${depsN ? " · 内联依赖 " + depsN + " 个" : ""}</span>`;
    venvSpan.title = "uv 自动创建临时环境并安装内联依赖，无需初始化";
  } else if (env.has_venv) {
    venvSpan.innerHTML = '<span class="dot ok"></span><span class="env-text ok">venv 已就绪</span>';
  } else {
    venvSpan.innerHTML = '<span class="dot warn"></span><span class="env-text warn">未初始化虚拟环境</span>';
    const initBtn = document.createElement("button");
    initBtn.className = "btn mini primary";
    initBtn.textContent = env.has_deps ? "初始化环境（含依赖）" : "初始化环境";
    initBtn.onclick = () => initEnv();
    parts.push(initBtn);
  }
  parts.push(venvSpan);

  if (env.has_deps) {
    const r = document.createElement("span");
    r.innerHTML = `<span class="dot ok"></span><span class="env-text ok">${escapeHtml(env.deps_name || "")}</span>`;
    r.title = env.requirements_path || "";
    parts.push(r);
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
  bar.append(...parts, depRow);
}

/** 用自定义依赖文件路径安装依赖（留空则自动检测脚本目录 requirements.txt） */
async function initEnvDeps(depsPath) {
  if (!state.script) return;
  if (depsPath && depsPath !== state.script.deps_path) {
    await api(`/api/scripts/${state.script.id}`, { method: "PUT", body: { deps_path: depsPath } });
    state.script.deps_path = depsPath;
  }
  switchTab("console");
  clearConsole();
  const installBtn = $("#env-bar .env-deps .btn.primary");
  if (installBtn) { installBtn.disabled = true; installBtn.innerHTML = '<span class="spinner" style="display:inline-block"></span> 安装中…'; }
  try {
    const res = await api(`/api/scripts/${state.script.id}/env/init`, {
      method: "POST",
      body: { deps_path: depsPath || null },
    });
    await connectWs(`/ws/env/${res.session_id}`, { envInit: true, scriptId: state.script.id });
  } catch (e) {
    toast("安装失败：" + e.message, true);
  }
  if (installBtn) { installBtn.disabled = false; installBtn.textContent = "安装依赖"; }
}

function showUvInstall() {
  const hint = state.uvHint || {};
  const entries = [];
  if (hint.mac) entries.push(["macOS", hint.mac]);
  if (hint.win) entries.push(["Windows (PowerShell)", hint.win]);
  if (hint.linux) entries.push(["Linux", hint.linux]);
  openModal({
    title: "需要安装 uv",
    bodyHTML: `
      <div class="result-tip err" style="margin-bottom:12px">未检测到 uv。uv 是脚本启动器运行依赖的环境管理器，请先安装：</div>
      <div class="uv-install">
        ${entries.map(([os, cmd]) => `
          <div>
            <div class="m-label" style="margin-bottom:4px">${os}</div>
            <div class="cmd">${escapeHtml(cmd)}<button class="copy-mini" data-copy="${escapeHtml(cmd)}">复制</button></div>
          </div>`).join("")}
      </div>
    `,
    footHTML: `<button class="btn ghost" id="uv-later">稍后</button><button class="btn primary" id="uv-retry">我已安装，重新检测</button>`,
    onMount: (mask) => {
      $("#uv-later", mask).addEventListener("click", closeModal);
      $("#uv-retry", mask).addEventListener("click", async () => {
        await checkUv();
        closeModal();
        if (state.uvOk && state.script) {
          const env = await api(`/api/scripts/${state.script.id}/env`);
          renderEnvBar(env);
        }
      });
      $$(".copy-mini", mask).forEach((b) => b.addEventListener("click", async () => {
        if (await copyText(b.dataset.copy)) toast("已复制安装命令");
      }));
    },
  });
}

async function initEnv() {
  if (!state.script) return;
  const btn = $("#env-bar .btn.primary");
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="display:inline-block"></span> 初始化中…'; }
  switchTab("console");
  clearConsole();
  try {
    const res = await api(`/api/scripts/${state.script.id}/env/init`, { method: "POST" });
    await connectWs(`/ws/env/${res.session_id}`, { envInit: true, scriptId: state.script.id });
  } catch (e) {
    toast("初始化失败：" + e.message, true);
  }
}

/* ================= 预设 ================= */

function renderPresets(presets) {
  const bar = $("#preset-bar");
  bar.innerHTML = "";
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "预设";
  const chips = document.createElement("div");
  chips.className = "preset-chips";
  for (const p of presets) {
    const chip = document.createElement("span");
    chip.className = "preset-chip";
    chip.textContent = p.name;
    chip.title = "点击应用此预设";
    chip.onclick = () => applyPreset(p);
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.title = "删除预设（连点两次）";
    twoStep(x, {
      onArm() {
        const chip = x.closest(".preset-chip");
        if (!chip) return;
        chip.dataset.origName = p.name;
        chip.classList.add("ts-armed-danger");
        chip.innerHTML = `${escapeHtml(p.name)} · 再次点击删除`;
      },
      onDisarm() {
        const chip = x.closest(".preset-chip");
        if (!chip) return;
        chip.classList.remove("ts-armed-danger");
        chip.textContent = chip.dataset.origName || p.name;
        chip.appendChild(x);
        x.style.display = "";
      },
      onConfirm: async () => {
        await api(`/api/presets/${p.id}`, { method: "DELETE" });
        toast("预设已删除");
        reloadDetail();
      },
    });
    chip.appendChild(x);
    chips.appendChild(chip);
  }
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn mini ghost";
  saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>';
  saveBtn.appendChild(document.createTextNode(" 保存当前为预设"));
  saveBtn.onclick = saveAsPreset;
  bar.append(lbl, chips, saveBtn);
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
        <div class="preset-overwrite-tip" id="preset-overwrite-tip" hidden></div>
      </div>`,
    footHTML: `<button class="btn ghost" data-close>取消</button><button class="btn primary" id="preset-save">保存为新预设</button>`,
    onMount: (mask) => {
      $$("[data-close]", mask).forEach((b) => b.addEventListener("click", closeModal));
      const chips = $("#preset-overwrite-chips", mask);
      const tip = $("#preset-overwrite-tip", mask);
      for (const p of presets) {
        const chip = document.createElement("span");
        chip.className = "preset-chip";
        chip.textContent = p.name;
        chip.title = "第一次点击进入覆盖确认，再次点击同一标签完成覆盖";
        twoStep(chip, {
          onArm() {
            $$(".preset-chip", chips).forEach((c) => c.classList.remove("cover-target"));
            chip.classList.add("cover-target");
            tip.hidden = false;
            tip.textContent = `⚠ 再次点击「${p.name}」将覆盖该预设`;
          },
          onDisarm() {
            chip.classList.remove("cover-target");
            tip.hidden = true;
          },
          onConfirm: async () => {
            await api(`/api/scripts/${state.script.id}/presets`, { method: "POST", body: { name: p.name, args: values } });
            toast(`已覆盖预设「${p.name}」`);
            closeModal();
            reloadDetail();
          },
        });
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
  // 运行状态切换时重置终止按钮的双态（防止残留警告态）
  const tb = $("#btn-terminate");
  if (tb.__tsArmed) {
    tb.__tsArmed = false;
    clearTimeout(tb.__tsTimer);
    tb.classList.remove("ts-armed-warn");
    tb.textContent = "终止";
  }
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

function buildCommandText() {
  const s = state.script;
  if (!s || !s.path) return "";
  const argList = buildArgList(s.args_schema || [], collectValues());
  if (s.has_inline_meta) {
    // PEP 723 内联脚本：uv run --script <path> <args...>
    const parts = ["uv", "run", "--script", shq(s.path)];
    for (const a of argList) parts.push(shq(a));
    return parts.join(" ");
  }
  const idx = s.path.lastIndexOf("/");
  const dir = idx >= 0 ? s.path.slice(0, idx) : s.path;
  const file = idx >= 0 ? s.path.slice(idx + 1) : s.path;
  const parts = ["uv", "run", "--project", shq(dir), "python", shq(file)];
  for (const a of argList) parts.push(shq(a));
  return parts.join(" ");
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
    const res = await api("/api/execute", {
      method: "POST",
      body: { script_id: state.script.id, args: values, preset_id: state.activePresetId },
    });
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
   - ANSI SGR 颜色码渲染为彩色文本 */

function clearConsole() {
  $("#console").innerHTML = "";
  $("#console-placeholder").style.display = "flex";
  state.lineCount = 0;
  termState.buf = "";
  termState.cur = null;
  termState.crPending = false;
}

const termState = { buf: "", cur: null, crPending: false, streamCls: "" };

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

function autoscrollConsole() {
  if ($("#opt-autoscroll").checked) {
    $("#console-wrap").scrollTop = $("#console-wrap").scrollHeight;
  }
}

function ensureTermLine() {
  if (termState.cur) return;
  const lineNo = state.lineCount + 1;
  const line = document.createElement("div");
  line.className = "console-line" + (termState.streamCls ? " " + termState.streamCls : "");
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
  $("#console").appendChild(line);
  state.lineCount++;
  termState.cur = line;
  // 控制控制台体量：最多保留 5000 行
  const consoleEl = $("#console");
  while (consoleEl.children.length > 5000) consoleEl.removeChild(consoleEl.firstChild);
}

function updateTermLine() {
  if (!termState.buf && !termState.cur) return;
  ensureTermLine();
  termState.cur.querySelector(".line-text").innerHTML = ansiToHtml(termState.buf);
  autoscrollConsole();
}

function flushTermLine() {
  ensureTermLine();
  termState.cur.querySelector(".line-text").innerHTML = ansiToHtml(termState.buf);
  termState.cur = null;
  termState.buf = "";
  autoscrollConsole();
}

function appendStream(stream, chunk) {
  $("#console-placeholder").style.display = "none";
  termState.streamCls = stream === "info" ? "info" : stream === "stderr" ? "stderr" : "";
  let i = 0;
  const len = chunk.length;
  while (i < len) {
    const ch = chunk[i];
    // 上一个块以 \r 结尾：先结算（下个字符决定是覆盖还是换行）
    if (termState.crPending) {
      termState.crPending = false;
      if (ch === "\n") { flushTermLine(); i++; continue; }
      termState.buf = ""; // \r 覆盖当前行
    }
    if (ch === "\r") {
      if (i + 1 < len) {
        if (chunk[i + 1] === "\n") { flushTermLine(); i += 2; continue; }
        termState.buf = ""; // 单行进度条刷新
        i++;
        continue;
      }
      termState.crPending = true;
      i++;
      continue;
    }
    if (ch === "\n") { flushTermLine(); i++; continue; }
    termState.buf += ch;
    i++;
  }
  // 块尾统一刷新当前行（进度条实时可见；\r 结尾时留待下块决定）
  if (termState.buf && !termState.crPending) updateTermLine();
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

twoStep($("#btn-terminate"), {
  onArm() {
    const b = $("#btn-terminate");
    b.classList.add("ts-armed-warn");
    b.textContent = "再次点击终止";
  },
  onDisarm() {
    const b = $("#btn-terminate");
    b.classList.remove("ts-armed-warn");
    b.textContent = "终止";
  },
  onConfirm: async () => {
    if (!state.currentExecId) return;
    try {
      await api(`/api/executions/${state.currentExecId}/terminate`, { method: "POST" });
      toast("已发送终止信号");
    } catch (e) {
      toast(e.message, true);
    }
  },
});

/* ================= 控制台工具 ================= */

$("#btn-copy-command").addEventListener("click", async () => {
  if (!state.script) return toast("请先选择一个脚本", true);
  const cmd = buildCommandText();
  if (!cmd) return toast("当前无脚本可复制", true);
  if (await copyText(cmd)) toast("已复制 uv run 命令");
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
    return (h.script_name || "").toLowerCase().includes(kw) ||
      h.status.includes(kw) ||
      tags.toLowerCase().includes(kw);
  });
  if (filtered.length === 0) {
    const hint = historyScope === "script" && state.selectedId
      ? `当前选中的「${state.script ? state.script.name : ""}」暂无执行记录，可点上方「全部」查看所有脚本的记录`
      : "暂无执行记录：运行脚本后，每次执行都会自动记录到这里";
    wrap.innerHTML = `<div class="sidebar-empty" style="padding:20px">${escapeHtml(hint)}</div>`;
    return;
  }
  for (const h of filtered) {
    const item = document.createElement("div");
    item.className = "hist-item";
    const top = document.createElement("div");
    top.className = "hi-top";
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
    item.onclick = () => showHistoryDetail(h.id, item);
    wrap.appendChild(item);
  }
}

function summarizeArgs(argsStr) {
  try {
    const a = JSON.parse(argsStr || "{}");
    const kv = Object.entries(a).filter(([, v]) => v !== "" && v !== null && v !== undefined);
    if (kv.length === 0) return "（无参数）";
    return kv.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join("  ");
  } catch { return ""; }
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function showHistoryDetail(id, itemEl) {
  $$(".hist-item").forEach((el) => el.classList.remove("active"));
  if (itemEl) itemEl.classList.add("active");
  const rec = await api(`/api/executions/${id}`);
  const detail = $("#history-detail");
  detail.hidden = false;
  detail.innerHTML = "";

  const head = document.createElement("div");
  head.className = "hd-head";
  const info = document.createElement("span");
  info.style.cssText = "font-size:12.5px;font-weight:600";
  info.textContent = `${rec.script_name || "脚本"} · ${formatTime(rec.started_at)} · 退出码 ${rec.exit_code ?? "-"}`;
  const rerun = document.createElement("button");
  rerun.className = "btn mini primary";
  rerun.textContent = "↻ 用此参数重跑";
  rerun.onclick = () => rerunExecution(rec);
  const del = document.createElement("button");
  del.className = "btn mini danger";
  del.textContent = "删除";
  del.title = "连点两次删除";
  twoStep(del, {
    onArm() { del.classList.add("ts-armed-danger"); del.textContent = "再次点击删除"; },
    onDisarm() { del.classList.remove("ts-armed-danger"); del.textContent = "删除"; },
    onConfirm: async () => {
      await api(`/api/executions/${rec.id}`, { method: "DELETE" });
      detail.hidden = true;
      refreshHistory();
    },
  });
  head.append(info, rerun, del);

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

  const out = document.createElement("div");
  out.className = "hd-output";
  out.innerHTML = rec.output ? ansiToHtml(rec.output) : "（无输出）";
  const truncated = document.createElement("div");
  truncated.className = "hd-truncated";
  truncated.textContent = "· 仅保留程序结束后最后 1000 行输出";

  detail.append(head, tagsRow, out, truncated);
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
  let list;
  try {
    list = await api("/api/schedules");
  } catch (e) {
    if (!silent) wrap.innerHTML = `<div class="schedule-empty">加载定时任务失败：${escapeHtml(e.message)}</div>`;
    return;
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

    // cron 表达式 + 下次执行
    const cronRow = document.createElement("div");
    cronRow.className = "si-cron-row";
    const cron = document.createElement("input");
    cron.className = "f-input mono si-cron-in";
    cron.value = s.cron;
    cron.title = "编辑 cron 表达式：失焦或回车保存，Esc 取消";
    cron.spellcheck = false;
    bindCronInline(cron, s);
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
    cronRow.append(cron, next);

    // 元信息：脚本 + 上次执行
    const meta = document.createElement("div");
    meta.className = "si-meta";
    const scriptNm = document.createElement("span");
    scriptNm.textContent = "脚本：" + (s.script_name || "（已删除）");
    const runsLabel = document.createElement("span");
    runsLabel.className = "si-meta-label";
    runsLabel.textContent = "次数：";
    const cnt = document.createElement("input");
    cnt.type = "number";
    cnt.className = "si-runs-in";
    cnt.min = -1;
    cnt.value = s.max_runs ? s.max_runs : -1;
    cnt.title = "执行次数上限，-1 表示不限；失焦或回车保存，Esc 取消";
    if (s.max_runs) cnt.style.color = "#2e7d32";
    bindRunsInline(cnt, s);
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
    meta.append(scriptNm, runsLabel, cnt, last);

    // 操作按钮
    const ops = document.createElement("div");
    ops.className = "si-ops";
    const runBtn = document.createElement("button");
    runBtn.className = "btn mini primary";
    runBtn.textContent = "立即运行";
    runBtn.onclick = async () => {
      try {
        await api(`/api/schedules/${s.id}/run`, { method: "POST" });
        toast("已触发「" + s.name + "」");
        renderSchedules();
      } catch (e) { toast(e.message, true); }
    };
    const editBtn = document.createElement("button");
    editBtn.className = "btn mini ghost";
    editBtn.textContent = "编辑";
    editBtn.onclick = () => scheduleModal(s);
    const delBtn = document.createElement("button");
    delBtn.className = "btn mini danger";
    delBtn.textContent = "删除";
    delBtn.title = "连点两次删除";
    twoStep(delBtn, {
      onArm() {
        row.classList.add("ts-armed-danger");
        const prog = document.createElement("div");
        prog.className = "ts-progress";
        row.appendChild(prog);
        row.__prog = prog;
        delBtn.classList.add("ts-armed-danger");
        delBtn.textContent = "再次点击删除";
      },
      onDisarm() {
        row.classList.remove("ts-armed-danger");
        if (row.__prog) { row.__prog.remove(); row.__prog = null; }
        delBtn.classList.remove("ts-armed-danger");
        delBtn.textContent = "删除";
      },
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

function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("#console-wrap").style.display = name === "console" ? "" : "none";
  $("#history-wrap").style.display = name === "history" ? "" : "none";
  $("#schedule-wrap").style.display = name === "schedules" ? "" : "none";
  if (name === "schedules") {
    renderSchedules();
    // 定时任务页自动刷新：执行中状态(running/success)与下次执行时间实时更新
    if (!window._schedRefreshTimer) {
      window._schedRefreshTimer = setInterval(() => renderSchedules(true), 5000);
    }
  } else if (window._schedRefreshTimer) {
    clearInterval(window._schedRefreshTimer);
    window._schedRefreshTimer = null;
  }
  applyRunState(); // 切 tab 后按 state 恢复运行按钮状态（呼吸灯/禁用）
}
document.addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (!t) return;
  switchTab(t.dataset.tab);
  if (t.dataset.tab === "history") refreshHistory();
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
twoStep($("#btn-clear-history"), {
  onArm() {
    const b = $("#btn-clear-history");
    b.classList.add("ts-armed-danger");
    const span = b.querySelector("span");
    if (span) span.textContent = "再次点击清空";
  },
  onDisarm() {
    const b = $("#btn-clear-history");
    b.classList.remove("ts-armed-danger");
    const span = b.querySelector("span");
    if (span) span.textContent = "清空历史";
  },
  onConfirm: async () => {
    const r = await api("/api/executions/clear", { method: "POST", body: {} });
    toast("已清空 " + r.deleted + " 条记录");
    refreshHistory();
  },
});
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

/* ================= 初始化 ================= */

async function init() {
  applyPrefs(); // 恢复上次的 UI 偏好（标签过滤 / 开关等）
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

/* ================= 面板拖拽（桌面宽度 / 平板·小屏高度） ================= */
(function initDrag() {
  const layout = document.querySelector(".layout");
  const panel = document.querySelector(".panel");
  if (!layout || !panel) return;
  const savedW = localStorage.getItem("panel_w");
  if (savedW && window.innerWidth >= 1024) panel.style.setProperty("--panel-w", savedW + "px");
  const savedH = localStorage.getItem("panel_h");
  if (savedH && window.innerWidth < 1024) panel.style.setProperty("--panel-h", savedH + "px");

  // 垂直分隔条：调整面板宽度（桌面/大屏）
  const gutter = document.getElementById("gutter");
  if (gutter) {
    let dragging = false;
    gutter.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      gutter.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      const move = (ev) => {
        if (!dragging) return;
        const layoutW = layout.getBoundingClientRect().width;
        let w = startW + (startX - ev.clientX);
        w = Math.max(320, Math.min(layoutW * 0.7, w));
        panel.style.setProperty("--panel-w", w + "px");
      };
      const up = () => {
        dragging = false;
        gutter.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        localStorage.setItem("panel_w", Math.round(panel.getBoundingClientRect().width));
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // 平板/小屏：底部抽屉顶部把手调整高度
  const handle = document.getElementById("panel-handle");
  if (handle) {
    let dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      const startY = e.clientY;
      const startH = panel.getBoundingClientRect().height;
      const move = (ev) => {
        if (!dragging) return;
        const vh = window.innerHeight;
        let h = startH + (startY - ev.clientY);
        h = Math.max(140, Math.min(vh * 0.85, h));
        panel.style.setProperty("--panel-h", h + "px");
      };
      const up = () => {
        dragging = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        localStorage.setItem("panel_h", Math.round(panel.getBoundingClientRect().height));
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }
})();

init();
