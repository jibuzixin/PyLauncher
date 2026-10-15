/* ==========================================================================
   ToolLauncher v2 · 前端逻辑
   分区：0 基础工具 / 1 控制台与终端 / 2 脚本卡片 / 3 脚本抽屉 / 4 历史
        5 定时任务 / 6 弹窗 / 7 顶栏与初始化
   ========================================================================== */
'use strict';

/* 全局兜底：未捕获异常一律进 console，便于定位界面级报错 */
window.addEventListener('error', (e) => {
  console.error('[window.error]', e.message, e.filename + ':' + e.lineno + ':' + e.colno, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled]', e.reason && (e.reason.stack || e.reason.message) || e.reason);
});

/* ========================= 0. 基础工具 ========================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 统一请求封装：后端错误一律为 {ok:false,error} + 4xx/5xx */
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 安全 JSON.parse：列表接口里 args/tags/args_schema 可能是字符串 */
function jparse(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function copyText(text) {
  const s = String(text == null ? '' : text);
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 忽略 */ }
    ta.remove();
  }
}

/* ---------- Toast ---------- */
const TOAST_ICON = {
  ok: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  warn: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 8v5"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  err: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

function toast(msg, type = 'ok', duration = 2600) {
  if (type === true) type = 'err';
  if (type === 'err') console.error('[toast:err]', msg);
  const box = $('#toast-box');
  $$('.toast', box).forEach(t => { t.classList.remove('in'); t.classList.add('out'); });
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${TOAST_ICON[type] || TOAST_ICON.ok}<span>${escapeHtml(msg)}</span>`;
  box.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  setTimeout(() => {
    el.classList.remove('in');
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, duration);
}

/* ---------- 时间格式化 ---------- */
function fmtTime(iso, withSec = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSec ? `${base}:${p(d.getSeconds())}` : base;
}
function fmtFull(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** 相对时间：3 分钟前 / 2 小时后 */
/** 近几天用「今天/明天/后天/大后天（昨天）」，再远就显示 M-D HH:MM */
function smartTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day1 - day0) / 86400000);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === 2) return `后天 ${hm}`;
  if (diff === 3) return `大后天 ${hm}`;
  if (diff === -1) return `昨天 ${hm}`;
  return fmtTime(iso, false);
}
function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff), fut = diff > 0;
  const units = [[86400000, '天'], [3600000, '小时'], [60000, '分钟']];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return fut ? `${n} ${label}后` : `${n} ${label}前`;
    }
  }
  return fut ? '即将' : '刚刚';
}
function durText(startIso, endIso) {
  if (!startIso) return '';
  const s = new Date(startIso).getTime();
  const e = endIso ? new Date(endIso).getTime() : Date.now();
  if (isNaN(s) || isNaN(e)) return '';
  let sec = Math.max(0, Math.round((e - s) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  sec %= 60;
  return h ? `${h}h${m}m` : `${m}m${sec}s`;
}

/* ---------- ANSI ---------- */
const ANSI_FG = { 30: '#3b4048', 31: '#d03050', 32: '#0aa32e', 33: '#c47d10', 34: '#1456f0', 35: '#8a4bd0', 36: '#0e8f9e', 37: '#606a76' };
const ANSI_FG_BRIGHT = { 90: '#6b7684', 91: '#f0526e', 92: '#2bbf4a', 93: '#ffa32e', 94: '#4d8bff', 95: '#b47bf0', 96: '#31c5d6', 97: '#8b95a1' };
const ANSI_BG = { 40: '#e9ebee', 41: '#ffd7de', 42: '#d6f5df', 43: '#ffeccc', 44: '#dbe7ff', 45: '#ecdfff', 46: '#d6f2f5', 47: '#e4e7eb' };

/** 只解析 SGR 序列；所有文本片段都先转义再拼接 */
function ansiToHtml(text) {
  const src = String(text == null ? '' : text);
  let out = '', color = null, bold = false, bg = null;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  const open = () => {
    const style = [];
    if (color) style.push(`color:${color}`);
    if (bg) style.push(`background:${bg}`);
    if (bold) style.push('font-weight:700');
    return `<span style="${style.join(';')}">`;
  };
  const push = (t) => { if (t) out += `<span style="${[color && `color:${color}`, bg && `background:${bg}`, bold && 'font-weight:700'].filter(Boolean).join(';')}">${escapeHtml(t)}</span>`; };
  while ((m = re.exec(src)) !== null) {
    push(src.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || '0').split(';').filter(x => x !== '').map(Number);
    if (!codes.length) codes.push(0);
    for (const code of codes) {
      if (code === 0) { color = null; bg = null; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = null;
      else if (code === 49) bg = null;
      else if (ANSI_FG[code]) color = ANSI_FG[code];
      else if (ANSI_FG_BRIGHT[code]) color = ANSI_FG_BRIGHT[code];
      else if (ANSI_BG[code]) bg = ANSI_BG[code];
    }
  }
  push(src.slice(last));
  void open;
  return out;
}
function stripAnsi(s) {
  return String(s == null ? '' : s).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
/** 无 ANSI 时按语义上色（用于 db 落库的静态输出快照） */
function decorateText(text) {
  const t = String(text == null ? '' : text);
  if (!t) return '&nbsp;';
  if (/\x1b\[/.test(t)) return ansiToHtml(t);
  const head = t.trim();
  if (t.startsWith('$ ')) return `<span class="t-dim">${escapeHtml(t)}</span>`;
  if (/^[✓✔]/.test(head) || /成功|success/i.test(head)) return `<span class="t-ok">${escapeHtml(t)}</span>`;
  if (/^[✗✘×]/.test(head) || /Traceback|Error|失败|错误/.test(head)) return `<span class="t-err">${escapeHtml(t)}</span>`;
  if (/^⚠/.test(head) || /警告|warn/i.test(head)) return `<span class="t-warn">${escapeHtml(t)}</span>`;
  return escapeHtml(t);
}

/* ---------- 全局状态 ---------- */
const state = {
  scripts: [],
  script: null,            // 当前选中脚本的详情（含 args_schema / presets / env）
  selectedId: null,
  activePresetId: null,
  running: false,
  currentExecId: null,
  ws: null,
  detailWs: null,
  detailId: null,
  detailStream: null,
  runningExecs: [],
  lastStatus: {},          // script_id -> 'success' | 'failed' | 'running'
  filter: 'all',
  kw: '',
  activeTag: null,
  favs: new Set(),
  view: 'scripts',
  uvOk: null,
  venvScanned: null,
  schedPatch: {},
  autoConsole: true,
  dockCollapsed: false,
  historyMulti: false,
  selectedHistory: new Set(),
  historyScope: 'all',
  histSig: null,
  schedSig: null,
  schedAnimated: false,
  schedKw: '',
  historyDetailMode: false,
  tabs: [],
  activeTab: 'welcome',
  offlineStreak: 0,
};

/* ---------- 设置页 ---------- */
function initSettingsView() {
  // 运行后自动收起详情 + 展开控制台
  $('#set-auto-console').addEventListener('change', (e) => {
    state.autoConsole = e.target.checked;
    savePrefs();
    toast(e.target.checked ? '运行后会自动收起详情并展开控制台' : '运行后保持当前界面不变');
  });
  // 与控件栏（dock / 抽屉）里的同名开关双向同步
  $('#set-autoscroll').addEventListener('change', (e) => {
    $('#opt-autoscroll').checked = e.target.checked;
    savePrefs();
  });
  $('#set-hide-empty').addEventListener('change', (e) => {
    $('#opt-hide-empty').checked = e.target.checked;
    applyEmptyFilter();
    savePrefs();
  });
  $('#opt-autoscroll').addEventListener('change', syncSettingsView);
  $('#opt-hide-empty').addEventListener('change', syncSettingsView);
  $('#set-export').addEventListener('click', exportData);
  $('#set-import').addEventListener('click', importConfig);
  $('#set-env-save').addEventListener('click', async () => {
    const box = $('#set-env');
    const text = box.value;
    try {
      const r = await api('/api/settings/env', { method: 'PUT', body: { text } });
      box.value = r.text || '';
      const hint = $('#set-env-hint');
      if (hint) hint.textContent = r.count ? `已配置 ${r.count} 个` : '尚未配置';
      toast(r.count ? `已保存 ${r.count} 个环境变量，对后续运行生效` : '环境变量已清空');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#set-env-clear').addEventListener('click', async () => {
    const ok = await confirmModal({ title: '清空环境变量', message: '所有脚本将不再注入这批环境变量（如 API_KEY）。', okText: '清空' });
    if (!ok) return;
    const box = $('#set-env');
    box.value = '';
    try {
      await api('/api/settings/env', { method: 'PUT', body: { text: '' } });
      const hint = $('#set-env-hint');
      if (hint) hint.textContent = '尚未配置';
      toast('环境变量已清空');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#set-usage').addEventListener('click', () => window.open('/static/usage.html?v=2', '_blank', 'noopener'));
  $('#btn-reset-prefs').addEventListener('click', async () => {
    const ok = await confirmModal({ title: '恢复默认偏好', message: '将重置本机保存的界面偏好（不影响脚本、预设与执行记录）。', okText: '恢复默认' });
    if (!ok) return;
    localStorage.removeItem(PREF_KEY);
    applyPrefs();
    applyEmptyFilter();
    syncSettingsView();
    toast('已恢复默认偏好');
  });
  syncSettingsView();
  loadRunEnv();
}

/** 读回设置页「环境变量」内容（正在输入时不覆盖，避免打断编辑）。 */
async function loadRunEnv(force) {
  const box = $('#set-env');
  if (!box) return;
  if (!force && document.activeElement === box) return;
  try {
    const r = await api('/api/settings/env');
    box.value = r.text || '';
    const hint = $('#set-env-hint');
    if (hint) hint.textContent = r.count ? `已配置 ${r.count} 个` : '尚未配置';
  } catch { /* 读不到就保持现状 */ }
}
async function fillSettingsAbout() {
  const el = $('#settings-about');
  if (!el) return;
  try {
    const [h, uv] = await Promise.all([
      api('/api/health'),
      api('/api/system/uv').catch(() => null),
    ]);
    if (!h || !h.ok) throw new Error('health');
    el.textContent = `本地服务运行中（${h.name}） · uv ${uv && uv.ok ? uv.version : '未安装'}`;
  } catch { el.textContent = '无法读取本地服务信息'; }
}

/* ---------- 偏好持久化 ---------- */
const PREF_KEY = 'launcher_prefs';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      favs: Array.from(state.favs),
      hideEmpty: $('#opt-hide-empty').checked,
      historyScope: state.historyScope,
      autoscroll: $('#opt-autoscroll').checked,
      autoConsole: state.autoConsole,
    }));
  } catch { /* 隐私模式下忽略 */ }
}
function applyPrefs() {
  const p = loadPrefs();
  state.favs = new Set((Array.isArray(p.favs) ? p.favs : []).map(Number));
  state.historyScope = p.historyScope === 'script' ? 'script' : 'all';
  state.autoConsole = p.autoConsole !== false;
  $('#opt-hide-empty').checked = !!p.hideEmpty;
  $('#opt-autoscroll').checked = p.autoscroll !== false;
  syncSettingsView();
}

/** 设置页里的开关与控件栏里的开关是同一份偏好的两个入口，改一个要同步另一个 */
function syncSettingsView() {
  const map = [['#set-autoscroll', '#opt-autoscroll'], ['#set-hide-empty', '#opt-hide-empty']];
  for (const [setEl, srcEl] of map) {
    const a = $(setEl), b = $(srcEl);
    if (a && b) a.checked = b.checked;
  }
  const ac = $('#set-auto-console');
  if (ac) ac.checked = state.autoConsole !== false;
}

/* ========================= 1. 控制台与终端 ========================= */

/**
 * 流式渲染器：还原终端语义（\r 覆盖当前行、\r\n 换行），保留 ANSI 颜色，
 * 最多 max 行；用户手动上滚后暂停自动跟随。
 * scrollEl 是滚动容器，contentEl 是行容器（每个终端 tab 独立持有，
 * 因此切 tab 不会丢失尚未换行的半行缓冲）。
 */
class Stream {
  constructor(scrollEl, contentEl, { max = 1000 } = {}) {
    this.scrollEl = scrollEl;
    this.contentEl = contentEl || scrollEl;
    this.max = max;
    this.buf = '';
    this.bufTs = '';
    this.crPending = false;
    this.streamCls = '';
    this.userScrolled = false;
    this.count = 0;
    this.cursorRow = null;
    scrollEl.addEventListener('scroll', () => {
      this.userScrolled = (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) >= 24;
    }, { passive: true });
  }
  clear() {
    this.buf = ''; this.crPending = false; this.count = 0; this.cursorRow = null;
    this.contentEl.innerHTML = '';
    this.userScrolled = false;
  }
  _row(ts, cls, html, raw) {
    const row = document.createElement('div');
    row.className = `con-line ${cls || ''}`;
    const no = document.createElement('div');
    no.className = 'con-no';
    no.innerHTML = `<span class="con-ts">${escapeHtml(ts || '')}</span><span class="con-copy" title="复制该行">复制</span>`;
    const txt = document.createElement('div');
    txt.className = 'con-text';
    txt.innerHTML = html || '&nbsp;';
    row.append(no, txt);
    row._raw = raw;
    return row;
  }
  _push(ts, cls, html, raw) {
    if (this.cursorRow) { this.cursorRow.remove(); this.cursorRow = null; }
    this.contentEl.appendChild(this._row(ts, cls, html, raw));
    this.count += 1;
    while (this.count > this.max && this.contentEl.firstChild) {
      this.contentEl.removeChild(this.contentEl.firstChild);
      this.count -= 1;
    }
    this._follow();
  }
  _flush(ts) {
    const text = this.buf;
    this.buf = '';
    const html = ansiToHtml(text);
    this._push(this.bufTs || ts || '', this.streamCls, html || '&nbsp;', text);
    this.bufTs = '';
  }
  append(stream, chunk, ts) {
    const cls = stream === 'stdout' ? '' : (stream || '');
    if (cls !== this.streamCls) { if (this.buf) this._flush(ts); this.streamCls = cls; }
    let s = String(chunk == null ? '' : chunk);
    if (this.crPending) {
      if (s.startsWith('\n')) { this._flush(ts); s = s.slice(1); }
      else { this.buf = ''; this.bufTs = ts; }
      this.crPending = false;
    }
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\r') {
        if (s[i + 1] === '\n') { this._flush(ts); i += 2; continue; }
        if (i + 1 < s.length) { this.buf = ''; this.bufTs = ts; i += 1; continue; }
        this.crPending = true; i += 1; continue;
      }
      if (ch === '\n') { this._flush(ts); i += 1; continue; }
      this.buf += ch; i += 1;
    }
    if (this.cursorRow) this._follow();
  }
  /** 运行中在末尾显示闪烁光标 */
  setLive(live) {
    if (live && !this.cursorRow) {
      const row = this._row('', '', '<span class="cursor"></span>', '');
      row.classList.add('cursor-row');
      this.contentEl.appendChild(row);
      this.cursorRow = row;
      this._follow();
    } else if (!live && this.cursorRow) {
      this.cursorRow.remove();
      this.cursorRow = null;
    }
  }
  /** 静态快照：数据库落库的输出 */
  renderSnapshot(text, tsText) {
    this.clear();
    const lines = String(text || '').split('\n');
    const tss = String(tsText || '').split('\n');
    while (lines.length && lines[lines.length - 1] === '') { lines.pop(); tss.pop(); }
    lines.forEach((l, i) => this._push(tss[i] || '', '', decorateText(l), l));
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }
  _follow() {
    const opt = $('#opt-autoscroll');
    if (!this.userScrolled && (!opt || opt.checked)) this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }
}

/* ---------- 终端 dock ---------- */
function initDock() {
  const termOut = $('#term-out');
  const welcomeBox = document.createElement('div');
  welcomeBox.innerHTML = [
    '<div class="term-empty">',
    '<div><span class="k">ToolLauncher v2.0</span> — 本地脚本启动器</div>',
    '<div>点脚本卡片 → 填参数 → 运行，输出会在这里新开一个 tab。</div>',
    '<div>提示：拖动顶部横条调高度；<span class="k">Esc</span> 关闭弹层；拖选输出可一键复制。</div>',
    '</div>',
  ].join('');
  const welcomeContent = document.createElement('div');
  welcomeContent.appendChild(welcomeBox);
  state.welcomeTab = { id: 'welcome', name: 'welcome', status: '', content: welcomeContent };
  termOut.appendChild(welcomeContent);

  const dock = $('#dock');
  const ICON_COLLAPSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>';
  const ICON_EXPAND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>';
  const setDockCollapsed = (collapsed) => {
    dock.classList.toggle('collapsed', !!collapsed);
    $('#dock-collapse').innerHTML = collapsed ? ICON_EXPAND : ICON_COLLAPSE;
    state.dockCollapsed = !!collapsed;
    syncDockEff();
    // 高度带 .25s 过渡，此刻读到的仍是过渡起始值；过渡结束后必须再同步一次，
    // 否则展开/收起后 --dock-eff 会卡在旧高度，抽屉与窄屏详情跟着错位。
    setTimeout(syncDockEff, 300);
    if (DEBUG) debugReport('dock:' + (collapsed ? 'collapsed' : 'open'));
  };
  const toggleDock = () => setDockCollapsed(!dock.classList.contains('collapsed'));
  // 暴露给运行流程用：跑完自动展开控制台
  state.toggleDock = toggleDock;
  $('#dock-collapse').addEventListener('click', toggleDock);
  // 双击标题条 / 折叠条即可展开或收起，不必去够右边那个小按钮
  dock.addEventListener('dblclick', (e) => {
    if (e.target.closest('.term-dock-actions, .term-out, .dock-resize')) return;
    toggleDock();
  });
  $('#dock-clear').addEventListener('click', () => {
    const tab = currentTab();
    if (!tab) return;
    if (tab.id === 'welcome') { switchTab('welcome'); return; }
    tab.stream.clear();
    toast('已清空该任务的输出显示（数据库记录不受影响）');
  });
  $('#dock-terminate').addEventListener('click', terminateCurrent);
  $('#opt-autoscroll').addEventListener('change', savePrefs);
  setupDockResize();
  syncDockEff();
  setupCopyFloat();
  renderTabs();
}

function currentTab() {
  if (state.activeTab === 'welcome') return state.welcomeTab;
  return state.tabs.find(t => t.id === state.activeTab) || null;
}
function getTab(id) { return state.tabs.find(t => t.id === id) || null; }

/** 每次执行开一个独立 tab，输出流互不干扰 */
function newTab(id, name) {
  let tab = getTab(id);
  if (!tab) {
    const content = document.createElement('div');
    tab = { id, name, status: 'running', content, stream: new Stream($('#term-out'), content, { max: 1000 }) };
    state.tabs.push(tab);
    renderTabs();
  }
  switchTab(id);
  return tab;
}
function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);
  renderTabs();
  if (state.activeTab === id) switchTab(state.tabs.length ? state.tabs[Math.max(0, idx - 1)].id : 'welcome');
}
function switchTab(id) {
  state.activeTab = id;
  const tab = currentTab();
  const termOut = $('#term-out');
  termOut.innerHTML = '';
  if (tab) termOut.appendChild(tab.content);
  if (tab && tab.stream) tab.stream.setLive(tab.status === 'running');
  if (tab) termOut.scrollTop = termOut.scrollHeight;
  renderTabs();
}
function setTabStatus(id, status) {
  const tab = getTab(id);
  if (!tab) return;
  tab.status = status;
  if (state.activeTab === id) tab.stream.setLive(status === 'running');
  renderTabs();
}
function renderTabs() {
  const box = $('#dock-tabs');
  $$('.term-tab', box).forEach(n => n.remove());
  const actions = $('.term-dock-actions', box);
  const mk = (tab, isWelcome) => {
    const b = document.createElement('button');
    b.className = `term-tab ${tab.status || ''}${state.activeTab === tab.id ? ' active' : ''}`;
    b.dataset.tab = tab.id;
    b.innerHTML = `<span class="dot"></span><span class="nm">${escapeHtml(tab.name)}</span>`
      + (isWelcome ? '' : '<span class="close" title="关闭">×</span>');
    b.addEventListener('click', (e) => {
      if (e.target.classList.contains('close')) { e.stopPropagation(); closeTab(tab.id); return; }
      switchTab(tab.id);
    });
    box.insertBefore(b, actions);
  };
  mk(state.welcomeTab, true);
  state.tabs.forEach(t => mk(t, false));
}

/* ---------- 控制台拖选复制 ---------- */
function setupCopyFloat() {
  const float = $('#copy-float');
  const update = () => {
    const sel = window.getSelection();
    const termOut = $('#term-out');
    if (!sel || sel.isCollapsed || !sel.rangeCount) { float.hidden = true; return; }
    const range = sel.getRangeAt(0);
    const host = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const container = host && host.closest ? host.closest('.term-out, .hist-detail-out') : null;
    if (!container) { float.hidden = true; return; }
    let n = 0;
    $$('.con-line', container).forEach(line => { if (range.intersectsNode(line)) n += 1; });
    if (!n) { float.hidden = true; return; }
    const rect = range.getBoundingClientRect();
    float.hidden = false;
    $('#copy-count').textContent = n;
    float.style.left = Math.max(10, Math.min(rect.left + rect.width / 2 - 60, window.innerWidth - 140)) + 'px';
    float.style.top = Math.max(10, rect.top - 36) + 'px';
  };
  document.addEventListener('mouseup', () => setTimeout(update, 0));
  document.addEventListener('keyup', () => setTimeout(update, 0));
  float.addEventListener('click', async () => {
    const sel = window.getSelection();
    if (sel) { await copyText(sel.toString()); toast(`已复制 ${$('#copy-count').textContent} 行`); }
    float.hidden = true;
    window.getSelection().removeAllRanges();
  });
}

/* ---------- 底部 dock 高度拖拽 ---------- */
/** 控制台实际占位高度（展开/收起/拖拽/改窗口后都要同步），供右侧抽屉与 toast 定位使用 */
function syncDockEff() {
  const d = $('#dock');
  if (!d) return;
  document.documentElement.style.setProperty('--dock-eff', `${Math.round(d.getBoundingClientRect().height)}px`);
}
// 兜底：拖拽与展开/收起的过渡结束时再校准一次实际占位高度
const dockEl = () => $('#dock');
if (dockEl()) dockEl().addEventListener('transitionend', (e) => {
  if (e.propertyName === 'height') syncDockEff();
});

function setupDockResize() {
  const handle = $('#dock-resize');
  const dock = $('#dock');
  let startY = 0, startH = 0;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY; startH = dock.offsetHeight;
    document.body.classList.add('dragging');
    const onMove = (ev) => {
      const h = Math.min(Math.max(startH - (ev.clientY - startY), 80), window.innerHeight - 220);
      dock.style.height = h + 'px';
      document.documentElement.style.setProperty('--dock-h', h + 'px');
      syncDockEff();
    };
    const onUp = () => {
      document.body.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      syncDockEff();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  window.addEventListener('resize', syncDockEff);
}
/* ========================= 2. 脚本卡片 ========================= */

function statusOf(scriptId) {
  return state.lastStatus[scriptId] || '';
}
function statusMeta(st) {
  return {
    idle: ['idle', '就绪'],
    running: ['running', '运行中'],
    success: ['ok', '上次成功'],
    failed: ['err', '上次失败'],
    terminated: ['err', '上次终止'],
  }[st] || ['idle', '就绪'];
}
function scriptArgCount(s) {
  return jparse(s.args_schema, []).length;
}

async function loadScripts() {
  state.scripts = await api('/api/scripts');
  renderTagBar();
  renderGrid();
  updateFilterCounts();
}

/** 卡片状态只做局部更新，避免整列重绘打断交互 */
function updateRunBadges() {
  const byScript = new Map();
  for (const r of state.runningExecs) {
    if (!byScript.has(r.script_id)) byScript.set(r.script_id, []);
    byScript.get(r.script_id).push(r);
  }
  $$('.scard').forEach(card => {
    const id = Number(card.dataset.id);
    const runs = byScript.get(id) || [];
    let badge = $('.run-badge', card);
    if (runs.length) {
      card.classList.add('running');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'run-badge';
        badge.innerHTML = '● 1';
        $('.card-foot .right', card).prepend(badge);
      }
      badge.textContent = `● ${runs.length}`;
    } else {
      card.classList.remove('running');
      if (badge) badge.remove();
    }
    const st = runs.length ? 'running' : statusOf(id);
    const [cls, label] = statusMeta(st);
    const stEl = $('.st', card);
    stEl.className = `st ${cls}`;
    stEl.innerHTML = `<i></i>${label}`;
  });
}

function renderGrid() {
  const grid = $('#grid');
  const kw = state.kw.trim().toLowerCase();
  const list = state.scripts.filter(s => {
    if (state.filter === 'fav' && !state.favs.has(s.id)) return false;
    if (state.filter === 'running' && !(state.runningExecs || []).some(r => r.script_id === s.id)) return false;
    if (state.filter === 'failed' && !['failed', 'terminated'].includes(statusOf(s.id))) return false;
    if (state.activeTag && !(s.tags || []).includes(state.activeTag)) return false;
    if (kw) {
      const hay = `${s.name} ${s.path} ${(s.tags || []).join(' ')} ${s.description || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });

  if (!list.length) {
    grid.innerHTML = `<div class="empty">没有匹配的脚本。<div class="empty-act">
      <button class="btn btn-ghost" onclick="document.getElementById('btn-add').click()">导入脚本</button></div></div>`;
    return;
  }

  grid.innerHTML = '';
  for (const s of list) grid.appendChild(scriptCard(s));
  updateRunBadges();
}

