#!/usr/bin/python3 -I
"""Forced SSH command: authenticate one bounded frame, drop privileges, then exec KCoder."""

import argparse
import json
import os
from pathlib import Path
import signal
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from studio_accounts import AccountError, AccountStore
from studio_account_runtime import drop_to_worker, ensure_binding, trusted_runtime

identity_verified = False


def reply(value):
    payload = memoryview((json.dumps(value) + "\n").encode())
    while payload:
        payload = payload[os.write(1, payload):]


def read_frame(limit=8192):
    # Avoid buffered reads: pipelined app-server frames must remain in stdin across exec.
    frame = bytearray()
    while len(frame) <= limit:
        byte = os.read(0, 1)
        if not byte:
            raise AccountError("Missing authentication frame")
        if byte == b"\n":
            break
        frame.extend(byte)
    else:
        raise AccountError("Authentication frame is too large")
    try:
        value = json.loads(frame)
    finally:
        frame[:] = bytes(len(frame))
    return value


def read_login():
    value = read_frame()
    if not isinstance(value, dict) or set(value) - {"protocol", "username", "password", "workspace", "mode"}:
        raise AccountError("Invalid authentication frame")
    if value.get("protocol") != "kcoder-account-v1" or not isinstance(value.get("username"), str) or not isinstance(value.get("password"), str):
        raise AccountError("Invalid authentication protocol")
    if value.get("mode", "runtime") not in ("runtime", "admin"):
        raise AccountError("Invalid connection mode")
    workspace = value.get("workspace")
    if workspace is not None and (not isinstance(workspace, str) or len(workspace) > 2048 or not os.path.isabs(workspace) or "\0" in workspace):
        raise AccountError("Invalid workspace")
    return value


def main():
    global identity_verified
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-directory", type=Path, default=Path("/var/lib/kcoder/accounts"))
    parser.add_argument("--homes-directory", type=Path, default=Path("/var/lib/kcoder-users"))
    parser.add_argument("--runtime", type=Path, default=Path("/usr/local/bin/kcoder"))
    args = parser.parse_args()
    if os.geteuid() != 0 or os.environ.get("SSH_ORIGINAL_COMMAND") != "kcoder-account":
        raise AccountError("This entry accepts only the KCoder account protocol")
    runtime = trusted_runtime(args.runtime)
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(20)
    login = read_login()
    store = AccountStore(args.state_directory)
    identity = store.authenticate(login["username"], login["password"])
    identity_verified = True
    del login["password"]
    if login.get("mode") == "admin":
        if identity["role"] != "admin":
            raise AccountError("Account administrator role required")
        result = store.administer(identity, read_frame(4 * 1024 * 1024))
        signal.alarm(0)
        reply({"protocol": "kcoder-account-v1", "authenticated": True,
               "principalId": identity["id"], "username": identity["username"],
               "role": "admin", "result": result})
        return
    binding = ensure_binding(store, identity, args.homes_directory)
    environment = drop_to_worker(binding, identity)
    # Clients may pass workspaces that are invisible or inaccessible to this
    # account (for example shared-host virtual paths). Fall back to the
    # account's own default workspace instead of failing the whole runtime.
    workspace = login.get("workspace") or binding["home"] + "/workspace"
    try:
        os.chdir(workspace)
    except OSError:
        workspace = binding["home"] + "/workspace"
        os.chdir(workspace)
    signal.alarm(0)
    response = {"protocol": "kcoder-account-v1", "authenticated": True,
                "principalId": identity["id"], "username": identity["username"],
                "role": identity["role"], "uid": os.geteuid()}
    reply(response)
    os.closerange(3, min(os.sysconf("SC_OPEN_MAX"), 1048576))
    os.execve(runtime, [runtime, "--cwd", workspace, "app-server"], environment)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never include input, provider details, filesystem paths or exception values here.
        reply({"protocol": "kcoder-account-v1", "authenticated": False,
               "errorCode": "runtime_start_failed" if identity_verified else "authentication_failed",
               "error": "Account authentication or isolated startup failed"})
        sys.exit(1)
