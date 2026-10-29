"""执行记录搜索：按「记录名 / 脚本名 / 标签 / 状态」都能搜到。

背景：
- 控制台里重命名过的记录（tab_name），在执行记录页按新名字搜是搜不到的，
  因为搜索范围里漏了记录名，只有脚本名参与匹配。
- 搜索还只在前端那 200 条里过滤，更早的记录即使名字对也搜不出来。

跑法：.venv/bin/python -m unittest tests_exec_search
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db  # noqa: E402


class ExecSearchTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self._old_db_path = db._DB_PATH
        db._DB_PATH = os.path.join(self.tmpdir.name, "test_launcher.db")
        db.init_db()
        now = db.now_iso()
        with db._conn() as conn:
            cur = conn.execute(
                "INSERT INTO scripts (name, path, args_schema, auto_saved_args, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?)", ("评测脚本.py", "/tmp/a.py", "[]", "{}", now, now))
            self.sid = cur.lastrowid
            cur = conn.execute(
                "INSERT INTO scripts (name, path, args_schema, auto_saved_args, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?)", ("上传图片.py", "/tmp/b.py", "[]", "{}", now, now))
            self.sid2 = cur.lastrowid
        # 三条记录：一条改过记录名、一条带标签、一条失败
        self.e1 = db.add_execution(self.sid, {"mode": "知识库"}, None, "uv run a.py --mode 知识库")
        db.set_execution_tab_name(self.e1["id"], "1022-知识库评测部分")
        self.e2 = db.add_execution(self.sid2, {}, None, "uv run b.py")
        db.set_execution_tags(self.e2["id"], ["重要", "飞书"])
        self.e3 = db.add_execution(self.sid2, {}, None, "uv run b.py --bad")
        db.finish_execution(self.e3["id"], "failed", 1, ["boom"])

    def tearDown(self):
        db._DB_PATH = self._old_db_path
        self.tmpdir.cleanup()

    def hit_ids(self, kw):
        return [e["id"] for e in db.list_executions(kw=kw)]

    def test_by_record_name(self):
        """重命名后的记录名能搜到（之前搜不到的就是这个）"""
        self.assertIn(self.e1["id"], self.hit_ids("1022-知识库评测部分"))
        self.assertIn(self.e1["id"], self.hit_ids("知识库评测"))

    def test_by_script_name(self):
        self.assertIn(self.e1["id"], self.hit_ids("评测脚本"))
        self.assertIn(self.e2["id"], self.hit_ids("上传图片"))

    def test_by_tag(self):
        self.assertEqual(self.hit_ids("飞书"), [self.e2["id"]])
        self.assertIn(self.e2["id"], self.hit_ids("重要"))

    def test_by_status_english_and_chinese(self):
        self.assertIn(self.e3["id"], self.hit_ids("failed"))
        self.assertIn(self.e3["id"], self.hit_ids("失败"))
        self.assertNotIn(self.e1["id"], self.hit_ids("失败"))

    def test_status_word_does_not_match_output_text(self):
        """状态词只跟状态字段比：输出里出现「失败」二字的成功记录不该被捞出来"""
        self.e4 = db.add_execution(self.sid2, {}, None, "uv run c.py")
        db.finish_execution(self.e4["id"], "success", 0, ["共 3 项失败"])
        self.assertNotIn(self.e4["id"], self.hit_ids("失败"))
        # 反过来：状态是失败、输出里写「成功」的记录，搜「成功」也不该命中
        self.e5 = db.add_execution(self.sid2, {}, None, "uv run d.py")
        db.finish_execution(self.e5["id"], "failed", 1, ["全部成功"])
        self.assertNotIn(self.e5["id"], self.hit_ids("成功"))

    def test_output_is_not_searchable(self):
        """搜索只查记录本身的信息，不查控制台输出内容（用户明确要求收窄）"""
        self.e4 = db.add_execution(self.sid2, {}, None, "uv run c.py")
        db.finish_execution(self.e4["id"], "success", 0, ["共 3 项失败"])
        # 输出里的话搜不到
        self.assertNotIn(self.e4["id"], self.hit_ids("共 3 项失败"))
        self.assertEqual(self.hit_ids("共 3 项失败"), [])

    def test_command_and_args_are_not_searchable(self):
        """命令、参数是执行细节，不参与搜索"""
        # e1 的命令里有「--mode 知识库」，参数里也有「知识库」
        self.assertNotIn(self.e3["id"], self.hit_ids("--bad"))
        self.assertNotIn(self.e1["id"], self.hit_ids("--mode 知识库"))

    def test_multiple_tokens_are_and(self):
        # 两个词都要命中才算
        self.assertIn(self.e1["id"], self.hit_ids("1022 知识库"))
        self.assertNotIn(self.e2["id"], self.hit_ids("1022 知识库"))

    def test_no_match_returns_empty(self):
        self.assertEqual(self.hit_ids("根本不存在的关键词"), [])

    def test_empty_kw_returns_all(self):
        self.assertEqual(len(db.list_executions(kw="")), 3)


if __name__ == "__main__":
    unittest.main()
