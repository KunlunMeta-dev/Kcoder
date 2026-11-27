"""Offline shared-queue tests. Every scanner, session and database is owned."""
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import signal
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
import threading
import time
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / "ocr_global_queue.py"
spec = importlib.util.spec_from_file_location("ocr_global_queue", SOURCE)
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)

FAKE = r'''#!PYTHON
import argparse, datetime, hashlib, json, os, pathlib, sys, time, uuid
p=argparse.ArgumentParser();p.add_argument('scan');
for name in ['repo','path','provider','model']:p.add_argument('--'+name)
a,_=p.parse_known_args(); root=pathlib.Path(a.repo); base=root.parent
control=json.loads((base/'control.json').read_text())
session=str(uuid.uuid4()); now=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
fingerprint=hashlib.sha256(b'full_scan\0'+a.path.encode()+b'\0'+(root/a.path).read_bytes()).hexdigest()
mode=control.get('mode','success')
start={'type':'session_start','sessionId':session,'timestamp':now,'cwd':str(root),'model':a.model,'reviewMode':'full_scan','scanPaths':[a.path]}
done={'type':'review_item_done','sessionId':session,'filePath':a.path,'oldPath':a.path,'newPath':a.path,'model':a.model,'fingerprint':fingerprint}
end={'type':'session_end','sessionId':session,'llm_failures':0}
if mode=='wrong-path':start['scanPaths']=['other.py']
if mode=='wrong-model':start['model']='other-model'
if mode=='wrong-fingerprint':done['fingerprint']='f'*64
if mode=='reused':done['type']='review_item_reused'
records=[start,done,end]
if mode in ('finding','secret','comment-body-mismatch'):
 done['comments']=[{'path':a.path,'content':'MOCK_API_KEY_do_not_persist_13579' if mode=='secret' else 'Synthetic finding','start_line':1,'end_line':1}]
if mode=='failed-last':records.insert(2,{**done,'type':'review_item_failed'})
if mode=='no-checkpoint':records=[start,end]
if mode=='llm-failure':end['llm_failures']=1
encoded=str(root).lstrip('/\\').replace('/','-').replace('\\','-')
session_path=pathlib.Path.home()/'.opencodereview'/'sessions'/encoded/(session+'.jsonl')
with open(session_path,'w',encoding='utf8') as f:
 os.chmod(session_path,0o600)
 for r in records:f.write(json.dumps(r)+'\n')
 if mode=='bad-tail':f.write('{')
result={'status':'success','session_id':session,'llm':{'provider':a.provider,'model':a.model},'comments':[],
 'summary':{'files_reviewed':1,'comments':0},'tool_calls':{'failure':0}}
if mode=='warning':result['status']='completed_with_warnings';result['warnings']=[{'type':'review_limit_reached'}]
if mode=='tool-failure':result['tool_calls']['failure']=1
if mode=='wrong-provider':result['llm']['provider']='foreign'
if mode=='budget':result['summary']['budget_exceeded']=True
if mode=='stderr-panic':sys.stderr.write('comment pool panic: owned fixture\n')
if mode in ('finding','secret','comment-body-mismatch'):
 result['comments']=done['comments'];result['summary']['comments']=1
if mode=='comment-body-mismatch':result['comments']=[dict(done['comments'][0],content='Different synthetic finding')]
if mode=='comment-count-mismatch':result['comments']=[{'path':a.path,'content':'Unexpected synthetic finding'}];result['summary']['comments']=1
if mode=='secret':
 sys.stderr.write('Authorization: Bearer MOCK_BEARER_do_not_persist_24680\n')
print(json.dumps(result),flush=True)
(base/'ready').write_text(session)
if mode=='block':
 while not (base/'release').exists():time.sleep(.01)
if mode=='nonzero':sys.exit(7)
'''


def claim_worker(database, output):
    queue = ocr.Queue(database)
    try:
        row = queue.claim()
        output.put(None if row is None else {key: row[key] for key in ('id', 'path', 'token')})
    finally:
        queue.close()


def launch_without_receipt(database, output):
    queue = ocr.Queue(database)
    row = queue.claim()
    child = ocr.launch(queue, row)
    child.wait(10)
    output.put((row['id'], row['token']))
    queue.close()


