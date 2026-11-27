"""Rebuild the pinned Windows worker on Linux; validate it in an owned Wine prefix."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile


HERE = Path(__file__).resolve().parent
PYTHON_VERSION = "3.14.6"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def windows_pe(path, library=False):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Windows interpreter input must be a single-link regular file")
    with path.open("rb") as stream:
        dos = stream.read(64)
        if len(dos) != 64 or dos[:2] != b"MZ":
            raise ValueError("Windows PE interpreter input required")
        offset = struct.unpack_from("<I", dos, 60)[0]
        if not 64 <= offset <= 1024 * 1024:
            raise ValueError("Invalid Windows PE header offset")
        stream.seek(offset)
        pe = stream.read(24)
    if (len(pe) != 24 or pe[:4] != b"PE\0\0"
            or struct.unpack_from("<H", pe, 4)[0] != 0x8664
            or bool(struct.unpack_from("<H", pe, 22)[0] & 0x2000) != library):
        raise ValueError("Windows x64 PE kind does not match interpreter input")


def extract_source(archive, destination, expected):
    archive, destination = Path(archive), Path(destination)
    if archive.is_symlink() or archive.stat().st_size > 64 * 1024 * 1024 or digest(archive) != expected:
        raise ValueError("Pinned upstream source archive hash mismatch")
    if destination.exists():
        raise ValueError("Source destination must be fresh")
    with zipfile.ZipFile(archive) as bundle:
        entries, seen, total = bundle.infolist(), set(), 0
        if len(entries) > 20000:
            raise ValueError("Upstream source entry budget exceeded")
        for entry in entries:
            name = entry.filename.rstrip("/")
            parts = name.split("/")
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if (not name or len(name) > 2048 or any(part in {"", ".", ".."} for part in parts)
                    or any(char in name for char in "\\:\0")
                    or kind not in {0, stat.S_IFREG, stat.S_IFDIR}
                    or name.casefold() in seen or entry.file_size > 16 * 1024 * 1024):
                raise ValueError("Unsafe upstream source archive entry")
            seen.add(name.casefold())
            total += entry.file_size
            if total > 256 * 1024 * 1024:
                raise ValueError("Upstream source byte budget exceeded")
        if not {"pyproject.toml", "license.md", "src/windows_mcp/__main__.py"} <= seen:
            raise ValueError("Pinned flat git-archive source layout required")
        destination.mkdir()
        bundle.extractall(destination)


def clean_build_bytecode(root):
    for path in sorted(Path(root).rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_symlink():
            raise ValueError("Linked runtime resource is not allowed")
        if path.is_dir() and path.name == "__pycache__":
            shutil.rmtree(path)
        elif path.is_file() and path.suffix == ".pyc":
            path.unlink()


class Build:
    def __init__(self, args, work):
        self.args, self.work = args, work
        self.recipe = args.recipe_root.resolve()
        self.root = work / "component"
        self.prefix = work / "wine-prefix"
        self.logs = work / "logs"
        self.logs.mkdir()
        self.steps = []
        self.env = dict(os.environ, WINEPREFIX=str(self.prefix), WINEDEBUG="-all",
                        WINEDLLOVERRIDES="winemenubuilder.exe=d", ANONYMIZED_TELEMETRY="false",
                        WINDOWS_MCP_WATCHDOG="false", PYTHONDONTWRITEBYTECODE="1")
        for key in ["PYTHONHOME", "PYTHONPATH", "UV_PYTHON", "UV_PROJECT_ENVIRONMENT"]:
            self.env.pop(key, None)

    def run(self, name, command, timeout=180):
        path = self.logs / (name + ".log")
        # Wine must receive pipe handles, rather than inheriting a POSIX regular
        # log descriptor which Windows Python rejects during stream startup.
        child = subprocess.Popen(list(map(str, command)), env=self.env, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        row = {"step": name, "pid": child.pid, "log": str(path), "exited": False}
        self.steps.append(row)
        try:
            content = child.communicate(timeout=timeout)[0]
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                content = child.communicate(timeout=5)[0]
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                content = child.communicate(timeout=5)[0]
            path.write_bytes(content[-8 * 1024 * 1024:])
            row["timedOut"] = True
            raise RuntimeError("Build step timed out: " + name) from None
        except BaseException:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
            try:
                content = child.communicate(timeout=5)[0]
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                content = child.communicate(timeout=5)[0]
            path.write_bytes(content[-8 * 1024 * 1024:])
            row["cancelled"] = True
            raise
        finally:
            row["exited"] = child.poll() is not None
        path.write_bytes(content[-8 * 1024 * 1024:])
        row["exitCode"] = child.returncode
        if child.returncode != 0:
            raise RuntimeError("Build step failed: " + name)
        return path.read_text(encoding="utf-8", errors="replace")

    def host(self, name, script, *arguments):
        return self.run(name, [self.args.host_python, "-I", "-B", script, *arguments])

    @staticmethod
    def winpath(path):
        return "Z:" + str(Path(path).resolve()).replace("/", "\\")

    def windows(self, name, *arguments):
        return self.run(name, [self.args.xvfb_run, "-a", self.args.wine,
                              self.python, *arguments], timeout=90)

    def check_runtime(self, name, bytecode_flag=True):
        output = self.windows(name, "-I", *(["-B"] if bytecode_flag else []),
                              self.winpath(self.root / "launch.py"), "--kcoder-runtime-check")
        values = []
        for line in output.splitlines():
            try:
                values.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        if not any(isinstance(value, dict) and value.get("python") == PYTHON_VERSION
                   and value.get("desktopProbe") == "not_run" and value.get("dependencies")
                   for value in values):
            raise RuntimeError("Windows runtime import proof missing: " + name)

    def prepare(self):
        pin = json.loads((self.recipe / "upstream.json").read_text())
        source = self.root / "source"
        self.root.mkdir()
        extract_source(self.args.source_archive, source, pin["sourceArchiveSha256"])
        interpreter = self.args.python_runtime.resolve()
        windows_pe(interpreter / "python.exe")
        windows_pe(interpreter / "python314.dll", True)
        runtime = self.root / "runtime" / "cpython-3.14.6-windows-x86_64-none"
        # uv exposes one host-only alias for foreign interpreters. All shipped
        # inputs are copied into new ordinary files before applying any patch.
        for path in interpreter.rglob("*"):
            if path.is_symlink() and not (path.parent == interpreter and path.name == "python"):
                raise ValueError("Unexpected linked interpreter input")
        shutil.copytree(interpreter, runtime, ignore=lambda directory, names:
                        [name for name in names if Path(directory) == interpreter and name == "python"
                         and (interpreter / name).is_symlink()])
        self.python = str(runtime / "python.exe")
        self.run("wine-initialize", [self.args.xvfb_run, "-a", self.args.wine, "wineboot", "--init"])
        if (self.prefix / "dosdevices/z:").resolve() != Path("/"):
            raise ValueError("Owned Wine prefix has an unexpected Z drive")
        version = self.windows("windows-python-version", "-I", "-B", "-c",
                               "import sys; print('PYTHON_READY', sys.version.split()[0])")
        if "PYTHON_READY " + PYTHON_VERSION not in version:
            raise ValueError("Pinned Windows Python version proof missing")
        desktop = source / "src/windows_mcp/desktop/service.py"
        text = desktop.read_text()
        if text.count("from fuzzywuzzy import process") != 1:
            raise ValueError("Expected upstream matching import is missing")
        desktop.write_text(text.replace("from fuzzywuzzy import process", "from thefuzz import process"))
        project = source / "pyproject.toml"
        text = project.read_text()
        for dependency in ['    "fuzzywuzzy>=0.18.0",', '    "python-levenshtein>=0.27.1",']:
            if text.count(dependency) != 1:
                raise ValueError("Expected upstream matching dependency is missing")
            text = text.replace(dependency, "")
        project.write_text(text)
        patches = [("input_cleanup", desktop), ("input_tagging", source / "src/windows_mcp/uia/core.py"),
                   ("uia_threading", source / "src/windows_mcp/uia/core.py"), ("snapshot_scope", desktop),
                   ("screenshot_frame", source / "src/windows_mcp"), ("clipboard_paste", desktop),
                   ("clear_text", desktop), ("unicode_input", source / "src/windows_mcp/uia/core.py"),
                   ("shortcut_input", source / "src/windows_mcp/uia/core.py")]
        for helper, destination in [("screenshot_frame.py", "kcoder_screenshot_frame.py"),
                                    ("clipboard_paste.py", "kcoder_clipboard.py"),
                                    ("clipboard_guard.py", "kcoder_clipboard_guard.py"),
                                    ("clear_text.py", "kcoder_clear.py")]:
            shutil.copy2(self.recipe / helper, source / "src/windows_mcp" / destination)
        for name, target in patches:
            script = self.recipe / ("patch_" + name + ".py")
            shutil.copy2(script, self.root / script.name)
            self.host("patch-" + name, script, target)
        shutil.copy2(self.recipe / "uv.lock", source / "uv.lock")
        self.run("lock-check", [self.args.uv, "lock", "--check", "--no-config", "--project", source,
                                "--python", self.args.host_python])
        requirements = self.root / "requirements.txt"
        self.run("requirements-export", [self.args.uv, "export", "--no-config", "--project", source,
                 "--frozen", "--no-dev", "--no-emit-project", "--format", "requirements-txt",
                 "--output-file", requirements, "--python", self.args.host_python])
        self.run("windows-wheel-install", [self.args.uv, "pip", "install", "--no-config", "--system-certs",
                 "--python", self.args.host_python, "--python-version", PYTHON_VERSION, "--python-platform",
                 "x86_64-pc-windows-msvc", "--target", self.root / "packages", "--require-hashes",
                 "--only-binary", ":all:", "-r", requirements], timeout=600)
        # Cross-installed console scripts name the build host interpreter. The
        # worker imports these packages through its fixed launch.py instead.
        for directory in [self.root / "packages/bin", self.root / "packages/Scripts"]:
            if directory.exists():
                shutil.rmtree(directory)
        shutil.rmtree(self.root / "packages/posthog/test", ignore_errors=True)
        for leaf in ["t64-arm.exe", "w64-arm.exe"]:
            (runtime / "Lib/site-packages/pip/_vendor/distlib" / leaf).unlink(missing_ok=True)
        for name in ["launch.py", "worker.toml", "check-runtime.py", "collect_licenses.py", "runtime_inventory.py",
                     "runtime_notices.py", "stage_runtime_notices.py"]:
            shutil.copy2(self.recipe / name, self.root / name)
        for name in ["license-overrides", "runtime-license-overrides"]:
            shutil.copytree(self.recipe / name, self.root / name)
        shutil.copy2(source / "LICENSE.md", self.root / "WINDOWS-MCP-LICENSE.md")
        self.host("immutable-python-startup", self.recipe / "prepare_python_startup.py", runtime)
        manifest = dict(schemaVersion=1, inputTrackingVersion=1, clipboardRecoveryVersion=1,
                        clearTextVersion=1, bytecodePolicyVersion=1, screenshotFrameVersion=1,
                        status="prototype", upstream=pin, pythonVersion=PYTHON_VERSION,
                        python=Path(self.python).relative_to(self.root).as_posix(), requirementsSha256=digest(requirements))
        (self.root / "runtime-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        self.check_runtime("windows-runtime-imports")
        self.windows("matching-and-native-dependencies", "-I", "-B",
                     self.winpath(self.root / "check-runtime.py"), self.winpath(self.root))
        self.windows("dependency-licenses", "-I", "-B", self.winpath(self.root / "collect_licenses.py"),
                     self.winpath(self.root))
        self.windows("runtime-license-supplements", "-I", "-B",
                     self.winpath(self.root / "stage_runtime_notices.py"), self.winpath(self.root),
                     self.winpath(self.root / "runtime-license-overrides"))
        self.windows("runtime-notices", "-I", "-B", self.winpath(self.root / "runtime_notices.py"),
                     self.winpath(self.root), self.winpath(self.root / "runtime-notices.json"))
        clean_build_bytecode(self.root)
        self.host("seal-runtime", self.root / "runtime_inventory.py", "seal", self.root)
        immutable = self.windows("immutable-startup-without-bytecode-flag", "-I", "-S", "-c",
            "import sys; assert not sys.flags.dont_write_bytecode and sys.dont_write_bytecode; print('IMMUTABLE_BOOTSTRAP_READY')")
        if "IMMUTABLE_BOOTSTRAP_READY" not in immutable:
            raise RuntimeError("Immutable Windows Python startup proof missing")
        self.check_runtime("sealed-runtime-imports-without-bytecode-flag", False)
        self.windows("sealed-runtime-verify", "-I", "-B", self.winpath(self.root / "runtime_inventory.py"),
                     "verify", self.winpath(self.root))

    def close(self):
        if not self.prefix.exists():
            return
        failure = None
        try:
            self.run("stop-owned-wine-prefix", [self.args.wineserver, "-k"], timeout=15)
        except RuntimeError as error:
            # Wine returns 1 when the prefix has already stopped. Waiting below
            # still has to confirm that no server remains for this owned prefix.
            row = self.steps[-1]
            if row.get("exitCode") != 1 or Path(row["log"]).read_bytes().strip():
                failure = error
        self.run("wait-owned-wine-prefix", [self.args.wineserver, "-w"], timeout=15)
        if failure:
            raise failure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-archive", type=Path, required=True)
    parser.add_argument("--python-runtime", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--recipe-root", type=Path, default=HERE)
    parser.add_argument("--host-python", default=sys.executable)
    parser.add_argument("--uv", default="uv")
    parser.add_argument("--wine", default="wine")
    parser.add_argument("--wineserver", default="wineserver")
    parser.add_argument("--xvfb-run", default="xvfb-run")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("This entry requires Linux; use build-runtime.ps1 on Windows")
    output = args.output_directory.absolute()
    if output.exists() or output.is_symlink():
        parser.error("Output directory must not exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".computer-use-cross-", dir=output.parent))
    build, failure = Build(args, work), None
    def cancelled(_signal, _frame):
        raise KeyboardInterrupt("Build cancelled")
    signal.signal(signal.SIGTERM, cancelled)
    try:
        build.prepare()
    except BaseException as error:
        failure = error
    try:
        build.close()
    except BaseException as error:
        failure = failure or error
    receipt = {"sourceRebuilt": True, "status": "failed" if failure else "prepared",
               "desktopProbe": "not_run", "windowsNativeHostProven": False,
               "workDirectory": str(work), "steps": build.steps, "published": False}
    if not failure:
        if output.exists() or output.is_symlink():
            failure = RuntimeError("Output directory changed during preparation")
        else:
            build.root.rename(output)
            receipt.update(published=True, outputDirectory=str(output),
                           inventorySha256=digest(output / "files.sha256.json"))
    if failure:
        receipt.update(status="failed", error=str(failure))
    (work / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
    if failure:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
