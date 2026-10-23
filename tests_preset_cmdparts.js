/**
 * 预设的「命令前后缀」：跟参数一起存、一起带回来、并能应用到定时任务。
 *
 * 跑法：node tests_preset_cmdparts.js
 */
const fs = require('fs');
const path = require('path');
const { readApp, extract } = require('./tests_jsutil');

const src = readApp();
const css = fs.readFileSync(path.join(__dirname, 'static', 'style.css'), 'utf8');

let failed = 0;
function check(desc, ok, extra) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok || !extra ? '' : `\n      ${extra}`));
}

/* 把抠出来的函数放进沙箱里真跑一遍（比只看源码强）
   注意：extract 抠出来的是 `function xxx(...)`，async 关键字被切掉了，
   所以这里统一包成 async 函数表达式。 */
function sandbox(names, srcCode) {
  const keys = Object.keys(names);
  const vals = keys.map(k => names[k]);
  // eslint-disable-next-line no-new-func
  return new Function(...keys, `return (async ${srcCode});`)(...vals);
}

/* 同步函数用这个（保持返回值不是 Promise） */
function sandboxSync(names, srcCode) {
  const keys = Object.keys(names);
  const vals = keys.map(k => names[k]);
  // eslint-disable-next-line no-new-func
  return new Function(...keys, `return (${srcCode});`)(...vals);
}

const applyPresetSrc = extract(src, 'applyPreset');
const currentCmdPartsSrc = extract(src, 'currentCmdParts');
const savePresetByNameSrc = extract(src, 'savePresetByName');
const overwritePresetByChipSrc = extract(src, 'overwritePresetByChip');
const setSchedCmdPartsSrc = extract(src, 'setSchedCmdParts');
const submitScheduleSrc = extract(src, 'submitSchedule');
const loadSchedScriptSrc = extract(src, 'loadSchedScript');
const setupDockTabScrollSrc = extract(src, 'setupDockTabScroll');
const presetChipSrc = extract(src, 'presetChip');

/* ---------- 套用预设：前后缀跟着一起回来 ---------- */

function makeApplyPreset(store) {
  const saved = [];
  const fn = sandbox({
    $: () => null,
    state: { selectedId: 7, activePresetId: null },
    collectValues: () => ({}),
    currentCmdParts: () => (store.parts || { prefix: '', suffix: '' }),
    fillValues: () => {},
    highlightChangedFields: () => {},
    saveArgs: async () => {},
    saveCmdParts: (id, parts) => { saved.push({ id, parts }); store.parts = parts; },
    renderPresets: () => {},
    refreshCmd: () => {},
    toast: () => {},
    api: async () => ({}),
  }, applyPresetSrc);
  return { fn, saved };
}

