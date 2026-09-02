"""工具脚本启动器 - FastAPI 后端入口。

启动：uv run --project launcher python -m launcher.main
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import webbrowser
from contextlib import asynccontextmanager
from datetime import datetime
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


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # 定时任务调度循环（服务生命周期内常驻）
    task = asyncio.create_task(_schedule_loop())
    try:
        yield
    finally:
        task.cancel()


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
    tags: Optional[list[str]] = None


class FolderReq(BaseModel):
    name: str


class MoveReq(BaseModel):
    folder_id: Optional[int] = None


class SaveArgsReq(BaseModel):
    args: dict


class PresetReq(BaseModel):
    name: str
    args: dict


class ExecuteReq(BaseModel):
    script_id: int
    args: dict
    preset_id: Optional[int] = None


class TagsReq(BaseModel):
    tags: list[str]


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


class ScheduleUpdateReq(BaseModel):
    name: Optional[str] = None
    cron: Optional[str] = None
    args: Optional[dict] = None
    enabled: Optional[bool] = None
    max_runs: Optional[int] = None


class CronPreviewReq(BaseModel):
    cron: str


class MetaReq(BaseModel):
    key: str
    value: str


# ---------------- 流式会话（执行 / 环境初始化共用） ----------------

_SESSIONS: dict[int, dict] = {}


async def _emit(session_id: int, stream: str, line: str) -> None:
    sess = _SESSIONS.get(session_id)
    if not sess:
        return
    sess["buffer"].append((stream, line))
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
    sess["buffer"].append(("__done__", result))
    sess["done"] = True
    async with sess["cond"]:
        sess["cond"].notify_all()
    return result


def _new_session(session_id: int) -> None:
    _SESSIONS[session_id] = {"buffer": [], "cond": asyncio.Condition(), "done": False}


async def _ws_pump(ws: WebSocket, session_id: int) -> None:
    """把会话缓冲区内容通过 WS 推送给前端。"""
    await ws.accept()
    sess = _SESSIONS.get(session_id)
    if not sess:
        await ws.send_json({"type": "done", "result": {"ok": False, "message": "会话不存在"}})
        await ws.close()
        return
    idx = 0
    while True:
        while idx < len(sess["buffer"]):
            stream, data = sess["buffer"][idx]
            idx += 1
            if stream == "__done__":
                await ws.send_json({"type": "done", "result": data})
                await ws.close()
                return
            await ws.send_json({"type": "line", "stream": stream, "line": data})
        async with sess["cond"]:
            await sess["cond"].wait()


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


def _merge_output_lines(chunks: list[str]) -> list[str]:
    """把原始输出块按终端语义合并为逻辑行：\r 覆盖当前行、\n（或 \r\n）换行。

    保留 ANSI 转义序列（历史详情前端做 ANSI 渲染）。支持 pty 块与管道行混排。
    """
    text = "".join(chunks)
    lines: list[str] = []
    buf = ""
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\r":
            if i + 1 < n and text[i + 1] == "\n":
                lines.append(buf)
                buf = ""
                i += 2
                continue
            buf = ""
            i += 1
            continue
        if ch == "\n":
            lines.append(buf)
            buf = ""
            i += 1
            continue
        buf += ch
        i += 1
    if buf:
        lines.append(buf)
    return lines


def _shq(s: str) -> str:
    """POSIX shell 单引号转义：仅含安全字符时原样返回，否则用单引号包裹。"""
    s = str(s)
    if s and all(c.isalnum() or c in "-_./@:=+%" for c in s):
        return s
    return "'" + s.replace("'", "'\\''") + "'"


def _build_command_text(script_path: str, arg_list: list[str]) -> str:
    """生成可直接复制执行的 uv run 命令（含 shell 转义）。"""
    p = Path(script_path)
    if executor.pep723_metadata(script_path):
        parts = ["uv", "run", "--script", _shq(str(p))] + [_shq(a) for a in arg_list]
        return " ".join(parts)
    parts = ["uv", "run", "--project", _shq(str(p.parent)), "python", _shq(p.name)] + [_shq(a) for a in arg_list]
    return " ".join(parts)


async def _execute_task(exec_id: int, script_path: str, arg_list: list[str], emit: Callable) -> dict:
    """后台执行任务，流式输出，结束后写库。"""
    await emit("info", "· 环境检查中…\n")
    env = executor.inspect_env(script_path)
    if env.get("has_inline_meta"):
        await emit("info", "· PEP 723 内联脚本，uv 自动管理依赖\n")
    elif not env["has_venv"]:
        await emit("info", "⚠ 未检测到虚拟环境，请先点击「初始化环境」\n")
    await emit("info", "$ " + _build_command_text(script_path, arg_list) + "\n")

    result = await executor.run_script(exec_id, script_path, arg_list, emit)
    terminated = result.get("terminated", False)

    if terminated:
        status = "terminated"
    elif result.get("exit_code") == 0:
        status = "success"
    else:
        status = "failed"

    chunks = [l for s, l in _SESSIONS.get(exec_id, {"buffer": []})["buffer"] if s != "__done__"]
    lines = _merge_output_lines(chunks)
    db.finish_execution(exec_id, status, result.get("exit_code"), lines)
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


def _refresh_schedule_plan(schedule_id: int, cron: str, enabled: bool) -> None:
    """cron 或启停变化后：清空旧计划，并按新 cron 立即重算 next_run。

    这样前端保存/创建后无需等调度器 tick（最长 10 秒）即可拿到正确的下次执行时间。
    """
    db.set_schedule_runtime(schedule_id, clear_next_run=True, last_status=None)
    if enabled:
        try:
            nr = _cron_next(cron, datetime.now().astimezone())
            db.set_schedule_runtime(schedule_id, next_run=_iso(nr))
        except Exception as e:  # noqa: BLE001
            db.set_schedule_runtime(schedule_id, last_status=f"cron 无效: {e}")


async def _sched_run(exec_id: int, sched: dict, script_path: str, arg_list: list[str]) -> None:
    """定时触发的一次执行：走标准 session 流程并落库，结束后回写 last_status。"""
    async def coro(emit: Callable) -> dict:
        return await _execute_task(exec_id, script_path, arg_list, emit)
    result = await _run_in_session(exec_id, coro)
    status = result.get("status", "unknown")
    # 已达执行上限自动停用时，保留上限提示而不覆盖为 success/failed
    cur = db.get_schedule(sched["id"])
    if cur:
        max_runs = cur.get("max_runs")
        run_count = cur.get("run_count") or 0
        if max_runs is not None and run_count >= max_runs:
            db.set_schedule_runtime(sched["id"], last_status=f"已达执行上限 {max_runs} 次，已自动停用（最后一次：{status}）")
            return
    db.set_schedule_runtime(sched["id"], last_status=status)


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
    schema = json.loads(rec.get("args_schema") or "[]")
    args = json.loads(sched.get("args") or "{}")
    arg_list = build_arg_list(schema, args)
    exec_row = db.add_execution(rec["id"], args, None)
    exec_id = exec_row["id"]
    _new_session(exec_id)
    asyncio.create_task(_sched_run(exec_id, sched, rec["path"], arg_list))
    db.set_schedule_runtime(sched["id"], next_run=_iso(nr), last_run=_iso(now), last_status="running")

    # 执行次数计数：达到上限后自动停用，等用户重新启用时重置
    new_count = (sched.get("run_count") or 0) + 1
    max_runs = sched.get("max_runs")
    if max_runs is not None:
        db.set_schedule_runtime(sched["id"], run_count=new_count)
        if new_count >= max_runs:
            db.set_schedule_runtime(sched["id"], enabled=False)
            db.set_schedule_runtime(sched["id"], last_status=f"已达执行上限 {max_runs} 次，已自动停用")


async def _tick_schedules() -> None:
    now = datetime.now().astimezone()
    for sched in db.list_schedules(only_enabled=True):
        try:
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
    try:
        _cron_next(cron, datetime.now().astimezone())
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"cron 表达式无效：{e}"}, status_code=400)
    s = db.add_schedule(req.script_id, name, cron, req.args, req.enabled, max_runs=req.max_runs)
    _refresh_schedule_plan(s["id"], cron, bool(req.enabled))
    s = db.get_schedule(s["id"])
    return {"ok": True, "schedule": s}


@app.put("/api/schedules/{schedule_id}")
async def update_schedule_api(schedule_id: int, req: ScheduleUpdateReq):
    if req.cron is not None:
        try:
            _cron_next(req.cron.strip(), datetime.now().astimezone())
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"ok": False, "error": f"cron 表达式无效：{e}"}, status_code=400)
        req.cron = req.cron.strip()
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


@app.post("/api/schedules/preview")
async def preview_cron(req: CronPreviewReq):
    """根据 cron 表达式计算下次执行时间（前端实时预览用）。"""
    try:
        nr = _cron_next(req.cron.strip(), datetime.now().astimezone())
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
    rec = db.update_script(script_id, req.name, req.description, req.deps_path, req.tags)
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
    rec["env"] = executor.inspect_env(rec["path"], rec.get("deps_path") or "")
    return rec


@app.delete("/api/scripts/{script_id}")
async def delete_script(script_id: int):
    db.delete_script(script_id)
    return {"ok": True}


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
        # 同名预设：覆盖其参数
        p = db.update_preset(existing["id"], req.args)
        return {"ok": True, "preset": p, "overwritten": True}
    p = db.add_preset(script_id, name, req.args)
    return {"ok": True, "preset": p, "overwritten": False}


@app.delete("/api/presets/{preset_id}")
async def delete_preset(preset_id: int):
    db.delete_preset(preset_id)
    return {"ok": True}


@app.get("/api/scripts/{script_id}/env")
async def script_env(script_id: int):
    rec = db.get_script(script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    return executor.inspect_env(rec["path"])


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
    asyncio.create_task(_run_in_session(session_id, lambda emit: executor.init_env(rec["path"], emit, deps_path)))
    return {"ok": True, "session_id": session_id}


# ---------- executions ----------

@app.post("/api/execute")
async def execute(req: ExecuteReq):
    rec = db.get_script(req.script_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "脚本不存在"}, status_code=404)
    schema = json.loads(rec.get("args_schema") or "[]")
    arg_list = build_arg_list(schema, req.args)
    command = _build_command_text(rec["path"], arg_list)
    exec_row = db.add_execution(req.script_id, req.args, req.preset_id)
    exec_id = exec_row["id"]
    _new_session(exec_id)
    asyncio.create_task(
        _run_in_session(exec_id, lambda emit: _execute_task(exec_id, rec["path"], arg_list, emit))
    )
    return {"ok": True, "execution_id": exec_id, "command": command}


@app.get("/api/executions")
async def list_executions(script_id: Optional[int] = None, tag: Optional[str] = None,
                          status: Optional[str] = None, limit: int = 200):
    return db.list_executions(script_id, tag, status, limit)


@app.get("/api/executions/{exec_id}")
async def execution_detail(exec_id: int):
    rec = db.get_execution(exec_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "记录不存在"}, status_code=404)
    rec["args"] = json.loads(rec.get("args") or "{}")
    rec["tags"] = json.loads(rec.get("tags") or "[]")
    # 附加脚本名用于展示
    if rec.get("script_id"):
        s = db.get_script(rec["script_id"])
        rec["script_name"] = s["name"] if s else None
    return rec


@app.put("/api/executions/{exec_id}/tags")
async def update_tags(exec_id: int, req: TagsReq):
    db.set_execution_tags(exec_id, req.tags)
    return {"ok": True}


@app.delete("/api/executions/{exec_id}")
async def delete_execution(exec_id: int):
    db.delete_execution(exec_id)
    return {"ok": True}


@app.post("/api/executions/clear")
async def clear_executions(req: ClearReq):
    n = db.clear_executions(req.script_id)
    return {"ok": True, "deleted": n}


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

def main() -> None:
    import uvicorn

    port = int(os.environ.get("LAUNCHER_PORT", "8900"))
    host = os.environ.get("LAUNCHER_HOST", "127.0.0.1")
    no_browser = "--no-browser" in sys.argv

    db.init_db()
    url = f"http://{host}:{port}/?t={int(time.time())}"
    print(f"· Python 脚本启动器已启动: {url}")

    if not no_browser:
        # 延迟打开浏览器，带时间戳避免复用旧页面，确保加载最新版
        threading_timer = __import__("threading").Timer(1.2, lambda: webbrowser.open(url))
        threading_timer.start()

    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
