"""端到端验证：预设里的「参数 + 命令前后缀」能落到定时任务执行上。

流程：
1. 起一个临时实例（独立库、独立端口）
2. 塞一个会打印东西的脚本
3. 建一个预设（带参数 + 前缀 + 后缀），再建一个绑定该预设的定时任务
4. 触发定时任务，检查执行记录里：
   - 用的是预设里的参数
   - 命令里带上了预设的前缀与后缀（后缀用 shell 语法，能在输出里看见）
   - 定时任务自己存的字段也确实落库了

跑法：.venv/bin/python tests_e2e_preset_cmdparts.py
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
PORT = int(os.environ.get("E2E_PORT", "8908"))
BASE = f"http://127.0.0.1:{PORT}"


def api(path, body=None, method=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method=method or ("POST" if body is not None else "GET"),
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read())


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="lv2_e2e_cmdparts_")
    try:
        for f in ("main.py", "db.py", "executor.py", "scanner.py"):
            shutil.copy(os.path.join(ROOT, f), tmp)
        shutil.copytree(os.path.join(ROOT, "static"), os.path.join(tmp, "static"))
        sys.path.insert(0, ROOT)
        import db  # noqa: E402

        script = os.path.join(tmp, "hello.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write("print('HELLO_FROM_SCRIPT')\n")

        import sqlite3
        db_path = os.path.join(tmp, "launcher.db")
        subprocess.run([sys.executable, "-c", "import db; db.init_db()"], cwd=tmp, check=True,
                       env=dict(os.environ, PYTHONPATH=tmp))
        conn = sqlite3.connect(db_path)
        now = db.now_iso()
        schema = json.dumps([{"dest": "url", "name": "--url", "kind": "optional",
                              "action": "store", "type": "str"}])
        cur = conn.execute(
            "INSERT INTO scripts (name, path, args_schema, auto_saved_args, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?)",
            ("hello.py", script, schema, "{}", now, now))
        sid = cur.lastrowid
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

            # 1) 预设：参数 + 前后缀一起存
            preset = api(f"/api/scripts/{sid}/presets", {
                "name": "带前后缀的预设",
                "args": {"url": "https://example.com"},
                "cmd_prefix": "E2E_MARKER=1",
                "cmd_suffix": "; echo SUFFIX_APPLIED",
            })["preset"]

            print(f"预设 #{preset['id']}：cmd_prefix={preset['cmd_prefix']!r} "
                  f"cmd_suffix={preset['cmd_suffix']!r}")
            ok1 = preset["cmd_prefix"] == "E2E_MARKER=1" and preset["cmd_suffix"] == "; echo SUFFIX_APPLIED"
            print(f"  {'PASS' if ok1 else 'FAIL'}  预设把参数与命令前后缀一起存下来了")
            ok = ok and ok1

            # 2) 定时任务：绑定预设 + 自带一份前后缀
            created = api("/api/schedules", {
                "script_id": sid, "name": "e2e带前后缀任务", "cron": "*/10 * * * *",
                "args": {"url": "手动值"}, "enabled": True, "max_runs": 1,
                "preset_id": preset["id"],
                "cmd_prefix": "OWN_PREFIX", "cmd_suffix": "OWN_SUFFIX",
            })["schedule"]
            ok2 = created["cmd_prefix"] == "OWN_PREFIX" and created["cmd_suffix"] == "OWN_SUFFIX"
            print(f"  {'PASS' if ok2 else 'FAIL'}  定时任务自己的前后缀也落库了")
            ok = ok and ok2

            # 3) 执行：应该用预设里的参数 + 预设里的前后缀
            api(f"/api/schedules/{created['id']}/run", {}, "POST")
            time.sleep(3)
            execs = api(f"/api/executions?script_id={sid}")
            if not execs:
                print("FAIL: 没有执行记录")
                return 1
            ex = api(f"/api/executions/{execs[0]['id']}")
            out = ex.get("output") or ""
            # 详情接口会用「按参数重新生成的命令」覆盖 command 字段，
            # 所以这里直接查临时库，看真正执行时落库的那条命令
            conn = sqlite3.connect(db_path)
            row = conn.execute("SELECT command, status, args FROM executions WHERE id=?",
                               (execs[0]["id"],)).fetchone()
            conn.close()
            cmd = row[0] or ""
            print(f"执行记录：args={ex.get('args')} status={row[1]}")
            print(f"  落库的命令：{cmd}")
            print(f"  输出片段：{out.strip()[:200]}")

            ok3 = ex.get("args", {}).get("url") == "https://example.com"
            print(f"  {'PASS' if ok3 else 'FAIL'}  执行时用的是预设里的参数")
            ok = ok and ok3

            ok4 = "SUFFIX_APPLIED" in out
            print(f"  {'PASS' if ok4 else 'FAIL'}  执行时用上了预设里的后缀")
            ok = ok and ok4

            ok5 = "E2E_MARKER=1" in cmd
            print(f"  {'PASS' if ok5 else 'FAIL'}  执行记录里能看到预设里的前缀")
            ok = ok and ok5

            ok6 = "OWN_PREFIX" not in cmd
            print(f"  {'PASS' if ok6 else 'FAIL'}  绑了预设就不该再用任务自己那份前缀")
            ok = ok and ok6

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
