import importlib.util
from pathlib import Path
import sys
import time
import unittest


QUALITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUALITY))
SPEC = importlib.util.spec_from_file_location('ocr_recovery_watch', QUALITY / 'ocr_recovery_watch.py')
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


class RecoveryWatchTests(unittest.TestCase):
    def test_later_verified_inflight_successes_recover_without_retrying_failed_file(self):
        from scripts.quality.tests import test_ocr_global_queue as fixtures

        case = fixtures.GlobalQueueTests('test_paused_zero_claim_and_explicit_resume')
        case.setUp()
        try:
            case.warm()
            case.control('block')
            first, first_child = case.start()
            second, second_child = case.start()
            deadline = time.monotonic() + 10
            while len(list(case.sessions.glob('*.jsonl'))) < 3 and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(len(list(case.sessions.glob('*.jsonl'))), 3)
            case.control('nonzero')
            failed, success = case.complete()
            self.assertFalse(success)
            self.assertEqual(case.queue.status()['models'][0]['state'], 'quarantined')
            watch = recovery.RecoveryWatch(case.queue)
            self.assertEqual(watch.poll(), [])
            (case.base / 'release').touch()
            for row, child in [(first, first_child), (second, second_child)]:
                child.wait(timeout=10)
                self.assertTrue(case.queue.finish(row['id'], row['token'], child.returncode))
            result = watch.poll()
            self.assertEqual(len(result), 1)
            self.assertEqual(case.queue.status()['models'][0]['state'], 'active')
            self.assertEqual(case.queue.attempt(failed['id'], failed['token'])['status'], 'held')
            self.assertEqual(case.queue.connection.execute('SELECT count(*) FROM attempts WHERE path=?',
                                                           (failed['path'],)).fetchone()[0], 1)
        finally:
            case.tearDown()
            case.doCleanups()

    def test_old_successes_and_paused_queue_never_authorize_recovery(self):
        from scripts.quality.tests import test_ocr_global_queue as fixtures

        case = fixtures.GlobalQueueTests('test_paused_zero_claim_and_explicit_resume')
        case.setUp()
        try:
            case.warm()
            case.control('nonzero')
            _failed, success = case.complete()
            self.assertFalse(success)
            watch = recovery.RecoveryWatch(case.queue)
            self.assertEqual(watch.poll(), [])
            self.assertEqual(watch.poll(), [])
            case.queue.pause(True)
            self.assertEqual(watch.poll(), [])
            self.assertEqual(case.queue.status()['models'][0]['state'], 'quarantined')
        finally:
            case.tearDown()
            case.doCleanups()

    def test_tampered_success_receipt_cannot_restore_a_model(self):
        from scripts.quality.tests import test_ocr_global_queue as fixtures

        case = fixtures.GlobalQueueTests('test_paused_zero_claim_and_explicit_resume')
        case.setUp()
        try:
            case.warm()
            case.control('block')
            first, first_child = case.start()
            second, second_child = case.start()
            deadline = time.monotonic() + 10
            while len(list(case.sessions.glob('*.jsonl'))) < 3 and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(len(list(case.sessions.glob('*.jsonl'))), 3)
            case.control('nonzero')
            _failed, success = case.complete()
            self.assertFalse(success)
            watch = recovery.RecoveryWatch(case.queue)
            self.assertEqual(watch.poll(), [])
            (case.base / 'release').touch()
            for row, child in [(first, first_child), (second, second_child)]:
                child.wait(timeout=10)
                self.assertTrue(case.queue.finish(row['id'], row['token'], child.returncode))
            receipt = next(row for row in case.queue.receipts() if row['attempt'] == second['id'])
            path = Path(receipt['session_file'])
            path.write_bytes(path.read_bytes() + b' ')
            with self.assertRaises(fixtures.ocr.QueueError):
                watch.poll()
            self.assertEqual(case.queue.status()['models'][0]['state'], 'quarantined')
        finally:
            case.tearDown()
            case.doCleanups()


if __name__ == '__main__':
    unittest.main()
