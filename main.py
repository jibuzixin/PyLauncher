"""工具脚本启动器 - FastAPI 后端入口。

启动：uv run --project launcher python -m launcher.main
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import webbrowser
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Optional

from croniter import croniter
from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import executor
import scanner

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
CONSOLE_TABS_KEY = "console_tabs"


def _login_shell_path() -> str:
    """问一次用户的登录 shell 要 PATH。

    Finder 双击 / IDE 任务 / nohup 启动时进程继承的 PATH 很窄，而用户在终端里
    手动执行脚本时用的是登录 shell 的完整环境（含 Homebrew、conda 等）。
    这里在启动时把两边的差异补齐，这样无论用哪种方式启动启动器，
    它跑起来的脚本都能找到同样的命令。
    """
    shell = os.environ.get("SHELL") or "/bin/zsh"
    for argv in ([shell, "-l", "-c", "echo $PATH"], [shell, "-lic", "echo $PATH"]):
        try:
            out = subprocess.run(argv, capture_output=True, text=True, timeout=8)
        except (OSError, subprocess.SubprocessError):
            continue
        got = (out.stdout or "").strip()
        if out.returncode == 0 and got:
            return got
    return ""


def _extend_path() -> None:
    """补全进程 PATH：先并入登录 shell 的 PATH，再兜底常见可执行目录。

    只补 PATH，不去解析 shell 配置里 export 的变量 —— 那是另一回事，
    也不该把凭据无声地注入到每个子进程里。
    """
    fallback = [
        os.path.expanduser("~/.local/bin"),
        os.path.expanduser("~/.cargo/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    cur = os.environ.get("PATH", "")
    parts = cur.split(os.pathsep) if cur else []
    for src in (_login_shell_path(), os.pathsep.join(fallback)):
        for d in src.split(os.pathsep):
            d = d.strip()
            # 优先保留当前进程里已有的目录（含已激活的 conda 等虚拟环境）
            if d and os.path.isdir(d) and d not in parts:
                parts.append(d)
    os.environ["PATH"] = os.pathsep.join(parts)


_extend_path()


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # 设置页配置的环境变量：注入所有被运行的脚本
    try:
        executor.set_extra_env(db.get_run_env())
    except Exception:  # noqa: BLE001
        executor.set_extra_env({})
    # 启动时清理上次进程遗留的 running 记录（服务重启后旧进程已不存在）
    try:
        n = db.mark_stale_running()
        if n:
            print(f"[startup] 清理 {n} 条遗留的 running 记录 → failed", flush=True)
    except Exception:  # noqa: BLE001
        pass
    # 同理：定时任务卡在「运行中」也是上次进程留下的，进程都没了不可能还在跑
    try:
        n = db.mark_stale_sched_running()
        if n:
            print(f"[startup] 清理 {n} 条遗留的定时任务 running 状态 → failed", flush=True)
    except Exception:  # noqa: BLE001
        pass
    # 队列同理：上次进程被杀掉时，正在跑的那一项没人收尾，
    # 把它放回「待执行」、队列回到「等待开始」，服务起来后接着跑
    try:
        db.recover_queues()
    except Exception:  # noqa: BLE001
        pass
    # 定时任务调度循环（服务生命周期内常驻）
    task = asyncio.create_task(_schedule_loop())
    # 运行队列单独跑一个更快的循环：队列要尽量贴着用户设的开始时间开跑
    qtask = asyncio.create_task(_queue_loop())
    try:
        yield
    finally:
        task.cancel()
        qtask.cancel()


app = FastAPI(title="Tool Launcher", docs_url=None, redoc_url=None, lifespan=_lifespan)

# ---------------- 数据模型 ----------------

class ScanReq(BaseModel):
    directory: str
    recursive: bool = True


class ScriptImportReq(BaseModel):
    path: str
    name: Optional[str] = None
    description: Optional[str] = None


class UpdateScriptReq(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    deps_path: Optional[str] = None
    venv_path: Optional[str] = None
    tags: Optional[list[str]] = None


class ParseCommandReq(BaseModel):
    command: str


class FolderReq(BaseModel):
    name: str


class MoveReq(BaseModel):
    folder_id: Optional[int] = None


class SaveArgsReq(BaseModel):
    args: dict


class PresetReq(BaseModel):
    name: str
    args: dict
    # 用户自定义命令的前缀 / 后缀；中间的参数段始终由系统按 args 生成，不存
    cmd_prefix: Optional[str] = None
    cmd_suffix: Optional[str] = None


class PresetPatchReq(BaseModel):
    """预设管理：固定 / 取消固定 / 手动排序 / 标记最近使用。"""
    pinned: Optional[bool] = None
    order: Optional[str] = None  # "up" | "down"
    touch: Optional[bool] = None


class ExecuteReq(BaseModel):
    script_id: int
    args: dict
    preset_id: Optional[int] = None
    command: Optional[str] = None  # 用户手动编辑的整条命令；为空则自动生成


class CommandReq(BaseModel):
    script_id: int
    args: dict = {}


class TagsReq(BaseModel):
    tags: list[str]


class TabNameReq(BaseModel):
    name: str = ""


class ConsoleTabsReq(BaseModel):
    ids: list = []


class ClearReq(BaseModel):
    script_id: Optional[int] = None


class OpenDirReq(BaseModel):
    path: str


class ScheduleReq(BaseModel):
    script_id: int
    name: str
    cron: str
    args: dict = {}
    enabled: bool = True
    max_runs: Optional[int] = None
    preset_id: Optional[int] = None
    # 自定义命令的前缀 / 后缀：定时任务执行时和参数段一起用上
    cmd_prefix: Optional[str] = None
    cmd_suffix: Optional[str] = None


class ScheduleUpdateReq(BaseModel):
    name: Optional[str] = None
    cron: Optional[str] = None
    args: Optional[dict] = None
    enabled: Optional[bool] = None
    max_runs: Optional[int] = None
    preset_id: Optional[int] = None
    # 自定义命令的前缀 / 后缀：定时任务执行时和参数段一起用上
    cmd_prefix: Optional[str] = None
    cmd_suffix: Optional[str] = None


class CronPreviewReq(BaseModel):
    cron: str


class QueueReq(BaseModel):
    """新建运行队列：名字 + 开始时间 + 间隔 + 出错策略 + 队列里的定时任务。"""
    name: str
    start_at: str
    interval_seconds: int = 5
    stop_on_error: bool = False
    schedule_ids: list[int] = []


class QueueUpdateReq(BaseModel):
    name: Optional[str] = None
    start_at: Optional[str] = None
    interval_seconds: Optional[int] = None
    stop_on_error: Optional[bool] = None


class QueueItemReq(BaseModel):
    schedule_id: int


class QueueMoveReq(BaseModel):
    direction: str = "up"          # up | down


class QueueRestartReq(BaseModel):
    start_at: Optional[str] = None


class QueueReorderReq(BaseModel):
    schedule_ids: list[int] = []


class MetaReq(BaseModel):
    key: str
    value: str


class HostReq(BaseModel):
    lan: bool


# ---------------- 流式会话（执行 / 环境初始化共用） ----------------

_SESSIONS: dict[int, dict] = {}


async def _emit(session_id: int, stream: str, line: str) -> None:
    sess = _SESSIONS.get(session_id)
    if not sess:
        return
    # 记录接收时刻（HH:MM:SS），并限制 buffer 体积：只保留最近 1500 块，
    # 避免超长输出（几千行）导致详情页 WS 重放卡顿；DB 落库时再截到 1000 行。
    sess["buffer"].append((stream, line, datetime.now().strftime("%H:%M:%S")))
    if len(sess["buffer"]) > 1500:
        over = len(sess["buffer"]) - 1500
        del sess["buffer"][:over]
        # 截断会令活跃连接的读取指针错位：统一前移，避免丢行或重复
        for h in sess["readers"]:
            h[0] = max(0, h[0] - over)
    async with sess["cond"]:
        sess["cond"].notify_all()


async def _run_in_session(session_id: int, coro: Callable[[Callable], Any]) -> None:
    sess = _SESSIONS.get(session_id)
    if not sess:
        return
    try:
        result = await coro(lambda s, l: _emit(session_id, s, l))
    except asyncio.CancelledError:
        result = {"ok": False, "message": "任务被取消"}
    except Exception as e:  # noqa: BLE001
        result = {"ok": False, "message": str(e)}
    sess["buffer"].append(("__done__", result, ""))
    sess["done"] = True
    async with sess["cond"]:
        sess["cond"].notify_all()
    return result


def _new_session(session_id: int) -> None:
    _SESSIONS[session_id] = {"buffer": [], "cond": asyncio.Condition(), "done": False, "readers": []}


async def _ws_pump(ws: WebSocket, session_id: int) -> None:
    """把会话缓冲区内容通过 WS 推送给前端。"""
    await ws.accept()
    sess = _SESSIONS.get(session_id)
    if not sess:
        await ws.send_json({"type": "done", "result": {"ok": False, "message": "会话不存在"}})
        await ws.close()
        return
    holder = [0]
    sess["readers"].append(holder)
    try:
        while True:
            idx = holder[0]
            while idx < len(sess["buffer"]):
                stream, data, ts = sess["buffer"][idx]
                holder[0] = idx + 1
                idx += 1
                if stream == "__done__":
                    await ws.send_json({"type": "done", "result": data})
                    await ws.close()
                    return
                await ws.send_json({"type": "line", "stream": stream, "line": data, "ts": ts})
            async with sess["cond"]:
                await sess["cond"].wait()
    finally:
        try:
            sess["readers"].remove(holder)
        except ValueError:
            pass


# ---------------- 执行逻辑 ----------------

def build_arg_list(schema_args: list[dict], values: dict) -> list[str]:
    """把表单值转换为命令行参数列表（顺序：位置参数在前，可选参数按 schema 顺序）。"""
    result: list[str] = []
    positionals = [a for a in schema_args if a["kind"] == "positional"]
    optionals = [a for a in schema_args if a["kind"] == "optional"]

    for a in positionals:
        v = values.get(a["dest"])
        if v is None or v == "":
            continue
        result.append(str(v))

    for a in optionals:
        flag = a["name"]
        v = values.get(a["dest"])
        if a.get("is_flag"):
            on = v in (True, "true", "True", 1, "1", "on")
            if a["action"] == "store_true" and on:
                result.append(flag)
            elif a["action"] == "store_false" and not on:
                result.append(flag)
            continue
        if v is None:
            continue
        if isinstance(v, (list, tuple)):
            if not v:
                continue
            if a.get("action") == "append":
                # append：每个值重复一次 flag（--tags v1 --tags v2）
                for item in v:
                    result.append(flag)
                    result.append(str(item))
            else:
                # nargs：一个 flag 后跟多个值（--flag v1 v2 v3）
                result.append(flag)
                for item in v:
                    result.append(str(item))
            continue
        s = str(v)
        if s == "":
            if a["required"]:
                result.append(flag)
                result.append("")
            continue
        result.append(flag)
        result.append(s)
    return result


def parse_command_args(schema_args: list[dict], command: str, script_path: str) -> dict:
    """把用户粘贴的命令行解析为参数值 dict。支持：
    - 完整命令（uv run ... script.py ...）与纯参数片段（--key value / -k value / --key=value）
    - 换行多行（shlex 视空白与换行为等价分隔）
    - 缺失参数（required 未填 → missing）、未知参数（unknown）、多余位置参数（extra）
    - 类型转换失败 → errors（dest -> 说明），失败项保留原文便于人工修正
    """
    import shlex
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError as e:
        return {"ok": False, "error": f"命令行无法解析（引号/转义不匹配）：{e}"}
    if not tokens:
        return {"ok": False, "error": "命令行内容为空"}

    # ---- 1. 剥离执行前缀：定位脚本路径 token，其后才是参数 ----
    script = Path(script_path)
    script_names = {str(script), str(script.resolve()), script.name}
    params: list[str] = []
    idx = 0
    n = len(tokens)
    found_script = False
    while idx < n:
        t = tokens[idx]
        if t in script_names:
            found_script = True
            idx += 1
            break
        # venv python 可执行文件绝对路径（/bin/python、Scripts\python.exe 等）
        if t.endswith(("/python", "/python3", "\\python.exe", "/python.exe")):
            idx += 1
            continue
        # uv run / python 等前缀及它们的带值选项
        if t in ("uv", "run", "python", "python3", "-u", "-X", "--"):
            idx += 1
            continue
        if t in ("--project", "--script", "--directory", "-p"):
            idx += 2
            continue
        params.append(t)
        idx += 1
    if found_script:
        if idx < n and tokens[idx] == "--":
            idx += 1
        params.extend(tokens[idx:])
    else:
        # 未匹配到脚本路径：跳过 uv run --project DIR python -u 等前缀，直到第一个参数
        prefix_set = {"uv", "run", "python", "python3", "-u", "-X", "--", "-m"}
        i = 0
        while i < n:
            t = tokens[i]
            if t in prefix_set:
                i += 1
                continue
            if t in ("--project", "--script", "--directory", "-p"):
                i += 2
                continue
            if t.endswith(("/python", "/python3", "\\python.exe", "/python.exe")):
                i += 1
                continue
            if t.endswith(".py"):
                i += 1
                continue
            break
        params = tokens[i:]

    # ---- 2. 建立 option 映射与位置参数列表 ----
    opt_map: dict[str, dict] = {}
    positionals: list[dict] = []
    for a in schema_args:
        if a["kind"] == "positional":
            positionals.append(a)
        else:
            for os_ in (a.get("option_strings") or [a["name"]]):
                opt_map[os_] = a
            # 兼容 dest 变体：--max_workers 与 --max-workers 等价
            d = a["dest"]
            opt_map.setdefault("--" + d, a)
            opt_map.setdefault("--" + d.replace("_", "-"), a)

    parsed: dict = {}
    errors: dict = {}
    unknown: list[str] = []
    extra: list[str] = []
    multi: dict = {}  # nargs/append 收集

    def _is_known_flag(tok: str) -> bool:
        return tok.startswith("-") and tok != "-" and tok in opt_map

    def _conv(a: dict, raw: str):
        t = a.get("type", "str")
        try:
            if t == "int":
                return int(raw)
            if t == "float":
                return float(raw)
            if t == "bool":
                return raw.lower() in ("1", "true", "yes", "on", "y")
            return raw
        except (ValueError, TypeError):
            return None

    def _assign(a: dict, raw: str) -> None:
        v = _conv(a, raw)
        if v is None:
            errors.setdefault(a["dest"], f"「{raw}」不是有效的 {a.get('type', 'str')}")
            parsed[a["dest"]] = raw  # 保留原文，用户可直接修改
        else:
            parsed[a["dest"]] = v

    def _assign_multi(a: dict, raws: list[str]) -> None:
        vals = []
        for r in raws:
            v = _conv(a, r)
            if v is None:
                lst = errors.setdefault(a["dest"], [])
                if isinstance(lst, list):
                    lst.append(f"「{r}」不是有效的 {a.get('type', 'str')}")
            else:
                vals.append(v)
        if a.get("action") == "append":
            multi.setdefault(a["dest"], []).extend(vals)
        else:
            multi[a["dest"]] = vals

    pos_i = 0
    idx = 0
    n = len(params)
    while idx < n:
        tok = params[idx]
        if tok == "--":
            idx += 1
            while idx < n:
                if pos_i < len(positionals):
                    _assign(positionals[pos_i], params[idx])
                    pos_i += 1
                else:
                    extra.append(params[idx])
                idx += 1
            break
        if tok.startswith("-") and tok != "-" and len(tok) > 1:
            if tok.startswith("--") and "=" in tok:
                key, _, val = tok.partition("=")
                arg = opt_map.get(key)
                if arg is None:
                    unknown.append(key)
                    idx += 1
                    continue
                if arg.get("is_flag"):
                    parsed[arg["dest"]] = val.lower() in ("1", "true", "yes", "on")
                    idx += 1
                    continue
                _assign(arg, val)
                idx += 1
                continue
            arg = opt_map.get(tok)
            if arg is None:
                unknown.append(tok)
                idx += 1
                continue
            if arg.get("is_flag"):
                parsed[arg["dest"]] = arg.get("action") == "store_true"
                idx += 1
                continue
            if arg.get("action") == "append" or arg.get("nargs"):
                vals: list[str] = []
                idx += 1
                while idx < n and not _is_known_flag(params[idx]) and params[idx] != "--":
                    vals.append(params[idx])
                    idx += 1
                _assign_multi(arg, vals)
                continue
            if idx + 1 >= n:
                errors.setdefault(arg["dest"], f"{tok} 缺少值")
                idx += 1
                continue
            _assign(arg, params[idx + 1])
            idx += 2
            continue
        # 位置参数
        if pos_i < len(positionals):
            _assign(positionals[pos_i], tok)
            pos_i += 1
        else:
            extra.append(tok)
        idx += 1

    # ---- 3. 合并多值 ----
    for d, vals in multi.items():
        parsed[d] = vals

    # choices 校验
    for a in schema_args:
        ch = a.get("choices")
        if ch and a["dest"] in parsed and parsed[a["dest"]] not in ch and str(parsed[a["dest"]]) not in [str(c) for c in ch]:
            errors.setdefault(a["dest"], f"值不在可选范围内：{'/'.join(str(c) for c in ch)}")

    missing = [a["dest"] for a in schema_args if a.get("required") and a["dest"] not in parsed]
    return {"ok": True, "parsed": parsed, "missing": missing, "unknown": unknown, "extra": extra, "errors": errors}




def _merge_output_lines(chunks: list[tuple[str, str, str]]) -> tuple[list[str], list[str]]:
    """把原始输出块按终端语义合并为逻辑行：\r 覆盖当前行、\n（或 \r\n）换行。

    保留 ANSI 转义序列（历史详情前端做 ANSI 渲染）。返回 (lines, ts_lines)，
    ts_lines 与 lines 一一对应，为各逻辑行首次接收时刻（HH:MM:SS）。
    """
    lines: list[str] = []
    ts_lines: list[str] = []
    buf = ""
    buf_ts = None
    for _stream, line, ts in chunks:
        i, n = 0, len(line)
        if buf_ts is None:
            buf_ts = ts
        while i < n:
            ch = line[i]
            if ch == "\r":
                if i + 1 < n and line[i + 1] == "\n":
                    lines.append(buf)
                    ts_lines.append(buf_ts or ts)
                    buf, buf_ts = "", None
                    i += 2
                    continue
                # 单行进度条刷新：覆盖当前行，时间更新为当前块
                buf, buf_ts = "", ts
                i += 1
                continue
            if ch == "\n":
                lines.append(buf)
                ts_lines.append(buf_ts or ts)
                buf, buf_ts = "", None
                i += 1
                continue
            buf += ch
            i += 1
    if buf:
        lines.append(buf)
        ts_lines.append(buf_ts or (chunks[-1][2] if chunks else ""))
    return lines, ts_lines


def _shq(s: str) -> str:
    """Shell 双引号转义：仅含安全字符时原样返回，否则用双引号包裹。

    双引号在 macOS/Linux shell 与 Windows cmd 下均通用（单引号在 cmd 中不是字符串界定符）。
    """
    s = str(s)
    if s and all(c.isalnum() or c in "-_./@:=+%" for c in s):
        return s
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"' 


def _build_command_text(script_path: str, arg_list: list[str], venv_path: str = "") -> str:
    """生成可直接复制执行的命令文本（含 shell 转义），无法执行时返回带说明的提示。"""
    cmd, err = executor.build_command_ex(script_path, arg_list, venv_path=venv_path)
    if err:
        return "# " + err
    return " ".join(_shq(c) for c in cmd)


async def _execute_task(exec_id: int, script_path: str, arg_list: list[str], emit: Callable,
                         venv_path: str = "") -> dict:
    """后台执行任务，流式输出，结束后写库。venv_path 指定自定义虚拟环境。"""
    await emit("info", "· 环境检查中…\n")
    env = executor.inspect_env(script_path, venv_path=venv_path)
    if env.get("venv_source") == "custom" and not env.get("venv_broken"):
        await emit("info", "· 使用指定虚拟环境: " + (env.get("venv_python") or "") + "\n")
    if env.get("has_inline_meta"):
        await emit("info", "· PEP 723 内联脚本，uv 自动管理依赖\n")
    elif not env["has_venv"]:
        await emit("info", "⚠ 未检测到虚拟环境，请先点击「初始化环境」\n")
    # 预检：无 uv 且无 .venv 时直接报错，不启动进程
    plan = executor.execution_plan(script_path, venv_path)
    if plan["mode"] is None:
        await emit("error", f"✗ {plan['error']}\n")
        await emit("info", "· 执行结束：failed（退出码 -1）\n")
        db.finish_execution(exec_id, "failed", -1, [plan["error"]])
        return {"ok": False, "exit_code": -1, "terminated": False, "status": "failed", "message": plan["error"]}
    await emit("info", "$ " + _build_command_text(script_path, arg_list, venv_path) + "\n")

    result = await executor.run_script(exec_id, script_path, arg_list, emit)
    terminated = result.get("terminated", False)

    if terminated:
        status = "terminated"
    elif result.get("exit_code") == 0:
        status = "success"
    else:
        status = "failed"

    chunks = [(s, l, t) for s, l, t in _SESSIONS.get(exec_id, {"buffer": []})["buffer"] if s != "__done__"]
    lines, ts_lines = _merge_output_lines(chunks)
    db.finish_execution(exec_id, status, result.get("exit_code"), lines, ts_lines)
    await emit("info", f"· 执行结束：{status}（退出码 {result.get('exit_code')}）\n")
    result["status"] = status
    return result


async def _execute_command_task(exec_id: int, command: str, script_path: str, emit: Callable) -> dict:
    """直接执行用户编辑的整条命令，流式输出，结束后写库。"""
    await emit("info", "· 使用自定义命令执行\n")
    await emit("info", "$ " + command + "\n")
    result = await executor.run_command(exec_id, command, str(Path(script_path).parent), emit)
    terminated = result.get("terminated", False)
    if terminated:
        status = "terminated"
    elif result.get("exit_code") == 0:
        status = "success"
    else:
        status = "failed"
    chunks = [(s, l, t) for s, l, t in _SESSIONS.get(exec_id, {"buffer": []})["buffer"] if s != "__done__"]
    lines, ts_lines = _merge_output_lines(chunks)
    db.finish_execution(exec_id, status, result.get("exit_code"), lines, ts_lines)
    await emit("info", f"· 执行结束：{status}（退出码 {result.get('exit_code')}）\n")
    result["status"] = status
    return result


# ---------------- 定时任务调度 ----------------

def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _cron_next(expr: str, base: datetime) -> datetime:
    return croniter(expr, base).get_next(datetime)


# cron 各字段的取值范围与中文名：分 时 日 月 周
_CRON_FIELDS: tuple[tuple[str, int, int], ...] = (
    ("分", 0, 59),
    ("时", 0, 23),
    ("日", 1, 31),
    ("月", 1, 12),
    ("周", 0, 7),
)
# croniter 允许的英文别名（月份 / 星期）
_CRON_ALIAS: dict[int, tuple[str, ...]] = {
    3: ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"),
    4: ("sun", "mon", "tue", "wed", "thu", "fri", "sat"),
}


def _cron_field_error(field: str, idx: int) -> Optional[str]:
    """校验单个 cron 字段，返回错误文案；合法返回 None。"""
    for raw in field.split(","):
        p = raw.strip()
        if not p:
            return "存在空的取值"
        seg = p.split("/")
        if len(seg) > 2:
            return f"取值 {p} 非法"
        if len(seg) == 2 and (not seg[1].isdigit() or int(seg[1]) < 1):
            return f"步长 {seg[1]} 非法"
        base = seg[0]
        if base == "*":
            continue
        if base.lower() in _CRON_ALIAS.get(idx, ()):
            continue
        if not re.fullmatch(r"\d+(-\d+)?", base):
            return f"取值 {p} 非法"
        lo_s, _, hi_s = base.partition("-")
        a = int(lo_s)
        b = int(hi_s) if hi_s else a
        lo, hi = _CRON_FIELDS[idx][1], _CRON_FIELDS[idx][2]
        if a > b:
            return f"区间 {p} 的起止顺序颠倒了"
        if a < lo or b > hi:
            return f"取值范围是 {lo}-{hi}，当前是 {p}"
    return None


def _validate_cron(expr: str) -> Optional[str]:
    """校验 5 段 cron 表达式（分 时 日 月 周），返回中文错误文案；合法返回 None。

    croniter 自身的报错只说 "out of range"，用户看不出是哪一段越界，
    这里先按字段做一遍范围检查，把问题说清楚。
    """
    parts = expr.split()
    if len(parts) != 5:
        return f"cron 需要 5 段（分 时 日 月 周），当前是 {len(parts)} 段"
    for idx, field in enumerate(parts):
        err = _cron_field_error(field, idx)
        if err:
            return f"{_CRON_FIELDS[idx][0]}字段{err}"
    return None


def _check_cron(expr: str) -> Optional[str]:
    """表达式校验（字段范围 + croniter 语义），返回错误文案；合法返回 None。"""
    err = _validate_cron(expr)
    if err:
        return err
    try:
        _cron_next(expr, datetime.now().astimezone())
    except Exception as e:  # noqa: BLE001
        return str(e)
    return None


def _refresh_schedule_plan(schedule_id: int, cron: str, enabled: bool) -> None:
    """cron 或启停变化后：清空旧计划，并按新 cron 立即重算 next_run。

    这样前端保存/创建后无需等调度器 tick（最长 10 秒）即可拿到正确的下次执行时间。
    last_status 也要清空：启用 / 改 cron 之后，旧的「已达执行上限，已自动停用」
    之类的文案已经不适用了，留着会让前端把刚启用的任务显示成「暂停」。
    但正在执行中的任务不清——那会让卡片中途从「运行中」跳回「就绪」。
    """
    running = (db.get_schedule(schedule_id) or {}).get("last_status") == "running"
    db.set_schedule_runtime(schedule_id, clear_next_run=True, clear_last_status=not running)
    if enabled:
        try:
            nr = _cron_next(cron, datetime.now().astimezone())
            db.set_schedule_runtime(schedule_id, next_run=_iso(nr))
        except Exception as e:  # noqa: BLE001
            db.set_schedule_runtime(schedule_id, last_status=f"cron 无效: {e}")


# 正在执行中的定时任务：id → 正在跑的次数
# 脚本跑完之前不被下一轮 cron 重复触发（执行时间可能超过一个 cron 周期）
_SCHED_RUNNING: dict[int, int] = {}


def _sched_running_count(schedule_id: int) -> int:
    """该任务当前有几个执行实例在跑。"""
    return _SCHED_RUNNING.get(schedule_id, 0)


def _sched_begin(schedule_id: int) -> None:
    _SCHED_RUNNING[schedule_id] = _sched_running_count(schedule_id) + 1


def _sched_end(schedule_id: int) -> None:
    n = _sched_running_count(schedule_id) - 1
    if n > 0:
        _SCHED_RUNNING[schedule_id] = n
    else:
        _SCHED_RUNNING.pop(schedule_id, None)


async def _sched_run(exec_id: int, sched: dict, script_path: str, arg_list: list[str],
                    venv_path: str = "", cmd_text: str = "") -> None:
    """定时触发的一次执行：走标准 session 流程并落库，结束后回写 last_status。"""
    async def coro(emit: Callable) -> dict:
        # 带自定义前后缀时走「整条命令」路径，和脚本页手动运行时一致
        if cmd_text:
            return await _execute_command_task(exec_id, cmd_text, script_path, emit)
        return await _execute_task(exec_id, script_path, arg_list, emit, venv_path)
    status = "failed"
    try:
        result = await _run_in_session(exec_id, coro) or {}
        status = result.get("status") or "failed"
    except asyncio.CancelledError:
        status = "terminated"
        raise
    except Exception:  # noqa: BLE001
        status = "failed"
    finally:
        # 无论成功、失败还是被取消，都要写下终态：
        # 否则卡片会永远停在「运行中」
        try:
            _sched_finish(sched["id"], status)
        except Exception:  # noqa: BLE001
            try:
                db.set_schedule_runtime(sched["id"], last_status=status)
            except Exception:  # noqa: BLE001
                pass
        # 执行收尾（无论成功失败）后，这个任务才允许被下一轮 cron 再次触发
        _sched_end(sched["id"])


def _sched_finish(schedule_id: int, status: str) -> None:
    """一次执行结束后的收尾：写终态；次数用满了就自动停用。

    次数上限是「跑完之后」才生效的：执行期间任务仍是启用状态、状态是「运行中」，
    跑完了才停用并写成「暂停」，这样卡片上的状态和实际进程是对得上的。
    """
    cur = db.get_schedule(schedule_id)
    if cur:
        max_runs = cur.get("max_runs")
        run_count = cur.get("run_count") or 0
        if max_runs is not None and run_count >= max_runs:
            # 已达执行上限自动停用时，保留上限提示而不覆盖为 success/failed
            db.set_schedule_runtime(
                schedule_id, enabled=False,
                last_status=f"已达执行上限 {max_runs} 次，已自动停用（最后一次：{status}）")
            return
    db.set_schedule_runtime(schedule_id, last_status=status)


def _sched_resolve(sched: dict, rec: dict) -> tuple[dict, list[str], str]:
    """定时任务这一次执行要用的「参数 + 命令」。

    绑定了预设就跟随预设的最新值（参数与命令前后缀都算），
    没绑定预设则用任务自己保存的快照（用户手动改过的任务以手动值为准）。
    返回 (args, arg_list, cmd_text)；cmd_text 为空表示按标准方式执行（不套自定义前后缀）。
    """
    schema = json.loads(rec.get("args_schema") or "[]")
    preset = db.get_preset(sched["preset_id"]) if sched.get("preset_id") else None
    if preset:
        args = json.loads(preset.get("args") or "{}")
        cmd_prefix = preset.get("cmd_prefix") or sched.get("cmd_prefix") or ""
        cmd_suffix = preset.get("cmd_suffix") or sched.get("cmd_suffix") or ""
    else:
        args = json.loads(sched.get("args") or "{}")
        cmd_prefix = sched.get("cmd_prefix") or ""
        cmd_suffix = sched.get("cmd_suffix") or ""
    arg_list = build_arg_list(schema, args)
    cmd_text = ""
    if cmd_prefix or cmd_suffix:
        auto = _build_command_text(rec["path"], arg_list, rec.get("venv_path") or "")
        # 命令生成失败时 _build_command_text 返回的是一行「# 说明」，
        # 这种情况下不能把它当命令去跑，交给标准执行路径做环境检查
        if not auto.startswith("#"):
            cmd_text = " ".join(x for x in (cmd_prefix.strip(), auto, cmd_suffix.strip()) if x and x.strip())
    return args, arg_list, cmd_text


async def _fire_schedule(sched: dict, base: datetime) -> None:
    """到点触发一次定时任务：创建执行记录 + 后台执行 + 更新 next_run/last_run。"""
    now = datetime.now().astimezone()
    try:
        nr = _cron_next(sched["cron"], base)
    except Exception:  # noqa: BLE001
        nr = _cron_next("0 0 1 1 *", base)  # 表达式异常时退化为一年一次，避免空转
    rec = db.get_script(sched["script_id"])
    if not rec:
        db.set_schedule_runtime(sched["id"], next_run=_iso(nr), last_run=_iso(now), last_status="脚本不存在")
        return
    args, arg_list, cmd_text = _sched_resolve(sched, rec)
    exec_row = db.add_execution(rec["id"], args, sched.get("preset_id"), cmd_text)
    exec_id = exec_row["id"]
    _new_session(exec_id)

    # 下面几步都在任务真正开始执行之前同步做完，顺序很重要：
    # 1) 先加执行次数——收尾时（_sched_finish）要按最新的计数判断有没有到上限
    # 2) 再标记「正在执行」并写 running——卡片此时显示「运行中」
    # 这里只加计数、只记 running，不停用：
    # 停用和「已达执行上限」的终态由 _sched_run 在本次执行结束时写，
    # 否则脚本还在跑，卡片就显示成「暂停」了。
    new_count = (sched.get("run_count") or 0) + 1
    if sched.get("max_runs") is not None:
        db.set_schedule_runtime(sched["id"], run_count=new_count)
    # 标记「正在执行」：上一次没跑完时，调度器不再重复触发同一个任务
    _sched_begin(sched["id"])
    db.set_schedule_runtime(sched["id"], next_run=_iso(nr), last_run=_iso(now), last_status="running")
    asyncio.create_task(_sched_run(exec_id, sched, rec["path"], arg_list,
                                    rec.get("venv_path") or "", cmd_text))


async def _tick_schedules() -> None:
    now = datetime.now().astimezone()
    for sched in db.list_schedules(only_enabled=True):
        try:
            # 上一次还在跑：不重复触发（任务执行时间可能超过一个 cron 周期）
            if _sched_running_count(sched["id"]) > 0:
                continue
            # 次数已经用完：停用，不再触发。
            # 正常情况下执行结束时就停好了（_sched_finish），
            # 这里兜底「服务重启打断了执行」等异常情况——否则任务会一直启用着反复触发。
            max_runs = sched.get("max_runs")
            if max_runs is not None and (sched.get("run_count") or 0) >= max_runs:
                db.set_schedule_runtime(sched["id"], enabled=False)
                if (sched.get("last_status") or "") == "running":
                    # 上次执行被服务重启打断，从没跑到终态：按失败收尾，别一直显示「运行中」
                    db.set_schedule_runtime(sched["id"], last_status="failed")
                continue
            # 兜底：状态卡在「运行中」但进程已经不在了（执行被外部打断），
            # 收尾成失败，别让卡片永远停在「运行中」
            if (sched.get("last_status") or "") == "running":
                db.set_schedule_runtime(sched["id"], last_status="failed")
                continue
            next_run = _parse_iso(sched.get("next_run"))
            if next_run is None:
                # 首次启用 / 表达式变更：计算下次执行时间
                try:
                    nr = _cron_next(sched["cron"], now)
                    db.set_schedule_runtime(sched["id"], next_run=_iso(nr))
                except Exception as e:  # noqa: BLE001
                    db.set_schedule_runtime(sched["id"], last_status=f"cron 无效: {e}")
                continue
            if now >= next_run:
                await _fire_schedule(sched, next_run)
        except Exception as e:  # noqa: BLE001
            print(f"[schedule {sched['id']}] tick 失败: {e}", file=sys.stderr)


async def _schedule_loop() -> None:
    """调度主循环：每 10 秒检查一次 cron 到点。"""
    while True:
        try:
            await _tick_schedules()
        except Exception as e:  # noqa: BLE001
            print(f"[scheduler] 循环异常: {e}", file=sys.stderr)
        await asyncio.sleep(10)


# ---------------- 运行队列 ----------------
# 队列 = 一串定时任务按先进先出的顺序串行执行：
# 前一个跑完（成不成都算跑完）才轮到下一个，任务之间隔一个可配置的间隔。
_QUEUES_RUNNING: dict[int, int] = {}


def _queue_running_count(queue_id: int) -> int:
    return _QUEUES_RUNNING.get(queue_id, 0)


def _queue_begin(queue_id: int) -> None:
    _QUEUES_RUNNING[queue_id] = _queue_running_count(queue_id) + 1


def _queue_end(queue_id: int) -> None:
    n = _queue_running_count(queue_id) - 1
    if n > 0:
        _QUEUES_RUNNING[queue_id] = n
    else:
        _QUEUES_RUNNING.pop(queue_id, None)


async def _queue_run_item(queue: dict, item: dict) -> None:
    """执行队列里的一个任务：跑完写终态，再决定是继续下一个还是就此停下。"""
    queue_id = queue["id"]
    status = "failed"
    err = ""
    exec_id = None
    try:
        sched = db.get_schedule(item["schedule_id"])
        rec = db.get_script(sched["script_id"]) if sched else None
        if not sched or not rec:
            err = "定时任务或脚本已不存在"
        else:
            # 参数与命令前后缀沿用该定时任务自己的设置（绑了预设就跟预设走）
            args, arg_list, cmd_text = _sched_resolve(sched, rec)
            exec_row = db.add_execution(rec["id"], args, sched.get("preset_id"), cmd_text)
            exec_id = exec_row["id"]
            _new_session(exec_id)

            async def coro(emit: Callable) -> dict:
                if cmd_text:
                    return await _execute_command_task(exec_id, cmd_text, rec["path"], emit)
                return await _execute_task(exec_id, rec["path"], arg_list, emit,
                                           rec.get("venv_path") or "")
            result = await _run_in_session(exec_id, coro) or {}
            status = result.get("status") or "failed"
            if status != "success":
                err = (result.get("message") or "").strip() or f"执行未成功（{status}）"
    except asyncio.CancelledError:
        status = "terminated"
        err = "已终止"
        raise
    except Exception as e:  # noqa: BLE001
        status = "failed"
        err = str(e) or e.__class__.__name__
    finally:
        try:
            db.set_queue_item_status(item["id"], status, error=err or None, exec_id=exec_id,
                                     finished=True)
            failed = status not in ("success",)
            stop = failed and bool(queue.get("stop_on_error"))
            if stop:
                # 出错就停下：剩下的任务标成「已跳过」，队列收尾
                db.skip_pending_queue_items(queue_id)
                db.set_queue_status(queue_id, "stopped", finished=True)
            else:
                # 继续下一个：等够间隔再开跑
                gap = max(0, int(queue.get("interval_seconds") or 0))
                ready = datetime.now().astimezone() + timedelta(seconds=gap)
                db.set_queue_status(queue_id, "running", next_ready_at=_iso(ready))
        except Exception as e:  # noqa: BLE001
            print(f"[queue {queue_id}] 收尾失败: {e}", file=sys.stderr)
        _queue_end(queue_id)


async def _tick_queues() -> None:
    """推进所有队列：到点就开跑，跑完一个接一个。"""
    now = datetime.now().astimezone()
    for q in db.list_queues():
        try:
            if q["status"] == "pending":
                start_at = _parse_iso(q.get("start_at"))
                if start_at is None or start_at > now:
                    continue
                # 到点了：队列开跑
                db.set_queue_status(q["id"], "running", started=True)
                q = db.get_queue(q["id"]) or q
            if q["status"] != "running":
                continue
            if _queue_running_count(q["id"]) > 0:
                continue        # 正在跑一个，等它跑完
            ready_at = _parse_iso(q.get("next_ready_at"))
            if ready_at is not None and now < ready_at:
                continue        # 还没到间隔时间
            item = db.next_queue_item(q["id"])
            if item is None:
                db.set_queue_status(q["id"], "done", finished=True)
                continue
            db.set_queue_item_status(item["id"], "running", started=True)
            _queue_begin(q["id"])
            asyncio.create_task(_queue_run_item(q, item))
        except Exception as e:  # noqa: BLE001
            print(f"[queue {q.get('id')}] tick 失败: {e}", file=sys.stderr)


async def _queue_loop() -> None:
    """队列循环：每 2 秒看一次，让队列尽量贴着用户设的开始时间开跑。"""
    while True:
        try:
            await _tick_queues()
        except Exception as e:  # noqa: BLE001
            print(f"[queue] 循环异常: {e}", file=sys.stderr)
        await asyncio.sleep(2)


# ---------------- REST API ----------------

@app.get("/api/export")
async def export_all():
    """导出脚本/文件夹/预设（版本迁移用）。"""
    return db.export_all()


class ImportReq(BaseModel):
    data: dict


@app.post("/api/import")
async def import_all(req: ImportReq):
    result = db.import_all(req.data)
    return {"ok": True, **result}


@app.get("/api/health")
async def health():
    return {"ok": True, "name": "python-script-launcher"}


@app.get("/api/system/uv")
async def system_uv():
    ok, version = executor.uv_available()
    return {"ok": ok, "version": version, "install_hint": executor.uv_install_hint() if not ok else None}


@app.get("/api/meta")
async def get_meta():
    return db.meta_list()


@app.post("/api/meta")
async def set_meta(req: MetaReq):
    db.meta_set(req.key, req.value)
    return {"ok": True}


# ---------- 局域网访问开关 ----------

CURRENT_HOST = "127.0.0.1"
CURRENT_PORT = 8900


def _restart_for_lan(lan: bool) -> None:
    """写偏好后由延迟线程调用：以新 host 重启自身进程（保留原有参数，替换 --host）。"""
    host = "0.0.0.0" if lan else "127.0.0.1"
    args = [sys.executable, *sys.argv]
    if "--host" in args:
        i = args.index("--host")
        args = args[:i] + args[i + 2:]
    args += ["--host", host]
    subprocess.Popen(args, start_new_session=True, close_fds=True)
    os._exit(0)


@app.get("/api/host")
async def get_host():
    lan = db.meta_get("lan_access", "0") == "1"
    return {"ok": True, "lan": lan, "current_host": CURRENT_HOST, "port": CURRENT_PORT}


@app.post("/api/host")
async def set_host(req: HostReq):
    want = "1" if req.lan else "0"
    if db.meta_get("lan_access", "0") == want:
        return {"ok": True, "restarting": False, "lan": req.lan}
    db.meta_set("lan_access", want)
    # 延迟重启，让当前响应先送达前端
    asyncio.get_event_loop().call_later(0.6, lambda: _restart_for_lan(req.lan))
    return {"ok": True, "restarting": True, "lan": req.lan}


# ---------- schedules（定时任务） ----------

@app.get("/api/schedules")
async def list_schedules_api():
    return db.list_schedules()


@app.post("/api/schedules")
async def create_schedule(req: ScheduleReq):
    name = req.name.strip()
    cron = req.cron.strip()
    if not name or not cron:
        return JSONResponse({"ok": False, "error": "名称与 cron 表达式不能为空"}, status_code=400)
    err = _check_cron(cron)
    if err:
        return JSONResponse({"ok": False, "error": f"cron 表达式无效：{err}"}, status_code=400)
    s = db.add_schedule(req.script_id, name, cron, req.args, req.enabled, max_runs=req.max_runs,
                        preset_id=req.preset_id,
                        cmd_prefix=req.cmd_prefix or "", cmd_suffix=req.cmd_suffix or "")
    _refresh_schedule_plan(s["id"], cron, bool(req.enabled))
    s = db.get_schedule(s["id"])
    return {"ok": True, "schedule": s}


@app.put("/api/schedules/{schedule_id}")
async def update_schedule_api(schedule_id: int, req: ScheduleUpdateReq):
    if req.cron is not None:
        req.cron = req.cron.strip()
        err = _check_cron(req.cron)
        if err:
            return JSONResponse({"ok": False, "error": f"cron 表达式无效：{err}"}, status_code=400)
    if req.name is not None:
        req.name = req.name.strip()
    old = db.get_schedule(schedule_id)
    was_enabled = bool(old and old.get("enabled"))
    s = db.update_schedule(
        schedule_id,
        name=req.name,
        cron=req.cron,
        args=req.args,
        enabled=req.enabled,
        max_runs=req.max_runs if "max_runs" in req.model_fields_set else db._UNSET,
        preset_id=req.preset_id if "preset_id" in req.model_fields_set else db._UNSET,
        cmd_prefix=req.cmd_prefix if "cmd_prefix" in req.model_fields_set else db._UNSET,
        cmd_suffix=req.cmd_suffix if "cmd_suffix" in req.model_fields_set else db._UNSET,
    )
    # 表达式或启停变化后：清空旧计划并立即重算 next_run，前端保存后即刻看到新时间
    if req.cron is not None or req.enabled is not None or req.max_runs is not None:
        cur_cron = req.cron if req.cron is not None else s.get("cron")
        new_enabled = bool(s.get("enabled", 0))
        # 重新启用时重置已执行次数（重新开始计数）
        if req.enabled is not None and req.enabled and not was_enabled:
            db.set_schedule_runtime(schedule_id, run_count=0)
        _refresh_schedule_plan(schedule_id, cur_cron, new_enabled)
        s = db.get_schedule(schedule_id)
    return {"ok": True, "schedule": s}


@app.post("/api/schedules/{schedule_id}/run")
async def run_schedule_now(schedule_id: int):
    """手动立即触发一次定时任务（不改变 cron 计划）。"""
    sched = db.get_schedule(schedule_id)
    if not sched:
        return JSONResponse({"ok": False, "error": "定时任务不存在"}, status_code=404)
    base = datetime.now().astimezone()
    await _fire_schedule(sched, base)
    return {"ok": True}


@app.delete("/api/schedules/{schedule_id}")
async def delete_schedule_api(schedule_id: int):
    db.delete_schedule(schedule_id)
    return {"ok": True}


# ---------------- 运行队列 API ----------------

@app.get("/api/queues")
async def list_queues_api():
    """所有队列（含任务清单）。"""
    out = []
    for q in db.list_queues():
        q["items"] = db.list_queue_items(q["id"])
        out.append(q)
    return out


@app.get("/api/queues/{queue_id}")
async def get_queue_api(queue_id: int):
    q = db.get_queue(queue_id)
    if not q:
        return JSONResponse({"ok": False, "error": "队列不存在"}, status_code=404)
    q["items"] = db.list_queue_items(queue_id)
    return q


@app.post("/api/queues")
async def create_queue(req: QueueReq):
    name = req.name.strip()
    if not name:
        return JSONResponse({"ok": False, "error": "队列名称不能为空"}, status_code=400)
    if not req.start_at:
        return JSONResponse({"ok": False, "error": "请设置队列的开始执行时间"}, status_code=400)
    q = db.add_queue(name, req.start_at, req.interval_seconds, req.stop_on_error)
    for sid in req.schedule_ids or []:
        if db.get_schedule(sid):
            db.add_queue_item(q["id"], sid)
    return {"ok": True, "queue": _queue_detail(q["id"])}


@app.put("/api/queues/{queue_id}")
async def update_queue_api(queue_id: int, req: QueueUpdateReq):
    q = db.get_queue(queue_id)
    if not q:
        return JSONResponse({"ok": False, "error": "队列不存在"}, status_code=404)
    db.update_queue(
        queue_id,
        name=req.name.strip() if req.name is not None else None,
        start_at=req.start_at if req.start_at is not None else None,
        interval_seconds=req.interval_seconds,
        stop_on_error=req.stop_on_error,
    )
    return {"ok": True, "queue": _queue_detail(queue_id)}


@app.delete("/api/queues/{queue_id}")
async def delete_queue_api(queue_id: int):
    db.delete_queue(queue_id)
    return {"ok": True}


@app.post("/api/queues/{queue_id}/items")
async def add_queue_item_api(queue_id: int, req: QueueItemReq):
    """把一个定时任务加入队尾。"""
    if not db.get_queue(queue_id):
        return JSONResponse({"ok": False, "error": "队列不存在"}, status_code=404)
    if not db.get_schedule(req.schedule_id):
        return JSONResponse({"ok": False, "error": "定时任务不存在"}, status_code=404)
    db.add_queue_item(queue_id, req.schedule_id)
    return {"ok": True, "queue": _queue_detail(queue_id)}


@app.post("/api/queues/{queue_id}/items/reorder")
async def reorder_queue_items_api(queue_id: int, req: QueueReorderReq):
    """按给定的定时任务顺序重建队列清单（前端拖动/上下移动后一次性提交）。"""
    if not db.get_queue(queue_id):
        return JSONResponse({"ok": False, "error": "队列不存在"}, status_code=404)
    ids = [s for s in (req.schedule_ids or []) if db.get_schedule(s)]
    db.set_queue_items(queue_id, ids)
    return {"ok": True, "queue": _queue_detail(queue_id)}


@app.delete("/api/queues/{queue_id}/items/{item_id}")
async def remove_queue_item_api(queue_id: int, item_id: int):
    item = db.get_queue_item(item_id)
    if item and item["queue_id"] == queue_id:
        db.remove_queue_item(item_id)
    return {"ok": True, "queue": _queue_detail(queue_id)}


@app.post("/api/queues/{queue_id}/items/{item_id}/move")
async def move_queue_item_api(queue_id: int, item_id: int, req: QueueMoveReq):
    """队列内调整顺序（up 往前 / down 往后）。"""
    item = db.get_queue_item(item_id)
    if item and item["queue_id"] == queue_id:
        db.move_queue_item(item_id, req.direction)
    return {"ok": True, "queue": _queue_detail(queue_id)}


@app.post("/api/queues/{queue_id}/clear")
async def clear_queue_api(queue_id: int):
    """清空队列里的任务（队列本身保留，可以继续加任务）。"""
    if not db.get_queue(queue_id):
        return JSONResponse({"ok": False, "error": "队列不存在"}, status_code=404)
    db.clear_queue_items(queue_id)
    return {"ok": True, "queue": _queue_detail(queue_id)}


@app.post("/api/queues/{queue_id}/restart")
async def restart_queue_api(queue_id: int, req: QueueRestartReq):
    """重新启动：所有任务回到待执行，队列回到等待开始。"""
    if not db.get_queue(queue_id):
        return JSONResponse({"ok": False, "error": "队列不存在"}, status_code=404)
    if req.start_at:
        db.update_queue(queue_id, start_at=req.start_at)
    db.restart_queue(queue_id)
    return {"ok": True, "queue": _queue_detail(queue_id)}


def _queue_detail(queue_id: int) -> dict:
    q = db.get_queue(queue_id) or {}
    q["items"] = db.list_queue_items(queue_id)
    return q


@app.post("/api/schedules/preview")
async def preview_cron(req: CronPreviewReq):
    """根据 cron 表达式计算下次执行时间（前端实时预览用）。"""
    expr = req.cron.strip()
    err = _check_cron(expr)
    if err:
        return JSONResponse({"ok": False, "error": f"cron 表达式无效：{err}"}, status_code=400)
    try:
        nr = _cron_next(expr, datetime.now().astimezone())
        return {"ok": True, "next": _iso(nr)}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"cron 表达式无效：{e}"}, status_code=400)


# ---------- scripts ----------

@app.post("/api/scripts/scan")
async def scan_scripts(req: ScanReq):
    """扫描目录，自动解析并注册符合约定的脚本。"""
    files = scanner.scan_python_files(req.directory, req.recursive)
    imported, skipped = [], []
    for f in files:
        info = scanner.analyze_script(f)
        if info["ok"]:
            rec = db.add_script(
                info["name"], info["path"], info["schema"]["args"],
                description=info["schema"].get("description") or "",
                has_inline_meta=executor.pep723_metadata(info["path"]) is not None,
            )
            imported.append(rec)
        else:
            skipped.append({"path": info["path"], "error": info["error"]})
    if req.directory:
        db.meta_set("last_scan_dir", req.directory)
    return {"imported": imported, "skipped": skipped, "total": len(files)}


@app.post("/api/scripts/import")
async def import_script(req: ScriptImportReq):
    p = Path(req.path).expanduser().resolve()
    if not p.exists() or not p.is_file():
        return JSONResponse({"ok": False, "error": "文件不存在"}, status_code=400)
    if p.suffix != ".py":
        return JSONResponse({"ok": False, "error": "仅支持 .py 脚本"}, status_code=400)
    info = scanner.analyze_script(str(p))
    if not info["ok"]:
        return JSONResponse({"ok": False, "error": info["error"]}, status_code=400)
    name = (req.name or "").strip() or info["name"]
    desc = req.description if req.description is not None else (info["schema"].get("description") or "")
    rec = db.add_script(
        name, info["path"], info["schema"]["args"], description=desc or "",
        has_inline_meta=executor.pep723_metadata(info["path"]) is not None,
    )
    return {"ok": True, "script": rec, "schema": info["schema"]}


@app.post("/api/scripts/upload")
async def upload_script(file: UploadFile = File(...), name: Optional[str] = Form(None)):
    """通过文件选择器上传 .py 脚本，保存到启动器管理目录并注册。"""
    filename = os.path.basename(file.filename or "")
    if not filename.endswith(".py"):
        return JSONResponse({"ok": False, "error": "仅支持 .py 脚本"}, status_code=400)
    imported_dir = APP_DIR / "imported"
    imported_dir.mkdir(parents=True, exist_ok=True)
    # 重名时追加序号，避免覆盖
    target = imported_dir / filename
    base = imported_dir / filename
    i = 1
    while target.exists():
        target = imported_dir / f"{base.stem}_{i}{base.suffix}"
        i += 1
    content = await file.read()
    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        return JSONResponse({"ok": False, "error": "文件不是有效的 UTF-8 编码"}, status_code=400)
    target.write_bytes(content)
    info = scanner.analyze_script(str(target))
    if not info["ok"]:
        target.unlink(missing_ok=True)
        return JSONResponse({"ok": False, "error": info["error"]}, status_code=400)
    script_name = (name or "").strip() or info["name"]
    rec = db.add_script(
        script_name, str(target), info["schema"]["args"],
        description=info["schema"].get("description") or "",
        has_inline_meta=executor.pep723_metadata(str(target)) is not None,
    )
    return {"ok": True, "script": rec, "schema": info["schema"]}


@app.put("/api/scripts/{script_id}")
async def update_script(script_id: int, req: UpdateScriptReq):
    rec = db.update_script(script_id, req.name, req.description, req.deps_path, req.venv_path, req.tags)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    return {"ok": True, "script": rec}


@app.post("/api/scripts/{script_id}/reload")
async def reload_script(script_id: int):
    """重新解析脚本文件，刷新参数 schema 与描述（脚本更新后使用）。"""
    rec = db.get_script(script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    info = scanner.analyze_script(rec["path"])
    if not info["ok"]:
        return JSONResponse({"ok": False, "error": info["error"]}, status_code=400)
    updated = db.update_script_schema(
        script_id, info["schema"]["args"], info["schema"].get("description") or "",
        has_inline_meta=executor.pep723_metadata(rec["path"]) is not None,
    )
    return {"ok": True, "script": updated, "schema": info["schema"]}


@app.get("/api/scripts")
async def list_scripts():
    return db.list_scripts()


@app.get("/api/scripts/{script_id}")
async def script_detail(script_id: int):
    rec = db.get_script(script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    rec["args_schema"] = json.loads(rec.get("args_schema") or "[]")
    rec["auto_saved_args"] = json.loads(rec.get("auto_saved_args") or "{}")
    presets = db.list_presets(script_id)
    for p in presets:
        p["args"] = json.loads(p.get("args") or "{}")
    rec["presets"] = presets
    rec["env"] = executor.inspect_env(rec["path"], rec.get("deps_path") or "", rec.get("venv_path") or "")
    return rec


@app.delete("/api/scripts/{script_id}")
async def delete_script(script_id: int):
    db.delete_script(script_id)
    return {"ok": True}


# ---------- 环境管理：检测管理器 / 扫描已有虚拟环境 ----------

@app.get("/api/env/managers")
async def env_managers():
    """检测本机环境管理工具（uv / conda / mamba / python）。"""
    return executor.list_env_managers()


@app.get("/api/env/venvs")
async def env_venvs():
    """扫描已有虚拟环境（conda env list + 常见 venv 约定目录），不做全盘扫描。"""
    return {"venvs": executor.scan_venvs()}


# ---------- folders ----------

@app.get("/api/folders")
async def get_folders():
    return db.list_folders()


@app.post("/api/folders")
async def create_folder(req: FolderReq):
    if not req.name.strip():
        return JSONResponse({"ok": False, "error": "文件夹名称不能为空"}, status_code=400)
    f = db.create_folder(req.name)
    return {"ok": True, "folder": f}


@app.delete("/api/folders/{folder_id}")
async def delete_folder(folder_id: int):
    db.delete_folder(folder_id)
    return {"ok": True}


@app.put("/api/scripts/{script_id}/move")
async def move_script(script_id: int, req: MoveReq):
    db.move_script(script_id, req.folder_id)
    return {"ok": True}


@app.put("/api/scripts/{script_id}/args")
async def save_auto_args(script_id: int, req: SaveArgsReq):
    db.save_auto_args(script_id, req.args)
    return {"ok": True}


@app.post("/api/scripts/{script_id}/presets")
async def create_preset(script_id: int, req: PresetReq):
    name = req.name.strip()
    if not name:
        return JSONResponse({"ok": False, "error": "预设名称不能为空"}, status_code=400)
    existing = db.find_preset_by_name(script_id, name)
    if existing:
        # 同名预设：覆盖其参数与命令补充段
        p = db.update_preset(existing["id"], req.args,
                             cmd_prefix=req.cmd_prefix, cmd_suffix=req.cmd_suffix)
        return {"ok": True, "preset": p, "overwritten": True}
    p = db.add_preset(script_id, name, req.args,
                      cmd_prefix=req.cmd_prefix or "", cmd_suffix=req.cmd_suffix or "")
    return {"ok": True, "preset": p, "overwritten": False}


@app.delete("/api/presets/{preset_id}")
async def delete_preset(preset_id: int):
    db.delete_preset(preset_id)
    return {"ok": True}


@app.patch("/api/presets/{preset_id}")
async def patch_preset(preset_id: int, req: PresetPatchReq):
    """预设管理：固定/取消固定、手动排序、标记最近使用。"""
    try:
        if req.order:
            db.move_preset(preset_id, req.order)
        if req.touch:
            db.touch_preset_used(preset_id)
        if req.pinned is not None:
            p = db.set_preset_pinned(preset_id, req.pinned)
            return {"ok": True, "preset": p}
        return {"ok": True}
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=404)


@app.get("/api/scripts/{script_id}/env")
async def script_env(script_id: int):
    rec = db.get_script(script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    return executor.inspect_env(rec["path"], venv_path=rec.get("venv_path") or "")


class EnvInitReq(BaseModel):
    deps_path: Optional[str] = None


@app.post("/api/scripts/{script_id}/env/init")
async def init_script_env(script_id: int, req: EnvInitReq = None):
    """创建环境初始化会话，返回 session_id（用于 /ws/env/{id}）。"""
    rec = db.get_script(script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    session_id = script_id + 10_000_000
    deps_path = (req.deps_path if req and req.deps_path else "") or (rec.get("deps_path") or "")
    _new_session(session_id)
    asyncio.create_task(_run_in_session(
        session_id,
        lambda emit: executor.init_env(rec["path"], emit, deps_path, rec.get("venv_path") or ""),
    ))
    return {"ok": True, "session_id": session_id}


# ---------- executions ----------

@app.post("/api/execute")
async def execute(req: ExecuteReq):
    rec = db.get_script(req.script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    schema = json.loads(rec.get("args_schema") or "[]")
    arg_list = build_arg_list(schema, req.args)
    command = _build_command_text(rec["path"], arg_list, rec.get("venv_path") or "")
    custom = (req.command or "").strip()
    exec_row = db.add_execution(req.script_id, req.args, req.preset_id, command=custom or command)
    if req.preset_id:
        db.touch_preset_used(req.preset_id)
    exec_id = exec_row["id"]
    _new_session(exec_id)
    if custom:
        asyncio.create_task(
            _run_in_session(exec_id, lambda emit: _execute_command_task(exec_id, custom, rec["path"], emit))
        )
    else:
        asyncio.create_task(
            _run_in_session(exec_id, lambda emit: _execute_task(exec_id, rec["path"], arg_list, emit, rec.get("venv_path") or ""))
        )
    return {"ok": True, "execution_id": exec_id, "command": custom or command}


@app.post("/api/scripts/command")
async def script_command(req: CommandReq):
    """按当前环境生成实际可执行的命令文本（uv run 或 .venv python），无法执行时返回 error。"""
    rec = db.get_script(req.script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    schema = json.loads(rec.get("args_schema") or "[]")
    arg_list = build_arg_list(schema, req.args)
    cmd, err = executor.build_command_ex(rec["path"], arg_list, venv_path=rec.get("venv_path") or "")
    command = "" if err else " ".join(_shq(c) for c in cmd)
    return {"ok": True, "command": command, "error": err}


def merge_command(script_path: str, schema_args: list[dict], values: dict, user_command: str) -> Optional[str]:
    """保留用户手动修改的命令前缀（如 -m pytest、PYTHONPATH=...、改脚本路径），
    只把参数段刷新为当前表单值。无法安全定位参数段时返回 None（保持整条命令）。"""
    if not user_command or not user_command.strip():
        return None
    try:
        tokens = shlex.split(user_command)
    except ValueError:
        return None
    if not tokens:
        return None
    opt_map: dict[str, dict] = {}
    for a in schema_args:
        for o in (a.get("option_strings") or []):
            if o.startswith("-"):
                opt_map[o] = a
                if "--" in o and "_" in o:
                    opt_map[o.replace("_", "-")] = a
    # 定位第一个被识别的参数 token（--key / -k / --key=value）；未知选项（-m、-X）视为前缀
    first = None
    for i, tok in enumerate(tokens):
        if tok.startswith("-") and tok != "-":
            base = tok.split("=", 1)[0]
            if base in opt_map:
                first = i
                break
            continue
    if first is None:
        return None
    # 参数段的起点：脚本路径之后。
    # 只认「第一个已知选项」会把位置参数误留在前缀里，导致旧的位置参数值被保留、
    # 新值再追加一次（"old subject CHANGED-SUBJECT"）。这里先定位脚本路径 token，
    # 它之后的全部内容都属于参数段；找不到脚本路径时退回按已知选项定位。
    start = None
    base_name = os.path.basename(script_path)
    for i, tok in enumerate(tokens):
        bare = tok.strip("'\"")
        if bare == script_path or bare.endswith("/" + base_name) or bare == base_name:
            start = i + 1
            break
    if start is None:
        start = first
    prefix = " ".join(tokens[:start])
    arg_list = build_arg_list(schema_args, values)
    args_text = " ".join(_shq(a) for a in arg_list)
    merged = (prefix + " " + args_text).strip() if args_text else prefix
    return merged


class MergeCommandReq(BaseModel):
    args: dict = {}
    command: str = ""


class RunEnvReq(BaseModel):
    text: str = ""


@app.get("/api/settings/env")
async def get_settings_env():
    """设置页「环境变量」：读回当前配置。"""
    env = db.get_run_env()
    return {"ok": True, "text": db.format_env_text(env), "count": len(env)}


@app.put("/api/settings/env")
async def put_settings_env(req: RunEnvReq):
    """保存环境变量并立即对后续运行生效（不需要重启服务）。"""
    env = db.set_run_env(req.text)
    executor.set_extra_env(env)
    return {"ok": True, "text": db.format_env_text(env), "count": len(env)}


@app.post("/api/scripts/{script_id}/merge-command")
async def merge_script_command(script_id: int, req: MergeCommandReq):
    """按当前表单值刷新用户自定义命令的参数段，保留手动修改的前缀。merged 为空表示无法合并、保持整条。"""
    rec = db.get_script(script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    schema = json.loads(rec.get("args_schema") or "[]")
    merged = merge_command(rec["path"], schema, req.args, req.command)
    return {"ok": True, "merged": merged or ""}


@app.post("/api/scripts/{script_id}/parse-command")
async def parse_script_command(script_id: int, req: ParseCommandReq):
    """把粘贴的命令行解析为参数值并回填表单。"""
    rec = db.get_script(script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    schema = json.loads(rec.get("args_schema") or "[]")
    if not schema:
        return {"ok": False, "error": "该脚本没有可解析的命令行参数"}
    return parse_command_args(schema, req.command, rec["path"])


@app.get("/api/executions")
async def list_executions(script_id: Optional[int] = None, tag: Optional[str] = None,
                          status: Optional[str] = None, limit: int = 200):
    return db.list_executions(script_id, tag, status, limit)


@app.get("/api/executions/running")
async def running_executions():
    """所有正在运行的执行（脚本卡片徽章 / 任务列表）。必须在 {exec_id} 路由之前。

    对 DB 中 running 的记录做进程存活校验：进程已不存在（外部中断/异常退出）的
    立即落库为 failed 并过滤，避免前端轮询永远显示"运行中"。
    """
    rows = db.list_running_executions()
    alive = []
    for r in rows:
        info = executor._RUNNING.get(r["id"])
        proc = info.get("proc") if info else None
        if info and proc is not None and proc.returncode is None:
            alive.append(r)
            continue
        # 进程已死：写入 failed（若执行协程随后正常收尾，finish_execution 会覆盖为真实状态）
        try:
            db.finish_execution(r["id"], "failed", -1, [])
        except Exception:  # noqa: BLE001
            pass
    return {"running": alive}


@app.get("/api/executions/{exec_id}")
async def execution_detail(exec_id: int):
    rec = db.get_execution(exec_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "记录不存在"}, status_code=404)
    rec["args"] = json.loads(rec.get("args") or "{}")
    rec["tags"] = json.loads(rec.get("tags") or "[]")
    # 附加脚本名与对应命令行，便于详情页展示/复制
    if rec.get("script_id"):
        s = db.get_script(rec["script_id"])
        if s:
            rec["script_name"] = s["name"]
            try:
                arg_list = build_arg_list(json.loads(s.get("args_schema") or "[]"), rec["args"])
                rec["command"] = _build_command_text(s["path"], arg_list)
            except Exception:  # noqa: BLE001
                rec["command"] = ""
    return rec


@app.put("/api/executions/{exec_id}/tags")
async def update_tags(exec_id: int, req: TagsReq):
    db.set_execution_tags(exec_id, req.tags)
    return {"ok": True}


@app.delete("/api/executions/{exec_id}")
async def delete_execution(exec_id: int):
    db.delete_execution(exec_id)
    return {"ok": True}


@app.get("/api/console/tabs")
async def get_console_tabs():
    """当前打开的控制台标签页（按执行 id）。存服务端，刷新/换浏览器都一致。"""
    try:
        ids = json.loads(db.meta_get(CONSOLE_TABS_KEY, "[]")) or []
    except (ValueError, TypeError):
        ids = []
    return {"ok": True, "ids": [int(i) for i in ids if str(i).lstrip("-").isdigit()]}


@app.put("/api/console/tabs")
async def put_console_tabs(req: ConsoleTabsReq):
    ids = [int(i) for i in (req.ids or []) if str(i).lstrip("-").isdigit()][:50]
    db.meta_set(CONSOLE_TABS_KEY, json.dumps(ids))
    return {"ok": True, "ids": ids}


@app.put("/api/executions/{exec_id}/tab-name")
async def rename_execution_tab(exec_id: int, req: TabNameReq):
    """重命名控制台标签页。存在执行记录里，所以刷新页面、换浏览器打开都一致。"""
    rec = db.set_execution_tab_name(exec_id, req.name)
    if not rec:
        return JSONResponse({"ok": False, "error": "执行记录不存在"}, status_code=404)
    return {"ok": True, "tab_name": rec.get("tab_name", "")}


@app.post("/api/executions/clear")
async def clear_executions(req: ClearReq):
    n = db.clear_executions(req.script_id)
    return {"ok": True, "deleted": n}


class DeleteExecsReq(BaseModel):
    ids: list[int]


@app.post("/api/executions/delete")
async def delete_executions(req: DeleteExecsReq):
    """批量删除执行记录；运行中的记录自动跳过。"""
    deleted, skipped_running = db.delete_executions(req.ids)
    return {"ok": True, "deleted": deleted, "skipped_running": skipped_running}


@app.post("/api/executions/{exec_id}/terminate")
async def terminate_execution(exec_id: int):
    ok = executor.terminate_execution(exec_id)
    return {"ok": ok}


# ---------- 系统工具 ----------

@app.post("/api/utils/open-dir")
async def open_dir(req: OpenDirReq):
    p = Path(req.path).expanduser()
    if not p.exists():
        return JSONResponse({"ok": False, "error": "路径不存在"}, status_code=400)
    # 传入的是文件则打开其所在目录，传入目录则直接打开
    target = p.parent if p.is_file() else p
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        elif os.name == "nt":
            subprocess.Popen(["explorer", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ---------------- WebSocket ----------------

@app.websocket("/ws/run/{exec_id}")
async def ws_run(ws: WebSocket, exec_id: int):
    try:
        await _ws_pump(ws, exec_id)
    except WebSocketDisconnect:
        pass


@app.websocket("/ws/env/{session_id}")
async def ws_env(ws: WebSocket, session_id: int):
    try:
        await _ws_pump(ws, session_id)
    except WebSocketDisconnect:
        pass


# ---------------- 静态文件 ----------------

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
async def index():
    """返回前端页面；禁用缓存以确保更新即时生效。"""
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


# ---------------- 启动 ----------------

def _port_listening(host: str, port: int, timeout: float = 0.5) -> bool:
    """端口是否已经在监听。"""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def _when_ready(host: str, port: int, on_ready, timeout: float = 30.0) -> None:
    """等端口真正监听起来之后回调（守护线程，不阻塞进程退出）。"""

    def _worker() -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if _port_listening(host, port):
                try:
                    on_ready()
                except Exception:  # noqa: BLE001
                    pass
                return
            time.sleep(0.4)

    threading.Thread(target=_worker, daemon=True).start()


def main() -> None:
    import uvicorn

    global CURRENT_HOST, CURRENT_PORT

    port = int(os.environ.get("LAUNCHER_PORT", "8900"))
    db.init_db()
    # 默认仅本机；meta 偏好 lan_access=1 时监听所有网卡；--host 命令行参数最高优先
    host = os.environ.get("LAUNCHER_HOST", "")
    if db.meta_get("lan_access", "0") == "1":
        host = "0.0.0.0"
    if not host:
        host = "127.0.0.1"
    if "--host" in sys.argv:
        i = sys.argv.index("--host")
        if i + 1 < len(sys.argv):
            host = sys.argv[i + 1]
    no_browser = "--no-browser" in sys.argv

    # 端口已被占用：说明服务早就跑着了，直接提示后退出，
    # 免得再起一个进程、再开一个浏览器标签页
    if _port_listening("127.0.0.1", port):
        print(f"· 端口 {port} 已被占用，服务应该已经在运行了。")
        print(f"· 直接访问： http://127.0.0.1:{port}/")
        return

    CURRENT_HOST = host
    CURRENT_PORT = port
    if host == "0.0.0.0":
        url = f"http://127.0.0.1:{port}/?t={int(time.time())}"
        print(f"· Python 脚本启动器已启动: {url}")
        print(f"· 已监听所有网卡，局域网访问: http://<你的IP>:{port}/?t={int(time.time())}")
    else:
        url = f"http://{host}:{port}/?t={int(time.time())}"
        print(f"· Python 脚本启动器已启动: {url}")

    # 记录本次启动时刻：启动脚本据此判断"服务是不是刚起来的"，
    # 重复双击时就不再重复开浏览器标签页
    started_mark = Path.home() / f".tool-launcher.started.{port}"

    def _on_ready() -> None:
        try:
            started_mark.write_text(str(int(time.time())), encoding="utf-8")
        except OSError:
            pass
        if not no_browser:
            # 等服务端口真正起来再打开浏览器：启动失败时不会多开一个打不开的标签页
            webbrowser.open(url)

    _when_ready("127.0.0.1", port, _on_ready)

    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
