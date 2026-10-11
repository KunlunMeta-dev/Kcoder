import json
from pathlib import Path
import tempfile
import unittest
from runtime_notices import inspect


class RuntimeNoticeTests(unittest.TestCase):
    def fixture(self, root):
        python = root / 'runtime/python'
        python.mkdir(parents=True)
        (python / 'python.exe').write_bytes(b'fixture')
        (python / 'LICENSE.txt').write_text('Python notice')
        (python / 'library.dll').write_bytes(b'native fixture')
        (python / 'pip_vendor').mkdir()
        (python / 'pip_vendor/COPYING').write_text('vendor notice')
        (root / 'packages').mkdir()
        (root / 'packages/extension.pyd').write_bytes(b'extension fixture')
        (root / 'runtime-manifest.json').write_text(json.dumps({
            'python': r'runtime\python\python.exe', 'pythonVersion': 'fixture',
        }), encoding='utf-8-sig')

    def test_vendor_notices_and_native_binaries_remain_pending_review(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            result = inspect(root)
            self.assertEqual(len(result['notices']), 2)
            self.assertEqual(len(result['nativeBinaries']), 2)
            self.assertEqual(result['reviewStatus'], 'pending')
            self.assertTrue(result['nativeAttributionReviewRequired'])

    def test_missing_python_notice_is_not_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            (root / 'runtime/python/LICENSE.txt').unlink()
            with self.assertRaisesRegex(ValueError, 'license is missing'):
                inspect(root)

    def test_path_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            (root / 'runtime-manifest.json').write_text(json.dumps({'python': '../python.exe'}))
            with self.assertRaisesRegex(ValueError, 'escapes'):
                inspect(root)
