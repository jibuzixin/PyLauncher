"""uv 集成：检测 / venv 管理 / 进程执行 / 流式输出。

约定：脚本所在目录 = 项目根目录，使用 uv 创建该目录下的 .venv。
"""
from __future__ import annotations

import asyncio
import json
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


def _venv_python_for(venv_dir: Path) -> Path:
    """返回 venv 根目录下的 python 可执行文件路径（win / posix 分支）。"""
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def resolve_venv_python(venv_path: str) -> Optional[str]:
    """解析用户指定的虚拟环境 python：接受 venv 根目录或 python 可执行文件路径。"""
    if not venv_path:
        return None
    p = Path(venv_path).expanduser()
    if not p.exists():
        return None
    if p.is_file():
        return str(p)
    py = _venv_python_for(p)
    return str(py) if py.exists() else None


def list_env_managers() -> dict[str, Any]:
    """检测本机环境管理工具：uv / conda / mamba / 系统 python。"""
    def _ver(cmd: list[str]) -> str:
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            return (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else ""
        except Exception:  # noqa: BLE001
            return ""
    managers = []
    for key, cmd in [
        ("uv", ["uv", "--version"]),
        ("conda", ["conda", "--version"]),
        ("mamba", ["mamba", "--version"]),
    ]:
        if shutil.which(key):
            v = _ver(cmd)
            managers.append({"name": key, "ok": True, "version": v or "已安装"})
    py = shutil.which("python3") or shutil.which("python")
    if py:
        import sysconfig
        managers.append({"name": "python", "ok": True,
                         "version": _ver([py, "--version"]).replace("Python ", "") or "", "path": py})
    return {"managers": managers}


def scan_venvs() -> list[dict[str, Any]]:
    """扫描已有虚拟环境（只扫"被管理的"，不做全盘扫描）。

    来源：conda/mamba 环境列表 + 常见 venv 约定目录（~/.virtualenvs、~/.venvs）。
    返回 [{name, path, python, type}]，python 存在性已校验。
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _add(name: str, root: Path, kind: str) -> None:
        root = root.expanduser()
        py = _venv_python_for(root)
        if py.exists() and str(root) not in seen:
            seen.add(str(root))
            out.append({"name": name, "path": str(root), "python": str(py), "type": kind})

    # 1. conda / mamba env list --json
    for mgr in ("conda", "mamba"):
        if not shutil.which(mgr):
            continue
        try:
            r = subprocess.run([mgr, "env", "list", "--json"], capture_output=True, text=True, timeout=20)
            data = json.loads(r.stdout or "{}")
            for p in data.get("envs", []):
                _add(Path(p).name, Path(p), "conda")
            break
        except Exception:  # noqa: BLE001
            pass

    # 2. 常见 venv 约定目录（定点扫描）
    for base in (Path.home() / ".virtualenvs", Path.home() / ".venvs"):
        if not base.is_dir():
            continue
        try:
            for child in sorted(base.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    _add(child.name, child, "venv")
        except Exception:  # noqa: BLE001
            pass

    return out


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


def execution_plan(script_path: str, venv_path: str = "") -> dict[str, Any]:
    """决定脚本如何执行：自定义 venv / uv / 项目 .venv / 无法执行。

    理念：脚本目录下只要有虚拟环境（.venv，原生 python venv 或 uv 创建的均可）
    或有 uv，就可以运行；用户也可为脚本显式指定任意位置的虚拟环境（venv_path）。
    返回 {"mode": "uv"|"venv"|None, "venv_python": str|None, "error": str|None}。
    """
    script = Path(script_path)
    # 显式指定的虚拟环境优先（用户明确选择，覆盖一切默认逻辑）
    if venv_path:
        vpy = resolve_venv_python(venv_path)
        if not vpy:
            return {"mode": None, "venv_python": None,
                    "error": f"指定的虚拟环境不可用：{venv_path}（未找到可执行的 python）"}
        return {"mode": "venv", "venv_python": vpy, "error": None}
    uv_ok, _ = uv_available()
    has_meta = pep723_metadata(script_path) is not None
    venv_py = _venv_python(script.parent)
    if has_meta:
        if not uv_ok:
            return {"mode": None, "venv_python": None,
                    "error": "该脚本使用 PEP 723 内联依赖，需要 uv 运行（uv 会自动创建临时环境安装依赖）；当前未检测到 uv，请先安装"}
        return {"mode": "uv", "venv_python": None, "error": None}
    if uv_ok:
        return {"mode": "uv", "venv_python": None, "error": None}
    if venv_py.exists():
        return {"mode": "venv", "venv_python": str(venv_py), "error": None}
    return {"mode": None, "venv_python": None,
            "error": "未检测到 uv，且脚本目录下没有 .venv。请安装 uv，或在页面点击「初始化环境」用系统 Python 创建虚拟环境"}


def inspect_env(script_path: str, deps_path: str = "", venv_path: str = "") -> dict[str, Any]:
    """检查脚本所在目录的环境状态。deps_path 为可选的自定义依赖文件；venv_path 为可选的自定义虚拟环境。"""
    script = Path(script_path)
    project_dir = script.parent
    kind, dep_file = _resolve_deps(deps_path, project_dir)
    meta = pep723_metadata(script_path)
    deps = meta.get("dependencies") or [] if meta else []
    uv_ok, uv_ver = uv_available()
    # 自定义虚拟环境优先
    if venv_path:
        vpy = resolve_venv_python(venv_path)
        has_venv = vpy is not None
        venv_py = vpy or _venv_python(project_dir)
        venv_source = "custom"
        venv_broken = not has_venv
    else:
        venv_py = _venv_python(project_dir)
        has_venv = venv_py.exists()
        venv_source = "project"
        venv_broken = False
    return {
        "project_dir": str(project_dir),
        "venv_path": venv_path,
        "venv_source": venv_source,
        "venv_broken": venv_broken,
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
        "uv_ok": uv_ok,
        "uv_version": uv_ver if uv_ok else None,
        # 可运行性：项目有虚拟环境或有 uv（PEP 723 内联脚本只需 uv）即可运行
        "exec_ready": bool(uv_ok or has_venv or meta is not None),
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

async def init_env(script_path: str, on_line: Callable[[str, str], Awaitable[None]], deps_path: str = "",
                   venv_path: str = "") -> dict[str, Any]:
    """初始化虚拟环境并安装依赖。deps_path 为空时自动找目录下 requirements.txt。

    venv_path 指定时：使用该虚拟环境（存在则不创建，只装依赖）；未指定时在脚本目录创建 .venv。
    """
    script = Path(script_path)
    project_dir = script.parent
    project_dir.mkdir(parents=True, exist_ok=True)
    venv_py = _venv_python(project_dir)
    steps: list[str] = []
    custom_venv = bool(venv_path)
    if custom_venv:
        venv_py = Path(resolve_venv_python(venv_path) or "")

    # 1. 创建 venv（有 uv 用 uv venv；无 uv 用系统 Python 创建，兼容原生虚拟环境）
    if custom_venv:
        await on_line("info", f"· 使用指定虚拟环境: {venv_py}\n")
    elif not venv_py.exists():
        uv_ok, _ = uv_available()
        if uv_ok:
            await on_line("info", f"→ 创建虚拟环境: uv venv --directory {project_dir}\n")
            code, _ = await _stream_proc(["uv", "venv", "--directory", str(project_dir)], str(project_dir), on_line)
            if code != 0:
                return {"ok": False, "step": "venv", "message": "uv venv 创建失败（退出码 %s）" % code}
        else:
            py = shutil.which("python3") or shutil.which("python")
            if not py:
                return {"ok": False, "step": "venv", "message": "未找到 python3/python，无法创建虚拟环境"}
            await on_line("info", f"→ 未检测到 uv，使用系统 Python 创建虚拟环境: {py} -m venv .venv\n")
            code, _ = await _stream_proc([py, "-m", "venv", ".venv"], str(project_dir), on_line)
            if code != 0:
                return {"ok": False, "step": "venv", "message": "python -m venv 创建失败（退出码 %s）" % code}
        steps.append("venv")
    else:
        await on_line("info", "· 虚拟环境已存在，跳过创建\n")

    # 2. 安装依赖文件（显式 deps_path 优先，否则目录下 requirements.txt / pyproject.toml）
    kind, dep_file = _resolve_deps(deps_path, project_dir)
    uv_ok, _ = uv_available()
    if dep_file is not None:
        if kind == "pyproject" and uv_ok:
            await on_line("info", f"→ 安装项目依赖: uv sync --project {project_dir}\n")
            code, _ = await _stream_proc(
                ["uv", "sync", "--project", str(project_dir), "--python", str(venv_py)],
                str(project_dir),
                on_line,
            )
            if code != 0:
                return {"ok": False, "step": "deps", "message": "uv sync 失败（退出码 %s）" % code}
        elif kind == "pyproject":
            # 无 uv：用 venv 的 pip 可编辑安装项目自身
            await on_line("info", f"→ 未检测到 uv，使用 venv pip 安装项目: {venv_py} -m pip install -e .\n")
            code, _ = await _stream_proc([str(venv_py), "-m", "pip", "install", "-e", "."], str(project_dir), on_line)
            if code != 0:
                return {"ok": False, "step": "deps", "message": "pip install -e . 失败（退出码 %s）" % code}
        elif uv_ok:
            await on_line("info", f"→ 安装依赖: uv pip install -r {dep_file}\n")
            code, _ = await _stream_proc(
                ["uv", "pip", "install", "-r", str(dep_file), "--python", str(venv_py)],
                str(project_dir),
                on_line,
            )
            if code != 0:
                return {"ok": False, "step": "deps", "message": "依赖安装失败（退出码 %s）" % code}
        else:
            await on_line("info", f"→ 未检测到 uv，使用 venv pip 安装依赖: {venv_py} -m pip install -r {dep_file.name}\n")
            code, _ = await _stream_proc([str(venv_py), "-m", "pip", "install", "-r", str(dep_file)], str(project_dir), on_line)
            if code != 0:
                return {"ok": False, "step": "deps", "message": "依赖安装失败（退出码 %s）" % code}
        steps.append("deps")
    else:
        await on_line("info", "· 未发现依赖文件（requirements.txt / pyproject.toml），跳过依赖安装")

    return {"ok": True, "steps": steps, "venv_python": str(venv_py)}


# ---------------- 执行脚本 ----------------

def build_command(script_path: str, args: list[str], extra_args: list[str] | None = None) -> list[str]:
    """拼接实际执行命令，返回 (cmd) 或抛 ValueError（无法执行时）。

    PEP 723 内联脚本：uv run --script <script> [-- args...]（uv 自动创建临时环境安装内联依赖）；
    有 uv 的普通项目：uv run --project <dir> python <script> <args...>；
    无 uv 但目录有 .venv：<venv_python> -u <script> <args...>（兼容原生 python venv）。
    """
    cmd, err = build_command_ex(script_path, args, extra_args)
    if err:
        raise ValueError(err)
    return cmd


def build_command_ex(script_path: str, args: list[str], extra_args: list[str] | None = None,
                    venv_path: str = "") -> tuple[list[str], Optional[str]]:
    """同 build_command，但返回 (cmd, error)，error 非空表示无法执行。venv_path 指定自定义虚拟环境。"""
    script = Path(script_path)
    plan = execution_plan(script_path, venv_path)
    if plan["mode"] is None:
        return [], plan["error"]
    if plan["mode"] == "uv" and pep723_metadata(script_path):
        cmd = ["uv", "run", "--script", str(script)] + args
        if extra_args:
            cmd += extra_args
        return cmd, None
    if plan["mode"] == "uv":
        cmd = ["uv", "run", "--project", str(script.parent), "python", "-u", str(script)]
    else:
        cmd = [plan["venv_python"], "-u", str(script)]
    cmd += args
    if extra_args:
        cmd += extra_args
    return cmd, None


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
    try:
        cmd = build_command(script_path, args, extra_args)
    except ValueError as e:
        # 无法执行（无 uv 且无 .venv / PEP 723 需 uv）
        await on_line("error", f"✗ {e}\n")
        return {"ok": False, "exit_code": -1, "terminated": False, "message": str(e)}

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
    """终止运行中的执行（进程组）。

    实测 macOS 下 uv run 对其子进程会屏蔽 SIGTERM（直接 kill -SIGTERM 子进程也不退出），
    因此先发 SIGTERM 进程组给脚本优雅退出的机会，后台 2 秒后若仍存活则 SIGKILL 进程组强制终止。
    """
    import subprocess
    import threading
    import time

    info = _RUNNING.get(exec_id)
    if not info:
        return False
    proc = info.get("proc")
    if proc is None or proc.returncode is not None:
        return False
    info["terminated"] = True
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
        )
        return True
    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        return True
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            return False
        return True

    # 后台兜底：SIGTERM 后若进程仍未退出，SIGKILL 进程组强制终止
    def _escalate() -> None:
        time.sleep(2)
        p = _RUNNING.get(exec_id, {}).get("proc")
        if p is None or p.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:  # noqa: BLE001
            try:
                p.kill()
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=_escalate, daemon=True).start()
    return True
