#!/bin/bash
# ============================================================
#  ToolLauncher v2（新版界面）· macOS 启动脚本
#  与原项目（8900 端口）并存，使用 8901 端口，互不影响
# ============================================================
cd "$(dirname "$0")" || exit 1

PORT=8901

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

# 若本副本已在运行，只打开浏览器
if lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT/?t=$(date +%s)"
  exit 0
fi

# 后台常驻启动（关闭本窗口不影响）
LAUNCHER_PORT=$PORT nohup .venv/bin/python main.py > "$HOME/.tool-launcher-v2.log" 2>&1 &
disown
sleep 2
open "http://127.0.0.1:$PORT/?t=$(date +%s)"
