"""Real fork/revocation tests without allocating UIDs or changing host services."""
import multiprocessing
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore
from studio_account_knowledge import start_knowledge_worker, supervise_knowledge


def wait_for(check, message):
    deadline = time.monotonic() + 8
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError(message)
        time.sleep(0.02)


class WikiSupervisor(unittest.TestCase):
    def test_ssh_exit_preserves_worker_but_revocation_stops_and_pauses_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = AccountStore(root / "accounts")
            identity = store.create("wiki-user", "synthetic-wiki-test-password")
            binding = {"home": str(root)}
            runtime = root / "fixture-runtime"
            runtime.write_text("""#!/usr/bin/python3
import os, signal, sys, time
from pathlib import Path
root = Path(os.environ['HOME'])
if sys.argv[1] == '--internal-wiki-pause':
    (root / 'paused').write_text('yes')
else:
    (root / 'started').write_text(str(os.getpid()))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    while True: time.sleep(.05)
""")
            runtime.chmod(0o700)
            environment = {"HOME": str(root), "PATH": "/usr/bin:/bin"}
            # The authenticated launcher exits, as an SSH connection would.
            # The worker retains no connection pipe or login password.
            with patch("studio_account_knowledge.drop_to_worker", return_value=environment):
                launcher = multiprocessing.get_context("fork").Process(
                    target=start_knowledge_worker, args=(store, identity, binding, str(runtime)))
                launcher.start()
                launcher.join(timeout=5)
            self.assertEqual(launcher.exitcode, 0)
            try:
                wait_for(lambda: (root / "started").exists(), "worker did not start")
                pid = int((root / "started").read_text())
                os.kill(pid, 0)
                self.assertFalse((root / "paused").exists())
                store.revoke_sessions("wiki-user")
                wait_for(lambda: (root / "paused").exists(), "revocation did not pause jobs")
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                store.set_disabled("wiki-user", True)
                wait_for(lambda: (root / "paused").exists(), "cleanup did not finish")

    def test_supervisor_signal_stops_without_restarting_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = AccountStore(root / "accounts")
            identity = store.create("wiki-user", "synthetic-wiki-test-password")
            runtime = root / "fixture-runtime"
            runtime.write_text("""#!/usr/bin/python3
import os, sys, time
from pathlib import Path
root = Path(os.environ['HOME'])
if sys.argv[1] == '--internal-wiki-pause': (root / 'paused').write_text('yes')
else:
    (root / 'started').write_text(str(os.getpid()))
    while True: time.sleep(.05)
""")
            runtime.chmod(0o700)
            with patch("studio_account_knowledge.drop_to_worker", return_value={"HOME": str(root)}):
                monitor = multiprocessing.get_context("fork").Process(target=supervise_knowledge,
                    args=(store, identity, {"home": str(root)}, str(runtime), 0.05))
                monitor.start()
            try:
                wait_for(lambda: (root / "started").exists(), "worker did not start")
                os.kill(monitor.pid, signal.SIGTERM)
                monitor.join(timeout=5)
                self.assertEqual(monitor.exitcode, 0)
                self.assertTrue((root / "paused").exists())
            finally:
                if monitor.is_alive(): monitor.kill()
                monitor.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
