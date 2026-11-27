import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / 'ocr_safe_view.py'
SPEC = importlib.util.spec_from_file_location('ocr_safe_view', MODULE)
view = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(view)


class SafeViewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ocr-safe-view-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir(mode=0o700)
        self.parent = self.root / 'private'
        self.parent.mkdir(mode=0o700)

    def write(self, path, data):
        target = self.source / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    def test_private_sources_are_withheld_and_public_bytes_are_bound(self):
        self.write('src/main.rs', b'pub fn main() {}\n')
        for name in ['.git', '.env.example', '.env', '.aws/credentials',
                     '.kcoder/settings.json', '.opencodereview/config.json',
                     'apps/kcoder-studio/e2e/private/trace.json', 'runtime/session.jsonl',
                     'runtime/run.log', 'keys/fixture.pem']:
            self.write(name, b'SYNTHETIC_SECRET_CANARY')
        self.write('src/looks_public.ts', b'const value = "sk-' + b'Q' * 40 + b'"\n')
        result = view.create_view(self.source, self.parent / 'view')
        self.assertEqual([entry['path'] for entry in result['files']], ['src/main.rs'])
        self.assertEqual(result['files'][0]['sha256'], hashlib.sha256(b'pub fn main() {}\n').hexdigest())
        self.assertEqual((self.parent / 'view/src/main.rs').read_bytes(), b'pub fn main() {}\n')
        self.assertFalse((self.parent / 'view/.git').exists())
        self.assertGreater(result['withheldEntries'], 0)
        self.assertEqual(result['contentWithheldEntries'], 1)

    def test_rejects_symlinks_and_hardlinks(self):
        target = self.write('source.txt', b'fixture')
        os.symlink(target, self.source / 'link.txt')
        with self.assertRaises((view.ViewError, OSError)):
            view.create_view(self.source, self.parent / 'first')
        (self.source / 'link.txt').unlink()
        os.link(target, self.source / 'hardlink.txt')
        with self.assertRaises(view.ViewError):
            view.create_view(self.source, self.parent / 'second')

    def test_destination_must_be_outside_git(self):
        self.write('source.txt', b'fixture')
        (self.root / '.git').write_text('gitdir: unrelated')
        with self.assertRaises(view.ViewError):
            view.create_view(self.source, self.parent / 'view')


if __name__ == '__main__':
    unittest.main()
