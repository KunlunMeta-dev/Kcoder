"""Collect actual distribution notices; missing files remain release blockers."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil


def collect(root):
    root = Path(root).resolve(strict=True)
    inventory = json.loads((root / "dependency-inventory.json").read_text(encoding="utf-8"))
    destination = root / "licenses" / "packages"
    if destination.exists():
        raise ValueError("License collection destination already exists")
    overrides_root = Path(__file__).resolve().parent / "license-overrides"
    overrides = json.loads((overrides_root / "index.json").read_text()) if (overrides_root / "index.json").is_file() else {}
    records = []
    missing = []
    for package in inventory["packages"]:
        name, version = package["name"], package["version"]
        if not re.fullmatch(r"[A-Za-z0-9_.+-]+", name) or not re.fullmatch(r"[A-Za-z0-9_.+-]+", version):
            raise ValueError("Invalid distribution identity")
        files = []
        for relative in package["licenseFiles"]:
            path = PurePosixPath(relative)
            if path.is_absolute() or ".." in path.parts or "\\" in relative or ":" in relative:
                raise ValueError("License path escapes package root")
            source = root / "packages" / path
            if source.is_symlink() or not source.is_file() or source.stat().st_size > 4 * 1024 * 1024:
                raise ValueError("License resource is missing, linked or too large")
            if not source.resolve().is_relative_to(root / "packages"):
                raise ValueError("License resolves outside package root")
            target = destination / f"{name}-{version}" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            files.append({"path": target.relative_to(root).as_posix(), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
        override = overrides.get(f"{name}=={version}")
        if not files and override:
            filename = override["file"]
            if Path(filename).name != filename:
                raise ValueError("Invalid supplemental license path")
            source = overrides_root / filename
            data = source.read_bytes()
            if hashlib.sha256(data).hexdigest() != override["sha256"]:
                raise ValueError("Supplemental license digest mismatch")
            target = destination / f"{name}-{version}" / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            files.append({"path": target.relative_to(root).as_posix(), "sha256": override["sha256"], "source": override["source"]})
        if not files:
            missing.append(f"{name}=={version}")
        records.append({"name": name, "version": version, "licenseExpression": package.get("licenseExpression"), "files": files})
    result = {"schemaVersion": 1, "reviewStatus": "pending", "missingNotices": missing, "packages": records}
    (root / "third-party-notices.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    import sys
    result = collect(sys.argv[1])
    print(json.dumps({"packages": len(result["packages"]), "missingNotices": result["missingNotices"], "reviewStatus": "pending"}))
