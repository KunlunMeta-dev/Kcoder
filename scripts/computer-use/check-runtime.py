"""Build-time checks; no desktop imports, screenshots, clicks or network access."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import ssl
import sqlite3
import zlib

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "packages"))
from thefuzz import process

cases = [
    ("Notepad", ["Notepad", "Calculator"], "Notepad"),
    ("notepad", ["NOTEPAD", "Paint"], "NOTEPAD"),
    ("记事本", ["计算器", "记事本"], "记事本"),
    ("记事本 - 测试文档", ["记事本 - 测试文档", "记事本 - 其他文档"], "记事本 - 测试文档"),
    ("Paint", ["Paint", "Paint"], "Paint"),
]
for query, choices, expected in cases:
    matched = process.extractOne(query, choices, score_cutoff=70)
    assert matched and len(matched) == 2 and matched[0] == expected, (query, matched)
assert process.extractOne("zzzzzz", ["Notepad"], score_cutoff=70) is None
assert process.extractOne("Notepad", [], score_cutoff=70) is None
packages = []
for distribution in importlib.metadata.distributions(path=[str(root / "packages")]):
    name = distribution.metadata["Name"]
    assert name.lower().replace("_", "-") not in {"fuzzywuzzy", "python-levenshtein", "levenshtein"}
    licenses = [str(path) for path in distribution.files or []
                if any(word in str(path).lower() for word in ("license", "copying", "notice"))]
    packages.append({"name": name, "version": distribution.version,
                     "licenseExpression": distribution.metadata.get("License-Expression"),
                     "license": distribution.metadata.get("License"),
                     "licenseFiles": licenses})
result = {"matchingCasesPassed": len(cases) + 2,
          "nativeVersions": {
              "python": sys.version.split()[0],
              "openssl": ssl.OPENSSL_VERSION,
              "sqlite": sqlite3.sqlite_version,
              "zlib": {name: getattr(zlib, name) for name in dir(zlib)
                       if "VERSION" in name and isinstance(getattr(zlib, name), (str, int, tuple))},
          },
          "requirementsSha256": hashlib.sha256((root / "requirements.txt").read_bytes()).hexdigest(),
          "packages": sorted(packages, key=lambda item: item["name"].lower()),
          "desktopProbe": "not_run", "licenseReview": "pending"}
output = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "dependency-inventory.json"
output.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({"matchingCasesPassed": len(cases) + 2, "packages": len(packages),
                  "nativeVersions": result["nativeVersions"], "desktopProbe": "not_run"}))
