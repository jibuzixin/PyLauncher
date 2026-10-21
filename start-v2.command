#!/bin/bash
# ============================================================
#  ToolLauncher v2（新版界面）· macOS 启动脚本
#  与原项目（8900 端口）并存，使用 8901 端口，互不影响
#
#  浏览器只由本脚本打开一次（后端带 --no-browser 启动），
#  避免一次启动弹出两个标签页。
# ============================================================
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8901}"
MARK="$HOME/.tool-launcher.started.$PORT"

# Finder 双击启动时 PATH 很窄（通常不含 Homebrew），这里补上常见安装位置，
# 否则后端 shutil.which("uv") 找不到 uv，会误报「未检测到 uv」
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ ! -x ".venv/bin/python" ]; then
  echo "首次运行：正在创建虚拟环境并安装依赖..."
  if ! command -v uv >/dev/null 2>&1; then
    echo "未检测到 uv，请先安装：brew install uv"
    read -r -p "按回车键退出..."
    exit 1
  fi
  uv venv || exit 1
  uv pip install -r requirements.txt || exit 1
fi

# 服务刚启动过（几秒内）就不再重复开标签页：可能是重复双击，
# 先启动的那一次已经负责打开浏览器了
skip_open() {
  [ -f "$MARK" ] || return 1
  local age=$(( $(date +%s) - $(cat "$MARK" 2>/dev/null || echo 0) ))
  [ "$age" -ge 0 ] && [ "$age" -lt 8 ]
}

# 若本副本已在运行，只打开浏览器
if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if skip_open; then
    echo "服务刚启动，已跳过重复打开浏览器。"
    exit 0
  fi
  open "http://127.0.0.1:$PORT/?t=$(date +%s)"
  exit 0
fi

# 后台常驻启动（关闭本窗口不影响）
# --no-browser：浏览器统一由本脚本打开，避免脚本和后端各开一个标签页
LAUNCHER_PORT=$PORT nohup .venv/bin/python main.py --no-browser > "$HOME/.tool-launcher-v2.log" 2>&1 &
disown

# 等端口真正起来再打开浏览器，避免打开一个还连不上的页面
for _ in $(seq 1 60); do
  lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done
open "http://127.0.0.1:$PORT/?t=$(date +%s)"
