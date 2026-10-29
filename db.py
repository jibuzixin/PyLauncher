"""sqlite 数据层：脚本注册表 / 参数预设 / 执行记录 / 配置表。

使用标准库 sqlite3。每次操作独立开连接，避免跨线程复用问题。
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launcher.db")

# 状态别名：搜「成功」「失败」也能命中执行记录（库里存的是英文状态）
# 这些词是「状态词」，只跟状态字段比，不会去 output/命令 里乱匹配
EXEC_STATUS_ALIAS = {
    "成功": "success",
    "失败": "failed",
    "运行中": "running",
    "已终止": "terminated",
    "终止": "terminated",
    "success": "success",
    "failed": "failed",
    "running": "running",
    "terminated": "terminated",
}

# 执行记录只保留程序结束后的最后 N 行
OUTPUT_KEEP_LINES = 1000

_lock = threading.Lock()

# 用于区分 update 时“未传”与“显式传 None（清除）”
_UNSET = object()

SCHEMA = """
CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    args_schema TEXT NOT NULL DEFAULT '[]',
    auto_saved_args TEXT NOT NULL DEFAULT '{}',
    description TEXT NOT NULL DEFAULT '',
    deps_path TEXT NOT NULL DEFAULT '',
    venv_path TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    has_inline_meta INTEGER NOT NULL DEFAULT 0,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    cmd_prefix TEXT NOT NULL DEFAULT '',
    cmd_suffix TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id INTEGER REFERENCES scripts(id) ON DELETE SET NULL,
    preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL,
    args TEXT NOT NULL DEFAULT '{}',
    command TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    exit_code INTEGER,
    output TEXT NOT NULL DEFAULT '',
    output_ts TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    max_runs INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    next_run TEXT,
    last_run TEXT,
    last_status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cmd_prefix TEXT NOT NULL DEFAULT '',
    cmd_suffix TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);

-- 运行队列：把若干定时任务排成一条串行执行的队伍
CREATE TABLE IF NOT EXISTS queues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_at TEXT NOT NULL,                    -- 队列的开始执行时间
    interval_seconds INTEGER NOT NULL DEFAULT 5,-- 两个任务之间的间隔
    stop_on_error INTEGER NOT NULL DEFAULT 0,  -- 1=出错就停下；0=跳过继续下一个
    enabled INTEGER NOT NULL DEFAULT 1,        -- 0=已关闭：不再开跑新的任务（不影响正在跑的）
    status TEXT NOT NULL DEFAULT 'pending',    -- pending / running / paused / done / stopped
    next_ready_at TEXT,                        -- 上一个任务跑完后，最早可以开始下一个的时刻
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id INTEGER NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL,  -- 绑预设就跟着预设走
    args TEXT NOT NULL DEFAULT '{}',          -- 没绑预设时的参数快照
    cmd_prefix TEXT NOT NULL DEFAULT '',      -- 没绑预设时的命令前缀快照
    cmd_suffix TEXT NOT NULL DEFAULT '',      -- 没绑预设时的命令后缀快照
    position INTEGER NOT NULL DEFAULT 0,       -- 先进先出：位置小的先跑
    status TEXT NOT NULL DEFAULT 'pending',    -- pending / running / success / failed / skipped
    rerun INTEGER NOT NULL DEFAULT 0,          -- 1=重新启动时正在跑：跑完回到待执行，重头再来
    error TEXT,
    exec_id INTEGER,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_items_queue ON queue_items(queue_id, position);

