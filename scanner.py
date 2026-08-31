"""脚本扫描与 argparse 参数定义解析（AST，不执行脚本）。

约定：工具脚本必须使用 argparse 解析命令行参数。
"""
from __future__ import annotations

import ast
import os
from pathlib import Path
from typing import Any, Optional

# 扫描时排除的目录（任意层级命中即跳过）
EXCLUDE_DIRS = {
    ".venv", "venv", "env", "node_modules", "__pycache__", ".git", ".hg",
    ".svn", "dist", "build", ".idea", ".vscode", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", "site-packages",
}


def is_excluded(path: Path) -> bool:
    for part in path.parts:
        if part in EXCLUDE_DIRS or part.startswith("."):
            return True
    return False


def scan_python_files(directory: str, recursive: bool = True) -> list[str]:
    """扫描目录下的 .py 文件（排除环境/缓存/隐藏目录），返回绝对路径列表。"""
    root = Path(directory).expanduser().resolve()
    if not root.is_dir():
        return []
    files: list[str] = []
    pattern = "**/*.py" if recursive else "*.py"
    for p in sorted(root.glob(pattern)):
        if is_excluded(p):
            continue
        if p.name == "__init__.py":
            continue
        files.append(str(p))
    return files


# ---------------- argparse AST 解析 ----------------

def _safe_literal(node: ast.AST) -> Any:
    """安全求值常量节点；无法求值返回 None。"""
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        return None


def _type_name(node: ast.AST) -> Optional[str]:
    """解析 type= 参数的类型名。"""
    if isinstance(node, ast.Name):
        return node.id  # int / str / float / bool / list ...
    if isinstance(node, ast.Attribute):
        return node.attr  # argparse.FileType / Path ...
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        return node.func.id  # 自定义构造函数
    return None


def _parse_arg(name: str, kwargs: dict[str, ast.AST]) -> Optional[dict[str, Any]]:
    """把一个 add_argument 调用解析为统一的参数定义。"""
    if name.startswith("-"):
        # 可选参数
        dest = kwargs.get("dest")
        if dest is not None:
            d = _safe_literal(dest)
        else:
            # argparse 规则：取最长的 option string 去前缀
            d = name.lstrip("-").replace("-", "_")
        kind = "optional"
    else:
        # 位置参数
        d = name
        kind = "positional"

    if not d:
        return None

    action = _safe_literal(kwargs.get("action")) or "store"
    tname = _type_name(kwargs["type"]) if "type" in kwargs else None
    tname = tname or "str"

    # 布尔开关：store_true / store_false
    if action in ("store_true", "store_false"):
        arg_type = "bool"
        default = _safe_literal(kwargs.get("default"))
        # store_false 默认 True，store_true 默认 False
        if default is None and "default" not in kwargs:
            default = action == "store_false"
    else:
        arg_type = tname

    choices_node = kwargs.get("choices")
    choices = None
    if choices_node is not None:
        choices = _safe_literal(choices_node)
        if not isinstance(choices, (list, tuple, set)):
            choices = None
        else:
            choices = list(choices)

    nargs = _safe_literal(kwargs.get("nargs"))
    if isinstance(nargs, int):
        nargs = str(nargs)

    required = bool(_safe_literal(kwargs.get("required")) or False)
    # 位置参数默认必选（除非 nargs='?'/'*' 或设置了 default）
    if kind == "positional":
        if nargs in ("?", "*"):
            required = False
        else:
            required = True

    return {
        "name": name,
        "dest": d,
        "kind": kind,
        "type": arg_type,
        "action": action,
        "default": _safe_literal(kwargs.get("default")),
        "required": required,
        "help": _safe_literal(kwargs.get("help")) or "",
        "choices": choices,
        "nargs": nargs,
        "is_flag": action in ("store_true", "store_false"),
    }


def parse_argparse_schema(source: str) -> Optional[dict[str, Any]]:
    """从源码 AST 提取 argparse 参数定义。

    返回 {"prog": str|None, "description": str|None, "args": [ {...} ]}，
    找不到任何 add_argument 时返回 None。
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None

    arg_defs: list[dict] = []
    prog: Optional[str] = None
    description: Optional[str] = None

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "add_argument":
            names: list[str] = []
            kwargs: dict[str, ast.AST] = {}
            for a in node.args:
                v = _safe_literal(a)
                if isinstance(v, str):
                    names.append(v)
            for kw in node.keywords:
                if kw.arg is not None and kw.value is not None:
                    kwargs[kw.arg] = kw.value
            if not names:
                continue
            # 主参数名：非 - 开头的为位置参数，否则取第一个可选参数
            name = next((n for n in names if not n.startswith("-")), names[0])
            parsed = _parse_arg(name, kwargs)
            if parsed:
                # 可选参数可带多个 option string（-o / --output），记录全部用于回显
                if name.startswith("-"):
                    parsed["option_strings"] = names
                arg_defs.append(parsed)
        elif isinstance(func, ast.Attribute) and func.attr == "ArgumentParser":
            for kw in node.keywords:
                if kw.arg == "prog" and kw.value is not None:
                    prog = _safe_literal(kw.value)
                if kw.arg == "description" and kw.value is not None:
                    description = _safe_literal(kw.value)
            # 也支持 argparse.ArgumentParser(...) 形式（func.value 是 Attribute）
        elif isinstance(func, ast.Name) and func.id == "ArgumentParser":
            for kw in node.keywords:
                if kw.arg == "prog" and kw.value is not None:
                    prog = _safe_literal(kw.value)
                if kw.arg == "description" and kw.value is not None:
                    description = _safe_literal(kw.value)

    if not arg_defs:
        return None

    # 必选参数置顶：required 的在前，其余保持声明顺序
    arg_defs.sort(key=lambda a: (0 if a["required"] else 1))

    return {
        "prog": prog,
        "description": description,
        "args": arg_defs,
    }


def analyze_script(path: str) -> dict[str, Any]:
    """分析单个脚本文件，返回结构化信息。"""
    p = Path(path)
    try:
        source = p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        # 尝试其他常见编码
        try:
            source = p.read_text(encoding="gbk")
        except (OSError, UnicodeDecodeError):
            return {"path": str(p), "name": p.name, "ok": False, "error": "无法读取文件编码"}
    schema = parse_argparse_schema(source)
    if schema is None:
        return {
            "path": str(p),
            "name": p.name,
            "ok": False,
            "error": "未检测到 argparse 参数定义（不符合约定）",
        }
    return {
        "path": str(p),
        "name": schema.get("prog") or p.stem,
        "ok": True,
        "schema": schema,
        "arg_count": len(schema["args"]),
    }
