#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes the coding agent to trigger (read the skill)
for a set of queries. Outputs results as JSON.
"""

import argparse
import json
import os
import re
import sys
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from scripts.agent_cli import AgentCLI
from scripts.utils import parse_skill_md


def find_project_root(backend: str | None = None) -> Path:
    """Use the selected backend's project discovery convention."""
    backend = backend or os.environ.get("SKILL_EVAL_BACKEND", "kcoder")
    current = Path.cwd()
    marker = ".kcoder" if backend == "kcoder" else ".claude"
    for parent in [current, *current.parents]:
        if (parent / marker).is_dir():
            return parent
    return current


def run_single_query(
    query: str, skill_name: str, skill_description: str, timeout: int,
    project_root: str, model: str | None = None,
    backend: str | None = None, cli: str | None = None,
) -> bool:
    """Register a unique temporary skill and await a successful CLI result."""
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", skill_name):
        raise RuntimeError("Skill name must be a safe single directory component")
    adapter = AgentCLI.configured(backend, cli)
    adapter.preflight(Path(project_root))
    clean_name = f"{skill_name[:24]}-eval-{uuid.uuid4().hex}"
    root = Path(project_root).resolve()
    if adapter.backend == "kcoder":
        skill_directory = root / ".kcoder" / "skills" / clean_name
        skill_directory.mkdir(parents=True, exist_ok=False)
        command_file = skill_directory / "SKILL.md"
    else:
        skill_directory = None
        project_commands = root / ".claude" / "commands"
        project_commands.mkdir(parents=True, exist_ok=True)
        command_file = project_commands / f"{clean_name}.md"
    try:
        indented_description = "\n  ".join(skill_description.split("\n"))
        command_file.write_text(
            f"---\nname: {clean_name}\ndescription: |\n  {indented_description}\n---\n\n"
            f"# {skill_name}\n\nThis skill handles: {skill_description}\n", encoding="utf-8")
        return adapter.collect(query, root, timeout, model, clean_name).triggered
    finally:
        command_file.unlink(missing_ok=True)
        if skill_directory is not None:
            skill_directory.rmdir()


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
    backend: str | None = None,
    cli: str | None = None,
) -> dict:
    """Run the full eval set and return results."""
    if not eval_set or num_workers < 1 or runs_per_query < 1 or timeout <= 0 or not 0 <= trigger_threshold <= 1:
        raise ValueError("Evaluation requires queries, positive worker/run/time limits, and a threshold between 0 and 1")
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    str(project_root),
                    model,
                    backend,
                    cli,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        query_errors: dict[str, list[str]] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                query_errors.setdefault(query, []).append(str(e))

    for query, triggers in query_triggers.items():
        item = query_items[query]
        errors = query_errors.get(query, [])
        trigger_rate = sum(triggers) / len(triggers) if triggers else None
        should_trigger = item["should_trigger"]
        if errors:
            did_pass = None
        elif should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
            "infrastructure_errors": errors,
        })

    passed = sum(1 for r in results if r["pass"] is True)
    total = sum(1 for r in results if r["pass"] is not None)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
            "infrastructure_errors": sum(len(errors) for errors in query_errors.values()),
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--backend", choices=["kcoder", "claude"], default=None, help="CLI protocol backend (default: kcoder or SKILL_EVAL_BACKEND)")
    parser.add_argument("--cli", default=None, help="Executable for the selected backend (or SKILL_EVAL_CLI)")
    parser.add_argument("--model", default=None, help="Model to use for the agent CLI (default: user's configured model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root(args.backend)

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
        backend=args.backend,
        cli=args.cli,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "INFRASTRUCTURE ERROR" if r["infrastructure_errors"] else ("PASS" if r["pass"] else "FAIL")
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))
    if output["summary"]["infrastructure_errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
