import hashlib
import importlib.util
import argparse
import os
from pathlib import Path
import struct
import tempfile
import sys
import unittest
import zipfile


spec = importlib.util.spec_from_file_location("build_runtime_cross", Path(__file__).with_name("build-runtime-cross.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class CrossBuildInputs(unittest.TestCase):
    def archive(self, directory, extra=None):
        path = Path(directory) / "source.zip"
        with zipfile.ZipFile(path, "w") as archive:
            for name in ["pyproject.toml", "LICENSE.md", "src/windows_mcp/__main__.py"]:
                archive.writestr(name, "owned source")
            if extra:
                archive.writestr(*extra)
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_exact_pin_required_before_source_directory_is_created(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, expected = self.archive(temporary)
            output = Path(temporary) / "source"
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                builder.extract_source(archive, output, "0" * 64)
            self.assertFalse(output.exists())
            builder.extract_source(archive, output, expected)
            self.assertEqual((output / "LICENSE.md").read_text(), "owned source")

    def test_traversal_case_aliases_and_links_do_not_extract(self):
        link = zipfile.ZipInfo("owned-link")
        link.create_system = 3
        link.external_attr = 0o120777 << 16
        for name, body in [("../outside", "bad"), ("LICENSE.MD", "alias"), (link, "../outside")]:
            with self.subTest(name=str(name)), tempfile.TemporaryDirectory() as temporary:
                archive, expected = self.archive(temporary, (name, body))
                output = Path(temporary) / "source"
                with self.assertRaisesRegex(ValueError, "Unsafe upstream"):
                    builder.extract_source(archive, output, expected)
                self.assertFalse(output.exists())
                self.assertFalse((Path(temporary) / "outside").exists())

    def test_windows_runtime_requires_exact_pe_machine_and_kind(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "python.exe"
            data = bytearray(88)
            data[:2] = b"MZ"
            struct.pack_into("<I", data, 60, 64)
            data[64:68] = b"PE\0\0"
            struct.pack_into("<H", data, 68, 0x8664)
            path.write_bytes(data)
            builder.windows_pe(path)
            with self.assertRaisesRegex(ValueError, "kind"):
                builder.windows_pe(path, True)
            struct.pack_into("<H", data, 68, 0x14c)
            path.write_bytes(data)
            with self.assertRaisesRegex(ValueError, "x64"):
                builder.windows_pe(path)

    def test_timed_out_owned_process_group_exits_before_return(self):
        with tempfile.TemporaryDirectory() as temporary:
            build = builder.Build(argparse.Namespace(recipe_root=Path(temporary)), Path(temporary))
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                build.run("owned-sleeper", [sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.05)
            row = build.steps[-1]
            self.assertTrue(row["exited"])
            with self.assertRaises(ProcessLookupError):
                os.killpg(row["pid"], 0)


if __name__ == "__main__":
    unittest.main()