CREATE INDEX IF NOT EXISTS idx_scripts_path ON scripts(path);
CREATE INDEX IF NOT EXISTS idx_exec_script ON executions(script_id);
CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_exec_started ON executions(started_at DESC);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """老库增量迁移：补充新增列，并清理已废弃的文件夹分组。"""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(scripts)")}
    if "description" not in cols:
        conn.execute("ALTER TABLE scripts ADD COLUMN description TEXT NOT NULL DEFAULT ''")
    if "folder_id" not in cols:
        conn.execute("ALTER TABLE scripts ADD COLUMN folder_id INTEGER REFERENCES folders(id)")
    if "deps_path" not in cols:
        conn.execute("ALTER TABLE scripts ADD COLUMN deps_path TEXT NOT NULL DEFAULT ''")
    if "tags" not in cols:
        conn.execute("ALTER TABLE scripts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
    if "has_inline_meta" not in cols:
        conn.execute("ALTER TABLE scripts ADD COLUMN has_inline_meta INTEGER NOT NULL DEFAULT 0")
    # schedules 表迁移
    scols = {r[1] for r in conn.execute("PRAGMA table_info(schedules)")}
    if "max_runs" not in scols:
        conn.execute("ALTER TABLE schedules ADD COLUMN max_runs INTEGER")
    if "run_count" not in scols:
        conn.execute("ALTER TABLE schedules ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0")
    if "preset_id" not in scols:
        conn.execute("ALTER TABLE schedules ADD COLUMN preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL")
    # schedules 表迁移：自定义命令的前缀 / 后缀（定时任务执行时一并用上）
    if "cmd_prefix" not in scols:
        conn.execute("ALTER TABLE schedules ADD COLUMN cmd_prefix TEXT NOT NULL DEFAULT ''")
    if "cmd_suffix" not in scols:
        conn.execute("ALTER TABLE schedules ADD COLUMN cmd_suffix TEXT NOT NULL DEFAULT ''")
    # scripts 表迁移：自定义虚拟环境（venv_path，空=默认脚本目录 .venv）
    scols = {r[1] for r in conn.execute("PRAGMA table_info(scripts)")}
    if "venv_path" not in scols:
        conn.execute("ALTER TABLE scripts ADD COLUMN venv_path TEXT NOT NULL DEFAULT ''")
    # presets 表迁移：固定 / 排序 / 最近使用
    # executions 表迁移：实际执行命令（自定义命令回显）+ 每行输出时间戳
    ecols = {r[1] for r in conn.execute("PRAGMA table_info(executions)")}
    if "command" not in ecols:
        conn.execute("ALTER TABLE executions ADD COLUMN command TEXT NOT NULL DEFAULT ''")
    if "output_ts" not in ecols:
        conn.execute("ALTER TABLE executions ADD COLUMN output_ts TEXT NOT NULL DEFAULT ''")
    # 控制台标签页自定义名称（多浏览器共享，随执行记录一起留痕）
    if "tab_name" not in ecols:
        conn.execute("ALTER TABLE executions ADD COLUMN tab_name TEXT NOT NULL DEFAULT ''")
    # presets 表迁移：固定 / 排序 / 最近使用
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(presets)")}
    if "pinned" not in pcols:
        conn.execute("ALTER TABLE presets ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
    if "sort_order" not in pcols:
        conn.execute("ALTER TABLE presets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    if "last_used_at" not in pcols:
        conn.execute("ALTER TABLE presets ADD COLUMN last_used_at TEXT")
    # presets 表迁移：用户自定义命令的前缀 / 后缀（参数段始终由系统按表单生成，不存）
    if "cmd_prefix" not in pcols:
        conn.execute("ALTER TABLE presets ADD COLUMN cmd_prefix TEXT NOT NULL DEFAULT ''")
    if "cmd_suffix" not in pcols:
        conn.execute("ALTER TABLE presets ADD COLUMN cmd_suffix TEXT NOT NULL DEFAULT ''")
    # queues 表迁移：启用开关（0=已关闭，不再开跑新任务）
    qcols = {r[1] for r in conn.execute("PRAGMA table_info(queues)")}
    if "enabled" not in qcols:
        conn.execute("ALTER TABLE queues ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
    # v0.0.4：文件夹功能废弃，脚本全部移回根目录并清空文件夹表
    conn.execute("UPDATE scripts SET folder_id=NULL WHERE folder_id IS NOT NULL")
    conn.execute("DELETE FROM folders")
    # queue_items 表迁移：队列任务从「定时任务」改成「脚本 + 预设」两个维度。
    # 老数据（schedule_id）按定时任务自己的 script_id / preset_id / 参数快照平移过来，
    # 原来绑了预设的继续跟着预设走，没绑的保留自己的参数与命令前后缀。
    qcols = {r[1] for r in conn.execute("PRAGMA table_info(queue_items)")}
    if "schedule_id" in qcols and "script_id" not in qcols:
        conn.execute("ALTER TABLE queue_items RENAME TO queue_items_old")
        conn.execute(
            "CREATE TABLE queue_items ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " queue_id INTEGER NOT NULL REFERENCES queues(id) ON DELETE CASCADE,"
            " script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,"
            " preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL,"
            " args TEXT NOT NULL DEFAULT '{}',"
            " cmd_prefix TEXT NOT NULL DEFAULT '',"
            " cmd_suffix TEXT NOT NULL DEFAULT '',"
            " position INTEGER NOT NULL DEFAULT 0,"
            " status TEXT NOT NULL DEFAULT 'pending',"
            " rerun INTEGER NOT NULL DEFAULT 0,"
            " error TEXT, exec_id INTEGER, started_at TEXT, finished_at TEXT,"
            " created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
        conn.execute(
            "INSERT INTO queue_items"
            " (id, queue_id, script_id, preset_id, args, cmd_prefix, cmd_suffix,"
            "  position, status, error, exec_id, started_at, finished_at, created_at, updated_at)"
            " SELECT qi.id, qi.queue_id, s.script_id, s.preset_id, s.args, s.cmd_prefix, s.cmd_suffix,"
            "        qi.position, qi.status, qi.error, qi.exec_id, qi.started_at, qi.finished_at,"
            "        qi.created_at, qi.updated_at"
            " FROM queue_items_old qi LEFT JOIN schedules s ON qi.schedule_id = s.id")
        conn.execute("DROP TABLE queue_items_old")
        # 老表上的同名索引会随 DROP 一起消失，所以重建表之后要重新建索引
        conn.execute("CREATE INDEX IF NOT EXISTS idx_queue_items_queue ON queue_items(queue_id, position)")
    # queue_items 表迁移：重新启动时正在跑的任务，跑完要回到待执行（重头再来一遍）
    qicols = {r[1] for r in conn.execute("PRAGMA table_info(queue_items)")}
    if "rerun" not in qicols:
        conn.execute("ALTER TABLE queue_items ADD COLUMN rerun INTEGER NOT NULL DEFAULT 0")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


@contextmanager
def _conn() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _lock:
        with _conn() as conn:
            conn.executescript(SCHEMA)
            _migrate(conn)


# ---------- 工具 ----------

def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _loads(s: str, default: Any = None) -> Any:
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return default if default is not None else {}


def get_meta(key: str, default: Optional[str] = None) -> Optional[str]:
    with _conn() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row is not None else default


def set_meta(key: str, value: str) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def _with_tags(row: Any) -> Optional[dict]:
    """scripts 行 → dict，并把 tags 解析成数组。

    写操作（新增 / 更新 / 重载）直接 SELECT * 返回的原始行里，tags 还是
    JSON 字符串；前端拿到后直接 tags.forEach 会抛
    「tags.forEach is not a function」，且抛错发生在标签行已清空之后，
    表现就是标签整行消失。所有对外返回脚本的出口都统一走这里。
    （args_schema / auto_saved_args 由调用方各自按需解析，不在这里动。）
    """
    if row is None:
        return None
    d = dict(row)
    d["tags"] = _loads(d.get("tags") or "[]", [])
    return d


# ---------- scripts ----------

def add_script(name: str, path: str, args_schema: list[dict], description: str = "", has_inline_meta: bool = False) -> Optional[dict]:
    """注册脚本。路径重复则更新 schema；用户改过的名称/描述不被扫描覆盖。"""
    ts = now_iso()
    with _lock, _conn() as conn:
        existing = conn.execute("SELECT * FROM scripts WHERE path = ?", (path,)).fetchone()
        if existing:
            # 名称：用户改过（与脚本名不同）则保留，否则同步脚本名
            final_name = name if existing["name"] == name else existing["name"]
            # 描述：用户已填则保留，否则用 argparse description 填充
            final_desc = existing["description"] if existing["description"] else (description or "")
            conn.execute(
                "UPDATE scripts SET name=?, args_schema=?, description=?, has_inline_meta=?, updated_at=? WHERE id=?",
                (final_name, _dumps(args_schema), final_desc, 1 if has_inline_meta else 0, ts, existing["id"]),
            )
            return _with_tags(conn.execute("SELECT * FROM scripts WHERE id=?", (existing["id"],)).fetchone())
        cur = conn.execute(
            "INSERT INTO scripts(name, path, args_schema, description, has_inline_meta, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
            (name, path, _dumps(args_schema), description or "", 1 if has_inline_meta else 0, ts, ts),
        )
        return _with_tags(conn.execute("SELECT * FROM scripts WHERE id=?", (cur.lastrowid,)).fetchone())


def update_script(script_id: int, name: str | None = None, description: str | None = None,
                  deps_path: str | None = None, venv_path: str | None = None,
                  tags: list[str] | None = None) -> Optional[dict]:
    """更新脚本名称/描述/依赖路径/虚拟环境/标签，不传的字段保持不变。"""
    sets: list[str] = []
    params: list = []
    if name is not None:
        sets.append("name=?")
        params.append(name)
    if description is not None:
        sets.append("description=?")
        params.append(description)
    if deps_path is not None:
        sets.append("deps_path=?")
        params.append(deps_path)
    if venv_path is not None:
        sets.append("venv_path=?")
        params.append(venv_path)
    if tags is not None:
        sets.append("tags=?")
        params.append(_dumps([str(t).strip() for t in tags if str(t).strip()]))
    if not sets:
        return get_script(script_id)
    sets.append("updated_at=?")
    params.append(now_iso())
    params.append(script_id)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE scripts SET {', '.join(sets)} WHERE id=?", params)
        return _with_tags(conn.execute("SELECT * FROM scripts WHERE id=?", (script_id,)).fetchone())


def update_script_schema(script_id: int, args_schema: list[dict], description: str, has_inline_meta: bool = False) -> Optional[dict]:
    """重新加载：只更新参数 schema、描述与内联脚本标记，保留用户名称/描述自定义。"""
    with _lock, _conn() as conn:
        existing = conn.execute("SELECT * FROM scripts WHERE id=?", (script_id,)).fetchone()
        if not existing:
            return None
        final_desc = existing["description"] if existing["description"] else (description or "")
        conn.execute(
            "UPDATE scripts SET args_schema=?, description=?, has_inline_meta=?, updated_at=? WHERE id=?",
            (_dumps(args_schema), final_desc, 1 if has_inline_meta else 0, now_iso(), script_id),
        )
        return _with_tags(conn.execute("SELECT * FROM scripts WHERE id=?", (script_id,)).fetchone())


def list_scripts() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM scripts ORDER BY name COLLATE NOCASE"
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["tags"] = _loads(d.get("tags") or "[]", [])
            out.append(d)
        return out


def get_script(script_id: int) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM scripts WHERE id=?",
            (script_id,),
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["tags"] = _loads(d.get("tags") or "[]", [])
        return d


def delete_script(script_id: int) -> bool:
    with _lock, _conn() as conn:
        cur = conn.execute("DELETE FROM scripts WHERE id=?", (script_id,))
        return cur.rowcount > 0


def save_auto_args(script_id: int, args: dict) -> None:
    ts = now_iso()
    with _lock, _conn() as conn:
        conn.execute(
            "UPDATE scripts SET auto_saved_args=?, updated_at=? WHERE id=?",
            (_dumps(args), ts, script_id),
        )


# ---------- presets ----------

def add_preset(script_id: int, name: str, args: dict, cmd_prefix: str = "", cmd_suffix: str = "") -> dict:
    with _lock, _conn() as conn:
        max_o = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM presets WHERE script_id=?", (script_id,)
        ).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO presets(script_id, name, args, created_at, sort_order, cmd_prefix, cmd_suffix) "
            "VALUES(?,?,?,?,?,?,?)",
            (script_id, name, _dumps(args), now_iso(), max_o + 1, cmd_prefix or "", cmd_suffix or ""),
        )
        return dict(conn.execute("SELECT * FROM presets WHERE id=?", (cur.lastrowid,)).fetchone())


def find_preset_by_name(script_id: int, name: str) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM presets WHERE script_id=? AND name=?", (script_id, name)
        ).fetchone()
        return dict(row) if row else None


def get_preset(preset_id: int) -> Optional[dict]:
    """按 id 取单个预设（定时任务执行时读取预设最新的参数与命令前后缀）。"""
    if not preset_id:
        return None
    with _conn() as conn:
        row = conn.execute("SELECT * FROM presets WHERE id=?", (preset_id,)).fetchone()
        return dict(row) if row else None


def update_preset(preset_id: int, args: dict, cmd_prefix: Optional[str] = None,
                  cmd_suffix: Optional[str] = None) -> dict:
    with _lock, _conn() as conn:
        if cmd_prefix is None and cmd_suffix is None:
            conn.execute(
                "UPDATE presets SET args=? WHERE id=?",
                (_dumps(args), preset_id),
            )
        else:
            # 只更新显式传入的一段，另一段保持原值
            sets, vals = ["args=?"], [_dumps(args)]
            if cmd_prefix is not None:
                sets.append("cmd_prefix=?"); vals.append(cmd_prefix)
            if cmd_suffix is not None:
                sets.append("cmd_suffix=?"); vals.append(cmd_suffix)
            vals.append(preset_id)
            conn.execute(f"UPDATE presets SET {', '.join(sets)} WHERE id=?", vals)
        return dict(conn.execute("SELECT * FROM presets WHERE id=?", (preset_id,)).fetchone())


def list_presets(script_id: int) -> list[dict]:
    """固定项在前，组内按 sort_order 升序（手动排序），再按创建时间倒序。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM presets WHERE script_id=? "
            "ORDER BY pinned DESC, sort_order ASC, created_at DESC",
            (script_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def list_all_presets() -> list[dict]:
    """所有预设（带 script_id），给「脚本 → 预设」两级选择用。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM presets ORDER BY script_id ASC, pinned DESC, sort_order ASC, created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def delete_preset(preset_id: int) -> bool:
    with _lock, _conn() as conn:
        cur = conn.execute("DELETE FROM presets WHERE id=?", (preset_id,))
        return cur.rowcount > 0


def touch_preset_used(preset_id: int) -> None:
    """记录最近使用时间（应用预设 / 用预设执行时调用）。毫秒精度，同秒多次使用可排序。"""
    with _lock, _conn() as conn:
        ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")
        conn.execute("UPDATE presets SET last_used_at=? WHERE id=?", (ts, preset_id))


def set_preset_pinned(preset_id: int, pinned: bool) -> dict:
    """固定 / 取消固定：排到对应分组的末尾（sort_order = 组内最大 + 1）。"""
    with _lock, _conn() as conn:
        row = conn.execute("SELECT * FROM presets WHERE id=?", (preset_id,)).fetchone()
        if not row:
            raise ValueError("preset not found")
        flag = 1 if pinned else 0
        max_o = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM presets WHERE script_id=? AND pinned=?",
            (row["script_id"], flag),
        ).fetchone()[0]
        conn.execute(
            "UPDATE presets SET pinned=?, sort_order=? WHERE id=?",
            (flag, max_o + 1, preset_id),
        )
        return dict(conn.execute("SELECT * FROM presets WHERE id=?", (preset_id,)).fetchone())


def move_preset(preset_id: int, direction: str) -> None:
    """在同一脚本、同一固定组内，与相邻预设交换 sort_order（手动排序）。"""
    with _lock, _conn() as conn:
        row = conn.execute("SELECT * FROM presets WHERE id=?", (preset_id,)).fetchone()
        if not row:
            return
        same = conn.execute(
            "SELECT id, sort_order FROM presets WHERE script_id=? AND pinned=? "
            "ORDER BY sort_order ASC, created_at DESC",
            (row["script_id"], row["pinned"]),
        ).fetchall()
        idx = next((i for i, r in enumerate(same) if r["id"] == preset_id), -1)
        nxt = idx - 1 if direction == "up" else idx + 1
        if idx < 0 or nxt < 0 or nxt >= len(same):
            return
        a, b = same[idx], same[nxt]
        conn.execute("UPDATE presets SET sort_order=? WHERE id=?", (b["sort_order"], a["id"]))
        conn.execute("UPDATE presets SET sort_order=? WHERE id=?", (a["sort_order"], b["id"]))


# ---------- 全局环境变量（设置页维护，运行时注入子进程） ----------

ENV_KEY = "run_env"


def parse_env_text(text: str) -> dict[str, str]:
    """解析 KEY=VALUE 文本 → dict。

    支持空行、`#` 注释、`export KEY=VALUE`，以及用单/双引号包裹的值
    （值里带空格或 `#` 时不必转义）。
    """
    out: dict[str, str] = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if not k:
            continue
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        out[k] = v
    return out


def format_env_text(env: dict[str, str]) -> str:
    return "\n".join(f"{k}={v}" for k, v in env.items())


def get_run_env() -> dict[str, str]:
    """读出配置的环境变量（启动器层面，注入所有被运行的脚本）。"""
    try:
        return parse_env_text(get_meta(ENV_KEY, "") or "")
    except Exception:  # noqa: BLE001
        return {}


def set_run_env(text: str) -> dict[str, str]:
    env = parse_env_text(text)
    # 规范化后回写，去掉无效行，避免下次再看到一堆解析不出来的内容
    set_meta(ENV_KEY, format_env_text(env))
    return env


def mark_stale_running() -> int:
    """服务启动时调用：上一次进程遗留的 running 记录全部标记为 failed（进程已不存在）。"""
    with _lock, _conn() as conn:
        cur = conn.execute(
            "UPDATE executions SET status='failed', exit_code=-1, finished_at=? WHERE status='running'",
            (now_iso(),),
        )
        return cur.rowcount


def mark_stale_sched_running() -> int:
    """服务启动时调用：上一次进程遗留的定时任务 running 状态标记为 failed。

    服务重启时不可能还有定时任务在跑（进程都没了），
    不清掉的话卡片会一直显示「运行中」。
    """
    with _lock, _conn() as conn:
        cur = conn.execute(
            "UPDATE schedules SET last_status='failed' WHERE last_status='running'",
        )
        return cur.rowcount


def list_running_executions() -> list[dict]:
    """所有正在运行的执行（脚本卡片徽章 / 任务列表用）。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT e.id, e.script_id, e.args, e.status, e.started_at, e.preset_id, s.name AS script_name "
            "FROM executions e LEFT JOIN scripts s ON e.script_id = s.id "
            "WHERE e.status='running' ORDER BY e.started_at DESC"
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["args"] = _loads(d.get("args") or "{}", {})
            out.append(d)
        return out


# ---------- schedules（定时任务） ----------

def list_schedules(only_enabled: bool = False) -> list[dict]:
    sql = (
        "SELECT s.*, sc.name AS script_name, p.name AS preset_name FROM schedules s "
        "LEFT JOIN scripts sc ON s.script_id=sc.id "
        "LEFT JOIN presets p ON s.preset_id=p.id"
    )
    if only_enabled:
        sql += " WHERE s.enabled=1"
    sql += " ORDER BY s.id DESC"
    with _conn() as conn:
        return [dict(r) for r in conn.execute(sql).fetchall()]


def get_schedule(schedule_id: int) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM schedules WHERE id=?", (schedule_id,)).fetchone()
        return dict(row) if row else None


def add_schedule(script_id: int, name: str, cron: str, args: dict, enabled: bool = True,
                max_runs: Optional[int] = None, preset_id: Optional[int] = None,
                cmd_prefix: str = "", cmd_suffix: str = "") -> dict:
    now = now_iso()
    with _lock, _conn() as conn:
        cur = conn.execute(
            "INSERT INTO schedules(script_id, name, cron, args, preset_id, enabled, max_runs,"
            " cmd_prefix, cmd_suffix, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (script_id, name, cron, _dumps(args), preset_id, 1 if enabled else 0, max_runs,
             cmd_prefix or "", cmd_suffix or "", now, now),
        )
        return dict(conn.execute("SELECT * FROM schedules WHERE id=?", (cur.lastrowid,)).fetchone())


def update_schedule(
    schedule_id: int,
    name: Optional[str] = None,
    cron: Optional[str] = None,
    args: Optional[dict] = None,
    enabled: Optional[bool] = None,
    max_runs=_UNSET,
    preset_id=_UNSET,
    cmd_prefix=_UNSET,
    cmd_suffix=_UNSET,
) -> dict:
    fields, vals = [], []
    if name is not None:
        fields.append("name=?"); vals.append(name)
    if cron is not None:
        fields.append("cron=?"); vals.append(cron)
    if args is not None:
        fields.append("args=?"); vals.append(_dumps(args))
    if enabled is not None:
        fields.append("enabled=?"); vals.append(1 if enabled else 0)
    if max_runs is not _UNSET:
        fields.append("max_runs=?"); vals.append(max_runs)
    if preset_id is not _UNSET:
        fields.append("preset_id=?"); vals.append(preset_id)
    if cmd_prefix is not _UNSET:
        fields.append("cmd_prefix=?"); vals.append(cmd_prefix or "")
    if cmd_suffix is not _UNSET:
        fields.append("cmd_suffix=?"); vals.append(cmd_suffix or "")
    fields.append("updated_at=?"); vals.append(now_iso())
    vals.append(schedule_id)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE schedules SET {', '.join(fields)} WHERE id=?", vals)
        return dict(conn.execute("SELECT * FROM schedules WHERE id=?", (schedule_id,)).fetchone())


def delete_schedule(schedule_id: int) -> bool:
    with _lock, _conn() as conn:
        cur = conn.execute("DELETE FROM schedules WHERE id=?", (schedule_id,))
        return cur.rowcount > 0


def set_schedule_runtime(
    schedule_id: int,
    next_run: Optional[str] = None,
    last_run: Optional[str] = None,
    last_status: Optional[str] = None,
    run_count: Optional[int] = None,
    enabled: Optional[bool] = None,
    clear_next_run: bool = False,
    clear_last_status: bool = False,
) -> None:
    sets, vals = [], []
    if clear_next_run:
        sets.append("next_run=NULL")
    # 显式清空：last_status=None 的语义是「不修改」，要清空必须走这个开关
    if clear_last_status:
        sets.append("last_status=NULL")
    if next_run is not None:
        sets.append("next_run=?"); vals.append(next_run)
    if last_run is not None:
        sets.append("last_run=?"); vals.append(last_run)
    if last_status is not None:
        sets.append("last_status=?"); vals.append(last_status)
    if run_count is not None:
        sets.append("run_count=?"); vals.append(run_count)
    if enabled is not None:
        sets.append("enabled=?"); vals.append(1 if enabled else 0)
    if not sets:
        return
    vals.append(schedule_id)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE schedules SET {', '.join(sets)} WHERE id=?", vals)


# ---------- queues（运行队列） ----------

def add_queue(name: str, start_at: str, interval_seconds: int = 5,
              stop_on_error: bool = False) -> dict:
    now = now_iso()
    with _lock, _conn() as conn:
        cur = conn.execute(
            "INSERT INTO queues(name, start_at, interval_seconds, stop_on_error, status,"
            " created_at, updated_at) VALUES(?,?,?,?,'pending',?,?)",
            (name, start_at, max(0, int(interval_seconds)), 1 if stop_on_error else 0, now, now),
        )
        return dict(conn.execute("SELECT * FROM queues WHERE id=?", (cur.lastrowid,)).fetchone())


def get_queue(queue_id: int) -> Optional[dict]:
    if not queue_id:
        return None
    with _conn() as conn:
        row = conn.execute("SELECT * FROM queues WHERE id=?", (queue_id,)).fetchone()
        return dict(row) if row else None


def list_queues() -> list[dict]:
    """所有队列，带上任务总数 / 已完成数 / 失败数，供列表直接显示进度。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT q.*,"
            " (SELECT COUNT(*) FROM queue_items qi WHERE qi.queue_id=q.id) AS item_count,"
            " (SELECT COUNT(*) FROM queue_items qi WHERE qi.queue_id=q.id"
            "  AND qi.status IN ('success','failed','skipped')) AS done_count,"
            " (SELECT COUNT(*) FROM queue_items qi WHERE qi.queue_id=q.id AND qi.status='failed')"
            "  AS failed_count"
            " FROM queues q ORDER BY q.id DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def update_queue(queue_id: int, name: Optional[str] = None, start_at: Optional[str] = None,
                 interval_seconds: Optional[int] = None,
                 stop_on_error: Optional[bool] = None,
                 enabled: Optional[bool] = None) -> dict:
    fields, vals = [], []
    if name is not None:
        fields.append("name=?"); vals.append(name)
    if start_at is not None:
        fields.append("start_at=?"); vals.append(start_at)
    if interval_seconds is not None:
        fields.append("interval_seconds=?"); vals.append(max(0, int(interval_seconds)))
    if stop_on_error is not None:
        fields.append("stop_on_error=?"); vals.append(1 if stop_on_error else 0)
    if enabled is not None:
        fields.append("enabled=?"); vals.append(1 if enabled else 0)
    fields.append("updated_at=?"); vals.append(now_iso())
    vals.append(queue_id)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE queues SET {', '.join(fields)} WHERE id=?", vals)
        return dict(conn.execute("SELECT * FROM queues WHERE id=?", (queue_id,)).fetchone())


