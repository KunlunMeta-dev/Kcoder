"""Offline native-directory session and receipt integration tests."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

from scripts.quality.tests import test_ocr_global_queue as fixture

QUALITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUALITY))
spec = importlib.util.spec_from_file_location('ocr_directory_scan', QUALITY / 'ocr_directory_scan.py')
directory_scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(directory_scan)
from scripts.quality import ocr_ingest_queue as ingest

FAKE = r'''#!PYTHON
import argparse,datetime,hashlib,json,os,pathlib,uuid
p=argparse.ArgumentParser();p.add_argument('scan');p.add_argument('--repo');p.add_argument('--path');p.add_argument('--provider');p.add_argument('--model');p.add_argument('--preview',action='store_true');args,_=p.parse_known_args()
root=pathlib.Path(args.repo); files=sorted(str(x.relative_to(root)) for x in (root/args.path).rglob('*.py'))
if args.preview:
 print(json.dumps({'files':[{'path':p,'will_review':True} for p in files],'reviewable_count':len(files)}));raise SystemExit
mode=json.loads((root.parent/'control.json').read_text()).get('mode')
session=str(uuid.uuid4());now=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
records=[{'type':'session_start','sessionId':session,'timestamp':now,'cwd':str(root),'model':args.model,'reviewMode':'full_scan','scanPaths':[args.path]}]
comments=[]
for path in files:
 fp=hashlib.sha256(b'full_scan\0'+path.encode()+b'\0'+(root/path).read_bytes()).hexdigest();comment={'path':path,'start_line':1,'end_line':1,'category':'bug','severity':'high','content':'Synthetic directory finding'};comments.append(comment)
 records.append({'type':'review_item_done','sessionId':session,'filePath':path,'oldPath':path,'newPath':path,'model':args.model,'fingerprint':fp,'comments':[comment]})
if mode=='cross-file':comments[0]['path']='outside.py'
if mode=='bad-checkpoint':records.pop()
if mode in ('partial-error','unscoped-error','foreign-error','malformed-error','mismatched-errors'):
 error_path = '' if mode=='unscoped-error' else ('outside.py' if mode=='foreign-error' else ([] if mode=='malformed-error' else files[0]))
 records.append({'type':'llm_error','sessionId':session,'filePath':error_path,'error':'synthetic'})
records.append({'type':'session_end','sessionId':session,'llm_failures':2 if mode=='mismatched-errors' else (1 if mode in ('partial-error','unscoped-error','foreign-error','malformed-error') else 0)})
encoded=str(root).lstrip('/\\').replace('/','-').replace('\\','-');out=pathlib.Path.home()/'.opencodereview'/'sessions'/encoded/(session+'.jsonl')
with open(out,'w') as f:
 os.chmod(out,0o600)
 for row in records:f.write(json.dumps(row)+'\n')
print(json.dumps({'status':'completed_with_warnings' if mode=='opaque-warning' else 'success','session_id':session,'llm':{'provider':args.provider,'model':args.model},'comments':comments,'summary':{'files_reviewed':len(files),'comments':len(comments)},'tool_calls':{'failure':0},'warnings':[{'type':'opaque'}] if mode=='opaque-warning' else []}))
'''


class DirectoryScanTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.GlobalQueueTests('test_paused_zero_claim_and_explicit_resume')
        original = fixture.FAKE
        fixture.FAKE = FAKE
        try:
            self.fixture.setUp()
        finally:
            fixture.FAKE = original
        self.queue = self.fixture.queue
        self.paths = self.fixture.add_directory('module', ['a.py', 'b.py', 'c.py'])
        with self.queue.transaction() as db:
            db.execute('UPDATE models SET canary=1 WHERE id=1')

    def tearDown(self):
        self.fixture.tearDown()
        self.fixture.doCleanups()

    def test_one_directory_process_produces_per_file_receipts_and_ingests(self):
        result = directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        self.assertEqual(result['completed'], 3)
        receipts = self.queue.receipts()
        self.assertEqual({r['path'] for r in receipts}, set(self.paths))
        self.assertEqual(len({r['session_uuid'] for r in receipts}), 1)
        for row in receipts:
            self.assertTrue(self.queue.verify_receipt(row['attempt'])['verified'])
        handoff = self.fixture.base / 'review-handoff'; handoff.mkdir(mode=0o700)
        (handoff / 'ledger-assignment.lock').touch(mode=0o600)
        ledger = self.fixture.base / 'ledger.json'
        ledger.write_text(json.dumps({'findings': [], 'reviewSummary': {}, 'reviewPolicy': {'mode': 'high_only'}})); ledger.chmod(0o600)
        self.assertEqual(ingest.ingest_once(self.queue.database, ledger)['newHighRisk'], 3)
        self.assertEqual(ingest.ingest_once(self.queue.database, ledger)['receipts'], 0)
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        self.assertEqual(self.queue.connection.execute('SELECT count(*) FROM attempts').fetchone()[0], 3)

    def test_partial_directory_receipts_publish_only_unaffected_files(self):
        self.fixture.control('partial-error')
        result = directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        self.assertEqual((result['completed'], result['held']), (2, 1))
        receipts = self.queue.receipts()
        self.assertEqual({r['path'] for r in receipts}, set(self.paths[1:]))
        self.assertEqual(self.queue.connection.execute('SELECT reason FROM files WHERE path=?', (self.paths[0],)).fetchone()[0], 'DIRECTORY_FILE_LLM_ERROR')
        self.assertEqual(self.queue.connection.execute('SELECT state FROM models WHERE id=1').fetchone()[0], 'quarantined')
        for row in receipts: self.assertTrue(self.queue.verify_receipt(row['attempt'])['verified'])
        handoff = self.fixture.base / 'review-handoff'; handoff.mkdir(mode=0o700)
        (handoff / 'ledger-assignment.lock').touch(mode=0o600)
        ledger = self.fixture.base / 'ledger.json'
        ledger.write_text(json.dumps({'findings': [], 'reviewSummary': {}, 'reviewPolicy': {'mode': 'high_only'}})); ledger.chmod(0o600)
        self.assertEqual(ingest.ingest_once(self.queue.database, ledger)['newHighRisk'], 2)
        self.assertEqual(ingest.ingest_once(self.queue.database, ledger)['receipts'], 0)
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        self.assertEqual(len(self.queue.receipts()), 2)

    def test_unscoped_or_inconsistent_errors_never_promote_any_file(self):
        for mode in ('unscoped-error', 'foreign-error', 'malformed-error', 'mismatched-errors', 'opaque-warning', 'cross-file'):
            with self.subTest(mode=mode):
                # A new owned queue is needed because held paths must not be replayed.
                if mode != 'unscoped-error':
                    self.tearDown(); self.setUp()
                self.fixture.control(mode)
                with self.assertRaises(directory_scan.queue.QueueError):
                    directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
                self.assertEqual(len(self.queue.receipts()), 0)
                row = self.queue.connection.execute('SELECT metadata,phase FROM directory_runs').fetchone()
                metadata = json.loads(row['metadata'])
                self.assertEqual(row['phase'], 'held')
                self.assertEqual(metadata['exitCode'], 0)
                self.assertTrue(metadata['result']['valid'])
                self.assertIn('diagnostics', metadata)

    def test_incomplete_checkpoint_holds_all_files_without_replay(self):
        self.fixture.control('bad-checkpoint')
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        self.assertEqual(self.queue.connection.execute("SELECT count(*) FROM files WHERE path LIKE 'module/%' AND state='held'").fetchone()[0], 3)
        self.assertEqual(len(self.queue.receipts()), 0)
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')

    def test_failed_one_file_canary_never_unlocks_generation(self):
        paths = self.fixture.add_directory('new-canary', ['a.py'])
        definition = self.fixture.definition('fresh-failed', 8)
        definition['eligiblePendingPaths'] = self.fixture.paths + paths
        ident = self.queue.add_model(definition)
        self.fixture.control('partial-error')
        result = directory_scan.run_directory(self.queue, 'new-canary', 'fixture', 'fresh-failed')
        self.assertEqual((result['completed'], result['held']), (0, 1))
        row = self.queue.connection.execute('SELECT canary,state FROM models WHERE id=?', (ident,)).fetchone()
        self.assertEqual((row['canary'], row['state']), (0, 'quarantined'))
        self.assertEqual(len(self.queue.receipts()), 0)

    def test_exit_receipt_recovers_after_owner_death_once(self):
        with mock.patch.object(directory_scan, 'publish_receipts', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        row = self.queue.connection.execute('SELECT id,phase,metadata FROM directory_runs').fetchone()
        self.assertEqual(row['phase'], 'held')
        self.assertIn('result', json.loads(row['metadata']))
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.recover_directory(self.queue, row['id'])
        with mock.patch.object(directory_scan.queue, 'alive', return_value=False):
            result = directory_scan.recover_directory(self.queue, row['id'])
        self.assertEqual(result['completed'], 3)
        self.assertEqual(len(self.queue.receipts()), 3)
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.recover_directory(self.queue, row['id'])

    def test_recovery_rejects_scanner_image_change(self):
        with mock.patch.object(directory_scan, 'publish_receipts', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        row = self.queue.connection.execute('SELECT id FROM directory_runs').fetchone()
        with self.fixture.fake.open('a') as stream: stream.write('\n# scanner changed\n')
        with mock.patch.object(directory_scan.queue, 'alive', return_value=False):
            with self.assertRaises(directory_scan.queue.QueueError):
                directory_scan.recover_directory(self.queue, row['id'])
        self.assertEqual(len(self.queue.receipts()), 0)

    def test_recovered_canary_does_not_revive_removed_generation(self):
        paths = self.fixture.add_directory('recovery-canary', ['a.py'])
        definition = self.fixture.definition('fresh-removed', 8)
        definition['eligiblePendingPaths'] = self.fixture.paths + paths
        ident = self.queue.add_model(definition)
        with mock.patch.object(directory_scan, 'publish_receipts', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                directory_scan.run_directory(self.queue, 'recovery-canary', 'fixture', 'fresh-removed')
        row = self.queue.connection.execute('SELECT id FROM directory_runs').fetchone()
        self.queue.model_change('fixture', 'fresh-removed', state='removed')
        with mock.patch.object(directory_scan.queue, 'alive', return_value=False):
            result = directory_scan.recover_directory(self.queue, row['id'])
        self.assertEqual(result['completed'], 1)
        model = self.queue.connection.execute('SELECT canary,state FROM models WHERE id=?', (ident,)).fetchone()
        self.assertEqual((model['canary'], model['state']), (0, 'removed'))

    def test_recovery_rejects_changed_session_or_missing_exit_receipt(self):
        with mock.patch.object(directory_scan, 'publish_receipts', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        row = self.queue.connection.execute('SELECT id,metadata FROM directory_runs').fetchone()
        metadata = json.loads(row['metadata'])
        session = self.fixture.sessions / (metadata['result']['session_id'] + '.jsonl')
        session.write_bytes(session.read_bytes() + b'{')
        with mock.patch.object(directory_scan.queue, 'alive', return_value=False):
            with self.assertRaises(directory_scan.queue.QueueError):
                directory_scan.recover_directory(self.queue, row['id'])
        self.assertEqual(len(self.queue.receipts()), 0)
        del metadata['result']
        with self.queue.transaction() as db:
            db.execute('UPDATE directory_runs SET metadata=? WHERE id=?', (json.dumps(metadata), row['id']))
        with mock.patch.object(directory_scan.queue, 'alive', return_value=False):
            with self.assertRaises(directory_scan.queue.QueueError):
                directory_scan.recover_directory(self.queue, row['id'])
        self.assertEqual(len(self.queue.receipts()), 0)

    def test_reserved_directory_fences_single_file_queue(self):
        paths, digest = directory_scan.preview(self.queue, 'module')
        directory_scan.reserve(self.queue, 'module', 'fixture', 'one', paths, digest)
        with self.assertRaises(fixture.ocr.QueueError):
            self.queue.pause(False)
        with self.queue.transaction() as db:
            db.execute("UPDATE meta SET value='false' WHERE key='paused'")
        self.assertIsNone(self.queue.claim())
        self.assertEqual(self.queue.connection.execute('SELECT count(*) FROM attempts').fetchone()[0], 0)

    def test_distinct_models_own_disjoint_directories_without_oversubscription(self):
        other = self.fixture.add_directory('other', ['a.py', 'b.py'])
        definition = self.fixture.definition('two', 4)
        definition['eligiblePendingPaths'] = self.fixture.paths + self.paths + other
        second = self.queue.add_model(definition)
        with self.queue.transaction() as db:
            db.execute('UPDATE models SET canary=1 WHERE id=?', (second,))
        first_paths, first_sha = directory_scan.preview(self.queue, 'module')
        other_paths, other_sha = directory_scan.preview(self.queue, 'other')
        directory_scan.reserve(self.queue, 'module', 'fixture', 'one', first_paths, first_sha)
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.reserve(self.queue, 'other', 'fixture', 'one', other_paths, other_sha)
        directory_scan.reserve(self.queue, 'other', 'fixture', 'two', other_paths, other_sha)
        rows = self.queue.connection.execute("SELECT directory, model_id FROM directory_runs WHERE phase='reserved' ORDER BY directory").fetchall()
        self.assertEqual([(row[0], row[1]) for row in rows], [('module', 1), ('other', second)])
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.reserve(self.queue, 'module', 'fixture', 'two', first_paths, first_sha)
        with self.assertRaises(fixture.ocr.QueueError):
            self.queue.pause(False)

    def test_new_generation_uses_one_file_directory_canary_before_full_capacity(self):
        path = self.fixture.add_directory('canary', ['a.py'])
        definition = self.fixture.definition('fresh', 4)
        definition['eligiblePendingPaths'] = self.fixture.paths + self.paths + path
        ident = self.queue.add_model(definition)
        files, digest = directory_scan.preview(self.queue, 'module')
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.reserve(self.queue, 'module', 'fixture', 'fresh', files, digest)
        result = directory_scan.run_directory(self.queue, 'canary', 'fixture', 'fresh')
        self.assertEqual(result['completed'], 1)
        row = self.queue.connection.execute('SELECT metadata FROM directory_runs WHERE id=?', (result['run'],)).fetchone()
        self.assertEqual(json.loads(row[0])['concurrency'], 1)
        self.assertEqual(self.queue.connection.execute('SELECT canary FROM models WHERE id=?', (ident,)).fetchone()[0], 1)
        run = directory_scan.reserve(self.queue, 'module', 'fixture', 'fresh', files, digest)
        row = self.queue.connection.execute('SELECT metadata FROM directory_runs WHERE id=?', (run,)).fetchone()
        self.assertEqual(json.loads(row[0])['concurrency'], 4)

    def test_expected_model_generation_cannot_silently_switch(self):
        files, digest = directory_scan.preview(self.queue, 'module')
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.reserve(self.queue, 'module', 'fixture', 'one', files, digest,
                                   expected_model_id=1, expected_generation=2)
        self.assertEqual(self.queue.connection.execute("SELECT count(*) FROM files WHERE path LIKE 'module/%' AND state='pending'").fetchone()[0], 3)
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.reserve(self.queue, 'module', 'fixture', 'one', files, digest,
                                   expected_model_id=1)
        run = directory_scan.reserve(self.queue, 'module', 'fixture', 'one', files, digest,
                                     expected_model_id=1, expected_generation=1)
        self.assertIsNotNone(run)

    def test_removed_model_is_fenced_between_reservation_and_dispatch(self):
        original = directory_scan.reserve
        def reserve_then_remove(q, *args, **kwargs):
            run = original(q, *args, **kwargs)
            q.model_change('fixture', 'one', state='removed')
            return run
        with mock.patch.object(directory_scan, 'reserve', side_effect=reserve_then_remove):
            with self.assertRaises(directory_scan.queue.QueueError):
                directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        self.assertEqual(self.queue.connection.execute("SELECT phase FROM directory_runs").fetchone()[0], 'held')
        self.assertFalse(list(self.fixture.sessions.glob('*.jsonl')))

    def test_changed_source_and_unpaused_queue_are_rejected_before_reservation(self):
        (self.fixture.snapshot / self.paths[0]).write_text('changed')
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')
        self.assertEqual(self.queue.connection.execute("SELECT count(*) FROM files WHERE path LIKE 'module/%' AND state='pending'").fetchone()[0], 3)
        self.queue.pause(False)
        with self.assertRaises(directory_scan.queue.QueueError):
            directory_scan.run_directory(self.queue, 'module', 'fixture', 'one')


if __name__ == '__main__':
    unittest.main()
