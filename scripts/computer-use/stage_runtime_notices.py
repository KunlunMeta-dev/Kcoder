"""Materialize version-bound notices into a fresh, not-yet-sealed runtime."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re


def verified_file(root, relative, expected):
    path = PurePosixPath(relative)
    if path.is_absolute() or not path.parts or ".." in path.parts or "\\" in relative or ":" in relative:
        raise ValueError("Invalid supplemental resource path")
    source = root / path
    if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(root):
        raise ValueError("Supplemental resource is missing or linked outside root")
    data = source.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Supplemental resource digest mismatch; review the new runtime version")
    return data


def stage(root, supplements):
    root, supplements = Path(root).resolve(strict=True), Path(supplements).resolve(strict=True)
    destination = root / "licenses/runtime"
    if destination.exists():
        raise ValueError("Runtime notice destination already exists")
    index_bytes = (supplements / "index.json").read_bytes()
    index = json.loads(index_bytes)
    if index.get("schemaVersion") != 1 or not index.get("components"):
        raise ValueError("Invalid supplemental notice index")
    pending = {}
    for component in index["components"]:
        for field in ("name", "version"):
            if not re.fullmatch(r"[A-Za-z0-9_+-][A-Za-z0-9_.+-]*", component[field]):
                raise ValueError("Invalid supplemental component identity")
        if not component.get("binaries") or not component.get("notices"):
            raise ValueError("Supplemental notices must bind actual binaries")
        for binary in component["binaries"]:
            verified_file(root, binary["path"], binary["sha256"])
        for notice in component["notices"]:
            if not re.fullmatch(r"[A-Za-z0-9_+-][A-Za-z0-9_.+-]*", notice["file"]):
                raise ValueError("Invalid supplemental notice filename")
            data = verified_file(supplements, notice["file"], notice["sha256"])
            if len(data) > 4 * 1024 * 1024:
                raise ValueError("Supplemental notice is too large")
            name = f'{component["name"]}-{component["version"]}/LICENSE-{notice["file"]}'
            if name in pending:
                raise ValueError("Duplicate supplemental notice")
            pending[name] = data
    # All pins validate before creating any destination resource. A failed build
    # must never leave a misleading notice for a different library version.
    destination.mkdir(parents=True)
    for name, data in pending.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as file:
            file.write(data)
    (destination / "index.json").write_bytes(index_bytes)
    return len(pending)


if __name__ == "__main__":
    import sys
    print(json.dumps({"supplementalNotices": stage(sys.argv[1], sys.argv[2])}))