def launch_owned_and_exit(database, base, output):
    queue = ocr.Queue(database)
    row = queue.claim()
    child = ocr.launch(queue, row)
    deadline = time.monotonic() + 10
    while not (Path(base) / 'ready').exists() and time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError('fixture scanner exited before the controller')
        time.sleep(.01)
    if not (Path(base) / 'ready').exists():
        raise RuntimeError('fixture scanner did not start')
    output.put((row['id'], row['token'], child.pid))
    output.close(); output.join_thread()
    os._exit(0)


class GlobalQueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ocr-global-queue-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.home=self.base/'home';self.home.mkdir(mode=0o700)
        environment={key:value for key,value in os.environ.items() if not key.upper().startswith('GIT_')}
        environment['HOME']=str(self.home)
        self.environment=mock.patch.dict(os.environ,environment,clear=True)
        self.environment.start();self.addCleanup(self.environment.stop)
        self.snapshot = self.base / 'snapshot'; self.snapshot.mkdir()
        self.sessions = ocr.default_session_root(self.home,self.snapshot); self.sessions.mkdir(mode=0o700,parents=True)
        self.paths = [f'f{i:03}.py' for i in range(32)]
        for path in self.paths:(self.snapshot/path).write_text('fixture\n')
        self.fake = self.base/'fake-ocr';self.fake.write_text(FAKE.replace('PYTHON',sys.executable));self.fake.chmod(0o700)
        self.control('success')
        self.plan = {'schemaVersion':2,'status':'prepared_dynamic_shared_pool_paused','permanentFileAssignments':False,
          'snapshot':str(self.snapshot),'originCheckout':str(self.snapshot),'sourceCommit':'f'*40,'pendingPaths':self.paths,'completedExcluded':[],
          'heldPriorAttemptPaths':[],'activeClaims':[],'members':[self.definition('one',8)]}
        self.queue = ocr.Queue.create(self.base/'state', self.plan, self.fake, self.sessions, 64)
        self.children = []

    def tearDown(self):
        (self.base/'release').touch()
        for child in self.children:
            try:child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                # Only this test's child, whose start identity is still held by Popen.
                os.killpg(child.pid, signal.SIGKILL);child.wait(timeout=3)
        self.queue.close();self.temporary.cleanup()
        self.assertFalse(self.base.exists())

    def definition(self, model, concurrency):
        return {'provider':'fixture','model':model,'configuredConcurrency':concurrency,
                'eligiblePendingPaths':self.paths,'eligibilityPreviewSha256':'a'*64,'maxTokens':64}

    def control(self, mode):
        (self.base/'ready').unlink(missing_ok=True)
        (self.base/'control.json').write_text(json.dumps({'mode':mode}))

    def start(self):
        row = self.queue.claim();self.assertIsNotNone(row)
        child=ocr.launch(self.queue,row);self.children.append(child)
        return row,child

    def complete(self):
        row,child=self.start();child.wait(timeout=10)
        result=self.queue.finish(row['id'],row['token'],child.returncode)
        return row,result

    def warm(self):
        self.queue.pause(False)
        self.assertTrue(self.complete()[1])

    def add_directory(self, directory, names):
        (self.snapshot / directory).mkdir(parents=True, exist_ok=True)
        paths = [f'{directory}/{name}' for name in names]
        with self.queue.transaction() as db:
            for path in paths:
                (self.snapshot / path).write_text('fixture directory\n')
                sha, fingerprint = ocr.source_identity(self.snapshot, path)
                db.execute("INSERT INTO files(path,state,sha256,fingerprint) VALUES(?,'pending',?,?)", (path, sha, fingerprint))
                db.execute('INSERT INTO eligible VALUES(?,?)', (1, path))
        return paths

    def test_directory_scope_survives_new_models_and_preserves_other_files(self):
        paths = self.add_directory('selected', ['a.py', 'b.py', 'c.py'])
        self.queue.select_directory('selected')
        definition = self.definition('two', 4)
        definition['eligiblePendingPaths'] = self.paths + paths
        self.queue.add_model(definition)
        self.queue.pause(False)
        self.assertTrue(self.complete()[1])
        self.queue.model_change('fixture', 'one', state='draining')
        self.assertTrue(self.complete()[1])
        self.assertTrue(self.complete()[1])
        self.assertIsNone(self.queue.claim())
        self.assertEqual(self.queue.status()['directoryFiles'], {'completed': 3})
        rows = list(self.queue.connection.execute('SELECT path FROM attempts'))
        self.assertEqual({row[0] for row in rows}, set(paths))
        self.assertEqual(self.queue.connection.execute("SELECT count(*) FROM files WHERE state='pending'").fetchone()[0], 32)

    def test_directory_change_requires_pause_and_drain_and_preserves_history(self):
        self.add_directory('first', ['a.py', 'b.py'])
        self.add_directory('second', ['a.py'])
        self.queue.select_directory('first')
        self.queue.pause(False)
        with self.assertRaises(ocr.QueueError): self.queue.select_directory('second')
        row = self.queue.claim()
        self.queue.pause(True)
        with self.assertRaises(ocr.QueueError): self.queue.select_directory('second')
        self.queue.hold(row['id'], row['token'], 'fixture', release=True, quarantine=False)
        self.queue.select_directory('second')
        history = self.queue.meta('directoryHistory')
        self.assertEqual(history[-1]['directory'], 'first')
        self.assertEqual(history[-1]['counts'], {'held': 1, 'pending': 1})
        self.assertEqual(self.queue.status()['directory'], 'second')

    def test_directory_rejects_unsafe_and_missing_paths_without_changing_scope(self):
        self.add_directory('selected', ['a.py'])
        self.queue.select_directory('selected')
        (self.snapshot / 'link').symlink_to(self.snapshot / 'selected', target_is_directory=True)
        for path in ('../selected', '/selected', 'selected/..', 'link'):
            with self.subTest(path=path), self.assertRaises(ocr.QueueError):
                self.queue.select_directory(path)
        self.assertEqual(self.queue.directory(), 'selected')

    def test_paused_zero_claim_and_explicit_resume(self):
        self.assertTrue(self.queue.status()['paused'])
        self.assertIsNone(self.queue.claim())
        self.assertEqual(self.queue.status()['activeSlots'],0)
        self.assertEqual(self.queue.connection.execute('SELECT count(*) FROM attempts').fetchone()[0],0)
        self.warm()

    def test_real_multiprocess_sqlite_claims_are_unique(self):
        self.warm();ctx=multiprocessing.get_context('fork');output=ctx.Queue()
        workers=[ctx.Process(target=claim_worker,args=(str(self.queue.database),output)) for _ in range(16)]
        try:
            for worker in workers:worker.start()
            results=[output.get(timeout=10) for _ in workers]
            for worker in workers:worker.join(10);self.assertEqual(worker.exitcode,0)
            claims=[r for r in results if r]
            self.assertEqual(len(claims),8);self.assertEqual(len({r['path'] for r in claims}),8)
            self.queue.reconcile();self.assertEqual(self.queue.status()['activeSlots'],8)
            self.assertIsNone(self.queue.claim())
        finally:
            for worker in workers:
                if worker.is_alive():worker.kill();worker.join(3)
            output.close();output.join_thread()

    def test_new_generation_requires_own_canary_and_stale_token_fails(self):
        self.warm();self.queue.model_change('fixture','one',state='removed')
        new=self.queue.add_model(self.definition('one',4));row=self.queue.claim()
        self.assertEqual(row['model_id'],new);self.assertEqual(row['generation'],2)
        self.assertIsNone(self.queue.claim())
        with self.assertRaises(ocr.QueueError):self.queue.attempt(row['id'],'stale-token')
        child=ocr.launch(self.queue,row);self.children.append(child);child.wait(10)
        self.assertTrue(self.queue.finish(row['id'],row['token'],child.returncode))
        self.assertEqual(self.queue.status()['models'][-1]['canary'],1)

    def test_controller_exit_does_not_interrupt_or_duplicate_inflight_scan(self):
        self.warm(); self.control('block')
        ctx = multiprocessing.get_context('fork'); output = ctx.Queue()
        controller = ctx.Process(target=launch_owned_and_exit, args=(str(self.queue.database), str(self.base), output))
        controller.start(); ident, token, child_pid = output.get(timeout=15); controller.join(10)
        self.assertEqual(controller.exitcode, 0); output.close(); output.join_thread()
        row = self.queue.attempt(ident, token); owner = ocr.decode(row['process'])
        self.assertEqual(owner['pid'], child_pid)
        try:
            self.assertTrue(ocr.alive(owner))
            self.queue.reconcile()
            self.assertEqual(self.queue.attempt(ident, token)['status'], 'running')
            self.assertEqual(self.queue.connection.execute('SELECT count(*) FROM attempts WHERE path=?', (row['path'],)).fetchone()[0], 1)
            (self.base / 'release').touch()
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                self.queue.reconcile()
                if self.queue.attempt(ident, token)['status'] != 'running': break
                time.sleep(.03)
            self.assertEqual(self.queue.attempt(ident, token)['status'], 'completed')
            self.assertEqual(self.queue.connection.execute('SELECT count(*) FROM attempts WHERE path=?', (row['path'],)).fetchone()[0], 1)
        finally:
            if ocr.alive(owner) is True:
                os.killpg(owner['pgid'], signal.SIGTERM)

    def test_quarantined_inflight_tasks_do_not_starve_another_model(self):
        self.warm()
        self.queue.add_model(self.definition('two', 3))
        self.queue.model_change('fixture', 'one', state='draining')
        self.assertTrue(self.complete()[1])  # The second model passes its own canary.
        self.queue.model_change('fixture', 'one', state='active')
        occupied = [self.queue.claim() for _ in range(4)]
        self.assertTrue(all(row and row['model'] == 'one' for row in occupied))
        with self.queue.transaction() as db:
            for row in occupied:
                db.execute("UPDATE attempts SET status='running' WHERE id=?", (row['id'],))
            db.execute("UPDATE models SET state='quarantined' WHERE model='one'")
        candidate = self.queue.claim()
        self.assertIsNotNone(candidate, 'a quarantined peer must not consume another model capacity')
        self.assertEqual(candidate['model'], 'two')
        child = ocr.launch(self.queue, candidate); self.children.append(child); child.wait(timeout=10)
        self.assertTrue(self.queue.finish(candidate['id'], candidate['token']))
        self.assertEqual(len({row['path'] for row in occupied} | {candidate['path']}), 5)

    def test_reduced_limit_drains_without_starving_other_model(self):
        self.warm()
        self.queue.add_model(self.definition('two', 3))
        self.queue.model_change('fixture', 'one', state='draining')
        self.assertTrue(self.complete()[1])
        self.queue.model_change('fixture', 'one', state='active')
        occupied = [self.queue.claim() for _ in range(4)]
        self.assertTrue(all(row and row['model'] == 'one' for row in occupied))
        with self.queue.transaction() as db:
            for row in occupied:
                db.execute("UPDATE attempts SET status='running' WHERE id=?", (row['id'],))
        self.queue.model_change('fixture', 'one', concurrency=1)
        candidate = self.queue.claim()
        self.assertIsNotNone(candidate, 'already admitted work must not consume another model capacity')
        self.assertEqual(candidate['model'], 'two')
        child = ocr.launch(self.queue, candidate); self.children.append(child); child.wait(timeout=10)
        self.assertTrue(self.queue.finish(candidate['id'], candidate['token']))

    def test_dynamic_drain_remove_add_and_lower_concurrency_keep_original_claims(self):
        self.warm();first=self.queue.claim();second=self.queue.claim()
        self.queue.model_change('fixture','one',concurrency=1)
        self.assertIsNone(self.queue.claim());self.assertEqual(self.queue.attempt(first['id'],first['token'])['status'],'claimed')
        self.queue.model_change('fixture','one',state='draining')
        self.assertIsNone(self.queue.claim())
        self.queue.model_change('fixture','one',state='removed');self.queue.add_model(self.definition('two',2))
        # Preserve the two old claims while allowing the new service one canary.
        self.assertEqual(self.queue.status()['activeSlots'], 2)
        candidate = self.queue.claim()
        self.assertEqual(candidate['model'], 'two')
        self.assertIsNone(self.queue.claim())
        self.assertEqual(len({first['path'], second['path'], candidate['path']}), 3)
        self.assertEqual(self.queue.attempt(first['id'], first['token'])['status'], 'claimed')
        self.assertEqual(self.queue.attempt(second['id'], second['token'])['status'], 'claimed')

    def test_pause_after_claim_blocks_dispatch(self):
        self.queue.pause(False);row=self.queue.claim();self.queue.pause(True)
        with self.assertRaises(ocr.QueueError):ocr.launch(self.queue,row)
        self.assertFalse((self.base/'ready').exists())

    def test_reduced_capacity_fences_reserved_claim_but_does_not_cancel_running(self):
        self.warm();self.control('block');first=self.queue.claim();second=self.queue.claim()
        self.queue.model_change('fixture','one',concurrency=1)
        child=ocr.launch(self.queue,first);self.children.append(child)
        deadline=time.monotonic()+5
        while not (self.base/'ready').exists():
            self.assertLess(time.monotonic(),deadline);time.sleep(.01)
        blocked=ocr.launch(self.queue,second);self.children.append(blocked);blocked.wait(5)
        self.assertIsNone(child.poll())
        self.assertEqual(self.queue.attempt(second['id'],second['token'])['status'],'held')
        self.assertEqual(self.queue.attempt(second['id'],second['token'])['slot_active'],0)
        (self.base/'release').touch();child.wait(5)
        self.assertTrue(self.queue.finish(first['id'],first['token'],child.returncode))

    def test_full_process_not_checkpoint_alone_owns_slot(self):
        self.queue.pause(False);self.control('block');row,child=self.start()
        deadline=time.monotonic()+5
        while not (self.base/'ready').exists():
            self.assertLess(time.monotonic(),deadline);time.sleep(.01)
        self.assertFalse(self.queue.finish(row['id'],row['token']))
        self.assertEqual(self.queue.status()['activeSlots'],1);self.assertIsNone(self.queue.claim())
        self.queue.pause();(self.base/'release').touch();child.wait(5)
        self.assertTrue(self.queue.finish(row['id'],row['token'],child.returncode))
        self.assertEqual(self.queue.status()['activeSlots'],0)

    def test_failed_and_unknown_cannot_be_counted_or_reassigned(self):
        for mode in ['warning','tool-failure','wrong-provider','wrong-model','wrong-path','wrong-fingerprint',
                     'budget','failed-last','bad-tail','no-checkpoint','llm-failure','stderr-panic','nonzero']:
            with self.subTest(mode=mode):
                self.queue.model_change('fixture','one',state='active')
                self.queue.pause(False);self.control(mode);row,result=self.complete()
                self.assertFalse(result);self.assertEqual(self.queue.attempt(row['id'],row['token'])['status'],'held')
                self.assertEqual(self.queue.status()['files'].get('completed',0),0)
                self.assertIsNone(self.queue.claim())
        self.assertEqual(self.queue.status()['files']['held'],13)

    def test_reused_checkpoint_does_not_pass_new_service_canary(self):
        self.queue.pause(False);self.control('reused');row,result=self.complete()
        self.assertTrue(result);self.assertEqual(self.queue.status()['models'][0]['canary'],0)
        self.assertEqual(self.queue.status()['models'][0]['state'],'quarantined')

    def test_source_change_is_not_a_valid_completion(self):
        self.queue.pause(False);self.control('block');row,child=self.start()
        deadline=time.monotonic()+5
        while not (self.base/'ready').exists():
            self.assertLess(time.monotonic(),deadline);time.sleep(.01)
        (self.snapshot/row['path']).write_text('changed')
        (self.base/'release').touch();child.wait(5)
        self.assertFalse(self.queue.finish(row['id'],row['token'],child.returncode))

    def test_original_completed_and_held_plan_paths_never_enter_pool(self):
        self.queue.close();self.plan['pendingPaths']=self.paths[2:]
        self.plan['completedExcluded']=[self.paths[0]];self.plan['heldPriorAttemptPaths']=[self.paths[1]]
        self.plan['priorOwnersReconciled']=True
        self.queue=ocr.Queue.create(self.base/'other-state',self.plan,self.fake,self.sessions,64)
        self.warm();row=self.queue.claim();self.assertNotIn(row['path'],self.paths[:2])

    def test_restart_reconciles_original_checkpoint_not_cli_exit(self):
        self.queue.pause(False);ctx=multiprocessing.get_context('fork');output=ctx.Queue()
        driver=ctx.Process(target=launch_without_receipt,args=(str(self.queue.database),output));driver.start()
        ident,token=output.get(timeout=10);driver.join(10);self.assertEqual(driver.exitcode,0)
        output.close();output.join_thread()
        database=self.queue.database;self.queue.close();self.queue=ocr.Queue(database)
        self.queue.reconcile()
        self.assertEqual(self.queue.attempt(ident,token)['status'],'completed')
        self.assertEqual(self.queue.status()['activeSlots'],0)

    def test_cli_driver_respects_pause_and_drains_owned_fake_pool(self):
        command=[sys.executable,str(SOURCE),'--db',str(self.queue.database),'run','--once']
        paused=subprocess.run(command,capture_output=True,text=True,timeout=10)
        self.assertEqual(paused.returncode,0,paused.stderr);self.assertEqual(json.loads(paused.stdout)['activeSlots'],0)
        self.assertFalse((self.base/'ready').exists())
        self.queue.pause(False)
        finished=subprocess.run(command,capture_output=True,text=True,timeout=40)
        self.assertEqual(finished.returncode,0,finished.stderr)
        state=json.loads(finished.stdout);self.assertEqual(state['files'],{'completed':32});self.assertEqual(state['activeSlots'],0)

    def test_unknown_owner_namespace_keeps_slot_and_original_file(self):
        self.queue.pause(False);row=self.queue.claim()
        owner=ocr.process_identity();owner['namespace']+=1
        with self.queue.transaction() as db:
            db.execute("UPDATE attempts SET process=?,status='running' WHERE id=?",(json.dumps(owner),row['id']))
        self.assertFalse(self.queue.finish(row['id'],row['token']))
        self.assertEqual(self.queue.status()['activeSlots'],1)

    def test_recovered_nonzero_exit_never_becomes_clean_success(self):
        self.queue.pause(False);self.control('nonzero');ctx=multiprocessing.get_context('fork');output=ctx.Queue()
        driver=ctx.Process(target=launch_without_receipt,args=(str(self.queue.database),output));driver.start()
        ident,token=output.get(timeout=10);driver.join(10);self.assertEqual(driver.exitcode,0)
        output.close();output.join_thread();self.queue.reconcile()
        row=self.queue.attempt(ident,token)
        self.assertEqual(row['status'],'held');self.assertEqual(row['exit_code'],7)
        self.assertEqual(self.queue.status()['models'][0]['canary'],0)

    def test_private_artifacts_never_copy_raw_stdout_or_stderr_secrets(self):
        self.queue.pause(False);self.control('secret');self.assertTrue(self.complete()[1])
        for path in self.queue.database.parent.rglob('*'):
            if path.is_file():
                value=path.read_bytes()
                self.assertNotIn(b'MOCK_API_KEY_do_not_persist_13579',value,str(path))
                self.assertNotIn(b'MOCK_BEARER_do_not_persist_24680',value,str(path))

    def test_known_pause_before_spawn_does_not_quarantine_healthy_member(self):
        self.queue.pause(False);original=self.queue.claim
        def claim_then_pause():
            row=original()
            if row:self.queue.pause(True)
            return row
        with mock.patch.object(self.queue,'claim',side_effect=claim_then_pause):ocr.run(self.queue,once=True)
        self.assertFalse((self.base/'ready').exists())
        self.assertEqual(self.queue.status()['models'][0]['state'],'active')
        self.queue.pause(False);self.assertIsNotNone(self.queue.claim())

    def test_concurrent_finish_is_idempotent(self):
        self.queue.pause(False);row,child=self.start();child.wait(10)
        barrier=threading.Barrier(2);original=ocr.find_receipt
        def receipt(*args):
            value=original(*args);barrier.wait(timeout=5);return value
        def finish(_):
            queue=ocr.Queue(self.queue.database)
            try:return queue.finish(row['id'],row['token'],0)
            finally:queue.close()
        with mock.patch.object(ocr,'find_receipt',side_effect=receipt),ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(list(pool.map(finish,range(2),timeout=10)),[True,True])

    def test_arbitrary_session_root_cannot_redirect_receipt_discovery(self):
        foreign=self.base/'foreign-sessions';foreign.mkdir(mode=0o700)
        candidate=None
        try:
            with self.assertRaises(ocr.QueueError):candidate=ocr.Queue.create(self.base/'foreign-state',self.plan,self.fake,foreign,64)
        finally:
            if candidate:candidate.close()

    def test_git_environment_pollution_is_rejected_before_resume(self):
        for key in ['GIT_DIR','GIT_WORK_TREE','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0',
                    'GIT_CONFIG_VALUE_0','GIT_CEILING_DIRECTORIES','GIT_TRACE','GIT_PAGER']:
            with self.subTest(key=key),mock.patch.dict(os.environ,{key:'owned synthetic override'}):
                with self.assertRaises(ocr.QueueError):self.queue.pause(False)
                self.assertTrue(self.queue.status()['paused'])
        self.assertEqual(self.queue.connection.execute('SELECT count(*) FROM attempts').fetchone()[0],0)

    def test_origin_checkout_change_is_held_before_claim_without_blame_on_model(self):
        original=self.base/'origin';shutil.copytree(self.snapshot,original)
        self.queue.close();self.plan.pop('originCheckout');self.plan['safety']={'sourceCheckout':str(original)}
        self.queue=ocr.Queue.create(self.base/'origin-state',self.plan,self.fake,self.sessions,64)
        (original/self.paths[0]).write_text('edited by another owned actor')
        self.queue.pause(False);row=self.queue.claim()
        self.assertEqual(row['path'],self.paths[1]);self.assertEqual(self.queue.status()['files']['held'],1)
        self.assertEqual(self.queue.status()['models'][0]['state'],'active')

    def test_changed_input_after_claim_cannot_execute(self):
        self.queue.pause(False);row=self.queue.claim();(self.snapshot/row['path']).write_text('changed after claim')
        child=ocr.launch(self.queue,row);self.children.append(child);child.wait(10)
        self.assertFalse((self.base/'ready').exists())
        self.assertEqual(self.queue.attempt(row['id'],row['token'])['status'],'held')
        self.assertEqual(self.queue.attempt(row['id'],row['token'])['slot_active'],0)
        self.assertEqual(self.queue.status()['models'][0]['state'],'active')

    def test_plan_binary_hash_mismatch_cannot_initialize(self):
        self.plan['safety']={'scannerSha256':'0'*64}
        with self.assertRaises(ocr.QueueError):ocr.Queue.create(self.base/'wrong-image',self.plan,self.fake,self.sessions,64)
        self.assertFalse((self.base/'wrong-image'/'queue.sqlite').exists())

    def test_changed_receipt_artifact_cannot_settle_original_attempt(self):
        self.queue.pause(False);row,child=self.start();child.wait(10)
        path=self.queue.database.parent/row['id']/'stdout.log'
        data=json.loads(path.read_text());data['commentsCount']=999;path.write_text(json.dumps(data))
        self.assertFalse(self.queue.finish(row['id'],row['token'],child.returncode))

    def test_missing_durable_exit_receipt_never_infers_success(self):
        self.queue.pause(False);row,child=self.start();child.wait(10)
        with self.queue.transaction() as db:db.execute('UPDATE attempts SET exit_receipt=NULL WHERE id=?',(row['id'],))
        self.assertFalse(self.queue.finish(row['id'],row['token']))
        self.assertEqual(self.queue.status()['models'][0]['canary'],0)

    def test_late_removed_generation_receipt_cannot_validate_reintroduced_model(self):
        self.warm();self.control('block');old,child=self.start()
        deadline=time.monotonic()+5
        while not (self.base/'ready').exists():
            self.assertLess(time.monotonic(),deadline);time.sleep(.01)
        self.queue.model_change('fixture','one',state='removed')
        fresh=self.queue.add_model(self.definition('one',4));self.assertIsNone(self.queue.claim())
        (self.base/'release').touch();child.wait(5);self.assertTrue(self.queue.finish(old['id'],old['token']))
        model=self.queue.connection.execute('SELECT canary FROM models WHERE id=?',(fresh,)).fetchone()
        self.assertEqual(model['canary'],0)

    def test_legacy_schema_is_preserved_but_not_resumed(self):
        with self.queue.transaction() as db:db.execute("UPDATE meta SET value='1' WHERE key='schema'")
        with self.assertRaises(ocr.QueueError):ocr.Queue(self.queue.database)

    def test_model_registration_failure_is_atomic(self):
        definition=self.definition('bad',8);definition['eligiblePendingPaths']=[self.paths[0],'missing.py']
        with self.assertRaises(ocr.QueueError):self.queue.add_model(definition)
        self.assertEqual(len(self.queue.status()['models']),1)
        self.assertEqual(self.queue.connection.execute('SELECT count(*) FROM eligible').fetchone()[0],len(self.paths))

    def test_commit_lost_receipt_preserves_original_error_and_blocks_writes(self):
        original=self.queue.connection;failure=sqlite3.OperationalError('owned lost commit receipt')
        class FaultConnection:
            def __getattr__(self,name):return getattr(original,name)
            def execute(self,sql,*args):
                result=original.execute(sql,*args)
                if sql=='COMMIT':raise failure
                return result
        self.queue.connection=FaultConnection()
        with self.assertRaises(sqlite3.OperationalError) as caught:self.queue.model_change('fixture','one',concurrency=3)
        self.assertIs(caught.exception,failure)
        self.assertEqual(self.queue.status()['models'][0]['concurrency'],3)
        with self.assertRaises(ocr.QueueError):self.queue.claim()

    def test_failed_initialization_rolls_back_registry_and_closes_owned_connection(self):
        self.plan['members'].append(self.definition('second',4))
        captured=[];original=ocr.Queue._insert_model
        def fail_second(queue,db,definition):
            captured.append(queue)
            if definition['model']=='second':raise OSError('owned initialization fault')
            return original(queue,db,definition)
        with mock.patch.object(ocr.Queue,'_insert_model',new=fail_second):
            with self.assertRaises(OSError):ocr.Queue.create(self.base/'failed-init',self.plan,self.fake,self.sessions,64)
        with self.assertRaises(sqlite3.ProgrammingError):captured[0].connection.execute('SELECT 1')
        database=sqlite3.connect(self.base/'failed-init'/'queue.sqlite')
        try:
            self.assertEqual(database.execute('SELECT count(*) FROM meta').fetchone()[0],0)
            self.assertEqual(database.execute('SELECT count(*) FROM models').fetchone()[0],0)
        finally:database.close()

    def test_session_sha_is_bound_and_later_ingestion_recheck_rejects_changes(self):
        self.warm();receipt=self.queue.receipts()[0]
        self.assertEqual(len(receipt['session_sha256']),64)
        self.assertEqual(self.queue.verify_receipt(receipt['attempt'])['session_sha256'],receipt['session_sha256'])
        path=Path(receipt['session_file']);path.write_bytes(path.read_bytes()+b'\n')
        with self.assertRaises(ocr.QueueError):self.queue.verify_receipt(receipt['attempt'])
        self.assertEqual(self.queue.receipts()[0]['session_sha256'],receipt['session_sha256'])

    def test_receipt_cursor_orders_completion_not_claim_and_is_idempotent(self):
        self.warm();first_cursor=self.queue.receipts()[0]['sequence']
        first,one=self.start();second,two=self.start();one.wait(10);two.wait(10)
        self.assertTrue(self.queue.finish(second['id'],second['token'],two.returncode))
        newer=self.queue.receipts(first_cursor);self.assertEqual([r['attempt'] for r in newer],[second['id']])
        self.assertTrue(self.queue.finish(first['id'],first['token'],one.returncode))
        latest=self.queue.receipts(newer[-1]['sequence']);self.assertEqual([r['attempt'] for r in latest],[first['id']])
        self.assertTrue(self.queue.finish(second['id'],second['token'],two.returncode))
        self.assertEqual(len(self.queue.receipts()),3)

    def test_readonly_receipt_cli_returns_only_verified_metadata(self):
        self.warm();base=[sys.executable,str(SOURCE),'--db',str(self.queue.database)]
        response=subprocess.run(base+['receipts','--after','0','--limit','1'],capture_output=True,text=True,timeout=10)
        self.assertEqual(response.returncode,0,response.stderr);record=json.loads(response.stdout)[0]
        checked=subprocess.run(base+['verify-receipt',record['attempt']],capture_output=True,text=True,timeout=10)
        self.assertEqual(checked.returncode,0,checked.stderr)
        self.assertTrue(json.loads(checked.stdout)['verified'])
        self.assertNotIn('token',record);self.assertNotIn('comments',record)

    def test_result_and_checkpoint_comment_count_and_content_must_match(self):
        for mode in ['comment-count-mismatch','comment-body-mismatch']:
            with self.subTest(mode=mode):
                self.queue.model_change('fixture','one',state='active')
                self.queue.pause(False);self.control(mode)
                self.assertFalse(self.complete()[1])

    def test_one_finding_is_preserved_as_hash_without_logging_its_text(self):
        self.queue.pause(False);self.control('finding');row,success=self.complete()
        self.assertTrue(success)
        projected=json.loads((self.queue.database.parent/row['id']/'stdout.log').read_text())
        self.assertEqual(projected['commentsCount'],1)
        self.assertEqual(len(projected['commentsSha256']),64)
        self.assertNotIn('Synthetic finding',json.dumps(projected))


if __name__ == '__main__':
    unittest.main()
