#!/usr/bin/env python3
"""Run one native OCR directory session and publish independently checked file receipts."""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

import ocr_global_queue as queue


RUN_TABLE = '''CREATE TABLE IF NOT EXISTS directory_runs(
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, model_id INTEGER NOT NULL,
    phase TEXT NOT NULL, created_ns INTEGER NOT NULL, owner TEXT NOT NULL,
    scanner_process TEXT, metadata TEXT NOT NULL, reason TEXT)'''


def preview(q, directory):
    argv = [q.meta('scanner'), 'scan', '--repo', q.meta('snapshot'), '--path', directory,
            '--preview', '--format', 'json']
    result = subprocess.run(argv, cwd=q.meta('snapshot'), env=queue.runtime_environment(q, scanner=True),
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=60, check=True)
    queue.require(len(result.stdout) <= queue.MAX_OUTPUT_BYTES, 'preview too large')
    data = queue.decode(result.stdout)
    queue.require(isinstance(data, dict) and isinstance(data.get('files'), list), 'invalid preview')
    files = [queue.relative_path(item['path']) for item in data['files'] if item.get('will_review') is True]
    queue.require(files and len(set(files)) == len(files) and data.get('reviewable_count') == len(files),
                  'invalid reviewable preview')
    queue.require(all(path.startswith(directory + '/') for path in files), 'preview outside directory')
    return files, hashlib.sha256(result.stdout).hexdigest()


def reserve(q, directory, provider, model, paths, preview_sha, *, expected_model_id=None, expected_generation=None):
    directory = queue.relative_path(directory)
    queue.require(isinstance(paths, list) and len(paths) == len(set(paths)) and paths,
                  'empty or duplicate directory preview')
    queue.require(all(queue.relative_path(p).startswith(directory + '/') for p in paths), 'scope mismatch')
    queue.require((expected_model_id is None and expected_generation is None) or
                  (type(expected_model_id) is int and expected_model_id > 0 and
                   type(expected_generation) is int and expected_generation > 0), 'invalid expected model identity')
    run_id = str(uuid.uuid4())
    with q.transaction() as db:
        q.require_host()
        queue.runtime_environment(q)
        queue.require(q.meta('paused') is True, 'single-file queue must remain paused')
        queue.require(not db.execute('SELECT 1 FROM attempts WHERE slot_active=1 LIMIT 1').fetchone(),
                      'prior queue attempts are still active')
        db.execute(RUN_TABLE)
        # One live directory session owns a model's entire concurrency budget.
        # Different services may scan disjoint directories concurrently; the
        # file-state checks below fence overlapping or already attempted paths.
        queue.require(not db.execute("""SELECT 1 FROM directory_runs r JOIN models m ON m.id=r.model_id
                      WHERE r.phase IN ('reserved','running','uncertain') AND m.provider=? AND m.model=? LIMIT 1""",
                      (provider, model)).fetchone(), 'model already owns an unresolved directory session')
        member = db.execute('SELECT * FROM models WHERE provider=? AND model=? ORDER BY generation DESC LIMIT 1',
                            (provider, model)).fetchone()
        queue.require(member is not None and member['state'] == 'active' and member['concurrency'] > 0,
                      'model needs an active generation')
        queue.require(expected_model_id is None or
                      (member['id'] == expected_model_id and member['generation'] == expected_generation),
                      'model generation changed before reservation')
        is_canary = not member['canary']
        queue.require(not is_canary or len(paths) == 1, 'unverified generation requires a one-file directory canary')
        prefix = directory + '/'
        rows = db.execute('SELECT * FROM files WHERE substr(path,1,?)=? ORDER BY path',
                          (len(prefix), prefix)).fetchall()
        queue.require({r['path'] for r in rows} == set(paths), 'preview and prepared directory differ')
        for row in rows:
            queue.require(row['state'] == 'pending', 'directory includes already attempted files')
            queue.require(db.execute('SELECT 1 FROM eligible WHERE model_id=? AND path=?',
                                     (member['id'], row['path'])).fetchone(), 'model not eligible for directory')
            queue.verify_inputs(q, row)
        metadata = {'previewSha256': preview_sha, 'paths': sorted(paths), 'provider': provider, 'model': model,
                    'concurrency': 1 if is_canary else member['concurrency'], 'canary': is_canary,
                    'definition': queue.decode(member['definition']),
                    'baseline': sorted(path.name for path in Path(q.meta('sessionRoot')).glob('*.jsonl'))}
        db.execute('INSERT INTO directory_runs(id,directory,model_id,phase,created_ns,owner,metadata) VALUES(?,?,?,\'reserved\',?,?,?)',
                   (run_id, directory, member['id'], time.time_ns(), json.dumps(queue.process_identity()), json.dumps(metadata)))
        for row in rows:
            db.execute("UPDATE files SET state='held',reason=? WHERE path=? AND state='pending'",
                       ('DIRECTORY_RESERVED:' + run_id, row['path']))
    return run_id


