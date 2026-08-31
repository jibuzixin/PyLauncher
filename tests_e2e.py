"""全链路 WS 流式测试：env init + execute。"""
import asyncio
import json
import sys
import urllib.request

import websockets

BASE = "http://127.0.0.1:8900"


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


async def pump(ws_path, label):
    lines = []
    async with websockets.connect("ws://127.0.0.1:8900" + ws_path) as ws:
        while True:
            msg = json.loads(await ws.recv())
            if msg["type"] == "line":
                lines.append((msg["stream"], msg["line"]))
                print(f"[{label}] {msg['stream']}: {msg['line'][:120]}")
            elif msg["type"] == "done":
                print(f"[{label}] DONE result={msg['result']}")
                return lines, msg["result"]


async def main():
    # 1. 初始化 script 2（带 requirements.txt）
    sid = post("/api/scripts/2/env/init", {})["session_id"]
    lines, result = await pump(f"/ws/env/{sid}", "ENV")
    print("ENV OK:", result)
    assert result.get("ok"), "env init 失败"
    assert "deps" in result.get("steps", [])

    # 2. 执行 script 1（argparse_demo）
    exec_id = post("/api/execute", {
        "script_id": 1,
        "args": {"subject": "流水线", "n": 3, "ratio": 0.5, "verbose": True,
                 "mode": "fast", "tags": ["t1", "t2"], "required_opt": "req1"},
    })["execution_id"]
    lines, result = await pump(f"/ws/run/{exec_id}", "RUN")
    print("RUN status:", result.get("status"), "exit:", result.get("exit_code"))
    assert result.get("status") == "success", result

    # 3. 执行 script 2（带依赖，验证 requests 已可用）
    exec_id2 = post("/api/execute", {
        "script_id": 2,
        "args": {"url": "https://www.baidu.com", "timeout": 8},
    })["execution_id"]
    lines, result = await pump(f"/ws/run/{exec_id2}", "RUN2")
    print("RUN2 status:", result.get("status"), "exit:", result.get("exit_code"))
    assert result.get("status") == "success", result

    # 4. 检查执行记录 + 打标签
    with urllib.request.urlopen(BASE + "/api/executions") as r:
        recs = json.loads(r.read())
    print("execution count:", len(recs))
    top = recs[0]
    req = urllib.request.Request(
        BASE + f"/api/executions/{top['id']}/tags",
        data=json.dumps({"tags": ["回归", "日常"]}).encode(),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req) as r:
        print("tag update:", json.loads(r.read()))
    with urllib.request.urlopen(BASE + f"/api/executions/{top['id']}") as r:
        detail = json.loads(r.read())
    print("detail tags:", detail["tags"], "output len:", len(detail["output"]))
    assert detail["tags"] == ["回归", "日常"]

    print("\nALL WS/EXECUTION TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
