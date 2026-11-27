#!/usr/bin/env python3
"""Single-host OCR admission and receipt reconciliation. No implicit model calls."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import sqlite3
import stat
import subprocess
import sys
import time
import uuid


class QueueError(RuntimeError):
    pass


QUEUE_SCHEMA = 3
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
DIAGNOSTIC_PATTERN = re.compile(rb"panic:|fatal error:|comment[^\n]*(?:failed|error|panic)|pool[^\n]*(?:error|panic)", re.I)


def require(condition, message):
    if not condition:
        raise QueueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def decode(value):
    return json.loads(value, object_pairs_hook=unique_object)


def relative_path(value):
    require(isinstance(value, str) and bool(value) and "\\" not in value
            and ":" not in value and not any(ord(c) < 32 for c in value), "unsafe relative path")
    require(not PurePosixPath(value).is_absolute()
            and all(part not in ("", ".", "..") for part in value.split("/")), "unsafe relative path")
    return value


def private_directory(path, create=False):
    path = Path(path).absolute()
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), "unsafe directory")
    info = path.stat()
    require(info.st_uid == os.getuid() and not info.st_mode & 0o077, "directory must be private and owned")
    return path


def read_regular(path, maximum=128 * 1024 * 1024, private=False):
    before = Path(path).lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum, "unsafe file")
    if private:
        require(before.st_uid == os.getuid() and not before.st_mode & 0o077, "file must be private and owned")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        held = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)
        require(stat.S_ISREG(held.st_mode) and identity(before) == identity(held), "file changed")
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, held.st_size - size + 1))
            if not chunk:
                break
            size += len(chunk)
            require(size <= held.st_size, "file grew during read")
            chunks.append(chunk)
        require(size == held.st_size and identity(held) == identity(os.fstat(fd))
                == identity(Path(path).lstat()), "file changed")
        return b"".join(chunks)
    finally:
        os.close(fd)


def source_identity(root, path):
    full = Path(root) / relative_path(path)
    for parent in full.parents:
        if parent == Path(root):
            break
        require(not parent.is_symlink(), "source ancestor symlink")
    data = read_regular(full)
    return hashlib.sha256(data).hexdigest(), hashlib.sha256(b"full_scan\0" + path.encode() + b"\0" + data).hexdigest()


def scanner_identity(path):
    info = Path(path).lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "unsafe scanner image")
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def default_session_root(home, snapshot):
    encoded = str(snapshot).lstrip('/\\').replace('/', '-').replace('\\', '-')
    return Path(home) / '.opencodereview' / 'sessions' / encoded


def runtime_environment(queue, *, scanner=False):
    require(not any(key.upper().startswith('GIT_') for key in os.environ), 'ambient Git environment is not allowed')
    home = str(Path.home().resolve(strict=True))
    require(home == queue.meta('scannerHome'), 'scanner HOME changed; preserve original profile')
    root = private_directory(queue.meta('sessionRoot'))
    require(root == default_session_root(home, queue.meta('snapshot')), 'OCR session root does not match native HOME contract')
    snapshot = Path(queue.meta('snapshot'))
    info = snapshot.lstat()
    require(stat.S_ISDIR(info.st_mode) and [info.st_dev, info.st_ino] == queue.meta('snapshotDirectory'), 'snapshot directory changed')
    environment = dict(os.environ)
    if scanner:
        environment.update({'GIT_CEILING_DIRECTORIES': str(snapshot.parent), 'GIT_TERMINAL_PROMPT': '0',
                            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull})
    # This environment contract is not a context-tool sandbox. The scanner's
    # independently verified file/tool/secret boundary is still required.
    return environment


def verify_inputs(queue, row):
    require(source_identity(queue.meta('snapshot'), row['path']) == (row['sha256'], row['fingerprint']), 'view input changed')
    origin = Path(queue.meta('originCheckout'))
    info = origin.lstat()
    require(stat.S_ISDIR(info.st_mode) and [info.st_dev, info.st_ino] == queue.meta('originDirectory'), 'origin checkout changed')
    require(source_identity(origin, row['path'])[0] == row['sha256'], 'origin input changed')


def host_identity():
    # Linux procfs is required. A different boot/PID namespace is never death proof.
    return {"boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "namespace": os.stat("/proc/self/ns/pid").st_ino}


def process_identity(pid=None):
    pid = os.getpid() if pid is None else pid
    raw = Path(f"/proc/{pid}/stat").read_text()
    fields = raw[raw.rfind(")") + 2:].split()
    return {**host_identity(), "pid": pid, "ticks": int(fields[19]), "pgid": int(fields[2]),
            "session": int(fields[3]), "state": fields[0]}


def alive(owner):
    if not owner or any(owner.get(k) != v for k, v in host_identity().items()):
        return None
    try:
        now = process_identity(owner["pid"])
    except (FileNotFoundError, ProcessLookupError):
        return False
    except (PermissionError, OSError):
        return None
    return now["ticks"] == owner["ticks"] and now["state"] != "Z"


def group_gone(owner):
    if not owner or any(owner.get(k) != v for k, v in host_identity().items()):
        return False
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            current = process_identity(int(entry.name))
            if current["pgid"] == owner["pgid"] and current["state"] != "Z":
                return False
        except (FileNotFoundError, ProcessLookupError):
            pass
        except (PermissionError, OSError):
            return False
    return True


SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE models(id INTEGER PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
 generation INTEGER NOT NULL, state TEXT NOT NULL, concurrency INTEGER NOT NULL,
 canary INTEGER NOT NULL DEFAULT 0, definition TEXT NOT NULL,
 UNIQUE(provider,model,generation));
CREATE TABLE files(path TEXT PRIMARY KEY, state TEXT NOT NULL, sha256 TEXT, fingerprint TEXT,
 attempt TEXT UNIQUE, reason TEXT);
CREATE TABLE eligible(model_id INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY(model_id,path));
CREATE TABLE attempts(id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
 model_id INTEGER NOT NULL, status TEXT NOT NULL, slot_active INTEGER NOT NULL,
 controller TEXT NOT NULL, process TEXT, scanner_process TEXT, exit_receipt TEXT,
 claimed_ns INTEGER NOT NULL, dispatch_ns INTEGER,
 exit_ns INTEGER, exit_code INTEGER, baseline TEXT, session_file TEXT,
 session_uuid TEXT, session_sha256 TEXT, session_identity TEXT, reason TEXT);
CREATE UNIQUE INDEX unique_file_attempt ON attempts(path);
CREATE TABLE completions(sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt TEXT NOT NULL UNIQUE);
"""


