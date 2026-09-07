@echo off
rem ============================================================
rem  Python 脚本启动器 · Windows 停止脚本
rem  双击即可停止运行中的服务（相当于关闭服务器）
rem ============================================================
echo 正在停止 Python 脚本启动器...

set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8900" ^| findstr "LISTENING"') do (
  if not defined FOUND (
    set "FOUND=1"
    echo 结束进程 PID: %%a
    taskkill /F /PID %%a >nul 2>nul
  )
)

if not defined FOUND (
  echo 服务当前未在运行。
) else (
  echo.
  echo ✓ 服务已停止。
)
pause
