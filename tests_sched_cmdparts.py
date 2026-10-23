"""自定义命令的前后缀：存进预设、跟着预设进定时任务、执行时用上。

背景：
- 之前脚本页的「参数 + 命令前后缀」只有参数会存进预设，前后缀只躺在 localStorage 里，
  切换预设来回就丢了。
- 定时任务也拿不到预设的前后缀，执行时只会按参数生成命令。

跑法：.venv/bin/python -m unittest tests_sched_cmdparts
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db  # noqa: E402


SCHEMA = [{"dest": "url", "name": "--url", "kind": "optional", "action": "store", "type": "str"},
          {"dest": "n", "name": "--n", "kind": "optional", "action": "store", "type": "int"}]


class PresetCmdPartsTest(unittest.TestCase):
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
                ("demo.py", "/tmp/demo.py", json.dumps(SCHEMA), "{}", now, now))
            self.script_id = cur.lastrowid

    def tearDown(self):
        db._DB_PATH = self._old_db_path
        self.tmpdir.cleanup()

    # ---------- 预设存不存得下前后缀 ----------

    def test_add_preset_keeps_cmd_parts(self):
        """新建预设：参数 + 前后缀一起落库。"""
        p = db.add_preset(self.script_id, "A", {"url": "x"}, cmd_prefix="NO_COLOR=1", cmd_suffix="2>&1")
        row = db.get_preset(p["id"])
        self.assertEqual(row["cmd_prefix"], "NO_COLOR=1")
        self.assertEqual(row["cmd_suffix"], "2>&1")
        self.assertEqual(json.loads(row["args"])["url"], "x")

    def test_update_preset_without_cmd_parts_keeps_them(self):
        """只改参数时，预设原有的前后缀保持不变。"""
        p = db.add_preset(self.script_id, "A", {"url": "x"}, cmd_prefix="P", cmd_suffix="S")
        db.update_preset(p["id"], {"url": "y"})
        row = db.get_preset(p["id"])
        self.assertEqual(row["cmd_prefix"], "P")
        self.assertEqual(row["cmd_suffix"], "S")
        self.assertEqual(json.loads(row["args"])["url"], "y")

    def test_update_preset_can_clear_cmd_parts(self):
        """显式传空串：前后缀被清掉（和「没传」要能区分开）。"""
        p = db.add_preset(self.script_id, "A", {"url": "x"}, cmd_prefix="P", cmd_suffix="S")
        db.update_preset(p["id"], {"url": "y"}, cmd_prefix="", cmd_suffix="")
        row = db.get_preset(p["id"])
        self.assertEqual(row["cmd_prefix"], "")
        self.assertEqual(row["cmd_suffix"], "")

    def test_get_preset_returns_none_for_missing(self):
        self.assertIsNone(db.get_preset(None))
        self.assertIsNone(db.get_preset(99999))

    # ---------- 定时任务存不存得下前后缀 ----------

    def test_add_schedule_keeps_cmd_parts(self):
        """新建定时任务：命令前后缀一起落库。"""
        s = db.add_schedule(self.script_id, "T", "0 9 * * *", {"url": "x"},
                            cmd_prefix="P", cmd_suffix="S")
        row = db.get_schedule(s["id"])
        self.assertEqual(row["cmd_prefix"], "P")
        self.assertEqual(row["cmd_suffix"], "S")

    def test_update_schedule_cmd_parts(self):
        """改定时任务：只传一段就只改那一段，不传的保持原值。"""
        s = db.add_schedule(self.script_id, "T", "0 9 * * *", {}, cmd_prefix="P", cmd_suffix="S")
        db.update_schedule(s["id"], cmd_prefix="P2")
        row = db.get_schedule(s["id"])
        self.assertEqual(row["cmd_prefix"], "P2")
        self.assertEqual(row["cmd_suffix"], "S")
        db.update_schedule(s["id"], cmd_suffix="")
        row = db.get_schedule(s["id"])
        self.assertEqual(row["cmd_prefix"], "P2")
        self.assertEqual(row["cmd_suffix"], "")

    def test_update_schedule_without_cmd_parts_keeps_them(self):
        """只改别的东西时，前后缀不能被清掉。"""
        s = db.add_schedule(self.script_id, "T", "0 9 * * *", {}, cmd_prefix="P", cmd_suffix="S")
        db.update_schedule(s["id"], name="T2")
        row = db.get_schedule(s["id"])
        self.assertEqual(row["cmd_prefix"], "P")
        self.assertEqual(row["cmd_suffix"], "S")

    # ---------- 执行时到底用哪一份 ----------

    def _resolve(self, sched):
        """跑一次「解析」，把命令生成固定住，只看前后缀怎么拼。"""
        import main
        rec = db.get_script(self.script_id)
        with mock.patch.object(main, "_build_command_text", return_value="python demo.py --url u --n 1"):
            return main._sched_resolve(sched, rec)

    def test_bound_schedule_follows_preset(self):
        """绑了预设：参数与前后缀都用预设里最新的那份。"""
        p = db.add_preset(self.script_id, "A", {"url": "preset-url", "n": 7},
                          cmd_prefix="PRESET_PREFIX", cmd_suffix="PRESET_SUFFIX")
        s = db.add_schedule(self.script_id, "T", "0 9 * * *", {"url": "old", "n": 1},
                            preset_id=p["id"], cmd_prefix="OWN", cmd_suffix="OWN")
        args, arg_list, cmd = self._resolve(db.get_schedule(s["id"]))
        self.assertEqual(args["url"], "preset-url")
        self.assertEqual(args["n"], 7)
        self.assertIn("--url preset-url", " ".join(arg_list))
        self.assertTrue(cmd.startswith("PRESET_PREFIX "))
        self.assertTrue(cmd.endswith(" PRESET_SUFFIX"))
        self.assertNotIn("OWN", cmd)

    def test_bound_schedule_without_preset_parts_falls_back_to_own(self):
        """预设没存前后缀：回退到任务自己存的那份。"""
        p = db.add_preset(self.script_id, "A", {"url": "preset-url"})
        s = db.add_schedule(self.script_id, "T", "0 9 * * *", {}, preset_id=p["id"],
                            cmd_prefix="OWN", cmd_suffix="OWN_S")
        args, _, cmd = self._resolve(db.get_schedule(s["id"]))
        self.assertEqual(args["url"], "preset-url")
        self.assertTrue(cmd.startswith("OWN "))
        self.assertTrue(cmd.endswith(" OWN_S"))

    def test_unbound_schedule_uses_own_snapshot(self):
        """没绑预设：参数与前后缀都用任务自己存的快照。"""
        s = db.add_schedule(self.script_id, "T", "0 9 * * *", {"url": "own-url", "n": 3},
                            cmd_prefix="OWN", cmd_suffix="OWN_S")
        args, arg_list, cmd = self._resolve(db.get_schedule(s["id"]))
        self.assertEqual(args["url"], "own-url")
        self.assertIn("--url own-url", " ".join(arg_list))
        self.assertTrue(cmd.startswith("OWN "))
        self.assertTrue(cmd.endswith(" OWN_S"))

    def test_no_cmd_parts_means_standard_execution(self):
        """没有任何前后缀：不套自定义命令，走标准执行路径。"""
        s = db.add_schedule(self.script_id, "T", "0 9 * * *", {"url": "x"})
        _, _, cmd = self._resolve(db.get_schedule(s["id"]))
        self.assertEqual(cmd, "")

    def test_broken_command_does_not_become_a_command(self):
        """命令生成失败时不能把「# 说明」当命令去跑。"""
        import main
        s = db.add_schedule(self.script_id, "T", "0 9 * * *", {}, cmd_prefix="P")
        rec = db.get_script(self.script_id)
        with mock.patch.object(main, "_build_command_text", return_value="# 环境有问题"):
            _, _, cmd = main._sched_resolve(db.get_schedule(s["id"]), rec)
        self.assertEqual(cmd, "")


