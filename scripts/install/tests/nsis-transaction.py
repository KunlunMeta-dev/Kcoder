#!/usr/bin/env python3
"""在独立 Wine profile 中验证 NSIS 取消、双文件提交及失败恢复。"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-ref", help="可选 Git 基线，用于验证旧版本确实失败")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    required = ["wine", "wineboot", "wineserver", "makensis", "x86_64-w64-mingw32-gcc"]
    for program in required:
        if shutil.which(program) is None:
            raise RuntimeError(f"missing prerequisite: {program}")
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("run this test with xvfb-run -a python3 " + __file__)
    with tempfile.TemporaryDirectory(prefix="kcoder-nsis-test-") as temporary:
        work = Path(temporary)
        prefix = work / "wine"
        # Child processes inherit only platform necessities; the isolated prefix receives neither provider credentials nor user Wine configuration.
        inherited = ["HOME", "PATH", "DISPLAY", "XAUTHORITY", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "XDG_RUNTIME_DIR"]
        env = {name: os.environ[name] for name in inherited if name in os.environ}
        env.update({"WINEPREFIX": str(prefix), "WINEDEBUG": "-all", "WINEDLLOVERRIDES": "mscoree,mshtml="})

        def run(argv, *, check=True, timeout=60):
            result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=timeout)
            if check and result.returncode:
                raise RuntimeError(f"command failed ({result.returncode}): {argv!r}\n{result.stdout}\n{result.stderr}")
            return result

        def winepath(path):
            return "Z:" + str(path).replace("/", "\\")

        def registry(key, name, value):
            run(["wine", "reg", "add", key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"])

        def digest(path):
            return hashlib.sha256(path.read_bytes()).hexdigest()

        try:
            run(["wineboot", "-u"])
            fixture = work / "fixture.exe"
            run(["x86_64-w64-mingw32-gcc", "-municode", "-O2", str(root / "scripts/install/tests/nsis-fixture.c"), "-o", str(fixture)])
            chrome = work / "chrome"
            chrome.mkdir()
            (chrome / ".kcoder-chrome.json").write_text("{}", encoding="utf-8")
            (chrome / "browser-resource.txt").write_text("new browser", encoding="utf-8")
            source = root / "scripts/install/installers/kcoder-windows-installer.nsi"
            if args.source_ref:
                source_text = run(["git", "-C", str(root), "show", f"{args.source_ref}:scripts/install/installers/kcoder-windows-installer.nsi"]).stdout
                source = work / "baseline.nsi"
                source.write_text(source_text, encoding="utf-8")
            installers = {}
            for scenario, defines in [
                ("normal", []),
                ("rollback", ["KCODER_INSTALL_TEST_FAIL_AFTER_MAIN"]),
                ("recovery", ["KCODER_INSTALL_TEST_FAIL_AFTER_MAIN", "KCODER_INSTALL_TEST_FAIL_RECOVERY"]),
            ]:
                output = work / f"{scenario}.exe"
                run(["makensis", "-V2", "-DVERSION=0.1.0", f"-DOUT_FILE={output}", f"-DCLI_BINARY={fixture}", f"-DSUPERVISOR_BINARY={fixture}", f"-DRIPGREP_BINARY={fixture}", f"-DCHROME_DIRECTORY={chrome}", *[f"-D{item}" for item in defines], str(source)])
                installers[scenario] = output
            legacy = prefix / "drive_c/Program Files/KCoder"
            target = prefix / "drive_c/new/KCoder"
            legacy.mkdir(parents=True)
            for name in ["kcoder.exe", "kcoder-process-supervisor.exe"]:
                (legacy / name).write_bytes(("old " + name).encode())
            registry(r"HKCU\Software\KCoder", "InstallDir", r"C:\Program Files\KCoder")
            registry(r"HKCU\Environment", "Path", r"C:\Program Files\KCoder;C:\sentinel")
            old_hashes = {name: digest(legacy / name) for name in ["kcoder.exe", "kcoder-process-supervisor.exe"]}
            run(["wine", str(fixture), "cancel", winepath(installers["normal"]), r"C:\new\KCoder"], timeout=30)
            assert all((legacy / name).is_file() and digest(legacy / name) == expected for name, expected in old_hashes.items()), "cancel after confirmation deleted previous binaries"
            path_value = run(["wine", "reg", "query", r"HKCU\Environment", "/v", "Path"]).stdout
            assert r"C:\Program Files\KCoder" in path_value, "cancel changed PATH"
            print("PASS: wizard cancellation preserves previous binaries and PATH")

            # Same-directory upgrades trigger old-version detection and must preserve the new program and registration data.
            installed = run(["wine", str(installers["normal"]), "/S", r"/D=C:\Program Files\KCoder"], check=False)
            assert installed.returncode == 0, "normal install failed: " + repr(sorted(str(path.relative_to(legacy)) for path in legacy.rglob("*")))
            assert all(digest(legacy / name) == digest(fixture) for name in old_hashes)
            assert digest(legacy / "lib/kcoder/rg.exe") == digest(fixture)
            assert r"C:\Program Files\KCoder" in run(["wine", "reg", "query", r"HKCU\Software\KCoder", "/v", "InstallDir"]).stdout
            print("PASS: in-place upgrade keeps the new pair")

            # Numeric file attributes must not be compared as decimal/hex strings.
            (legacy / "chrome/browser-resource.txt").write_text("old browser", encoding="utf-8")
            upgraded = run(["wine", str(installers["normal"]), "/S", r"/D=C:\Program Files\KCoder"], check=False)
            assert upgraded.returncode == 0, "upgrade rejected the existing managed Chrome directory"
            assert (legacy / "chrome/browser-resource.txt").read_text() == "new browser"
            print("PASS: existing managed Chrome is upgraded in place")

            fresh = prefix / "drive_c/fresh/KCoder"
            result = run(["wine", str(installers["rollback"]), "/S", r"/D=C:\fresh\KCoder"], check=False)
            assert result.returncode != 0
            assert not (fresh / "kcoder.exe").exists() and not (fresh / "kcoder-process-supervisor.exe").exists()
            assert not list(fresh.glob("*.tmp"))
            print("PASS: fresh-install failure leaves no partial binary pair")

            target.mkdir(parents=True)
            for name in old_hashes:
                (target / name).write_bytes(("old " + name).encode())
            ready, stop = work / "lock-ready", work / "lock-stop"
            locker = subprocess.Popen(["wine", str(fixture), "lock", winepath(target / "kcoder-process-supervisor.exe"), winepath(ready), winepath(stop)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 10
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                assert ready.exists(), "file lock fixture did not become ready"
                locked_install = run(["wine", str(installers["normal"]), "/S", r"/D=C:\new\KCoder"], check=False)
                assert locked_install.returncode != 0
                assert all(digest(target / name) == expected for name, expected in old_hashes.items())
            finally:
                stop.touch()
                try:
                    locker.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    locker.kill()
                    locker.communicate(timeout=5)
                    raise
            print("PASS: locked old helper restores the already-backed-up main binary")
            result = run(["wine", str(installers["rollback"]), "/S", r"/D=C:\new\KCoder"], check=False)
            assert result.returncode != 0, "injected commit failure incorrectly succeeded"
            assert all(digest(target / name) == expected for name, expected in old_hashes.items()), "rollback did not restore both binaries"
            assert not list(target.glob("*.tmp")), "successful rollback left transaction artifacts"
            print("PASS: second-file failure restores both previous binaries")

            result = run(["wine", str(installers["recovery"]), "/S", r"/D=C:\new\KCoder"], check=False)
            assert result.returncode != 0
            backups = list(target.glob("*/backup/kcoder.exe"))
            assert len(backups) == 1 and digest(backups[0]) == old_hashes["kcoder.exe"], "failed recovery erased the backup"
            assert digest(target / "kcoder-process-supervisor.exe") == old_hashes["kcoder-process-supervisor.exe"]
            print("PASS: failed recovery retains the exact previous binary backup")
            relocated = prefix / "drive_c/relocated/KCoder"
            run(["wine", str(installers["normal"]), "/S", r"/D=C:\relocated\KCoder"])
            assert all(digest(relocated / name) == digest(fixture) for name in old_hashes)
            assert not (legacy / "kcoder.exe").exists()
            assert not (legacy / "kcoder-process-supervisor.exe").exists()
            assert r"C:\relocated\KCoder" in run(["wine", "reg", "query", r"HKCU\Software\KCoder", "/v", "InstallDir"]).stdout
            print("PASS: relocation cleans the legacy pair only after successful installation")
            run(["wine", str(relocated / "uninstall.exe"), "/S", r"_?=C:\relocated\KCoder"])
            assert not (relocated / "chrome").exists(), "uninstall retained the owned Chrome directory"
            print("PASS: uninstall removes the managed Chrome directory")
        finally:
            # Terminate only the server for this unique WINEPREFIX, then remove the temporary directory owned by the test.
            run(["wineserver", "-k"], check=False, timeout=15)
            run(["wineserver", "-w"], timeout=15)


if __name__ == "__main__":
    main()