def scanner_argv(q, run):
    meta = queue.decode(run['metadata'])
    return [q.meta('scanner'), 'scan', '--repo', q.meta('snapshot'), '--path', run['directory'],
            '--concurrency', str(meta['concurrency']), '--batch', 'continuous', '--no-dedup', '--no-plan',
            '--no-summary', '--provider', meta['provider'], '--model', meta['model'], '--max-tokens',
            str(meta['definition']['maxTokens']), '--format', 'json', '--audience', 'human']


def verified_session(q, run, result, diagnostics, code, end_ns):
    meta = queue.decode(run['metadata'])
    queue.require(code == 0 and result.get('valid') is True and result.get('status') in ('success', 'completed_with_warnings')
                  and result.get('serviceMatched') is True and result.get('filesReviewed') == len(meta['paths'])
                  and result.get('warningsCount') == 0 and result.get('toolFailures') == 0
                  and result.get('budgetExceeded') is False and result.get('fresh') is True,
                  'directory result unconfirmed')
    queue.require(not diagnostics['fatal'] and not diagnostics['overflow'] and not diagnostics['streamError'],
                  'directory diagnostics unconfirmed')
    session = result['session_id']
    path = Path(q.meta('sessionRoot')) / (session + '.jsonl')
    queue.require(path.name not in meta['baseline'], 'session predates directory run')
    identity = queue.scanner_identity(path)
    raw = queue.read_regular(path, private=True)
    queue.require(identity == queue.scanner_identity(path) and raw.endswith(b'\n'), 'session changed or incomplete')
    records = [queue.decode(line) for line in raw.splitlines()]
    queue.require(records and all(isinstance(r, dict) and r.get('sessionId') == session for r in records),
                  'invalid session records')
    start = records[0]
    timestamp = datetime.fromisoformat(start['timestamp'].replace('Z', '+00:00'))
    queue.require(timestamp.tzinfo is not None and run['created_ns'] // 1_000_000_000 <= timestamp.timestamp() <= end_ns // 1_000_000_000,
                  'session outside original run')
    queue.require(start.get('type') == 'session_start' and start.get('scanPaths') == [run['directory']]
                  and start.get('cwd') == q.meta('snapshot') and start.get('model') == meta['model']
                  and start.get('reviewMode') == 'full_scan', 'directory session identity mismatch')
    llm_errors = [r for r in records if r.get('type') == 'llm_error']
    queue.require(records[-1].get('type') == 'session_end' and type(records[-1].get('llm_failures')) is int
                  and records[-1]['llm_failures'] == len(llm_errors)
                  and not any(r.get('type') in ('warning', 'review_limit') for r in records)
                  and all(r.get('filePath') in meta['paths'] for r in llm_errors),
                  'directory session has unscoped or inconsistent errors')
    failed_paths = {r['filePath'] for r in llm_errors}
    checkpoints = {}
    for row in records:
        if row.get('type') in ('review_item_done', 'review_item_failed', 'review_item_reused'):
            path_name = row.get('filePath')
            queue.require(path_name in meta['paths'] and path_name not in checkpoints, 'unexpected or duplicate checkpoint')
            checkpoints[path_name] = row
    queue.require(set(checkpoints) == set(meta['paths']), 'directory checkpoints incomplete')
    comments = []
    for name, checkpoint in checkpoints.items():
        file = q.connection.execute('SELECT * FROM files WHERE path=?', (name,)).fetchone()
        queue.require(file is not None and file['state'] == 'held' and file['reason'] == 'DIRECTORY_RESERVED:' + run['id'],
                      'directory reservation changed')
        queue.verify_inputs(q, file)
        queue.require(checkpoint['type'] == 'review_item_done' and checkpoint.get('fingerprint') == file['fingerprint']
                      and checkpoint.get('model') == meta['model'] and checkpoint.get('oldPath') == name
                      and checkpoint.get('newPath') == name, 'directory checkpoint identity mismatch')
        value = checkpoint.get('comments', [])
        queue.require(isinstance(value, list) and all(isinstance(c, dict) and c.get('path', name) == name for c in value),
                      'cross-file or invalid checkpoint comments')
        comments.extend(value)
    queue.require(len(comments) == result['commentsCount'] and queue.comments_identity(comments) == result['commentsSha256'],
                  'directory results and checkpoints differ')
    return str(path), session, hashlib.sha256(raw).hexdigest(), identity, failed_paths


