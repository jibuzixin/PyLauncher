/**
 * 预设的破坏性操作（删除 / 覆盖）必须走项目统一的二次确认机制。
 *
 * 统一机制：armDelConfirm(btn, { label, hint, onConfirm })
 *   第一次点击 → 按钮进入 pending-del 待确认态 + 胶囊提示「⚠ <hint> · 2.5 秒内再点一次」
 *   2.5 秒内再点同一个按钮 → 才真正执行
 *
 * 跑法：node tests_preset_confirm.js
 */
const { readApp, extract } = require('./tests_jsutil');

const src = readApp();

let failed = 0;
function check(desc, ok, extra) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok || !extra ? '' : `\n      ${extra}`));
}

const askDeletePreset = extract(src, 'askDeletePreset');
const openSavePreset = extract(src, 'openSavePreset');
const openPresetManager = extract(src, 'openPresetManager');
const savePresetByName = extract(src, 'savePresetByName');
const overwritePresetByChip = extract(src, 'overwritePresetByChip');

/* ---- 删除预设：统一到 armDelConfirm ---- */
check('删除预设走 armDelConfirm', askDeletePreset.includes('armDelConfirm('));
check('删除预设不再自造 confirm-del 状态', !askDeletePreset.includes('confirm-del'));
check('删除预设的提示文案带预设名', /确认删除预设「\$\{p\.name\}」？/.test(askDeletePreset));
check('删除预设的提示语与其它删除操作一致（问句 + 预设名）',
  askDeletePreset.includes("label: '删除预设'"));

/* ---- 覆盖预设：两条入口都要二次确认 ---- */
check('保存时同名覆盖走 armDelConfirm', openSavePreset.includes('armDelConfirm('));
check('点已有预设覆盖走 armDelConfirm', openSavePreset.includes('armDelConfirm(chip'));
check('覆盖提示文案统一', openSavePreset.includes("label: '覆盖预设'")
  && /确认覆盖预设「\$\{name\}」？原有参数与命令前后缀将被当前设置替换/.test(src));
check('覆盖不再清空预设名称输入框（旧逻辑）', !openSavePreset.includes("$('#preset-name').value = ''"));
check('覆盖不再用自造的 pending 变量', !/let pending = null/.test(openSavePreset));

/* ---- 覆盖的两条路径各自落库，且语义不互相干扰 ---- */
check('保存路径带上命令前后缀', savePresetByName.includes('cmd_prefix: cp.prefix'));
check('点 chip 覆盖也带上命令前后缀（预设 = 参数 + 前后缀一整套）',
  overwritePresetByChip.includes('cmd_prefix: cp.prefix')
  && overwritePresetByChip.includes('cmd_suffix: cp.suffix'));

/* ---- 预设管理弹窗：确认后才从列表移除 ---- */
check('管理弹窗删除也走 askDeletePreset', openPresetManager.includes('askDeletePreset(btn, p'));
check('管理弹窗不再第一次点击就移除列表项',
  !openPresetManager.includes('all.splice(all.indexOf(p), 1); render(); return;'));
check('移除列表项放在确认回调里', /askDeletePreset\(btn, p, \(\) => \{[\s\S]*?all\.splice/.test(openPresetManager));

/* ---- 样式：旧的 confirm-del 变红态已随机制一起下线 ---- */
check('样式表里不再保留 preset-chip.confirm-del', !src.includes('preset-chip.confirm-del'));

console.log(failed ? `\n${failed} 个用例失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
