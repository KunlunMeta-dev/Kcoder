"""Deterministic build-resource checks; no downloads or native interpreter needed."""
from pathlib import Path
import json
import tempfile
import unittest

import prepare


class PythonStagingTest(unittest.TestCase):
    def test_native_import_checks_require_matching_platform_and_architecture(self):
        for system, machine, target in [
            ("darwin", "arm64", "mac-arm64"), ("darwin", "x86_64", "mac-x64"),
            ("win32", "AMD64", "win-x64"), ("linux", "x86_64", "linux-x64"),
        ]:
            with self.subTest(system=system, machine=machine):
                self.assertTrue(prepare.is_native_target(target, system, machine))
                for other in prepare.PIN["platforms"]:
                    if other != target:
                        self.assertFalse(prepare.is_native_target(other, system, machine))
        self.assertFalse(prepare.is_native_target("mac-arm64", "darwin", "unknown"))

    def test_runtime_reuse_rejects_a_different_build_recipe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "build-source").mkdir()
            (root / "build-source/prepare.py").write_text("obsolete fixture recipe")
            (root / "runtime-manifest.json").write_text(json.dumps({
                "platform": "win-x64", "upstream": prepare.PIN,
                "launcherSha256": prepare.sha(prepare.HERE / "launch.py"),
                "egressSha256": prepare.sha(prepare.HERE / "egress.py"),
                "requirementsSha256": prepare.sha(prepare.HERE / "requirements.lock"),
            }))
            with self.assertRaisesRegex(ValueError, "different build recipe"):
                prepare.verify(root, "win-x64")
            self.assertTrue((root / "build-source/prepare.py").exists())

    def test_runtime_omits_build_only_pip_but_preserves_python_and_libraries(self):
        for windows, library, scripts, interpreter in [
            (True, "Lib", "Scripts", "python.exe"),
            (False, "lib/python3.14", "bin", "bin/python3.14"),
        ]:
            with self.subTest(windows=windows), tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary) / "source"
                destination = Path(temporary) / "runtime"
                kept = [interpreter, "LICENSE", f"{library}/json/__init__.py", f"{library}/site-packages/retained/__init__.py", f"{scripts}/other-tool"]
                removed = [f"{library}/site-packages/pip/__init__.py", f"{library}/site-packages/pip/_vendor/distlib/t64-arm.exe", f"{library}/site-packages/pip/_vendor/distlib/w64-arm.exe", f"{library}/site-packages/pip-25.2.dist-info/METADATA"]
                removed += [f"{scripts}/{name}" for name in ["pip", "pip3", "pip3.14", "pip.exe", "pip3.exe", "pip3.14.exe"]]
                for name in kept + removed:
                    path = source / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"fixture")
                prepare.copy_python(source, destination, windows)
                for name in kept:
                    self.assertEqual((destination / name).read_bytes(), b"fixture")
                for name in removed:
                    self.assertFalse((destination / name).exists(), name)
                self.assertTrue((source / removed[0]).is_file(), "the pinned build cache is unchanged")


if __name__ == "__main__":
    unittest.main()