function scriptCard(s) {
  const card = document.createElement('div');
  card.className = 'scard' + (state.selectedId === s.id ? ' sel' : '');
  card.dataset.id = s.id;
  const n = scriptArgCount(s);
  card.innerHTML = `
    <div class="scard-top">
      <div class="fname">${escapeHtml(s.name)}</div>
      <button class="fav ${state.favs.has(s.id) ? 'on' : ''}" title="收藏">${state.favs.has(s.id) ? '♥' : '♡'}</button>
    </div>
    <div class="sc-path" title="${escapeHtml(s.path)}">${escapeHtml(s.path)}</div>
    <div class="desc">${escapeHtml(s.description || '')}</div>
    <div class="tags"></div>
    <div class="card-foot">
      <span class="st idle"><i></i>就绪</span>
      <span class="right">${n ? `${n} 参数` : '无参数'}</span>
    </div>`;

  const tags = $('.tags', card);
  (s.tags || []).slice(0, 3).forEach(t => {
    const el = document.createElement('span');
    el.className = 'tag';
    el.dataset.tag = t;
    el.textContent = '#' + t;
    tags.appendChild(el);
  });
  if ((s.tags || []).length > 3) {
    const more = document.createElement('span');
    more.className = 'tag more';
    more.textContent = `+${s.tags.length - 3}`;
    tags.appendChild(more);
  }
  if (s.has_inline_meta) {
    const el = document.createElement('span');
    el.className = 'tag env';
    el.textContent = 'PEP 723';
    el.title = '内联依赖声明，由 uv 自动管理';
    tags.appendChild(el);
  }
  return card;
}

/** 卡片区事件委托：列表重绘不会丢事件 */
function initGridEvents() {
  $('#grid').addEventListener('click', (e) => {
    const card = e.target.closest('.scard');
    if (!card) return;
    const id = Number(card.dataset.id);
    const s = state.scripts.find(x => x.id === id);
    if (!s) return;
    const badge = e.target.closest('.run-badge');
    if (badge) {
      const runs = state.runningExecs.filter(r => r.script_id === id);
      if (runs.length) openRunPopover(badge, runs);
      return;
    }
    const fav = e.target.closest('.fav');
    if (fav) {
      if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
      savePrefs();
      if (state.filter === 'fav') renderGrid();
      else {
        fav.classList.toggle('on', state.favs.has(id));
        fav.textContent = state.favs.has(id) ? '♥' : '♡';
      }
      updateFilterCounts();
      return;
    }
    const tag = e.target.closest('.tag[data-tag]');
    if (tag) {
      state.activeTag = state.activeTag === tag.dataset.tag ? null : tag.dataset.tag;
      renderTagBar(); renderGrid();
      return;
    }
    selectScript(id);
  });
}