class ScheduleMigrationTest(unittest.TestCase):
    """老库里没有 cmd_prefix / cmd_suffix 两列，升级时补上。"""

    def test_migration_adds_cmd_columns(self):
        tmpdir = tempfile.TemporaryDirectory()
        path = os.path.join(tmpdir.name, "old.db")
        # 造一张「旧结构」的 schedules 表
        conn = sqlite3.connect(path)
        conn.execute(
            "CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, script_id INTEGER NOT NULL,"
            " name TEXT NOT NULL, cron TEXT NOT NULL, args TEXT NOT NULL DEFAULT '{}',"
            " enabled INTEGER NOT NULL DEFAULT 1, max_runs INTEGER, preset_id INTEGER,"
            " run_count INTEGER NOT NULL DEFAULT 0, next_run TEXT, last_run TEXT, last_status TEXT,"
            " created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
        conn.commit()
        conn.close()

        old = db._DB_PATH
        db._DB_PATH = path
        try:
            db.init_db()
            with db._conn() as c:
                cols = {r[1] for r in c.execute("PRAGMA table_info(schedules)")}
            self.assertIn("cmd_prefix", cols)
            self.assertIn("cmd_suffix", cols)
            # 老数据不受影响，缺省是空串
            with db._conn() as c:
                c.execute("INSERT INTO schedules (script_id, name, cron, created_at, updated_at)"
                          " VALUES (1,'T','0 9 * * *','x','x')")
                row = dict(c.execute("SELECT * FROM schedules").fetchone())
            self.assertEqual(row["cmd_prefix"], "")
            self.assertEqual(row["cmd_suffix"], "")
        finally:
            db._DB_PATH = old
            tmpdir.cleanup()


if __name__ == "__main__":
    unittest.main()
