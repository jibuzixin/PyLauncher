"""启动器「只开一个浏览器标签页」的回归测试。

背景：start.command 自己和后端 main.py 各开一次浏览器，一次启动会弹出两个标签页。
约定：浏览器只由启动脚本开，后端带 --no-browser 启动；后端直接跑时自己开一个。
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import main

ROOT = Path(__file__).resolve().parent


class TestPortListening(unittest.TestCase):
    def test_closed_port_is_not_listening(self):
        # 找一个确定没人监听的端口
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            free_port = s.getsockname()[1]
        self.assertFalse(main._port_listening("127.0.0.1", free_port))

    def test_listening_port_is_detected(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            s.listen(1)
            port = s.getsockname()[1]
            self.assertTrue(main._port_listening("127.0.0.1", port))


class TestWhenReady(unittest.TestCase):
    def test_callback_fires_once_port_is_up(self):
        fired = []
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            s.listen(1)
            port = s.getsockname()[1]
            main._when_ready("127.0.0.1", port, lambda: fired.append(1), timeout=5)
            for _ in range(50):
                if fired:
                    break
                time.sleep(0.1)
        self.assertEqual(len(fired), 1)

    def test_callback_not_fired_when_port_never_comes_up(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            free_port = s.getsockname()[1]
        fired = []
        main._when_ready("127.0.0.1", free_port, lambda: fired.append(1), timeout=0.8)
        time.sleep(1.2)
        self.assertEqual(fired, [])


class TestScriptsDoNotDoubleOpen(unittest.TestCase):
    """启动脚本必须带 --no-browser 启动后端，否则会和后端各开一个标签页。"""

    def test_mac_scripts_pass_no_browser(self):
        for name in ("start.command", "start-v2.command"):
            with self.subTest(script=name):
                text = (ROOT / name).read_text(encoding="utf-8")
                # 后端带 --no-browser 启动：浏览器只由脚本开，不会弹两个标签页
                self.assertIn("main.py --no-browser", text)
                # 脚本里有两处 open，但分别在互斥分支里：
                # 「服务已在运行」分支与「刚启动」分支，每次运行只命中一处
                self.assertEqual(text.count('open "http'), 2)
                # 重复双击时靠"服务刚启动"标记跳过重复打开
                self.assertIn("skip_open", text)

    def test_backend_supports_no_browser_flag(self):
        self.assertIn('"--no-browser" in sys.argv', (ROOT / "main.py").read_text(encoding="utf-8"))


class TestServerOpensAtMostOneTab(unittest.TestCase):
    """真起一个服务，用 BROWSER 环境变量把 webbrowser.open 换成假浏览器来计数。"""

    def _run_server(self, extra_args, port, log_path):
        env = dict(os.environ)
        env["LAUNCHER_PORT"] = str(port)
        env["BROWSER"] = str(ROOT / "tests_fake_browser.sh")
        env["FAKE_BROWSER_LOG"] = str(log_path)
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.Popen(
            [str(ROOT / ".venv" / "bin" / "python"), "main.py", *extra_args],
            cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        # 等端口起来
        for _ in range(80):
            if main._port_listening("127.0.0.1", port):
                break
            time.sleep(0.1)
        time.sleep(1.0)  # 给"就绪回调"留出打开浏览器的时间
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        return log_path.read_text(encoding="utf-8") if log_path.exists() else ""

    def _free_port(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def test_no_browser_flag_opens_no_tab(self):
        with tempfile.TemporaryDirectory() as td:
            log = Path(td) / "tabs.log"
            out = self._run_server(["--no-browser"], self._free_port(), log)
            self.assertEqual(out.strip(), "", "带 --no-browser 时后端不应该再开浏览器")

    def test_without_flag_opens_exactly_one_tab(self):
        with tempfile.TemporaryDirectory() as td:
            log = Path(td) / "tabs.log"
            out = self._run_server([], self._free_port(), log)
            self.assertEqual(len([x for x in out.splitlines() if x.strip()]), 1,
                             "不带 --no-browser 时后端应该只开一个标签页")


if __name__ == "__main__":
    unittest.main(verbosity=2)
