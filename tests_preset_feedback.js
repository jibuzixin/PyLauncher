/**
 * 套用预设的反馈：chip 本身不给按压反馈，反馈落在「这次被改动的参数框」上。
 *
 * 跑法：node tests_preset_feedback.js
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

const presetChip = extract(src, 'presetChip');
const applyPreset = extract(src, 'applyPreset');
const highlightChangedFields = extract(src, 'highlightChangedFields');

/* ---- chip 不给按压反馈，也不留持久选中态 ---- */
check('chip 不再加持久的 on 类', !presetChip.includes("' on'") && !presetChip.includes('preset-chip.on'));
check('样式表里移除了 .preset-chip.on', !css.includes('.preset-chip.on'));
check('chip 不再有按压/闪烁态', !css.includes('.preset-chip.flash') && !src.includes('flashPresetChip'));
check('仍然记录当前应用的预设（用于执行记录）', src.includes('activePresetId'));

/* ---- 反馈落在参数框上 ---- */
check('applyPreset 会比对改动并高亮字段', applyPreset.includes('highlightChangedFields(before'));
check('高亮前先取当前表单值', applyPreset.includes('const before = collectValues()'));
check('高亮前先套用预设', /fillValues\([\s\S]*?highlightChangedFields/.test(applyPreset));
check('只高亮值真的变了的字段', highlightChangedFields.includes('String(oldV) === String(v)'));
check('表单里没有的参数不参与高亮', highlightChangedFields.includes('if (oldV === undefined) continue;'));
check('按 data-dest 定位到具体字段', highlightChangedFields.includes('.field[data-dest='));
check('高亮会自己淡回', /classList\.add\('hit'\)[\s\S]*?setTimeout[\s\S]*?classList\.remove\('hit'\)/.test(highlightChangedFields));

/* ---- 高亮样式：沿用项目自己的焦点环语言 ---- */
check('高亮用 brand-6 描边 + brand-5 浅蓝底',
  css.includes('.field.hit input[type=text]') && css.includes('border-color:var(--brand-6);background:var(--brand-5)'));
check('开关字段也有对应高亮', css.includes('.field.hit .switch .track{background:var(--brand-6);}'));
check('输入框自带过渡，高亮能淡入淡出',
  /\.field input\[type=text\][^{]*\{[^}]*transition:all var\(--t-fast\)/.test(css));
check('页面支持 prefers-reduced-motion 降级（规范要求）',
  css.includes('@media (prefers-reduced-motion: reduce)'));

console.log(failed ? `\n${failed} 个用例失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
