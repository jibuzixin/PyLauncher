#!/bin/bash
# ============================================================
#  Python 脚本启动器 · macOS 启动脚本
#  双击即可启动，首次运行自动创建虚拟环境并安装依赖
#  服务器在后台常驻运行，关闭本窗口不影响使用
# ============================================================
cd "$(dirname "$0")" || exit 1

if [ ! -x ".venv/bin/python" ]; then
  echo "首次运行：正在创建虚拟环境并安装依赖..."
  if ! command -v uv >/dev/null 2>&1; then
    echo "未检测到 uv，请先安装：brew install uv"
    echo "安装完成后重新双击本脚本。"
    read -r -p "按回车键退出..."
    exit 1
  fi
  uv venv || exit 1
  uv pip install -r requirements.txt || exit 1
fi

# 若服务已在运行，只打开浏览器（带时间戳，强制加载最新页面而非旧缓存）
if lsof -i :8900 -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://127.0.0.1:8900/?t=$(date +%s)"
  exit 0
fi

# 后台常驻启动（日志写入用户目录，关闭窗口不影响）
nohup .venv/bin/python main.py --host 0.0.0.0 > "$HOME/.tool-launcher.log" 2>&1 &
disown
sleep 2
open "http://127.0.0.1:8900/?t=$(date +%s)"