def publish_receipts(q, run):
    run_id = run['id']
    meta = queue.decode(run['metadata'])
    queue.require(run['phase'] in ('running', 'held') and run['scanner_process'] is not None,
                  'directory has no reconcilable process receipt')
    queue.require(all(k in meta for k in ('result', 'diagnostics', 'exitCode', 'finishedNs',
                                          'scannerSha256', 'scannerIdentity')),
                  'original directory exit receipt unavailable')
    queue.require(meta['scannerSha256'] == q.meta('scannerSha256') and
                  meta['scannerIdentity'] == q.meta('scannerIdentity') and
                  queue.scanner_identity(q.meta('scanner')) == meta['scannerIdentity'] and
                  hashlib.sha256(queue.read_regular(q.meta('scanner'))).hexdigest() == meta['scannerSha256'],
                  'original scanner provenance changed')
    session_path, session, digest, identity, failed_paths = verified_session(q, run, meta['result'], meta['diagnostics'], meta['exitCode'], meta['finishedNs'])
    with q.transaction() as db:
        queue.require(q.meta('paused') is True, 'single-file queue admission changed')
        queue.require(queue.scanner_identity(session_path) == identity and
                      hashlib.sha256(queue.read_regular(session_path, private=True)).hexdigest() == digest,
                      'directory session changed before publication')
        metadata = dict(meta, sessionSha256=digest, failedPaths=sorted(failed_paths))
        changed = db.execute('UPDATE directory_runs SET metadata=? WHERE id=? AND phase=?', (json.dumps(metadata), run_id, run['phase'])).rowcount
        queue.require(changed == 1, 'directory run changed during reconciliation')
        for name in meta['paths']:
            file = db.execute('SELECT * FROM files WHERE path=?', (name,)).fetchone()
            queue.require(file['state'] == 'held' and file['reason'] == 'DIRECTORY_RESERVED:' + run_id,
                          'directory reservation changed')
            queue.verify_inputs(q, file)
            if name in failed_paths:
                db.execute("UPDATE files SET reason='DIRECTORY_FILE_LLM_ERROR' WHERE path=?", (name,))
                continue
            ident, token = str(uuid.uuid4()), str(uuid.uuid4())
            db.execute('''INSERT INTO attempts(id,token,path,model_id,status,slot_active,controller,process,scanner_process,
                       claimed_ns,dispatch_ns,exit_ns,exit_code,baseline,session_file,session_uuid,session_sha256,session_identity)
                       VALUES(?,?,?,?,\'completed\',0,?,?,?,?,?,?,?,?,?,?,?,?)''',
                       (ident, token, name, run['model_id'], run['owner'], run['owner'], run['scanner_process'],
                        run['created_ns'], run['created_ns'], meta['finishedNs'], meta['exitCode'], json.dumps(meta['baseline']),
                        session_path, session, digest, json.dumps(identity)))
            db.execute("UPDATE files SET state='completed',attempt=?,reason=NULL WHERE path=?", (ident, name))
            db.execute('INSERT INTO completions(attempt) VALUES(?)', (ident,))
        phase = 'partially_completed' if failed_paths else 'completed'
        db.execute("UPDATE directory_runs SET phase=?,reason=NULL WHERE id=? AND phase=?", (phase, run_id, run['phase']))
        if failed_paths:
            db.execute("UPDATE models SET state='quarantined' WHERE id=? AND state='active'", (run['model_id'],))
        elif meta.get('canary') is True:
            # A passing original canary belongs only to this exact generation;
            # a concurrently removed or quarantined generation is not revived.
            db.execute("UPDATE models SET canary=1 WHERE id=? AND state='active'", (run['model_id'],))
    return {'directory': run['directory'], 'run': run_id, 'completed': len(meta['paths']) - len(failed_paths), 'held': len(failed_paths)}



def recover_directory(q, run_id):
    q.require_host()
    queue.runtime_environment(q)
    run = q.connection.execute('SELECT * FROM directory_runs WHERE id=?', (run_id,)).fetchone()
    queue.require(run is not None and run['phase'] in ('held', 'running'), 'reconcilable directory run not found')
    queue.require(queue.alive(queue.decode(run['owner'])) is False, 'original controller is not confirmed dead')
    queue.require(run['scanner_process'] is not None and queue.group_gone(queue.decode(run['scanner_process'])),
                  'original scanner group is not confirmed gone')
    return publish_receipts(q, run)


