#!/bin/bash
# ============================================================
#  Python 脚本启动器 · macOS 停止脚本
#  双击即可停止后台运行的服务（相当于关闭服务器）
# ============================================================
echo "正在停止 Python 脚本启动器…"

# 找到监听 8900 端口的进程并结束
PID=$(lsof -ti :8900 -sTCP:LISTEN 2>/dev/null)
if [ -n "$PID" ]; then
  kill "$PID" 2>/dev/null
  sleep 1.5
  if lsof -ti :8900 -sTCP:LISTEN >/dev/null 2>&1; then
    # 未退出则强制结束
    lsof -ti :8900 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null
    sleep 1
  fi
  if lsof -ti :8900 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "⚠ 端口 8900 仍被占用，请手动检查。"
  else
    echo "✓ 服务已停止。"
  fi
else
  echo "服务当前未在运行。"
fi
