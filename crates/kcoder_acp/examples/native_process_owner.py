"""Linux-only ownership of this probe's observed process generations."""
import os
import select
import signal
import threading
import time
from pathlib import Path


def process_identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return int(fields[1]), int(fields[19])
    except (OSError, IndexError, ValueError):
        return None


def exited(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return bool(poll.poll(0))


class OwnedProcesses:
    def __init__(self, stop):
        self.stop = stop
        self.lock = threading.RLock()
        self.observed = {}
        self.accepting = True
        self.parent_identity = process_identity(os.getpid())
        self.cleanup_result = None

    def _parent(self, pid):
        with self.lock:
            if not self.accepting:
                return None
            current = process_identity(pid)
            if pid == os.getpid():
                return current if current == self.parent_identity else None
            for (known, start), fd in self.observed.items():
                if known == pid and current is not None and current[1] == start and not exited(fd):
                    return current
        return None

    def observe(self, pid, parent):
        generation = self._parent(parent)
        before = process_identity(pid)
        if generation is None or before is None or before[0] != parent:
            return None
        with self.lock:
            if not self.accepting:
                return None
            key = (pid, before[1])
            if key in self.observed:
                return key
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                return None
            if process_identity(pid) != before or self._parent(parent) != generation:
                os.close(fd)
                return None
            self.observed[key] = fd
            return key

    def descendants(self, parent):
        generation = self._parent(parent)
        if generation is None or self.stop.is_set():
            return
        children = set()
        try:
            for task in Path(f"/proc/{parent}/task").iterdir():
                try:
                    children.update(map(int, (task / "children").read_text().split()))
                except OSError:
                    pass
        except OSError:
            return
        # A children listing is not ownership of a recycled parent PID.
        if self._parent(parent) != generation:
            return
        for pid in sorted(children):
            if self.stop.is_set():
                return
            if self.observe(pid, parent) is not None:
                self.descendants(pid)

    def freeze(self):
        with self.lock:
            self.accepting = False
            return list(self.observed.values())

    def cleanup(self, child):
        if self.cleanup_result is not None:
            return self.cleanup_result
        handles = self.freeze()
        failures = []

        def attempt(stage, action):
            try:
                return action()
            except ProcessLookupError:
                return None
            except Exception as error:
                failures.append(stage + ":" + type(error).__name__)
                return None

        def gone(fd):
            try:
                return exited(fd)
            except Exception as error:
                failures.append("exit_observation:" + type(error).__name__)
                return False

        def wait():
            deadline = time.monotonic() + 3
            while any(not gone(fd) for fd in handles) and time.monotonic() < deadline:
                time.sleep(0.01)

        root_observed = child is None or any(pid == child.pid for pid, _start in self.observed)
        if not root_observed:
            failures.append("root_observation_missing")
        if child is not None and child.stdin is not None:
            attempt("stdin_close", child.stdin.close)
        for fd in reversed(handles):
            if not gone(fd):
                attempt("term_signal", lambda fd=fd: signal.pidfd_send_signal(fd, signal.SIGTERM))
        if child is not None and not root_observed:
            attempt("root_terminate", child.terminate)
        attempt("term_wait", wait)
        for fd in reversed(handles):
            if not gone(fd):
                attempt("kill_signal", lambda fd=fd: signal.pidfd_send_signal(fd, signal.SIGKILL))
        if child is not None:
            if not root_observed:
                attempt("root_kill", child.kill)
            attempt("root_wait", lambda: child.wait(timeout=3))
        attempt("kill_wait", wait)
        all_exited = all(gone(fd) for fd in handles) and (child is None or child.returncode is not None)
        for fd in handles:
            attempt("pidfd_close", lambda fd=fd: os.close(fd))
        self.cleanup_result = {"observedProcesses": len(handles), "allObservedExited": all_exited and root_observed,
                               "cleanupFailures": failures}
        return self.cleanup_result
