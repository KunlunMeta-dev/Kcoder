import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

QUALITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUALITY))
SPEC = importlib.util.spec_from_file_location('ocr_switch_scanner', QUALITY / 'ocr_switch_scanner.py')
switcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(switcher)


class ScannerTransitionTests(unittest.TestCase):
    def setUp(self):
        from scripts.quality.tests import test_ocr_global_queue as fixtures
        self.case = fixtures.GlobalQueueTests('test_paused_zero_claim_and_explicit_resume')
        self.case.setUp()
        self.addCleanup(self.finish_case)
        self.case.warm()
        self.case.queue.pause(True)
        base = self.case.base
        handoff = base / 'review-handoff'; handoff.mkdir(mode=0o700)
        (handoff / 'ledger-assignment.lock').touch(mode=0o600)
        self.ledger = base / 'ledger.json'
        info = self.case.queue.database.stat()
        binding = {'database': str(self.case.queue.database), 'device': info.st_dev, 'inode': info.st_ino,
                   'scannerSha256': self.case.queue.meta('scannerSha256'), 'snapshot': self.case.queue.meta('snapshot')}
        self.ledger.write_text(json.dumps({'findings': [], 'queueIngestion': {'binding': binding, 'cursor': 1, 'receipts': {}}}))
        self.ledger.chmod(0o600)
        self.owners = base / 'owners.json'
        self.owners.write_text(json.dumps({'scannerSha256': binding['scannerSha256']})); self.owners.chmod(0o600)
        self.new = base / 'scanner-v2'; self.new.write_bytes(self.case.fake.read_bytes() + b'\n# new build\n'); self.new.chmod(0o700)
        self.sha = hashlib.sha256(self.new.read_bytes()).hexdigest()
        self.args = (self.case.queue.database, self.ledger, self.owners, self.new, self.sha)

    def finish_case(self):
        self.case.tearDown()
        self.case.doCleanups()

    def test_drained_transition_preserves_original_receipt_and_updates_all_bindings(self):
        old = self.case.queue.receipts()[0]
        outcome = switcher.switch(*self.args)
        self.assertTrue(outcome['paused']); self.assertEqual(outcome['cursor'], 1)
        self.assertEqual(self.case.queue.meta('scannerSha256'), self.sha)
        self.assertEqual(json.loads(self.ledger.read_text())['queueIngestion']['binding']['scannerSha256'], self.sha)
        self.assertEqual(json.loads(self.owners.read_text())['scannerSha256'], self.sha)
        self.assertTrue(self.case.queue.verify_receipt(old['attempt'])['verified'])
        self.assertEqual(self.case.queue.connection.execute('select count(*) from attempts').fetchone()[0], 1)
        self.assertEqual(len(list(self.case.queue.database.parent.glob('scanner-switch-*.json'))), 1)
        self.assertFalse((self.case.queue.database.parent / 'scanner-switch.pending.json').exists())
        import ocr_ingest_queue as ingest
        self.case.queue.pause(False)
        self.assertTrue(self.case.complete()[1])
        result = ingest.ingest_once(self.case.queue.database, self.ledger)
        self.assertEqual((result['receipts'], result['cursor']), (1, 2))
        self.assertEqual(len(json.loads(self.ledger.read_text())['scannerTransitions']), 1)

    def test_interruption_after_database_commit_is_resumable_without_losing_receipts(self):
        original = switcher.atomic_json
        def fail_ledger(path, value):
            if path == self.ledger:
                raise OSError('synthetic ledger write interruption')
            return original(path, value)
        with mock.patch.object(switcher, 'atomic_json', side_effect=fail_ledger):
            with self.assertRaises(OSError):
                switcher.switch(*self.args)
        self.assertEqual(self.case.queue.meta('scannerSha256'), self.sha)
        self.assertTrue(self.case.queue.meta('paused'))
        self.assertTrue((self.case.queue.database.parent / 'scanner-switch.pending.json').exists())
        self.assertEqual(switcher.switch(*self.args)['scannerSha256'], self.sha)
        self.assertEqual(json.loads(self.ledger.read_text())['queueIngestion']['cursor'], 1)
        self.assertEqual(len(json.loads(self.ledger.read_text())['scannerTransitions']), 1)
        self.assertTrue(self.case.queue.verify_receipt(self.case.queue.receipts()[0]['attempt'])['verified'])

    def test_unpaused_queue_is_rejected_without_claiming_it_was_paused(self):
        original = self.case.queue.meta('scannerSha256')
        self.case.queue.pause(False)
        with self.assertRaisesRegex(switcher.SwitchError, 'queue must be paused'):
            switcher.switch(*self.args)
        self.assertFalse(self.case.queue.meta('paused'))
        self.assertEqual(self.case.queue.meta('scannerSha256'), original)

    def test_pending_or_unverified_inputs_fail_without_changing_bindings(self):
        original = self.case.queue.meta('scannerSha256')
        with self.assertRaises(switcher.SwitchError):
            switcher.switch(*self.args[:-1], 'f' * 64)
        self.case.queue.pause(False); self.assertIsNotNone(self.case.queue.claim()); self.case.queue.pause(True)
        with self.assertRaisesRegex(switcher.SwitchError, 'drained'):
            switcher.switch(*self.args)
        self.assertEqual(self.case.queue.meta('scannerSha256'), original)
        self.assertEqual(json.loads(self.ledger.read_text())['queueIngestion']['binding']['scannerSha256'], original)
        self.assertFalse((self.case.queue.database.parent / 'scanner-switch.pending.json').exists())


if __name__ == '__main__':
    unittest.main()