function renderTagBar() {
  const bar = $('#tag-bar');
  const tags = [...new Set(state.scripts.flatMap(s => s.tags || []))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
  if (!tags.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = '<span class="lbl">标签</span>' + tags.map(t =>
    `<button class="tag-chip ${state.activeTag === t ? 'on' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')
    + (state.activeTag ? '<button class="tag-chip" id="btn-tag-clear">清除筛选</button>' : '');
  $$('[data-tag]', bar).forEach(b => b.addEventListener('click', () => {
    state.activeTag = state.activeTag === b.dataset.tag ? null : b.dataset.tag;
    renderTagBar(); renderGrid();
  }));
  const clear = $('#btn-tag-clear');
  if (clear) clear.addEventListener('click', () => { state.activeTag = null; renderTagBar(); renderGrid(); });
}

function updateFilterCounts() {
  $('#c-all').textContent = state.scripts.length;
  $('#c-fav').textContent = state.scripts.filter(s => state.favs.has(s.id)).length;
  $('#c-run').textContent = new Set(state.runningExecs.map(r => r.script_id)).size;
  $('#c-fail').textContent = state.scripts.filter(s => ['failed', 'terminated'].includes(statusOf(s.id))).length;
}

/* ---------- 运行中任务浮层 ---------- */
let popTimer = null;
function openRunPopover(anchor, runs) {
  const pop = $('#run-popover');
  pop.innerHTML = '<div class="rp-head"><span>运行中的任务</span><span class="mono">' + runs.length + ' 个</span></div>';
  for (const r of runs) {
    const item = document.createElement('div');
    item.className = 'rp-item';
    item.innerHTML = `<div class="rp-args" title="${escapeHtml(summarizeArgs(r.args))}">${escapeHtml(summarizeArgs(r.args) || '（无参数）')}</div>
      <div class="rp-meta"><span class="mono" data-t="${r.id}">${escapeHtml(fmtTime(r.started_at))}</span>
      <span>· 已运行 <span class="mono" data-d="${r.id}">${durText(r.started_at)}</span></span></div>`;
    item.addEventListener('click', () => { closeRunPopover(); jumpToExecution(r.id); });
    pop.appendChild(item);
  }
  const rect = anchor.getBoundingClientRect();
  pop.classList.add('show');
  const w = 330;
  pop.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - w - 10)) + 'px';
  pop.style.top = (rect.bottom + 6) + 'px';
  clearInterval(popTimer);
  popTimer = setInterval(() => {
    for (const r of runs) {
      const el = $(`[data-d="${r.id}"]`, pop);
      if (el) el.textContent = durText(r.started_at);
    }
  }, 1000);
}
function closeRunPopover() {
  $('#run-popover').classList.remove('show');
  clearInterval(popTimer);
}
function summarizeArgs(args) {
  const a = typeof args === 'string' ? jparse(args, {}) : (args || {});
  return Object.entries(a)
    .filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `--${k} ${Array.isArray(v) ? v.join(',') : v}`)
    .join(' ');
}
function jumpToExecution(id) {
  switchView('history');
  refreshHistory().then(() => {
    const row = $(`.hist-row[data-id="${id}"]`);
    if (row) showHistoryDetail(Number(id), row);
    else toast('该执行记录已不存在', 'warn');
  });
}

/* ========================= 3. 脚本抽屉 ========================= */

async function selectScript(id, { keepDrawer = false } = {}) {
  try {
    const script = await api(`/api/scripts/${id}`);
    state.script = script;
    state.selectedId = id;
    state.activePresetId = null;
    try { localStorage.setItem('last_script_id', String(id)); } catch { /* ignore */ }
    if (!keepDrawer) openDrawer();
    renderScriptHead();
    renderEnvBar();
    renderDepsRow();
    renderPresets();
    renderFields();
    refreshCmd();
    setRunning(false);
    $$('.scard').forEach(c => c.classList.toggle('sel', Number(c.dataset.id) === id));
  } catch (e) {
    toast(e.message, 'err');
  }
}

function openDrawer() {
  $('#drawer').classList.add('show');
  $('#drawer-mask').classList.add('show');
  if (DEBUG) setTimeout(() => debugReport('drawer'), 450);
}
function closeDrawer() {
  $('#drawer').classList.remove('show');
  $('#drawer-mask').classList.remove('show');
}

function renderScriptHead() {
  const rec = state.script;
  if (!rec) return;
  $('#d-name').textContent = rec.name;
  $('#d-desc').innerHTML = escapeHtml(rec.description || '') || '<span style="color:var(--ink-4)">（点击添加描述）</span>';
  $('#d-path').textContent = rec.path;
  renderScriptTags();
}

/* 名称 / 描述：contenteditable，失焦即存，Esc 撤销 */
function bindEditable(el, { placeholder, save }) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { e.dataset.cancel = '1'; el.blur(); }
  });
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text');
    document.execCommand('insertText', false, t.replace(/\n/g, ' '));
  });
  el.addEventListener('blur', async () => {
    const cancel = el.dataset.cancel === '1';
    el.dataset.cancel = '0';
    const raw = el.innerText.trim();
    const value = raw || placeholder;
    el.textContent = value;
    if (cancel || value === el.dataset.saved) return;
    el.dataset.saved = value;
    try { await save(value); } catch (e) { toast(e.message, 'err'); }
  });
}
function initEditables() {
  const nameEl = $('#d-name');
  nameEl.dataset.placeholder = '';
  bindEditable(nameEl, {
    placeholder: '',
    save: async (v) => {
      if (!v) { nameEl.textContent = state.script.name; toast('名称不能为空', 'warn'); return; }
      await api(`/api/scripts/${state.selectedId}`, { method: 'PUT', body: { name: v } });
      state.script.name = v;
      toast('已重命名');
      await loadScripts();
    },
  });
  const descEl = $('#d-desc');
  bindEditable(descEl, {
    placeholder: '',
    save: async (v) => {
      await api(`/api/scripts/${state.selectedId}`, { method: 'PUT', body: { description: v } });
      state.script.description = v;
      descEl.innerHTML = escapeHtml(v) || '<span style="color:var(--ink-4)">（点击添加描述）</span>';
      await loadScripts();
    },
  });
}

function renderScriptTags() {
  const box = $('#d-tags');
  // tags 正常是数组；接口偶尔回字符串时兜底解析，绝不能让它把整个标签行打崩
  const raw = state.script && state.script.tags;
  const tags = Array.isArray(raw) ? raw : jparse(raw, []);
  box.innerHTML = '<span style="font-size:11px;color:var(--ink-4)">标签</span>';
  tags.forEach(t => {
    const el = document.createElement('span');
    el.className = 'tag';
    el.innerHTML = `#${escapeHtml(t)}<span class="x" title="移除标签">×</span>`;
    $('.x', el).addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = tags.filter(x => x !== t);
      await setScriptTags(next);
    });
    box.appendChild(el);
  });
  const inp = document.createElement('input');
  inp.className = 'tag-input mono';
  inp.placeholder = '+ 标签';
  inp.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const v = inp.value.trim();
    if (!v) return;
    if (tags.includes(v)) { inp.value = ''; return; }
    inp.value = '';
    await setScriptTags([...tags, v]);
  });
  box.appendChild(inp);
}
async function setScriptTags(tags) {
  try {
    const r = await api(`/api/scripts/${state.selectedId}`, { method: 'PUT', body: { tags } });
    const back = r.script ? r.script.tags : tags;
    // 以服务端回读为准（重命名等并发改动也能对齐），类型兜底防止非数组把渲染打崩
    state.script.tags = Array.isArray(back) ? back : jparse(back, tags);
    renderScriptTags();
    await loadScripts();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- 环境条 ---------- */
function renderEnvBar() {
  const bar = $('#d-env-bar');
  const env = state.script && state.script.env;
  if (!env) { bar.innerHTML = ''; return; }
  const items = [];
  // uv
  if (state.uvOk === false) {
    if (env.has_venv || env.has_inline_meta) items.push('<span class="env-item">未装 uv · 用项目环境运行</span>');
    else items.push('<span class="env-item err">未检测到 uv</span>');
  } else if (env.uv_version) {
    items.push(`<span class="env-item ok" title="${escapeHtml(env.uv_version)}">${escapeHtml(env.uv_version.split(/\s+/).pop())}</span>`);
  }
  // 虚拟环境
  let venvNode = '';
  if (env.venv_source === 'custom') {
    venvNode = env.venv_broken
      ? '<span class="env-item err">指定环境不可用</span>'
      : `<span class="env-item ok" title="${escapeHtml(env.venv_python || '')}">指定环境</span>`;
  } else if (env.has_inline_meta) {
    venvNode = `<span class="env-item ok">PEP 723 内联${env.inline_deps && env.inline_deps.length ? ` · ${env.inline_deps.length} 依赖` : ''}</span>`;
  } else if (env.has_venv) {
    venvNode = `<span class="env-item ok" title="${escapeHtml(env.venv_python || '')}">venv 已就绪</span>`;
  } else {
    venvNode = '<span class="env-item warn">未初始化虚拟环境</span>';
  }
  items.push(venvNode);
  // 依赖
  items.push(env.has_deps
    ? `<span class="env-item ok" title="${escapeHtml(env.requirements_path || '')}">${escapeHtml(env.deps_name || '依赖文件')}</span>`
    : '<span class="env-item">无依赖文件</span>');

  const actions = [];
  if (!env.has_inline_meta) {
    actions.push('<span class="env-action" id="env-venv-set">更换环境</span>');
    if (!env.venv_source && !env.has_venv) actions.push('<span class="env-action" id="env-init">初始化环境</span>');
    else actions.push('<span class="env-action" id="env-init">安装依赖</span>');
  }
  bar.innerHTML = items.join('') + `<span class="env-sp"></span>${actions.join('')}`;
  const setBtn = $('#env-venv-set');
  if (setBtn) setBtn.addEventListener('click', openVenvSettings);
  const initBtn = $('#env-init');
  if (initBtn) initBtn.addEventListener('click', () => startEnvInit());
}

function renderDepsRow() {
  const row = $('#d-deps-row');
  const env = state.script && state.script.env;
  if (!env || env.has_inline_meta) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  row.innerHTML = `<label>依赖文件</label>
    <input class="mono" id="deps-input" value="${escapeHtml(state.script.deps_path || '')}" placeholder="留空自动检测脚本目录 requirements.txt">
    <button class="quick-btn" id="deps-save">保存并安装</button>`;
  $('#deps-save').addEventListener('click', async () => {
    const v = $('#deps-input').value.trim();
    try {
      await api(`/api/scripts/${state.selectedId}`, { method: 'PUT', body: { deps_path: v } });
      state.script.deps_path = v;
      toast('已保存依赖文件路径');
      await reloadEnv();
      startEnvInit();
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function reloadEnv() {
  try {
    const env = await api(`/api/scripts/${state.selectedId}/env`);
    state.script.env = env;
    renderEnvBar();
    renderDepsRow();
  } catch { /* 忽略 */ }
}

/** 环境初始化：走 /ws/env 流式会话（旧版这里没有实现，属于修复） */
async function startEnvInit() {
  if (!state.selectedId) return;
  const deps = $('#deps-input') ? $('#deps-input').value.trim() : '';
  const id = `env-${state.selectedId}`;
  let tab = getTab(id);
  if (tab) { tab.stream.clear(); setTabStatus(id, 'running'); switchTab(id); }
  try {
    const r = await api(`/api/scripts/${state.selectedId}/env/init`, { method: 'POST', body: { deps_path: deps } });
    tab = newTab(r.session_id, '环境初始化');
    tab.id = r.session_id;
    tab.name = `env · ${state.script.name}`;
    renderTabs();
    connectWs(`/ws/env/${r.session_id}`, { tabId: r.session_id, envInit: true });
    toast('开始初始化环境…');
  } catch (e) {
    toast(e.message, 'err');
    if (tab) setTabStatus(tab.id, 'err');
  }
}

/* ---------- 预设 ---------- */
function presetDisplayGroups(all) {
  const pinned = all.filter(p => p.pinned);
  const unpinned = all.filter(p => !p.pinned);
  const max = 6;
  const shown = unpinned.slice(0, Math.max(0, max - pinned.length));
  return { pinned, shown, rest: unpinned.slice(shown.length) };
}
function renderPresets() {
  const box = $('#preset-chips');
  const all = (state.script && state.script.presets) || [];
  const { pinned, shown, rest } = presetDisplayGroups(all);
  box.innerHTML = '';
  if (!all.length) {
    box.innerHTML = '<span style="font-size:11px;color:var(--ink-4)">还没有预设，填好参数后点右侧「保存」</span>';
  }
  [...pinned, ...shown].forEach(p => box.appendChild(presetChip(p)));
  const more = document.createElement('button');
  more.className = 'more-bubble';
  more.textContent = rest.length ? `⋯ +${rest.length}` : '⋯ 管理';
  more.title = '管理全部预设';
  more.addEventListener('click', () => openPresetManager(all));
  box.appendChild(more);
}
function presetChip(p) {
  const chip = document.createElement('button');
  chip.className = 'preset-chip' + (p.pinned ? ' pinned' : '') + (state.activePresetId === p.id ? ' on' : '');
  chip.innerHTML = `${p.pinned ? '<span title="已固定">📌</span>' : ''}<span class="nm">${escapeHtml(p.name)}</span><span class="x" title="删除预设">×</span>`;
  chip.addEventListener('click', (e) => {
    if (e.target.classList.contains('x')) { e.stopPropagation(); askDeletePreset(chip, p, () => renderPresets()); return; }
    applyPreset(p);
  });
  return chip;
}
async function applyPreset(p) {
  state.activePresetId = p.id;
  fillValues(p.args || {});
  await saveArgs(p.args || {});
  // 预设同时携带自定义命令的前后缀，套用预设 = 套用「参数 + 命令补充」整套运行预期
  if (state.selectedId) {
    saveCmdParts(state.selectedId, { prefix: p.cmd_prefix || '', suffix: p.cmd_suffix || '' });
  }
  renderPresets();
  refreshCmd();
  toast(`已应用预设「${p.name}」`);
  api(`/api/presets/${p.id}`, { method: 'PATCH', body: { touch: true } }).catch(() => {});
}
function askDeletePreset(chip, p, after) {
  if (chip.classList.contains('confirm-del')) {
    clearTimeout(chip._delTimer);
    api(`/api/presets/${p.id}`, { method: 'DELETE' })
      .then(async () => {
        toast(`已删除预设「${p.name}」`);
        if (state.script) state.script.presets = (state.script.presets || []).filter(x => x.id !== p.id);
        renderPresets();
        if (after) after();
      })
      .catch(e => toast(e.message, 'err'));
    return;
  }
  chip.classList.add('confirm-del');
  toast('再次点击 × 确认删除该预设', 'warn');
  chip._delTimer = setTimeout(() => chip.classList.remove('confirm-del'), 3000);
}

/* ---------- 参数表单 ---------- */
function typeLabelOf(a) {
  if (a.is_flag) return 'bool';
  if (a.choices && a.choices.length) return 'enum';
  if (a.nargs || a.action === 'append') return 'list';
  if (a.type === 'int') return 'int';
  if (a.type === 'float') return 'float';
  return 'str';
}
function renderFields() {
  const box = $('#d-fields');
  const schema = (state.script && state.script.args_schema) || [];
  const saved = (state.script && state.script.auto_saved_args) || {};
  if (!schema.length) {
    box.innerHTML = '<div class="empty" style="padding:32px 12px">该脚本没有定义任何命令行参数。</div>';
    return;
  }
  box.innerHTML = '';
  for (const a of schema) {
    const wrap = document.createElement('div');
    wrap.className = 'field' + (a.is_flag ? ' field-switch' : '');
    wrap.dataset.dest = a.dest;
    const t = typeLabelOf(a);
    const opts = (a.option_strings || []).join(' / ');
    const positionalNote = a.kind === 'positional' ? '位置参数' : (opts || '');
    wrap.innerHTML = `<label><span class="name">${escapeHtml(a.dest)}</span>
        ${a.required ? '<span class="req">*</span>' : ''}
        <span class="opt">${escapeHtml(positionalNote)}</span>
        <span class="type ${t}">${t}</span></label>`;

    const initial = saved[a.dest] !== undefined && saved[a.dest] !== null ? saved[a.dest] : a.default;
    if (a.is_flag) {
      const sw = document.createElement('label');
      sw.className = 'switch';
      const on = a.action === 'store_false' ? !initial : !!initial;
      sw.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><span class="track"></span><span class="sw-val">${on ? '开启' : '关闭'}</span>`;
      sw.querySelector('input').addEventListener('change', (e) => {
        $('.sw-val', sw).textContent = e.target.checked ? '开启' : '关闭';
        autoSave();
      });
      wrap.appendChild(sw);
    } else if (a.choices && a.choices.length) {
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">${a.required ? '请选择…' : '（不传）'}</option>`
        + a.choices.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      sel.value = initial == null ? '' : String(initial);
      sel.addEventListener('change', autoSave);
      wrap.appendChild(sel);
    } else {
      const inp = document.createElement('input');
      const multi = a.nargs || a.action === 'append';
      inp.type = (a.type === 'int' || a.type === 'float') ? 'number' : 'text';
      if (a.type === 'int') inp.step = '1';
      if (multi) inp.placeholder = '多个值用英文逗号分隔';
      inp.value = Array.isArray(initial) ? initial.join(', ') : (initial == null ? '' : String(initial));
      inp.addEventListener('input', autoSave);
      wrap.appendChild(inp);
    }
    const help = a.help || '';
    if (help) {
      const h = document.createElement('div');
      h.className = 'help';
      h.textContent = help;
      wrap.appendChild(h);
    }
    box.appendChild(wrap);
  }
  applyEmptyFilter();
}

function fieldInputs(dest) {
  const f = $(`.field[data-dest="${CSS.escape(dest)}"]`, $('#d-fields'));
  return f ? { field: f, cb: $('input[type=checkbox]', f), input: $('input[type=text],input[type=number]', f), sel: $('select', f) } : null;
}
function collectValues() {
  const schema = (state.script && state.script.args_schema) || [];
  const values = {};
  for (const a of schema) {
    const got = fieldInputs(a.dest);
    if (!got) continue;
    if (a.is_flag) { values[a.dest] = !!(got.cb && got.cb.checked); continue; }
    if (a.choices && a.choices.length) { values[a.dest] = got.sel ? got.sel.value : ''; continue; }
    const raw = (got.input ? got.input.value : '').trim();
    if (a.nargs || a.action === 'append') { values[a.dest] = raw ? raw.split(/[,，\s]+/).filter(Boolean) : []; continue; }
    if (a.type === 'int' || a.type === 'float') { values[a.dest] = raw === '' ? '' : Number(raw); continue; }
    values[a.dest] = raw;
  }
  return values;
}
function fillValues(values) {
  const schema = (state.script && state.script.args_schema) || [];
  for (const [dest, v] of Object.entries(values || {})) {
    if (v === undefined) continue;
    const got = fieldInputs(dest);
    if (!got) continue;
    const a = schema.find(x => x.dest === dest) || {};
    if (a.is_flag) { if (got.cb) { got.cb.checked = !!v; $('.sw-val', got.field).textContent = got.cb.checked ? '开启' : '关闭'; } }
    else if (got.sel) got.sel.value = String(v);
    else if (got.input) got.input.value = Array.isArray(v) ? v.join(', ') : String(v);
  }
  applyEmptyFilter();
}
function applyEmptyFilter() {
  const hide = $('#opt-hide-empty').checked;
  $$('.field', $('#d-fields')).forEach(f => {
    if (f.classList.contains('field-switch')) { f.style.display = ''; return; }
    const ctrl = $('select', f) || $('input', f);
    const val = ctrl ? String(ctrl.value || '') : '';
    f.style.display = (hide && val === '') ? 'none' : '';
  });
}

const autoSave = debounce(async () => {
  const values = collectValues();
  state.script.auto_saved_args = values;
  await saveArgs(values);
  refreshCmd();
}, 500);
async function saveArgs(values) {
  if (!state.selectedId) return;
  try { await api(`/api/scripts/${state.selectedId}/args`, { method: 'PUT', body: { args: values } }); }
  catch { /* 自动保存失败不打扰用户 */ }
}

/* ---------- 命令：三段式（前缀 + 参数段 + 后缀） ----------
   参数段始终由系统按当前表单值生成，用户只能在前 / 后补充内容（环境变量、
   管道、重定向等），这样改参数时命令一定会跟着变，不会出现「用户手改的参数
   留在命令里和表单打架」。                              */
const cmdPartsKey = (id) => `launcher_cmdparts_${id}`;

/** 读取该脚本保存的命令补充段（没有则两段都为空） */
function getCmdParts(id) {
  try {
    const p = JSON.parse(localStorage.getItem(cmdPartsKey(id)) || '{}');
    return { prefix: String(p.prefix || '').trim(), suffix: String(p.suffix || '').trim() };
  } catch { return { prefix: '', suffix: '' }; }
}
function saveCmdParts(id, parts) {
  const p = { prefix: (parts.prefix || '').trim(), suffix: (parts.suffix || '').trim() };
  if (!p.prefix && !p.suffix) localStorage.removeItem(cmdPartsKey(id));
  else localStorage.setItem(cmdPartsKey(id), JSON.stringify(p));
}
/** 前缀 + 参数段 + 后缀 → 最终整条命令 */
function joinCommand(autoCmd, parts) {
  return [parts.prefix, autoCmd, parts.suffix].filter((x) => x && x.trim()).join(' ').trim();
}

async function buildCommandText(values) {
  if (!state.selectedId) return { command: '' };
  try {
    const r = await api('/api/scripts/command', { method: 'POST', body: { script_id: state.selectedId, args: values || collectValues() } });
    if (r.error) return { command: '', error: r.error };
    return { command: r.command || '' };
  } catch (e) { return { command: '', error: e.message }; }
}

/** 当前表单值对应的参数段（系统生成，用户不可编辑） */
async function buildArgsSegment(values) {
  const { command } = await buildCommandText(values);
  return command;
}

/** 即将真正执行的整条命令 */
async function resolveRunCommand(values) {
  const { command } = await buildCommandText(values || collectValues());
  if (!command) return '';
  return joinCommand(command, getCmdParts(state.selectedId));
}

async function refreshCmd() {
  if (!state.selectedId) return;
  const parts = getCmdParts(state.selectedId);
  const autoCmd = await buildArgsSegment();
  const finalCmd = joinCommand(autoCmd, parts);
  const prefixEl = $('#cmd-prefix'), suffixEl = $('#cmd-suffix');
  const argsEl = $('#cmd-args'), finalEl = $('#cmd-final');
  // 正在输入的框不覆盖光标
  if (prefixEl && document.activeElement !== prefixEl) prefixEl.value = parts.prefix;
  if (suffixEl && document.activeElement !== suffixEl) suffixEl.value = parts.suffix;
  if (argsEl) argsEl.value = autoCmd;
  if (finalEl) finalEl.textContent = finalCmd || '（命令为空，请检查参数）';
  const inline = $('#cmd-inline');
  if (inline) {
    inline.textContent = finalCmd || '';
    inline.title = finalCmd || '';
  }
  const dot = $('#cmd-dot');
  if (dot) dot.hidden = !(parts.prefix || parts.suffix);
}

function initCmdStrip() {
  const strip = $('#cmd-strip');
  const headLbl = $('.cmd-strip-head .lbl', strip);
  const setHead = (open) => { if (headLbl) headLbl.textContent = open ? '编辑运行命令' : '运行命令'; };
  const open = () => {
    strip.classList.add('open', 'pop');
    setHead(true);
    refreshCmd();
    // 面板覆盖整个参数区，进来就直接落在可编辑的前缀上
    const p = $('#cmd-prefix');
    if (p) setTimeout(() => p.focus(), 60);
  };
  const close = () => { strip.classList.remove('open', 'pop'); setHead(false); };
  $('#cmd-strip-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    if (strip.classList.contains('open')) close(); else open();
  });
  $('#cmd-strip').addEventListener('click', (e) => {
    if (e.target.closest('.cmd-edit-pop')) e.stopPropagation();
  });
  $('#cmd-cancel').addEventListener('click', (e) => {
    e.stopPropagation(); close(); refreshCmd();
  });
  $('#cmd-reset').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (state.selectedId) localStorage.removeItem(cmdPartsKey(state.selectedId));
    close();
    await refreshCmd();
    toast('已清除自定义前后缀，命令回到系统生成');
  });
  $('#cmd-save').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (state.selectedId) {
      saveCmdParts(state.selectedId, {
        prefix: $('#cmd-prefix').value,
        suffix: $('#cmd-suffix').value,
      });
    }
    close();
    await refreshCmd();
    const p = getCmdParts(state.selectedId);
    toast((p.prefix || p.suffix) ? '前后缀已保存，运行时会用上' : '已恢复为系统生成的命令');
  });
  // 边输入边更新「即将运行的完整命令」，并自动保存草稿
  const onInput = debounce(() => {
    if (state.selectedId) {
      saveCmdParts(state.selectedId, { prefix: $('#cmd-prefix').value, suffix: $('#cmd-suffix').value });
    }
    refreshCmd();
  }, 400);
  $('#cmd-prefix').addEventListener('input', onInput);
  $('#cmd-suffix').addEventListener('input', onInput);
}

/* ---------- 执行 ---------- */
function setRunning(running) {
  state.running = running;
  const btn = $('#btn-run');
  btn.classList.toggle('running', running);
  $('#run-label').textContent = running ? '■ 终止' : '▶ 运行';
  $('#dock-terminate').hidden = !running;
  $('#q-run-status').className = 'quick-btn status-chip' + (running ? ' clickable' : '');
  const stEl = $('#q-run-status .st') || $('#q-run-status');
  const [cls, label] = running ? ['running', '运行中'] : statusMeta(statusOf(state.selectedId));
  stEl.className = `st ${cls}`;
  stEl.innerHTML = `<i></i>${label}`;
  $$('.scard').forEach(c => c.classList.toggle('running', running && Number(c.dataset.id) === state.selectedId));
  if (state.selectedId) {
    const card = $(`.scard[data-id="${state.selectedId}"]`);
    if (card) {
      const badge = $('.run-badge', card);
      if (running && !badge) {
        const b = document.createElement('span');
        b.className = 'run-badge';
        b.textContent = '● 1';
        $('.card-foot .right', card).prepend(b);
      }
    }
  }
}

async function runScript() {
  if (!state.script) { toast('请先选择一个脚本', 'warn'); return; }
  if (state.running) { terminateCurrent(); return; }
  const schema = state.script.args_schema || [];
  const values = collectValues();
  const missing = schema.filter(a => a.required
    && (values[a.dest] === undefined || values[a.dest] === null || values[a.dest] === ''
      || (Array.isArray(values[a.dest]) && !values[a.dest].length)))
    .map(a => a.dest);
  if (missing.length) { toast(`缺少必选参数：${missing.join(', ')}`, 'err'); return; }

  await saveArgs(values);
  // 用户手改过命令时，先把当前参数合并进命令，避免「改了参数但命令里还是旧参数」
  const custom = await resolveRunCommand(values);
  const payload = { script_id: state.selectedId, args: values, preset_id: state.activePresetId };
  if (custom) payload.command = custom;

  setRunning(true);
  setRunState('启动中…', 'run');
  // 偏好开启时：收起脚本详情 + 展开控制台，让用户直接看到输出
  if (state.autoConsole) {
    closeDrawer();
    if (state.dockCollapsed && state.toggleDock) state.toggleDock();
  }
  try {
    const r = await api('/api/execute', { method: 'POST', body: payload });
    state.currentExecId = r.execution_id;
    const tab = newTab(r.execution_id, state.script.name);
    tab.name = state.script.name;
    tab.execId = r.execution_id;
    renderTabs();
    connectWs(`/ws/run/${r.execution_id}`, { tabId: r.execution_id });
    refreshRunning();
  } catch (e) {
    setRunning(false);
    setRunState(e.message, 'err');
    toast('执行失败：' + e.message, 'err');
  }
}
function setRunState(text, kind) {
  const el = $('#q-run-status .st');
  if (!el) return;
  el.innerHTML = `<i></i>${escapeHtml(text)}`;
  el.className = `st ${kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : kind === 'warn' ? 'ok' : 'running'}`;
}

async function terminateCurrent() {
  if (!state.currentExecId) return;
  try {
    await api(`/api/executions/${state.currentExecId}/terminate`, { method: 'POST' });
    toast('已发送终止信号', 'warn');
  } catch (e) { toast(e.message, 'err'); }
}

function connectWs(path, { tabId, envInit = false } = {}) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } }
  const ws = new WebSocket(`${proto}//${location.host}${path}`);
  state.ws = ws;
  const tab = getTab(tabId);
  ws.onmessage = (ev) => {
    if (state.ws !== ws) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'line') {
      if (tab) tab.stream.append(msg.stream, msg.line, msg.ts);
      return;
    }
    if (msg.type === 'done') {
      const r = msg.result || {};
      ws.close();
      if (tab) setTabStatus(tab.id, r.ok === false && !r.status ? 'err' : (r.status === 'success' ? 'ok' : r.status === 'failed' ? 'err' : 'warn'));
      if (envInit) {
        if (r.ok) { toast('环境初始化完成'); reloadEnv(); }
        else toast('环境初始化失败：' + (r.message || '未知错误'), 'err');
        return;
      }
      const map = { success: ['ok', '执行成功'], failed: ['err', '执行失败'], terminated: ['err', '已终止'] };
      const [cls, text] = map[r.status] || ['err', '执行结束'];
      setRunState(`${text} · 退出码 ${r.exit_code == null ? '-' : r.exit_code}`, cls);
      setRunning(false);
      refreshRunning();
      refreshHistory();
      state.lastStatus[state.selectedId] = r.status || 'failed';
      updateRunBadges();
      updateFilterCounts();
    }
  };
  ws.onerror = () => toast('实时连接断开', 'err');
  ws.onclose = () => { if (state.ws === ws) state.ws = null; };
}
/* ========================= 4. 执行记录 ========================= */

