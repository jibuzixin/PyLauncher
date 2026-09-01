"""uv 集成：检测 / venv 管理 / 进程执行 / 流式输出。

约定：脚本所在目录 = 项目根目录，使用 uv 创建该目录下的 .venv。
"""
from __future__ import annotations

import asyncio
import os
import platform
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

# 运行中的进程句柄：execution_id -> 进程控制对象
_RUNNING: dict[int, dict[str, Any]] = {}

# 伪终端模式：macOS / Linux 使用 pty 获得完整终端体验（\r 进度条、ANSI 颜色），Windows 自动退回管道
USE_PTY = os.name != "nt"

UV_INSTALL_HINTS = {
    "mac": "brew install uv",
    "win": 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
    "linux": "curl -LsSf https://astral.sh/uv/install.sh | sh",
}


def _venv_python(project_dir: Path) -> Path:
    if os.name == "nt":
        return project_dir / ".venv" / "Scripts" / "python.exe"
    return project_dir / ".venv" / "bin" / "python"


def uv_available() -> tuple[bool, str]:
    """检测 uv 是否可用，返回 (可用, 版本或错误)。"""
    path = shutil.which("uv")
    if not path:
        return False, "未检测到 uv"
    try:
        import subprocess
        out = subprocess.run(["uv", "--version"], capture_output=True, text=True, timeout=10)
        return True, (out.stdout or out.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def uv_install_hint() -> dict:
    return {
        "mac": UV_INSTALL_HINTS["mac"],
        "win": UV_INSTALL_HINTS["win"],
        "linux": UV_INSTALL_HINTS["linux"],
        "platform": platform.system().lower(),
    }


def _resolve_deps(deps_path: str, project_dir: Path) -> tuple[Optional[str], Optional[Path]]:
    """解析依赖文件：显式 deps_path 优先，其次 requirements.txt，最后 pyproject.toml。

    返回 (kind, path)，kind ∈ {"requirements", "pyproject"}。
    """
    if deps_path:
        p = Path(deps_path).expanduser()
        if p.exists():
            kind = "pyproject" if p.name == "pyproject.toml" else "requirements"
            return kind, p
        return None, None
    req = project_dir / "requirements.txt"
    if req.exists():
        return "requirements", req
    py = project_dir / "pyproject.toml"
    if py.exists():
        return "pyproject", py
    return None, None


def pep723_metadata(script_path: str) -> Optional[dict]:
    """读取脚本开头的 PEP 723 内联元数据（# /// script ... # ///），返回 [script] 段 dict。

    解析失败或不存在时返回 None。只读取文件开头一小段，避免大文件开销。
    """
    try:
        with open(script_path, "r", encoding="utf-8") as f:
            head = f.read(8192)
    except Exception:  # noqa: BLE001
        return None
    lines = head.splitlines()
    start = end = -1
    for i, line in enumerate(lines):
        s = line.lstrip()
        if start == -1 and s.startswith("# /// script"):
            start = i
        elif start != -1 and s.startswith("# ///"):
            end = i
            break
    if start == -1 or end == -1:
        return None
    toml_lines = []
    for i in range(start + 1, end):
        s = lines[i].lstrip()
        if s.startswith("#"):
            s = s[1:].lstrip()
        toml_lines.append(s)
    try:
        import tomllib
        data = tomllib.loads("\n".join(toml_lines))
        # PEP 723 的内联元数据即 [script] 段本身（无表头），直接作为 script 表返回
        return data or None
    except Exception:  # noqa: BLE001
        return None


def inspect_env(script_path: str, deps_path: str = "") -> dict[str, Any]:
    """检查脚本所在目录的环境状态。deps_path 为可选的自定义依赖文件。"""
    script = Path(script_path)
    project_dir = script.parent
    venv_py = _venv_python(project_dir)
    has_venv = venv_py.exists()
    kind, dep_file = _resolve_deps(deps_path, project_dir)
    meta = pep723_metadata(script_path)
    deps = meta.get("dependencies") or [] if meta else []
    return {
        "project_dir": str(project_dir),
        "has_venv": has_venv,
        "venv_python": str(venv_py) if has_venv else None,
        "deps_path": deps_path,
        "has_deps": dep_file is not None,
        "deps_kind": kind,
        "deps_name": dep_file.name if dep_file else None,
        "requirements_path": str(dep_file) if dep_file else None,
        "has_requirements": dep_file is not None and kind == "requirements",  # 兼容旧字段
        "has_inline_meta": meta is not None,
        "inline_deps": deps,
        "inline_requires_python": (meta.get("requires-python") if meta else None),
        "uv_ok": uv_available()[0],
        "uv_version": uv_available()[1] if uv_available()[0] else None,
    }


async def _stream_proc(
    cmd: list[str],
    cwd: str,
    on_line: Callable[[str, str], Awaitable[None]],
    env_extra: Optional[dict] = None,
    new_group: bool = True,
    proc_holder: Optional[dict] = None,
) -> tuple[int, asyncio.subprocess.Process]:
    """运行命令并流式回调 on_line(stream, text)。

    macOS/Linux 使用伪终端（pty）运行：子进程 isatty()=True，完整支持 \r 单行进度条与 ANSI 颜色；
    Windows 退回管道模式。回调收到的是原始字节块（可能含 \r\n、ANSI 转义、跨行）。
    """
    if USE_PTY:
        return await _stream_proc_pty(cmd, cwd, on_line, env_extra, proc_holder)

    # ---- Windows / 管道模式：按行读取 ----
    kwargs: dict[str, Any] = {"cwd": cwd, "stdout": asyncio.subprocess.PIPE, "stderr": asyncio.subprocess.PIPE}
    env = dict(os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if env_extra:
        env.update(env_extra)
    kwargs["env"] = env

    if os.name == "nt":
        kwargs["creationflags"] = getattr(__import__("subprocess"), "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        if new_group:
            kwargs["preexec_fn"] = os.setsid

    proc = await asyncio.create_subprocess_exec(*cmd, **kwargs)
    if proc_holder is not None:
        proc_holder["proc"] = proc

    async def pump(stream: asyncio.StreamReader, name: str) -> None:
        while True:
            raw = await stream.readline()
            if not raw:
                break
            try:
                line = raw.decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001
                line = raw.decode("latin-1", errors="replace")
            # 保留结尾 \n，与 pty 模式统一为"原始块"语义，供前端流式解析与历史合并
            await on_line(name, line)

    await asyncio.gather(pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr"))
    code = await proc.wait()
    return code, proc


async def _stream_proc_pty(
    cmd: list[str],
    cwd: str,
    on_line: Callable[[str, str], Awaitable[None]],
    env_extra: Optional[dict] = None,
    proc_holder: Optional[dict] = None,
) -> tuple[int, asyncio.subprocess.Process]:
    """伪终端模式：stdout/stderr 合并到同一个 pty，按原始字节块流式回调。"""
    import fcntl
    import pty
    import struct
    import termios
    import threading

    master, slave = pty.openpty()
    # 设置终端尺寸（宽 120 列，进度条有足够空间）
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
    except Exception:  # noqa: BLE001
        pass

    env = dict(os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if env_extra:
        env.update(env_extra)

    proc = subprocess.Popen(
        cmd, cwd=cwd, stdin=slave, stdout=slave, stderr=slave,
        env=env, close_fds=True, preexec_fn=os.setsid,
    )
    os.close(slave)
    if proc_holder is not None:
        proc_holder["proc"] = proc

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _reader() -> None:
        try:
            while True:
                try:
                    data = os.read(master, 8192)
                except OSError:
                    break
                if not data:
                    break
                try:
                    text = data.decode("utf-8", errors="replace")
                except Exception:  # noqa: BLE001
                    text = data.decode("latin-1", errors="replace")
                loop.call_soon_threadsafe(queue.put_nowait, text)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    t = threading.Thread(target=_reader, daemon=True)
    t.start()

    while True:
        text = await queue.get()
        if text is None:
            break
        await on_line("stdout", text)

    code = await asyncio.to_thread(proc.wait)
    try:
        os.close(master)
    except OSError:
        pass
    return code, proc


# ---------------- venv 初始化 ----------------

async def init_env(script_path: str, on_line: Callable[[str, str], Awaitable[None]], deps_path: str = "") -> dict[str, Any]:
    """初始化脚本所在目录的 venv 并安装依赖。deps_path 为空时自动找目录下 requirements.txt。"""
    script = Path(script_path)
    project_dir = script.parent
    project_dir.mkdir(parents=True, exist_ok=True)
    venv_py = _venv_python(project_dir)
    steps: list[str] = []

    # 1. 创建 venv
    if not venv_py.exists():
        await on_line("info", f"→ 创建虚拟环境: uv venv --directory {project_dir}\n")
        code, _ = await _stream_proc(["uv", "venv", "--directory", str(project_dir)], str(project_dir), on_line)
        if code != 0:
            return {"ok": False, "step": "venv", "message": "uv venv 创建失败（退出码 %s）" % code}
        steps.append("venv")
    else:
        await on_line("info", "· 虚拟环境已存在，跳过创建\n")

    # 2. 安装依赖文件（显式 deps_path 优先，否则目录下 requirements.txt / pyproject.toml）
    kind, dep_file = _resolve_deps(deps_path, project_dir)
    if dep_file is not None:
        if kind == "pyproject":
            await on_line("info", f"→ 安装项目依赖: uv sync --project {project_dir}\n")
            code, _ = await _stream_proc(
                ["uv", "sync", "--project", str(project_dir), "--python", str(venv_py)],
                str(project_dir),
                on_line,
            )
            if code != 0:
                return {"ok": False, "step": "deps", "message": "uv sync 失败（退出码 %s）" % code}
        else:
            await on_line("info", f"→ 安装依赖: uv pip install -r {dep_file}\n")
            code, _ = await _stream_proc(
                ["uv", "pip", "install", "-r", str(dep_file), "--python", str(venv_py)],
                str(project_dir),
                on_line,
            )
            if code != 0:
                return {"ok": False, "step": "deps", "message": "依赖安装失败（退出码 %s）" % code}
        steps.append("deps")
    else:
        await on_line("info", "· 未发现依赖文件（requirements.txt / pyproject.toml），跳过依赖安装")

    return {"ok": True, "steps": steps, "venv_python": str(venv_py)}


# ---------------- 执行脚本 ----------------

def build_command(script_path: str, args: list[str], extra_args: list[str] | None = None) -> list[str]:
    """拼接 uv 执行命令。

    PEP 723 内联脚本：uv run --script <script> [-- args...]（uv 自动创建临时环境安装内联依赖）；
    普通项目：uv run --project <dir> python <script> <args...>。
    """
    script = Path(script_path)
    if pep723_metadata(script_path):
        # uv run --script 之后的参数直接传给脚本（无需 -- 分隔，-- 会被原样传给脚本）
        cmd = ["uv", "run", "--script", str(script)] + args
        if extra_args:
            cmd += extra_args
        return cmd
    cmd = ["uv", "run", "--project", str(script.parent), "python", "-u", str(script)]
    cmd += args
    if extra_args:
        cmd += extra_args
    return cmd


async def run_script(
    exec_id: int,
    script_path: str,
    args: list[str],
    on_line: Callable[[str, str], Awaitable[None]],
    extra_args: list[str] | None = None,
) -> dict[str, Any]:
    """执行脚本并流式回调，支持通过 terminate_execution 终止。"""
    script = Path(script_path)
    project_dir = script.parent
    cmd = build_command(script_path, args, extra_args)

    holder = _RUNNING.setdefault(exec_id, {"proc": None, "terminated": False})
    try:
        code, proc = await _stream_proc(cmd, str(project_dir), on_line, proc_holder=holder)
        terminated = holder.get("terminated", False)
        return {"ok": True, "exit_code": code, "terminated": terminated}
    except asyncio.CancelledError:
        return {"ok": False, "exit_code": -1, "terminated": holder.get("terminated", False), "message": "任务被取消"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "exit_code": -1, "terminated": holder.get("terminated", False), "message": str(e)}
    finally:
        _RUNNING.pop(exec_id, None)


def terminate_execution(exec_id: int) -> bool:
    """终止运行中的执行（进程组）。"""
    import subprocess

    info = _RUNNING.get(exec_id)
    if not info:
        return False
    proc = info.get("proc")
    if proc is None or proc.returncode is not None:
        return False
    info["terminated"] = True
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
            )
        else:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except ProcessLookupError:
                proc.terminate()
        return True
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            return False
        return True
