"""Collect audited system programs and their ELF closure into a new owned rootfs."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import sysconfig


def digest(data):
    return hashlib.sha256(data).hexdigest()


def collect(output, native, expected_native):
    if os.geteuid() != 0 or sys.executable != "/usr/bin/python3":
        raise RuntimeError("Explicit system Python and root-owned preparation required")
    if not output.is_absolute() or output.exists():
        raise RuntimeError("Rootfs output must be a new absolute owned directory")
    if digest(native.read_bytes()) != expected_native:
        raise RuntimeError("Original immutable Native SHA mismatch")
    output.mkdir(mode=0o700)
    entries = {}
    pending = []
    observed_elf = set()
    total = 0

    def copy(source, destination):
        nonlocal total
        source = source.resolve(strict=True)
        if not any(source.is_relative_to(Path(root)) for root in ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64"]):
            raise RuntimeError("System program/library escaped the explicit source roots")
        if destination in entries:
            if entries[destination]["source"] != str(source):
                raise RuntimeError("Two system sources collided in the rootfs")
            return
        info = source.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_size > 512 * 1024 * 1024:
            raise RuntimeError("Untrusted system rootfs input")
        with source.open("rb") as stream:
            data = stream.read()
        after = source.stat()
        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError("System input changed while collecting")
        if len(data) != info.st_size:
            raise RuntimeError("System input changed size")
        relative = destination.lstrip("/")
        if not relative or ".." in Path(relative).parts:
            raise RuntimeError("Rootfs destination escaped")
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        os.chmod(target, 0o555 if info.st_mode & 0o111 or data.startswith(b"\x7fELF") else 0o444)
        total += len(data)
        if total > 1024 * 1024 * 1024 or len(entries) > 20000:
            raise RuntimeError("Offline rootfs exceeded its bounds")
        entries[destination] = {"source": str(source), "bytes": len(data), "sha256": digest(data), "uid": 0, "mode": oct(target.stat().st_mode & 0o777)}
        if data.startswith(b"\x7fELF"):
            pending.append(source)

    cache = subprocess.check_output(["/sbin/ldconfig", "-p"], text=True, env={"PATH": "/usr/bin:/bin", "LANG": "C"})
    libraries = {}
    for line in cache.splitlines():
        match = re.match(r"\s*(\S+) \([^)]*x86-64[^)]*\) => (\S+)", line)
        if match:
            libraries.setdefault(match[1], Path(match[2]))
    programs = ["/usr/bin/python3", "/usr/bin/python3.12", "/usr/sbin/sshd", "/usr/bin/ssh-keygen", "/bin/sh", "/bin/bash", "/usr/bin/env", "/usr/bin/id", "/usr/bin/cat", "/usr/bin/sleep"]
    for program in programs:
        copy(Path(program), program)
    stdlib = Path(sysconfig.get_path("stdlib"))
    if stdlib != Path("/usr/lib/python3.12"):
        raise RuntimeError("Only the system Python standard library is allowed")
    excluded = {"site-packages", "dist-packages", "__pycache__", "test", "tests", "ensurepip", "idlelib", "tkinter", "turtledemo", "venv"}
    for directory, names, files in os.walk(stdlib):
        names[:] = sorted(name for name in names if name not in excluded)
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink() or path.suffix in {".pyc", ".pyo", ".pth"}:
                continue
            copy(path, str(path))
    pending.append(native)
    for optional in ["libnss_files.so.2", "libnss_dns.so.2", "libnss_compat.so.2"]:
        if optional in libraries:
            copy(libraries[optional], str(libraries[optional]))
    while pending:
        program = pending.pop()
        if program in observed_elf:
            continue
        observed_elf.add(program)
        dynamic = subprocess.check_output(["/usr/bin/readelf", "-d", str(program)], text=True, env={"PATH": "/usr/bin:/bin", "LANG": "C"})
        for name in re.findall(r"\(NEEDED\).*\[([^\]]+)\]", dynamic):
            if name not in libraries:
                raise RuntimeError("Unresolved system ELF dependency: " + name)
            copy(libraries[name], str(libraries[name]))
        headers = subprocess.check_output(["/usr/bin/readelf", "-l", str(program)], text=True, env={"PATH": "/usr/bin:/bin", "LANG": "C"})
        interpreter = re.search(r"Requesting program interpreter: ([^\]]+)", headers)
        if interpreter:
            copy(Path(interpreter[1]), interpreter[1])

    generated = {
        "/etc/passwd": "root:x:0:0:Owned fixture controller:/root:/bin/sh\nsshd:x:74:74:Owned privilege separation:/run/sshd:/bin/sh\n",
        "/etc/group": "root:x:0:\nsshd:x:74:\n",
        "/etc/shadow": "root:*:0:0:99999:7:::\nsshd:*:0:0:99999:7:::\n",
        "/etc/nsswitch.conf": "passwd: files\ngroup: files\nshadow: files\nhosts: files dns\n",
        "/etc/shells": "/bin/sh\n/bin/bash\n",
        "/etc/hosts": "127.0.0.1 localhost\n::1 localhost\n",
        "/etc/ssh/sshd_config": "# Fixture runtime supplies a fresh explicit configuration and keys.\nPasswordAuthentication no\nUsePAM no\n",
    }
    for name, text in generated.items():
        path = output / name.lstrip("/")
        path.parent.mkdir(parents=True, exist_ok=True)
        data = text.encode()
        path.write_bytes(data)
        os.chmod(path, 0o600 if name == "/etc/shadow" else 0o644)
        entries[name] = {"source": "generated_test_only", "bytes": len(data), "sha256": digest(data), "uid": 0, "mode": oct(path.stat().st_mode & 0o777)}
    for name in ["/proc", "/dev", "/sys", "/run/sshd", "/root", "/tmp", "/owned", "/runtime", "/fixture"]:
        (output / name.lstrip("/")).mkdir(parents=True, exist_ok=True)
    for directory, _names, _files in os.walk(output):
        os.chmod(directory, 0o755)
    os.chmod(output / "tmp", 0o1777)
    encoded = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    return {"schemaVersion": 1, "source": "system_programs_recursive_elf_and_system_python_stdlib", "nativeDependencyInput": {"path": str(native), "sha256": expected_native, "copiedIntoImage": False}, "files": entries, "fileCount": len(entries), "bytes": sum(entry["bytes"] for entry in entries.values()), "rootfsSha256": digest(encoded), "hostEtcCopied": False, "hostAccountDatabaseCopied": False, "hostKeysCopied": False, "python": "/usr/bin/python3", "pythonVersion": sys.version.split()[0]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--native-sha256", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    arguments = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{64}", arguments.native_sha256):
        raise SystemExit("Explicit Native SHA required")
    manifest = collect(arguments.output, arguments.native, arguments.native_sha256)
    arguments.manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({key: value for key, value in manifest.items() if key != "files"}))
