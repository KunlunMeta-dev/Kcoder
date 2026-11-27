import json
from pathlib import Path
import tempfile
import unittest
from collect_licenses import collect

class LicenseTests(unittest.TestCase):
    def test_actual_notice_is_copied_and_missing_is_not_hidden(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'packages/a.dist-info/LICENSE'
            source.parent.mkdir(parents=True)
            source.write_text('copyright fixture')
            (root / 'dependency-inventory.json').write_text(json.dumps({'packages': [
                {'name': 'a', 'version': '1', 'licenseFiles': ['a.dist-info/LICENSE']},
                {'name': 'b', 'version': '2', 'licenseFiles': []},
            ]}))
            result = collect(root)
            self.assertEqual(result['missingNotices'], ['b==2'])
            self.assertEqual((root / result['packages'][0]['files'][0]['path']).read_text(), 'copyright fixture')
            self.assertEqual(result['reviewStatus'], 'pending')

    def test_rejects_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'dependency-inventory.json').write_text(json.dumps({'packages': [
                {'name': 'a', 'version': '1', 'licenseFiles': ['../outside/LICENSE']},
            ]}))
            with self.assertRaises(ValueError):
                collect(root)
