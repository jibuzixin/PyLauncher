"""带依赖的示例脚本：演示 uv venv + requirements.txt 初始化流程。"""
import argparse


def main() -> int:
    p = argparse.ArgumentParser(description="带依赖示例：请求一个 URL 并打印响应大小")
    p.add_argument("--url", default="https://www.baidu.com", help="目标 URL")
    p.add_argument("--timeout", type=int, default=5, help="超时秒数")
    args = p.parse_args()

    try:
        import requests
    except ImportError:
        print("⚠ requests 未安装 —— 请先在启动器里点击「初始化环境」")
        return 1

    print(f"请求 {args.url}（超时 {args.timeout}s）…", flush=True)
    r = requests.get(args.url, timeout=args.timeout)
    print(f"状态码: {r.status_code}  响应大小: {len(r.content)} 字节")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
