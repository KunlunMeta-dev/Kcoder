#!/usr/bin/env python3
"""Record comparable Cargo builds without sharing artifacts with other worktrees."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
try:
    import resource
except ImportError:
    resource = None


def capture(argv, cwd):
    return subprocess.check_output(argv, cwd=cwd, text=True).strip()


def timing_units(html):
    match = re.search(r"const UNIT_DATA = (\[.*?\]);", html, re.S)
    return json.loads(match.group(1)) if match else []


def save_record(path, record):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n")
    temporary.replace(path)


def source_identity(root):
    diff = subprocess.check_output(["git", "diff", "HEAD", "--binary"], cwd=root)
    untracked = capture(["git", "ls-files", "--others", "--exclude-standard"], root).splitlines()
    digest = hashlib.sha256(capture(["git", "rev-parse", "HEAD"], root).encode() + b"\0")
    digest.update(diff)
    for name in sorted(untracked):
        digest.update(name.encode() + b"\0")
        digest.update((root / name).read_bytes())
    return digest.hexdigest()


def host_sample():
    result = {"loadavg": list(os.getloadavg())} if hasattr(os, "getloadavg") else {}
    memory = Path("/proc/meminfo")
    if memory.exists():
        result["memory_kib"] = {
            line.split(":")[0]: int(line.split()[1])
            for line in memory.read_text().splitlines()
            if line.startswith(("MemAvailable:", "MemTotal:"))
        }
    return result


def checkout_target(root):
    """Refuse primary checkouts and redirected build directories before any clean."""
    git_marker = root / ".git"
    if git_marker.is_symlink() or not git_marker.is_file():
        raise ValueError("run this benchmark from an isolated linked Git worktree")
    target = root / "target"
    for path in [target, target / "debug", *(
        target / "debug" / name for name in ["deps", "build", "incremental", ".fingerprint"]
    )]:
        if path.is_symlink() or path.resolve() != path:
            raise ValueError(f"refusing redirected build directory: {path}")
    return target


def build_environment_identity(env):
    selected = {
        key: value for key, value in env.items()
        if key.startswith(("RUST", "CARGO_PROFILE_", "CARGO_BUILD_"))
        or (key.startswith("CARGO_TARGET_") and key != "CARGO_TARGET_DIR")
        or key in {"CARGO_ENCODED_RUSTFLAGS", "CARGO_INCREMENTAL"}
    }
    return hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True)
    parser.add_argument("--jobs", type=int, default=6)
    rebuild = parser.add_mutually_exclusive_group()
    rebuild.add_argument("--rebuild-workspace", action="store_true")
    rebuild.add_argument("--rebuild-package", action="store_true")
    parser.add_argument("--package", default="kcoder_cli")
    parser.add_argument("--bin", default="kcoder")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.label) or args.jobs < 1:
        parser.error("label must be a filename-safe identifier and jobs must be positive")

    root = Path(__file__).resolve().parents[2]
    # This directory is deliberately fixed to this source checkout. Never clean
    # the caller's ambient CARGO_TARGET_DIR or a different worktree's artifacts.
    try:
        target = checkout_target(root)
    except ValueError as error:
        parser.error(str(error))
    evidence = target / "build-metrics" / args.label
    evidence.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, CARGO_TARGET_DIR=str(target))
    metadata = json.loads(capture([
        "cargo", "metadata", "--offline", "--locked", "--no-deps", "--format-version", "1",
    ], root))
    members = set(metadata["workspace_members"])
    packages = [p["name"] for p in metadata["packages"] if p["id"] in members]
    command = [
        "cargo", "build", "--offline", "--locked", "-p", args.package,
        "--bin", args.bin, "--jobs", str(args.jobs), "--timings",
    ]
    record = {
        "label": args.label, "workspace": str(root),
        "commit": capture(["git", "rev-parse", "HEAD"], root),
        "source_diff_sha256": source_identity(root),
        "status": capture(["git", "status", "--short"], root),
        "rustc": capture(["rustc", "-Vv"], root),
        "cargo": capture(["cargo", "-V"], root),
        "root_manifest_sha256": hashlib.sha256((root / "Cargo.toml").read_bytes()).hexdigest(),
        "build_environment_sha256": build_environment_identity(env),
        "command": command, "target_dir": str(target),
        "incremental": env.get("CARGO_INCREMENTAL", "profile-default"),
        "scenario": ("dependencies-warm-workspace-rebuild" if args.rebuild_workspace
                     else "package-rebuild" if args.rebuild_package else "as-is-cache"),
        "host_start": host_sample(), "started_unix": time.time(),
    }
    save_record(evidence / "run.json", record)
    if args.rebuild_workspace or args.rebuild_package:
        clean = ["cargo", "clean", "--offline", "--target-dir", str(target)]
        for package in packages if args.rebuild_workspace else [args.package]:
            clean.extend(["-p", package])
        with (evidence / "clean.log").open("w") as log:
            subprocess.run(clean, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    start = time.monotonic()
    usage_start = resource.getrusage(resource.RUSAGE_CHILDREN) if resource else None
    try:
        with (evidence / "cargo.log").open("w") as log:
            with subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT) as child:
                while True:
                    try:
                        record["exit_code"] = child.wait(timeout=30)
                        break
                    except subprocess.TimeoutExpired:
                        elapsed = round(time.monotonic() - start, 3)
                        record.setdefault("samples", []).append(dict(seconds=elapsed, **host_sample()))
                        save_record(evidence / "run.json", record)
                        print(f"{args.label}: running {elapsed:.0f}s; log: {evidence / 'cargo.log'}", flush=True)
    finally:
        record["elapsed_seconds"] = round(time.monotonic() - start, 3)
        record["host_end"] = host_sample()
        record["source_consistent"] = source_identity(root) == record["source_diff_sha256"]
        if resource:
            usage = resource.getrusage(resource.RUSAGE_CHILDREN)
            record["cpu_user_seconds"] = round(usage.ru_utime - usage_start.ru_utime, 3)
            record["cpu_system_seconds"] = round(usage.ru_stime - usage_start.ru_stime, 3)
            record["peak_child_rss_platform_units"] = usage.ru_maxrss
        reports = sorted((target / "cargo-timings").glob("cargo-timing-*.html"), key=lambda p: p.stat().st_mtime)
        if reports and reports[-1].stat().st_mtime >= record["started_unix"]:
            html = reports[-1].read_text()
            (evidence / "cargo-timing.html").write_text(html)
            record["units"] = timing_units(html)
        save_record(evidence / "run.json", record)
    print(f"{args.label}: {record['elapsed_seconds']:.3f}s, exit={record.get('exit_code', 'interrupted')}", flush=True)
    units = sorted(record.get("units", []), key=lambda u: u.get("duration", 0), reverse=True)
    for unit in units[:12]:
        print(f"  {unit['name']}: {unit['duration']:.3f}s")
    print(evidence / "run.json")
    return record["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
