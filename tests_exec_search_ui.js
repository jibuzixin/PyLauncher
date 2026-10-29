/**
 * 执行记录搜索（前端）单元测试：
 *  - 多关键词按空格拆开，逐个都要命中（AND）
 *  - 匹配范围含：记录名（tab_name）/ 脚本名 / 标签 / 状态（中英文）/ 命令 / 参数
 *  - 服务端结果（histRows）就绪时直接用它，不再被本地过滤误杀
 *  - 服务端结果还没回来时，退回本地即时过滤
 *  - 源码级断言：接口带 kw 参数、搜索框 placeholder、histRowsKw 一致性校验
 *
 * 跑法：node tests_exec_search_ui.js
 */
const fs = require('fs');
const path = require('path');
const { readApp, extract } = require('./tests_jsutil');

const src = readApp();

let failed = 0;
function check(desc, ok, extra) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok || !extra ? '' : `\n      ${extra}`));
}

/* ---- 纯函数：抠出来直接跑 ---- */
const sandbox = { state: { histKw: '', histRows: null, histRowsKw: '', executions: [] } };
new Function('exports', 'state',
  extract(src, 'jparse') + '\n' +
  extract(src, 'STATUS_TEXT') + '\n' +
  extract(src, 'EXEC_STATUS_ALIAS') + '\n' +
  extract(src, 'historyFiltered') + '\n' +
  extract(src, 'findExecution') + '\n' +
  'exports.historyFiltered = historyFiltered;\n' +
  'exports.findExecution = findExecution;'
)(sandbox, sandbox.state);

const { historyFiltered, findExecution } = sandbox;
const st = sandbox.state;

const SAMPLE = [
  { id: 1, script_name: '评测脚本.py', tab_name: '1022-知识库评测部分', status: 'success', tags: '["重要"]', command: 'uv run a.py --mode 知识库', args: '{"mode":"知识库"}', output: '' },
  { id: 2, script_name: '上传图片.py', tab_name: '', status: 'failed', tags: '["飞书"]', command: 'uv run b.py', args: '{}', output: 'boom' },
  { id: 3, script_name: '导出报表.py', tab_name: '月度报表', status: 'running', tags: '[]', command: 'uv run c.py', args: '{}', output: '' },
  // 状态与输出文字相反的记录：状态词只按状态判，不能被输出里的字带偏
  { id: 4, script_name: '校验脚本.py', tab_name: '', status: 'success', tags: '[]', command: 'uv run d.py', args: '{}', output: '共 3 项失败' },
  { id: 5, script_name: '审计脚本.py', tab_name: '', status: 'failed', tags: '[]', command: 'uv run e.py', args: '{}', output: '全部成功' },
];

function reset(kw = '', rows = null) {
  st.histKw = kw;
  st.histRows = rows;
  st.histRowsKw = rows ? kw : '';
  st.executions = SAMPLE.slice();
}
function ids(list) { return list.map(r => r.id); }

/* ---- 本地即时过滤（服务端结果还没回来的窗口） ---- */
reset('知识库');
check('本地过滤能按记录名命中', ids(historyFiltered()).includes(1));
reset('上传图片');
check('本地过滤能按脚本名命中', ids(historyFiltered()).includes(2));
reset('飞书');
check('本地过滤能按标签命中', ids(historyFiltered()).includes(2));
reset('失败');
check('本地过滤能按中文状态命中', ids(historyFiltered()).includes(2));
check('状态词不把输出里的「失败」二字算进来（本地侧）',
  !ids(historyFiltered()).includes(4), JSON.stringify(ids(historyFiltered())));
reset('failed');
check('本地过滤能按英文状态命中', ids(historyFiltered()).includes(2));
reset('成功');
check('本地过滤能按中文状态命中（成功）', ids(historyFiltered()).includes(1));
check('状态词不误伤：输出含「成功」但状态是 failed 的记录不该被捞进来',
  !ids(historyFiltered()).includes(5), JSON.stringify(ids(historyFiltered())));
reset('全部成功');
check('只在输出里的词也能被本地过滤命中（避免闪「无匹配」）',
  ids(historyFiltered()).includes(5), JSON.stringify(ids(historyFiltered())));
reset('共 3 项失败');
check('只在输出里的中文词也能被本地过滤命中',
  ids(historyFiltered()).includes(4), JSON.stringify(ids(historyFiltered())));
reset('月度');
check('本地过滤能按记录名命中（另一条）', ids(historyFiltered()).includes(3));

/* ---- 多关键词 AND ---- */
reset('知识库 评测');
check('两个词都命中才算命中', ids(historyFiltered()).length === 1 && ids(historyFiltered())[0] === 1);
reset('知识库 上传图片');
check('只命中一个词的被排除', ids(historyFiltered()).length === 0);

/* ---- 空关键词 → 全部 ---- */
reset('');
check('空关键词返回全部记录', historyFiltered().length === 5);

/* ---- 服务端结果就绪时直接用，不再二次过滤 ---- */
reset('服务端独有', [{ id: 99, script_name: 'x.py', tab_name: '服务端独有', status: 'success', tags: '[]', command: '', args: '' }]);
check('服务端结果直接采用', ids(historyFiltered()).includes(99));

reset('关键词', [{ id: 98, script_name: 'y.py', tab_name: '别的名字', status: 'success', tags: '[]', command: '', args: '' }]);
// histRowsKw 与当前关键词一致 → 认为是服务端结果，直接返回
st.histRowsKw = '关键词';
check('服务端结果命中即使本地字段不含关键词', ids(historyFiltered()).includes(98));

// histRowsKw 与当前关键词不一致（请求在途中）→ 退回本地过滤
st.histRowsKw = '旧关键词';
check('关键词不一致时退回本地过滤', !ids(historyFiltered()).includes(98));

/* ---- findExecution：能取到服务端搜出来的老记录 ---- */
reset('老记录', [{ id: 77, script_name: 'z.py', tab_name: '老记录', status: 'success', tags: '[]', command: '', args: '' }]);
st.histRowsKw = '老记录';
check('findExecution 能找到服务端结果里的记录', findExecution(77) && findExecution(77).id === 77);
check('findExecution 能找到最近列表里的记录', findExecution(1) && findExecution(1).id === 1);

/* ---- 源码级断言 ---- */
check('执行记录接口带 kw 参数', src.includes("/api/executions?limit=200&kw="));
check('后端路由声明了 kw', fs.readFileSync(path.join(__dirname, 'main.py'), 'utf8').includes('kw: Optional[str] = None'));
check('搜索框 placeholder 提到记录名', src.includes('搜索执行记录：记录名 / 脚本名 / 标签 / 状态…'));
check('关键词变化时会丢弃过期结果', src.includes('histRowsKw'));
check('后端有状态中文别名表', fs.readFileSync(path.join(__dirname, 'db.py'), 'utf8').includes('EXEC_STATUS_ALIAS'));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