(async () => {
  // 1) 预设里有前后缀：套用时一起写回
  {
    const store = { parts: null };
    const { fn, saved } = makeApplyPreset(store);
    await fn({ id: 3, name: 'A', args: { url: 'x' }, cmd_prefix: 'NO_COLOR=1', cmd_suffix: '2>&1' });
    check('套用预设时把预设里的前后缀一起写回', saved.length === 1 && saved[0].parts.prefix === 'NO_COLOR=1'
      && saved[0].parts.suffix === '2>&1', JSON.stringify(saved));
  }

  // 2) 预设里没有前后缀：当前的前后缀要一起清掉（不留残留）
  {
    const store = { parts: { prefix: 'KEEP_ME', suffix: '' } };
    const { fn, saved } = makeApplyPreset(store);
    await fn({ id: 3, name: 'B', args: { url: 'y' }, cmd_prefix: '', cmd_suffix: '' });
    check('预设没有前后缀时把当前的一并清掉（预设 = 一整套运行预期）', saved.length === 1
      && saved[0].parts.prefix === '' && saved[0].parts.suffix === '', JSON.stringify(saved));
  }

  // 3) 「切到别的预设再切回来」：回来时前缀要跟着回来
  {
    const store = { parts: { prefix: 'OLD', suffix: '' } };
    const { fn } = makeApplyPreset(store);
    await fn({ id: 2, name: 'B', args: {}, cmd_prefix: '', cmd_suffix: '' });   // 切到 B
    await fn({ id: 1, name: 'A', args: {}, cmd_prefix: 'PREFIX_A', cmd_suffix: '' }); // 再切回 A
    check('切换预设来回后，前后缀跟着预设一起回来', store.parts.prefix === 'PREFIX_A');
  }

  {
    check('清掉当前前后缀时明确告诉用户', applyPresetSrc.includes('已清掉当前前后缀'));
  }

  /* ---------- 读取当前前后缀：优先输入框里的最新内容 ---------- */

  {
    let live = { prefix: 'FROM_TEXTAREA', suffix: '' };
    const fn = sandbox({
      $: (sel) => (sel === '#cmd-prefix' ? { value: live.prefix }
        : sel === '#cmd-suffix' ? { value: live.suffix } : null),
      getCmdParts: () => ({ prefix: 'FROM_STORAGE', suffix: '' }),
      state: { selectedId: 7 },
    }, currentCmdPartsSrc);
    const r = await fn();
    check('读的是输入框里的最新内容（防抖没落盘时也不丢）', r.prefix === 'FROM_TEXTAREA', JSON.stringify(r));
    live = { prefix: '  SPACED  ', suffix: ' x ' };
    const r2 = await fn();
    check('前后缀会去空格', r2.prefix === 'SPACED' && r2.suffix === 'x', JSON.stringify(r2));
  }

  /* ---------- 保存预设：参数 + 前后缀一起提交 ---------- */

  function makeSaver(fnSrc) {
    let sent = null;
    const fn = sandbox({
      $: () => null,
      state: { selectedId: 7 },
      collectValues: () => ({ url: 'u' }),
      currentCmdParts: () => ({ prefix: 'P', suffix: 'S' }),
      api: async (url, opts) => { sent = opts.body; return { overwritten: true }; },
      closeModal: () => {},
      toast: () => {},
      reloadPresets: async () => {},
    }, fnSrc);
    return { fn, getSent: () => sent };
  }

  {
    const { fn, getSent } = makeSaver(savePresetByNameSrc);
    await fn('我的预设');
    const b = getSent();
    check('新建预设：参数与前后缀一起提交', b && b.args && b.args.url === 'u'
      && b.cmd_prefix === 'P' && b.cmd_suffix === 'S', JSON.stringify(b));
  }

  /* ---------- 完整链路：套用预设 → 保存预设，不能夹带别的前缀 ---------- */

  {
    // 用户报的坑：套用一个「没有前缀」的预设后，当前残留的前缀
    // 会被下一次保存的新预设顺手带进去 —— 预设本身没有前缀却被加了一个
    const store = { prefix: 'STALE_PREFIX', suffix: '' };
    const els = {
      '#cmd-prefix': { get value() { return store.prefix; }, set value(v) { store.prefix = v; } },
      '#cmd-suffix': { get value() { return store.suffix; }, set value(v) { store.suffix = v; } },
    };
    const $ = (sel) => els[sel] || null;
    const state = { selectedId: 7, activePresetId: null };
    const getCmdParts = () => ({ prefix: store.prefix, suffix: store.suffix });
    const saveCmdParts = (id, parts) => { store.prefix = parts.prefix; store.suffix = parts.suffix; };
    let sent = null;
    const api = async (url, opts) => { sent = opts.body; return {}; };
    const currentCmdParts = sandboxSync({ $, getCmdParts, state }, currentCmdPartsSrc);
    const apply = sandbox({
      $, state, collectValues: () => ({}), currentCmdParts, fillValues: () => {}, highlightChangedFields: () => {},
      saveArgs: async () => {}, saveCmdParts, renderPresets: () => {}, refreshCmd: () => {},
      toast: () => {}, api: async () => ({}),
    }, applyPresetSrc);
    const save = sandbox({
      $, state, collectValues: () => ({ url: 'u' }), currentCmdParts, api,
      closeModal: () => {}, toast: () => {}, reloadPresets: async () => {},
    }, savePresetByNameSrc);

    await apply({ id: 3, name: '无前缀预设', args: {}, cmd_prefix: '', cmd_suffix: '' });
    check('套用没有前缀的预设后，当前的前缀不再残留', store.prefix === '', `prefix=${store.prefix}`);
    await save('新预设');
    check('保存的新预设不会夹带别人的前缀', sent.cmd_prefix === '' && sent.cmd_suffix === '',
      JSON.stringify(sent));

    // 反过来：套用带前缀的预设，保存出来的新预设就该带着这个前缀
    await apply({ id: 4, name: '带前缀预设', args: {}, cmd_prefix: 'PFX', cmd_suffix: 'SFX' });
    await save('新预设2');
    check('套用带前缀的预设后，保存的新预设带着同一个前缀',
      sent.cmd_prefix === 'PFX' && sent.cmd_suffix === 'SFX', JSON.stringify(sent));
  }

  {
    const { fn, getSent } = makeSaver(overwritePresetByChipSrc);
    await fn('我的预设');
    const b = getSent();
    check('点 chip 覆盖预设：参数与前后缀一起提交', b && b.cmd_prefix === 'P' && b.cmd_suffix === 'S',
      JSON.stringify(b));
  }

  {
    check('两条覆盖提示都说明了前后缀会被一起替换',
      (src.match(/原有参数与命令前后缀将被当前设置替换/g) || []).length === 2);
  }

  /* ---------- 预设 chip 上标出「带不带自定义命令」 ---------- */

  {
    check('带自定义命令的预设，chip 上有标记',
      presetChipSrc.includes('cmd-dot') && presetChipSrc.includes('p.cmd_prefix'));
    check('标记有样式（低调的灰点）', css.includes('.preset-chip .cmd-dot'));
  }

  /* ---------- 定时任务：带着预设的参数与前后缀 ---------- */

  {
    check('定时任务弹窗有前后缀输入框', src.includes('id="sc-cmd-prefix"') && src.includes('id="sc-cmd-suffix"'));
    check('预设下拉里带着预设的前后缀', loadSchedScriptSrc.includes('data-cmd-prefix=')
      && loadSchedScriptSrc.includes('data-cmd-suffix='));
    check('选预设时会把前后缀带出来', src.includes('if (pre || suf) setSchedCmdParts(pre, suf);'));
    check('定时任务保存时提交前后缀', submitScheduleSrc.includes('cmd_prefix: cmdPrefix')
      && submitScheduleSrc.includes('cmd_suffix: cmdSuffix'));
    check('定时任务卡片上标出含自定义命令', src.includes("' · 含自定义命令'"));
  }

  {
    // setSchedCmdParts 写进两个输入框
    const els = {};
    const fn = sandbox({ $: (sel) => (els[sel] = els[sel] || { value: '' }) }, setSchedCmdPartsSrc);
    fn('AAA', 'BBB');
    check('前后缀写进定时任务弹窗的两个输入框',
      els['#sc-cmd-prefix'].value === 'AAA' && els['#sc-cmd-suffix'].value === 'BBB');
  }

  {
    // submitSchedule 真正把输入框里的前后缀发出去
    const vals = {
      '#sc-name': 'T', '#sc-cron': '0 9 * * *', '#sc-script': '3', '#sc-max-runs': '-1',
      '#sc-preset': '', '#sc-cmd-prefix': ' PFX ', '#sc-cmd-suffix': ' SFX ', '#sc-enabled': '',
    };
    const els = {};
    const $ = (sel) => (els[sel] = els[sel] || { value: '', checked: false });
    for (const [k, v] of Object.entries(vals)) $(k).value = v;
    let sent = null;
    const fn = sandbox({
      $,
      cronValidate: () => '',
      collectSchedFields: () => ({ url: 'u' }),
      schedCtx: { editingId: null },
      api: async (url, opts) => { sent = opts.body; return {}; },
      toast: () => {},
      closeModal: () => {},
      renderSchedules: async () => {},
    }, submitScheduleSrc);
    await fn();
    check('新建定时任务时前后缀一起提交（且去掉首尾空格）',
      sent && sent.cmd_prefix === 'PFX' && sent.cmd_suffix === 'SFX', JSON.stringify(sent));
  }

  /* ---------- 控制台标签栏：不再有那条粗滚动条 ---------- */

  check('标签栏隐藏了系统滚动条', /\.term-tabs\{[^}]*scrollbar-width:none/.test(css)
    && css.includes('.term-tabs::-webkit-scrollbar'));
  check('右侧操作区吸边，横向滚动时不会被划走',
    /\.term-dock-actions\{[^}]*position:sticky/.test(css));
  check('滚轮可以横向滚动标签栏', src.includes('function setupDockTabScroll()')
    && src.includes('box.scrollLeft += e.deltaY;'));

  {
    // 滚轮 → 横向滚动：隐藏了滚动条之后，鼠标用户也得能把多余的标签划出来
    const handlers = {};
    const box = {
      scrollWidth: 1000, clientWidth: 400, scrollLeft: 0,
      addEventListener: (ev, fn) => { handlers[ev] = fn; },
    };
    const fn = sandbox({ $: (sel) => (sel === '#dock-tabs' ? box : null) }, setupDockTabScrollSrc);
    await fn();
    check('标签栏绑定了滚轮事件', !!handlers.wheel);
    let prevented = false;
    handlers.wheel({ deltaX: 0, deltaY: 120, preventDefault: () => { prevented = true; } });
    check('竖向滚轮会横向滚动标签栏', box.scrollLeft === 120 && prevented, `scrollLeft=${box.scrollLeft}`);
    box.scrollLeft = 0; prevented = false;
    handlers.wheel({ deltaX: 50, deltaY: 120, preventDefault: () => { prevented = true; } });
    check('触控板本来就在横向滚时不接管', box.scrollLeft === 0 && !prevented);
    box.clientWidth = 1000; box.scrollLeft = 0; prevented = false;
    handlers.wheel({ deltaX: 0, deltaY: 120, preventDefault: () => { prevented = true; } });
    check('标签装得下时不抢页面的滚动', box.scrollLeft === 0 && !prevented);
  }

  console.log(failed ? `\n${failed} 个用例失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