def set_queue_status(queue_id: int, status: str, next_ready_at: Optional[str] = None,
                     clear_next_ready: bool = False, started: bool = False,
                     finished: bool = False) -> None:
    sets, vals = ["status=?"], [status]
    if clear_next_ready:
        sets.append("next_ready_at=NULL")
    elif next_ready_at is not None:
        sets.append("next_ready_at=?"); vals.append(next_ready_at)
    if started:
        sets.append("started_at=?"); vals.append(now_iso())
    if finished:
        sets.append("finished_at=?"); vals.append(now_iso())
    sets.append("updated_at=?"); vals.append(now_iso())
    vals.append(queue_id)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE queues SET {', '.join(sets)} WHERE id=?", vals)


def delete_queue(queue_id: int) -> bool:
    with _lock, _conn() as conn:
        cur = conn.execute("DELETE FROM queues WHERE id=?", (queue_id,))
        return cur.rowcount > 0


def clear_queue_items(queue_id: int) -> None:
    """清空队列里的任务（队列本身留着，还能继续加任务）。"""
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM queue_items WHERE queue_id=?", (queue_id,))
        conn.execute("UPDATE queues SET status='pending', next_ready_at=NULL, started_at=NULL,"
                     " finished_at=NULL, updated_at=? WHERE id=?", (now_iso(), queue_id))


