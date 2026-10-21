/**
 * 测试用的小工具：从 static/app.js 里抠出指定的顶层函数 / 常量，做纯函数测试。
 * 纯函数之外的部分（DOM 事件、接口调用）用源码级断言覆盖。
 */
const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, 'static', 'app.js');

function readApp() {
  return fs.readFileSync(APP_JS, 'utf8');
}

/** 从 app.js 里抠出指定名字的顶层声明（const / function） */
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

module.exports = { APP_JS, readApp, extract };