state.executions = [];

const STATUS_TEXT = { success: '成功', failed: '失败', running: '运行中', terminated: '已终止' };

/** 数据指纹：轮询时用它判断是否真的变了，避免无谓重绘造成的闪烁 */
function signature(list, fields) {
  return list.map(x => fields.map(f => {
    const v = x[f];
    return typeof v === 'object' ? JSON.stringify(v) : v;
  }).join('|')).join(';');
}

async function refreshHistory() {
  try {
    const list = await api('/api/executions?limit=200');
    state.executions = list;
    // 用最新一次执行推导每个脚本的状态（卡片徽章 + 失败筛选）
    const latest = {};
    for (const h of [...list].reverse()) {
      if (h.script_id && !latest[h.script_id]) latest[h.script_id] = h.status;
    }
    state.lastStatus = latest;
    // 只有列表内容真的变了才重绘，否则 6 秒轮询会让整页反复闪
    const sig = signature(list, ['id', 'status', 'finished_at', 'tags', 'script_name']);
    const changed = sig !== state.histSig;
    state.histSig = sig;
    if (changed) renderHistory();
    updateRunBadges();
    updateFilterCounts();
    updatePageBadge();
    hideOffline();
  } catch (e) {
    markOffline();
    $('#hist-rows').innerHTML = `<div class="empty">加载执行记录失败：${escapeHtml(e.message)}</div>`;
  }
}

function updatePageBadge() {
  const n = state.scripts.length, m = state.executions.length;
  const running = state.runningExecs.length;
  const el = $('#page-badge');
  el.textContent = `${n} 脚本 · ${m} 记录${running ? ` · ${running} 运行中` : ''}`;
  el.classList.remove('bad');
}

function historyFiltered() {
  const kw = ($('#history-search').value || '').trim().toLowerCase();
  return state.executions.filter(h => {
    if (state.historyScope === 'script' && state.selectedId && h.script_id !== state.selectedId) return false;
    if (!kw) return true;
    const tags = jparse(h.tags, []).join(' ');
    const hay = `${h.script_name || ''} ${h.status} ${STATUS_TEXT[h.status] || ''} ${tags} ${h.command || ''}`.toLowerCase();
    return hay.includes(kw);
  });
}

function renderHistory() {
  const box = $('#hist-rows');
  const list = historyFiltered();
  $('#hist-multi-bar').classList.toggle('show', state.historyMulti);
  $('#hm-count').textContent = `已选 ${state.selectedHistory.size} 条`;
  $('#btn-history-multi').textContent = state.historyMulti ? '取消多选' : '多选';
  $('#btn-history-multi').classList.toggle('active', state.historyMulti);

  if (!list.length) {
    box.innerHTML = `<div class="empty">${state.executions.length ? '没有匹配的记录。' : '还没有执行记录。'}</div>`;
    return;
  }
  box.innerHTML = '';
  for (const h of list) {
    const row = document.createElement('div');
    row.className = 'hist-row' + (state.detailId === h.id ? ' sel' : '');
    row.dataset.id = h.id;
    const tags = jparse(h.tags, []);
    const scopeNote = state.historyScope === 'script' && !state.selectedId ? '（未选择脚本，显示全部）' : '';
    row.innerHTML = `
      ${state.historyMulti ? `<input type="checkbox" class="hi-cb" ${state.selectedHistory.has(h.id) ? 'checked' : ''}>` : '<span></span>'}
      <div class="main">
        <div class="script">${escapeHtml(h.script_name || '（脚本已删除）')}</div>
        <div class="meta">${tags.map(t => `<span class="tg">#${escapeHtml(t)}</span>`).join('')}${escapeHtml(fmtTime(h.started_at, false))} → ${h.finished_at ? escapeHtml(fmtTime(h.finished_at, false)) : '进行中'} · ${escapeHtml(durText(h.started_at, h.finished_at))}${scopeNote}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="status-pill ${escapeHtml(h.status)}">${escapeHtml(STATUS_TEXT[h.status] || h.status)}</span>
        <button class="hi-del" title="删除记录">×</button>
      </div>`;
    if (state.historyMulti) {
      $('.hi-cb', row).addEventListener('click', (e) => e.stopPropagation());
    }
    box.appendChild(row);
  }
}

/** 记录列表事件委托：轮询重绘不会丢事件 */
function initHistoryRowEvents() {
  $('#hist-rows').addEventListener('click', (e) => {
    const row = e.target.closest('.hist-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    const rec = state.executions.find(h => h.id === id);
    if (state.historyMulti) {
      if (e.target.closest('.hi-del')) return;
      if (state.selectedHistory.has(id)) state.selectedHistory.delete(id); else state.selectedHistory.add(id);
      renderHistory();
      return;
    }
    if (e.target.closest('.hi-del')) { armDeleteRow(row, id); return; }
    if (row.classList.contains('confirm-del') && !e.target.closest('.hi-del')) {
      // 点击黄色卡片任意处 = 取消确认
      clearTimeout(row._arm);
      row.classList.remove('confirm-del');
      const b = $('.hi-del', row);
      if (b) b.textContent = '×';
      return;
    }
    if (rec) showHistoryDetail(id);
  });
}

function armDeleteRow(row, id) {
  if (row.classList.contains('confirm-del')) {
    clearTimeout(row._arm);
    row.classList.remove('confirm-del');
    api(`/api/executions/${id}`, { method: 'DELETE' }).then(async () => {
      state.selectedHistory.delete(id);
      if (state.detailId === id) clearHistoryDetail();
      toast('已删除该记录');
      await refreshHistory();
    }).catch(e => toast(e.message, 'err'));
    return;
  }
  row.classList.add('confirm-del');
  $('.hi-del', row).textContent = '确认删除';
  row._arm = setTimeout(() => {
    row.classList.remove('confirm-del');
    const b = $('.hi-del', row);
    if (b) b.textContent = '×';
  }, 3000);
}

function clearHistoryDetail() {
  state.detailId = null;
  setDetailMode(false);
  if (state.detailWs) { try { state.detailWs.close(); } catch { /* ignore */ } state.detailWs = null; }
  $('#hd-script').textContent = '选择左侧记录查看详情';
  $('#hd-ops').innerHTML = '';
  $('#hd-sub').innerHTML = '';
  $('#hd-tags-bar').innerHTML = '';
  $('#hd-out').textContent = '—';
  setOutputFullscreen(false);
  $$('.hist-row').forEach(r => r.classList.remove('sel'));
}

/** 窄屏下切换「列表 / 详情」两种模式（宽屏时该类名无副作用） */
function setDetailMode(on) {
  state.historyDetailMode = !!on;
  $('#hist-layout').classList.toggle('show-detail', state.historyDetailMode);
}
/** 运行日志全屏：详情整块铺满视口，头部按钮仍在，方便退出 */
function setOutputFullscreen(on) {
  const box = $('#hist-detail-box');
  box.classList.toggle('out-full', !!on);
  const b = $('[data-op-fs]', box);
  if (b) { b.textContent = on ? '退出全屏' : '全屏日志'; b.title = on ? '退出全屏' : '全屏查看运行日志'; }
}

async function showHistoryDetail(id) {
  try {
    const rec = await api(`/api/executions/${id}`);
    state.detailId = id;
    setDetailMode(true);
    $$('.hist-row').forEach(r => r.classList.toggle('sel', Number(r.dataset.id) === id));
    $('#hd-script').textContent = rec.script_name || '（脚本已删除）';

    // 操作区
    const ops = $('#hd-ops');
    ops.innerHTML = '';
    const mk = (label, title, cls = 'quick-btn') => {
      const b = document.createElement('button');
      b.className = cls; b.textContent = label; b.title = title;
      ops.appendChild(b);
      return b;
    };
    if (rec.status === 'running') {
      const t = mk('终止', '终止该次执行', 'quick-btn danger');
      t.addEventListener('click', async () => {
        t.disabled = true; t.textContent = '终止中…';
        try { await api(`/api/executions/${id}/terminate`, { method: 'POST' }); toast('已发送终止信号', 'warn'); }
        catch (e) { t.disabled = false; t.textContent = '终止'; toast(e.message, 'err'); }
      });
    }
    mk('复制命令', '复制这次执行使用的命令').addEventListener('click', async () => {
      if (!rec.command) { toast('无法生成命令', 'warn'); return; }
      await copyText(rec.command);
      toast('命令已复制');
    });
    mk('↻ 重跑', '用这次参数重新填入表单').addEventListener('click', () => rerunExecution(rec));
    mk('删除', '删除该记录', 'quick-btn danger').addEventListener('click', async () => {
      const ok = await confirmModal({ title: '删除执行记录', message: '该记录及其输出将一并删除，无法恢复。', okText: '删除', danger: true });
      if (!ok) return;
      if (state.detailWs) { try { state.detailWs.close(); } catch { /* ignore */ } state.detailWs = null; }
      await api(`/api/executions/${id}`, { method: 'DELETE' });
      state.detailId = null;
      toast('已删除');
      await refreshHistory();
    });
    const fsBtn = mk('全屏日志', '全屏查看运行日志');
    fsBtn.dataset.opFs = '1';
    fsBtn.addEventListener('click', () => setOutputFullscreen(!$('#hist-detail-box').classList.contains('out-full')));

    // 参数 + 命令（数量多时默认折叠，把纵向空间让给运行日志）
    const args = rec.args || {};
    const entries = Object.entries(args)
      .filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length));
    const chips = entries
      .map(([k, v]) => `<span class="arg-chip"><b>${escapeHtml(k)}</b>=${escapeHtml(Array.isArray(v) ? v.join(',') : v)}</span>`).join('');
    const cmdTxt = rec.command || '';
    const argTitle = entries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('\n');
    state.argsOpen = entries.length <= 5;
    $('#hd-sub').innerHTML = `
      <div class="hd-meta-row">
        <span class="status-pill ${escapeHtml(rec.status)}">${escapeHtml(STATUS_TEXT[rec.status] || rec.status)}</span>
        <span>${escapeHtml(fmtTime(rec.started_at))} → ${rec.finished_at ? escapeHtml(fmtTime(rec.finished_at)) : '进行中'}</span>
        <span>耗时 ${escapeHtml(durText(rec.started_at, rec.finished_at))}</span>
        <span>退出码 ${rec.exit_code == null ? '—' : escapeHtml(rec.exit_code)}</span>
      </div>
      <div class="hd-args-box${state.argsOpen ? '' : ' collapsed'}">
        <button class="hd-args-toggle" title="${escapeHtml(argTitle)}">
          <span class="caret">${state.argsOpen ? '▾' : '▸'}</span>参数 <b>${entries.length}</b>${cmdTxt ? ` · 命令 <b>${cmdTxt.length}</b> 字符` : ''}
        </button>
        <div class="hd-args">
          ${chips || '<span style="color:var(--ink-4)">无参数</span>'}
          ${cmdTxt ? `<div class="cmd" title="${escapeHtml(cmdTxt)}">${escapeHtml(cmdTxt)}</div>` : ''}
        </div>
      </div>`;
    const argsBox = $('.hd-args-box', $('#hd-sub'));
    // 注意：这里是 class 选择器，#hd-sub 内动态生成的按钮并没有 id
    const argsToggle = argsBox && $('.hd-args-toggle', argsBox);
    if (argsToggle) argsToggle.addEventListener('click', () => {
      state.argsOpen = argsBox.classList.contains('collapsed');
      argsBox.classList.toggle('collapsed', !state.argsOpen);
      $('.caret', argsBox).textContent = state.argsOpen ? '▾' : '▸';
    });

    renderDetailTags(rec);

    // 输出
    const out = $('#hd-out');
    out.className = 'hist-detail-out';
    const content = document.createElement('div');
    out.innerHTML = '';
    out.appendChild(content);
    const stream = new Stream(out, content, { max: 1000 });

    if (rec.status === 'running') {
      content.innerHTML = '<div class="t-placeholder">任务运行中，等待实时输出…</div>';
      const ph = content.firstChild;
      if (state.detailWs) { try { state.detailWs.close(); } catch { /* ignore */ } }
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/run/${id}`);
      state.detailWs = ws;
      ws.onmessage = (ev) => {
        if (state.detailWs !== ws) return;
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'line') {
          if (ph) { ph.remove(); }
          stream.append(m.stream, m.line, m.ts);
        } else if (m.type === 'done') {
          ws.close();
          state.detailWs = null;
          refreshRunning();
          refreshHistory().then(() => showHistoryDetail(id));
        }
      };
      ws.onerror = () => { if (state.detailWs === ws) state.detailWs = null; };
    } else {
      stream.renderSnapshot(rec.output, rec.output_ts);
      if (!rec.output) content.innerHTML = '<div class="t-placeholder">（无输出）</div>';
    }
    state.detailStream = stream;
  } catch (e) {
    console.error('[showHistoryDetail]', e && (e.stack || e.message) || e);
    toast(e.message, 'err');
  }
}

