"""运行队列界面走查（CDP 驱动无头 Chrome，自动点一遍真实操作路径）。

这条脚本会：
1. 起一个临时实例（独立库、独立端口 8913），塞 3 个脚本 + 3 个预设
2. 用无头 Chrome 打开它，按真实用户路径操作：
   新建队列 → 选脚本 → 选预设（看命令预览）→ 加入队列 → ↑↓ 调顺序（看动效）
   → 保存 → 在卡片上再调一次顺序 → 看队列实跑
3. 逐项断言并打印 PASS / FAIL

跑法（不需要往项目 venv 里装东西，uv 会用临时环境）：
    uv run --with websockets python tests_walk_queue_ui.py

想自己动手点：
    .venv/bin/python tests_e2e_queue.py --serve
    然后浏览器打开 http://127.0.0.1:8909
"""
import asyncio
import base64
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("WALK_PORT", "8913"))
BASE = f"http://127.0.0.1:{PORT}"
OUT = os.path.join(tempfile.gettempdir(), "lv2_queue_walk")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CDP_PORT = 9334


# ---------------- 极简 CDP 客户端 ----------------

class Session:
    """连无头 Chrome，做点击 / 取值 / 截图。"""

    def __init__(self):
        self.proc = None
        self.profile = None
        self.loop = None
        self.ws = None
        self._id = 0

    def __enter__(self):
        import websockets  # noqa: PLC0415  (只在真正跑这个脚本时才需要)

        self.profile = tempfile.mkdtemp(prefix="cdp_profile_")
        self.proc = subprocess.Popen([
            CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
            f"--remote-debugging-port={CDP_PORT}", f"--user-data-dir={self.profile}",
            "--window-size=1280,860", "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ws_url = None
        for _ in range(80):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json", timeout=2) as r:
                    pages = [t for t in json.loads(r.read()) if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:  # noqa: BLE001
                time.sleep(0.25)
        if not ws_url:
            raise RuntimeError("Chrome 没起来")
        self.loop = asyncio.new_event_loop()
        self.ws = self.loop.run_until_complete(websockets.connect(ws_url, max_size=None))
        return self

    def __exit__(self, *exc):
        try:
            self.loop.run_until_complete(self.ws.close())
        except Exception:  # noqa: BLE001
            pass
        try:
            self.loop.close()
        except Exception:  # noqa: BLE001
            pass
        if self.proc:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                self.proc.kill()
        if self.profile:
            shutil.rmtree(self.profile, ignore_errors=True)

    def _send(self, method, params=None, timeout=30):
        async def run():
            self._id += 1
            mid = self._id
            await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=timeout))
                if msg.get("id") == mid:
                    return msg
        return self.loop.run_until_complete(run())

    def goto(self, url, wait=1.5):
        self._send("Page.enable")
        self._send("Page.navigate", {"url": url})
        time.sleep(wait)

    def js(self, expr, timeout=30):
        r = self._send("Runtime.evaluate",
                       {"expression": expr, "returnByValue": True, "awaitPromise": True}, timeout)
        res = r.get("result", {})
        if "exceptionDetails" in res:
            raise RuntimeError("JS 报错: " + json.dumps(res["exceptionDetails"], ensure_ascii=False)[:400])
        return res.get("result", {}).get("value")

    def shot(self, path):
        data = self._send("Page.captureScreenshot", {"format": "png"}).get("result", {}).get("data")
        if data:
            with open(path, "wb") as fh:
                fh.write(base64.b64decode(data))

    def text(self, selector):
        return self.js(f"(document.querySelector({json.dumps(selector)})||{{}}).innerText || ''")


# ---------------- 临时实例 ----------------

def start_instance(tmp):
    for f in ("main.py", "db.py", "executor.py", "scanner.py"):
        shutil.copy(os.path.join(ROOT, f), tmp)
    shutil.copytree(os.path.join(ROOT, "static"), os.path.join(tmp, "static"))
    with open(os.path.join(tmp, "ok1.py"), "w", encoding="utf-8") as fh:
        fh.write("import time\nprint('OK1_START')\ntime.sleep(1)\nprint('OK1_END')\n")
    with open(os.path.join(tmp, "ok2.py"), "w", encoding="utf-8") as fh:
        fh.write("print('OK2_DONE')\n")
    with open(os.path.join(tmp, "bad.py"), "w", encoding="utf-8") as fh:
        fh.write("import sys\nprint('BAD_FAIL')\nsys.exit(1)\n")
    subprocess.run([sys.executable, "-c", "import db; db.init_db()"], cwd=tmp, check=True,
                   env=dict(os.environ, PYTHONPATH=tmp))
    conn = sqlite3.connect(os.path.join(tmp, "launcher.db"))
    now = "2026-01-01T00:00:00+08:00"
    for nm in ("ok1.py", "ok2.py", "bad.py"):
        conn.execute(
            "INSERT INTO scripts (name, path, args_schema, auto_saved_args, created_at, updated_at)"
            " VALUES (?,?,'[]','{}',?,?)", (nm, os.path.join(tmp, nm), now, now))
    conn.commit()
    for sid, label in ((1, "夜间模式"), (2, "白天模式"), (3, "夜间模式")):
        conn.execute(
            "INSERT INTO presets (script_id, name, args, created_at, cmd_prefix, cmd_suffix)"
            " VALUES (?,?,?,?,?,?)", (sid, label, "{}", now, "DEMO=1", ""))
    conn.commit()
    conn.close()
    env = dict(os.environ, LAUNCHER_PORT=str(PORT))
    proc = subprocess.Popen([sys.executable, "main.py", "--no-browser"], cwd=tmp, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            with urllib.request.urlopen(BASE + "/api/scripts", timeout=2) as r:
                r.read()
            return proc
        except Exception:  # noqa: BLE001
            time.sleep(0.3)
    raise RuntimeError("临时实例没起来")


# ---------------- 走查 ----------------

OK = True


def check(label, cond, extra=""):
    global OK
    OK = OK and bool(cond)
    print(f"  {'PASS' if cond else 'FAIL'}  {label} {extra}")


def walk():
    os.makedirs(OUT, exist_ok=True)
    with Session() as s:
        s.goto(BASE + "/", wait=2)
        s.js("document.querySelector('.nav-btn[data-view=\"queues\"]').click()")
        time.sleep(0.8)

        s.js("document.querySelector('#btn-new-queue').click()")
        time.sleep(1.0)
        check("新建队列弹窗打开", s.js("!!document.querySelector('#q-name')"))
        check("弹窗里按脚本 + 预设选择",
              s.js("!!document.querySelector('#q-script')") and s.js("!!document.querySelector('#q-preset')"))
        check("开始时间是日期 + 时间两个选择器（能直接点选）",
              s.js("document.querySelector('#q-date').type") == "date"
              and s.js("document.querySelector('#q-time').type") == "time")
        check("开始时间有快捷键", s.js("document.querySelectorAll('#q-quick button').length") == 3)
        # 快捷键：5 分钟后
        s.js("document.querySelector('#q-quick button[data-q=\"5m\"]').click()")
        time.sleep(0.3)
        quick_date = s.js("document.querySelector('#q-date').value || ''")
        quick_time = s.js("document.querySelector('#q-time').value || ''")
        check("点「5 分钟后」能填好日期和时间",
              bool(re.match(r"^\d{4}-\d{2}-\d{2}$", quick_date or ""))
              and bool(re.match(r"^\d{2}:\d{2}$", quick_time or "")),
              f"{quick_date} {quick_time}")
        s.shot(f"{OUT}/1_modal.png")

        # 脚本 → 预设联动 + 命令预览
        s.js("""(() => {
            const sel = document.querySelector('#q-script');
            sel.value = Array.from(sel.options).find(o => o.value).value;
            sel.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
        })()""")
        time.sleep(0.8)
        presets = s.js("JSON.stringify(Array.from(document.querySelectorAll('#q-preset option')).map(o=>o.textContent))")
        check("选脚本后预设跟着联动", presets and presets != "[]")
        cmd = s.js("document.querySelector('#q-cmd').textContent || ''")
        check("有命令预览", len(cmd) > 5, cmd[:60])

        s.js("""(() => {
            const sel = document.querySelector('#q-preset');
            const opt = Array.from(sel.options).filter(o => o.value)[0];
            if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true})); }
            return true;
        })()""")
        time.sleep(0.9)
        cmd2 = s.js("document.querySelector('#q-cmd').textContent || ''")
        check("换预设后命令预览跟着变", cmd2 != cmd)

        # 加两个任务
        s.js("document.querySelector('#q-add-btn').click()")
        time.sleep(0.5)
        s.js("""(() => {
            const sel = document.querySelector('#q-script');
            const opts = Array.from(sel.options).filter(o => o.value);
            sel.value = opts[1].value;
            sel.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
        })()""")
        time.sleep(0.7)
        s.js("document.querySelector('#q-add-btn').click()")
        time.sleep(0.5)
        check("两个任务都进了队列草稿", s.js("document.querySelectorAll('#q-items .q-item').length") == 2)
        s.shot(f"{OUT}/2_items.png")

        # ↑ 调顺序 + 动效
        s.js("""(() => {
            window.__moves = 0;
            new MutationObserver(() => {
                if (document.querySelector('#q-items .q-item.moving')) window.__moves++;
            }).observe(document.querySelector('#q-items'), {subtree:true, attributes:true, attributeFilter:['class']});
            return true;
        })()""")
        before = s.js("JSON.stringify(Array.from(document.querySelectorAll('#q-items .q-item .qi-name')).map(e=>e.textContent))")
        s.js("document.querySelectorAll('#q-items .q-item')[1].querySelectorAll('.qi-btn')[0].click()")
        time.sleep(0.8)
        after = s.js("JSON.stringify(Array.from(document.querySelectorAll('#q-items .q-item .qi-name')).map(e=>e.textContent))")
        check("↑ 能把任务往前挪", before != after)
        check("移动时有滑动动效", (s.js("window.__moves") or 0) > 0)

        # 保存
        s.js("document.querySelector('#q-name').value = '演示队列'")
        s.js("""(() => {
            const b = Array.from(document.querySelectorAll('.modal button')).find(b => b.textContent.trim() === '创建');
            b.click(); return true;
        })()""")
        time.sleep(1.5)
        s.js("document.querySelector('.nav-btn[data-view=\"queues\"]').click()")
        time.sleep(0.8)
        card = s.text("#queue-grid")
        check("队列卡片显示脚本名 + 预设名", "ok1.py" in card and ("默认参数" in card or "夜间模式" in card))
        check("卡片任务数正确", "任务 0 / 2" in card)
        s.shot(f"{OUT}/3_card.png")

        # 卡片上再调一次顺序（也有动效），并检查卡片本身没有被重建（不闪）
        s.js("""(() => {
            window.__cardMoves = 0;
            new MutationObserver(() => {
                if (document.querySelector('.queue-card .queue-item.moving')) window.__cardMoves++;
            }).observe(document.querySelector('#queue-grid'), {subtree:true, attributes:true, attributeFilter:['class']});
            // 给卡片打个标记：重建就说明会闪一下
            document.querySelector('.queue-card').__keep = 'yes';
            return true;
        })()""")
        c_before = s.js("JSON.stringify(Array.from(document.querySelectorAll('.queue-card .queue-item .qi-name')).map(e=>e.textContent))")
        s.js("document.querySelectorAll('.queue-card .queue-item')[1].querySelectorAll('.qi-btn')[0].click()")
        time.sleep(1.2)
        c_after = s.js("JSON.stringify(Array.from(document.querySelectorAll('.queue-card .queue-item .qi-name')).map(e=>e.textContent))")
        check("卡片上 ↑ 能挪动顺序", c_before != c_after)
        check("卡片上移动也有滑动动效", (s.js("window.__cardMoves") or 0) > 0)
        check("排序后卡片没有整块重建（不闪）", s.js("document.querySelector('.queue-card').__keep") == "yes")
        s.shot(f"{OUT}/4_card_moved.png")

        # 启用 / 停用开关
        s.js("""(() => {
            const sw = document.querySelector('.queue-card .sw input');
            sw.checked = false;
            sw.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
        })()""")
        time.sleep(1.2)
        check("关掉后卡片显示「已关闭」", "已关闭" in s.text("#queue-grid"))
        check("关掉后开关处于关闭态", s.js("document.querySelector('.queue-card .sw input').checked") is False)
        s.shot(f"{OUT}/5_disabled.png")
        s.js("""(() => {
            const sw = document.querySelector('.queue-card .sw input');
            sw.checked = true;
            sw.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
        })()""")
        time.sleep(1.2)
        check("打开后不再显示「已关闭」", "已关闭" not in s.text("#queue-grid"))

        # 编辑框里的清空按钮
        s.js("document.querySelector('.queue-card .queue-ops .btn[data-op=edit]').click()")
        time.sleep(1.0)
        check("编辑框里有清空按钮", s.js("!!document.querySelector('#q-clear')") and not s.js("document.querySelector('#q-clear').hidden"))
        s.js("document.querySelector('#q-clear').click()")
        time.sleep(0.5)
        s.js("document.querySelector('#q-clear').click()")
        time.sleep(1.2)
        check("清空后编辑框里的任务清空了", s.js("document.querySelectorAll('#q-items .q-item').length") == 0)
        s.shot(f"{OUT}/6_cleared.png")
        s.js("""(() => {
            const b = Array.from(document.querySelectorAll('.modal button')).find(b => b.textContent.trim() === '取消');
            b.click(); return true;
        })()""")
        time.sleep(0.6)

        # 队列实跑：马上开始，第一个任务失败不影响第二个
        s.js("document.querySelector('#btn-new-queue').click()")
        time.sleep(0.9)
        s.js("""(() => {
            document.querySelector('#q-name').value = '实跑验证';
            const d = new Date(Date.now() + 3000);
            const p = n => String(n).padStart(2, '0');
            document.querySelector('#q-date').value =
                `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
            document.querySelector('#q-time').value = `${p(d.getHours())}:${p(d.getMinutes())}`;
            document.querySelector('#q-interval').value = '1';
            const sel = document.querySelector('#q-script');
            const bad = Array.from(sel.options).find(o => o.textContent.includes('bad.py'));
            sel.value = bad.value;
            sel.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
        })()""")
        time.sleep(0.6)
        s.js("document.querySelector('#q-add-btn').click()")
        time.sleep(0.4)
        s.js("""(() => {
            const sel = document.querySelector('#q-script');
            const ok = Array.from(sel.options).find(o => o.textContent.includes('ok1.py'));
            sel.value = ok.value;
            sel.dispatchEvent(new Event('change', {bubbles:true}));
            return true;
        })()""")
        time.sleep(0.6)
        s.js("document.querySelector('#q-add-btn').click()")
        time.sleep(0.4)
        s.js("""(() => {
            const b = Array.from(document.querySelectorAll('.modal button')).find(b => b.textContent.trim() === '创建');
            b.click(); return true;
        })()""")
        time.sleep(1.5)
        s.js("document.querySelector('.nav-btn[data-view=\"queues\"]').click()")
        time.sleep(0.5)
        final = ""
        end = time.time() + 40
        while time.time() < end:
            time.sleep(1.5)
            s.js("document.querySelector('.nav-btn[data-view=\"queues\"]').click()")
            time.sleep(0.4)
            final = s.text("#queue-grid")
            if "已完成" in final:
                break
        print("  队列最终状态：", final.replace("\n", " | ")[:200])
        check("队列跑完后是「已完成」", "已完成" in final)
        check("第一个任务失败", "失败" in final)
        check("第二个任务成功（失败不影响后一个）", "成功" in final)
        s.shot(f"{OUT}/5_finished.png")


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="lv2_walk_queue_")
    proc = None
    try:
        proc = start_instance(tmp)
        walk()
        print()
        print(f"截图在：{OUT}")
        return 0 if OK else 1
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
