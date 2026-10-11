import tempfile
import unittest
from pathlib import Path
from runtime_inventory import seal, verify


class InventoryTests(unittest.TestCase):
    def test_relocation_and_tamper_add_remove(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "original"
            root.mkdir()
            (root / "resource").write_bytes(b"original")
            seal(root)
            target = root.rename(Path(temp) / "中文 path")
            self.assertEqual(verify(target), 1)
            (target / "resource").write_bytes(b"modified")
            with self.assertRaises(ValueError):
                verify(target)
            (target / "resource").write_bytes(b"original")
            (target / "extra.dll").write_bytes(b"injected")
            with self.assertRaises(ValueError):
                verify(target)
            (target / "extra.dll").unlink()
            (target / "resource").unlink()
            with self.assertRaises(ValueError):
                verify(target)

    def test_rejects_links_and_mutable_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "bad.pyc").write_bytes(b"cache")
            with self.assertRaises(ValueError):
                seal(root)
            (root / "bad.pyc").unlink()
            (root / "linked").symlink_to(root / "missing")
            with self.assertRaises(ValueError):
                seal(root)


if __name__ == "__main__":
    unittest.main()
