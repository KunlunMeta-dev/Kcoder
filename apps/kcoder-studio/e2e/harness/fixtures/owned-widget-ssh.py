"""Owned physical-host fixture controller. Never reads an account's KCoder configuration."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time

root = Path(sys.argv[1])
nonce = sys.argv[2]
if not re.fullmatch(r"/tmp/kcoder-widget-e2e-[a-f0-9]{24}", str(root)):
    raise RuntimeError("invalid owned remote root")
if not re.fullmatch(r"[a-f0-9]{32}", nonce):
    raise RuntimeError("invalid owner nonce")
os.mkdir(root, 0o700)
identity = os.lstat(root)
owner = {"nonce": nonce, "uid": os.getuid(), "dev": identity.st_dev, "ino": identity.st_ino}
with os.fdopen(os.open(root / "owner.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
    json.dump(owner, output)
for name in ["config", "home", "workspace"]:
    os.mkdir(root / name, 0o700)

def verify():
    current = os.lstat(root)
    if not stat.S_ISDIR(current.st_mode) or stat.S_ISLNK(current.st_mode) or current.st_uid != owner["uid"] or current.st_mode & 0o777 != 0o700 or current.st_dev != owner["dev"] or current.st_ino != owner["ino"]:
        raise RuntimeError("remote owner identity changed")
    if json.loads((root / "owner.json").read_text()) != owner:
        raise RuntimeError("remote owner proof changed")

def active_binary():
    expected = str(root / "kcoder").encode()
    for item in Path("/proc").iterdir():
        if not item.name.isdigit():
            continue
        try:
            args = (item / "cmdline").read_bytes().split(b"\0")
            if args and args[0] == expected:
                return True
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    return False

def cleanup():
    verify()
    deadline = time.monotonic() + 6
    while active_binary() and time.monotonic() < deadline:
        time.sleep(0.05)
    if active_binary():
        raise RuntimeError("owned remote app-server is still running; root retained")
    shutil.rmtree(root)

def write_leaf(name, value, mode=0o600):
    path = root / name
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode), "w") as output:
        output.write(value)

print(json.dumps({"ready": True, "root": str(root), "uid": owner["uid"], "dev": owner["dev"], "ino": owner["ino"]}), flush=True)
cleaned = False
try:
    for line in sys.stdin:
        if len(line) > 1024 * 1024:
            raise RuntimeError("remote control request exceeds budget")
        request = json.loads(line)
        verify()
        action = request.get("action")
        result = None
        if action == "configure":
            write_leaf("config/settings.json", json.dumps(request["settings"]))
            quote = lambda value: "'" + value.replace("'", "'\\''") + "'"
            launcher = "#!/bin/sh\nexport KCODER_CONFIG_DIR=" + quote(str(root / "config")) + "\nexport XDG_CONFIG_HOME=" + quote(str(root / "config")) + "\nexport HOME=" + quote(str(root / "home")) + "\nexec " + quote(str(root / "kcoder")) + " --settings-file " + quote(str(root / "config/settings.json")) + ' "$@"\n'
            write_leaf("launcher", launcher, 0o700)
            write_leaf("workspace/README.md", "owned physical widget runtime fixture\n")
            result = {"configured": True}
        elif action == "verify_binary":
            info = os.lstat(root / "kcoder")
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != owner["uid"]:
                raise RuntimeError("remote binary must be an owned ordinary file")
            digest = hashlib.sha256()
            with (root / "kcoder").open("rb") as binary:
                for chunk in iter(lambda: binary.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != request["sha256"]:
                raise RuntimeError("remote binary digest mismatch")
            os.chmod(root / "kcoder", 0o700)
            result = {"sha256": digest.hexdigest(), "bytes": info.st_size}
        elif action == "cleanup":
            cleanup()
            cleaned = True
            result = {"cleaned": True}
        else:
            raise RuntimeError("unsupported remote fixture action")
        print(json.dumps({"id": request["id"], "result": result}), flush=True)
        if cleaned:
            break
finally:
    if not cleaned:
        cleanup()
