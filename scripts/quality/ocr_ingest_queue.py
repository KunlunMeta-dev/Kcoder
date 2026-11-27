#!/usr/bin/env python3
"""Ingest validated OCR queue receipts into the central opinion ledger."""
from __future__ import annotations

import argparse
import collections
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

import ocr_global_queue as queue_module


class IngestError(RuntimeError):
    pass


def key(item):
    return (item['path'], item.get('start_line', 0), item.get('end_line', 0),
            item.get('category', ''), item.get('severity', ''), item['content'])


def merge_receipts(ledger, receipts, session_bytes):
    """Return a new ledger; malformed or ambiguous receipts never mutate the input."""
    result = copy.deepcopy(ledger)
    known = {key(item): item for item in result['findings']}
    ids = {item['id']: key(item) for item in result['findings']}
    paths = {}
    for item in result['findings']:
        owner = item.get('manualReviewOwner')
        if owner in ('user', 'held_same_file'):
            paths[item.get('path', '')] = 'user'
        elif owner == 'assistant' and item.get('path', '') not in paths:
            paths[item.get('path', '')] = 'assistant'
    new_count = high_count = 0
    for receipt in receipts:
        attempt = receipt['attempt']
        raw = session_bytes[attempt]
        if hashlib.sha256(raw).hexdigest() != receipt['session_sha256']:
            raise IngestError('validated session digest changed')
        records = [json.loads(line) for line in raw.splitlines()]
        if not records or any(row.get('sessionId') != receipt['session_uuid'] for row in records):
            raise IngestError('session identity mismatch')
        checkpoints = [row for row in records if row.get('type') in
                       ('review_item_done', 'review_item_reused', 'review_item_failed')
                       and row.get('filePath') == receipt['path']]
        if not checkpoints or checkpoints[-1]['type'] not in ('review_item_done', 'review_item_reused'):
            raise IngestError('original checkpoint is not successful')
        comments = checkpoints[-1].get('comments', [])
        if not isinstance(comments, list):
            raise IngestError('invalid comments')
        for comment in comments:
            if not isinstance(comment, dict):
                raise IngestError('invalid comment')
            path = comment.get('path') or receipt['path']
            content = comment.get('content')
            start, end = comment.get('start_line', 0), comment.get('end_line', 0)
            category, severity = comment.get('category', ''), comment.get('severity', '')
            if (path != receipt['path'] or not isinstance(content, str) or not content
                    or len(content) > 200000 or type(start) is not int or type(end) is not int
                    or start < 0 or end < 0 or (start > 0 and end > 0 and end < start)
                    or not isinstance(category, str) or not isinstance(severity, str)):
                raise IngestError('comment is malformed or targets another file')
            item = {'path': path, 'start_line': start, 'end_line': end,
                    'category': category, 'severity': severity, 'content': content}
            identity = key(item)
            if identity in known:
                existing = known[identity]
                if receipt['session_uuid'] not in existing['sessions']:
                    existing['sessions'].append(receipt['session_uuid'])
                continue
            ident = hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()[:16]
            if ident in ids and ids[ident] != identity:
                raise IngestError('opinion ID collision')
            high = severity.lower() in ('high', 'critical')
            unclassified = severity.lower() not in ('high', 'critical', 'medium', 'low')
            current_owner = paths.get(path)
            if unclassified:
                owner = 'held_same_file'
                paths.setdefault(path, 'user')
            elif current_owner == 'user':
                owner = 'held_same_file'
            elif high:
                owner = 'assistant'
                paths[path] = 'assistant'
            elif result.get('reviewPolicy', {}).get('mode') == 'high_only':
                owner = 'deferred_low_risk'
            else:
                owner = 'assistant'
                paths.setdefault(path, 'assistant')
            item.update(id=ident, sessions=[receipt['session_uuid']], decision='pending', evidence=[],
                        manualReviewOwner=owner, sourceAttempt=attempt, sourceModel=receipt['model'],
                        sourceSessionSha256=receipt['session_sha256'],
                        sourceFileSha256=receipt.get('source_sha256'))
            for field in ('existing_code', 'suggestion_code'):
                value = comment.get(field)
                if value is not None:
                    if not isinstance(value, str) or len(value) > 200000:
                        raise IngestError('invalid comment code')
                    item[field] = value
            if high:
                item['requiresHighRiskReview'] = True
                if owner == 'held_same_file':
                    item['requiresUserHighRiskReview'] = True
                high_count += 1
            if unclassified:
                item['requiresSeverityReview'] = True
            result['findings'].append(item)
            known[identity] = item
            ids[ident] = identity
            new_count += 1
    result['reviewSummary'] = dict(collections.Counter(item.get('decision', 'pending')
                                                       for item in result['findings']))
    return result, new_count, high_count


def ingest_once(database: Path, ledger_path: Path):
    q = queue_module.Queue(database)
    lock_path = ledger_path.parent / 'review-handoff' / 'ledger-assignment.lock'
    try:
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    except BaseException:
        q.close()
        raise
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    try:
        raw = queue_module.read_regular(ledger_path, private=True)
        baseline = hashlib.sha256(raw).hexdigest()
        ledger = json.loads(raw)
        db_info = database.stat()
        binding = {'database': str(database.absolute()), 'device': db_info.st_dev, 'inode': db_info.st_ino,
                   'scannerSha256': q.meta('scannerSha256'), 'snapshot': q.meta('snapshot')}
        previous = ledger.get('queueIngestion')
        if previous is not None and previous.get('binding') != binding:
            raise IngestError('ledger belongs to a different queue')
        cursor = 0 if previous is None else previous['cursor']
        consumed = {} if previous is None else dict(previous.get('receipts', {}))
        receipts = q.receipts(after=cursor, limit=100)
        if not receipts:
            return {'receipts': 0, 'newOpinions': 0, 'newHighRisk': 0, 'cursor': cursor}
        payloads = {}
        for receipt in receipts:
            prior = consumed.get(receipt['attempt'])
            if prior is not None:
                raise IngestError('attempt appeared again after its committed cursor')
            q.verify_receipt(receipt['attempt'])
            payloads[receipt['attempt']] = queue_module.read_regular(receipt['session_file'], private=True)
            consumed[receipt['attempt']] = {'sequence': receipt['sequence'], 'path': receipt['path'],
                                            'sessionSha256': receipt['session_sha256'],
                                            'sourceSha256': receipt['source_sha256'],
                                            'model': receipt['model']}
        updated, count, high = merge_receipts(ledger, receipts, payloads)
        updated['queueIngestion'] = {'binding': binding, 'cursor': receipts[-1]['sequence'],
                                     'receipts': consumed, 'updatedUnix': int(time.time())}
        if hashlib.sha256(queue_module.read_regular(ledger_path, private=True)).hexdigest() != baseline:
            raise IngestError('ledger changed during ingestion')
        fd, temporary = tempfile.mkstemp(prefix='.ocr-ingest-', dir=ledger_path.parent)
        os.fchmod(fd, 0o600)
        try:
            with os.fdopen(fd, 'w', encoding='utf8') as stream:
                json.dump(updated, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, ledger_path)
            directory_fd = os.open(ledger_path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {'receipts': len(receipts), 'newOpinions': count, 'newHighRisk': high,
                'cursor': receipts[-1]['sequence']}
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
        q.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    while True:
        result = ingest_once(args.db, args.ledger)
        if result['receipts'] or args.once:
            print(json.dumps(result), flush=True)
        if args.once:
            return
        time.sleep(5)


if __name__ == '__main__':
    main()
