"""Trusted fixture snapshots accept source bytes, never source ownership as authority."""

import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from stage_organization_fixture import OIDC_DATA, stage


@unittest.skipUnless(os.geteuid() == 0, "Root-owned fixture staging required")
class TrustedOidcSourceTests(unittest.TestCase):
    def fixture(self, root):
        source = root / "checkout"
        for directory in ("lib", "installers", "tests", "oidc"):
            (source / directory).mkdir(parents=True)
        for directory in ("lib", "installers", "tests"):
            (source / directory / "owned_source.py").write_text("# Synthetic source fixture.\n")
        for name in OIDC_DATA:
            (source / "oidc" / name).write_text("synthetic public source\n")
        return source

    def test_unprivileged_checkout_ancestor_is_hashed_into_root_owned_source_without_chmod(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.fixture(root)
            os.chown(source, 65534, 65534)
            before = source.stat()
            result = stage(source, root / "trusted" / "source")
            self.assertEqual(source.stat().st_uid, before.st_uid)
            self.assertEqual(source.stat().st_mode, before.st_mode)
            manifest = json.loads(Path(result["manifest"]).read_text())
            self.assertTrue(any(parent["uid"] == 65534 for parent in manifest["sourceAncestors"]))
            self.assertEqual({Path(item["path"]).parts[0] for item in manifest["files"]}, {"lib", "installers", "oidc", "tests"})
            for item in manifest["files"]:
                output = Path(result["sourceRoot"]) / item["path"]
                self.assertEqual(output.stat().st_uid, 0)
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), item["sha256"])
            with self.assertRaises(FileExistsError): stage(source, root / "trusted" / "source")

    def test_symlink_or_hardlinked_source_is_not_adopted(self):
        for kind in ("symlink", "hardlink"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); source = self.fixture(root)
                source_file = source / "lib/owned_source.py"
                if kind == "symlink":
                    source_file.unlink(); source_file.symlink_to(source / "tests/owned_source.py")
                else:
                    os.link(source_file, root / "unexpected-hardlink")
                with self.assertRaises((RuntimeError, OSError)): stage(source, root / "trusted" / "source")


if __name__ == "__main__":
    unittest.main()
