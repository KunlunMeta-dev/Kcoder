import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from stage_runtime_notices import stage


class SupplementalNoticeTests(unittest.TestCase):
    def fixture(self, root):
        runtime, notices = root / 'bundle', root / 'notices'
        runtime.mkdir()
        notices.mkdir()
        (runtime / 'library.dll').write_bytes(b'library version one')
        (notices / 'library.LICENSE').write_bytes(b'notice version one')
        (notices / 'index.json').write_text(json.dumps({'schemaVersion': 1, 'components': [{
            'name': 'library', 'version': '1',
            'binaries': [{'path': 'library.dll', 'sha256': hashlib.sha256(b'library version one').hexdigest()}],
            'notices': [{'file': 'library.LICENSE', 'sha256': hashlib.sha256(b'notice version one').hexdigest()}],
        }]}))
        return runtime, notices

    def test_pinned_notice_is_materialized_and_cannot_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime, notices = self.fixture(Path(temp))
            self.assertEqual(stage(runtime, notices), 1)
            self.assertEqual((runtime / 'licenses/runtime/library-1/LICENSE-library.LICENSE').read_bytes(), b'notice version one')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                stage(runtime, notices)

    def test_library_upgrade_and_notice_tampering_fail_before_writing(self):
        for target in ['binary', 'notice']:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temp:
                runtime, notices = self.fixture(Path(temp))
                path = runtime / 'library.dll' if target == 'binary' else notices / 'library.LICENSE'
                path.write_bytes(b'changed version')
                with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                    stage(runtime, notices)
                self.assertFalse((runtime / 'licenses/runtime').exists())
