/**
 * 运行队列（前端）单元测试：
 *  - 状态标签：队列 4 态、任务 5 态
 *  - 已完成任务计数
 *  - datetime-local ↔ ISO 转换
 *  - 源码级断言：接口路径、脚本+预设两个维度、二次确认、动效、导航与页面骨架、样式类
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

/* ---- 时间输入：日期 + 时间两个选择器 ---- */
const tsandbox = {};
new Function('exports',
  extract(src, 'toLocalInput') + '\n' +
  extract(src, 'splitLocalInput') + '\n' +
  extract(src, 'parseLocalInput') + '\n' +
  extract(src, 'fmtLocal') + '\n' +
  'exports.toLocalInput = toLocalInput;\n' +
  'exports.splitLocalInput = splitLocalInput;\n' +
  'exports.parseLocalInput = parseLocalInput;\n' +
  'exports.fmtLocal = fmtLocal;')(tsandbox);
const toLocalInput = tsandbox.toLocalInput;
const splitLocalInput = tsandbox.splitLocalInput;
const parseLocalInput = tsandbox.parseLocalInput;
const local = toLocalInput('2026-10-24T06:05:00+08:00');
check('ISO → 文本形如 YYYY-MM-DD HH:mm', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(local), local);
check('是本地时间（这里应当是 06:05）', local.endsWith('06:05'), local);
check('空值回退到现在（不炸）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(toLocalInput('')));
check('非法日期返回空串', toLocalInput('not-a-date') === '');
const sp = splitLocalInput('2026-10-24T06:05:00+08:00');
check('拆成日期 / 时间两个值', sp.date === '2026-10-24' && sp.time === '06:05', JSON.stringify(sp));
check('日期 + 时间能拼回本地时间', (() => {
  const d = parseLocalInput('2026-10-24', '06:05');
  return d && d.getFullYear() === 2026 && d.getMonth() === 9 && d.getDate() === 24
    && d.getHours() === 6 && d.getMinutes() === 5;
})());
check('缺日期或时间返回 null',
  parseLocalInput('', '06:05') === null && parseLocalInput('2026-10-24', '') === null);
check('名字没填时用开始时间', src.includes('const name = nameInput || fmtLocal(startDate);'));
check('弹窗用日期 + 时间两个选择器', src.includes('type="date" id="q-date"') && src.includes('type="time" id="q-time"'));
check('提交时读的是日期和时间两个值', src.includes("const dateStr = ($('#q-date') && $('#q-date').value) || ''"));

/* ---- 源码级断言：接口 ---- */
check('拉取队列列表用 GET /api/queues', src.includes("api('/api/queues')"));
check('新建队列用 POST /api/queues', src.includes("api('/api/queues', {"));
check('保存队列设置用 PUT /api/queues/{id}', src.includes("api(`/api/queues/${queueCtx.queue.id}`, {"));
check('保存任务清单用 PUT /api/queues/{id}/items', src.includes("api(`/api/queues/${queueCtx.queue.id}/items`, { method: 'PUT'"));
check('加入队列用 POST items', src.includes("api(`/api/queues/${v}/items`") || src.includes("method: 'POST', body: { script_id"));
check('移出任务用 DELETE items/{id}', src.includes("api(`/api/queues/${q.id}/items/${itemId}`, { method: 'DELETE' })"));
check('上下挪动用 POST items/{id}/move', src.includes('/items/${itemId}/move'));
check('清空队列用 POST /clear', src.includes('/clear`'));
check('重新启动用 POST /restart', src.includes('/restart`'));
check('删除队列用 DELETE /api/queues/{id}', src.includes("api(`/api/queues/${q.id}`, { method: 'DELETE' })"));
check('老接口 items/reorder 已经不用了', !src.includes('/items/reorder'));

/* ---- 源码级断言：脚本 + 预设 两个维度 ---- */
check('弹窗里按脚本 + 预设选择', src.includes('id="q-script"') && src.includes('id="q-preset"'));
check('拉取全部预设用于两级联动', src.includes("api('/api/presets')"));
check('预设跟着所选脚本联动', src.includes('presetByScript'));
check('不绑预设时用脚本默认参数', src.includes('不绑定预设'));
check('提交时带上 script_id / preset_id', src.includes('script_id: d.script_id') && src.includes('preset_id: d.preset_id || null'));
check('已有任务带 item_id 回去（保住执行状态）', src.includes('item_id: d.item_id || undefined'));
check('队列任务显示脚本名', src.includes('it.script_name'));
check('队列任务显示预设名', src.includes('it.preset_name'));
check('不再从定时任务维度加入队列', !src.includes('openAddToQueueModal') && !src.includes('data-op="queue"'));

/* ---- 命令预览 ---- */
check('有命令预览接口', src.includes("api('/api/preview-cmd'"));
check('弹窗里有命令预览框', src.includes('id="q-cmd"'));

/* ---- 源码级断言：破坏性操作走二次确认 ---- */
for (const op of ['restart', 'del']) {
  const re = new RegExp(`data-op="${op}"[\\s\\S]{0,2500}?armDelConfirm`);
  check(`卡片上的 ${op} 走 armDelConfirm 二次确认`, re.test(src));
}
check('任务移出队列也走 armDelConfirm', /label: '移出队列'/.test(src));
check('清空按钮挪进编辑框（#q-clear）', src.includes('id="q-clear"'));
check('清空按钮走二次确认', /label: '清空队列'/.test(src));
check('卡片上不再有清空按钮', !/data-op="clear"/.test(src));

/* ---- 源码级断言：开关、重新启动、编辑按钮 ---- */
check('队列状态有「已关闭」（paused）', /paused: \{ cls: 'paused', label: '已关闭' \}/.test(src));
check('卡片上有启用开关', src.includes('class="sw"') && /title="启用 \/ 停用/.test(src));
check('开关调用 PUT /api/queues/{id} 的 enabled', /body: \{ enabled: e\.target\.checked \}/.test(src));
check('开关关闭的提示说明不影响正在跑的', src.includes('正在跑的跑完为止'));
check('重新启动单独一个逻辑', /op === 'restart'/.test(src) && src.includes('/restart'));
check('编辑按钮是黑色实心', /btn btn-solid" data-op="edit"/.test(src));

/* ---- 动效：上下移动有滑动过渡 ---- */
check('有 FLIP 动效函数 flipList', /function flipList\(/.test(src));
check('队列卡片重绘前后记录位置（captureQueuePositions）', /function captureQueuePositions\(/.test(src));
check('重绘后按位置做动画（animateQueuePositions）', /function animateQueuePositions\(/.test(src));
check('动效走 translateY 位移', src.includes('translateY(${d}px)'));
check('就地更新不整块重建（避免闪一下）',
  /updateQueueCard\(card, q\)/.test(src) && !/wrap\.innerHTML = '';\s*\n\s*for \(const q of list\)/.test(src));
check('任务清单按 id 复用已有的行', /rows\.set\(li\.dataset\.item, li\)/.test(src));
check('样式里有 .moving 过渡', css.includes('.q-item.moving') && css.includes('.queue-item.moving'));
check('样式里有新条目入场动画 .qi-enter', css.includes('.qi-enter'));
check('降级：系统开启「减少动态效果」时动效关闭', /prefers-reduced-motion: reduce[\s\S]{0,200}transition-duration/.test(css));

/* ---- 源码级断言：间隔默认 5 秒、两种异常策略 ---- */
check('任务间隔默认 5 秒', src.includes("isEdit ? queue.interval_seconds : 5"));
check('异常策略有「停下整个队列」', src.includes('value="stop"'));
check('异常策略有「跳过继续下一个」', src.includes('value="skip"'));
check('异常策略用说明式选项（.q-choice）', src.includes('class="q-choice') && src.includes('q-choice-body'));
check('默认异常策略是跳过继续', src.includes('!isEdit || !queue.stop_on_error ? '));

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
  '.qi-preset', '.qi-main', '.qi-ops', '.qi-btn', '.queue-empty', '.queue-ops',
  '.q-items', '.q-item', '.q-picker', '.q-pick', '.q-cmd', '.q-block',
  '.q-choice', '.q-choice-body', '.q-quick', '.q-clear', '.q-dt']) {
  check(`样式表里有 ${cls}`, css.includes(cls));
}
check('队列页标题是「运行队列」', tpl.includes('<h1>运行队列</h1>'));

console.log(failed ? `\n${failed} 个用例失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
