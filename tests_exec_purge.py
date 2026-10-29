"""执行记录按时间清理（永久删除 30 天前的记录）。

要点：
- 真 DELETE，不做假性删除（库里不留软标记，删完就没了）
- 只删 started_at 早于截止时刻的，30 天内的保留
- running 的记录自动跳过（别把正在跑的任务连输出一起抹掉）
- started_at 是带时区偏移的 ISO，跨偏移量比较必须用 julianday，不能字符串比

跑法：.venv/bin/python -m unittest tests_exec_purge
"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db  # noqa: E402


def iso(dt):
    return dt.astimezone().isoformat(timespec="seconds")


class ExecPurgeTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self._old_db_path = db._DB_PATH
        db._DB_PATH = os.path.join(self.tmpdir.name, "test_launcher.db")
        db.init_db()
        now = db.now_iso()
        with db._conn() as conn:
            cur = conn.execute(
                "INSERT INTO scripts (name, path, args_schema, auto_saved_args, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?)", ("老脚本.py", "/tmp/a.py", "[]", "{}", now, now))
            self.sid = cur.lastrowid
        self.now = datetime.now(timezone.utc)

    def tearDown(self):
        db._DB_PATH = self._old_db_path
        self.tmpdir.cleanup()

    def _add(self, days_ago, status="success", name=""):
        """造一条 started_at 在 days_ago 天前的记录。"""
        started = iso(self.now - timedelta(days=days_ago))
        with db._conn() as conn:
            cur = conn.execute(
                "INSERT INTO executions (script_id, args, command, status, started_at, finished_at)"
                " VALUES (?,?,?,?,?,?)",
                (self.sid, "{}", "uv run a.py", status, started, started))
            eid = cur.lastrowid
        if name:
            db.set_execution_tab_name(eid, name)
        return eid

    def _count(self):
        with db._conn() as conn:
            return conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0]

    def _cutoff(self, days=30):
        return iso(self.now - timedelta(days=days))

    def test_deletes_only_old_records(self):
        old = self._add(40)
        recent = self._add(10)
        edge = self._add(29)
        deleted, running = db.purge_executions_before(self._cutoff())
        self.assertEqual(deleted, 1)
        self.assertEqual(running, 0)
        self.assertEqual(self._count(), 2)
        with db._conn() as conn:
            ids = [r[0] for r in conn.execute("SELECT id FROM executions").fetchall()]
        self.assertNotIn(old, ids)
        self.assertIn(recent, ids)
        self.assertIn(edge, ids)

    def test_really_deleted_not_soft(self):
        """必须是真删：库里不能留下软标记的行，接口也查不出来"""
        eid = self._add(40)
        db.purge_executions_before(self._cutoff())
        with db._conn() as conn:
            row = conn.execute("SELECT * FROM executions WHERE id=?", (eid,)).fetchone()
        self.assertIsNone(row, "记录还在库里，说明不是真删")
        self.assertEqual(db.get_execution(eid), None)

    def test_running_records_are_skipped(self):
        running = self._add(40, status="running")
        old = self._add(40)
        deleted, skipped = db.purge_executions_before(self._cutoff())
        self.assertEqual(deleted, 1)
        self.assertEqual(skipped, 1)
        with db._conn() as conn:
            ids = [r[0] for r in conn.execute("SELECT id FROM executions").fetchall()]
        self.assertIn(running, ids, "运行中的记录不该被删")
        self.assertNotIn(old, ids)

    def test_preview_counts_without_deleting(self):
        self._add(40)
        self._add(40)
        self._add(5)
        n, running = db.count_executions_before(self._cutoff())
        self.assertEqual(n, 2)
        self.assertEqual(running, 0)
        self.assertEqual(self._count(), 3, "preview 不能真删")

    def test_preview_excludes_running_from_deletable_count(self):
        """preview 报「会删几条」时不能把 running 混进去，否则和实际删除数对不上"""
        self._add(40)
        self._add(40, status="running")
        n, running = db.count_executions_before(self._cutoff())
        self.assertEqual(n, 1, "会删的条数应排除 running")
        self.assertEqual(running, 1)
        # 实际删除数和 preview 报的一致
        deleted, skipped = db.purge_executions_before(self._cutoff())
        self.assertEqual(deleted, n)
        self.assertEqual(skipped, running)

    def test_dry_run_deletes_nothing(self):
        self._add(40)
        deleted, _ = db.purge_executions_before(self._cutoff(), dry_run=True)
        self.assertEqual(deleted, 1)
        self.assertEqual(self._count(), 1, "dry_run 不能真删")

    def test_timezone_offsets_do_not_break_comparison(self):
        """started_at 带不同偏移量时，字符串比较会错，julianday 才靠谱"""
        old = self.now - timedelta(days=40)
        # 一个 +08:00，一个 +00:00，同一个时刻但字符串排序完全不同
        for off in (8, 0):
            tz = timezone(timedelta(hours=off))
            started = old.astimezone(tz).isoformat(timespec="seconds")
            with db._conn() as conn:
                conn.execute(
                    "INSERT INTO executions (script_id, args, command, status, started_at)"
                    " VALUES (?,?,?,?,?)", (self.sid, "{}", "x", "success", started))
        deleted, _ = db.purge_executions_before(self._cutoff())
        self.assertEqual(deleted, 2, "带不同时区偏移的旧记录都该被删")

    def test_nothing_to_delete(self):
        self._add(1)
        deleted, running = db.purge_executions_before(self._cutoff())
        self.assertEqual(deleted, 0)
        self.assertEqual(running, 0)
        self.assertEqual(self._count(), 1)


if __name__ == "__main__":
    unittest.main()