function renderDetailTags(rec) {
  const bar = $('#hd-tags-bar');
  const tags = jparse(rec.tags, []);
  bar.innerHTML = '<span>标签</span>';
  tags.forEach(t => {
    const el = document.createElement('span');
    el.className = 'tag';
    el.innerHTML = `#${escapeHtml(t)}<span class="x" style="cursor:pointer;margin-left:3px;color:var(--ink-4)">×</span>`;
    $('.x', el).addEventListener('click', () => setDetailTags(rec, tags.filter(x => x !== t)));
    bar.appendChild(el);
  });
  const inp = document.createElement('input');
  inp.className = 'tag-input mono';
  inp.placeholder = '+ 标签';
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = inp.value.trim();
    if (!v || tags.includes(v)) { inp.value = ''; return; }
    inp.value = '';
    setDetailTags(rec, [...tags, v]);
  });
  bar.appendChild(inp);
}
async function setDetailTags(rec, tags) {
  try {
    await api(`/api/executions/${rec.id}/tags`, { method: 'PUT', body: { tags } });
    rec.tags = tags;
    renderDetailTags(rec);
    await refreshHistory();
  } catch (e) { toast(e.message, 'err'); }
}

async function rerunExecution(rec) {
  if (!rec.script_id) { toast('原脚本已删除，无法重跑', 'warn'); return; }
  await selectScript(rec.script_id);
  const args = typeof rec.args === 'string' ? jparse(rec.args, {}) : (rec.args || {});
  fillValues(args);
  await saveArgs(args);
  state.activePresetId = rec.preset_id;
  renderPresets();
  toast('已载入该次执行的参数，确认后点击「运行」');
}

/* ---------- 历史工具栏 ---------- */
function initHistoryView() {
  const search = debounce(() => renderHistory(), 220);
  $('#history-search').addEventListener('input', search);
  $('#btn-history-scope').addEventListener('click', () => {
    state.historyScope = state.historyScope === 'all' ? 'script' : 'all';
    updateHistoryScopeBtn();
    savePrefs();
    renderHistory();
  });
  $('#btn-history-multi').addEventListener('click', () => {
    state.historyMulti = !state.historyMulti;
    if (!state.historyMulti) state.selectedHistory.clear();
    if (state.historyMulti) setDetailMode(false);
    renderHistory();
  });
  $('#hist-back').addEventListener('click', () => setDetailMode(false));
  $('#detail-back').addEventListener('click', () => { clearHistoryDetail(); setDetailMode(false); });
  // 窄屏详情是右侧抽屉：点遮罩或按 Esc 都能退回列表
  $('#hd-mask').addEventListener('click', () => clearHistoryDetail());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#hist-detail-box').classList.contains('out-full')) { setOutputFullscreen(false); return; }
    if (state.historyDetailMode) clearHistoryDetail();
  });
  $('#hm-select-all').addEventListener('click', () => {
    const list = historyFiltered();
    const allOn = list.every(h => state.selectedHistory.has(h.id));
    if (allOn) list.forEach(h => state.selectedHistory.delete(h.id));
    else list.forEach(h => state.selectedHistory.add(h.id));
    renderHistory();
  });
  $('#hm-delete').addEventListener('click', async () => {
    const ids = Array.from(state.selectedHistory);
    if (!ids.length) { toast('请先选择要删除的记录', 'warn'); return; }
    const ok = await confirmModal({ title: '批量删除', message: `将删除 ${ids.length} 条执行记录（运行中的记录会自动跳过）。`, okText: '删除', danger: true });
    if (!ok) return;
    try {
      const r = await api('/api/executions/delete', { method: 'POST', body: { ids } });
      const skip = (r.skipped_running || []).length;
      toast(skip ? `已删除 ${r.deleted} 条，跳过 ${skip} 条运行中记录` : `已删除 ${r.deleted} 条记录`);
      state.selectedHistory.clear();
      state.detailId = null;
      await refreshHistory();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-clear-history').addEventListener('click', async () => {
    const ok = await confirmModal({ title: '清空执行记录', message: `将清空全部 ${state.executions.length} 条执行记录，无法恢复。`, okText: '清空', danger: true });
    if (!ok) return;
    try {
      const r = await api('/api/executions/clear', { method: 'POST', body: {} });
      state.detailId = null;
      state.tabs.forEach(t => t.stream.clear());
      toast(`已清空 ${r.deleted} 条记录`);
      await refreshHistory();
    } catch (e) { toast(e.message, 'err'); }
  });
}
function updateHistoryScopeBtn() {
  const b = $('#btn-history-scope');
  b.textContent = state.historyScope === 'all' ? '全部' : '当前脚本';
  b.classList.toggle('active', state.historyScope === 'script');
  b.title = state.historyScope === 'all' ? '显示全部脚本的记录' : '只显示当前选中脚本的记录';
}

/* ========================= 轮询与连接状态 ========================= */

async function refreshRunning() {
  try {
    const r = await api('/api/executions/running');
    state.runningExecs = r.running || [];
    state.runningExecs.forEach(x => { state.lastStatus[x.script_id] = 'running'; });
    updateRunBadges();
    updateFilterCounts();
    updatePageBadge();
    hideOffline();
    refreshDetailStatus();
    // 定时任务页可见时同步刷新
    if (state.view === 'schedules') renderSchedules(true);
  } catch { markOffline(); }
}

function refreshDetailStatus() {
  if (!state.detailId) return;
  const still = state.runningExecs.some(r => r.id === state.detailId);
  const row = $(`.hist-row[data-id="${state.detailId}"]`);
  const rowStatus = row ? ($('.status-pill', row).className.match(/status-pill (\w+)/) || [])[1] : null;
  if (!still && rowStatus === 'running') showHistoryDetail(state.detailId);
}

function markOffline() {
  state.offlineStreak += 1;
  if (state.offlineStreak >= 2) $('#offline').classList.add('show');
}
function hideOffline() {
  state.offlineStreak = 0;
  $('#offline').classList.remove('show');
}

async function checkUv() {
  try {
    const r = await api('/api/system/uv');
    state.uvOk = r.ok;
    state.uvHint = r.install_hint;
    const note = $('#uv-note');
    if (r.ok) {
      note.textContent = '';
      note.className = 'toolbar-note mono';
    } else {
      // 不再弹窗打断：只在工具条留一行可点击的提示，需要时点开看安装方式
      note.className = 'toolbar-note mono warn-note';
      note.innerHTML = '未检测到 uv · 点此查看安装方式';
      note.onclick = () => showUvInstall(r.install_hint);
    }
  } catch { state.uvOk = null; }
}
/* ========================= 5. 定时任务 ========================= */

const CRON_QUICK = [
  ['* * * * *', '每分钟'], ['*/5 * * * *', '每 5 分钟'], ['*/10 * * * *', '每 10 分钟'],
  ['0 * * * *', '每小时'], ['0 */2 * * *', '每 2 小时'], ['0 9 * * *', '每天 09:00'],
  ['0 9 * * 1-5', '工作日 09:00'], ['0 9 * * 0', '每周日 09:00'], ['0 9 1 * *', '每月 1 号'],
];
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

async function fetchSchedules() {
  return api('/api/schedules');
}

/** 定时任务页搜索：按 任务名 / 脚本名 / 预设名 / cron / 徽章 文案 过滤 */
function filterSchedules(list) {
  // 以顶栏搜索框实际值为准，state.schedKw 只作兜底：两者都是关键词，拼在一起会变成「知识知识」而永远搜不到
  const box = $('#search');
  const kw = String((box && state.view === 'schedules' && box.value) || state.schedKw || '').trim().toLowerCase();
  if (!kw) return list;
  return list.filter((s) => {
    const autoDone = !s.enabled && s.max_runs && (s.run_count || 0) >= s.max_runs;
    const badgeTxt = autoDone ? `已完成 ${s.run_count}/${s.max_runs}` : (s.enabled ? '已启用' : '已停用');
    return [s.name, s.script_name, s.preset_name, s.cron, badgeTxt]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(kw));
  });
}

async function renderSchedules(silent = false) {
  const wrap = $('#sched-grid');
  if (silent && wrap.contains(document.activeElement)
      && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  let list = [];
  try { list = await fetchSchedules(); } catch (e) { if (!silent) toast(e.message, 'err'); return; }
  // 乐观补丁（立即运行时的临时状态）
  list = list.map(s => (state.schedPatch[s.id] ? { ...s, ...state.schedPatch[s.id] } : s));
  // 静默轮询：数据没变就整块跳过，否则每 3 秒重绘一次会不停闪烁
  // （搜索词也算进指纹，否则改了关键词界面不会更新）
  const sig = signature(list, SCHED_SIG_FIELDS) + '|' + (state.schedKw || '');
  if (silent && sig === state.schedSig) return;
  state.schedSig = sig;
  state.schedules = list;

  const enabled = list.filter(s => s.enabled).length;
  const badge = $('#sched-badge');
  badge.hidden = enabled === 0;
  badge.textContent = enabled;

  const shown = filterSchedules(list);
  const countEl = $('#sched-count');
  const clearBtn = $('#btn-sched-search-clear');
  const kw = (state.schedKw || '').trim();
  if (countEl) countEl.textContent = kw ? `${shown.length} / ${list.length} 个任务` : `${list.length} 个任务`;
  if (clearBtn) clearBtn.hidden = !kw;

  if (!list.length) {
    wrap.innerHTML = `<div class="empty">还没有定时任务。<div class="empty-act">
      <button class="btn btn-solid" onclick="document.getElementById('btn-new-sched').click()">新建定时任务</button></div></div>`;
    return;
  }
  if (!shown.length) {
    wrap.innerHTML = `<div class="empty">没有匹配「${escapeHtml(kw)}」的定时任务。</div>`;
    return;
  }
  wrap.innerHTML = '';
  // 入场动画只在「本次进入定时任务视图后的首绘」播放；之后所有刷新（轮询 / 运行完成 /
  // 编辑保存 / 删除）都不重播，否则每张卡片都会闪一下。
  const animate = !state.schedAnimated;
  state.schedAnimated = true;
  for (const s of shown) wrap.appendChild(scheduleCard(s, animate));
}

function lastStatusClass(txt) {
  const t = String(txt || '').toLowerCase();
  if (t.includes('running') || t.includes('运行')) return 'last-run';
  if (t.includes('success') || t.includes('成功')) return 'last-ok';
  if (t.includes('fail') || t.includes('error') || t.includes('终止') || t.includes('无效') || t.includes('不存在')) return 'last-fail';
  return '';
}

/** 判断两批定时任务是否等价（轮询时据此决定要不要重绘） */
const SCHED_SIG_FIELDS = ['id', 'enabled', 'cron', 'max_runs', 'run_count', 'next_run', 'last_run', 'last_status'];

/** 上次执行状态 → 简单状态标签（对齐 demo：只显示 成功 / 失败 / 运行中 / 终止 / 暂停） */
function schedStatusPill(lastRun, lastStatus) {
  if (!lastRun) return '<span class="status-pill paused">暂停</span>';
  const cls = lastStatusClass(lastStatus);
  const map = { 'last-ok': ['success', '成功'], 'last-fail': ['failed', '失败'], 'last-run': ['running', '运行中'], '': ['paused', '暂停'] };
  const [c, txt] = map[cls] || map[''];
  return `<span class="status-pill ${c}">${txt}</span>`;
}

/** 只刷新某一张卡片的执行状态，不整块重绘（整块重绘会重放入场动画，看着很闪） */
function setScheduleStatusDom(id, s) {
  const card = $(`.sched-card[data-id="${id}"]`);
  const el = card ? $('.sched-status', card) : null;
  if (el) el.innerHTML = schedStatusPill(s.last_run, s.last_status);
}
/** 重新拉取并只更新这一张卡片的状态 */
async function refreshScheduleStatusDom(id) {
  let list = [];
  try { list = await fetchSchedules(); } catch { return; }
  const s = list.find(x => x.id === id);
  if (!s) return;
  setScheduleStatusDom(id, s);
  // 重算指纹：真实数据变了下一次轮询才会整块刷新，没变就继续跳过，避免无谓重绘
  state.schedSig = signature(list, SCHED_SIG_FIELDS);
}

function scheduleCard(s, animate = true) {
  const card = document.createElement('div');
  card.className = 'sched-card' + (animate ? '' : ' no-anim');
  const maxRuns = s.max_runs;
  const autoDone = !s.enabled && maxRuns && (s.run_count || 0) >= maxRuns;
  const badgeCls = autoDone ? 'done' : s.enabled ? 'on' : 'off';
  const badgeTxt = autoDone ? `已完成 ${s.run_count}/${maxRuns}` : s.enabled ? '已启用' : '已停用';
  // 下次执行：两行排版「下次 / 明天 13:15 · 3 小时后」，近几天用口语化说法
  const nextTxt = !s.enabled
    ? '下次<br><span class="t">—</span>'
    : s.next_run
      ? `下次<br><span class="t">${escapeHtml(smartTime(s.next_run))}</span>${relTime(s.next_run) ? ` · ${escapeHtml(relTime(s.next_run))}` : ''}`
      : '下次<br><span class="t">待计算</span>';
  const presetTxt = s.preset_name ? `预设：「${s.preset_name}」` : '参数：手动输入';
  const lastTxt = `上次：${s.last_run ? smartTime(s.last_run) : '尚未执行'}`;

  card.dataset.id = s.id;
  card.innerHTML = `
    <div class="sched-head">
      <div class="sched-head-left">
        <div class="sched-title" title="点击查看完整参数">${escapeHtml(s.name)}</div>
        <div class="sched-sub mono" title="${escapeHtml(s.script_name || '')}">${escapeHtml(s.script_name || '（脚本已删除）')}</div>
      </div>
      <div class="sched-head-right">
        <span class="sched-badge ${badgeCls}" ${autoDone ? 'title="重新启用后将从 0 重新计数"' : ''}>${escapeHtml(badgeTxt)}</span>
        <label class="sw" title="启用 / 停用">
          <input type="checkbox" ${s.enabled ? 'checked' : ''}><span class="track"></span>
        </label>
      </div>
    </div>
    <div class="sched-cron-row">
      <input class="sched-cron-in" value="${escapeHtml(s.cron)}" title="cron 表达式，失焦自动保存">
      <span class="sched-runs">
        次数 <span class="cur">${s.run_count || 0}</span>/<input type="number" min="-1" value="${maxRuns ? maxRuns : -1}" class="${maxRuns ? 'limited' : ''}" title="执行次数上限，-1 为不限">
      </span>
      <span class="sched-next">${nextTxt}</span>
    </div>
    <div class="sched-meta">
      <span class="preset m-ellip" title="${escapeHtml(presetTxt)}">${escapeHtml(presetTxt)}</span>
      <span class="m-last m-ellip" title="${escapeHtml(lastTxt)}">${escapeHtml(lastTxt)}</span>
      <span class="sched-status">${schedStatusPill(s.last_run, s.last_status)}</span>
    </div>
    <div class="sched-ops">
      <button class="btn btn-solid" data-op="run">▶ 立即运行</button>
      <button class="btn btn-ghost" data-op="edit">编辑</button>
      <button class="btn btn-danger" data-op="del">删除</button>
    </div>`;

  // 启停
  $('.sw input', card).addEventListener('change', async (e) => {
    try {
      await api(`/api/schedules/${s.id}`, { method: 'PUT', body: { enabled: e.target.checked } });
      toast(e.target.checked ? `已启用「${s.name}」` : `已停用「${s.name}」`);
      await renderSchedules();
    } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
  });

  // cron 行内编辑
  bindInlineNumber($('.sched-cron-in', card), {
    get: () => s.cron,
    validate: (v) => {
      if (!v) return 'cron 不能为空';
      if (v.split(/\s+/).length !== 5) return 'cron 需要 5 段：分 时 日 月 周';
      return null;
    },
    transform: (v) => v.trim(),
    save: async (v) => { await api(`/api/schedules/${s.id}`, { method: 'PUT', body: { cron: v } }); toast('执行时间已更新'); },
    after: () => renderSchedules(),
  });

  // 次数上限行内编辑（-1 = 不限 → 传 null）
  bindInlineNumber($('.sched-runs input', card), {
    get: () => (s.max_runs ? s.max_runs : -1),
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n)) return '执行次数需为不小于 1 的整数或 -1（不限）';
      if (n !== -1 && n < 1) return '执行次数需为不小于 1 的整数或 -1（不限）';
      return null;
    },
    transform: (v) => { const n = parseInt(v, 10); return n === -1 ? null : n; },
    save: async (v) => { await api(`/api/schedules/${s.id}`, { method: 'PUT', body: { max_runs: v } }); toast(v === null ? '已设为不限次数' : `执行次数上限已设为 ${v} 次`); },
    after: () => {
      if (!s.enabled && s.max_runs && (s.run_count || 0) >= s.max_runs) {
        toast('该任务已达上限停用，重新启用后将从 0 重新计数', 'warn');
      }
      renderSchedules();
    },
  });

  $('[data-op=run]', card).addEventListener('click', (e) => { e.stopPropagation(); runScheduleNow(s); });
  $('[data-op=edit]', card).addEventListener('click', (e) => { e.stopPropagation(); openScheduleModal(s); });
  $('[data-op=del]', card).addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await confirmModal({ title: '删除定时任务', message: `「${s.name}」将被删除，已产生的执行记录不受影响。`, okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
      toast('已删除');
      await renderSchedules();
    } catch (err) { toast(err.message, 'err'); }
  });
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, input, label, .sw')) return;
    showScheduleDetail(s);
  });
  return card;
}

