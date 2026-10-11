#!/usr/bin/env python3
"""Check repository documentation coverage, links, examples and source references."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit

from generate_references import generated_files, jsonc, rust_brace_end
from agent_guides import guide_inventory, tracked_guides
from source_facts import claim_errors


ROOT = Path(__file__).resolve().parents[2]
LINK = re.compile(r"!?\[[^\]\n]*\]\(([^)\n]+)\)")


def prose_lines(text):
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        match = re.match(r"^\s*(`{3,}|~{3,})(.*)$", line)
        if match:
            marker, language = match.groups()
            if fence is None:
                fence = marker[0]
            elif marker[0] == fence:
                fence = None
            continue
        if fence is None:
            yield number, line


def slug(value):
    value = re.sub(r"[`*_]", "", value).lower()
    value = re.sub(r"[^\w\s-]", "", value)
    return re.sub(r"\s+", "-", value.strip())


def link_errors(root, file):
    errors = []
    for number, line in prose_lines(file.read_text()):
        for match in LINK.finditer(line):
            target = match[1].strip()
            if target.startswith("<") and ">" in target:
                target = target[1:target.index(">")]
            else:
                target = target.split(' "', 1)[0]
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc:
                continue
            relative = unquote(parsed.path)
            resolved = (file.parent / relative).resolve() if relative else file.resolve()
            if not resolved.is_relative_to(root.resolve()):
                errors.append(f"{file.relative_to(root)}:{number}: link escapes repository: {target}")
                continue
            if not resolved.exists():
                errors.append(f"{file.relative_to(root)}:{number}: missing link: {target}")
                continue
            fragment = unquote(parsed.fragment)
            if fragment and resolved.is_file():
                if re.fullmatch(r"L\d+(?:-L\d+)?", fragment):
                    maximum = int(re.findall(r"\d+", fragment)[-1])
                    if maximum > len(resolved.read_text().splitlines()):
                        errors.append(f"{file.relative_to(root)}:{number}: source line outside file: {target}")
                elif resolved.suffix == ".md":
                    headings = {
                        slug(m[1]) for raw in resolved.read_text().splitlines()
                        if (m := re.match(r"^#{1,6}\s+(.+)", raw))
                    }
                    if fragment not in headings and f'id="{fragment}"' not in resolved.read_text():
                        errors.append(f"{file.relative_to(root)}:{number}: missing heading: {target}")
    return errors


def example_errors(root, file):
    errors = []
    text = file.read_text()
    for match in re.finditer(r"^```(json|jsonc)\s*\n(.*?)^```\s*$", text, re.M | re.S):
        try:
            jsonc(match[2]) if match[1] == "jsonc" else json.loads(match[2])
        except (ValueError, KeyError) as error:
            line = text.count("\n", 0, match.start()) + 1
            errors.append(f"{file.relative_to(root)}:{line}: invalid {match[1]} example: {error}")
    markers = [line for line in text.splitlines() if re.match(r"^\s*(`{3,}|~{3,})", line)]
    if len(markers) % 2:
        errors.append(f"{file.relative_to(root)}: unclosed code fence")
    return errors


def tracked_packages(root):
    names = subprocess.check_output(
        ["git", "ls-files", "-z", "*/Cargo.toml", "*/package.json"], cwd=root
    ).decode().split("\0")
    for name in filter(None, names):
        parts = Path(name).parts
        if any(part in {"fixtures", "node_modules", "target", "workspace-template"} for part in parts):
            continue
        yield str(Path(name).parent)


def check(root=ROOT, public_snapshot=False):
    errors = []
    if public_snapshot:
        for name in ["docs", "DESIGN.md", "CONTEXT.md"]:
            if (root / name).exists():
                errors.append(f"Public source snapshot contains private documentation: {name}")
        for name in sorted(tracked_guides(root) | ({"AGENTS.md"} if (root / "AGENTS.md").exists() else set())):
            errors.append(f"Public source snapshot contains private agent guide: {name}")
        file = root / "README.md"
        return link_errors(root, file) + example_errors(root, file) + errors
    manifest = json.loads((root / "docs/coverage.json").read_text())
    paths = set(manifest["requiredDocs"] + manifest["generatedReferences"])
    guides, guide_errors = guide_inventory(root, manifest["modules"])
    paths.update(guides)
    errors.extend(guide_errors)
    errors.extend(claim_errors(root, rust_brace_end))
    roots = set()
    for module in manifest["modules"]:
        roots.add(module["path"])
        paths.add(module["readme"])
        paths.update(module.get("topics", []))
        for source in module.get("sources", []):
            if not (root / source).is_file():
                errors.append("Missing module source: " + source)
    for package in tracked_packages(root):
        if package not in roots:
            errors.append("Uncovered source package: " + package)
    for name in sorted(paths):
        file = root / name
        if not file.is_file():
            errors.append("Missing required document: " + name)
            continue
        text = file.read_text()
        if not re.search(r"^#\s+\S", text, re.M):
            errors.append("Missing document title: " + name)
        if re.search(r"^(?:TODO|TBD|待补充|占位文档)\s*$", text, re.M):
            errors.append("Unfinished document: " + name)
        errors.extend(link_errors(root, file))
        errors.extend(example_errors(root, file))
    if root.resolve() == ROOT.resolve():
        for name, expected in generated_files().items():
            file = root / name
            if not file.exists() or file.read_text() != expected:
                errors.append("Stale generated reference: " + name)
    print(f"Documentation coverage: {len(roots)} modules, {len(guides)} agent guides, {len(paths)} documents, {len(errors)} errors")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-snapshot", action="store_true")
    args = parser.parse_args()
    errors = check(public_snapshot=args.public_snapshot)
    for error in errors:
        print(error)
    return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())
