"""Freeze reviewed checkout source into a root-owned acceptance fixture.

Input ownership is not authority. Only bounded, stable, single-link source
bytes are copied; the authority loader later enforces its original root checks
against the independently owned destination and recorded hashes.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat

OIDC_DATA = ("requirements.in", "requirements.lock", "dependencies.json", "README.md")


def root_directory(path):
    path = Path(path)
    if os.geteuid() != 0 or not path.is_absolute() or ".." in path.parts:
        raise RuntimeError("Trusted fixture staging requires root and an absolute destination")
    for item in reversed((path, *path.parents)):
        try: item.mkdir(mode=0o700)
        except FileExistsError: pass
        info = item.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise RuntimeError("Trusted fixture destination has an unsafe ancestor")
    return path


def stable_bytes(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 4 * 1024 * 1024:
            raise RuntimeError("Fixture source must be a bounded single-link regular file")
        raw = source.read(4 * 1024 * 1024 + 1)
        after = os.fstat(source.fileno())
        fields = lambda info: (info.st_dev, info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if len(raw) > 4 * 1024 * 1024 or fields(before) != fields(after):
            raise RuntimeError("Fixture source changed during snapshot")
    return raw, before


def stage(source, destination):
    source = Path(source).resolve(strict=True)
    destination = Path(destination)
    root_directory(destination.parent)
    destination.mkdir(mode=0o700)
    inventory = []
    for directory in ("lib", "installers", "tests"):
        for path in sorted((source / directory).rglob("*.py")):
            if "__pycache__" not in path.parts:
                inventory.append(path.relative_to(source))
    inventory.extend(Path("oidc") / name for name in OIDC_DATA)
    if not inventory:
        raise RuntimeError("Fixture source inventory is empty")
    files = []
    for relative in inventory:
        input_path = source / relative
        for parent in input_path.parents:
            if parent == source: break
            if parent.is_symlink():
                raise RuntimeError("Fixture source contains a symlink ancestor")
        raw, info = stable_bytes(input_path)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw); output.flush(); os.fsync(output.fileno())
        digest = hashlib.sha256(raw).hexdigest()
        verified, staged_info = stable_bytes(target)
        if staged_info.st_uid != 0 or staged_info.st_mode & 0o077 or hashlib.sha256(verified).hexdigest() != digest:
            raise RuntimeError("Trusted fixture snapshot verification failed")
        files.append({"path": str(relative), "sha256": digest, "bytes": len(raw),
                      "sourceUid": info.st_uid, "sourceDevice": info.st_dev, "sourceInode": info.st_ino})
    ancestors = [{"path": str(path), "uid": path.lstat().st_uid, "mode": oct(path.lstat().st_mode & 0o7777)}
                 for path in (source, *source.parents)]
    manifest = {"version": 1, "source": str(source), "sourceAncestors": ancestors,
                "destination": str(destination), "files": files}
    raw = (json.dumps(manifest, indent=2) + "\n").encode()
    path = destination / "source-manifest.json"
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(raw); output.flush(); os.fsync(output.fileno())
    return {"sourceRoot": str(destination), "manifest": str(path), "manifestSha256": hashlib.sha256(raw).hexdigest(), "fileCount": len(files)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(stage(args.source, args.destination)))