def restart_queue(queue_id: int) -> None:
    """重新启动：从头开始，按原来的开始时间再跑一遍。

    · 还没在跑的任务 → 回到「待执行」
    · 正在跑的那个 → 不打断它，跑完之后回到「待执行」（这样整条队从头再来一遍）
    · 队列本身 → 回到「等待开始」，并重新打开（关了的话重新启动当然是要跑的）
    """
    now = now_iso()
    with _lock, _conn() as conn:
        conn.execute(
            "UPDATE queue_items SET status='pending', error=NULL, exec_id=NULL, rerun=0,"
            " started_at=NULL, finished_at=NULL, updated_at=? WHERE queue_id=? AND status!='running'",
            (now, queue_id))
        conn.execute(
            "UPDATE queue_items SET rerun=1, updated_at=? WHERE queue_id=? AND status='running'",
            (now, queue_id))
        conn.execute("UPDATE queues SET status='pending', next_ready_at=NULL, started_at=NULL,"
                     " finished_at=NULL, enabled=1, updated_at=? WHERE id=?", (now, queue_id))


def reset_queue_item_to_pending(item_id: int) -> None:
    """重新启动时正在跑的任务跑完了：回到待执行，等着重头再来一遍。"""
    now = now_iso()
    with _lock, _conn() as conn:
        conn.execute(
            "UPDATE queue_items SET status='pending', error=NULL, exec_id=NULL, rerun=0,"
            " started_at=NULL, finished_at=NULL, updated_at=? WHERE id=?", (now, item_id))


