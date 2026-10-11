#!/usr/bin/env python3
"""Check CI package-manager pins and discovered CLI integration-test coverage."""
from __future__ import annotations

import json
import argparse
from collections import Counter
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[2]
PNPM_ROOTS = ("apps/kcoder-studio", "apps/kcoder-studio/renderer")


def cli_targets(root):
    directory = root / "crates/kcoder_cli"
    cargo = tomllib.loads((directory / "Cargo.toml").read_text())
    targets = set()
    if cargo["package"].get("autotests", True):
        targets.update(path.stem for path in (directory / "tests").glob("*.rs"))
        targets.update(path.parent.name for path in (directory / "tests").glob("*/main.rs"))
    targets.update(target["name"] for target in cargo.get("test", []))
    return targets


def covered_cli_targets(command, targets):
    if command[:2] != ["cargo", "test"]:
        return set()
    arguments = command[2:command.index("--")] if "--" in command else command[2:]
    packages = [arguments[i + 1] for i, value in enumerate(arguments[:-1]) if value in ("-p", "--package")]
    excludes = [arguments[i + 1] for i, value in enumerate(arguments[:-1]) if value == "--exclude"]
    if "kcoder_cli" not in packages and not ("--workspace" in arguments and "kcoder_cli" not in excludes):
        return set()
    selected = [arguments[i + 1] for i, value in enumerate(arguments[:-1]) if value == "--test"]
    if selected:
        return targets.intersection(selected)
    if "--all-targets" in arguments or not set(arguments).intersection({"--bin", "--lib", "--example", "--bench", "--doc"}):
        return targets
    return set()


def check(root=ROOT):
    errors = []
    managers = []
    for name in PNPM_ROOTS:
        manager = json.loads((root / name / "package.json").read_text()).get("packageManager", "")
        if not re.fullmatch(r"pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f\d]+)?", manager):
            errors.append(f"Missing exact pnpm packageManager: {name}")
        managers.append(manager.split("+", 1)[0])
    if len(set(managers)) != 1:
        errors.append("Studio and renderer pnpm versions disagree")
    expected = managers[0]
    workflow = (root / ".github/workflows/ci.yml").read_text().split("\njobs:\n", 1)[1]
    jobs = list(re.finditer(r"^  ([\w-]+):\s*$", workflow, re.M))
    for index, job in enumerate(jobs):
        body = workflow[job.end():jobs[index + 1].start() if index + 1 < len(jobs) else len(workflow)]
        if re.search(r"\bpnpm\s+(?:--dir|store|install|exec|build)\b", body):
            if f"corepack prepare {expected} --activate" not in body:
                errors.append(f"Unpinned pnpm job: {job[1]}")
    targets = cli_targets(root)
    matrix = tomllib.loads((root / "tests/matrix.toml").read_text())
    roster = json.loads((root / "tests/ignored-tests.linux.json").read_text())
    workspace = next(suite for suite in matrix["suite"] if suite["id"] == "rust-workspace")
    if workspace["summary"]["expected_skips"]["linux"] != len(roster["cases"]):
        errors.append("Linux ignored count disagrees with the reviewed named roster")
    for tier in ("pr", "full"):
        covered = set()
        for suite in matrix["suite"]:
            if tier in suite["tiers"]:
                covered.update(covered_cli_targets(suite["command"], targets))
        if missing := targets - covered:
            errors.append(f"CLI integration targets missing from {tier}: {', '.join(sorted(missing))}")
    return errors


def ignored_differences(expected, output):
    actual = Counter(re.findall(r"^(.+): test$", output, re.M))
    expected = Counter(expected)
    errors = []
    if added := actual - expected:
        errors.append("Unreviewed ignored cases: " + ", ".join(sorted(added.elements())))
    if removed := expected - actual:
        errors.append("Ignored cases disappeared: " + ", ".join(sorted(removed.elements())))
    return errors


def check_runtime_ignored(root=ROOT):
    if sys.platform != "linux":
        return ["Linux ignored inventory requires an actual Linux test build"]
    matrix = tomllib.loads((root / "tests/matrix.toml").read_text())
    suite = next(suite for suite in matrix["suite"] if suite["id"] == "rust-workspace")
    command = suite["command"] + ["--", "--list", "--ignored"]
    allowed = ("PATH", "HOME", "CARGO_HOME", "RUSTUP_HOME", "RUSTC_WRAPPER", "CC", "CXX", "PKG_CONFIG_PATH", "RUSTFLAGS", "RUSTDOCFLAGS", "LD_LIBRARY_PATH", "TMPDIR", "CARGO_TARGET_DIR")
    environment = {name: os.environ[name] for name in allowed if name in os.environ}
    process = subprocess.Popen(command, cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=900)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
        return ["Ignored inventory compilation/listing timed out; owned process group stopped"]
    if process.returncode:
        return [f"Ignored inventory compilation/listing failed ({process.returncode}); no tests were executed"]
    expected = json.loads((root / "tests/ignored-tests.linux.json").read_text())["cases"]
    return ignored_differences(expected, stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-ignored", action="store_true", help="compile/list ignored Linux cases without executing them")
    args = parser.parse_args()
    errors = check()
    if args.check_ignored and not errors:
        errors.extend(check_runtime_ignored())
    for error in errors:
        print(error)
    print(f"Quality contracts: {len(errors)} errors")
    return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())
