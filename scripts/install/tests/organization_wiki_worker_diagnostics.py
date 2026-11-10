"""Optional private stderr capture for the fixture's exact owned worker only."""
from contextlib import contextmanager
import os
import hashlib
import json
import re
from pathlib import Path
import stat
import uuid
import traceback
from unittest.mock import patch

import studio_account_knowledge
from studio_account_files import AccountError
from studio_organization_channel import OrganizationChannel


@contextmanager
def private_worker_diagnostics():
    selected = os.environ.get("KCODER_ORGANIZATION_WIKI_DIAGNOSTIC_DIR")
    if not selected:
        yield
        return
    directory = Path(selected)
    info = directory.lstat()
    if (os.geteuid() != 0 or not directory.is_absolute() or directory.is_symlink()
            or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077):
        raise RuntimeError("Explicit root-private fixture diagnostics directory required")
    path = directory / ("owned-wiki-worker-" + uuid.uuid4().hex + ".log")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    original = studio_account_knowledge.supervise
    original_error = AccountError.__init__
    original_channel = OrganizationChannel.__init__

    def record(value):
        os.write(descriptor, (json.dumps(value, separators=(",", ":")) + "\n").encode())

    class ObservedSocket:
        def __init__(self, inner):
            self.inner = inner
        def __getattr__(self, name):
            return getattr(self.inner, name)
        def recvmsg(self, *args, **kwargs):
            value = self.inner.recvmsg(*args, **kwargs)
            try:
                request = json.loads(value[0])
                operation = request.get("operation")
            except (ValueError, AttributeError):
                operation = None
            allowed = {"inspect", "evaluate", "model.evaluate", "budget.request", "wiki.jobs", "wiki.job.bind",
                "wiki.job.preflight", "wiki.job.open", "wiki.job.current", "wiki.job.observe"}
            record({"receivedOperation": operation if operation in allowed else "other"})
            if operation == "model.evaluate":
                revision = request.get("configurationRevision")
                record({"observedModelRevision": revision if isinstance(revision, str) and re.fullmatch(r"[a-f0-9]{64}", revision) else None})
            if operation == "budget.request":
                kind = request.get("action", {}).get("kind")
                record({"budgetAction": kind if kind in {"reserve", "dispatch", "read", "observe", "check", "calls_closed"} else "other"})
            return value
        def send(self, data, *args, **kwargs):
            try:
                value = json.loads(data)
                result = value.get("result")
                record({"responseOk": value.get("ok") is True,
                    "allowed": result.get("allowed") if isinstance(result, dict) and isinstance(result.get("allowed"), bool) else None,
                    "listedJobs": len(result["items"]) if isinstance(result, dict) and isinstance(result.get("items"), list) else None})
            except (ValueError, TypeError):
                record({"responseEncodingObserved": False})
            return self.inner.send(data, *args, **kwargs)

    def observed_channel(channel, *args, **kwargs):
        original_channel(channel, *args, **kwargs)
        if channel.parent is not None:
            channel.parent = ObservedSocket(channel.parent)
        record({"channelPurpose": channel.purpose, "organizationBound": channel.snapshot is not None})

    def observed_error(error, *args):
        # Record only a digest and code location. Neither diagnostic body nor
        # a possibly interpolated credential/path enters the capture.
        event = {"accountErrorSha256": hashlib.sha256(str(args[0] if args else "").encode()).hexdigest(),
            "locations": [{"file": Path(frame.filename).name, "line": frame.lineno, "function": frame.name}
                for frame in traceback.extract_stack(limit=4)[:-1]]}
        record(event)
        original_error(error, *args)

    def supervise(store, identity, start, **kwargs):
        def owned_start():
            os.dup2(descriptor, 2)
            start()
        return original(store, identity, owned_start, **kwargs)

    try:
        # The owned fork inherits this callback and descriptor. Its argv,
        # identity, authority, deadline and cleanup remain the original ones.
        with patch.object(studio_account_knowledge, "supervise", supervise), patch.object(AccountError, "__init__", observed_error), patch.object(OrganizationChannel, "__init__", observed_channel):
            yield
    finally:
        os.close(descriptor)