# ---------- queue_items ----------

def add_queue_item(queue_id: int, script_id: int, preset_id: Optional[int] = None,
                   args: Optional[dict] = None, cmd_prefix: str = "", cmd_suffix: str = "") -> dict:
    """加入队尾（先进先出）。绑了预设就跟着预设走，没绑的存一份参数快照。"""
    now = now_iso()
    with _lock, _conn() as conn:
        row = conn.execute("SELECT COALESCE(MAX(position), -1) FROM queue_items WHERE queue_id=?",
                           (queue_id,)).fetchone()
        # 注意：0 是合法位置，不能用 `or` 判断空值（0 会被当成空）
        pos = (row[0] if row[0] is not None else -1) + 1
        cur = conn.execute(
            "INSERT INTO queue_items(queue_id, script_id, preset_id, args, cmd_prefix, cmd_suffix,"
            " position, status, created_at, updated_at)"
            " VALUES(?,?,?,?,?,?,?,'pending',?,?)",
            (queue_id, script_id, preset_id, _dumps(args or {}), cmd_prefix or "", cmd_suffix or "",
             pos, now, now))
        return dict(conn.execute("SELECT * FROM queue_items WHERE id=?", (cur.lastrowid,)).fetchone())


def get_queue_item(item_id: int) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM queue_items WHERE id=?", (item_id,)).fetchone()
        return dict(row) if row else None


