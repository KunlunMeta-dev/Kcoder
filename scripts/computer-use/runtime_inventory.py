"""Deterministic build-time inventory. Verification never imports bundle code."""
import argparse
import hashlib
import json
from pathlib import Path

INVENTORY = "files.sha256.json"


def inventory(root):
    root = Path(root).resolve(strict=True)
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise ValueError(f"Linked runtime resource: {path.relative_to(root)}")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if relative == INVENTORY:
            continue
        if "__pycache__" in path.parts or path.suffix == ".pyc":
            raise ValueError(f"Mutable Python cache inside runtime: {relative}")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        result[relative] = {"sha256": digest.hexdigest(), "bytes": path.stat().st_size}
    return result


def seal(root):
    root = Path(root)
    payload = {"schemaVersion": 1, "files": inventory(root)}
    (root / INVENTORY).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def verify(root):
    root = Path(root)
    expected = json.loads((root / INVENTORY).read_text(encoding="utf-8"))
    if expected.get("schemaVersion") != 1 or expected.get("files") != inventory(root):
        raise ValueError("Runtime files differ from sealed inventory")
    return len(expected["files"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["seal", "verify"])
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    if args.operation == "seal":
        seal(args.root)
    print(json.dumps({"verifiedFiles": verify(args.root)}))
