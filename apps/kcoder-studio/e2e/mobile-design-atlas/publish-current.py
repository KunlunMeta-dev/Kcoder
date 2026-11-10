"""Run over the authorized SSH connection; publish only the owned current-V3 atlas."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

expected_hash, release_id, archive_path = sys.argv[1:]
assert re.fullmatch(r"[0-9a-f]{64}", expected_hash)
assert re.fullmatch(r"[0-9]{8}-[0-9]{6}", release_id)
archive = Path(archive_path)
assert archive == Path("/opt/kcoder-design-atlas-v1") / ("current-v3-" + release_id + ".tar.gz")
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected_hash
release = Path("/var/www/kcoder-review") / ("mobile-design-atlas-current-v3-" + release_id)
assert not release.exists()
release.mkdir(mode=0o755)
with tarfile.open(archive) as bundle:
    for entry in bundle.getmembers():
        path = PurePosixPath(entry.name)
        assert not path.is_absolute() and ".." not in path.parts and entry.isfile()
    bundle.extractall(release)
for path in release.rglob("*"):
    os.chmod(path, 0o755 if path.is_dir() else 0o644)
catalog = json.loads((release / "catalog.json").read_text())
assert catalog["v3Only"] and catalog["edition"] == "05"
for state in catalog["states"]:
    assert state["transition"]["from"] and state["transition"]["trigger"]["steps"] and state["transition"]["next"]
    assert state["version"] == "V3" and state["freshness"] == "本次组件采样"
    assert state["rendererTreeSha256"] == catalog["rendererTreeSha256"]
    for variant in state["variants"]:
        assert variant["source"].startswith("current-fixture/App.tsx?")
        assert hashlib.sha256((release / variant["image"]).read_bytes()).hexdigest() == variant["sha256"]
unit = Path("/etc/systemd/system/kcoder-design-atlas-v1.service")
assert unit.is_file() and "/opt/kcoder-design-atlas-v1/atlas-server" in unit.read_text()
drop_dir = Path(str(unit) + ".d")
assert (drop_dir / "02-content.conf").is_file()
drop = drop_dir / "90-current-content.conf"
previous = drop.read_bytes() if drop.exists() else None
staged = drop_dir / ".90-current-content.conf.tmp"
assert not staged.exists()
staged.write_text("[Service]\nExecStart=\nExecStart=/opt/kcoder-design-atlas-v1/atlas-server -root " + str(release)
                + " -config /etc/kcoder-design-atlas-v1/auth.json -listen 127.0.0.1:18673\n")
os.chmod(staged, 0o644)
os.replace(staged, drop)
try:
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "restart", "kcoder-design-atlas-v1.service"], check=True)
    for _ in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:18673/fixtures/mobile-design-atlas-v1/login", timeout=2) as response:
                assert response.status == 200
            break
        except (urllib.error.URLError, OSError):
            time.sleep(0.1)
    else:
        raise RuntimeError("Owned atlas did not become healthy")
    try:
        urllib.request.urlopen("http://127.0.0.1:18673/fixtures/mobile-design-atlas-v1/catalog.json", timeout=2)
        raise RuntimeError("Public catalog must require a session")
    except urllib.error.HTTPError as error:
        assert error.code == 401
    print(json.dumps({"edition": catalog["edition"], "v3Only": True, "states": len(catalog["states"]), "pngs": catalog["imageCount"],
                      "sourceTreeSha256": catalog["rendererTreeSha256"], "release": str(release)}))
except Exception:
    if previous is None:
        drop.unlink(missing_ok=True)
    else:
        staged.write_bytes(previous)
        os.chmod(staged, 0o644)
        os.replace(staged, drop)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "restart", "kcoder-design-atlas-v1.service"], check=True)
    raise
