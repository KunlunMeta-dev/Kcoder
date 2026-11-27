"""Build a sealed, relocatable SearXNG component. End users need no Python/uv."""
import argparse
import hashlib
import json
import os
import platform as host_platform
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
PIN = json.loads((HERE / "upstream.json").read_text())


def is_native_target(target, system=None, machine=None):
    system = sys.platform if system is None else system
    machine = host_platform.machine().lower() if machine is None else machine.lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    family = {"linux": "linux", "win32": "win", "darwin": "mac"}.get(system)
    return arch is not None and family is not None and target == f"{family}-{arch}"


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(*args):
    subprocess.run(list(map(str, args)), check=True, timeout=600)


def download_source(cache):
    archive = cache / ("searxng-" + PIN["commit"] + ".tar.gz")
    if not archive.exists():
        handle, name = tempfile.mkstemp(prefix=".searxng-download-", dir=cache)
        os.close(handle)
        temporary = Path(name)
        try:
            with urllib.request.urlopen(PIN["sourceUrl"], timeout=60) as response, temporary.open("wb") as output:
                total = 0
                while chunk := response.read(128 * 1024):
                    total += len(chunk)
                    if total > 100 * 1024 * 1024:
                        raise ValueError("SearXNG source archive exceeds 100 MiB")
                    output.write(chunk)
            if sha(temporary) != PIN["sourceSha256"]:
                raise ValueError("SearXNG source archive hash mismatch")
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    if sha(archive) != PIN["sourceSha256"]:
        raise ValueError("Cached SearXNG source hash mismatch")
    return archive


def copy_python(source, destination, windows):
    def ignored(directory, names):
        skip = {name for name in names if name in {"__pycache__", "__tests__", "__fixtures__"} or name.endswith((".pyc", ".pyo"))}
        if Path(directory).name == "site-packages":
            # Dependency installation belongs to the build host. In particular,
            # pip's foreign-architecture launchers are not service resources.
            skip |= {name for name in names if name == "pip" or (name.startswith("pip-") and name.endswith(".dist-info"))}
        if Path(directory).name in {"Scripts", "bin"}:
            skip |= {name for name in names if re.fullmatch(r"pip(?:3(?:\.\d+)?)?(?:\.exe)?", name)}
        if Path(directory) == source and windows:
            # uv creates a host-only alias when cross-staging Windows on Unix.
            skip |= {name for name in names if name == "python" and (source / name).is_symlink()}
        return skip

    for path in source.rglob("*"):
        if path.is_symlink() and not (windows and path.name == "python" and path.parent == source):
            if not path.resolve(strict=True).is_relative_to(source):
                raise ValueError("Python runtime contains an external symbolic link")
    shutil.copytree(source, destination, symlinks=False, ignore=ignored)


def stage_source(archive, fresh):
    extracted = fresh / ".source-extract"
    extracted.mkdir()
    with tarfile.open(archive) as bundle:
        total = 0
        selected = []
        prefix = "searxng-" + PIN["commit"] + "/"
        for member in bundle:
            if not (member.name.startswith(prefix + "searx/") or member.name == prefix + "LICENSE"):
                continue
            total += member.size
            if not (member.isfile() or member.isdir()) or total > 256 * 1024 * 1024:
                raise ValueError("Unexpected SearXNG source archive entry or size")
            selected.append(member)
        bundle.extractall(extracted, members=selected, filter="data")
    original = extracted / ("searxng-" + PIN["commit"])
    target = fresh / "source" / "searx"
    target.parent.mkdir()
    shutil.copytree(original / "searx", target)
    frozen = (
        '# SPDX-License-Identifier: AGPL-3.0-or-later\n'
        + "VERSION_STRING = " + repr(PIN["version"]) + "\n"
        + "VERSION_TAG = VERSION_STRING\nDOCKER_TAG = VERSION_STRING.replace('+', '-')\n"
        + "GIT_URL = " + repr(PIN["repository"]) + "\nGIT_BRANCH = 'master'\n"
    )
    (target / "version_frozen.py").write_text(frozen)
    valkey = target / "valkeydb.py"
    text = valkey.read_text()
    old = '        _pw = pwd.getpwuid(os.getuid())\n        logger.exception("[%s (%s)] can\'t connect valkey DB ...", _pw.pw_name, _pw.pw_uid)'
    if text.count(old) != 1 or text.count("import os\nimport pwd\n") != 1:
        raise ValueError("Pinned SearXNG Valkey adaptation no longer matches")
    valkey.write_text(text.replace("import os\nimport pwd\n", "").replace(old, '        logger.exception("Cannot connect to the configured Valkey DB")'))
    shutil.copy2(original / "LICENSE", fresh / "SEARXNG-LICENSE.txt")
    shutil.copy2(archive, fresh / "SEARXNG-SOURCE.tar.gz")
    shutil.rmtree(extracted)


