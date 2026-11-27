"""Explicit, isolated real-user bus fixture for native service acceptance."""

import json
import os
from pathlib import Path
import pwd
import signal
import stat
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore
from studio_account_runtime import drop_to_worker, ensure_binding, worker_name
from account_fixture_cleanup import cleanup_worker_accounts


class OwnedSystemdUser:
    """Never adopts an existing account or stops an unrelated user manager."""

    def __init__(self, root):
        if os.geteuid() != 0 or os.environ.get("KCODER_TEST_SYSTEM_USERS") != "1":
            raise RuntimeError("Explicit root KCODER_TEST_SYSTEM_USERS=1 required")
        self.root = Path(root).absolute()
        self.store = None
        self.binding = None
        self.identity = None
        self.manager_owned = False
        self.closed = False

    def _systemctl(self, *arguments, check=True):
        return subprocess.run(["/usr/bin/systemctl", *arguments], check=check,
                              capture_output=True, text=True, timeout=30)

    def start(self):
        self.root.mkdir(mode=0o711)
        self.store = AccountStore(self.root / "accounts")
        self.identity = self.store.create("systemd-fixture", "synthetic-systemd-test-password")
        self.binding = ensure_binding(self.store, self.identity, self.root / "homes")
        uid = self.binding["uid"]
        self.user = worker_name(self.identity["id"], self.binding["instance"])
        self.unit = f"user@{uid}.service"
        if self._systemctl("is-active", self.unit, check=False).returncode == 0:
            raise RuntimeError("Refuse adoption of an existing user manager")
        # The newly allocated UID is exclusive to this fixture. Mark ownership
        # before starting so a partial systemd start still receives cleanup.
        self.manager_owned = True
        self._systemctl("start", self.unit)
        self.runtime = Path("/run/user") / str(uid)
        info = self.runtime.lstat()
        bus = (self.runtime / "bus").lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
            raise RuntimeError("Original user runtime directory is not private")
        if not stat.S_ISSOCK(bus.st_mode) or bus.st_uid != uid:
            raise RuntimeError("Original user bus is unavailable")
        result = self.run(["/usr/bin/systemctl", "--user", "show-environment"])
        if result.returncode:
            raise RuntimeError("Actual owned user manager did not answer")
        return self

    def account(self):
        return {"uid": self.binding["uid"], "gid": self.binding["gid"],
                "home": self.binding["home"], "user": self.user,
                "runtimeDir": str(self.runtime),
                "busAddress": f"unix:path={self.runtime}/bus"}

    def run(self, arguments):
        def become_worker():
            environment = drop_to_worker(self.binding, self.identity)
            environment.update(XDG_RUNTIME_DIR=str(self.runtime),
                               DBUS_SESSION_BUS_ADDRESS=f"unix:path={self.runtime}/bus")
            os.environ.clear()
            os.environ.update(environment)

        return subprocess.run(arguments, preexec_fn=become_worker, capture_output=True,
                              text=True, timeout=30)

    def close(self):
        if self.closed:
            return
        if self.binding:
            current = pwd.getpwnam(self.user)
            if current.pw_uid != self.binding["uid"] or current.pw_dir != self.binding["home"]:
                raise RuntimeError("Retain fixture: original account identity changed")
            if self.manager_owned:
                self._systemctl("stop", self.unit)
                if self._systemctl("is-active", self.unit, check=False).returncode == 0:
                    raise RuntimeError("Retain fixture: original user manager remains active")
            # Foreign or unconfirmed processes are never killed to make userdel
            # succeed. Preserve the account and its data for their owner.
            deadline = time.monotonic() + 10
            while True:
                result = subprocess.run(["/usr/bin/pgrep", "-u", str(current.pw_uid)],
                                        capture_output=True, text=True, timeout=5)
                if result.returncode == 1:
                    break
                if result.returncode != 0 or time.monotonic() >= deadline:
                    raise RuntimeError("Retain fixture: owned UID process exit is unconfirmed")
                time.sleep(0.1)
            cleanup_worker_accounts(self.store)
        self.closed = True


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: owned_systemd_user.py <new-owned-directory>")
    fixture = OwnedSystemdUser(sys.argv[1])

    def interrupted(_signal, _frame):
        raise InterruptedError("Owned fixture termination requested")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        fixture.start()
        print(json.dumps({"ready": True, "account": fixture.account()}), flush=True)
        # EOF is the owner's explicit request to stop. No arbitrary RPC executes.
        for _line in sys.stdin:
            raise RuntimeError("Owned systemd fixture accepts EOF only")
    finally:
        fixture.close()
    print(json.dumps({"closed": True, "originalManagerStopped": True,
                      "originalAccountRemoved": True}), flush=True)


if __name__ == "__main__":
    main()
