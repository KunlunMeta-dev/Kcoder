#!/usr/bin/env python3
"""Recover a quarantined OCR model only after later verified in-flight results."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

import ocr_global_queue as ocr


class RecoveryWatch:
    def __init__(self, queue):
        self.queue = queue
        self.observed = {}

    def poll(self):
        recovered = []
        with self.queue.transaction() as db:
            self.queue.require_host()
            if self.queue.meta('paused'):
                self.observed.clear()
                return recovered
            latest = db.execute('SELECT coalesce(max(sequence),0) FROM completions').fetchone()[0]
            models = db.execute('SELECT id,provider,model,state,canary FROM models').fetchall()
            for model in models:
                ident = model['id']
                if model['state'] != 'quarantined' or model['canary'] != 1:
                    self.observed.pop(ident, None)
                    continue
                failures = frozenset(row[0] for row in db.execute(
                    "SELECT id FROM attempts WHERE model_id=? AND status='held'", (ident,)))
                if not failures:
                    self.observed.pop(ident, None)
                    continue
                observation = self.observed.get(ident)
                if observation is None or observation[0] != failures:
                    self.observed[ident] = (failures, latest)
                    continue
                unknown = db.execute("SELECT 1 FROM attempts WHERE model_id=? AND status='held' AND slot_active=1 LIMIT 1", (ident,)).fetchone()
                if unknown:
                    continue
                rows = db.execute('''SELECT c.sequence,a.id FROM completions c JOIN attempts a ON a.id=c.attempt
                    WHERE a.model_id=? AND a.status='completed' AND c.sequence>? ORDER BY c.sequence''',
                                  (ident, observation[1])).fetchall()
                if len(rows) < 2:
                    continue
                # The completion cursor is monotonic; wall-clock changes cannot
                # make an old success appear to follow a newly observed failure.
                safe = rows[-2:]
                for row in safe:
                    self.queue.verify_receipt(row['id'])
                db.execute("UPDATE models SET state='active' WHERE id=? AND state='quarantined' AND canary=1", (ident,))
                if db.execute('SELECT changes()').fetchone()[0] == 1:
                    recovered.append({'model': model['model'], 'provider': model['provider'],
                                      'evidenceSequences': [safe[-2]['sequence'], safe[-1]['sequence']]})
                    self.observed.pop(ident, None)
        return recovered


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    q = ocr.Queue(args.db)
    try:
        watch = RecoveryWatch(q)
        while True:
            result = watch.poll()
            for item in result:
                print(json.dumps(item, ensure_ascii=False), flush=True)
            if args.once:
                return
            time.sleep(1)
    finally:
        q.close()


if __name__ == '__main__':
    main()