def list_queue_items(queue_id: int) -> list[dict]:
    """队列里的任务（按执行顺序），带上脚本名与预设名。"""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT qi.*, sc.name AS script_name, sc.path AS script_path,"
            " p.name AS preset_name"
            " FROM queue_items qi"
            " LEFT JOIN scripts sc ON qi.script_id = sc.id"
            " LEFT JOIN presets p ON qi.preset_id = p.id"
            " WHERE qi.queue_id=? ORDER BY qi.position ASC, qi.id ASC", (queue_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def set_queue_items(queue_id: int, plan: list[dict]) -> list[dict]:
    """按前端给的清单重建队列的任务清单。

    plan 里每一项是 {item_id?, script_id, preset_id?, args?, cmd_prefix?, cmd_suffix?}：
      · 带 item_id 的沿用原来的任务（执行状态不会被重置）
      · 没带 item_id 的按「脚本 + 预设」新建
      · 清单里没有的任务移除掉
    """
    now = now_iso()
    with _lock, _conn() as conn:
        existing = {}
        for r in conn.execute("SELECT * FROM queue_items WHERE queue_id=?", (queue_id,)).fetchall():
            existing[r["id"]] = dict(r)
        by_pair = {}
        for it in existing.values():
            by_pair.setdefault((it["script_id"], it.get("preset_id")), it)
        keep: set[int] = set()
        pos = 0
        for entry in plan or []:
            item_id = entry.get("item_id")
            it = existing.get(int(item_id)) if item_id else None
            if it is None:
                # 没带 id 就按「脚本 + 预设」找一条同款任务复用（避免重复添加）
                it = by_pair.get((int(entry["script_id"]), entry.get("preset_id")))
            if it is not None:
                conn.execute(
                    "UPDATE queue_items SET position=?, script_id=?, preset_id=?, args=?,"
                    " cmd_prefix=?, cmd_suffix=?, updated_at=? WHERE id=?",
                    (pos, int(entry["script_id"]), entry.get("preset_id"),
                     _dumps(entry.get("args") or {}), entry.get("cmd_prefix") or "",
                     entry.get("cmd_suffix") or "", now, it["id"]))
                keep.add(it["id"])
            else:
                cur = conn.execute(
                    "INSERT INTO queue_items(queue_id, script_id, preset_id, args, cmd_prefix,"
                    " cmd_suffix, position, status, created_at, updated_at)"
                    " VALUES(?,?,?,?,?,?,?,'pending',?,?)",
                    (queue_id, int(entry["script_id"]), entry.get("preset_id"),
                     _dumps(entry.get("args") or {}), entry.get("cmd_prefix") or "",
                     entry.get("cmd_suffix") or "", pos, now, now))
                keep.add(cur.lastrowid)
            pos += 1
        for r in conn.execute("SELECT id FROM queue_items WHERE queue_id=?", (queue_id,)).fetchall():
            if r["id"] not in keep:
                conn.execute("DELETE FROM queue_items WHERE id=?", (r["id"],))
    return list_queue_items(queue_id)


def remove_queue_item(item_id: int) -> bool:
    with _lock, _conn() as conn:
        cur = conn.execute("DELETE FROM queue_items WHERE id=?", (item_id,))
        return cur.rowcount > 0


def move_queue_item(item_id: int, direction: str) -> bool:
    """队列内上下移动：up 往前挪一格，down 往后挪一格。"""
    with _lock, _conn() as conn:
        row = conn.execute("SELECT * FROM queue_items WHERE id=?", (item_id,)).fetchone()
        if not row:
            return False
        item = dict(row)
        if direction == "up":
            other = conn.execute(
                "SELECT * FROM queue_items WHERE queue_id=? AND position < ?"
                " ORDER BY position DESC LIMIT 1", (item["queue_id"], item["position"])).fetchone()
        else:
            other = conn.execute(
                "SELECT * FROM queue_items WHERE queue_id=? AND position > ?"
                " ORDER BY position ASC LIMIT 1", (item["queue_id"], item["position"])).fetchone()
        if not other:
            return False
        other = dict(other)
        now = now_iso()
        conn.execute("UPDATE queue_items SET position=?, updated_at=? WHERE id=?",
                     (other["position"], now, item["id"]))
        conn.execute("UPDATE queue_items SET position=?, updated_at=? WHERE id=?",
                     (item["position"], now, other["id"]))
        return True


def set_queue_item_status(item_id: int, status: str, error: Optional[str] = None,
                          exec_id: Optional[int] = None, started: bool = False,
                          finished: bool = False) -> None:
    sets, vals = ["status=?"], [status]
    if error is not None:
        sets.append("error=?"); vals.append(error)
    elif status != "failed":
        sets.append("error=NULL")
    if exec_id is not None:
        sets.append("exec_id=?"); vals.append(exec_id)
    if started:
        sets.append("started_at=?"); vals.append(now_iso())
    if finished:
        sets.append("finished_at=?"); vals.append(now_iso())
    sets.append("updated_at=?"); vals.append(now_iso())
    vals.append(item_id)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE queue_items SET {', '.join(sets)} WHERE id=?", vals)


def next_queue_item(queue_id: int) -> Optional[dict]:
    """下一个该跑的任务（先进先出：位置最小且还没跑的）。"""
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM queue_items WHERE queue_id=? AND status='pending'"
            " ORDER BY position ASC, id ASC LIMIT 1", (queue_id,)).fetchone()
        return dict(row) if row else None


