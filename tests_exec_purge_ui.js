/**
 * 执行记录「清理 30 天前」前端单元测试：
 *  - 按钮存在
 *  - 先 preview 拿数量，再走二次确认（armDelConfirm）
 *  - 用的是 POST /api/executions/purge-old（真删接口）
 *  - 确认提示里带上会删多少条
 *
 * 跑法：node tests_exec_purge_ui.js
 */
const fs = require('fs');
const path = require('path');
const { readApp } = require('./tests_jsutil');

const src = readApp();
const tpl = fs.readFileSync(path.join(__dirname, 'static', 'index.template.html'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, 'db.py'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, 'main.py'), 'utf8');

let failed = 0;
function check(desc, ok, extra) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok || !extra ? '' : `\n      ${extra}`));
}

/* ---- 页面骨架 ---- */
check('执行记录页有「清理30天前」按钮', tpl.includes('id="btn-purge-old"'));
check('按钮文案是「清理30天前」', tpl.includes('>清理30天前<'));

/* ---- 接口 ---- */
check('有 preview 接口（删除前先看数量）',
  mainSrc.includes('/api/executions/purge-old/preview'));
check('有真删接口', mainSrc.includes('@app.post("/api/executions/purge-old")'));
check('真删接口走 POST + days 参数',
  src.includes("body: { days: 30 }"));
check('preview 接口用 GET + days 参数',
  src.includes('/api/executions/purge-old/preview?days=30'));

/* ---- 前端逻辑 ---- */
check('先取 preview 数量再确认', src.includes('purge-old/preview'));
check('走了二次确认 armDelConfirm', /btn-purge-old[\s\S]{0,600}armDelConfirm/.test(src));
check('提示里带上会删多少条', src.includes('确认永久删除 ${n} 条 30 天前的执行记录'));
check('提示里说明删除后无法恢复', src.includes('删除后无法恢复'));
check('删完刷新列表', /purge-old[\s\S]{0,1200}refreshHistory\(\)/.test(src));
check('没有旧记录时不做破坏性操作', src.includes('没有 30 天前的记录，无需清理'));

/* ---- 后端是真删，不是软标记 ---- */
check('后端用 DELETE 语句真删', dbSrc.includes('DELETE FROM executions WHERE id IN'));
check('后端没有引入软删除字段',
  !/deleted_at|is_deleted|soft_delete/i.test(dbSrc));
check('清理函数带 running 保护', dbSrc.includes('status') && dbSrc.includes('running'));
check('用 julianday 比较时间（跨时区偏移安全）', dbSrc.includes('julianday(started_at)'));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
