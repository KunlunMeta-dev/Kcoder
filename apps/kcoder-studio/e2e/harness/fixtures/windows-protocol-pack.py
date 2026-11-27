"""Archive only caller-selected regular source files, preserving repository paths."""
import json
from pathlib import Path
import stat
import sys
import zipfile

root = Path(sys.argv[1]).resolve()
manifest = json.loads(Path(sys.argv[2]).read_text())
with zipfile.ZipFile(sys.argv[3], "x", compression=zipfile.ZIP_DEFLATED) as archive:
    for relative in manifest:
        if not relative.startswith("apps/kcoder-studio/e2e/harness/") or ".." in Path(relative).parts:
            raise RuntimeError("Source archive path escaped the selected harness")
        source = root / relative
        if source.is_symlink() or not stat.S_ISREG(source.lstat().st_mode):
            raise RuntimeError("Source archive requires ordinary files")
        archive.write(source, relative)
