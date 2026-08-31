# Python 脚本启动器 v0.0.4

一个本地运行的脚本启动平台：把「进入目录 → 敲命令行 → 看终端输出」的可视化为一个按钮。
本质是在指定目录下用 `uv` 拼接并执行命令行参数。

## 功能

- **脚本导入**：扫描目录自动解析导入 `.py` 脚本（递归，自动跳过 `.venv`/`__pycache__` 等），或指定文件路径 / **文件选择器上传**（上传会复制到 `imported/` 管理目录）
- **名称与描述**：导入时可自定义显示名称与描述；描述默认自动取自 argparse 的 `description`；导入后点击脚本名/描述即可随时编辑
- **参数表单**：自动解析 `argparse` 参数定义生成表单（文本框/数字/开关/下拉/多值），**必选参数置顶**；参数说明显示在输入框上方；每个参数带**类型标签**（int/float/bool/enum/list 彩色区分）；输入自动保存，下次打开自动恢复
- **参数预设**：一键把当前表单另存为命名预设，点击预设即复写表单
- **实时控制台**：WebSocket 流式显示 stdout/stderr，带**行号**、行号悬浮**复制单行**、拖选**多选复制**；**每次执行自动清空**，每个脚本独立查看
- **执行记录**：每次执行完整记录（含标准输出），支持**添加标签**、按标签/脚本/状态筛选、**默认显示全部脚本记录**（可切「当前脚本」只看某个脚本）、一键用旧参数重跑
- **uv 集成**：启动时检测 uv（缺失给出 mac/win 安装指引，状态用红绿标识）；按脚本目录管理独立 venv，「初始化环境」按钮一键 `uv venv` + 自动安装依赖；依赖文件**同时兼容 `requirements.txt` 与 `pyproject.toml`**（pyproject 走 `uv sync`）；支持**自定义依赖文件路径**（依赖文件不在脚本同目录时，可在编辑信息或环境栏指定并「安装依赖」）；执行走 `uv run --project <目录>`
- **标签过滤**：给脚本添加多个**标签**（编辑脚本信息即可），侧边栏**多选标签**即可过滤显示想看的脚本，可随时清除
- **重新加载**：脚本文件更新后一键重新解析参数（无需重新导入）
- **批量迁移**：一键**导出全部脚本信息**（名称/路径/描述/参数/标签/预设）为 JSON，另一台机器**导入**即可恢复
- **便捷操作**：打开脚本所在目录、复制脚本绝对路径、执行中可终止
- **安全确认**：所有删除操作（脚本/预设/记录/清空历史）均有二次确认
- **存储**：数据全部存于本地 `sqlite`（`launcher.db`）
- **UI**：极简黑白风；颜色规范统一——成功绿色、错误红色、可忽略灰色、常规黑色
- **后台常驻**：`start.command` 以后台进程启动，关闭终端窗口不影响使用；再次双击会直接打开浏览器

## 快速开始

### macOS

```bash
cd launcher
uv venv && uv pip install -r requirements.txt
./start.command        # 或：.venv/bin/python main.py --no-browser
```

双击 `start.command` 亦可（首次自动初始化；启动后**后台常驻**并自动打开浏览器）。

### Windows

双击 `start.bat`，或：

```powershell
cd launcher
uv venv
uv pip install -r requirements.txt
.venv\Scripts\python.exe main.py
```

启动后访问 http://127.0.0.1:8900

## 接入你自己的脚本（约定）

> **你的脚本必须使用 argparse 解析命令行参数**，启动器会自动解析出参数定义。

```python
import argparse

p = argparse.ArgumentParser(description="我的工具")
p.add_argument("input", help="必选位置参数")               # 位置参数 → 文本框（必选）
p.add_argument("-n", "--num", type=int, default=3)        # int → 数字框
p.add_argument("--ratio", type=float, default=0.5)        # float → 数字框
p.add_argument("--verbose", action="store_true")          # 布尔 → 开关
p.add_argument("--mode", choices=["fast", "slow"])        # choices → 下拉
p.add_argument("--tags", action="append", default=[])     # append → 多值（逗号分隔）
p.add_argument("--opt", required=True, help="必选可选参数") # required → 必填置顶
args = p.parse_args()
```

支持的类型映射：

| argparse 写法 | 表单控件 |
|---|---|
| 位置参数 / 普通 `--opt` | 文本框 |
| `type=int` / `type=float` | 数字输入框 |
| `action="store_true"/"store_false"` | 开关 |
| `choices=[...]` | 下拉框 |
| `action="append"` / `nargs="+"` | 多值输入（英文逗号分隔） |
| `required=True` | 必填（置顶 + 红星） |

## 项目结构

```
launcher/
├── main.py           # FastAPI 后端入口（REST + WebSocket）
├── db.py             # sqlite 数据层
├── scanner.py        # 目录扫描 + argparse AST 解析
├── executor.py       # uv 检测 / venv 管理 / 进程执行 / 流式输出
├── static/           # 前端（极简黑白 UI）
├── examples/         # 演示脚本（可删除）
├── start.command     # macOS 启动脚本
├── start.bat         # Windows 启动脚本
└── launcher.db       # 数据文件（自动生成）
```

## 数据与隐私

- 全部数据保存在本地 `launcher.db`（脚本注册表、参数预设、执行记录、配置）
- 执行记录仅保留程序结束后的**最后 1000 行**输出；可在顶部「清空历史」手动清理
- 命令以 `subprocess` 参数列表方式执行（不经过 shell），参数值天然防注入

## 常见问题

- **提示未检测到 uv** → 按弹窗指引安装（mac: `brew install uv`；win: PowerShell 安装命令），装完点「重新检测」
- **脚本无法导入** → 确认脚本里用了 `argparse` 且包含至少一个 `add_argument`
- **脚本依赖其他包** → 把依赖写入脚本同目录的 `requirements.txt` 或 `pyproject.toml`，点「初始化环境」即可自动安装；依赖文件在别处时，可在「编辑脚本信息」里指定路径
- **关闭窗口后服务还在吗** → 在，`start.command` 以后台方式运行；再双击一次即可打开浏览器
- **端口占用** → 设置环境变量 `LAUNCHER_PORT` 指定其他端口
