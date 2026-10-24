/**
 * 运行队列（前端）单元测试：
 *  - 状态标签：队列 4 态、任务 5 态
 *  - 已完成任务计数
 *  - datetime-local ↔ ISO 转换
 *  - 源码级断言：接口路径、二次确认、导航与页面骨架、样式类
 *
 * 跑法：node tests_queue_ui.js
 */
const fs = require('fs');
const path = require('path');
const { readApp, extract } = require('./tests_jsutil');

const src = readApp();
const css = fs.readFileSync(path.join(__dirname, 'static', 'style.css'), 'utf8');
const tpl = fs.readFileSync(path.join(__dirname, 'static', 'index.template.html'), 'utf8');

let failed = 0;
function check(desc, ok, extra) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok || !extra ? '' : `\n      ${extra}`));
}

/* ---- 纯函数：抠出来直接跑 ---- */
const sandbox = {};
new Function('exports',
  extract(src, 'QUEUE_STATUS_META') + '\n' +
  extract(src, 'queueStatusPill') + '\n' +
  extract(src, 'queueItemPill') + '\n' +
  extract(src, 'queueDoneCount') + '\n' +
  'exports.queueStatusPill = queueStatusPill;\n' +
  'exports.queueItemPill = queueItemPill;\n' +
  'exports.queueDoneCount = queueDoneCount;'
)(sandbox);

/* ---- 队列状态标签 ---- */
const qpill = sandbox.queueStatusPill;
function expectQ(desc, status, text, cls) {
  const html = qpill({ status });
  const ok = html.includes(`>${text}<`) && html.includes(`status-pill ${cls}`);
  check(desc, ok, `期望 ${text}/${cls}，实际 ${html}`);
}
expectQ('队列等待开始 → 等待开始', 'pending', '等待开始', 'ready');
expectQ('队列运行中 → 运行中', 'running', '运行中', 'running');
expectQ('队列全部跑完 → 已完成', 'done', '已完成', 'success');
expectQ('队列出错停下 → 已中止', 'stopped', '已中止', 'terminated');
check('未知状态退回「等待开始」', qpill({ status: 'weird' }).includes('等待开始'));
check('队列为空对象也有标签', qpill({}).includes('status-pill'));

/* ---- 任务状态标签 ---- */
const ipill = sandbox.queueItemPill;
function expectI(desc, status, text, cls) {
  const html = ipill({ status });
  const ok = html.includes(`>${text}<`) && html.includes(`status-pill ${cls}`);
  check(desc, ok, `期望 ${text}/${cls}，实际 ${html}`);
}
expectI('任务成功 → 成功', 'success', '成功', 'success');
expectI('任务失败 → 失败', 'failed', '失败', 'failed');
expectI('任务运行中 → 运行中', 'running', '运行中', 'running');
expectI('任务被跳过 → 已跳过', 'skipped', '已跳过', 'paused');
expectI('任务待执行 → 待执行', 'pending', '待执行', 'ready');

/* ---- 已完成任务计数（成功 + 失败 + 跳过都算跑完） ---- */
const done = sandbox.queueDoneCount;
check('全部待执行 → 0 个完成', done({ items: [{ status: 'pending' }, { status: 'pending' }] }) === 0);
check('成功/失败/跳过都算完成', done({
  items: [{ status: 'success' }, { status: 'failed' }, { status: 'skipped' }, { status: 'pending' }, { status: 'running' }],
}) === 3);
check('没有任务 → 0 个完成', done({ items: [] }) === 0);
check('缺 items 字段也不炸', done({}) === 0);

/* ---- datetime-local ↔ ISO ---- */
const tsandbox = {};
new Function('exports', extract(src, 'toLocalInput') + '\nexports.toLocalInput = toLocalInput;')(tsandbox);
const toLocalInput = tsandbox.toLocalInput;
const local = toLocalInput('2026-10-24T06:05:00+08:00');
check('ISO → datetime-local 形如 YYYY-MM-DDTHH:mm', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local), local);
check('datetime-local 是本地时间（这里应当是 06:05）', local.endsWith('T06:05'), local);
check('空值回退到现在（不炸）', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(toLocalInput('')));
check('非法日期返回空串', toLocalInput('not-a-date') === '');

/* ---- 源码级断言：接口 ---- */
check('拉取队列列表用 GET /api/queues', src.includes("api('/api/queues')"));
check('新建队列用 POST /api/queues', src.includes("api('/api/queues', {\n        method: 'POST'"));
check('保存队列用 PUT /api/queues/{id}', src.includes("api(`/api/queues/${queueCtx.queue.id}`, {\n        method: 'PUT'"));
check('调序用 items/reorder 一次性提交', src.includes('/items/reorder'));
check('加入队列用 POST items', src.includes("api(`/api/queues/${v}/items`"));
check('移出任务用 DELETE items/{id}', src.includes("api(`/api/queues/${q.id}/items/${itemId}`, { method: 'DELETE' })"));
check('清空队列用 POST /clear', src.includes('/clear`'));
check('重新启动用 POST /restart', src.includes('/restart`'));
check('删除队列用 DELETE /api/queues/{id}', src.includes("api(`/api/queues/${q.id}`, { method: 'DELETE' })"));

/* ---- 源码级断言：破坏性操作走二次确认 ---- */
for (const op of ['clear', 'restart', 'del']) {
  const re = new RegExp(`data-op="${op}"[\\s\\S]{0,2500}?armDelConfirm`);
  check(`${op} 走 armDelConfirm 二次确认`, re.test(src));
}
check('任务移出队列也走 armDelConfirm', /label: '移出队列'/.test(src));

/* ---- 源码级断言：间隔默认 5 秒、两种异常策略 ---- */
check('任务间隔默认 5 秒', src.includes("isEdit ? queue.interval_seconds : 5"));
check('异常策略有「停下整个队列」', src.includes("value=\"stop\""));
check('异常策略有「跳过这个，继续跑下一个」', src.includes("value=\"skip\""));
check('默认异常策略是跳过继续', src.includes('!isEdit || !queue.stop_on_error ? \'on\''));

/* ---- 页面骨架与导航 ---- */
check('导航有「运行队列」入口', tpl.includes('data-view="queues"'));
check('页面有 #view-queues', tpl.includes('id="view-queues"'));
check('页面有 #btn-new-queue', tpl.includes('id="btn-new-queue"'));
check('页面有队列容器 #queue-grid', tpl.includes('id="queue-grid"'));
check('导航上有运行中队列计数徽章', tpl.includes('id="queue-badge"'));
check('队列页不显示顶栏搜索框', /name === 'scripts' \|\| name === 'schedules' \|\| name === 'history'/.test(src));

/* ---- 样式 ---- */
for (const cls of ['.queue-grid', '.queue-card', '.queue-head', '.queue-title', '.queue-sub',
  '.queue-progress', '.queue-bar', '.queue-items', '.queue-item', '.qi-no', '.qi-name',
  '.qi-script', '.qi-ops', '.qi-btn', '.queue-empty', '.queue-ops', '.q-items', '.q-item', '.q-add']) {
  check(`样式表里有 ${cls}`, css.includes(cls));
}
check('队列页标题是「运行队列」', tpl.includes('<h1>运行队列</h1>'));

console.log(failed ? `\n${failed} 个用例失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