def run_directory(q, directory, provider, model, *, expected_model_id=None, expected_generation=None):
    directory = queue.relative_path(directory)
    queue.require(queue.scanner_identity(q.meta('scanner')) == q.meta('scannerIdentity')
                  and hashlib.sha256(queue.read_regular(q.meta('scanner'))).hexdigest() == q.meta('scannerSha256'),
                  'scanner changed')
    queue.runtime_environment(q)
    files, preview_sha = preview(q, directory)
    run_id = reserve(q, directory, provider, model, files, preview_sha,
                     expected_model_id=expected_model_id, expected_generation=expected_generation)
    run = q.connection.execute('SELECT * FROM directory_runs WHERE id=?', (run_id,)).fetchone()
    child = None
    scanner_identity = None
    scanner_sha = q.meta('scannerSha256')
    scanner_image = q.meta('scannerIdentity')
    try:
        queue.require(queue.scanner_identity(q.meta('scanner')) == scanner_image and
                      hashlib.sha256(queue.read_regular(q.meta('scanner'))).hexdigest() == scanner_sha,
                      'scanner changed')
        # Serialize the final admission with model drain/removal and capacity
        # changes. Once spawned, the already owned scanner is allowed to finish.
        with q.transaction() as db:
            current = db.execute('SELECT * FROM models WHERE id=?', (run['model_id'],)).fetchone()
            latest = db.execute('SELECT max(generation) FROM models WHERE provider=? AND model=?',
                                (provider, model)).fetchone()[0]
            meta = queue.decode(run['metadata'])
            queue.require(q.meta('paused') is True and current is not None and current['state'] == 'active'
                          and current['generation'] == latest and current['concurrency'] >= meta['concurrency']
                          and (current['canary'] == 1 or meta['canary'] is True and meta['concurrency'] == 1),
                          'model admission changed before dispatch')
            child = subprocess.Popen(scanner_argv(q, run), cwd=q.meta('snapshot'), stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                     env=queue.runtime_environment(q, scanner=True))
            scanner_identity = queue.process_identity(child.pid)
            db.execute("UPDATE directory_runs SET phase='running',scanner_process=? WHERE id=? AND phase='reserved'",
                       (json.dumps(scanner_identity), run_id))
        output, diagnostics = queue.collect_output(child)
        code = child.wait()
        queue.require(queue.group_gone(scanner_identity), 'scanner process group still active')
        meta = queue.decode(run['metadata'])
        result = queue.project_result(output, {'provider': provider, 'model': model})
        end_ns = time.time_ns()
        # Persist the finite original-process result before validation. A failed
        # validator must not erase the only exit and diagnostic evidence.
        metadata = dict(meta, result=result, diagnostics=diagnostics, exitCode=code, finishedNs=end_ns,
                        scannerSha256=scanner_sha, scannerIdentity=scanner_image)
        with q.transaction() as db:
            changed = db.execute("UPDATE directory_runs SET metadata=? WHERE id=? AND phase='running'",
                                 (json.dumps(metadata), run_id)).rowcount
            queue.require(changed == 1, 'directory owner changed before exit receipt')
        run = q.connection.execute('SELECT * FROM directory_runs WHERE id=?', (run_id,)).fetchone()
        return publish_receipts(q, run)
    except BaseException:
        phase = 'uncertain' if child is not None and (child.poll() is None or scanner_identity is None or not queue.group_gone(scanner_identity)) else 'held'
        with q.transaction() as db:
            db.execute("UPDATE directory_runs SET phase=?,reason='DIRECTORY_RESULT_UNCONFIRMED' WHERE id=? AND phase IN ('reserved','running')", (phase, run_id))
            if child is not None:
                db.execute("UPDATE models SET state='quarantined' WHERE id=? AND state='active'", (run['model_id'],))
        raise


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', required=True)
    p.add_argument('--directory')
    p.add_argument('--provider')
    p.add_argument('--model')
    p.add_argument('--recover')
    p.add_argument('--expected-model-id', type=int)
    p.add_argument('--expected-generation', type=int)
    args = p.parse_args()
    q = queue.Queue(args.db)
    try:
        if args.recover:
            queue.require(not any((args.directory, args.provider, args.model, args.expected_model_id, args.expected_generation)), 'recovery cannot start a scan')
            print(json.dumps(recover_directory(q, args.recover)))
        else:
            queue.require(all((args.directory, args.provider, args.model)), 'directory, provider and model required')
            print(json.dumps(run_directory(q, args.directory, args.provider, args.model,
                                           expected_model_id=args.expected_model_id, expected_generation=args.expected_generation)))
    finally:
        q.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('OCR directory session unconfirmed; reserved files remain held', file=__import__('sys').stderr)
        raise SystemExit(1)
