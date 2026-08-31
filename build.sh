#!/bin/bash
# ============================================================
#  构建脚本：把 static/app.js 与 static/style.css 内联进页面
#  使页面不依赖外部静态资源，彻底规避浏览器缓存旧 JS 的问题
#  用法：改完 app.js / style.css / index.template.html 后运行 ./build.sh
# ============================================================
cd "$(dirname "$0")" || exit 1

python3 - <<'EOF'
import re
from pathlib import Path

base = Path("static")
tpl = (base / "index.template.html").read_text(encoding="utf-8")
css = (base / "style.css").read_text(encoding="utf-8")
js = (base / "app.js").read_text(encoding="utf-8")

html = re.sub(
    r'<link rel="stylesheet" href="/static/style\.css\?v=\d+">',
    lambda m: "<style>\n" + css + "\n</style>",
    tpl,
)
html = re.sub(
    r'<script src="/static/app\.js\?v=\d+"></script>',
    lambda m: "<script>\n" + js + "\n</script>",
    html,
)
(base / "index.html").write_text(html, encoding="utf-8")
print(f"构建完成：index.html 已内联 JS+CSS（{len(html)} 字节）")
EOF
