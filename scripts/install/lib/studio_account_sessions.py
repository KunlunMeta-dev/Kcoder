"""Supervise only the account runtime created by this SSH connection."""
import os
import signal
import time


def supervise(store, identity, start, interval=1.0):
    """Keep the root-owned account revision check outside the unprivileged child."""
    ready_read, ready_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(ready_read)
            os.setsid()
            os.write(ready_write, b"1")
            os.close(ready_write)
            start()
        finally:
            os._exit(1)
    os.close(ready_write)
    previous = {}
    stop = False

    def request_stop(*_):
        nonlocal stop
        stop = True

    try:
        os.read(ready_read, 1)
        for kind in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            previous[kind] = signal.signal(kind, request_stop)
        while True:
            observed = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if observed:
                return observed.si_status if observed.si_code == os.CLD_EXITED else 1
            try:
                valid = store.session_current(identity)
            except Exception:
                valid = False
            if stop or not valid:
                break
            time.sleep(interval)
    finally:
        os.close(ready_read)
        # This child created its own session before acknowledging the pipe.
        # Never enumerate or kill other UIDs, SSH connections or account sessions.
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                if os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
                    break
            except ChildProcessError:
                break
            time.sleep(0.05)
        # Include descendants that outlive the main child in the owned group.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        for kind, handler in previous.items():
            signal.signal(kind, handler)
    return 1
