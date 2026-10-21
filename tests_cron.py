"""cron 表达式校验与「分/时」语义的回归测试。

覆盖曾经出问题的地方：
  1. 时/分写反时，croniter 报的是不透明的 "out of range"；
  2. "02 59 * * *" 这类表达式（时字段 59）必须被拦下并说清是哪个字段越界；
  3. cron 的字段顺序是「分 时 日 月 周」，计算结果必须与之一致。
"""
import unittest
from datetime import datetime

import main


class TestCronValidate(unittest.TestCase):
    def test_valid_expressions(self):
        for expr in [
            "* * * * *",
            "*/5 * * * *",
            "0 */2 * * *",
            "0 9 * * *",
            "0 9 * * 1-5",
            "0 9 * * mon",
            "0 9 * jan *",
            "0 0 1 1 *",
            "30 2 15 * 6",
            "0 9 1 * *",
        ]:
            with self.subTest(expr=expr):
                self.assertIsNone(main._validate_cron(expr))

    def test_out_of_range_is_reported_per_field(self):
        # 时字段 59：曾经因为可视化构建器把时/分写反而产生，报错要说人话
        err = main._validate_cron("02 59 * * *")
        self.assertIsNotNone(err)
        self.assertIn("时", err)
        self.assertIn("0-23", err)

        self.assertIn("分", main._validate_cron("60 0 * * *"))
        self.assertIn("日", main._validate_cron("0 0 32 * *"))
        self.assertIn("月", main._validate_cron("0 0 1 13 *"))
        self.assertIn("周", main._validate_cron("0 0 * * 8"))

    def test_field_count_must_be_five(self):
        self.assertIn("5 段", main._validate_cron("0 9 * *"))
        self.assertIn("5 段", main._validate_cron("0 0 9 * * *"))

    def test_invalid_step_and_order(self):
        self.assertIsNotNone(main._validate_cron("0 9 * * */0"))
        self.assertIsNotNone(main._validate_cron("0 9 * * 5-1"))

    def test_check_cron_uses_both_layers(self):
        self.assertIsNone(main._check_cron("0 9 * * *"))
        self.assertIsNotNone(main._check_cron("02 59 * * *"))
        # 字段范围合法但 croniter 不认（区间带步长）时，也应给出错误而不是异常
        self.assertIsNotNone(main._check_cron("0 0-30/2 * * *"))


class TestCronNextOrder(unittest.TestCase):
    """cron 字段顺序是「分 时 日 月 周」：02 00 是 00:02，不是 02:00。"""

    BASE = datetime(2026, 10, 19, 20, 0, 0).astimezone()

    def test_minute_before_hour(self):
        self.assertEqual(
            main._cron_next("02 00 * * *", self.BASE).strftime("%H:%M:%S"), "00:02:00"
        )
        self.assertEqual(
            main._cron_next("00 02 * * *", self.BASE).strftime("%H:%M:%S"), "02:00:00"
        )
        self.assertEqual(
            main._cron_next("59 02 * * *", self.BASE).strftime("%H:%M:%S"), "02:59:00"
        )

    def test_daily_at_nine(self):
        nxt = main._cron_next("0 9 * * *", self.BASE)
        self.assertEqual(nxt.strftime("%Y-%m-%d %H:%M:%S"), "2026-10-20 09:00:00")


if __name__ == "__main__":
    unittest.main(verbosity=2)
