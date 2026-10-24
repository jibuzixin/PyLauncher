"""端到端验证：运行队列按先进先出串行执行，前一个失败不影响后一个。

流程：
1. 起一个临时实例（独立库、独立端口）
2. 塞三个脚本：正常、失败、正常；各建一个定时任务
3. 建队列：开始时间 = 现在 + 2 秒，间隔 1 秒，异常跳过继续
   → 期望：三个都跑过，第二个 failed，第三个照样成功，队列 done
4. 再建一个队列：异常就停止
   → 期望：第二个 failed，第三个 skipped，队列 stopped

跑法：.venv/bin/python tests_e2e_queue.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("E2E_PORT", "8909"))
BASE = f"http://127.0.0.1:{PORT}"


def api(path, body=None, method=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method or ("POST" if body is not None else "GET"),
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def wait_queue_done(qid, timeout=90):
    """等队列跑到终态（done / stopped）。"""
    end = time.time() + timeout
    while time.time() < end:
        q = api(f"/api/queues/{qid}")
        if q.get("status") in ("done", "stopped"):
            return q
        time.sleep(1)
    return api(f"/api/queues/{qid}")


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="lv2_e2e_queue_")
    try:
        for f in ("main.py", "db.py", "executor.py", "scanner.py"):
            shutil.copy(os.path.join(ROOT, f), tmp)
        shutil.copytree(os.path.join(ROOT, "static"), os.path.join(tmp, "static"))
        sys.path.insert(0, ROOT)
        import db  # noqa: E402

        # 三个脚本：正常（慢一点，便于观察串行）、失败、正常
        with open(os.path.join(tmp, "ok1.py"), "w", encoding="utf-8") as fh:
            fh.write("import time\nprint('OK1_START')\ntime.sleep(2)\nprint('OK1_END')\n")
        with open(os.path.join(tmp, "bad.py"), "w", encoding="utf-8") as fh:
            fh.write("import sys\nprint('BAD_FAIL')\nsys.exit(1)\n")
        with open(os.path.join(tmp, "ok2.py"), "w", encoding="utf-8") as fh:
            fh.write("print('OK2_DONE')\n")

        import sqlite3
        db_path = os.path.join(tmp, "launcher.db")
        subprocess.run([sys.executable, "-c", "import db; db.init_db()"], cwd=tmp, check=True,
                       env=dict(os.environ, PYTHONPATH=tmp))
        conn = sqlite3.connect(db_path)
        now = db.now_iso()
        sids = []
        for nm in ("ok1.py", "bad.py", "ok2.py"):
            cur = conn.execute(
                "INSERT INTO scripts (name, path, args_schema, auto_saved_args, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?)",
                (nm, os.path.join(tmp, nm), "[]", "{}", now, now))
            sids.append(cur.lastrowid)
        sch_ids = []
        for nm, sid in zip(("正常1", "会失败", "正常2"), sids):
            cur = conn.execute(
                "INSERT INTO schedules (script_id, name, cron, args, enabled, created_at, updated_at)"
                " VALUES (?,?,?,?,1,?,?)", (sid, nm, "0 0 1 1 *", "{}", now, now))
            sch_ids.append(cur.lastrowid)
        conn.commit()
        conn.close()

        env = dict(os.environ, LAUNCHER_PORT=str(PORT))
        proc = subprocess.Popen([sys.executable, "main.py", "--no-browser"],
                                cwd=tmp, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(80):
                try:
                    api("/api/schedules")
                    break
                except Exception:  # noqa: BLE001
                    time.sleep(0.3)
            else:
                print("FAIL: 服务没起来")
                return 1

            ok = True
            start_at = (datetime.now().astimezone() + timedelta(seconds=2)).isoformat(timespec="seconds")

            # ---- 场景一：出错跳过，继续跑下一个 ----
            q = api("/api/queues", {
                "name": "跳过继续", "start_at": start_at, "interval_seconds": 1,
                "stop_on_error": False, "schedule_ids": sch_ids,
            })["queue"]
            print(f"已建队列 #{q['id']}（出错跳过继续），任务 {len(q['items'])} 个")
            done = wait_queue_done(q["id"])
            items = done["items"]
            print(f"  队列状态={done['status']}  任务状态={[i['status'] for i in items]}")
            r1 = [i["status"] for i in items] == ["success", "failed", "success"]
            print(f"  {'PASS' if r1 else 'FAIL'}  按顺序跑完三个，中间失败不影响后面")
            ok = ok and r1
            r2 = done["status"] == "done"
            print(f"  {'PASS' if r2 else 'FAIL'}  全部跑完后队列标记为已完成")
            ok = ok and r2

            # 串行：第一个任务结束时间不应晚于第二个开始时间
            r3 = True
            prev_finish = None
            for it in items:
                if prev_finish and it["started_at"] and it["started_at"] < prev_finish:
                    r3 = False
                prev_finish = it["finished_at"]
            print(f"  {'PASS' if r3 else 'FAIL'}  串行执行：后一个在前一个结束之后才开始")
            ok = ok and r3

            # ---- 场景二：出错就停下 ----
            start_at2 = (datetime.now().astimezone() + timedelta(seconds=2)).isoformat(timespec="seconds")
            q2 = api("/api/queues", {
                "name": "出错停止", "start_at": start_at2, "interval_seconds": 1,
                "stop_on_error": True, "schedule_ids": sch_ids,
            })["queue"]
            done2 = wait_queue_done(q2["id"])
            items2 = done2["items"]
            print(f"  队列状态={done2['status']}  任务状态={[i['status'] for i in items2]}")
            r4 = [i["status"] for i in items2] == ["success", "failed", "skipped"]
            print(f"  {'PASS' if r4 else 'FAIL'}  出错就停下：后面的任务不再执行")
            ok = ok and r4
            r5 = done2["status"] == "stopped"
            print(f"  {'PASS' if r5 else 'FAIL'}  队列标记为已中止")
            ok = ok and r5

            # ---- 场景三：清空 / 重启 / 删除 ----
            api(f"/api/queues/{q2['id']}/clear", {})
            after = api(f"/api/queues/{q2['id']}")
            r6 = len(after["items"]) == 0 and after["status"] == "pending"
            print(f"  {'PASS' if r6 else 'FAIL'}  清空后任务清空、队列回到等待开始")
            ok = ok and r6

            api(f"/api/queues/{q['id']}/restart", {})
            after2 = api(f"/api/queues/{q['id']}")
            r7 = after2["status"] == "pending" and all(i["status"] == "pending" for i in after2["items"])
            print(f"  {'PASS' if r7 else 'FAIL'}  重新启动后所有任务回到待执行")
            ok = ok and r7

            api(f"/api/queues/{q['id']}", None, "DELETE")
            left = [x for x in api("/api/queues") if x["id"] == q["id"]]
            r8 = not left
            print(f"  {'PASS' if r8 else 'FAIL'}  删除队列")
            ok = ok and r8

            return 0 if ok else 1
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                proc.kill()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