def model_definition(definition):
    require(isinstance(definition, dict), 'model definition must be an object')
    provider, model = definition.get("provider"), definition.get("model")
    require(isinstance(provider, str) and provider and isinstance(model, str) and model, "provider/model required")
    limit = definition.get("configuredConcurrency")
    require(type(limit) is int and 0 <= limit <= 256, "invalid concurrency")
    require(type(definition.get("maxTokens")) is int and 0 < definition["maxTokens"] <= 1000000,
            "validated per-model maxTokens required")
    require(not any(key.lower() in ("key", "apikey", "api_key", "token", "password", "credentials")
                    for key in definition), "credentials do not belong in model definitions")
    paths = definition.get("eligiblePendingPaths", [])
    require(isinstance(paths, list) and all(isinstance(p, str) for p in paths)
            and len(set(paths)) == len(paths), "invalid eligibility")
    require(not paths or re_sha(definition.get("eligibilityPreviewSha256")), "validated eligibility preview digest required")
    for path in paths:
        relative_path(path)
    safe = {key: definition[key] for key in ("provider", "model", "configuredConcurrency", "maxTokens",
            "eligibilityPreviewSha256", "capabilitiesValidated") if key in definition}
    require('capabilitiesValidated' not in safe or type(safe['capabilitiesValidated']) is bool, 'invalid capability metadata')
    return provider, model, limit, paths, safe


def admission_capacity(db):
    """Keep each active service's capacity while prior owned slots drain."""
    active = {(row['provider'], row['model']): row['concurrency'] for row in db.execute(
        "SELECT * FROM models m WHERE state='active' AND generation=(SELECT max(generation) FROM models WHERE provider=m.provider AND model=m.model)")}
    occupied = {(row['provider'], row['model']): row['count'] for row in db.execute(
        "SELECT m.provider,m.model,count(*) AS count FROM attempts a JOIN models m ON m.id=a.model_id WHERE a.slot_active=1 GROUP BY m.provider,m.model")}
    return sum(max(limit, occupied.pop(key, 0)) for key, limit in active.items()) + sum(occupied.values())


def directory_run_in_progress(db):
    exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='directory_runs'").fetchone()
    return bool(exists and db.execute(
        "SELECT 1 FROM directory_runs WHERE phase IN ('reserved','running','uncertain') LIMIT 1").fetchone())