def seal(root, platform):
    for path in sorted(root.rglob("*"), reverse=True):
        if path.is_dir() and path.name in {"__pycache__", "__tests__", "__fixtures__"}:
            shutil.rmtree(path)
        elif path.is_file() and path.suffix in {".pyc", ".pyo"}:
            path.unlink()
    manifest = {
        "schemaVersion": 1, "serviceProtocolVersion": 1, "platform": platform,
        "python": PIN["platforms"][platform]["python"], "pythonVersion": PIN["pythonVersion"],
        "upstream": PIN, "requirementsSha256": sha(HERE / "requirements.lock"),
        "launcherSha256": sha(root / "launch.py"),
        "egressSha256": sha(root / "egress.py"),
    }
    (root / "runtime-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Runtime staging retained a symbolic link")
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            files[relative] = {"bytes": path.stat().st_size, "sha256": sha(path)}
    (root / "files.sha256.json").write_text(json.dumps({"schemaVersion": 1, "files": files}, indent=2) + "\n")


def prepare(args):
    target = PIN["platforms"][args.platform]
    output = args.destination.resolve()
    cache = args.cache.resolve()
    if output.exists():
        verify(output, args.platform)
        print(json.dumps({"status": "verified", "platform": args.platform, "destination": str(output)}))
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    expected_uv = PIN["pythonBuildTool"].split()[1]
    found = subprocess.check_output([args.uv, "--version"], text=True).split()[1]
    if found != expected_uv:
        raise ValueError("SearXNG preparation requires pinned uv " + expected_uv)
    archive = download_source(cache)
    run(args.uv, "python", "install", target["pythonKey"], "--install-dir", cache / "python", "--no-bin", "--no-registry", "--no-config")
    python_root = (cache / "python" / target["pythonKey"]).resolve(strict=True)
    if not python_root.is_relative_to(cache / "python"):
        raise ValueError("Managed Python escaped its dedicated cache")
    with tempfile.TemporaryDirectory(prefix=".searxng-build-", dir=output.parent) as temporary:
        fresh = Path(temporary) / "runtime"
        fresh.mkdir()
        copy_python(python_root, fresh / "python", args.platform == "win-x64")
        run(args.uv, "pip", "install", "--no-config", "--system-certs", "--require-hashes", "--only-binary", ":all:", "--python-version", PIN["pythonVersion"], "--python-platform", target["wheelPlatform"], "--target", fresh / "packages", "-r", HERE / "requirements.lock")
        # Console entry points contain build-host paths; the service imports packages directly.
        for directory in [fresh / "packages/bin", fresh / "packages/Scripts"]:
            if directory.exists():
                shutil.rmtree(directory)
        stage_source(archive, fresh)
        shutil.copy2(HERE / "launch.py", fresh / "launch.py")
        shutil.copy2(HERE / "egress.py", fresh / "egress.py")
        build_source = fresh / "build-source"
        build_source.mkdir()
        for name in ["prepare.py", "launch.py", "egress.py", "upstream.json", "requirements.in", "requirements.lock"]:
            shutil.copy2(HERE / name, build_source / name)
        # Translation compilation only imports Babel's pure Python modules, also for cross-builds.
        sys.path.insert(0, str(fresh / "packages"))
        from babel.messages.pofile import read_po
        from babel.messages.mofile import write_mo
        for po in (fresh / "source/searx/translations").rglob("*.po"):
            with po.open("rb") as stream:
                catalog = read_po(stream)
            with po.with_suffix(".mo").open("wb") as stream:
                write_mo(stream, catalog)
        seal(fresh, args.platform)
        native = is_native_target(args.platform)
        if native:
            run(fresh / target["python"], "-I", "-B", fresh / "launch.py", "--check")
        fresh.rename(output)
    print(json.dumps({"status": "prepared", "platform": args.platform, "destination": str(output), "inventorySha256": sha(output / "files.sha256.json"), "nativeImportsChecked": native}))


def verify(root, platform):
    manifest = json.loads((root / "runtime-manifest.json").read_text())
    if manifest.get("platform") != platform or manifest.get("upstream") != PIN or manifest.get("launcherSha256") != sha(HERE / "launch.py") or manifest.get("egressSha256") != sha(HERE / "egress.py") or manifest.get("requirementsSha256") != sha(HERE / "requirements.lock"):
        raise ValueError("Existing search runtime has different inputs; preserve it and prepare a fresh destination")
    if (root / "build-source/prepare.py").read_bytes() != (HERE / "prepare.py").read_bytes():
        raise ValueError("Existing search runtime has a different build recipe; preserve it and prepare a fresh destination")
    inventory = json.loads((root / "files.sha256.json").read_text())["files"]
    observed = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("Search runtime contains a symbolic link")
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            if relative == "files.sha256.json":
                continue
            observed.add(relative)
            if inventory.get(relative) != {"bytes": path.stat().st_size, "sha256": sha(path)}:
                raise ValueError("Existing search runtime inventory mismatch")
    if observed != set(inventory):
        raise ValueError("Existing search runtime is incomplete")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", choices=PIN["platforms"], required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=REPO / "target/cache/searxng")
    parser.add_argument("--uv", default="uv")
    prepare(parser.parse_args())
