/**
 * 可视化 cron 构建器的回归测试（node 直接跑，无需浏览器）。
 *
 * 曾经的 bug：<input type="time"> 的值是 "HH:MM"，构建器却把它当成
 * "分:时" 写进 cron，于是选 09:00 变成每天 00:09、选 02:59 直接越界报错。
 *
 * 跑法：node tests_cron_builder.js
 */
const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, 'static', 'app.js');

/** 从 app.js 里抠出指定名字的顶层声明（const / function），做纯函数测试 */
function extract(src, name) {
  const constIdx = src.indexOf(`const ${name} =`);
  const funcIdx = src.indexOf(`function ${name}(`);
  let start, end;
  if (constIdx >= 0 && (funcIdx < 0 || constIdx < funcIdx)) {
    start = constIdx;
    // 按括号深度找声明结尾（兼容多行的数组 / 对象字面量）
    let depth = 0, i = src.indexOf('=', start) + 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ';' && depth <= 0) { i++; break; }
    }
    end = i;
  } else {
    start = funcIdx;
    // 用大括号配平找函数体结尾
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    end = i;
  }
  if (start < 0 || end < 0) throw new Error(`app.js 里找不到 ${name}`);
  return src.slice(start, end);
}

const src = fs.readFileSync(APP_JS, 'utf8');
const sandbox = {};
const factory = new Function(
  'exports',
  extract(src, 'CRON_RANGES') + '\n' +
  extract(src, 'CRON_FIELD_NAMES') + '\n' +
  extract(src, 'CRON_ALIAS') + '\n' +
  extract(src, 'cronValidate') + '\n' +
  extract(src, 'timeToCronFields') + '\n' +
  'exports.cronValidate = cronValidate; exports.timeToCronFields = timeToCronFields;'
);
factory(sandbox);
const { cronValidate, timeToCronFields } = sandbox;

let failed = 0;
function check(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`));
}

/* ---- 时/分不能写反 ---- */
check('09:00 → 09 点 00 分', timeToCronFields('09:00'), { mm: '00', hh: '09' });
check('02:59 → 2 点 59 分', timeToCronFields('02:59'), { mm: '59', hh: '02' });
check('00:00 → 0 点 0 分', timeToCronFields('00:00'), { mm: '00', hh: '00' });
check('23:59 → 23 点 59 分', timeToCronFields('23:59'), { mm: '59', hh: '23' });
check('空值回落到 09:00', timeToCronFields(''), { mm: '00', hh: '09' });

/* ---- 越界表达式要能说清是哪个字段 ---- */
check('时字段 59 报错', cronValidate('02 59 * * *'), '时字段取值范围是 0-23，当前是 59');
check('分字段 60 报错', cronValidate('60 0 * * *'), '分字段取值范围是 0-59，当前是 60');
check('月字段 13 报错', cronValidate('0 0 1 13 *'), '月字段取值范围是 1-12，当前是 13');
check('周字段 8 报错', cronValidate('0 0 * * 8'), '周字段取值范围是 0-7，当前是 8');
check('段数不对报错', cronValidate('0 9 * *'), 'cron 需要 5 段：分 时 日 月 周');
check('区间颠倒报错', cronValidate('0 0 * * 5-1'), '周字段区间 5-1 的起止顺序颠倒了');
check('步长非法报错', cronValidate('0 0 * * */0'), '周字段步长 0 非法');

/* ---- 合法表达式不能被误杀 ---- */
for (const expr of [
  '* * * * *', '*/5 * * * *', '0 */2 * * *', '0 9 * * *', '0 9 * * 1-5',
  '0 9 * * mon', '0 9 * jan *', '0 0 1 1 *', '30 2 15 * 6', '0 0 * * 0,7',
]) {
  check(`合法表达式放行：${expr}`, cronValidate(expr), '');
}

console.log(failed ? `\n${failed} 个用例失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