class Queue:
    def __init__(self, database, *, _creating=False):
        self.database = Path(database).absolute()
        private_directory(self.database.parent)
        info = self.database.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
                and not info.st_mode & 0o077, "unsafe queue database")
        self.connection = sqlite3.connect(self.database, isolation_level=None, timeout=30)
        self.transaction_poisoned = False
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA busy_timeout=30000")
        if not _creating:
            try:
                require(self.meta('schema') == QUEUE_SCHEMA, 'unsupported queue schema; preserve existing state')
            except BaseException:
                self.close()
                raise

    def close(self):
        self.connection.close()

    @contextmanager
    def transaction(self):
        require(not self.transaction_poisoned, 'queue transaction state unconfirmed; reopen and reconcile')
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield self.connection
            self.connection.execute("COMMIT")
        except BaseException as original:
            try:
                self.connection.execute("ROLLBACK")
            except BaseException as cleanup:
                self.transaction_poisoned = True
                original.cleanup_error = cleanup
            raise

    def meta(self, key):
        row = self.connection.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        require(row is not None, "missing queue metadata")
        return decode(row[0])

    @classmethod
    def create(cls, state_dir, plan, scanner, session_root, max_tokens=58888):
        require(plan.get("schemaVersion") == 2 and plan.get("permanentFileAssignments") is False
                and plan.get("status", "").startswith("prepared_dynamic_shared_pool"), "dynamic prepared plan required")
        require(not plan.get("activeClaims"), "active prior claims require explicit owner import; do not discard them")
        require(not any(key.upper().startswith('GIT_') for key in os.environ), 'ambient Git environment is not allowed')
        root = Path(plan["snapshot"]).resolve(strict=True)
        root_stat = root.stat()
        safety = plan.get('safety', {})
        require(isinstance(safety, dict), 'invalid safety metadata')
        origin_name = plan.get('originCheckout', safety.get('sourceCheckout'))
        require(isinstance(origin_name, str), 'originCheckout or safety.sourceCheckout binding required')
        origin = Path(origin_name).resolve(strict=True)
        if 'originCheckout' in plan and 'sourceCheckout' in safety:
            require(origin == Path(safety['sourceCheckout']).resolve(strict=True), 'conflicting origin checkout bindings')
        origin_stat = origin.stat()
        home = str(Path.home().resolve(strict=True))
        scanner = Path(scanner).resolve(strict=True)
        scanner_sha = hashlib.sha256(read_regular(scanner)).hexdigest()
        scanner_stat = scanner_identity(scanner)
        if 'scannerSha256' in safety:
            require(re_sha(safety['scannerSha256']) and scanner_sha == safety['scannerSha256'], 'scanner does not match approved plan image')
        session_root = private_directory(session_root)
        require(session_root == default_session_root(home, root), 'OCR session root does not match native HOME contract')
        paths = [(path, state) for field, state in [("pendingPaths", "pending"), ("completedExcluded", "completed"),
                 ("heldPriorAttemptPaths", "held")] for path in plan[field]]
        require(len({path for path, _ in paths}) == len(paths), "overlapping plan paths")
        require('scopeFiles' not in plan or type(plan['scopeFiles']) is int and plan['scopeFiles'] == len(paths), 'scope count mismatch')
        require('priorOwnersReconciled' not in plan or type(plan['priorOwnersReconciled']) is bool, 'invalid prior owner evidence')
        scope = {relative_path(path) for path, _ in paths}
        definitions = [model_definition(model) for model in plan["members"]]
        require(len({(m[0], m[1]) for m in definitions}) == len(definitions), "duplicate model service")
        require(all(set(model[3]) <= scope for model in definitions), "eligibility outside prepared scope")
        images = [(path, state, *(source_identity(root, path) if state == "pending" else (None, None))) for path, state in paths]
        directory = private_directory(state_dir, create=True)
        database = directory / "queue.sqlite"
        fd = os.open(database, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        queue = cls(database, _creating=True)
        try:
            queue.connection.executescript(SCHEMA)
            queue.connection.execute("PRAGMA journal_mode=WAL")
            with queue.transaction() as db:
                metadata = {"schema": QUEUE_SCHEMA, "paused": True, "snapshot": str(root),
                            "snapshotDirectory": [root_stat.st_dev, root_stat.st_ino], 'host': host_identity(),
                            'originCheckout': str(origin), 'originDirectory': [origin_stat.st_dev, origin_stat.st_ino],
                            'scannerHome': home,
                            "snapshotIdentity": plan.get("sourceCommit"), "scanner": str(scanner),
                            "scannerSha256": scanner_sha, "scannerIdentity": scanner_stat,
                            "sessionRoot": str(session_root), "maxTokens": max_tokens,
                            "planSha256": hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest(),
                            "priorOwnersReconciled": bool(plan.get("priorOwnersReconciled", not plan["heldPriorAttemptPaths"]))}
                for key, value in metadata.items():
                    db.execute("INSERT INTO meta VALUES(?,?)", (key, json.dumps(value)))
                for path, state, sha, fingerprint in images:
                    db.execute("INSERT INTO files(path,state,sha256,fingerprint) VALUES(?,?,?,?)", (path, state, sha, fingerprint))
                for model in plan['members']:
                    queue._insert_model(db, model)
        except BaseException as original:
            try:
                queue.close()
            except BaseException as cleanup:
                original.cleanup_error = cleanup
            raise
        return queue

    def add_model(self, definition):
        with self.transaction() as db:
            ident = self._insert_model(db, definition)
        return ident

    def _insert_model(self, db, definition):
        provider, model, limit, paths, safe = model_definition(definition)
        previous = db.execute('SELECT * FROM models WHERE provider=? AND model=? ORDER BY generation DESC LIMIT 1', (provider, model)).fetchone()
        require(previous is None or previous['state'] == 'removed', 'model already registered; adjust or drain it')
        generation = 1 if previous is None else previous['generation'] + 1
        ident = db.execute("INSERT INTO models(provider,model,generation,state,concurrency,definition) VALUES(?,?,?,'active',?,?)", (provider, model, generation, limit, json.dumps(safe))).lastrowid
        for path in paths:
            require(db.execute('SELECT 1 FROM files WHERE path=?', (path,)).fetchone(), 'eligibility outside prepared scope')
            db.execute('INSERT INTO eligible VALUES(?,?)', (ident, path))
        return ident

    def require_host(self):
        require(self.meta('host') == host_identity(), 'queue belongs to another boot or PID namespace')

    def model_change(self, provider, model, state=None, concurrency=None):
        require(state in (None, "active", "draining", "removed"), "invalid model state")
        require(concurrency is None or type(concurrency) is int and 0 <= concurrency <= 256, "invalid concurrency")
        with self.transaction() as db:
            row = db.execute("SELECT * FROM models WHERE provider=? AND model=? ORDER BY generation DESC LIMIT 1", (provider, model)).fetchone()
            require(row is not None and row["state"] != "removed", "model not active in registry")
            db.execute("UPDATE models SET state=?,concurrency=? WHERE id=?", (state or row["state"],
                       row["concurrency"] if concurrency is None else concurrency, row["id"]))

    def pause(self, paused=True):
        with self.transaction() as db:
            if not paused:
                require(not directory_run_in_progress(db), 'directory session unresolved; remain paused')
                self.require_host()
                runtime_environment(self)
                require(self.meta("priorOwnersReconciled") is True, "prior owners not reconciled; remain paused")
            db.execute("UPDATE meta SET value=? WHERE key='paused'", (json.dumps(paused),))

    def directory(self):
        row = self.connection.execute("SELECT value FROM meta WHERE key='activeDirectory'").fetchone()
        return decode(row[0]) if row else None

    def directory_counts(self, directory):
        prefix = directory + '/'
        return dict(self.connection.execute(
            'SELECT state,count(*) FROM files WHERE substr(path,1,?)=? GROUP BY state',
            (len(prefix), prefix)))

    def select_directory(self, directory):
        directory = relative_path(directory)
        with self.transaction() as db:
            self.require_host()
            require(self.meta('paused') is True, 'pause queue before changing directory')
            require(not db.execute('SELECT 1 FROM attempts WHERE slot_active=1 LIMIT 1').fetchone(),
                    'drain active attempts before changing directory')
            require(not db.execute("SELECT 1 FROM files WHERE state='claimed' LIMIT 1").fetchone(),
                    'reconcile claimed files before changing directory')
            for root in (self.meta('snapshot'), self.meta('originCheckout')):
                current = Path(root)
                for part in directory.split('/'):
                    current = current / part
                    info = current.lstat()
                    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
                            'directory contains a symlink or is not a directory')
            counts = self.directory_counts(directory)
            require(counts.get('pending', 0) > 0, 'directory has no pending files')
            previous = self.directory()
            history_row = db.execute("SELECT value FROM meta WHERE key='directoryHistory'").fetchone()
            history = decode(history_row[0]) if history_row else []
            if previous is not None:
                history.append({'directory': previous, 'counts': self.directory_counts(previous),
                                'closedNs': time.time_ns()})
            for key, value in [('activeDirectory', directory), ('directoryHistory', history)]:
                db.execute('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                           (key, json.dumps(value)))
            return counts

    def status(self):
        directory = self.directory()
        return {'directory': directory, 'directoryFiles': self.directory_counts(directory) if directory else None,'contextSafety': 'external_gate_required', "paused": self.meta("paused"), "files": dict(self.connection.execute("SELECT state,count(*) FROM files GROUP BY state")),
                "activeSlots": self.connection.execute("SELECT count(*) FROM attempts WHERE slot_active=1").fetchone()[0],
                "models": [dict(row) for row in self.connection.execute("SELECT id,provider,model,generation,state,concurrency,canary FROM models")],
                "heldAttempts": [dict(row) for row in self.connection.execute("SELECT id,path,status,slot_active,reason FROM attempts WHERE status='held'")]}

    def claim(self):
        with self.transaction() as db:
            self.require_host()
            if self.meta("paused") or directory_run_in_progress(db):
                return None
            models = db.execute("SELECT * FROM models m WHERE state='active' AND generation=(SELECT max(generation) FROM models WHERE provider=m.provider AND model=m.model) ORDER BY id").fetchall()
            cap = admission_capacity(db)
            if db.execute("SELECT count(*) FROM attempts WHERE slot_active=1").fetchone()[0] >= cap:
                return None
            directory = self.directory()
            prefix = directory + '/' if directory else None
            path_sql = ("SELECT f.path FROM files f JOIN eligible e ON e.path=f.path "
                        "WHERE f.state='pending' AND e.model_id=?" +
                        (" AND substr(f.path,1,?)=?" if prefix else "") + " ORDER BY f.path LIMIT 1")
            for model in models:
                active = db.execute("SELECT count(*) FROM attempts a JOIN models m ON m.id=a.model_id WHERE a.slot_active=1 AND m.provider=? AND m.model=?", (model["provider"], model["model"])).fetchone()[0]
                if active >= min(model["concurrency"], model["concurrency"] if model["canary"] else 1):
                    continue
                path = db.execute(path_sql, (model["id"], len(prefix), prefix) if prefix else (model["id"],)).fetchone()
                while path is not None:
                    image = db.execute('SELECT * FROM files WHERE path=?', (path[0],)).fetchone()
                    try:
                        verify_inputs(self, image)
                        break
                    except (OSError, QueueError):
                        db.execute("UPDATE files SET state='held',reason='INPUT_CHANGED_BEFORE_CLAIM' WHERE path=? AND state='pending'", (path[0],))
                        path = db.execute(path_sql, (model["id"], len(prefix), prefix) if prefix else (model["id"],)).fetchone()
                if path is None:
                    continue
                ident, token = str(uuid.uuid4()), str(uuid.uuid4())
                db.execute("INSERT INTO attempts(id,token,path,model_id,status,slot_active,controller,claimed_ns) VALUES(?,?,?,?,'claimed',1,?,?)", (ident, token, path[0], model["id"], json.dumps(process_identity()), time.time_ns()))
                db.execute("UPDATE files SET state='claimed',attempt=? WHERE path=? AND state='pending'", (ident, path[0]))
                return self.attempt(ident, token)
        return None

    def attempt(self, ident, token):
        row = self.connection.execute("SELECT a.*,m.provider,m.model,m.generation,m.definition,f.sha256,f.fingerprint FROM attempts a JOIN models m ON m.id=a.model_id JOIN files f ON f.path=a.path AND f.attempt=a.id WHERE a.id=? AND a.token=?", (ident, token)).fetchone()
        require(row is not None, "stale attempt token")
        return dict(row)

    def dispatch_gate(self, ident, token):
        # Called only by the already spawned owned session leader, before exec.
        with self.transaction() as db:
            self.require_host()
            runtime_environment(self)
            row = self.attempt(ident, token)
            require(row["status"] == "claimed", "attempt already dispatched or held")
            model = db.execute("SELECT * FROM models WHERE id=?", (row["model_id"],)).fetchone()
            latest = db.execute("SELECT max(generation) FROM models WHERE provider=? AND model=?", (row["provider"], row["model"])).fetchone()[0]
            require(not self.meta("paused") and not directory_run_in_progress(db) and model["state"] == "active" and latest == row["generation"], "dispatch admission changed")
            directory = self.directory()
            require(directory is None or row['path'].startswith(directory + '/'), 'directory admission changed')
            require(scanner_identity(self.meta("scanner")) == self.meta("scannerIdentity"), "scanner image changed")
            # Reservations are not executing requests. A reduced limit fences
            # unadmitted claims, while already admitted processes keep running.
            cap = admission_capacity(db)
            admitted = db.execute("SELECT count(*) FROM attempts WHERE slot_active=1 AND status!='claimed'").fetchone()[0]
            service = db.execute("SELECT count(*) FROM attempts a JOIN models m ON m.id=a.model_id WHERE slot_active=1 AND a.status!='claimed' AND m.provider=? AND m.model=?", (row["provider"], row["model"])).fetchone()[0]
            limit = model["concurrency"] if model["canary"] else min(1, model["concurrency"])
            require(admitted < cap and service < limit, "dispatch capacity changed")
            verify_inputs(self, row)
            identity = process_identity()
            require(identity["pgid"] == identity["pid"] == identity["session"], "launcher must own its process session")
            baseline = sorted(path.name for path in Path(self.meta("sessionRoot")).glob("*.jsonl"))
            db.execute("UPDATE attempts SET status='running',process=?,dispatch_ns=?,baseline=? WHERE id=? AND token=?", (json.dumps(identity), time.time_ns(), json.dumps(baseline), ident, token))
            return self.attempt(ident, token)

    def hold(self, ident, token, reason, release=False, quarantine=True):
        with self.transaction() as db:
            row = self.attempt(ident, token)
            require(row["status"] != "completed", "completed attempt immutable")
            db.execute("UPDATE attempts SET status='held',reason=?,slot_active=? WHERE id=? AND token=?", (reason, 0 if release else row["slot_active"], ident, token))
            db.execute("UPDATE files SET state='held',reason=? WHERE path=? AND attempt=?", (reason, row["path"], ident))
            if quarantine:
                db.execute("UPDATE models SET state='quarantined' WHERE id=? AND state='active'", (row["model_id"],))

    def finish(self, ident, token, exit_code=None):
        self.require_host()
        row = self.attempt(ident, token)
        if row["status"] == "completed":
            return True
        owner = decode(row["process"]) if row["process"] else None
        living = alive(owner)
        if living is True:
            return False
        if living is not False or not group_gone(owner):
            self.hold(ident, token, "PROCESS_LIVENESS_UNCONFIRMED")
            return False
        ended = time.time_ns()
        receipt = find_receipt(self, row, ended)
        with self.transaction() as db:
            current = self.attempt(ident, token)
            if current['status'] == 'completed':
                return True
            success = receipt is not None
            db.execute("UPDATE attempts SET status=?,slot_active=0,exit_ns=?,session_file=?,session_uuid=?,session_sha256=?,session_identity=?,reason=? WHERE id=? AND token=?", ("completed" if success else "held", ended, receipt["file"] if success else None,
                receipt['session_uuid'] if success else None, receipt['session_sha256'] if success else None,
                json.dumps(receipt['session_identity']) if success else None, None if success else "CHECKPOINT_UNCONFIRMED", ident, token))
            db.execute("UPDATE files SET state=?,reason=? WHERE path=? AND attempt=?", ("completed" if success else "held", None if success else "CHECKPOINT_UNCONFIRMED", row["path"], ident))
            if success:
                db.execute('INSERT INTO completions(attempt) VALUES(?)', (ident,))
            if success and receipt["type"] == "review_item_done":
                db.execute("UPDATE models SET canary=1 WHERE id=?", (row["model_id"],))
            elif not success:
                db.execute("UPDATE models SET state='quarantined' WHERE id=? AND state='active'", (row["model_id"],))
            else:
                db.execute("UPDATE models SET state='quarantined' WHERE id=? AND canary=0 AND state='active'", (row["model_id"],))
        return success

    def receipts(self, after=0, limit=100):
        require(type(after) is int and after >= 0 and type(limit) is int and 1 <= limit <= 1000, 'invalid receipt cursor')
        return [dict(row) for row in self.connection.execute('''SELECT c.sequence,a.id AS attempt,
            a.status,a.path,a.session_file,a.session_uuid,a.session_sha256,f.sha256 AS source_sha256,
            m.provider,m.model,m.generation FROM completions c JOIN attempts a ON a.id=c.attempt
            JOIN files f ON f.path=a.path JOIN models m ON m.id=a.model_id
            WHERE c.sequence>? ORDER BY c.sequence LIMIT ?''', (after,limit))]

    def verify_receipt(self, ident):
        row = self.connection.execute("SELECT * FROM attempts WHERE id=? AND status='completed'", (ident,)).fetchone()
        require(row is not None, 'completed receipt not found')
        path = Path(row['session_file'])
        require(path.parent == Path(self.meta('sessionRoot')) and path.name == row['session_uuid'] + '.jsonl', 'session receipt scope changed')
        identity = scanner_identity(path)
        data = read_regular(path, private=True)
        require(identity == scanner_identity(path) == decode(row['session_identity'])
                and hashlib.sha256(data).hexdigest() == row['session_sha256'], 'verified session changed; hold ingestion')
        return {'attempt': ident, 'session_uuid': row['session_uuid'], 'session_sha256': row['session_sha256'], 'verified': True}

    def abort_before_exec(self, ident, token):
        with self.transaction() as db:
            row = self.attempt(ident, token)
            require(row["status"] == "claimed" and row["process"] is None, "cannot revoke an already admitted worker")
            db.execute("UPDATE attempts SET status='held',slot_active=0,process=?,exit_ns=?,reason='DISPATCH_REJECTED_BEFORE_EXEC' WHERE id=? AND token=?",
                       (json.dumps(process_identity()), time.time_ns(), ident, token))
            db.execute("UPDATE files SET state='held',reason='DISPATCH_REJECTED_BEFORE_EXEC' WHERE path=? AND attempt=?", (row["path"], ident))

    def reconcile(self):
        self.require_host()
        for raw in self.connection.execute("SELECT id,token,process,controller FROM attempts WHERE slot_active=1").fetchall():
            # The original live parent owns wait()/exit status. Another observer
            # must not race it and infer success from a just-exited zombie.
            if alive(decode(raw["controller"])) is True:
                continue
            if raw["process"]:
                if alive(decode(raw["process"])) is False:
                    self.finish(raw["id"], raw["token"])
            elif alive(decode(raw["controller"])) is not True:
                self.hold(raw["id"], raw["token"], "LAUNCH_OWNERSHIP_UNCONFIRMED")
        return self.status()

    def record_scanner(self, ident, token, process):
        with self.transaction() as db:
            row = self.attempt(ident, token)
            require(same_process(decode(row['process']), process_identity()), 'collector ownership changed')
            require(process['pgid'] == os.getpgrp() and process['session'] == os.getsid(0), 'scanner escaped owned session')
            db.execute('UPDATE attempts SET scanner_process=? WHERE id=? AND token=?', (json.dumps(process), ident, token))

    def record_exit(self, ident, token, code, result_hash, diagnostic_hash):
        with self.transaction() as db:
            row = self.attempt(ident, token)
            require(same_process(decode(row['process']), process_identity()), 'collector ownership changed')
            require(row['scanner_process'] is not None and row['exit_receipt'] is None, 'exit receipt already settled or scanner unknown')
            value = {'version': 1, 'attempt': ident, 'tokenSha256': hashlib.sha256(token.encode()).hexdigest(),
                     'process': decode(row['process']), 'scanner': decode(row['scanner_process']),
                     'code': code, 'resultSha256': result_hash, 'diagnosticSha256': diagnostic_hash}
            db.execute('UPDATE attempts SET exit_code=?,exit_receipt=? WHERE id=? AND token=?', (code, json.dumps(value), ident, token))


def re_sha(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def same_process(left, right):
    return all(left.get(key) == right.get(key) for key in ('boot', 'namespace', 'pid', 'ticks', 'pgid', 'session'))


def write_artifact(path, value):
    payload = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        offset = 0
        while offset < len(payload):
            written = os.write(fd, payload[offset:])
            require(written > 0, 'artifact write made no progress')
            offset += written
        os.fsync(fd)
    finally:
        os.close(fd)
    return hashlib.sha256(payload).hexdigest()


def comments_identity(comments):
    require(isinstance(comments, list) and all(isinstance(comment, dict) for comment in comments), 'invalid checkpoint comments')
    # The current no-dedup single-file producer uses LlmComment on both outlets.
    # Normalize object keys and array order, retaining every field and duplicate.
    items = sorted(json.dumps(comment, sort_keys=True, separators=(',', ':'),
                              ensure_ascii=False, allow_nan=False).encode() for comment in comments)
    digest = hashlib.sha256(b'ocr-comments-v1\0')
    for item in items:
        digest.update(len(item).to_bytes(8, 'big'));digest.update(item)
    return digest.hexdigest()


def project_result(raw, row):
    # Persist only finite receipt metadata. Finding text, messages, URLs,
    # tool details and arbitrary warnings never enter coordinator artifacts.
    invalid = {'schemaVersion': 1, 'valid': False, 'reason': 'RESULT_UNCONFIRMED'}
    try:
        result = decode(raw)
        require(isinstance(result, dict), 'invalid result')
        require(all(isinstance(result.get(key), dict) for key in ('llm', 'summary', 'tool_calls')), 'invalid result objects')
        require(result.get('status') in ('success', 'completed_with_warnings', 'completed_with_errors', 'skipped'), 'unsupported result status')
        session = result.get('session_id')
        require(isinstance(session, str) and str(uuid.UUID(session)) == session
                and uuid.UUID(session).version == 4, 'invalid original session identity')
        require(result.get('manifest') is None, 'scan manifest contract changed')
        summary, calls = result['summary'], result['tool_calls']
        counts = [summary.get('files_reviewed'), summary.get('comments'), calls.get('failure')]
        require(all(type(value) is int and 0 <= value <= 9007199254740991 for value in counts), 'invalid result counters')
        require(isinstance(result.get('comments'), list)
                and all(isinstance(comment, dict) for comment in result['comments'])
                and counts[1] == len(result['comments']), 'invalid comments')
        warnings = result.get('warnings', [])
        budget = summary.get('budget_exceeded', False)
        require(isinstance(warnings, list) and type(budget) is bool, 'invalid warning/budget metadata')
        return {'schemaVersion': 1, 'valid': True, 'session_id': session,
                'status': result['status'], 'serviceMatched': result['llm'].get('provider') == row['provider']
                and result['llm'].get('model') == row['model'], 'filesReviewed': counts[0],
                'commentsCount': counts[1], 'toolFailures': counts[2], 'warningsCount': len(warnings),
                'commentsSha256': comments_identity(result['comments']),
                'budgetExceeded': budget, 'fresh': result.get('resume') is None}
    except (ValueError, TypeError, AttributeError, KeyError, QueueError):
        return invalid


def collect_output(child):
    # Raw bytes stay in bounded memory; overflow is drained and becomes unknown.
    diagnostics = {'schemaVersion': 1, 'fatal': False, 'overflow': False,
                   'streamError': False, 'stdoutBytes': 0, 'stderrBytes': 0}
    output, tail = bytearray(), b''
    with selectors.DefaultSelector() as selector:
        for pipe, name in ((child.stdout, 'stdout'), (child.stderr, 'stderr')):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, name)
        while selector.get_map():
            for key, _ in selector.select(timeout=0.2):
                try:
                    chunk = os.read(key.fileobj.fileno(), 65536)
                except BlockingIOError:
                    continue
                except OSError:
                    diagnostics['streamError'] = True
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                name = key.data
                diagnostics[name + 'Bytes'] += len(chunk)
                if name == 'stdout':
                    remaining = MAX_OUTPUT_BYTES - len(output)
                    output.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        diagnostics['overflow'] = True
                else:
                    scan = tail + chunk
                    diagnostics['fatal'] |= bool(DIAGNOSTIC_PATTERN.search(scan))
                    tail = scan[-8192:]
    return bytes(output), diagnostics


def execute_attempt(queue, ident, token):
    try:
        row = queue.dispatch_gate(ident, token)
    except BaseException:
        queue.abort_before_exec(ident, token)
        raise
    child = None
    try:
        child = subprocess.Popen(scanner_argv(queue, row), cwd=queue.meta('snapshot'),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=runtime_environment(queue, scanner=True))
        queue.record_scanner(ident, token, process_identity(child.pid))
        output, diagnostics = collect_output(child)
        code = child.wait()
        result = project_result(output, row)
        if diagnostics['overflow'] or diagnostics['streamError']:
            result = {'schemaVersion': 1, 'valid': False, 'reason': 'OUTPUT_UNCONFIRMED'}
        directory = private_directory(queue.database.parent / ident)
        result_hash = write_artifact(directory / 'stdout.log', result)
        diagnostic_hash = write_artifact(directory / 'stderr.log', diagnostics)
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        queue.record_exit(ident, token, code, result_hash, diagnostic_hash)
        return code if 0 <= code <= 125 else 1
    except BaseException:
        # Do not kill or replay a scanner whose execution/exit is not confirmed.
        # Its recorded original process group continues to consume its slot.
        try:
            queue.hold(ident, token, 'COLLECTOR_UNCONFIRMED')
        except Exception:
            pass
        raise
    finally:
        if child is not None:
            # Closing pipes after an exceptional collector exit does not
            # constitute a process termination receipt.
            for pipe in (child.stdout, child.stderr):
                if pipe is not None:
                    pipe.close()


def session_receipt(queue, row, session, end_ns, projection):
    path = Path(queue.meta('sessionRoot')) / (session + '.jsonl')
    require(path.name not in decode(row['baseline']), 'session predates original attempt')
    identity = scanner_identity(path)
    data = read_regular(path, private=True)
    require(identity == scanner_identity(path), 'session image changed')
    require(data.endswith(b'\n'), 'partial session tail')
    records = [decode(line) for line in data.splitlines()]
    require(records and all(isinstance(record, dict) for record in records), 'invalid session records')
    start = records[0]
    require(start.get('type') == 'session_start', 'missing session start')
    timestamp = datetime.fromisoformat(start['timestamp'].replace('Z', '+00:00'))
    require(timestamp.tzinfo is not None and row['dispatch_ns'] // 1_000_000_000
            <= timestamp.timestamp() <= end_ns // 1_000_000_000, 'session outside attempt window')
    require(start.get('scanPaths') == [row['path']] and start.get('model') == row['model']
            and start.get('cwd') == queue.meta('snapshot') and start.get('reviewMode') == 'full_scan'
            and start.get('sessionId') == session, 'session scope mismatch')
    require(all(record.get('sessionId') == session for record in records), 'mixed session records')
    checkpoints = [record for record in records if record.get('type') in
                   ('review_item_done', 'review_item_reused', 'review_item_failed')
                   and record.get('filePath') == row['path']]
    require(checkpoints and checkpoints[-1].get('type') != 'review_item_failed', 'no successful terminal checkpoint')
    done = checkpoints[-1]
    require(done.get('fingerprint') == row['fingerprint'] and done.get('model') == row['model']
            and done.get('oldPath') == done.get('newPath') == row['path'], 'checkpoint identity mismatch')
    comments = done.get('comments', [])
    require(isinstance(comments, list) and len(comments) == projection['commentsCount']
            and comments_identity(comments) == projection['commentsSha256'], 'result/checkpoint comments differ')
    require(records[-1].get('type') == 'session_end' and type(records[-1].get('llm_failures')) is int
            and records[-1]['llm_failures'] == 0, 'session not cleanly finalized')
    require(not any(record.get('type') in ('warning', 'llm_error', 'review_limit') for record in records),
            'uncertain session diagnostics')
    return {'file': str(path), 'type': done['type'], 'session_uuid': session,
            'session_sha256': hashlib.sha256(data).hexdigest(), 'session_identity': identity}


def find_receipt(queue, row, end_ns):
    try:
        require(row['dispatch_ns'] and row['baseline'] and row['exit_receipt'], 'no durable original exit receipt')
        original_exit = decode(row['exit_receipt'])
        require(original_exit.get('version') == 1 and original_exit.get('attempt') == row['id']
                and original_exit.get('tokenSha256') == hashlib.sha256(row['token'].encode()).hexdigest()
                and same_process(original_exit['process'], decode(row['process']))
                and original_exit['scanner'] == decode(row['scanner_process'])
                and type(original_exit.get('code')) is int and original_exit['code'] == row['exit_code'] == 0,
                'original scanner exit unconfirmed')
        verify_inputs(queue, row)
        directory = private_directory(queue.database.parent / row['id'])
        result_bytes = read_regular(directory / 'stdout.log', private=True)
        diagnostic_bytes = read_regular(directory / 'stderr.log', private=True)
        require(hashlib.sha256(result_bytes).hexdigest() == original_exit['resultSha256']
                and hashlib.sha256(diagnostic_bytes).hexdigest() == original_exit['diagnosticSha256'],
                'original receipt artifact changed')
        result, diagnostics = decode(result_bytes), decode(diagnostic_bytes)
        require(result.get('schemaVersion') == 1 and result.get('valid') is True
                and result.get('status') == 'success' and result.get('serviceMatched') is True
                and result.get('filesReviewed') == 1 and result.get('warningsCount') == 0
                and result.get('toolFailures') == 0 and result.get('budgetExceeded') is False
                and result.get('fresh') is True, 'result not a clean fresh scan')
        require(diagnostics.get('schemaVersion') == 1 and diagnostics.get('fatal') is False
                and diagnostics.get('overflow') is False and diagnostics.get('streamError') is False,
                'uncertain original diagnostics')
        return session_receipt(queue, row, result['session_id'], end_ns, result)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, QueueError):
        return None


def scanner_argv(queue, row):
    definition = decode(row["definition"])
    return [queue.meta("scanner"), "scan", "--repo", queue.meta("snapshot"), "--path", row["path"],
            "--concurrency", "1", "--batch", "continuous", "--no-dedup", "--no-plan", "--no-summary",
            "--provider", row["provider"], "--model", row["model"], "--max-tokens",
            str(definition["maxTokens"]), "--format", "json", "--audience", "human"]


def launch(queue, row):
    # The original controller owns this reservation; only the child gate can
    # mark it admitted. No scanner bytes are connected to persistent log files.
    private_directory(queue.database.parent / row["id"], create=True)
    environment = runtime_environment(queue)
    with queue.transaction():
        current = queue.attempt(row["id"], row["token"])
        require(current["status"] == "claimed" and not queue.meta("paused"), "launch admission changed")
        require(scanner_identity(queue.meta("scanner")) == queue.meta("scannerIdentity"), "scanner image changed")
        model = queue.connection.execute("SELECT state,generation FROM models WHERE id=?", (current["model_id"],)).fetchone()
        latest = queue.connection.execute("SELECT max(generation) FROM models WHERE provider=? AND model=?", (current["provider"], current["model"])).fetchone()[0]
        require(model["state"] == "active" and model["generation"] == latest, "launch model changed")
        return subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--db", str(queue.database),
                                 "_exec", row["id"], row["token"]], cwd=queue.meta("snapshot"),
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                env=environment, start_new_session=True)


