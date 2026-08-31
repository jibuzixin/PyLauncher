"""参数演示脚本：覆盖 argparse 各种参数形态，用于测试启动器表单。"""
import argparse
import time


def main() -> None:
    p = argparse.ArgumentParser(description="参数演示脚本")
    p.add_argument("subject", help="必选位置参数")
    p.add_argument("-n", "--num", type=int, default=3, help="循环次数")
    p.add_argument("--ratio", type=float, default=0.5, help="比例值")
    p.add_argument("--verbose", action="store_true", help="是否输出详细信息")
    p.add_argument("--mode", choices=["fast", "slow"], default="fast", help="运行模式")
    p.add_argument("--tags", action="append", default=[], help="标签，可传多次")
    p.add_argument("--required-opt", required=True, help="一个必选的可选参数")
    args = p.parse_args()

    print(f"[参数] subject={args.subject} num={args.num} ratio={args.ratio}")
    print(f"[参数] verbose={args.verbose} mode={args.mode} tags={args.tags} required_opt={args.required_opt}")

    for i in range(args.num):
        if args.verbose:
            print(f"[debug] 第 {i + 1} 次循环…", flush=True)
        else:
            print(f"处理中 {i + 1}/{args.num}", flush=True)
        time.sleep(0.2 if args.mode == "fast" else 0.8)

    import sys
    print("完成 ✓")
    sys.exit(0)


if __name__ == "__main__":
    main()
