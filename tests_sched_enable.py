"""启用定时任务后，旧的 last_status 必须被清掉。

背景：db.set_schedule_runtime 的 last_status=None 语义是「不修改」，
之前 _refresh_schedule_plan 想清空旧状态却一直传 None，
导致重新启用的任务还带着「已达执行上限，已自动停用」的旧文案，
前端据此把刚启用的任务显示成「暂停」。

跑法：.venv/bin/python -m unittest tests_sched_enable
"""
import asyncio
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db  # noqa: E402


class SchedEnableStatusTest(unittest.TestCase):
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

    def _add(self, enabled=0, last_status="已达执行上限 1 次，已自动停用（最后一次：success）", max_runs=1):
        with db._conn() as conn:
            cur = conn.execute(
                "INSERT INTO schedules (script_id, name, cron, args, enabled, max_runs, run_count,"
                " next_run, last_run, last_status, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (self.script_id, "测试", "*/10 * * * *", "{}", enabled, max_runs, 1,
                 "2026-10-24T06:00:00+08:00", "2026-10-14T15:14:11+08:00", last_status,
                 db.now_iso(), db.now_iso()))
            return cur.lastrowid

    def test_set_runtime_none_means_no_change(self):
        """last_status=None 不能当成「清空」，否则改计划会误伤历史状态。"""
        sid = self._add()
        db.set_schedule_runtime(sid, last_status=None)
        self.assertEqual(db.get_schedule(sid)["last_status"], "已达执行上限 1 次，已自动停用（最后一次：success）")

    def test_set_runtime_clear_flag(self):
        """显式开关才能清空。"""
        sid = self._add()
        db.set_schedule_runtime(sid, clear_last_status=True)
        self.assertIsNone(db.get_schedule(sid)["last_status"])

    def test_refresh_plan_clears_last_status(self):
        """重排计划（启用 / 改 cron）后旧状态必须清掉。"""
        import main
        sid = self._add()
        main._refresh_schedule_plan(sid, "*/10 * * * *", True)
        row = db.get_schedule(sid)
        self.assertIsNone(row["last_status"])
        self.assertIsNotNone(row["next_run"])

    def test_enable_api_clears_last_status(self):
        """走真实接口：启用一个到过上限的任务，last_status 要被清空。"""
        import main
        sid = self._add(enabled=0)
        resp = asyncio.run(main.update_schedule_api(sid, main.ScheduleUpdateReq(enabled=True)))
        row = db.get_schedule(resp["schedule"]["id"])
        self.assertEqual(row["enabled"], 1)
        self.assertIsNone(row["last_status"])
        # 重新启用时执行次数从头开始
        self.assertEqual(row["run_count"], 0)


if __name__ == "__main__":
    unittest.main()
