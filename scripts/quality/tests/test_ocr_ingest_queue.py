import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock


QUALITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUALITY))
SPEC = importlib.util.spec_from_file_location('ocr_ingest_queue', QUALITY / 'ocr_ingest_queue.py')
ingest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ingest)


def receipt(path, comments, attempt='attempt-1'):
    session = 'session-1'
    records = [{'type': 'session_start', 'sessionId': session},
               {'type': 'review_item_done', 'sessionId': session, 'filePath': path, 'comments': comments},
               {'type': 'session_end', 'sessionId': session}]
    raw = b''.join(json.dumps(row).encode() + b'\n' for row in records)
    return {'attempt': attempt, 'path': path, 'session_uuid': session, 'model': 'fixture',
            'session_sha256': hashlib.sha256(raw).hexdigest()}, raw


class QueueIngestionTests(unittest.TestCase):
    def setUp(self):
        self.ledger = {'findings': [{'id': 'existing', 'path': 'owned.rs', 'start_line': 1, 'end_line': 1,
                                     'category': 'bug', 'severity': 'medium', 'content': 'Existing',
                                     'sessions': ['old'], 'decision': 'pending', 'evidence': [],
                                     'manualReviewOwner': 'assistant'}], 'reviewPolicy': {'mode': 'high_only'}}

    def test_exact_duplicate_is_merged_without_losing_decision_or_owner(self):
        comment = {'path': 'owned.rs', 'start_line': 1, 'end_line': 1, 'category': 'bug',
                   'severity': 'medium', 'content': 'Existing'}
        row, data = receipt('owned.rs', [comment])
        updated, count, high = ingest.merge_receipts(self.ledger, [row], {row['attempt']: data})
        self.assertEqual((count, high), (0, 0))
        self.assertEqual(updated['findings'][0]['sessions'], ['old', 'session-1'])
        self.assertEqual(updated['findings'][0]['manualReviewOwner'], 'assistant')
        self.assertEqual(self.ledger['findings'][0]['sessions'], ['old'])

    def test_new_high_risk_is_assigned_and_lower_risk_is_deferred(self):
        comments = [{'path': 'new.rs', 'severity': 'low', 'content': 'Low'},
                    {'path': 'new.rs', 'severity': 'high', 'content': 'High'}]
        row, data = receipt('new.rs', comments)
        updated, count, high = ingest.merge_receipts(self.ledger, [row], {row['attempt']: data})
        self.assertEqual((count, high), (2, 1))
        self.assertEqual([x['manualReviewOwner'] for x in updated['findings'][1:]], ['deferred_low_risk', 'assistant'])

    def test_new_high_risk_on_assistant_file_is_assigned_to_assistant(self):
        row, data = receipt('owned.rs', [{'path': 'owned.rs', 'severity': 'high', 'content': 'High'}])
        updated, count, high = ingest.merge_receipts(self.ledger, [row], {row['attempt']: data})
        self.assertEqual((count, high), (1, 1))
        self.assertEqual(updated['findings'][-1]['manualReviewOwner'], 'assistant')
        self.assertTrue(updated['findings'][-1]['requiresHighRiskReview'])

    def test_new_high_risk_on_user_file_is_held_for_coordination(self):
        self.ledger['findings'][0]['manualReviewOwner'] = 'user'
        row, data = receipt('owned.rs', [{'path': 'owned.rs', 'severity': 'high', 'content': 'High'}])
        updated, count, high = ingest.merge_receipts(self.ledger, [row], {row['attempt']: data})
        self.assertEqual((count, high), (1, 1))
        self.assertEqual(updated['findings'][-1]['manualReviewOwner'], 'held_same_file')
        self.assertTrue(updated['findings'][-1]['requiresUserHighRiskReview'])

    def test_unknown_severity_is_held_for_classification(self):
        row, data = receipt('new.rs', [{'path': 'new.rs', 'severity': 'unknown', 'content': 'Check'}])
        updated, count, high = ingest.merge_receipts(self.ledger, [row], {row['attempt']: data})
        self.assertEqual((count, high), (1, 0))
        self.assertEqual(updated['findings'][-1]['manualReviewOwner'], 'held_same_file')
        self.assertTrue(updated['findings'][-1]['requiresSeverityReview'])

    def test_tampering_or_cross_file_comment_fails_without_ledger_mutation(self):
        before = copy.deepcopy(self.ledger)
        row, data = receipt('owned.rs', [{'path': 'other.rs', 'severity': 'high', 'content': 'No'}])
        with self.assertRaises(ingest.IngestError):
            ingest.merge_receipts(self.ledger, [row], {row['attempt']: data})
        with self.assertRaises(ingest.IngestError):
            ingest.merge_receipts(self.ledger, [row], {row['attempt']: data + b' '})
        self.assertEqual(self.ledger, before)

    def test_empty_checkpoint_preserves_existing_decisions(self):
        row, data = receipt('empty.rs', [])
        updated, count, high = ingest.merge_receipts(self.ledger, [row], {row['attempt']: data})
        self.assertEqual((count, high), (0, 0))
        self.assertEqual(updated['findings'], self.ledger['findings'])


class QueueIngestionIntegrationTests(unittest.TestCase):
    def test_owned_queue_receipt_is_ingested_once_and_tampering_is_rejected(self):
        from scripts.quality.tests import test_ocr_global_queue as fixtures

        sample = "{'path':a.path,'start_line':1,'end_line':1,'category':'bug','severity':'medium','content':'Synthetic finding'}"
        fake = fixtures.FAKE.replace("records=[start,done,end]", "done['comments']=[" + sample + "]\nrecords=[start,done,end]")
        fake = fake.replace("'comments':[],\n 'summary':{'files_reviewed':1,'comments':0}",
                            "'comments':[" + sample + "],\n 'summary':{'files_reviewed':1,'comments':1}")
        case = fixtures.GlobalQueueTests('test_paused_zero_claim_and_explicit_resume')
        with mock.patch.object(fixtures, 'FAKE', fake):
            case.setUp()
        try:
            case.queue.pause(False)
            row, success = case.complete()
            self.assertTrue(success)
            handoff = case.base / 'review-handoff'
            handoff.mkdir(mode=0o700)
            (handoff / 'ledger-assignment.lock').touch(mode=0o600)
            ledger = case.base / 'ledger.json'
            ledger.write_text(json.dumps({'findings': [], 'reviewSummary': {}, 'reviewPolicy': {'mode': 'high_only'}}))
            ledger.chmod(0o600)
            first = ingest.ingest_once(case.queue.database, ledger)
            self.assertEqual((first['receipts'], first['newOpinions']), (1, 1))
            self.assertEqual(ingest.ingest_once(case.queue.database, ledger)['receipts'], 0)
            data = json.loads(ledger.read_text())
            self.assertEqual(data['findings'][0]['manualReviewOwner'], 'deferred_low_risk')
            self.assertEqual(data['queueIngestion']['receipts'][row['id']]['sessionSha256'],
                             case.queue.receipts()[0]['session_sha256'])
            receipt_row = case.queue.receipts()[0]
            session = Path(receipt_row['session_file'])
            session.write_bytes(session.read_bytes() + b' ')
            with self.assertRaises(fixtures.ocr.QueueError):
                case.queue.verify_receipt(row['id'])
        finally:
            case.tearDown()
            case.doCleanups()


if __name__ == '__main__':
    unittest.main()
