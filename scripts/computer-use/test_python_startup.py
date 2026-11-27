import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import unittest
import zipfile

from prepare_python_startup import ARCHIVE, PATH_CONFIG, prepare
from runtime_inventory import seal, verify


class PythonStartupTests(unittest.TestCase):
    def fixture(self, root):
        encodings = root / "Lib" / "encodings"
        encodings.mkdir(parents=True)
        for name, value in {
            "__init__.py": "import codecs\nimport sys\n",
            "aliases.py": "aliases = {}\n",
            "utf_8.py": "# fixture\n",
        }.items():
            (encodings / name).write_text(value, encoding="utf-8")
        (root / "python314.dll").write_bytes(b"fixture")
        return encodings

    def test_rejects_unknown_source_without_partial_policy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            encodings = self.fixture(root)
            (encodings / "__init__.py").write_text("# changed upstream\n")
            with self.assertRaisesRegex(ValueError, "Unsupported Python"):
                prepare(root)
            self.assertFalse((root / ARCHIVE).exists())
            self.assertFalse((root / PATH_CONFIG).exists())

    def test_rejects_imports_added_before_the_encoding_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            encodings = self.fixture(root)
            (encodings / "__init__.py").write_text("import pathlib\nimport codecs\nimport sys\n")
            with self.assertRaisesRegex(ValueError, "Unsupported Python"):
                prepare(root)
            self.assertFalse((root / ARCHIVE).exists())

    def test_policy_is_deterministic_and_does_not_modify_stdlib(self):
        with tempfile.TemporaryDirectory() as temp:
            archives = []
            for name in ["first", "中文 relocated"]:
                root = Path(temp) / name
                encodings = self.fixture(root)
                original = (encodings / "__init__.py").read_bytes()
                prepare(root)
                self.assertEqual((encodings / "__init__.py").read_bytes(), original)
                with zipfile.ZipFile(root / ARCHIVE) as archive:
                    self.assertIn(b"sys.dont_write_bytecode = True", archive.read("encodings/__init__.py"))
                    self.assertTrue(all(item.compress_type == zipfile.ZIP_STORED for item in archive.infolist()))
                self.assertEqual((root / PATH_CONFIG).read_bytes(), (root / "python._pth").read_bytes())
                archives.append((root / ARCHIVE).read_bytes())
                with self.assertRaisesRegex(ValueError, "already exists"):
                    prepare(root)
            self.assertEqual(*archives)

    def test_linked_encoding_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            encodings = self.fixture(root)
            target = root / "outside.py"
            target.write_text("# outside\n")
            try:
                (encodings / "extra.py").symlink_to(target)
            except OSError as error:
                self.skipTest(f"Symlinks unavailable: {error}")
            with self.assertRaisesRegex(ValueError, "Linked"):
                prepare(root)

    def test_real_interpreter_without_B_keeps_sealed_resources_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="kcoder-python-startup-") as temp:
            (Path(temp) / "owner.json").write_text(json.dumps({
                "pid": os.getpid(), "testSource": str(Path(__file__).resolve()),
            }))
            root = Path(temp) / "中文 runtime"
            root.mkdir()
            interpreter = root / ("python.exe" if sys.platform == "win32" else "python")
            shutil.copy2(sys.executable, interpreter)
            stdlib = Path(sysconfig.get_path("stdlib"))
            shutil.copytree(stdlib, root / "Lib", ignore=shutil.ignore_patterns(
                "site-packages", "dist-packages", "__pycache__", "*.pyc", "lib-dynload"))
            if sys.platform == "win32":
                for path in Path(sys.base_prefix).glob("*.dll"):
                    shutil.copy2(path, root / path.name)
                shutil.copytree(Path(sys.base_prefix) / "DLLs", root / "DLLs")
            else:
                (root / "python314.dll").write_bytes(b"Windows policy-name fixture")
                shutil.copytree(stdlib / "lib-dynload", root / "DLLs")
            (root / "Lib" / "diagnostic_target.py").write_text("value = 7\n")
            environment = os.environ.copy()
            for name in ["PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX", "PYTHONHOME"]:
                environment.pop(name, None)
            environment["PYTHONPATH"] = str(root / "Lib")
            # The same unprotected interpreter must reproduce the original fault.
            subprocess.run([str(interpreter), "-c", "import diagnostic_target"],
                           env=environment, capture_output=True, timeout=20, check=True)
            self.assertTrue(list(root.rglob("*.pyc")), "Unprotected import must reproduce cache pollution")
            for cache in root.rglob("__pycache__"):
                shutil.rmtree(cache)
            prepare(root)
            probe = Path(temp) / "probe.py"
            probe.write_text(
                "import sys, json, pathlib, subprocess, threading, traceback, inspect, diagnostic_target\n"
                "print(json.dumps({'disabled': sys.dont_write_bytecode, 'isolated': sys.flags.isolated, "
                "'value': diagnostic_target.value, 'encodings': sys.modules['encodings'].__file__}))\n")
            (root / "Lib" / "diagnostic_probe.py").write_text(probe.read_text())
            seal(root)
            count = verify(root)
            commands = [[*flags, str(probe)] for flags in [[], ["-I"], ["-S"], ["-I", "-S"]]]
            commands.extend([["-c", probe.read_text()], ["-m", "diagnostic_probe"]])
            for arguments in commands:
                with self.subTest(arguments=arguments[:1]):
                    result = subprocess.run([str(interpreter), *arguments], env=environment,
                                            capture_output=True, text=True, timeout=20, check=True)
                    observed = json.loads(result.stdout)
                    self.assertTrue(observed["disabled"])
                    self.assertEqual(observed["isolated"], 1)
                    self.assertEqual(observed["value"], 7)
                    self.assertIn(ARCHIVE, observed["encodings"])
                    self.assertEqual(verify(root), count)
                    self.assertFalse(list(root.rglob("__pycache__")))
                    self.assertFalse(list(root.rglob("*.pyc")))
            bundle = os.environ.get("KCODER_TEST_COMPUTER_USE_RUNTIME")
            if bundle:
                self.assertEqual(sys.platform, "win32", "Bundled worker acceptance requires Windows")
                source = Path(bundle)
                self.assertTrue(source.is_absolute())
                verify(source)
                copied = Path(temp) / "copied worker"
                shutil.copytree(source, copied)
                manifest_path = copied / "runtime-manifest.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
                bundled_python = (copied / manifest["python"]).resolve(strict=True)
                self.assertTrue(bundled_python.is_relative_to(copied / "runtime"))
                if not (bundled_python.parent / ARCHIVE).exists():
                    prepare(bundled_python.parent)
                shutil.copy2(Path(__file__).with_name("launch.py"), copied / "launch.py")
                manifest["bytecodePolicyVersion"] = 1
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                seal(copied)
                count = verify(copied)
                for flags in [[], ["-I"]]:
                    with self.subTest(bundled_runtime_flags=flags):
                        result = subprocess.run([str(bundled_python), *flags,
                                                 str(copied / "launch.py"), "--kcoder-runtime-check"],
                                                env=environment, capture_output=True, text=True,
                                                timeout=40, check=True)
                        self.assertEqual(json.loads(result.stdout)["desktopProbe"], "not_run")
                        self.assertEqual(verify(copied), count)
                verify(source)


if __name__ == "__main__":
    unittest.main()
