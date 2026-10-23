/**
 * 定时任务卡片状态标签：停用→暂停 / 就绪 / 运行中 / 成功 / 失败 / 终止。
 *
 * 跑法：node tests_sched_status.js
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

/* schedStatusPill 是纯函数，直接抠出来跑 */
const sandbox = {};
new Function('exports', extract(src, 'schedStatusPill') + '\nexports.schedStatusPill = schedStatusPill;')(sandbox);
const pill = sandbox.schedStatusPill;

function expect(desc, s, text, cls) {
  const html = pill(s);
  const ok = html.includes(`>${text}<`) && html.includes(`status-pill ${cls}`);
  check(desc, ok, `期望 ${text}/${cls}，实际 ${html}`);
}

const RUN = '2026-10-23T06:00:09+08:00';

/* ---- 停用 ---- */
expect('未启用的任务 → 暂停', { enabled: 0, last_run: null, last_status: null }, '暂停', 'paused');
expect('停用且上次成功 → 暂停（不显示上次结果）', { enabled: 0, last_run: RUN, last_status: 'success' }, '暂停', 'paused');
expect('达上限自动停用 → 暂停', {
  enabled: 0, last_run: RUN, last_status: '已达执行上限 1 次，已自动停用（最后一次：success）',
}, '暂停', 'paused');

/* ---- 已启用但没跑过 → 就绪（这是之前显示成"暂停"的那个 bug） ---- */
expect('已启用、还没执行过 → 就绪', { enabled: 1, last_run: null, last_status: null }, '就绪', 'ready');
expect('刚启用（后端清了 last_status）→ 就绪', { enabled: 1, last_run: RUN, last_status: null }, '就绪', 'ready');

/* ---- 执行中 ---- */
expect('正在执行 → 运行中', { enabled: 1, last_run: RUN, last_status: 'running' }, '运行中', 'running');
expect('执行中（即便刚被停用）→ 运行中', { enabled: 0, last_run: RUN, last_status: 'running' }, '运行中', 'running');

/* ---- 上次结果 ---- */
expect('上次成功 → 成功', { enabled: 1, last_run: RUN, last_status: 'success' }, '成功', 'success');
expect('上次失败 → 失败', { enabled: 1, last_run: RUN, last_status: 'failed' }, '失败', 'failed');
expect('上次被终止 → 终止', { enabled: 1, last_run: RUN, last_status: 'terminated' }, '终止', 'terminated');
expect('cron 无效 → 失败', { enabled: 1, last_run: RUN, last_status: 'cron 无效: out of range' }, '失败', 'failed');
expect('脚本不存在 → 失败', { enabled: 1, last_run: RUN, last_status: '脚本不存在' }, '失败', 'failed');

/* ---- 样式类都在 ---- */
for (const cls of ['success', 'failed', 'running', 'terminated', 'paused', 'ready']) {
  check(`样式表里有 .status-pill.${cls}`, css.includes(`.status-pill.${cls}`));
}
check('就绪态有独立配色（与暂停的灰区分）', /\.status-pill\.ready\{[^}]*brand-3/.test(css));

console.log(failed ? `\n${failed} 个用例失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
