"""Offline tests for owned, non-overlapping directory dispatch."""
import importlib.util
import json
import multiprocessing
import sqlite3
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest import mock

from scripts.quality.tests import test_ocr_global_queue as fixtures
from scripts.quality.tests import test_ocr_directory_scan as directory_fixtures

QUALITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(QUALITY))
spec = importlib.util.spec_from_file_location('ocr_directory_dispatch', QUALITY / 'ocr_directory_dispatch.py')
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)
from scripts.quality import ocr_directory_scan


def supervisor_worker(database, scopes, worker):
    q = dispatch.queue.Queue(database)
    try:
        dispatch.supervise(q, scopes, 'a' * 64, Path(worker), poll_seconds=.05)
    finally:
        q.close()


FAKE_DIRECTORY_WORKER = r'''#!PYTHON
import argparse,json,os,sqlite3,time,uuid,pathlib
raw=pathlib.Path('/proc/self/stat').read_text();f=raw[raw.rfind(')')+2:].split();owner={'boot':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'namespace':os.stat('/proc/self/ns/pid').st_ino,'pid':os.getpid(),'ticks':int(f[19]),'pgid':int(f[2]),'session':int(f[3]),'state':f[0]}
p=argparse.ArgumentParser()
for key in ['db','directory','provider','model','expected-model-id','expected-generation']:p.add_argument('--'+key,required=True)
a=p.parse_args();c=sqlite3.connect(a.db,timeout=10);c.execute('PRAGMA busy_timeout=10000');c.execute('BEGIN IMMEDIATE')
model=c.execute('SELECT id FROM models WHERE provider=? AND model=? ORDER BY generation DESC LIMIT 1',(a.provider,a.model)).fetchone()[0]
ident=str(uuid.uuid4());now=time.time_ns();c.execute("INSERT INTO directory_runs(id,directory,model_id,phase,created_ns,owner,metadata) VALUES(?,?,?,'running',?,?,?)",(ident,a.directory,model,now,json.dumps(owner),'{}'));c.execute("UPDATE files SET state='held' WHERE substr(path,1,?)=?",(len(a.directory)+1,a.directory+'/'));c.commit()
time.sleep({'alpha':1.3,'beta':3.0,'gamma':.1,'delta':.1}[a.directory]);c.execute('BEGIN IMMEDIATE');c.execute("UPDATE files SET state='completed' WHERE substr(path,1,?)=?",(len(a.directory)+1,a.directory+'/'));c.execute("UPDATE directory_runs SET phase='completed',reason=? WHERE id=?",(str(time.time_ns()),ident));c.commit();c.close()
'''


class DirectoryDispatchTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.GlobalQueueTests('test_paused_zero_claim_and_explicit_resume')
        self.case.setUp()
        self.q = self.case.queue
        self.paths = {}
        for name, files in [('alpha', ['a.py', 'b.py']), ('beta', ['a.py', 'b.py']),
                            ('gamma', ['a.py']), ('delta', ['a.py'])]:
            self.paths[name] = self.case.add_directory(name, files)
        self.scopes = []
        for name, paths in self.paths.items():
            entries = [{'path': path, 'sha256': self.q.connection.execute(
                'SELECT sha256 FROM files WHERE path=?', (path,)).fetchone()[0]} for path in paths]
            self.scopes.append({'directory': name, 'reviewable': len(entries), 'files': entries})
        with self.q.transaction() as db:
            db.execute('UPDATE models SET canary=1 WHERE id=1')
            db.execute(ocr_directory_scan.RUN_TABLE)
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try: child.wait(3)
                except subprocess.TimeoutExpired: child.kill(); child.wait(3)
        self.case.tearDown()
        self.case.doCleanups()

    def add_model(self, name, canary=1):
        definition = self.case.definition(name, 4)
        definition['eligiblePendingPaths'] = self.case.paths + [p for paths in self.paths.values() for p in paths]
        ident = self.q.add_model(definition)
        with self.q.transaction() as db:
            db.execute('UPDATE models SET canary=? WHERE id=?', (canary, ident))
        return ident

    def sleeper(self, *args, **kwargs):
        child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
        self.children.append(child)
        return child

    def claim(self):
        return dispatch.claim(self.q, self.scopes, 'a' * 64)

    def start(self, job):
        return dispatch.launch(self.q, job, QUALITY / 'ocr_directory_scan.py', popen=self.sleeper)

    def complete(self, job, child, phase='completed'):
        with self.q.transaction() as db:
            db.execute('''INSERT INTO directory_runs(id,directory,model_id,phase,created_ns,owner,metadata)
                VALUES(?,?,?,?,?,?,?)''', (job['id'], job['directory'], job['model_id'], phase,
                time.time_ns(), json.dumps(fixtures.ocr.process_identity(child.pid)), '{}'))
            for path in self.paths[job['directory']]:
                db.execute('UPDATE files SET state=? WHERE path=?',
                           ('completed' if phase == 'completed' else 'held', path))
        child.terminate(); child.wait(3)

    def test_distinct_models_get_distinct_directories_and_refill_immediately(self):
        self.add_model('two')
        first = self.claim(); a = self.start(first)
        second = self.claim(); b = self.start(second)
        self.assertEqual((first['model'], second['model']), ('one', 'two'))
        self.assertNotEqual(first['directory'], second['directory'])
        self.assertIsNone(self.claim())
        self.complete(first, a)
        dispatch.reconcile(self.q, {first['id']: a, second['id']: b})
        replacement = self.claim()
        self.assertEqual(replacement['model'], 'one')
        self.assertEqual(replacement['directory'], 'gamma')
        self.assertNotIn(replacement['directory'], (first['directory'], second['directory']))

    def test_new_generation_needs_single_file_canary(self):
        self.q.model_change('fixture', 'one', state='removed')
        self.add_model('one', canary=0)
        job = self.claim()
        self.assertEqual(job['generation'], 2)
        self.assertEqual(job['directory'], 'gamma')
        self.assertEqual(len(self.paths[job['directory']]), 1)
        self.assertIsNone(self.claim())

    def test_unproven_model_gets_one_file_scope_before_active_model_consumes_it(self):
        self.add_model('two', canary=0)
        self.scopes = [self.scopes[2], self.scopes[0], self.scopes[1]]
        job = self.claim()
        self.assertEqual((job['model'], job['directory']), ('two', 'gamma'))
        next_job = self.claim()
        self.assertEqual((next_job['model'], next_job['directory']), ('one', 'alpha'))

    def test_unknown_spawn_is_never_replayed_after_restart(self):
        first = self.claim()
        dispatch.reconcile(self.q, {})
        self.assertEqual(self.q.connection.execute('SELECT status FROM directory_dispatches WHERE id=?',
                                                 (first['id'],)).fetchone()[0], 'uncertain')
        self.assertIsNone(self.claim())
        self.add_model('two')
        second = self.claim()
        self.assertEqual(second['model'], 'two')
        self.assertNotEqual(first['directory'], second['directory'])
        self.assertEqual(self.q.connection.execute('SELECT count(*) FROM directory_dispatches WHERE directory=?',
                                                 (first['directory'],)).fetchone()[0], 1)

    def test_failed_preflight_is_blocked_and_next_directory_is_admitted(self):
        (self.case.snapshot / self.paths['alpha'][0]).write_text('source changed')
        job = self.claim()
        self.assertEqual(job['directory'], 'beta')
        self.assertEqual(self.q.connection.execute("SELECT status FROM directory_dispatches WHERE directory='alpha'").fetchone()[0], 'blocked')
        self.assertEqual(self.q.connection.execute("SELECT count(*) FROM attempts").fetchone()[0], 0)

    def test_existing_external_run_and_old_generation_block_same_service(self):
        old = self.q.connection.execute("SELECT id FROM models WHERE model='one'").fetchone()[0]
        with self.q.transaction() as db:
            db.execute("UPDATE models SET state='removed' WHERE id=?", (old,))
            db.execute('''INSERT INTO directory_runs(id,directory,model_id,phase,created_ns,owner,metadata)
                VALUES('foreign','alpha',?,'running',?,?,?)''',
                (old, time.time_ns(), json.dumps(fixtures.ocr.process_identity()), '{}'))
        self.add_model('one', canary=1)
        self.add_model('two')
        job = self.claim()
        self.assertEqual(job['model'], 'two')
        self.assertNotEqual(job['directory'], 'alpha')

    def test_unrelated_receipt_cannot_release_a_model_and_late_owned_receipt_can(self):
        job = self.claim(); child = self.start(job)
        actual_owner = self.q.connection.execute('SELECT worker FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()[0]
        self.complete(job, child)
        with self.q.transaction() as db:
            db.execute('UPDATE directory_runs SET owner=? WHERE id=?', (json.dumps(fixtures.ocr.process_identity()), job['id']))
        dispatch.reconcile(self.q, {job['id']: child})
        row = self.q.connection.execute('SELECT status FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()
        self.assertEqual(row[0], 'uncertain')
        self.assertIsNone(self.claim())
        with self.q.transaction() as db:
            db.execute('UPDATE directory_runs SET owner=? WHERE id=?', (actual_owner, job['id']))
        dispatch.reconcile(self.q, {})
        row = self.q.connection.execute('SELECT status FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()
        self.assertEqual(row[0], 'completed')
        self.assertNotEqual(self.claim()['directory'], job['directory'])

    def test_partially_completed_directory_is_terminal_but_never_replayed(self):
        job = self.claim(); child = self.start(job)
        self.complete(job, child, phase='partially_completed')
        dispatch.reconcile(self.q, {job['id']: child})
        self.assertEqual(self.q.connection.execute('SELECT status FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()[0], 'partially_completed')
        self.assertNotEqual(self.claim()['directory'], job['directory'])

    def test_model_removal_does_not_cancel_or_replace_its_inflight_session(self):
        job = self.claim(); child = self.start(job)
        self.q.model_change('fixture', 'one', state='removed')
        self.add_model('one', canary=1)
        self.assertIsNone(self.claim())
        self.assertIsNone(child.poll())
        self.complete(job, child)
        dispatch.reconcile(self.q, {job['id']: child})
        replacement = self.claim()
        self.assertEqual(replacement['generation'], 2)
        self.assertNotEqual(replacement['directory'], job['directory'])

    def test_nonzero_child_exit_is_terminal_and_not_retried(self):
        job = self.claim(); child = self.start(job)
        child.terminate(); child.wait(3)
        dispatch.reconcile(self.q, {job['id']: child})
        self.assertEqual(self.q.connection.execute('SELECT status FROM directory_dispatches WHERE id=?',
                                                 (job['id'],)).fetchone()[0], 'blocked')
        replacement = self.claim()
        self.assertNotEqual(replacement['directory'], job['directory'])

    def test_real_supervisor_observes_model_join_and_refills_without_overlap(self):
        fake = self.case.base / 'fake-directory-worker.py'
        fake.write_text(FAKE_DIRECTORY_WORKER.replace('PYTHON', sys.executable))
        process = multiprocessing.get_context('fork').Process(target=supervisor_worker,
                    args=(str(self.q.database), self.scopes, str(fake)))
        process.start()
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                rows = self.q.connection.execute("SELECT directory,phase FROM directory_runs").fetchall()
                if any(r['directory'] == 'alpha' and r['phase'] == 'running' for r in rows): break
                time.sleep(.02)
            else: self.fail('first owned directory did not start')
            self.add_model('two')
            while time.monotonic() < deadline:
                rows = self.q.connection.execute("SELECT directory,phase FROM directory_runs").fetchall()
                if len(rows) == 4 and all(r['phase'] == 'completed' for r in rows): break
                time.sleep(.05)
            else: self.fail('directory sessions did not settle after model joined')
            self.assertTrue(process.is_alive())
            rows = {r['directory']: r for r in self.q.connection.execute('SELECT * FROM directory_runs')}
            self.assertLess(rows['beta']['created_ns'], int(rows['alpha']['reason']))
            self.assertLess(rows['gamma']['created_ns'], int(rows['beta']['reason']))
            self.assertEqual(len(rows), 4)
            self.assertEqual(self.q.connection.execute('SELECT count(*) FROM directory_dispatches').fetchone()[0], 4)
        finally:
            process.terminate();process.join(5)
            if process.is_alive(): process.kill();process.join(3)

    def test_retired_model_releases_only_proven_unreserved_files_with_audit(self):
        self.add_model('two')
        job = self.claim(); child = self.start(job)
        self.q.model_change('fixture', 'one', state='removed')
        child.terminate(); child.wait(3)
        dispatch.reconcile(self.q, {job['id']: child})
        row = self.q.connection.execute('SELECT * FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()
        self.assertEqual(row['status'], 'released_no_reservation')
        evidence = json.loads(row['evidence_json'])
        self.assertTrue(evidence['workerExited'] and evidence['workerGroupGone'])
        self.assertEqual((evidence['directoryRunCount'], evidence['attemptCount']), (0, 0))
        self.assertTrue(all(item['state'] == 'pending' for item in evidence['files']))
        next_job = self.claim()
        self.assertEqual((next_job['directory'], next_job['model']), (job['directory'], 'two'))
        self.assertEqual(self.q.connection.execute('SELECT count(*) FROM directory_dispatches WHERE directory=?',
                                                  (job['directory'],)).fetchone()[0], 2)

    def test_same_active_model_exit_without_reservation_is_not_released(self):
        job = self.claim(); child = self.start(job)
        child.terminate(); child.wait(3)
        dispatch.reconcile(self.q, {job['id']: child})
        row = self.q.connection.execute('SELECT status,evidence_json FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()
        self.assertEqual((row['status'], row['evidence_json']), ('blocked', None))
        self.assertNotEqual(self.claim()['directory'], job['directory'])

    def test_unknown_owner_cannot_release_directory_even_if_model_removed(self):
        job = self.claim(); child = self.start(job)
        self.q.model_change('fixture', 'one', state='removed')
        worker = json.loads(self.q.connection.execute('SELECT worker FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()[0])
        worker['namespace'] = -1
        with self.q.transaction() as db:
            db.execute('UPDATE directory_dispatches SET worker=? WHERE id=?', (json.dumps(worker), job['id']))
        child.terminate(); child.wait(3)
        # A fresh supervisor has no owned Popen receipt and must trust identity proof.
        dispatch.reconcile(self.q, {})
        row = self.q.connection.execute('SELECT status,evidence_json FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()
        self.assertEqual((row['status'], row['evidence_json']), ('uncertain', None))

    def test_live_owner_does_not_release_even_if_model_removed(self):
        job = self.claim(); child = self.start(job)
        self.q.model_change('fixture', 'one', state='removed')
        dispatch.reconcile(self.q, {})
        self.assertEqual(self.q.connection.execute('SELECT status FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()[0], 'running')
        self.assertIsNone(child.poll())

    def test_unconfirmed_process_group_cannot_release(self):
        job = self.claim(); child = self.start(job)
        self.q.model_change('fixture', 'one', state='removed')
        child.terminate(); child.wait(3)
        with mock.patch.object(dispatch.queue, 'group_gone', return_value=False):
            dispatch.reconcile(self.q, {job['id']: child})
        row = self.q.connection.execute('SELECT status,evidence_json FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()
        self.assertNotEqual(row['status'], 'released_no_reservation')
        self.assertIsNone(row['evidence_json'])

    def test_legacy_dispatch_schema_is_rejected_without_writing_or_launching(self):
        with self.q.transaction() as db:
            db.execute('CREATE TABLE directory_dispatches(id TEXT PRIMARY KEY,directory TEXT UNIQUE,status TEXT)')
        with self.assertRaises(dispatch.queue.QueueError): self.claim()
        self.assertEqual(self.q.connection.execute('SELECT count(*) FROM directory_dispatches').fetchone()[0], 0)

    def test_claimed_or_held_files_are_not_released_when_model_removed(self):
        for state, directory in [('claimed', 'alpha'), ('held', 'beta')]:
            with self.subTest(state=state):
                job = self.claim(); self.assertEqual(job['directory'], directory)
                child = self.start(job)
                with self.q.transaction() as db:
                    db.execute('UPDATE files SET state=? WHERE path=?', (state, self.paths[directory][0]))
                    db.execute("UPDATE models SET state='draining' WHERE id=?", (job['model_id'],))
                child.terminate(); child.wait(3)
                dispatch.reconcile(self.q, {job['id']: child})
                row = self.q.connection.execute('SELECT status,evidence_json FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()
                self.assertNotEqual(row['status'], 'released_no_reservation')
                self.assertIsNone(row['evidence_json'])
                with self.q.transaction() as db:
                    db.execute("UPDATE models SET state='active' WHERE id=?", (job['model_id'],))

    def test_existing_reservation_is_never_released_on_model_removal(self):
        job = self.claim(); child = self.start(job)
        worker = self.q.connection.execute('SELECT worker FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()[0]
        with self.q.transaction() as db:
            db.execute("INSERT INTO directory_runs(id,directory,model_id,phase,created_ns,owner,metadata) VALUES(?,?,?,'running',?,?,?)",
                (job['id'],job['directory'],job['model_id'],time.time_ns(),worker,'{}'))
            db.execute("UPDATE models SET state='removed' WHERE id=?", (job['model_id'],))
        child.terminate(); child.wait(3)
        dispatch.reconcile(self.q, {job['id']: child})
        row = self.q.connection.execute('SELECT status,evidence_json FROM directory_dispatches WHERE id=?', (job['id'],)).fetchone()
        self.assertEqual((row['status'], row['evidence_json']), ('uncertain', None))

    def test_child_is_bound_to_expected_model_id_and_generation(self):
        job = self.claim(); captured = []
        def record(argv, **kwargs):
            captured.append(argv);return self.sleeper()
        dispatch.launch(self.q, job, QUALITY / 'ocr_directory_scan.py', popen=record)
        argv = captured[0]
        self.assertEqual(argv[argv.index('--expected-model-id') + 1], str(job['model_id']))
        self.assertEqual(argv[argv.index('--expected-generation') + 1], str(job['generation']))

    def test_plan_rejects_ancestor_directories_and_duplicate_files(self):
        doc = {'schemaVersion': 1, 'snapshotIdentity': self.q.meta('snapshotIdentity'),
               'scannerSha256': self.q.meta('scannerSha256'), 'scopes': self.scopes}
        path = self.case.base / 'plan.json';path.write_text(json.dumps(doc));path.chmod(0o600)
        scopes, digest = dispatch.plan_document(self.q, path)
        self.assertEqual(len(scopes), 4);self.assertEqual(len(digest), 64)
        bad = dict(doc, scopes=[self.scopes[0], {'directory': 'alpha/nested', 'reviewable': 1,
                     'files': [{'path': 'alpha/nested/z.py', 'sha256': 'a' * 64}]}])
        path.write_text(json.dumps(bad))
        with self.assertRaises(dispatch.queue.QueueError): dispatch.plan_document(self.q, path)


class NativeDirectoryDispatchIntegrationTests(unittest.TestCase):
    def test_real_dispatcher_runs_multiple_disjoint_directory_sessions(self):
        case = fixtures.GlobalQueueTests('test_paused_zero_claim_and_explicit_resume')
        with mock.patch.object(fixtures, 'FAKE', directory_fixtures.FAKE):
            case.setUp()
        q = case.queue
        process = None
        try:
            folders = {'alpha': case.add_directory('alpha', ['a.py', 'b.py']),
                       'beta': case.add_directory('beta', ['a.py', 'b.py']),
                       'gamma': case.add_directory('gamma', ['a.py'])}
            scopes = [{'directory': name, 'reviewable': len(paths), 'files': [
                       {'path': path, 'sha256': q.connection.execute('SELECT sha256 FROM files WHERE path=?', (path,)).fetchone()[0]}
                       for path in paths]} for name, paths in folders.items()]
            definition = case.definition('two', 4)
            definition['eligiblePendingPaths'] = case.paths + [p for paths in folders.values() for p in paths]
            second = q.add_model(definition)
            with q.transaction() as db:
                db.execute('UPDATE models SET canary=1 WHERE id IN (?,?)', (1, second))
            process = multiprocessing.get_context('fork').Process(target=supervisor_worker,
                       args=(str(q.database), scopes, str(QUALITY / 'ocr_directory_scan.py')))
            process.start(); deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                if not process.is_alive(): self.fail('directory dispatcher stopped unexpectedly')
                exists = q.connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='directory_dispatches'").fetchone()
                if exists:
                    rows = q.connection.execute('SELECT directory,status FROM directory_dispatches ORDER BY directory').fetchall()
                    if len(rows) == 3 and all(r['status'] == 'completed' for r in rows): break
                    if any(r['status'] in ('blocked', 'uncertain', 'held', 'partially_completed') for r in rows):
                        self.fail('owned directory session was held or blocked: ' + repr([tuple(r) for r in rows]))
                time.sleep(.05)
            else: self.fail('owned directory sessions did not finish')
            runs = q.connection.execute('SELECT directory,model_id,phase FROM directory_runs ORDER BY directory').fetchall()
            self.assertEqual(len(runs), 3)
            self.assertEqual({r['directory'] for r in runs}, set(folders))
            self.assertEqual(len({r['model_id'] for r in runs}), 2)
            self.assertTrue(all(r['phase'] == 'completed' for r in runs))
            receipts = q.receipts()
            self.assertEqual(len(receipts), 5)
            self.assertEqual(len({r['path'] for r in receipts}), 5)
            self.assertEqual(len({r['session_uuid'] for r in receipts}), 3)
            for receipt in receipts: self.assertTrue(q.verify_receipt(receipt['attempt'])['verified'])
        finally:
            if process is not None:
                process.terminate();process.join(5)
                if process.is_alive(): process.kill();process.join(3)
            case.tearDown();case.doCleanups()


if __name__ == '__main__':
    unittest.main()
