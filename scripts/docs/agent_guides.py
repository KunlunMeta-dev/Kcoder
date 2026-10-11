"""Validate versioned agent-guide scope, inheritance and module coverage."""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
import re
import subprocess


def tracked_guides(root):
    names = subprocess.check_output(
        ["git", "ls-files", "-z", "AGENTS.md", "**/AGENTS.md"], cwd=root
    ).decode().split("\0")
    return set(filter(None, names))


def relative_path(value, allow_root=False):
    if not isinstance(value, str) or not value:
        return False
    if allow_root and value == ".":
        return True
    path = PurePosixPath(value)
    return (
        not path.is_absolute()
        and not any(part in {".", ".."} for part in value.split("/"))
        and "\\" not in value
        and str(path) == value
    )


def guide_inventory(root, modules):
    errors = []
    inventory = root / "docs/agent-guides.json"
    try:
        data = json.loads(inventory.read_text())
    except (OSError, ValueError) as error:
        return set(), [f"Cannot read agent-guide inventory: {error}"]
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        return set(), ["Unsupported agent-guide inventory schema"]
    entries = data.get("guides")
    if not isinstance(entries, list):
        return set(), ["Agent-guide inventory guides must be an array"]
    guides = {}
    scopes = set()
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("Agent-guide entry must be an object")
            continue
        name, scope = entry.get("path"), entry.get("scope")
        title, parent = entry.get("title"), entry.get("parent")
        if not relative_path(name) or not relative_path(scope, allow_root=True):
            errors.append(f"Invalid agent-guide path/scope: {name!r}, {scope!r}")
            continue
        expected = "AGENTS.md" if scope == "." else f"{scope}/AGENTS.md"
        if name != expected:
            errors.append(f"Agent-guide scope does not match path: {name} -> {scope}")
            continue
        if name in guides or scope in scopes:
            errors.append(f"Duplicate agent-guide path/scope: {name}")
            continue
        if not isinstance(title, str) or not title.strip():
            errors.append(f"Missing agent-guide title: {name}")
        if parent is not None and not relative_path(parent):
            errors.append(f"Invalid agent-guide parent: {name}")
            continue
        file = root / name
        if not file.resolve().is_relative_to(root.resolve()):
            errors.append(f"Agent-guide escapes repository: {name}")
            continue
        guides[name] = entry
        scopes.add(scope)
        if not file.is_file():
            errors.append(f"Missing required agent guide: {name}")
        else:
            actual = re.search(r"^#\s+(.+)$", file.read_text(), re.M)
            if not actual or actual[1] != title:
                errors.append(f"Agent-guide title/scope drift: {name}")
    if "AGENTS.md" not in guides:
        errors.append("Missing repository agent-guide entry")
    for name, entry in guides.items():
        directory = PurePosixPath(name).parent
        candidates = [
            other for other in guides
            if other != name and PurePosixPath(other).parent in directory.parents
        ]
        parent = max(candidates, key=lambda item: len(PurePosixPath(item).parts), default=None)
        if entry.get("parent") != parent:
            errors.append(f"Agent-guide parent must be nearest ancestor: {name} -> {parent}")
    for name in sorted(tracked_guides(root) - guides.keys()):
        errors.append(f"Uninventoried tracked agent guide: {name}")
    for module in modules:
        scope = module["path"]
        name = f"{scope}/AGENTS.md"
        if name not in guides:
            errors.append(f"Uncovered module agent guide: {scope}")
    return set(guides), errors
