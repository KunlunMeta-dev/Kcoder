import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RepositoryChecks(unittest.TestCase):
    def repository(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        return root

    def test_syntax_gate_never_executes_workloads_and_rejects_invalid_tracked_python(self):
        module = load("syntax_gate", ROOT / "scripts/ci/check_repository_syntax.py")
        root = self.repository()
        (root / "scripts").mkdir()
        marker = root / "unexpected-execution"
        source = root / "scripts/job.py"
        source.write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        with patch.object(module, "ROOT", root), contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(module.main())
        self.assertFalse(marker.exists())
        source.write_text("def broken(:\n")
        with patch.object(module, "ROOT", root), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(module.main())

    def test_language_gate_checks_english_copy_and_allows_chinese_translation(self):
        module = load("language_gate", ROOT / "scripts/audit/audit_source_language.py")
        root = self.repository()
        import json

        base = root / "apps/kcoder-studio/renderer/src/i18n/locales"
        for locale, text in [("en", "English command"), ("zh-CN", "中文命令")]:
            folder = base / locale
            folder.mkdir(parents=True)
            (folder / "common-workbench.json").write_text(json.dumps({
                "workbench": {key: text for key in module.SLASH_LOCALE_KEYS}
            }, ensure_ascii=False))
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        with patch("sys.argv", ["audit", str(root)]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(module.main(), 0)
        (base / "en/common-workbench.json").write_text(json.dumps({
            "workbench": {key: "错误英文" for key in module.SLASH_LOCALE_KEYS}
        }))
        with patch("sys.argv", ["audit", str(root)]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(module.main(), 1)


if __name__ == "__main__":
    unittest.main()
