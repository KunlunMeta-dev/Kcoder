"""Owned runner fixture: optionally change a tracked file during one suite."""
import json
import sys
from pathlib import Path

output = Path(sys.argv[1])
if sys.argv[2] == "mutate":
    Path("marker.txt").write_text("changed during suite\n", encoding="utf-8")
elif sys.argv[2] != "clean":
    raise SystemExit("unsupported fixture mode")
(output / "assertions.json").write_text(
    json.dumps({"ok": True, "checks": [{"name": "fixture executed", "ok": True}]}) + "\n",
    encoding="utf-8",
)