/** 通用「失焦保存」行内编辑：Enter 提交，Esc 还原 */
function bindInlineNumber(input, { get, validate, transform, save, after }) {
  let saving = false;
  const commit = async () => {
    if (saving) return;
    const raw = input.value.trim();
    if (String(raw) === String(get())) return;
    const err = validate(raw);
    if (err) { input.value = get(); toast(err, 'err'); return; }
    const value = transform ? transform(raw) : raw;
    saving = true;
    try {
      await save(value);
      if (after) await after();
    } catch (e) {
      input.value = get();
      toast(e.message, 'err');
    } finally { saving = false; }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = get(); input.blur(); }
  });
}

async function runScheduleNow(s) {
  // 只把这张卡片的状态标签改成「运行中」，不整块重绘，避免闪烁
  state.schedPatch[s.id] = { last_status: 'running' };
  setScheduleStatusDom(s.id, { ...s, last_status: 'running' });
  const done = () => { delete state.schedPatch[s.id]; refreshScheduleStatusDom(s.id); };
  try {
    await api(`/api/schedules/${s.id}/run`, { method: 'POST' });
    toast(`已触发「${s.name}」`);
    setTimeout(done, 3000);
  } catch (e) {
    toast(e.message, 'err');
    setTimeout(done, 3000);
  }
}

function showScheduleDetail(s) {
  const args = jparse(s.args, {});
  const argChips = Object.entries(args)
    .filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `<span class="arg-chip"><b>${escapeHtml(k)}</b>=${escapeHtml(Array.isArray(v) ? v.join(',') : v)}</span>`).join('');
  const rows = [
    ['执行时间', `<span class="mono">${escapeHtml(s.cron)}</span>`],
    ['执行次数', `${s.run_count || 0} / ${s.max_runs || '不限'}`],
    ['脚本', escapeHtml(s.script_name || '（已删除）')],
    ['参数来源', s.preset_name ? `预设：「${escapeHtml(s.preset_name)}」` : '手动输入'],
    ['参数', argChips ? `<div class="arg-preview">${argChips}</div>` : '无参数'],
    ['上次执行', s.last_run ? `${escapeHtml(fmtTime(s.last_run))}${s.last_status ? ` · <span class="${lastStatusClass(s.last_status)}">${escapeHtml(s.last_status)}</span>` : ''}` : '尚未执行'],
    ['下次执行', s.enabled ? (s.next_run ? `${escapeHtml(fmtTime(s.next_run))} <span style="color:var(--ink-4)">（${escapeHtml(relTime(s.next_run))}）</span>` : '待计算') : '已停用'],
    ['创建时间', s.created_at ? escapeHtml(fmtFull(s.created_at)) : '—'],
  ];
  openModal({
    title: '定时任务详情',
    body: `<div class="detail-rows">${rows.map(([k, v]) =>
      `<div class="detail-row"><div class="k">${escapeHtml(k)}</div><div class="v">${v}</div></div>`).join('')}</div>`,
    foot: [{ label: '关闭' }, { label: '编辑', primary: true, onClick: () => { closeModal(); openScheduleModal(s); } }],
  });
}

/* ---------- 新建 / 编辑定时任务 ---------- */
let schedCtx = { scripts: [], scriptId: null, schema: [], presets: [] };

async function openScheduleModal(sched) {
  const isEdit = !!sched;
  schedCtx = { scripts: [], scriptId: null, schema: [], presets: [], editingId: isEdit ? sched.id : null };
  let scripts = [];
  try { scripts = await api('/api/scripts'); } catch { scripts = []; }
  if (!scripts.length) { toast('请先导入脚本', 'warn'); return; }
  schedCtx.scripts = scripts;

  const current = sched ? {
    name: sched.name,
    scriptId: sched.script_id,
    cron: sched.cron,
    maxRuns: sched.max_runs ? sched.max_runs : -1,
    enabled: !!sched.enabled,
    presetId: sched.preset_id || null,
    args: jparse(sched.args, {}),
  } : {
    name: '', scriptId: scripts[0].id, cron: '0 9 * * *', maxRuns: -1, enabled: true, presetId: null, args: {},
  };
  schedCtx.current = current;

  const body = `
    <div class="mfield"><label>任务名称 <span class="req">*</span></label>
      <input type="text" id="sc-name" value="${escapeHtml(current.name || '')}" placeholder="如：每日数据同步"></div>
    <div class="mfield"><label>选择脚本 <span class="req">*</span></label>
      <select id="sc-script">${scripts.map(s =>
        `<option value="${s.id}" ${s.id === current.scriptId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select></div>
    <div class="mfield"><label>参数预设</label>
      <select id="sc-preset"><option value="">手动输入参数</option></select></div>
    <div class="mfield"><label>cron 表达式 <span class="req">*</span></label>
      <input type="text" class="mono" id="sc-cron" value="${escapeHtml(current.cron)}" placeholder="0 9 * * *">
      <div class="hint" id="sc-preview">分 时 日 月 周</div>
      <div class="cron-quick">${CRON_QUICK.map(([c, l]) =>
        `<button data-cron="${escapeHtml(c)}">${escapeHtml(l)}</button>`).join('')}</div></div>
    <div class="mfield"><label>可视化构建</label>
      <div class="builder">
        <div class="builder-row">
          <label>频率</label>
          <select id="sc-freq">
            <option value="minute">按分钟</option><option value="hour">按小时</option>
            <option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option>
          </select>
          <span id="sc-builder-opts" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"></span>
        </div>
      </div></div>
    <div class="mfield"><label>参数（来自预设或手动填写）</label>
      <div id="sc-fields"></div></div>
    <div class="mfield-row">
      <div class="mfield"><label>执行次数上限</label>
        <input type="number" id="sc-max-runs" value="${current.maxRuns}" min="-1">
        <div class="hint">-1 表示不限次数</div></div>
      <div class="mfield"><label>状态</label>
        <label class="switch" style="margin-top:8px"><input type="checkbox" id="sc-enabled" ${current.enabled ? 'checked' : ''}><span class="track"></span><span class="sw-val">${current.enabled ? '启用' : '停用'}</span></label></div>
    </div>`;

  openModal({
    title: isEdit ? '编辑定时任务' : '新建定时任务',
    wide: true,
    body,
    foot: [
      ...(isEdit ? [{ label: '删除', danger: true, left: true, onClick: async () => {
        closeModal();
        const ok = await confirmModal({ title: '删除定时任务', message: `「${sched.name}」将被删除。`, okText: '删除', danger: true });
        if (!ok) return;
        await api(`/api/schedules/${sched.id}`, { method: 'DELETE' });
        toast('已删除');
        await renderSchedules();
      } }] : []),
      { label: '取消' },
      { label: isEdit ? '保存' : '创建', primary: true, onClick: submitSchedule },
    ],
  });

  // 脚本切换 → 重新拉 schema / presets / 参数
  $('#sc-script').addEventListener('change', () => loadSchedScript($('#sc-script').value));
  $('#sc-preset').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    const args = opt && opt.dataset.args ? jparse(opt.dataset.args, {}) : {};
    renderSchedFields(args);
  });
  $('#sc-enabled').addEventListener('change', (e) => {
    e.target.nextElementSibling.nextElementSibling.textContent = e.target.checked ? '启用' : '停用';
  });
  $$('#modal-body [data-cron]').forEach(b => b.addEventListener('click', () => {
    $('#sc-cron').value = b.dataset.cron;
    previewCron();
    syncBuilderFromCron();
  }));
  $('#sc-cron').addEventListener('input', previewCron);
  $('#sc-freq').addEventListener('change', () => { renderBuilderOpts(); buildCronFromBuilder(); });
  $('#sc-builder-opts').addEventListener('input', () => buildCronFromBuilder());
  $('#sc-builder-opts').addEventListener('change', () => buildCronFromBuilder());

  await loadSchedScript(current.scriptId, current.args, current.presetId);
  renderBuilderOpts();
  syncBuilderFromCron();
  previewCron();
}

async function loadSchedScript(scriptId, presetArgs, presetId) {
  schedCtx.scriptId = Number(scriptId);
  schedCtx.schema = []; schedCtx.presets = [];
  try {
    const detail = await api(`/api/scripts/${scriptId}`);
    schedCtx.schema = detail.args_schema || [];
    schedCtx.presets = detail.presets || [];
  } catch { /* 保持空 */ }
  const sel = $('#sc-preset');
  if (sel) {
    sel.innerHTML = '<option value="">手动输入参数</option>'
      + schedCtx.presets.map(p => `<option value="${p.id}" data-args='${escapeHtml(JSON.stringify(p.args || {}))}'>${escapeHtml(p.name)}</option>`).join('');
    if (presetId && schedCtx.presets.some(p => p.id === presetId)) sel.value = String(presetId);
  }
  renderSchedFields(presetArgs || (schedCtx.current && schedCtx.current.args) || {});
}
function renderSchedFields(values) {
  const box = $('#sc-fields');
  if (!box) return;
  const schema = schedCtx.schema || [];
  if (!schema.length) { box.innerHTML = '<div style="font-size:12px;color:var(--ink-4)">该脚本没有可配置参数。</div>'; return; }
  box.innerHTML = '';
  for (const a of schema) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.dataset.dest = a.dest;
    const t = typeLabelOf(a);
    const v = values[a.dest];
    wrap.innerHTML = `<label><span class="name">${escapeHtml(a.dest)}</span>
      ${a.required ? '<span class="req">*</span>' : ''}<span class="type ${t}">${t}</span></label>`;
    if (a.is_flag) {
      const sw = document.createElement('label');
      sw.className = 'switch';
      const on = !!v;
      sw.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><span class="track"></span>`;
      wrap.appendChild(sw);
    } else if (a.choices && a.choices.length) {
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">（不传）</option>` + a.choices.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      sel.value = v == null ? '' : String(v);
      wrap.appendChild(sel);
    } else {
      const inp = document.createElement('input');
      inp.type = (a.type === 'int' || a.type === 'float') ? 'number' : 'text';
      inp.value = Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));
      wrap.appendChild(inp);
    }
    box.appendChild(wrap);
  }
}
function collectSchedFields() {
  const schema = schedCtx.schema || [];
  const values = {};
  for (const a of schema) {
    const f = $(`.field[data-dest="${CSS.escape(a.dest)}"]`, $('#sc-fields'));
    if (!f) continue;
    if (a.is_flag) { values[a.dest] = !!($('input', f) && $('input', f).checked); continue; }
    const sel = $('select', f), inp = $('input', f);
    const raw = ((sel ? sel.value : inp ? inp.value : '')).trim();
    if (a.nargs || a.action === 'append') { values[a.dest] = raw ? raw.split(/[,，\s]+/).filter(Boolean) : []; continue; }
    if (a.type === 'int' || a.type === 'float') { values[a.dest] = raw === '' ? '' : Number(raw); continue; }
    values[a.dest] = raw;
  }
  return values;
}

const previewCron = debounce(async () => {
  const el = $('#sc-preview');
  if (!el) return;
  const cron = ($('#sc-cron').value || '').trim();
  if (!cron) { el.className = 'hint'; el.textContent = '分 时 日 月 周'; return; }
  try {
    const r = await api('/api/schedules/preview', { method: 'POST', body: { cron } });
    el.className = 'hint ok';
    el.textContent = `下次执行：${fmtFull(r.next)}（${relTime(r.next)}）`;
  } catch (e) {
    el.className = 'hint err';
    el.textContent = e.message;
  }
}, 400);

