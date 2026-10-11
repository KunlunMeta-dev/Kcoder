"""A detached Wiki supervisor retains account revocation checks after SSH EOF.

Only this root-owned launcher may start durable account workers. There is no
network listener and no stored password/token: validity comes from AccountStore.
"""
import fcntl
import os
from pathlib import Path
import signal
import time

from studio_account_runtime import drop_to_worker
from studio_account_sessions import supervise


def start_knowledge_worker(store, identity, binding, runtime):
    """Fork a supervisor, independent of the connection's process group."""
    # Do not pass any SSH descriptors (including the authentication stream) to
    # the durable process. The parent never waits for Wiki model work.
    child = os.fork()
    if child:
        os.waitpid(child, 0)
        return
    try:
        os.setsid()
        if os.fork():
            os._exit(0)
        signal.alarm(0)
        for kind in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            signal.signal(kind, signal.SIG_DFL)
        null = os.open(os.devnull, os.O_RDWR)
        for descriptor in (0, 1, 2):
            os.dup2(null, descriptor)
        os.closerange(3, min(os.sysconf("SC_OPEN_MAX"), 1048576))
        supervise_knowledge(store, identity, binding, runtime)
    finally:
        os._exit(0)


def supervise_knowledge(store, identity, binding, runtime, interval=1.0):
    """Keep exactly one root supervisor for this account authorization revision."""
    lock_path = store.path.parent / ("wiki-" + identity["id"] + "-" + str(identity["revision"]) + ".lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        profile = str(Path(binding["home"]) / ".config/kcoder/settings.json")

        def start_worker():
            environment = drop_to_worker(binding, identity)
            os.execve(runtime, [runtime, "--internal-wiki-worker", profile], environment)

        # Reuse the existing group ownership/revocation supervisor. Unlike its
        # connection instance, this supervisor never receives an SSH hangup.
        def current():
            try:
                return store.session_current(identity)
            except Exception:
                return False

        stop_requested = []
        while current() and not stop_requested:
            supervise(store, identity, start_worker, interval=interval,
                      stop_requested=stop_requested)
            if current() and not stop_requested:
                time.sleep(interval)
        # SIGTERM normally pauses the worker itself. Also pause after a crash or
        # forced kill, so a later login cannot revive work from a revoked grant.
        child = os.fork()
        if child == 0:
            try:
                environment = drop_to_worker(binding, identity)
                os.execve(runtime, [runtime, "--internal-wiki-pause", profile], environment)
            finally:
                os._exit(1)
        os.waitpid(child, 0)
    finally:
        os.close(descriptor)
