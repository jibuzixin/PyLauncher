"""端到端验证：定时任务执行期间显示「运行中」，跑完达到上限才变「暂停」。

流程：
1. 起一个临时实例（独立库、独立端口）
2. 塞一个会跑 3 秒的脚本，max_runs=1 的定时任务
3. 触发后立刻查：last_status 应该是 running、enabled 应该是 1
4. 等脚本跑完再查：enabled 应该是 0、last_status 是「已达执行上限 1 次，已自动停用（最后一次：success）」

跑法：.venv/bin/python tests_e2e_sched_running.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("E2E_PORT", "8907"))
BASE = f"http://127.0.0.1:{PORT}"


def api(path, body=None, method=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method or ("POST" if body is not None else "GET"),
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="lv2_e2e_sched_")
    try:
        for f in ("main.py", "db.py", "executor.py", "scanner.py"):
            shutil.copy(os.path.join(ROOT, f), tmp)
        shutil.copytree(os.path.join(ROOT, "static"), os.path.join(tmp, "static"))
        sys.path.insert(0, ROOT)
        import db  # noqa: E402

        # 一个跑 3 秒的脚本：够长，能观察「运行中」状态
        script = os.path.join(tmp, "slow.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write("import time\nprint('working...')\ntime.sleep(3)\nprint('done')\n")

        # 直接往临时库里塞脚本记录（临时实例的库就在 tmp 下）
        import sqlite3
        db_path = os.path.join(tmp, "launcher.db")
        # 先建表：直接用临时实例自己的 db 模块初始化
        subprocess.run([sys.executable, "-c",
                        "import db; db.init_db()"], cwd=tmp, check=True,
                       env=dict(os.environ, PYTHONPATH=tmp))
        conn = sqlite3.connect(db_path)
        now = db.now_iso()
        cur = conn.execute(
            "INSERT INTO scripts (name, path, args_schema, auto_saved_args, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?)",
            ("slow.py", script, "[]", "{}", now, now))
        sid = cur.lastrowid
        conn.commit()
        conn.close()

        env = dict(os.environ, LAUNCHER_PORT=str(PORT))
        proc = subprocess.Popen([sys.executable, "main.py", "--no-browser"],
                                cwd=tmp, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            # 等服务起来
            for _ in range(60):
                try:
                    api("/api/schedules")
                    break
                except Exception:  # noqa: BLE001
                    time.sleep(0.3)
            else:
                print("FAIL: 服务没起来")
                return 1

            # 建定时任务（max_runs=1：只执行一次）
            created = api("/api/schedules", {
                "script_id": sid, "name": "e2e一次性任务", "cron": "*/10 * * * *",
                "args": {}, "enabled": True, "max_runs": 1,
            })
            sch = created["schedule"]
            print(f"已创建定时任务 #{sch['id']}（max_runs=1）")

            # 触发
            api(f"/api/schedules/{sch['id']}/run", {}, "POST")
            time.sleep(0.8)

            during = api("/api/schedules")[0]
            print(f"执行期间：enabled={during['enabled']} "
                  f"last_status={during['last_status']!r} run_count={during['run_count']}")
            ok1 = during["last_status"] == "running" and during["enabled"] == 1
            print(f"  {'PASS' if ok1 else 'FAIL'}  执行期间应为 running 且仍启用")

            # 等脚本跑完
            time.sleep(5)
            after = api("/api/schedules")[0]
            print(f"执行结束：enabled={after['enabled']} "
                  f"last_status={after['last_status']!r} run_count={after['run_count']}")
            ok2 = (after["enabled"] == 0
                   and "已达执行上限 1 次" in (after["last_status"] or "")
                   and "最后一次：success" in (after["last_status"] or ""))
            print(f"  {'PASS' if ok2 else 'FAIL'}  执行结束达到上限应停用并写上限提示")

            # 不该被自动触发第二次
            time.sleep(1)
            again = api("/api/schedules")[0]
            ok3 = again["run_count"] == 1
            print(f"  {'PASS' if ok3 else 'FAIL'}  达到上限后不该再被触发（run_count 仍为 1，实际 {again['run_count']}）")

            return 0 if (ok1 and ok2 and ok3) else 1
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
