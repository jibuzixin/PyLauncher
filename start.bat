@echo off
rem ============================================================
rem  Tool Launcher · Windows 启动脚本
rem  双击即可启动，首次运行会自动创建虚拟环境并安装依赖
rem ============================================================
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo 首次运行：正在创建虚拟环境并安装依赖...
  where uv >nul 2>nul
  if errorlevel 1 (
    echo 未检测到 uv，请先在 PowerShell 中安装：
    echo   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
    echo 安装完成后重新双击本脚本。
    pause
    exit /b 1
  )
  uv venv || goto :err
  uv pip install -r requirements.txt || goto :err
)

.venv\Scripts\python.exe main.py
goto :eof

:err
echo 初始化失败，请检查上方错误信息。
pause