def run(queue, once=False):
    runtime_environment(queue)
    require(hashlib.sha256(read_regular(queue.meta("scanner"))).hexdigest() == queue.meta("scannerSha256"), "scanner image changed")
    children = {}
    while True:
        for ident, (row, child) in list(children.items()):
            if child.poll() is not None:
                child.wait()
                queue.finish(ident, row["token"], child.returncode)
                del children[ident]
        queue.reconcile()
        while (row := queue.claim()) is not None:
            try:
                children[row["id"]] = (row, launch(queue, row))
            except QueueError:
                queue.hold(row["id"], row["token"], "ADMISSION_CHANGED_BEFORE_SPAWN", release=True, quarantine=False)
            except OSError:
                queue.hold(row["id"], row["token"], "LAUNCH_UNCONFIRMED")
        if once and not children:
            return
        time.sleep(0.2)


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--plan", type=Path, required=True)
    init.add_argument("--scanner", type=Path, required=True)
    init.add_argument("--session-root", type=Path, required=True)
    init.add_argument("--max-tokens", type=int, default=58888)
    for name in ("status", "pause", "resume", "reconcile"):
        commands.add_parser(name)
    directory = commands.add_parser('directory').add_subparsers(dest='operation', required=True)
    select = directory.add_parser('select')
    select.add_argument('path')
    directory.add_parser('show')
    receipts = commands.add_parser('receipts')
    receipts.add_argument('--after', type=int, default=0)
    receipts.add_argument('--limit', type=int, default=100)
    verify = commands.add_parser('verify-receipt')
    verify.add_argument('attempt')
    driver = commands.add_parser("run")
    driver.add_argument("--once", action="store_true")
    execute = commands.add_parser("_exec")
    execute.add_argument("attempt")
    execute.add_argument("token")
    models = commands.add_parser("models").add_subparsers(dest="operation", required=True)
    add = models.add_parser("add")
    add.add_argument("--definition", type=Path, required=True)
    models.add_parser("list")
    for name in ("drain", "resume", "remove", "set-concurrency"):
        change = models.add_parser(name)
        change.add_argument("provider")
        change.add_argument("model")
        if name == "set-concurrency":
            change.add_argument("concurrency", type=int)
    args = parser.parse_args(argv)
    if args.command == "init":
        require(args.db.name == "queue.sqlite", "init database must be named queue.sqlite")
        queue = Queue.create(args.db.parent, decode(read_regular(args.plan)), args.scanner, args.session_root, args.max_tokens)
    else:
        queue = Queue(args.db)
    try:
        if args.command == "_exec":
            raise SystemExit(execute_attempt(queue, args.attempt, args.token))
        elif args.command in ("pause", "resume"):
            queue.pause(args.command == "pause")
        elif args.command == "run":
            run(queue, args.once)
        elif args.command == "reconcile":
            queue.reconcile()
        elif args.command == 'receipts':
            print(json.dumps(queue.receipts(args.after,args.limit),ensure_ascii=False));return
        elif args.command == 'verify-receipt':
            print(json.dumps(queue.verify_receipt(args.attempt),ensure_ascii=False));return
        elif args.command == "directory":
            if args.operation == "select":
                queue.select_directory(args.path)
        elif args.command == "models":
            if args.operation == "add":
                queue.add_model(decode(read_regular(args.definition)))
            elif args.operation != "list":
                queue.model_change(args.provider, args.model,
                    state={"drain": "draining", "resume": "active", "remove": "removed"}.get(args.operation),
                    concurrency=getattr(args, "concurrency", None))
        print(json.dumps(queue.status(), ensure_ascii=False))
    finally:
        queue.close()


if __name__ == "__main__":
    try:
        main()
    except QueueError as error:
        print(f"OCR queue error: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('OCR queue error: OPERATION_UNCONFIRMED', file=sys.stderr)
        sys.exit(1)
