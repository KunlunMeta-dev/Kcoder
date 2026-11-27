#!/usr/bin/env python3
"""Schedule disjoint native OCR directory sessions without replaying unknown work."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import uuid

import ocr_global_queue as queue


DISPATCH_TABLE = '''CREATE TABLE IF NOT EXISTS directory_dispatches(
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, plan_sha256 TEXT NOT NULL, scope_json TEXT NOT NULL,
    provider TEXT, model TEXT, generation INTEGER, model_id INTEGER,
    status TEXT NOT NULL, controller TEXT NOT NULL, worker TEXT,
    created_ns INTEGER NOT NULL, exit_code INTEGER, reason TEXT, evidence_json TEXT)'''
DISPATCH_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS directory_dispatch_unique_scope ON directory_dispatches(directory) WHERE status != 'released_no_reservation'"
ACTIVE = ('starting', 'running', 'uncertain')
TERMINAL_RUN = ('completed', 'held', 'partially_completed')


def init_dispatch_tables(db):
    db.execute(DISPATCH_TABLE)
    columns = {row['name'] for row in db.execute('PRAGMA table_info(directory_dispatches)')}
    queue.require({'scope_json', 'evidence_json'} <= columns, 'unsupported directory dispatcher schema')
    # A legacy UNIQUE(directory) autoindex would prevent auditable reassignment.
    indexes = db.execute('PRAGMA index_list(directory_dispatches)').fetchall()
    queue.require(not any(row['unique'] and row['origin'] == 'u' for row in indexes),
                  'legacy directory dispatcher schema requires reconciliation')
    db.execute(DISPATCH_INDEX)


def table_exists(db, name):
    return bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())


def plan_document(q, path):
    raw = queue.read_regular(path, private=True)
    doc = queue.decode(raw)
    queue.require(isinstance(doc, dict) and doc.get('schemaVersion') == 1
                  and doc.get('snapshotIdentity') == q.meta('snapshotIdentity')
                  and doc.get('scannerSha256') == q.meta('scannerSha256'), 'directory plan identity mismatch')
    scopes = doc.get('scopes')
    queue.require(isinstance(scopes, list) and bool(scopes), 'empty directory plan')
    seen_dirs, seen_files = set(), set()
    for scope in scopes:
        queue.require(isinstance(scope, dict), 'invalid directory scope')
        directory = queue.relative_path(scope.get('directory'))
        queue.require(not any(directory == other or directory.startswith(other + '/') or other.startswith(directory + '/')
                              for other in seen_dirs), 'overlapping directories')
        seen_dirs.add(directory)
        files = scope.get('files')
        queue.require(isinstance(files, list) and files and scope.get('reviewable') == len(files), 'invalid plan files')
        for entry in files:
            queue.require(isinstance(entry, dict) and queue.re_sha(entry.get('sha256')), 'invalid plan source digest')
            path = queue.relative_path(entry.get('path'))
            queue.require(path.startswith(directory + '/') and path not in seen_files, 'overlapping plan files')
            seen_files.add(path)
    return scopes, hashlib.sha256(raw).hexdigest()


def service_busy(db, provider, model):
    if db.execute("SELECT 1 FROM directory_dispatches WHERE provider=? AND model=? AND status IN ('starting','running','uncertain') LIMIT 1",
                  (provider, model)).fetchone():
        return True
    if table_exists(db, 'directory_runs'):
        return bool(db.execute('''SELECT 1 FROM directory_runs r JOIN models m ON m.id=r.model_id
            WHERE m.provider=? AND m.model=? AND r.phase IN ('reserved','running','uncertain') LIMIT 1''',
            (provider, model)).fetchone())
    return False


def scope_is_current(q, db, scope):
    prefix = scope['directory'] + '/'
    rows = db.execute('SELECT * FROM files WHERE substr(path,1,?)=?', (len(prefix), prefix)).fetchall()
    expected = {item['path']: item['sha256'] for item in scope['files']}
    queue.require(len(rows) == len(expected) and {row['path'] for row in rows} == set(expected),
                  'directory inputs differ from plan')
    for row in rows:
        queue.require(row['state'] == 'pending' and row['sha256'] == expected[row['path']]
                      and not db.execute('SELECT 1 FROM attempts WHERE path=?', (row['path'],)).fetchone(),
                      'directory files already attempted or changed')
        queue.verify_inputs(q, row)
    return rows


def claim(q, scopes, plan_sha):
    """Atomically record intent; unknown intent is never automatically replayed."""
    with q.transaction() as db:
        q.require_host()
        queue.require(q.meta('paused') is True, 'single-file queue must remain paused')
        queue.require(not db.execute('SELECT 1 FROM attempts WHERE slot_active=1 LIMIT 1').fetchone(),
                      'single-file queue still has active work')
        init_dispatch_tables(db)
        models = db.execute('''SELECT * FROM models m WHERE state='active' AND concurrency>0
            AND generation=(SELECT max(generation) FROM models WHERE provider=m.provider AND model=m.model)
            ORDER BY canary ASC,id''').fetchall()
        for model in models:
            if service_busy(db, model['provider'], model['model']):
                continue
            for scope in scopes:
                directory = scope['directory']
                if db.execute("SELECT 1 FROM directory_dispatches WHERE directory=? AND status!='released_no_reservation'", (directory,)).fetchone():
                    continue
                if table_exists(db, 'directory_runs') and db.execute('''SELECT 1 FROM directory_runs
                    WHERE directory=? AND phase IN ('reserved','running','uncertain','completed','held','partially_completed')''',
                    (directory,)).fetchone():
                    continue
                if not model['canary'] and len(scope['files']) != 1:
                    continue
                if any(not db.execute('SELECT 1 FROM eligible WHERE model_id=? AND path=?',
                                      (model['id'], row['path'])).fetchone() for row in scope['files']):
                    continue
                try:
                    scope_is_current(q, db, scope)
                except (queue.QueueError, OSError):
                    db.execute('''INSERT INTO directory_dispatches
                        (id,directory,plan_sha256,scope_json,status,controller,created_ns,reason)
                        VALUES(?,?,?,?,'blocked',?,?,?)''',
                        (str(uuid.uuid4()), directory, plan_sha, json.dumps(scope), json.dumps(queue.process_identity()),
                         time.time_ns(), 'INPUT_OR_RESERVATION_CHANGED'))
                    continue
                ident = str(uuid.uuid4())
                db.execute('''INSERT INTO directory_dispatches
                    (id,directory,plan_sha256,scope_json,provider,model,generation,model_id,status,controller,created_ns)
                    VALUES(?,?,?,?,?,?,?,?,'starting',?,?)''',
                    (ident, directory, plan_sha, json.dumps(scope), model['provider'], model['model'], model['generation'],
                     model['id'], json.dumps(queue.process_identity()), time.time_ns()))
                return dict(db.execute('SELECT * FROM directory_dispatches WHERE id=?', (ident,)).fetchone())
    return None


def launch(q, job, worker_script, *, popen=subprocess.Popen):
    """Spawn after durable intent; never guess whether a lost spawn occurred."""
    argv = [sys.executable, str(worker_script), '--db', str(q.database), '--directory', job['directory'],
            '--provider', job['provider'], '--model', job['model'], '--expected-model-id', str(job['model_id']),
            '--expected-generation', str(job['generation'])]
    child = None
    try:
        env = queue.runtime_environment(q)
    except (queue.QueueError, OSError):
        with q.transaction() as db:
            db.execute("UPDATE directory_dispatches SET status='blocked',reason='RUNTIME_PREFLIGHT_FAILED' WHERE id=? AND status='starting'", (job['id'],))
        raise
    try:
        child = popen(argv, cwd=q.meta('snapshot'), env=env, stdin=subprocess.DEVNULL,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        worker = queue.process_identity(child.pid)
        queue.require(worker['pid'] == worker['pgid'] == worker['session'], 'worker session identity mismatch')
        with q.transaction() as db:
            updated = db.execute("UPDATE directory_dispatches SET status='running',worker=? WHERE id=? AND status='starting'",
                                 (json.dumps(worker), job['id'])).rowcount
            queue.require(updated == 1, 'dispatch ownership changed')
        return child
    except BaseException:
        # Even failed spawn may have started work if the receipt was lost.
        with q.transaction() as db:
            db.execute("UPDATE directory_dispatches SET status='uncertain',reason='SPAWN_UNCONFIRMED' WHERE id=? AND status='starting'", (job['id'],))
        raise



def release_evidence(q, db, job, worker):
    """Prove a model retired before this exact worker could reserve a file."""
    try:
        if queue.alive(worker) is not False or not queue.group_gone(worker):
            return None
        if table_exists(db, 'directory_runs') and db.execute(
                'SELECT 1 FROM directory_runs WHERE directory=? LIMIT 1', (job['directory'],)).fetchone():
            return None
        latest = db.execute('SELECT id,generation,state FROM models WHERE provider=? AND model=? ORDER BY generation DESC LIMIT 1',
                            (job['provider'], job['model'])).fetchone()
        if latest is not None and latest['id'] == job['model_id'] and latest['generation'] == job['generation'] and latest['state'] == 'active':
            return None
        scope = queue.decode(job['scope_json'])
        queue.require(isinstance(scope, dict) and scope.get('directory') == job['directory'], 'dispatch scope identity mismatch')
        rows = scope_is_current(q, db, scope)
        return {'worker': worker, 'dispatcher': queue.decode(job['controller']),
                'workerExited': True, 'workerGroupGone': True, 'directoryRunCount': 0,
                'files': [{'path': row['path'], 'sha256': row['sha256'], 'state': row['state']} for row in rows],
                'attemptCount': 0, 'latestModel': dict(latest) if latest is not None else None,
                'checkedNs': time.time_ns()}
    except (queue.QueueError, OSError, ValueError, TypeError, KeyError, AttributeError):
        return None


def reconcile(q, children):
    """Settle only terminals bound to the exact original worker identity."""
    if not table_exists(q.connection, 'directory_dispatches'):
        return False
    active = q.connection.execute("SELECT 1 FROM directory_dispatches WHERE status IN ('starting','running','uncertain') LIMIT 1").fetchone()
    if active is None:
        return False
    changed = False
    with q.transaction() as db:
        rows = db.execute("SELECT * FROM directory_dispatches WHERE status IN ('starting','running','uncertain') ORDER BY created_ns").fetchall()
        for job in rows:
            child = children.get(job['id'])
            observed_exit = child is not None
            if child is not None:
                code = child.poll()
                if code is None:
                    continue
                child.wait()
                del children[job['id']]
            else:
                code = job['exit_code']
            if job['worker'] is None:
                if job['status'] != 'uncertain':
                    db.execute("UPDATE directory_dispatches SET status='uncertain',reason='SPAWN_RECEIPT_MISSING' WHERE id=?", (job['id'],))
                    changed = True
                continue
            try:
                worker = queue.decode(job['worker'])
                living = queue.alive(worker) if child is None else False
            except (queue.QueueError, ValueError, TypeError, AttributeError, KeyError):
                living = None
            if living is True:
                continue
            if living is None:
                if job['status'] != 'uncertain':
                    db.execute("UPDATE directory_dispatches SET status='uncertain',reason='WORKER_IDENTITY_UNKNOWN' WHERE id=?", (job['id'],))
                    changed = True
                continue
            terminal = None
            active_run = False
            ambiguous = False
            if table_exists(db, 'directory_runs'):
                runs = db.execute('SELECT * FROM directory_runs WHERE directory=? AND model_id=?',
                                  (job['directory'], job['model_id'])).fetchall()
                matching = []
                for run in runs:
                    try:
                        if queue.same_process(queue.decode(run['owner']), worker):
                            matching.append(run)
                    except (queue.QueueError, ValueError, TypeError, AttributeError):
                        ambiguous = True
                if len(matching) == 1:
                    terminal = matching[0]['phase'] if matching[0]['phase'] in TERMINAL_RUN else None
                    active_run = matching[0]['phase'] in ('reserved', 'running', 'uncertain')
                elif len(matching) > 1 or runs:
                    ambiguous = True
            evidence = None if terminal is not None or active_run or ambiguous else release_evidence(q, db, job, worker)
            if terminal is not None and not ambiguous:
                status, reason = terminal, None
            elif evidence is not None:
                status, reason = 'released_no_reservation', 'MODEL_CHANGED_WITHOUT_RESERVATION'
            elif active_run or ambiguous or not observed_exit:
                status, reason = 'uncertain', 'DIRECTORY_TERMINAL_UNCONFIRMED'
            else:
                # No safe release proof: never automatically retry this directory.
                status, reason = 'blocked', 'PREFLIGHT_OR_DIRECTORY_UNCONFIRMED'
            if job['status'] != status or job['reason'] != reason or job['exit_code'] != code:
                db.execute('UPDATE directory_dispatches SET status=?,exit_code=?,reason=?,evidence_json=? WHERE id=?',
                           (status, code, reason, json.dumps(evidence) if evidence is not None else None, job['id']))
                changed = True
    return changed


def supervise(q, scopes, plan_sha, worker_script, *, poll_seconds=.2):
    children = {}
    last_version = None
    while True:
        settled = reconcile(q, children)
        version = q.connection.execute('PRAGMA data_version').fetchone()[0]
        if settled or version != last_version:
            while True:
                job = claim(q, scopes, plan_sha)
                if job is None:
                    break
                try:
                    children[job['id']] = launch(q, job, worker_script)
                except (queue.QueueError, OSError):
                    pass
            # Preserve the version observed before admission; an external
            # model update during admission must trigger the next iteration.
            last_version = version
        # Active children refill promptly. Idle polling reads no files or rows;
        # a different SQLite connection advances data_version on model updates.
        time.sleep(poll_seconds if children else max(poll_seconds, 1))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--plan', type=Path, required=True)
    args = parser.parse_args()
    q = queue.Queue(args.db)
    fd = None
    try:
        queue.runtime_environment(q)
        scopes, plan_sha = plan_document(q, args.plan)
        fd = os.open(q.database.parent / 'directory-dispatch.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        queue.require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
                      and not info.st_mode & 0o077, 'unsafe directory dispatch lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        supervise(q, scopes, plan_sha, Path(__file__).resolve().with_name('ocr_directory_scan.py'))
    finally:
        if fd is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        q.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('OCR directory dispatcher stopped; preserve and reconcile existing reservations.', file=sys.stderr)
        raise SystemExit(1)
