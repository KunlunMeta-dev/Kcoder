#!/usr/bin/env python3
"""Switch a drained OCR queue to a verified scanner without losing receipt provenance."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import sys
import time
import uuid

import ocr_global_queue as ocr


class SwitchError(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise SwitchError(message)


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.ocr-switch-', dir=path.parent)
    os.fchmod(fd, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verified_scanner(path, expected):
    require(ocr.re_sha(expected), 'invalid expected scanner digest')
    path = Path(path).absolute()
    before = ocr.scanner_identity(path)
    raw = ocr.read_regular(path)
    require(hashlib.sha256(raw).hexdigest() == expected and before == ocr.scanner_identity(path)
            and os.access(path, os.X_OK), 'scanner image identity mismatch')
    return {'path': str(path), 'sha256': expected, 'identity': before}


def switch(database, ledger_path, owners_path, scanner_path, expected_sha):
    database, ledger_path, owners_path = map(lambda x: Path(x).absolute(), (database, ledger_path, owners_path))
    queue = ocr.Queue(database)
    lock_path = ledger_path.parent / 'review-handoff' / 'ledger-assignment.lock'
    try:
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    except BaseException:
        queue.close()
        raise
    journal = database.parent / 'scanner-switch.pending.json'
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        queue.require_host()
        candidate = verified_scanner(scanner_path, expected_sha)
        ledger = ocr.decode(ocr.read_regular(ledger_path, private=True))
        owners = ocr.decode(ocr.read_regular(owners_path, private=True))
        binding = ledger.get('queueIngestion', {}).get('binding')
        require(isinstance(binding, dict), 'ledger has no queue binding')
        db_info = database.stat()
        require(binding.get('database') == str(database) and binding.get('device') == db_info.st_dev
                and binding.get('inode') == db_info.st_ino and binding.get('snapshot') == queue.meta('snapshot'),
                'ledger is bound to another queue')
        with queue.transaction() as db:
            require(queue.meta('paused') is True, 'queue must be paused')
            require(db.execute('SELECT count(*) FROM attempts WHERE slot_active=1').fetchone()[0] == 0
                    and db.execute("SELECT count(*) FROM files WHERE state='claimed'").fetchone()[0] == 0,
                    'owned scan attempts have not drained')
            cursor = db.execute('SELECT coalesce(max(sequence),0) FROM completions').fetchone()[0]
            require(ledger['queueIngestion'].get('cursor') == cursor, 'ingestion cursor is not caught up')
            current = {'path': queue.meta('scanner'), 'sha256': queue.meta('scannerSha256'),
                       'identity': queue.meta('scannerIdentity')}
            attempts = db.execute('SELECT count(*) FROM attempts').fetchone()[0]
            latest_claim = db.execute('SELECT coalesce(max(claimed_ns),0) FROM attempts').fetchone()[0]
        if journal.exists():
            record = ocr.decode(ocr.read_regular(journal, private=True))
            require(record.get('schemaVersion') == 1 and record.get('new') == candidate
                    and record.get('cursor') == cursor and record.get('attempts') == attempts
                    and record.get('latestClaimNs') == latest_claim, 'pending scanner transition does not match current state')
        else:
            require(current['sha256'] != candidate['sha256'], 'scanner image is already selected')
            require(current == verified_scanner(current['path'], current['sha256']), 'old scanner identity changed')
            require(binding.get('scannerSha256') == current['sha256']
                    and owners.get('scannerSha256') == current['sha256'], 'old scanner bindings disagree')
            record = {'schemaVersion': 1, 'id': str(uuid.uuid4()), 'old': current, 'new': candidate,
                      'cursor': cursor, 'attempts': attempts, 'latestClaimNs': latest_claim,
                      'createdUnix': int(time.time())}
            fd = os.open(journal, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w', encoding='utf8') as stream:
                json.dump(record, stream, ensure_ascii=False, indent=2)
                stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
            directory = os.open(journal.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        require(current in (record['old'], record['new']), 'queue scanner changed during transition')
        require(binding.get('scannerSha256') in (record['old']['sha256'], record['new']['sha256'])
                and owners.get('scannerSha256') in (record['old']['sha256'], record['new']['sha256']),
                'scanner transition bindings changed')
        if current == record['old']:
            require(binding['scannerSha256'] == record['old']['sha256']
                    and owners['scannerSha256'] == record['old']['sha256'], 'scanner transition state is inconsistent')
            with queue.transaction() as db:
                require(queue.meta('paused') is True and queue.meta('scannerSha256') == record['old']['sha256']
                        and db.execute('SELECT count(*) FROM attempts WHERE slot_active=1').fetchone()[0] == 0,
                        'queue changed during scanner transition')
                for key, value in [('scanner', candidate['path']), ('scannerSha256', candidate['sha256']),
                                   ('scannerIdentity', candidate['identity'])]:
                    db.execute('UPDATE meta SET value=? WHERE key=?', (json.dumps(value), key))
                prior = db.execute("SELECT value FROM meta WHERE key='scannerHistory'").fetchone()
                history = [] if prior is None else ocr.decode(prior[0])
                require(isinstance(history, list) and all(x.get('id') != record['id'] for x in history), 'scanner history mismatch')
                history.append(record)
                db.execute("INSERT INTO meta(key,value) VALUES('scannerHistory',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(history),))
        if binding['scannerSha256'] == record['old']['sha256']:
            ledger['queueIngestion']['binding']['scannerSha256'] = candidate['sha256']
            history = ledger.setdefault('scannerTransitions', [])
            require(isinstance(history, list) and all(x.get('id') != record['id'] for x in history), 'ledger scanner history mismatch')
            history.append(record)
            atomic_json(ledger_path, ledger)
        else:
            require(any(x.get('id') == record['id'] for x in ledger.get('scannerTransitions', [])), 'ledger lacks scanner transition evidence')
        if owners['scannerSha256'] == record['old']['sha256']:
            owners['scannerSha256'] = candidate['sha256']
            history = owners.setdefault('scannerTransitions', [])
            require(isinstance(history, list) and all(x.get('id') != record['id'] for x in history), 'owner scanner history mismatch')
            history.append(record)
            atomic_json(owners_path, owners)
        else:
            require(any(x.get('id') == record['id'] for x in owners.get('scannerTransitions', [])), 'owners lack scanner transition evidence')
        finished = journal.with_name('scanner-switch-' + record['id'] + '.json')
        require(not finished.exists(), 'scanner transition receipt already exists')
        os.rename(journal, finished)
        directory = os.open(journal.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return {'scannerSha256': candidate['sha256'], 'previousScannerSha256': record['old']['sha256'],
                'cursor': cursor, 'existingAttempts': attempts, 'paused': True}
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
        queue.close()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--owners', type=Path, required=True)
    parser.add_argument('--scanner', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    print(json.dumps(switch(args.db, args.ledger, args.owners, args.scanner, args.sha256)))


if __name__ == '__main__':
    try:
        main()
    except (SwitchError, ocr.QueueError, OSError, ValueError, KeyError, TypeError):
        print('OCR scanner transition unconfirmed; check the queue pause state and private transition journal.', file=sys.stderr)
        raise SystemExit(1)