async function submitSchedule() {
  const name = $('#sc-name').value.trim();
  const cron = $('#sc-cron').value.trim();
  const scriptId = Number($('#sc-script').value);
  const maxRaw = parseInt($('#sc-max-runs').value, 10);
  if (!name) { toast('请填写任务名称', 'err'); return; }
  if (!cron) { toast('请填写 cron 表达式', 'err'); return; }
  if (isNaN(maxRaw) || maxRaw < -1 || maxRaw === 0) { toast('执行次数上限需为不小于 1 的整数或 -1', 'err'); return; }
  const presetSel = $('#sc-preset');
  const presetId = presetSel && presetSel.value ? Number(presetSel.value) : null;
  const args = collectSchedFields();
  const enabled = $('#sc-enabled').checked;
  const max_runs = maxRaw === -1 ? null : maxRaw;
  const isEdit = schedCtx.editingId != null;
  try {
    if (isEdit) {
      await api(`/api/schedules/${schedCtx.editingId}`, { method: 'PUT', body: { name, cron, enabled, args, max_runs, preset_id: presetId } });
      toast('已保存');
    } else {
      await api('/api/schedules', { method: 'POST', body: { script_id: scriptId, name, cron, enabled, args, max_runs, preset_id: presetId } });
      toast('定时任务已创建');
    }
    closeModal();
    await renderSchedules();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- 可视化 cron 构建 ---------- */
function renderBuilderOpts() {
  const box = $('#sc-builder-opts');
  const freq = $('#sc-freq').value;
  const num = (id, label, val, attrs = '') =>
    `<label style="font-size:11px;color:var(--ink-3)">${label}</label><input type="number" id="${id}" value="${val}" ${attrs}>`;
  if (freq === 'minute') {
    box.innerHTML = num('sc-n', '每', 5, 'min="1" max="59"');
  } else if (freq === 'hour') {
    box.innerHTML = num('sc-nh', '每', 2, 'min="1" max="23"') + num('sc-mh', '第', 0, 'min="0" max="59"') + '<label style="font-size:11px;color:var(--ink-3)">小时的第 N 分执行</label>';
  } else if (freq === 'daily') {
    box.innerHTML = '<input type="time" id="sc-time" value="09:00">';
  } else if (freq === 'weekly') {
    box.innerHTML = '<input type="time" id="sc-time" value="09:00"><div class="wd-group" id="sc-wd">'
      + WEEK_LABELS.map((w, i) => `<button class="wd ${i === 0 ? 'on' : ''}" data-wd="${i}">周${w}</button>`).join('') + '</div>';
  } else {
    box.innerHTML = '<input type="time" id="sc-time" value="09:00">'
      + num('sc-md', '每月', 1, 'min="1" max="28"') + '<label style="font-size:11px;color:var(--ink-3)">号</label>';
  }
  $$('#sc-wd .wd', box).forEach(b => b.addEventListener('click', () => {
    b.classList.toggle('on');
    buildCronFromBuilder();
  }));
}
function buildCronFromBuilder() {
  const freq = $('#sc-freq').value;
  let cron = '';
  if (freq === 'minute') cron = `*/${$('#sc-n').value || 5} * * * *`;
  else if (freq === 'hour') cron = `${$('#sc-mh').value || 0} */${$('#sc-nh').value || 2} * * *`;
  else {
    const t = ($('#sc-time').value || '09:00').split(':');
    const mm = String(t[0] || 0).padStart(2, '0'), hh = String(t[1] || 9).padStart(2, '0');
    if (freq === 'daily') cron = `${mm} ${hh} * * *`;
    else if (freq === 'monthly') cron = `${mm} ${hh} ${$('#sc-md').value || 1} * *`;
    else {
      const on = $$('#sc-wd .wd.on').map(b => Number(b.dataset.wd));
      if (!on.length) { toast('请至少选择一个星期', 'warn'); return; }
      const cronDays = on.map(i => (i === 6 ? 0 : i + 1)).sort().join(',');
      cron = `${mm} ${hh} * * ${cronDays}`;
    }
  }
  $('#sc-cron').value = cron;
  previewCron();
}
function syncBuilderFromCron() {
  const cron = ($('#sc-cron').value || '').trim();
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return;
  const [mm, hh, dom, mon, dow] = parts;
  const setFreq = (f) => { $('#sc-freq').value = f; renderBuilderOpts(); };
  if (/^\*\/\d+$/.test(mm)) { setFreq('minute'); $('#sc-n').value = mm.slice(2); return; }
  if (/^\*\/\d+$/.test(hh)) {
    setFreq('hour'); $('#sc-mh').value = parseInt(mm, 10) || 0; $('#sc-nh').value = hh.slice(2); return;
  }
  const timeVal = `${String(parseInt(hh, 10) || 0).padStart(2, '0')}:${String(parseInt(mm, 10) || 0).padStart(2, '0')}`;
  if (/^\d+$/.test(dom) && dom !== '1') {
    setFreq('monthly'); $('#sc-time').value = timeVal; $('#sc-md').value = parseInt(dom, 10); return;
  }
  if (dow !== '*') {
    setFreq('weekly'); $('#sc-time').value = timeVal;
    $$('#sc-wd .wd').forEach(b => {
      const cronDay = Number(b.dataset.wd) === 6 ? 0 : Number(b.dataset.wd) + 1;
      b.classList.toggle('on', dow.split(',').includes(String(cronDay)));
    });
    return;
  }
  setFreq('daily');
  $('#sc-time').value = timeVal;
}
/* ========================= 6. 弹窗 ========================= */

let modalCleanup = null;

function openModal({ title, body, foot = [], wide = false }) {
  if (modalCleanup) modalCleanup();
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  const footBox = $('#modal-foot');
  footBox.innerHTML = '';
  for (const f of foot) {
    const b = document.createElement('button');
    b.className = `btn ${f.primary ? 'btn-solid' : f.danger ? 'btn-danger' : 'btn-ghost'}${f.left ? ' btn-left' : ''}`;
    b.textContent = f.label;
    // 没指定动作的按钮一律当作「关闭」，避免出现点了没反应的按钮
    b.addEventListener('click', () => (f.onClick ? f.onClick(b) : closeModal()));
    footBox.appendChild(b);
  }
  $('#modal').classList.toggle('wide', !!wide);
  $('#modal-mask').classList.add('show');
  if (DEBUG) debugReport('modal:' + title);
  const onMask = (e) => { if (e.target === $('#modal-mask')) closeModal(); };
  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  $('#modal-mask').addEventListener('click', onMask);
  $('#modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', onKey);
  modalCleanup = () => {
    $('#modal-mask').removeEventListener('click', onMask);
    $('#modal-close').removeEventListener('click', closeModal);
    document.removeEventListener('keydown', onKey);
  };
}
function closeModal() {
  $('#modal-mask').classList.remove('show');
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
}
function confirmModal({ title = '确认操作', message, okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    openModal({
      title,
      body: `<div style="font-size:13px;color:var(--ink-2);line-height:1.7">${escapeHtml(message).replace(/\n/g, '<br>')}</div>`,
      foot: [
        { label: '取消', onClick: () => finish(false) },
        { label: okText, primary: !danger, danger, onClick: () => finish(true) },
      ],
    });
    const mask = $('#modal-mask');
    const obs = new MutationObserver(() => {
      if (!mask.classList.contains('show')) { obs.disconnect(); finish(false); }
    });
    obs.observe(mask, { attributes: true, attributeFilter: ['class'] });
  });
}

/* ---------- 导入脚本 ---------- */
function openImportModal(mode = 'file') {
  let cur = mode;
  const render = () => {
    const isScan = cur === 'scan';
    openModal({
      title: '导入脚本',
      body: `
        <div class="mfield">
          <div class="radio-cards" id="add-mode">
            <label class="radio-card ${!isScan ? 'on' : ''}"><input type="radio" name="addmode" value="file" ${!isScan ? 'checked' : ''}>单个脚本文件</label>
            <label class="radio-card ${isScan ? 'on' : ''}"><input type="radio" name="addmode" value="scan" ${isScan ? 'checked' : ''}>扫描目录批量导入</label>
          </div>
        </div>
        <div class="mfield">
          <label>${isScan ? '目录路径' : '脚本路径'}</label>
          <div style="display:flex;gap:8px">
            <input type="text" class="mono" id="add-path" style="flex:1" placeholder="${isScan ? '/Users/you/code' : '/Users/you/code/xxx.py'}" value="${escapeHtml(localStorage.getItem('last_scan_dir') || '')}">
            ${isScan ? '' : '<button class="btn btn-ghost" id="add-browse" style="flex-shrink:0">选择文件…</button>'}
          </div>
          <div class="hint" id="add-hint">${isScan ? '递归扫描目录下的 .py 文件，自动解析含 argparse 的脚本' : '选择文件会把脚本复制到启动器管理目录（imported/）'}</div>
        </div>
        ${isScan ? `
        <div class="mfield">
          <label class="switch"><input type="checkbox" id="add-recursive" checked><span class="track"></span><span class="sw-val">递归扫描所有子目录</span></label>
        </div>` : `
        <div class="mfield"><label>显示名（留空则用文件名）</label>
          <input type="text" id="add-name" placeholder="如：数据管道"></div>`}
        <input type="file" id="add-file" accept=".py" hidden>`,
      foot: [
        { label: '取消' },
        { label: isScan ? '开始扫描' : '导入', primary: true, onClick: (b) => doImport(b, isScan) },
      ],
    });
    $$('#add-mode .radio-card').forEach(card => card.addEventListener('click', () => {
      const v = $('input', card).value;
      if (v === cur) return;
      cur = v;
      render();
    }));
    const rec = $('#add-recursive');
    if (rec) rec.addEventListener('change', () => {
      $('.sw-val', rec.parentElement).textContent = rec.checked ? '递归扫描所有子目录' : '仅当前目录';
    });
    const browse = $('#add-browse');
    if (browse) browse.addEventListener('click', () => $('#add-file').click());
    const file = $('#add-file');
    if (file) file.addEventListener('change', () => { if (file.files[0]) uploadScript(file.files[0]); });
  };
  render();
}

async function doImport(btn, isScan) {
  const path = $('#add-path').value.trim();
  if (!path) { toast('请输入路径', 'warn'); return; }
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  try {
    if (isScan) {
      const r = await api('/api/scripts/scan', { method: 'POST', body: { directory: path, recursive: $('#add-recursive').checked } });
      localStorage.setItem('last_scan_dir', path);
      closeModal();
      await loadScripts();
      await refreshHistory();
      showScanResult(r);
    } else {
      const body = { path };
      const name = $('#add-name').value.trim();
      if (name) body.name = name;
      const r = await api('/api/scripts/import', { method: 'POST', body });
      closeModal();
      toast(`已导入 ${r.script.name}`);
      await loadScripts();
      await selectScript(r.script.id);
    }
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function uploadScript(file) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    toast('正在上传…');
    const res = await fetch('/api/scripts/upload', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || '上传失败');
    closeModal();
    toast(`已导入 ${data.script.name}`);
    await loadScripts();
    await selectScript(data.script.id);
  } catch (e) {
    toast('导入失败：' + e.message, 'err');
  }
}

function showScanResult(r) {
  const skipped = (r.skipped || []).map(s => `<div>· ${escapeHtml(s.path)} — ${escapeHtml(s.error)}</div>`).join('');
  openModal({
    title: '扫描完成',
    body: `<div class="result-summary">
      共发现 ${r.total} 个文件，成功导入 <b>${(r.imported || []).length}</b> 个${(r.skipped || []).length ? `，跳过 ${r.skipped.length} 个` : ''}。
      ${skipped ? `<div class="skipped">${skipped}</div>` : ''}
      </div>`,
    foot: [{ label: '知道了', primary: true, onClick: closeModal }],
  });
}

/* ---------- 编辑脚本信息 ---------- */
function openMetaModal() {
  const s = state.script;
  if (!s) return;
  openModal({
    title: '编辑脚本信息',
    body: `
      <div class="mfield"><label>名称 <span class="req">*</span></label>
        <input type="text" id="meta-name" value="${escapeHtml(s.name)}"></div>
      <div class="mfield"><label>描述</label>
        <textarea id="meta-desc" placeholder="这个脚本做什么、怎么用">${escapeHtml(s.description || '')}</textarea></div>
      <div class="mfield"><label>标签（逗号分隔）</label>
        <input type="text" id="meta-tags" value="${escapeHtml((s.tags || []).join(', '))}" placeholder="data, etl, daily"></div>
      <div class="mfield"><label>依赖文件路径</label>
        <input type="text" class="mono" id="meta-deps" value="${escapeHtml(s.deps_path || '')}" placeholder="留空自动检测脚本目录 requirements.txt">
        <div class="hint">指定后「安装依赖」会优先使用该文件</div></div>`,
    foot: [
      { label: '取消' },
      { label: '保存', primary: true, onClick: async () => {
        const name = $('#meta-name').value.trim();
        if (!name) { toast('名称不能为空', 'err'); return; }
        const tags = $('#meta-tags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
        try {
          await api(`/api/scripts/${s.id}`, {
            method: 'PUT',
            body: { name, description: $('#meta-desc').value.trim(), deps_path: $('#meta-deps').value.trim(), tags },
          });
          closeModal();
          toast('已保存');
          await loadScripts();
          await selectScript(s.id);
        } catch (e) { toast(e.message, 'err'); }
      } },
    ],
  });
  setTimeout(() => { const d = $('#meta-desc'); if (d) d.focus(); }, 60);
}

/* ---------- 更换虚拟环境 ---------- */
async function openVenvSettings() {
  const s = state.script;
  if (!s) return;
  let managers = [];
  try { managers = (await api('/api/env/managers')).managers || []; } catch { /* 忽略 */ }

  const bodyFor = (tab) => `
    <div class="seg" id="venv-tabs" style="margin-bottom:14px">
      <button class="${tab === 'select' ? 'on' : ''}" data-vt="select">选择已有环境</button>
      <button class="${tab === 'manual' ? 'on' : ''}" data-vt="manual">手动输入路径</button>
    </div>
    <div id="venv-pane"></div>
    <div class="mfield" style="margin-top:16px;margin-bottom:0">
      <label>本机环境管理器</label>
      <div class="env-managers">${managers.length
        ? managers.map(m => `<span class="env-manager">${escapeHtml(m.name)}<span class="ver">${escapeHtml(m.version || '')}</span></span>`).join('')
        : '<span style="font-size:12px;color:var(--ink-4)">未检测到 uv / conda</span>'}</div>
    </div>`;

  openModal({ title: '更换虚拟环境', body: bodyFor('select'), foot: [
    { label: '取消' },
    { label: '保存', primary: true, onClick: saveVenv },
  ] });

  const renderPane = (tab) => {
    const pane = $('#venv-pane');
    if (tab === 'select') {
      pane.innerHTML = `
        <div class="mfield"><label>虚拟环境</label>
          <div style="display:flex;gap:8px">
            <select id="venv-sel" style="flex:1"><option value="">加载中…</option></select>
            <button class="btn btn-ghost" id="venv-scan" style="flex-shrink:0">重新扫描</button>
          </div>
          <div class="hint" id="venv-preview"></div></div>`;
      $('#venv-scan').addEventListener('click', () => scanVenvs(false));
      $('#venv-sel').addEventListener('change', updatePreview);
      scanVenvs(true);
    } else {
      pane.innerHTML = `
        <div class="mfield"><label>虚拟环境路径</label>
          <input type="text" class="mono" id="venv-manual" value="${escapeHtml(s.venv_path || '')}" placeholder="/Users/you/.venvs/myenv">
          <div class="hint">可填虚拟环境根目录，或直接填 python 可执行文件路径</div></div>`;
      $('#venv-manual').addEventListener('input', updatePreview);
      updatePreview();
    }
  };
  const activate = (tab) => {
    $$('#venv-tabs button').forEach(b => b.classList.toggle('on', b.dataset.vt === tab));
    renderPane(tab);
  };
  $$('#venv-tabs button').forEach(b => b.addEventListener('click', () => activate(b.dataset.vt)));
  activate('select');

  async function scanVenvs(useCache) {
    const btn = $('#venv-scan');
    if (!btn) return;
    const sel = $('#venv-sel');
    if (useCache && state.venvScanned) { fillVenvOptions(state.venvScanned); return; }
    btn.disabled = true;
    btn.textContent = '扫描中…';
    try {
      const data = (await api('/api/env/venvs')).venvs || [];
      state.venvScanned = data;
      fillVenvOptions(data);
      toast(`已扫描到 ${data.length} 个虚拟环境`);
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = '重新扫描'; }
  }
  function fillVenvOptions(venvs) {
    const sel = $('#venv-sel');
    if (!sel) return;
    const cur = s.venv_path || '';
    sel.innerHTML = '<option value="">默认（脚本目录 .venv）</option>'
      + (venvs.length ? `<optgroup label="已检测到的虚拟环境">${venvs.map(v =>
        `<option value="${escapeHtml(v.path)}" title="${escapeHtml(v.python || '')}">${escapeHtml(v.name)}（${escapeHtml(v.type)}）</option>`).join('')}</optgroup>` : '')
      + (cur && !venvs.some(v => v.path === cur) ? `<option value="${escapeHtml(cur)}" selected>自定义：${escapeHtml(cur)}</option>` : '');
    sel.value = cur;
    updatePreview();
  }
  function currentVenvValue() {
    const manual = $('#venv-manual');
    return manual ? manual.value.trim() : ($('#venv-sel') ? $('#venv-sel').value : '');
  }
  function updatePreview() {
    const el = $('#venv-preview');
    if (!el) return;
    const v = currentVenvValue();
    const env = s.env || {};
    if (v) { el.className = 'hint ok'; el.textContent = `将使用：${v}`; }
    else { el.className = 'hint'; el.textContent = `当前：默认（脚本目录 .venv）${env.venv_python ? ' · ' + env.venv_python : ''}`; }
  }
  async function saveVenv() {
    const v = currentVenvValue();
    try {
      await api(`/api/scripts/${s.id}`, { method: 'PUT', body: { venv_path: v } });
      s.venv_path = v;
      closeModal();
      toast(v ? '已切换虚拟环境' : '已恢复默认环境');
      await reloadEnv();
      refreshCmd();
    } catch (e) { toast(e.message, 'err'); }
  }
}

/* ---------- 预设管理 ---------- */
function openPresetManager(all) {
  const render = () => {
    const list = all.slice();
    const rows = list.map(p => `
      <div class="list-row" data-id="${p.id}">
        <span class="nm clickable" data-act="apply" title="点击应用">${p.pinned ? '📌 ' : ''}${escapeHtml(p.name)}</span>
        <button class="icon-mini ${p.pinned ? 'on' : ''}" data-act="pin" title="固定 / 取消固定">📌</button>
        <button class="icon-mini" data-act="up" title="上移">↑</button>
        <button class="icon-mini" data-act="down" title="下移">↓</button>
        <button class="icon-mini danger" data-act="del" title="删除">✕</button>
      </div>`).join('');
    openModal({
      title: `全部预设 · ${all.length} 个`,
      body: list.length ? `<div class="list-box">${rows}</div>
        <div class="hint" style="margin-top:8px;color:var(--ink-4);font-size:11px">
        顺序：固定项在前，组内按手动排序，再按创建时间倒序。</div>` : '<div class="empty" style="padding:30px">还没有预设</div>',
      foot: [{ label: '关闭', onClick: closeModal }, { label: '新建预设', primary: true, onClick: () => openSavePreset() }],
    });
    const box = $('.list-box', $('#modal-body'));
    if (box) {
      box.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = Number(btn.closest('.list-row').dataset.id);
        const p = all.find(x => x.id === id);
        const act = btn.dataset.act;
        if (act === 'apply') { closeModal(); applyPreset(p); return; }
        if (act === 'del') { askDeletePreset(btn, p, () => renderPresets()); all.splice(all.indexOf(p), 1); render(); return; }
        try {
          if (act === 'pin') {
            const r = await api(`/api/presets/${id}`, { method: 'PATCH', body: { pinned: !p.pinned } });
            p.pinned = r.preset ? !!r.preset.pinned : !p.pinned;
          } else {
            await api(`/api/presets/${id}`, { method: 'PATCH', body: { order: act } });
            const i = all.indexOf(p);
            const j = act === 'up' ? i - 1 : i + 1;
            if (j >= 0 && j < all.length) { all.splice(i, 1); all.splice(j, 0, p); }
          }
          render();
          await reloadPresets();
          renderPresets();
        } catch (err) { toast('操作失败：' + err.message, 'err'); }
      });
    }
  };
  render();
}
async function reloadPresets() {
  try {
    const detail = await api(`/api/scripts/${state.selectedId}`);
    state.script.presets = detail.presets || [];
    renderPresets();
  } catch { /* 忽略 */ }
}

