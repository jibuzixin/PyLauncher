"""执行记录「清理 30 天前」端到端测试（临时实例，不碰真实库）。

流程：
1. 起临时实例（独立目录 + 独立端口 + 独立库）
2. 造几条记录：40 天前、10 天前、40 天前且 running
3. 调 preview → 校验数量，且记录还在
4. 调 purge-old → 校验真删（库里查不到了）、30 天内的保留、running 跳过
5. 校验列表接口里也看不到被删的记录

跑法：.venv/bin/python tests_e2e_exec_purge.py
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PURGE_PORT", "8914"))
BASE = f"http://127.0.0.1:{PORT}"

OK = True


def check(label, cond, extra=""):
    global OK
    OK = OK and bool(cond)
    print(f"  {'PASS' if cond else 'FAIL'}  {label} {extra}")


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read())


def post(path, payload):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    tmp = tempfile.mkdtemp(prefix="lv2_purge_")
    for f in ("main.py", "db.py", "executor.py", "scanner.py"):
        shutil.copy(os.path.join(ROOT, f), tmp)
    shutil.copytree(os.path.join(ROOT, "static"), os.path.join(tmp, "static"))
    subprocess.run([sys.executable, "-c", "import db; db.init_db()"], cwd=tmp, check=True,
                   env=dict(os.environ, PYTHONPATH=tmp))

    now = datetime.now(timezone.utc)
    old_iso = (now - timedelta(days=40)).astimezone().isoformat(timespec="seconds")
    mid_iso = (now - timedelta(days=10)).astimezone().isoformat(timespec="seconds")

    conn = sqlite3.connect(os.path.join(tmp, "launcher.db"))
    conn.execute(
        "INSERT INTO scripts (name, path, args_schema, auto_saved_args, created_at, updated_at)"
        " VALUES ('老脚本.py','/tmp/a.py','[]','{}',?,?)", (old_iso, old_iso))
    conn.commit()
    conn.close()

    env = dict(os.environ, LAUNCHER_PORT=str(PORT))
    proc = subprocess.Popen([sys.executable, "main.py", "--no-browser"], cwd=tmp, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(80):
            try:
                get("/api/scripts")
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.3)
        else:
            raise RuntimeError("临时实例没起来")

        # 造记录：老 + 中 + 老且运行中
        conn = sqlite3.connect(os.path.join(tmp, "launcher.db"))
        conn.execute("INSERT INTO executions (script_id,args,command,status,started_at,finished_at)"
                     " VALUES (1,'{}','old','success',?,?)", (old_iso, old_iso))
        old_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute("INSERT INTO executions (script_id,args,command,status,started_at,finished_at)"
                     " VALUES (1,'{}','mid','success',?,?)", (mid_iso, mid_iso))
        mid_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute("INSERT INTO executions (script_id,args,command,status,started_at)"
                     " VALUES (1,'{}','run','running',?)", (old_iso,))
        run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        conn.close()

        # preview
        pv = get("/api/executions/purge-old/preview?days=30")
        check("preview 报出会删 1 条（running 的单独算）", pv["would_delete"] == 1, str(pv))
        check("preview 报出跳过 1 条 running", pv["skipped_running"] == 1, str(pv))
        check("preview 不真删（记录还在）", len(get("/api/executions?limit=100")) == 3)

        # 真删
        r = post("/api/executions/purge-old", {"days": 30})
        check("purge 删了 1 条（40天前且非 running）", r["deleted"] == 1, str(r))
        check("purge 跳过 1 条 running", r["skipped_running"] == 1, str(r))

        rows = get("/api/executions?limit=100")
        ids = [x["id"] for x in rows]
        check("列表里只剩 30 天内那条 + running 那条", ids == [mid_id, run_id], str(ids))
        check("30 天内的记录保留", mid_id in ids)
        check("老的记录已消失", old_id not in ids)

        # 库里也查不到 → 真删，不是软标记
        conn = sqlite3.connect(os.path.join(tmp, "launcher.db"))
        left = conn.execute("SELECT id FROM executions").fetchall()
        conn.close()
        check("数据库里真的没有老记录了（不是假性删除）",
              sorted(x[0] for x in left) == sorted([mid_id, run_id]), str(left))

        # 再删一次没得删
        r2 = post("/api/executions/purge-old", {"days": 30})
        check("重复清理不会误删运行中的记录", r2["deleted"] == 0 and r2["skipped_running"] == 1, str(r2))

        # 保留天数可调：7 天
        r3 = post("/api/executions/purge-old", {"days": 7})
        check("days=7 也能用（删掉 10 天前那条）", r3["deleted"] == 1, str(r3))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n全部通过" if OK else "\n有失败项")
    return 0 if OK else 1


if __name__ == "__main__":
    sys.exit(main())
