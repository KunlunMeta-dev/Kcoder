"""Revoke only owned fixture accounts before deleting their temporary UIDs."""

import pwd
import subprocess
import time

from studio_account_runtime import worker_name


def cleanup_worker_accounts(store):
    state = store._load()
    for identity in state["accounts"]:
        binding = state["bindings"].get(identity["id"])
        if not binding:
            continue
        name = worker_name(identity["id"], state["instance"])
        try:
            account = pwd.getpwnam(name)
        except KeyError:
            continue
        if account.pw_uid != binding["uid"] or account.pw_uid < 1000:
            raise AssertionError("Refuse cleanup of an unowned worker account")
        # Wiki workers intentionally survive SSH EOF. Revoke the fixture's
        # authorization so its supervisor stops and pauses them before userdel.
        store.revoke_sessions(identity["username"])
        deadline = time.monotonic() + 30
        while True:
            current = pwd.getpwnam(name)
            if current.pw_uid != account.pw_uid:
                raise AssertionError("Worker identity changed during fixture cleanup")
            result = subprocess.run(["/usr/sbin/userdel", name], capture_output=True)
            if result.returncode == 0:
                break
            if result.returncode != 8 or time.monotonic() >= deadline:
                result.check_returncode()
            time.sleep(0.1)