function openSavePreset() {
  const existing = state.script.presets || [];
  let pending = null;
  const body = `
    <div class="mfield"><label>预设名称 <span class="req">*</span></label>
      <input type="text" id="preset-name" placeholder="如：生产环境"></div>
    ${existing.length ? `<div class="mfield"><label>或点击已有预设覆盖它</label>
      <div class="preset-chips" id="preset-overwrite">${existing.map(p =>
        `<button class="preset-chip" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>`).join('')}</div></div>` : ''}`;
  openModal({
    title: '保存为预设',
    body,
    foot: [
      { label: '取消' },
      { label: '保存', primary: true, onClick: async () => {
        const name = ($('#preset-name').value || '').trim();
        if (!name) { toast('请填写预设名称', 'err'); return; }
        const dup = existing.find(p => p.name === name);
        if (dup && pending !== name) {
          pending = name;
          $('#preset-name').value = '';
          toast(`「${name}」已存在，再点一次「保存」覆盖它`, 'warn');
          return;
        }
        const values = collectValues();
        const cp = getCmdParts(state.selectedId);
        try {
          const r = await api(`/api/scripts/${state.selectedId}/presets`, {
            method: 'POST',
            body: { name, args: values, cmd_prefix: cp.prefix, cmd_suffix: cp.suffix },
          });
          closeModal();
          toast(r.overwritten ? `已覆盖预设「${name}」` : '预设已保存');
          await reloadPresets();
        } catch (e) { toast(e.message, 'err'); }
      } },
    ],
  });
  const ow = $('#preset-overwrite');
  if (ow) ow.addEventListener('click', async (e) => {
    const chip = e.target.closest('.preset-chip');
    if (!chip) return;
    const name = chip.dataset.name;
    const values = collectValues();
    try {
      const r = await api(`/api/scripts/${state.selectedId}/presets`, { method: 'POST', body: { name, args: values } });
      closeModal();
      toast(r.overwritten ? `已覆盖预设「${name}」` : '预设已保存');
      await reloadPresets();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ---------- 命令行导入 ---------- */
function openCmdImport() {
  if (!state.script) { toast('请先选择一个脚本', 'warn'); return; }
  if (!(state.script.args_schema || []).length) { toast('该脚本没有可解析的命令行参数', 'warn'); return; }
  const hasPos = state.script.args_schema.some(a => a.kind === 'positional');
  openModal({
    title: '命令行导入参数',
    body: `
      <div class="mfield"><label>粘贴一条完整命令或参数片段</label>
        <textarea class="mono" id="cmd-import" placeholder="${hasPos ? 'python xxx.py --date 2026-10-09 --batch 100' : 'python xxx.py --key value'}"></textarea>
        <div class="hint">支持完整命令（自动剥离 uv run / python 前缀）与纯参数片段；引号包裹的值会正确解析</div></div>
      <div id="cmd-import-result"></div>`,
    foot: [
      { label: '取消' },
      { label: '解析并回填', primary: true, onClick: doParseCommand },
    ],
  });
  setTimeout(() => { const t = $('#cmd-import'); if (t) t.focus(); }, 60);
}
async function doParseCommand() {
  const command = $('#cmd-import').value.trim();
  const box = $('#cmd-import-result');
  if (!command) { toast('请先粘贴命令', 'warn'); return; }
  try {
    const res = await api(`/api/scripts/${state.selectedId}/parse-command`, { method: 'POST', body: { command } });
    const filled = Object.keys(res.parsed || {}).length;
    const issues = [];
    if ((res.missing || []).length) issues.push(`<div class="hint err">缺少必填：${res.missing.map(escapeHtml).join('、')}</div>`);
    if ((res.unknown || []).length) issues.push(`<div class="hint err">未识别的参数：${res.unknown.map(escapeHtml).join('、')}</div>`);
    if ((res.extra || []).length) issues.push(`<div class="hint err">多余的位置参数：${res.extra.map(escapeHtml).join('、')}</div>`);
    const errs = Object.entries(res.errors || {});
    if (errs.length) issues.push('<div class="hint err">' + errs.map(([k, v]) =>
      `${escapeHtml(k)}：${Array.isArray(v) ? v.map(escapeHtml).join('；') : escapeHtml(v)}`).join('<br>') + '</div>');
    box.innerHTML = `<div class="hint ${issues.length ? 'err' : 'ok'}">已解析 ${filled} 个参数${issues.length ? '' : '，已回填表单'}</div>${issues.join('')}`;
    fillValues(res.parsed || {});
    await saveArgs(collectValues());
    refreshCmd();
    if (!filled) { toast('未解析到可识别的参数', 'err'); return; }
    if (issues.length) { toast('已回填，请查看下方提示', 'warn'); return; }
    closeModal();
    toast(`已解析 ${filled} 个参数并回填`);
  } catch (e) {
    box.innerHTML = `<div class="hint err">${escapeHtml(e.message)}</div>`;
  }
}

function showUvInstall(hint) {
  if (!hint) return;
  openModal({
    title: '未检测到 uv',
    body: `<div style="font-size:13px;color:var(--ink-2);line-height:1.8">
      uv 负责自动创建虚拟环境并安装依赖，缺少它时只能使用脚本自带的 .venv。<br>当前平台：<b>${escapeHtml(hint.platform || '')}</b>
      <div class="result-summary mono" style="margin-top:10px">${escapeHtml(hint[hint.platform] || hint.mac || '')}</div></div>`,
    foot: [{ label: '知道了', primary: true, onClick: closeModal }],
  });
}

/* ========================= 7. 顶栏与初始化 ========================= */

/** 顶栏搜索框在「脚本 / 定时任务」两个 tab 间复用：
 *  同一个输入框、切过去就换 placeholder 和搜索目标，各自记住自己的关键词。 */
function syncTopSearch() {
  const box = $('#search');
  if (!box) return;
  const isSched = state.view === 'schedules';
  box.placeholder = isSched ? '搜索定时任务 / 脚本名 / 预设 / cron…' : '搜索脚本…';
  box.value = isSched ? (state.schedKw || '') : (state.kw || '');
}

function switchView(name) {
  state.view = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.hdr-nav .nav-btn').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  $('#search').style.visibility = (name === 'scripts' || name === 'schedules') ? '' : 'hidden';
  syncTopSearch();
  // 抽屉遮罩会挡住整页，切到别的页面时自动收起
  if (name !== 'scripts') closeDrawer();
  if (name === 'history') { refreshHistory(); }
  if (name === 'schedules') { state.schedAnimated = false; renderSchedules(); }
  if (name === 'settings') { syncSettingsView(); fillSettingsAbout(); loadRunEnv(); }
  closeRunPopover();
  if (DEBUG) debugReport('view:' + name);
}

function initTopbar() {
  $$('.hdr-nav .nav-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#brand').addEventListener('click', () => switchView('scripts'));

  // 同一个搜索框按当前 tab 分派：脚本 tab 搜脚本，定时任务 tab 搜定时任务
  $('#search').addEventListener('input', debounce((e) => {
    const v = e.target.value;
    if (state.view === 'schedules') { state.schedKw = v; renderSchedules(); }
    else { state.kw = v; renderGrid(); }
  }, 160));

  $('#seg-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    state.filter = b.dataset.f;
    $$('#seg-filter button').forEach(x => x.classList.toggle('on', x === b));
    renderGrid();
  });

  $('#btn-add').addEventListener('click', () => openImportModal('file'));
  $('#btn-new-sched').addEventListener('click', () => openScheduleModal(null));
  // 搜索框在顶栏复用，这里只放计数旁的「清空」
  $('#btn-sched-search-clear').addEventListener('click', () => {
    state.schedKw = '';
    const box = $('#search');
    box.value = '';
    renderSchedules();
    box.focus();
  });
  $('#btn-scan-dir').addEventListener('click', () => openImportModal('scan'));
  $('#btn-usage').addEventListener('click', () => window.open('/static/usage.html?v=2', '_blank', 'noopener'));
  // 导入 / 导出只保留在设置页，顶栏不再重复放
  $('#lan-toggle').addEventListener('click', toggleLan);

  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-mask').addEventListener('click', closeDrawer);
  $('#btn-run').addEventListener('click', runScript);
  $('#btn-save-preset').addEventListener('click', openSavePreset);
  $('#btn-parse-cmd').addEventListener('click', openCmdImport);
  $('#btn-copy-cmd').addEventListener('click', async () => {
    if (!state.script) { toast('请先选择一个脚本', 'warn'); return; }
    const { command, error } = await buildCommandText();
    if (error) { toast(error, 'err'); return; }
    if (!command) { toast('命令为空', 'warn'); return; }
    await copyText(command);
    toast('命令已复制');
  });
  $('#opt-hide-empty').addEventListener('change', () => { applyEmptyFilter(); savePrefs(); });
  initSettingsView();
  $('#q-open-dir').addEventListener('click', async () => {
    if (!state.script) return;
    try { await api('/api/utils/open-dir', { method: 'POST', body: { path: state.script.path } }); toast('已打开所在目录'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#q-copy-path').addEventListener('click', async () => {
    if (!state.script) return;
    await copyText(state.script.path);
    toast('路径已复制');
  });
  $('#q-meta').addEventListener('click', openMetaModal);
  $('#q-reload').addEventListener('click', reloadCurrentScript);
  $('#q-delete').addEventListener('click', deleteCurrentScript);
  // 状态标签只是显示当前状态，不再当作「运行」按钮；
  // 只有正在运行时才可点，点它 = 终止当前实例。
  $('#q-run-status').addEventListener('click', () => {
    if (state.running) terminateCurrent();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#run-popover') && !e.target.closest('.run-badge')) closeRunPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeRunPopover();
      $('#copy-float').hidden = true;
      if ($('#cmd-strip').classList.contains('open')) {
        $('#cmd-strip').classList.remove('open', 'pop');
        refreshCmd();
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runScript(); }
  });
}

async function reloadCurrentScript() {
  if (!state.selectedId) return;
  toast('正在重新解析脚本…');
  try {
    await api(`/api/scripts/${state.selectedId}/reload`, { method: 'POST' });
    toast('已重新解析，参数定义已刷新');
    await loadScripts();
    await selectScript(state.selectedId, { keepDrawer: true });
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteCurrentScript() {
  if (!state.script) return;
  const ok = await confirmModal({
    title: '移除脚本',
    message: `确定从启动器移除「${state.script.name}」？\n该脚本的预设与执行记录会一并删除，脚本文件本身不受影响。`,
    okText: '移除', danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/scripts/${state.script.id}`, { method: 'DELETE' });
    toast('已移除');
    state.script = null; state.selectedId = null; state.activePresetId = null;
    try { localStorage.removeItem('last_script_id'); } catch { /* ignore */ }
    closeDrawer();
    await loadScripts();
    await refreshHistory();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- 导出 / 导入 ---------- */
async function exportData() {
  try {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    a.href = url;
    a.download = `tool-launcher-export-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`已导出 ${data.scripts.length} 个脚本配置`);
  } catch (e) { toast(e.message, 'err'); }
}
function importConfig() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.scripts)) throw new Error('不是有效的启动器导出文件');
      const r = await api('/api/import', { method: 'POST', body: { data } });
      const skip = (r.skipped || []).length;
      toast(`导入完成：新增 ${r.imported}、更新 ${r.updated}${skip ? `、跳过 ${skip}` : ''}`);
      await loadScripts();
    } catch (e) { toast('导入失败：' + e.message, 'err'); }
  });
  input.click();
}

/* ---------- 局域网开关 ---------- */
async function toggleLan() {
  const el = $('#lan-toggle');
  if (el.classList.contains('disabled')) return;
  const next = !el.classList.contains('on');
  el.classList.add('disabled');
  try {
    await api('/api/host', { method: 'POST', body: { lan: next } });
    toast(next ? '已开启局域网访问，服务正在重启…' : '已关闭局域网访问，服务正在重启…', 'warn', 3200);
  } catch (e) {
    el.classList.remove('disabled');
    toast(e.message, 'err');
    return;
  }
  const deadline = Date.now() + 15000;
  const wait = async () => {
    if (Date.now() > deadline) {
      el.classList.remove('disabled');
      toast('服务重启超时，请手动刷新页面', 'err', 4000);
      return;
    }
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) { location.replace(location.pathname + '?t=' + Date.now()); return; }
    } catch { /* 继续等 */ }
    setTimeout(wait, 800);
  };
  setTimeout(wait, 800);
}
async function loadLan() {
  try {
    const r = await api('/api/host');
    $('#lan-toggle').classList.toggle('on', !!r.lan);
    if (r.current_host === '0.0.0.0') $('#lan-toggle').title = `已监听所有网卡，局域网可用 http://<本机IP>:${r.port}`;
  } catch { /* 忽略 */ }
}

/* ========================= 启动 ========================= */

async function init() {
  applyPrefs();
  initDock();
  initEditables();
  initCmdStrip();
  initHistoryView();
  initHistoryRowEvents();
  initGridEvents();
  initTopbar();
  updateHistoryScopeBtn();
  await loadLan();
  checkUv();
  try {
    await loadScripts();
  } catch (e) {
    toast('加载脚本列表失败：' + e.message, 'err');
  }
  refreshHistory();
  refreshRunning();
  setInterval(refreshRunning, 3000);
  setInterval(() => { if (state.view === 'history') refreshHistory(); else updateRunBadges(); }, 6000);

  const last = Number(localStorage.getItem('last_script_id') || 0);
  // 恢复上次选中的脚本，但不自动弹出抽屉（否则遮罩会挡住整页）
  if (last && state.scripts.some(s => s.id === last)) await selectScript(last, { keepDrawer: true });
}

/**
 * 布局自检：URL 带 ?debug=1 时，在切视图 / 展开收起控制台后自动输出关键元素几何，
 * 便于排查「控制台是否挤压页面」「开关是否错位」「命令条是否只占一行」这类纯视觉问题。
 * 正常访问不带 debug，控制台保持干净。
 */
const DEBUG = /(?:^|[?&])debug=1(?:&|$)/.test(location.search);
function debugReport(tag = '') {
  const box = (sel) => {
    const el = $(sel);
    if (!el) return `${sel}=缺失`;
    const r = el.getBoundingClientRect();
    return `${sel}=${Math.round(r.width)}x${Math.round(r.height)}@y${Math.round(r.top)}`;
  };
  const cs = (sel, prop) => {
    const el = $(sel);
    if (!el) return `${sel}.${prop}=缺失`;
    return `${sel}.${prop}=${getComputedStyle(el)[prop]}`;
  };
  console.log(`[debug${tag ? ' ' + tag : ''}]`,
    box('.views'), box('#hist-layout'), box('#hist-list-box'), box('#hist-detail-box'),
    box('#dock'), box('#term-out'), box('#cmd-strip'), box('#cmd-inline'),
    box('#drawer'),
    '| dockEff=' + getComputedStyle(document.documentElement).getPropertyValue('--dock-eff').trim(),
    '| drawerBottom=' + ($('#drawer') ? getComputedStyle($('#drawer')).bottom : 'n/a'),
    '| drawerShow=' + ($('#drawer') ? $('#drawer').classList.contains('show') : 'n/a'),
    '|', cs('.term-dock', 'position'), cs('.term-dock', 'zIndex'),
    '| anim=' + ((($('.sched-card') || {}).className) || 'n/a'),
    '| cursor=' + (($('.sched-card') ? getComputedStyle($('.sched-card')).cursor : 'n/a')),
    '| scardAnim=' + (($('.scard') ? getComputedStyle($('.scard')).animationFillMode : 'n/a')),
    '| swTrackW=' + ($('.switch .track') ? Math.round($('.switch .track').getBoundingClientRect().width) : 'n/a'),
    '| switches=' + ($$('.switch').map((l) => {
      const t = $('.track', l);
      const w = t ? Math.round(t.getBoundingClientRect().width) : -1;
      const h = t ? Math.round(t.getBoundingClientRect().height) : -1;
      return `${w}x${h}`;
    }).join(',') || '无'),
    '| autoConsole=' + state.autoConsole);
  return true;
}
window.__debugReport = debugReport;

init();
if (DEBUG) setTimeout(() => debugReport('boot'), 700);