def skip_pending_queue_items(queue_id: int) -> int:
    """出错停止时，把还没跑的任务标成「已跳过」。"""
    with _lock, _conn() as conn:
        cur = conn.execute(
            "UPDATE queue_items SET status='skipped', error=?, updated_at=?"
            " WHERE queue_id=? AND status='pending'", ("队列已中止", now_iso(), queue_id))
        return cur.rowcount


def recover_queues() -> int:
    """服务重启后的收尾：正在跑的那一项没人收尾了，放回「待执行」；
    队列回到「等待开始」，服务起来后接着跑（按原来的开始时间）。"""
    now = now_iso()
    with _lock, _conn() as conn:
        n = conn.execute(
            "UPDATE queue_items SET status='pending', error=NULL, exec_id=NULL,"
            " started_at=NULL, finished_at=NULL, updated_at=?"
            " WHERE status='running'", (now,)).rowcount
        conn.execute("UPDATE queues SET status='pending', next_ready_at=NULL, started_at=NULL,"
                     " updated_at=? WHERE status='running'", (now,))
        return n


# ---------- executions ----------

def add_execution(
    script_id: int | None, args: dict, preset_id: int | None = None, command: str = ""
) -> dict:
    with _lock, _conn() as conn:
        cur = conn.execute(
            "INSERT INTO executions(script_id, preset_id, args, command, status, started_at) VALUES(?,?,?,?,?,?)",
            (script_id, preset_id, _dumps(args), command, "running", now_iso()),
        )
        return dict(conn.execute("SELECT * FROM executions WHERE id=?", (cur.lastrowid,)).fetchone())


def finish_execution(exec_id: int, status: str, exit_code: int | None, output_lines: list[str],
                    ts_lines: list[str] | None = None) -> None:
    """status: success / failed / terminated。output 只保留最后 OUTPUT_KEEP_LINES 行（含对应时间戳）。"""
    kept = output_lines[-OUTPUT_KEEP_LINES:] if output_lines else []
    ts = (ts_lines or [])[-OUTPUT_KEEP_LINES:] if ts_lines else []
    with _lock, _conn() as conn:
        conn.execute(
            "UPDATE executions SET status=?, exit_code=?, output=?, output_ts=?, finished_at=? WHERE id=?",
            (status, exit_code, "\n".join(kept), "\n".join(ts), now_iso(), exec_id),
        )


def get_execution(exec_id: int) -> Optional[dict]:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM executions WHERE id=?", (exec_id,)).fetchone()
        return dict(row) if row else None


def set_execution_tab_name(exec_id: int, name: str) -> Optional[dict]:
    """重命名控制台标签页；名称存执行记录上，因此所有浏览器 / 所有页面都一致。"""
    with _lock, _conn() as conn:
        conn.execute("UPDATE executions SET tab_name=? WHERE id=?", (name.strip()[:80], exec_id))
        row = conn.execute("SELECT * FROM executions WHERE id=?", (exec_id,)).fetchone()
        return dict(row) if row else None


def list_executions(
    script_id: int | None = None,
    tag: str | None = None,
    status: str | None = None,
    limit: int = 200,
    kw: str | None = None,
) -> list[dict]:
    """执行记录列表。kw 非空时按「记录名 / 脚本名 / 标签 / 状态」过滤。

    多个关键词按空格拆开，逐个都要命中（AND），所以「1022 知识库」这种
    只给了片段的搜索也能用。搜索覆盖的是全部记录，不只是首页那 200 条。
    刻意不搜命令、参数、控制台输出：那些是执行细节，命中太多反而查不出想要的记录。
    """
    sql = "SELECT e.*, s.name AS script_name FROM executions e LEFT JOIN scripts s ON e.script_id = s.id WHERE 1=1"
    params: list = []
    if script_id is not None:
        sql += " AND e.script_id=?"
        params.append(script_id)
    if status:
        sql += " AND e.status=?"
        params.append(status)
    if tag:
        sql += " AND e.tags LIKE ?"
        params.append(f'%"{tag}"%')
    for token in [t for t in str(kw or "").lower().split() if t]:
        like = f"%{token}%"
        alias = EXEC_STATUS_ALIAS.get(token)
        if alias:
            # 状态词（成功/失败/运行中/已终止/success/failed/...）只跟「状态 / 名字 / 标签」比，
            # 不去名字之外的字段里匹配，否则「失败」会把名字里带这字的记录也捞进来
            conds = [
                "e.status = ?",                            # 状态（精确）
                "LOWER(COALESCE(e.tab_name,'')) LIKE ?",    # 记录名
                "LOWER(COALESCE(s.name,'')) LIKE ?",        # 脚本名
                "LOWER(COALESCE(e.tags,'')) LIKE ?",        # 标签
            ]
            sql += " AND (" + " OR ".join(conds) + ")"
            params.append(alias)
            params += [like] * 3
            continue
        conds = [
            "LOWER(COALESCE(e.tab_name,'')) LIKE ?",     # 记录名（控制台重命名后的名字）
            "LOWER(COALESCE(s.name,'')) LIKE ?",         # 脚本名
            "LOWER(COALESCE(e.tags,'')) LIKE ?",         # 标签
            "LOWER(COALESCE(e.status,'')) LIKE ?",       # 状态（英文，用于 fail/succ 这类片段）
        ]
        sql += " AND (" + " OR ".join(conds) + ")"
        params += [like] * len(conds)
    sql += " ORDER BY e.started_at DESC LIMIT ?"
    params.append(limit)
    with _conn() as conn:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


def set_execution_tags(exec_id: int, tags: Iterable[str]) -> None:
    with _lock, _conn() as conn:
        conn.execute("UPDATE executions SET tags=? WHERE id=?", (_dumps(list(tags)), exec_id))


