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

/** 删除等危险操作的二次确认弹窗 */
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
  if (env.has_venv) {
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
    x.title = "删除预设";
    x.onclick = async (e) => {
      e.stopPropagation();
      confirmModal({
        title: "删除预设",
        message: `确定删除预设「${p.name}」吗？`,
        onConfirm: async () => {
          await api(`/api/presets/${p.id}`, { method: "DELETE" });
          toast("预设已删除");
          reloadDetail();
        },
      });
    };
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
          tip.hidden = false;
          tip.textContent = `⚠ 再次点击「${p.name}」将覆盖该预设`;
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
  del.onclick = async () => {
    confirmModal({
      title: "删除执行记录",
      message: `确定删除这条执行记录（${rec.script_name || "脚本"} · ${formatTime(rec.started_at)}）吗？`,
      onConfirm: async () => {
        await api(`/api/executions/${rec.id}`, { method: "DELETE" });
        detail.hidden = true;
        refreshHistory();
      },
    });
  };
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

/* ================= Tab ================= */

function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("#console-wrap").style.display = name === "console" ? "" : "none";
  $("#history-wrap").style.display = name === "history" ? "" : "none";
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

init();
