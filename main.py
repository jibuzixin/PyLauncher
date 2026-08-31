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
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import executor
import scanner

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"

app = FastAPI(title="Tool Launcher", docs_url=None, redoc_url=None)

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


async def _execute_task(exec_id: int, script_path: str, arg_list: list[str], emit: Callable) -> dict:
    """后台执行任务，流式输出，结束后写库。"""
    await emit("info", "· 环境检查中…\n")
    env = executor.inspect_env(script_path)
    if not env["has_venv"]:
        await emit("info", "⚠ 未检测到虚拟环境，请先点击「初始化环境」\n")
    await emit("info", "$ uv run --project " + str(Path(script_path).parent) + " python " + Path(script_path).name + " " + " ".join(arg_list) + "\n")

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
    rec = db.add_script(name, info["path"], info["schema"]["args"], description=desc or "")
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
    updated = db.update_script_schema(script_id, info["schema"]["args"], info["schema"].get("description") or "")
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
    if not req.name.strip():
        return JSONResponse({"ok": False, "error": "预设名称不能为空"}, status_code=400)
    p = db.add_preset(script_id, req.name.strip(), req.args)
    return {"ok": True, "preset": p}


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
    exec_row = db.add_execution(req.script_id, req.args, req.preset_id)
    exec_id = exec_row["id"]
    _new_session(exec_id)
    asyncio.create_task(
        _run_in_session(exec_id, lambda emit: _execute_task(exec_id, rec["path"], arg_list, emit))
    )
    return {"ok": True, "execution_id": exec_id}


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