def delete_execution(exec_id: int) -> bool:
    with _lock, _conn() as conn:
        cur = conn.execute("DELETE FROM executions WHERE id=?", (exec_id,))
        return cur.rowcount > 0


def delete_executions(ids: list[int]) -> tuple[int, list[int]]:
    """批量删除执行记录；返回 (删除数, 跳过的 running 记录 id 列表)。"""
    ids = [int(i) for i in ids if str(i).strip().isdigit()]
    if not ids:
        return 0, []
    placeholders = ",".join("?" * len(ids))
    with _lock, _conn() as conn:
        running = [
            r["id"] for r in conn.execute(
                f"SELECT id FROM executions WHERE id IN ({placeholders}) AND status='running'", ids
            ).fetchall()
        ]
        del_ids = [i for i in ids if i not in running]
        if not del_ids:
            return 0, running
        dph = ",".join("?" * len(del_ids))
        cur = conn.execute(f"DELETE FROM executions WHERE id IN ({dph})", del_ids)
        return cur.rowcount, running


def clear_executions(script_id: int | None = None) -> int:
    with _lock, _conn() as conn:
        if script_id is None:
            cur = conn.execute("DELETE FROM executions")
        else:
            cur = conn.execute("DELETE FROM executions WHERE script_id=?", (script_id,))
        return cur.rowcount


# ---------- folders ----------

def create_folder(name: str) -> Optional[dict]:
    name = name.strip()
    if not name:
        return None
    ts = now_iso()
    with _lock, _conn() as conn:
        existing = conn.execute("SELECT * FROM folders WHERE name=?", (name,)).fetchone()
        if existing:
            return dict(existing)
        cur = conn.execute("INSERT INTO folders(name, created_at) VALUES(?,?)", (name, ts))
        return dict(conn.execute("SELECT * FROM folders WHERE id=?", (cur.lastrowid,)).fetchone())


def list_folders() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM folders ORDER BY name COLLATE NOCASE").fetchall()
        return [dict(r) for r in rows]


def delete_folder(folder_id: int) -> bool:
    with _lock, _conn() as conn:
        conn.execute("UPDATE scripts SET folder_id=NULL WHERE folder_id=?", (folder_id,))
        cur = conn.execute("DELETE FROM folders WHERE id=?", (folder_id,))
        return cur.rowcount > 0


def move_script(script_id: int, folder_id: int | None) -> bool:
    with _lock, _conn() as conn:
        cur = conn.execute("UPDATE scripts SET folder_id=? WHERE id=?", (folder_id, script_id))
        return cur.rowcount > 0


# ---------- 导出 / 导入（版本迁移） ----------

def export_all() -> dict:
    """导出脚本、文件夹、预设（不含执行历史）。"""
    with _conn() as conn:
        folders = [dict(r) for r in conn.execute("SELECT id, name FROM folders").fetchall()]
        scripts = []
        for row in conn.execute("SELECT * FROM scripts").fetchall():
            s = dict(row)
            presets = [dict(r) for r in conn.execute(
                "SELECT name, args, pinned, sort_order, last_used_at, cmd_prefix, cmd_suffix "
                "FROM presets WHERE script_id=?", (s["id"],)
            ).fetchall()]
            scripts.append({
                "name": s["name"],
                "path": s["path"],
                "description": s.get("description") or "",
                "deps_path": s.get("deps_path") or "",
                "tags": _loads(s.get("tags") or "[]", []),
                "args_schema": _loads(s.get("args_schema") or "[]", []),
                "auto_saved_args": _loads(s.get("auto_saved_args") or "{}", {}),
                "presets": presets,
            })
        return {"version": 1, "folders": [f["name"] for f in folders], "scripts": scripts}


def import_all(data: dict) -> dict:
    """导入导出数据。以脚本 path 为唯一键，已存在则更新，预设同名跳过。"""
    imported, updated, skipped = 0, 0, []
    with _lock, _conn() as conn:
        # 文件夹功能已废弃，导入时忽略 folders 字段
        ts = now_iso()
        for sc in data.get("scripts", []):
            path = sc.get("path", "")
            name = sc.get("name") or "unnamed"
            schema = sc.get("args_schema") or []
            desc = sc.get("description") or ""
            deps = sc.get("deps_path") or ""
            tags = _dumps([str(t) for t in (sc.get("tags") or []) if str(t).strip()])
            try:
                existing = conn.execute("SELECT id FROM scripts WHERE path=?", (path,)).fetchone()
                if existing:
                    sid = existing["id"]
                    conn.execute(
                        "UPDATE scripts SET name=?, args_schema=?, description=?, deps_path=?, tags=?, folder_id=NULL, updated_at=? WHERE id=?",
                        (name, _dumps(schema), desc, deps, tags, ts, sid),
                    )
                    updated += 1
                else:
                    cur = conn.execute(
                        "INSERT INTO scripts(name, path, args_schema, auto_saved_args, description, deps_path, tags, folder_id, created_at, updated_at) "
                        "VALUES(?,?,?,?,?,?,?,NULL,?,?)",
                        (name, path, _dumps(schema), _dumps(sc.get("auto_saved_args") or {}),
                         desc, deps, tags, ts, ts),
                    )
                    sid = cur.lastrowid
                    imported += 1
                # 预设：同名跳过
                for p in sc.get("presets", []):
                    pname = p.get("name", "")
                    if not pname:
                        continue
                    dup = conn.execute(
                        "SELECT id FROM presets WHERE script_id=? AND name=?", (sid, pname)
                    ).fetchone()
                    if not dup:
                        conn.execute(
                            "INSERT INTO presets(script_id, name, args, created_at, pinned, sort_order, last_used_at, cmd_prefix, cmd_suffix) "
                            "VALUES(?,?,?,?,?,?,?,?,?)",
                            (sid, pname, _dumps(p.get("args") or {}), ts,
                             1 if p.get("pinned") else 0,
                             int(p.get("sort_order") or 0),
                             p.get("last_used_at") or None,
                             p.get("cmd_prefix") or "", p.get("cmd_suffix") or ""),
                        )
            except Exception as e:  # noqa: BLE001
                skipped.append({"path": path, "error": str(e)})
        return {"imported": imported, "updated": updated, "skipped": skipped}


# ---------- meta ----------

def meta_get(key: str, default: str | None = None) -> Optional[str]:
    with _conn() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


def meta_set(key: str, value: str) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def meta_list() -> dict:
    with _conn() as conn:
        rows = conn.execute("SELECT key, value FROM meta").fetchall()
        return {r["key"]: r["value"] for r in rows}
