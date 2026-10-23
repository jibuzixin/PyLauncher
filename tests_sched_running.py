"""定时任务的状态时机：执行期间显示「运行中」，跑完达到上限才显示「暂停」。

背景：原来的 _fire_schedule 在任务刚触发、脚本还没跑完的时候，
就把 enabled=False 和「已达执行上限」写进库了，卡片于是显示「暂停」。
现在改成：触发时只记 running，执行结束（_sched_finish）才收尾。

跑法：.venv/bin/python -m unittest tests_sched_running
"""
import asyncio
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db  # noqa: E402


class SchedRunningStatusTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self._old_db_path = db._DB_PATH
        db._DB_PATH = os.path.join(self.tmpdir.name, "test_launcher.db")
        db.init_db()
        now = db.now_iso()
        with db._conn() as conn:
            cur = conn.execute(
                "INSERT INTO scripts (name, path, args_schema, auto_saved_args, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?)",
                ("demo.py", "/tmp/demo.py", "[]", "{}", now, now))
            self.script_id = cur.lastrowid

    def tearDown(self):
        db._DB_PATH = self._old_db_path
        self.tmpdir.cleanup()

    def _add(self, enabled=1, max_runs=1, run_count=0, last_status=None):
        with db._conn() as conn:
            cur = conn.execute(
                "INSERT INTO schedules (script_id, name, cron, args, enabled, max_runs, run_count,"
                " next_run, last_run, last_status, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (self.script_id, "测试", "*/10 * * * *", "{}", enabled, max_runs, run_count,
                 "2026-10-24T06:00:00+08:00", "2026-10-23T06:00:00+08:00", last_status,
                 db.now_iso(), db.now_iso()))
            return cur.lastrowid

    # ---------- 执行结束时的收尾 ----------

    def test_finish_reaches_limit_disables_task(self):
        """次数用满：执行结束后才停用，并留下上限提示。"""
        import main
        sid = self._add(max_runs=1, run_count=1)
        main._sched_finish(sid, "success")
        row = db.get_schedule(sid)
        self.assertEqual(row["enabled"], 0)
        self.assertIn("已达执行上限 1 次", row["last_status"])
        self.assertIn("最后一次：success", row["last_status"])

    def test_finish_below_limit_keeps_enabled(self):
        """次数没满：只写终态，任务继续启用。"""
        import main
        sid = self._add(max_runs=3, run_count=1)
        main._sched_finish(sid, "failed")
        row = db.get_schedule(sid)
        self.assertEqual(row["enabled"], 1)
        self.assertEqual(row["last_status"], "failed")

    def test_finish_without_limit_keeps_enabled(self):
        """不限次数：只写终态。"""
        import main
        sid = self._add(max_runs=None, run_count=7)
        main._sched_finish(sid, "success")
        row = db.get_schedule(sid)
        self.assertEqual(row["enabled"], 1)
        self.assertEqual(row["last_status"], "success")

    # ---------- 执行期间的状态 ----------

    def test_running_state_is_kept_during_execution(self):
        """执行期间：last_status 是 running、任务仍是启用状态。"""
        sid = self._add(enabled=1, max_runs=1, run_count=1)
        db.set_schedule_runtime(sid, last_status="running")
        row = db.get_schedule(sid)
        self.assertEqual(row["last_status"], "running")
        self.assertEqual(row["enabled"], 1)

    def test_running_counter_guard(self):
        """同一个任务没跑完时，调度器不再重复触发。"""
        import main
        sid = self._add()
        self.assertEqual(main._sched_running_count(sid), 0)
        main._sched_begin(sid)
        self.assertEqual(main._sched_running_count(sid), 1)
        main._sched_begin(sid)
        self.assertEqual(main._sched_running_count(sid), 2)
        main._sched_end(sid)
        self.assertEqual(main._sched_running_count(sid), 1)
        main._sched_end(sid)
        self.assertEqual(main._sched_running_count(sid), 0)

    # ---------- 服务重启后的清理 ----------

    def test_startup_clears_stale_running(self):
        """服务重启：卡在 running 的定时任务要收尾成 failed，不能永远显示「运行中」。"""
        sid = self._add(enabled=1, max_runs=1, run_count=1, last_status="running")
        n = db.mark_stale_sched_running()
        self.assertEqual(n, 1)
        row = db.get_schedule(sid)
        self.assertEqual(row["last_status"], "failed")
        self.assertNotEqual(row["last_status"], "running")

    def test_startup_cleanup_leaves_normal_rows(self):
        """正常终态的任务不受影响。"""
        sid = self._add(enabled=0, max_runs=1, run_count=1, last_status="success")
        db.mark_stale_sched_running()
        self.assertEqual(db.get_schedule(sid)["last_status"], "success")


if __name__ == "__main__":
    unittest.main()
