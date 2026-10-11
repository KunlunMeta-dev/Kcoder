#!/usr/bin/env python3
"""Check tracked support scripts without importing or executing their workloads."""

import ast
import pathlib
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parents[2]


def main():
    files = subprocess.check_output(
        ["git", "ls-files", "-z"], cwd=ROOT
    ).decode().split("\0")
    failures = []
    checked = 0
    for name in filter(None, files):
        path = ROOT / name
        if not path.is_file() or path.is_symlink():
            continue
        if not name.startswith(("scripts/", "skills/", "tools/", "site/", "apps/kcoder-relay/")):
            continue
        if path.suffix not in (".py", ".sh", ".bash", ".js", ".mjs", ".cjs"):
            continue
        checked += 1
        try:
            if path.suffix == ".py":
                ast.parse(path.read_text(encoding="utf-8"), filename=name)
            elif path.suffix in (".sh", ".bash"):
                subprocess.run(["bash", "-n", str(path)], check=True)
            elif path.suffix in (".js", ".mjs", ".cjs"):
                subprocess.run(["node", "--check", str(path)], check=True)
            else:
                continue
        except (OSError, SyntaxError, UnicodeError, subprocess.CalledProcessError) as error:
            failures.append(f"{name}: {error}")
    if not checked:
        raise RuntimeError("No tracked support scripts were checked")
    print(f"Support script syntax: {checked} files, {len(failures)} failures")
    for failure in failures:
        print(failure, file=sys.stderr)
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
