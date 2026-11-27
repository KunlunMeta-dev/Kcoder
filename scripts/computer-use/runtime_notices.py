"""Inventory interpreter/vendor notices and native binaries without claiming
that presence of a license file proves redistribution compliance."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re


def entry(root, path):
    return {"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def inspect(root):
    root = Path(root).resolve(strict=True)
    manifest = json.loads((root / "runtime-manifest.json").read_text(encoding="utf-8-sig"))
    relative = PurePosixPath(manifest["python"].replace("\\", "/"))
    if relative.is_absolute() or ".." in relative.parts or ":" in str(relative):
        raise ValueError("Interpreter path escapes runtime")
    interpreter = root / relative
    if not interpreter.resolve(strict=True).is_relative_to(root / "runtime"):
        raise ValueError("Interpreter must belong to the bundled runtime")
    python_license = interpreter.parent / "LICENSE.txt"
    if not python_license.is_file():
        raise ValueError("Bundled Python license is missing")
    notices, native = [], []
    subtrees = [root / "runtime", root / "packages"]
    if (root / "licenses/runtime").exists():
        subtrees.append(root / "licenses/runtime")
    for subtree in subtrees:
        if not subtree.is_dir() or subtree.is_symlink():
            raise ValueError("Runtime subtree is missing or linked")
        for path in sorted(subtree.rglob("*")):
            if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
                raise ValueError("Linked runtime resources are not allowed")
            if not path.is_file():
                continue
            if re.match(r"^(licen[sc]e|copying|copyright|notice|authors)([.\-_]|$)", path.name, re.I):
                if path.stat().st_size > 4 * 1024 * 1024:
                    raise ValueError("Notice resource is too large")
                notices.append(entry(root, path))
            if path.suffix.lower() in {".dll", ".pyd"}:
                native.append(entry(root, path))
    if not any(item["path"] == python_license.relative_to(root).as_posix() for item in notices):
        raise ValueError("Python license was not inventoried")
    return {"schemaVersion": 1, "reviewStatus": "pending",
            "pythonVersion": manifest["pythonVersion"],
            "pythonLicense": python_license.relative_to(root).as_posix(),
            "notices": notices, "nativeBinaries": native,
            "nativeAttributionReviewRequired": True}


if __name__ == "__main__":
    import sys
    result = inspect(sys.argv[1])
    # Explicit output lets audits leave an already sealed prototype untouched.
    destination = Path(sys.argv[2])
    with destination.open("x", encoding="utf-8") as output:
        json.dump(result, output, indent=2)
        output.write("\n")
    print(json.dumps({"notices": len(result["notices"]),
                      "nativeBinaries": len(result["nativeBinaries"]),
                      "reviewStatus": result["reviewStatus"]}))
