#!/usr/bin/env python3
"""Compare completed build records only when measurement conditions match."""

import argparse
import json
from pathlib import Path


def comparison_key(record):
    return tuple(json.dumps(record.get(key), sort_keys=True) for key in (
        "command", "scenario", "rustc", "incremental", "root_manifest_sha256",
        "build_environment_sha256",
    ))


def succeeded(record):
    elapsed = record.get("elapsed_seconds")
    return (record.get("exit_code") == 0 and elapsed is not None
            and record.get("source_consistent", True))


def render(records):
    lines = [
        "| 测量 | 场景 | 耗时 | 相对同条件首个成功样本 | 结果 |",
        "| --- | --- | ---: | ---: | --- |",
    ]
    baselines = {}
    for record in records:
        elapsed = record.get("elapsed_seconds")
        success = succeeded(record)
        delta = "—"
        if success:
            key = comparison_key(record)
            baseline = baselines.setdefault(key, elapsed)
            if baseline:
                delta = f"{(elapsed / baseline - 1) * 100:+.1f}%"
        result = ("成功" if success else "源码在测量中变化" if record.get("source_consistent") is False
                  else "失败" if record.get("exit_code") is not None else "进行中／未完成")
        seconds = f"{elapsed:.3f}s" if elapsed is not None else "—"
        lines.append(f"| {record['label']} | {record['scenario']} | {seconds} | {delta} | {result} |")
    lines += ["", "共享服务器负载与样本数量仍影响可比性；首次依赖构建、单包重编译、workspace 重编译及原缓存构建分别比较。"]
    return "\n".join(lines) + "\n"



def render_reference(records, reference, goal_percent):
    baseline = reference["elapsed_seconds"]
    goal_seconds = baseline * (1 - goal_percent / 100)
    lines = [
        "",
        f"指定基线 `{reference['label']}` 为 {baseline:.3f}s，"
        f"缩短 {goal_percent:g}% 需要达到 {goal_seconds:.3f}s。",
        "本表要求相同的测量场景、构建命令和工具链。配置差异与主机负载会影响结果。",
        "",
        "| 测量 | 比指定基线缩短 | 距目标还需缩短 | CLI runtime | Rust 前端 |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    condition = ("scenario", "command", "rustc", "cargo")
    for record in records:
        if not succeeded(record) or any(record.get(key) != reference.get(key) for key in condition):
            continue
        elapsed = record["elapsed_seconds"]
        runtime = next((unit for unit in record.get("units", [])
                        if unit["name"] == "kcoder_cli_runtime" and unit["target"] == ""), None)
        runtime_time = f"{runtime['duration']:.2f}s" if runtime else "—"
        frontend = dict(runtime.get("sections") or []).get("frontend") if runtime else None
        frontend_time = f"{frontend['end'] - frontend['start']:.2f}s" if frontend else "—"
        lines.append(
            f"| {record['label']} | {(1 - elapsed / baseline) * 100:.2f}% | "
            f"{max(0, elapsed - goal_seconds):.3f}s | {runtime_time} | {frontend_time} |"
        )
    return "\n".join(lines) + "\n"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("records", nargs="+", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--reference", help="Label of an explicit baseline for cross-profile comparison")
    parser.add_argument("--goal-percent", type=float, default=50)
    args = parser.parse_args()
    if not 0 < args.goal_percent < 100:
        parser.error("--goal-percent must be between 0 and 100")
    records = [json.loads(path.read_text()) for path in args.records]
    report = render(records)
    if args.reference:
        candidates = [record for record in records
                      if record["label"] == args.reference and succeeded(record)]
        if len(candidates) != 1 or candidates[0]["elapsed_seconds"] <= 0:
            parser.error("--reference must identify exactly one successful record with positive duration")
        report += render_reference(records, candidates[0], args.goal_percent)
    if args.output:
        args.output.write_text(report)
    print(report, end="")


if __name__ == "__main__":
    main()
