"""Test-only namespace initializer and SSH byte bridge; never edits host accounts."""

import json
import os
from pathlib import Path
import pwd
import re
import selectors
import socket
import subprocess
import sys
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


BASE_PASSWD = "root:x:0:0:Owned fixture controller:/root:/bin/sh\nsshd:x:74:74:Owned privilege separation:/run/sshd:/bin/sh\n"
BASE_GROUP = "root:x:0:\nsshd:x:74:\n"
BASE_SHADOW = "root:*:0:0:99999:7:::\nsshd:*:0:0:99999:7:::\n"


def require_owner(owner):
    if not re.fullmatch(r"[a-f0-9-]{36}", owner) or not Path("/.dockerenv").is_file():
        raise RuntimeError("Original owned container required")
    if json.loads(Path("/control/owner.json").read_text())["owner"] != owner:
        raise RuntimeError("Original container owner changed")


def emit(value):
    print(json.dumps(value), flush=True)


def accounts(owner):
    suffix = owner.replace("-", "")[:12]
    return [{"name": "kce2e_a_" + suffix, "uid": 20001, "gid": 20001, "home": "/home/a"},
            {"name": "kce2e_b_" + suffix, "uid": 20002, "gid": 20002, "home": "/home/b"}]


def verify_accounts(users):
    for user in users:
        actual = pwd.getpwnam(user["name"])
        info = Path(user["home"]).stat()
        if (actual.pw_uid, actual.pw_gid, actual.pw_dir) != (user["uid"], user["gid"], user["home"]) or info.st_uid != user["uid"] or info.st_mode & 0o077:
            raise RuntimeError("Original fixture account identity changed")


def initialize(owner):
    require_owner(owner)
    if os.getpid() != 1 or os.geteuid() != 0 or set(os.listdir("/sys/class/net")) != {"lo"}:
        raise RuntimeError("Private PID1/root/network-none namespace required before account initialization")
    if Path("/etc/passwd").read_text() != BASE_PASSWD or Path("/etc/group").read_text() != BASE_GROUP:
        raise RuntimeError("Refuse adoption of an existing namespace account database")
    users = accounts(owner)
    Path("/etc/passwd").write_text(BASE_PASSWD + "".join(f"{u['name']}:x:{u['uid']}:{u['gid']}:Owned SSH fixture:{u['home']}:/bin/sh\n" for u in users))
    Path("/etc/group").write_text(BASE_GROUP + "".join(f"{u['name']}:x:{u['gid']}:\n" for u in users))
    Path("/etc/shadow").write_text(BASE_SHADOW + "".join(f"{u['name']}:*:0:0:99999:7:::\n" for u in users))
    os.chmod("/etc/shadow", 0o600)
    for index, user in enumerate(users):
        home = Path(user["home"])
        os.chown(home, user["uid"], user["gid"])
        os.chmod(home, 0o700)
        for leaf in ["workspace", "tmp", ".config", ".config/kcoder"]:
            path = home / leaf
            path.mkdir(mode=0o700)
            os.chown(path, user["uid"], user["gid"])
        marker = home / "private-marker"
        marker.write_text(f"OWNED_UID_{index}_PRIVATE\n")
        os.chmod(marker, 0o600)
        os.chown(marker, user["uid"], user["gid"])
    verify_accounts(users)
    subprocess.run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "owned-peer-uid-container", "-f", "/control/host-key"], check=True)
    reservation = socket.socket()
    reservation.bind(("127.0.0.1", 0))
    port = reservation.getsockname()[1]
    config = "\n".join([f"Port {port}", "ListenAddress 127.0.0.1", "HostKey /control/host-key", "PidFile /control/sshd.pid",
        "AuthorizedKeysFile /auth/authorized_keys", "StrictModes yes", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes",
        "AuthenticationMethods publickey", "PermitRootLogin no", "UsePAM no", "PermitUserEnvironment no", "PermitUserRC no", "AllowAgentForwarding no",
        "AllowTcpForwarding no", "X11Forwarding no", "PermitTunnel no", "LogLevel VERBOSE", "AllowUsers " + " ".join(u["name"] for u in users), ""])
    Path("/control/sshd_config").write_text(config)
    os.chmod("/control/sshd_config", 0o600)
    log = open("/control/sshd.log", "ab", buffering=0)
    reservation.close()
    sshd = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e", "-f", "/control/sshd_config"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
    deadline = time.monotonic() + 10
    while True:
        if sshd.poll() is not None:
            raise RuntimeError("Owned namespace sshd exited before ready")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                break
        except OSError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Owned namespace sshd readiness timeout")
            time.sleep(0.02)
    return users, port, sshd, log


def user_processes(users):
    identifiers = {u["uid"] for u in users}
    found = []
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            line = next(line for line in (path / "status").read_text().splitlines() if line.startswith("Uid:"))
            if int(line.split()[1]) in identifiers:
                found.append(int(path.name))
        except (FileNotFoundError, PermissionError, StopIteration):
            continue
    return found


def product_model(users):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_HEAD(self):
            self.send_error(404)

        def do_POST(self):
            observed = {"path": self.path, "status": None}
            requests.append(observed)
            length = int(self.headers.get("content-length", "0"))
            if self.path != "/v1/chat/completions" or not 0 < length <= 2 * 1024 * 1024:
                observed["status"] = 400
                self.send_error(400)
                return
            body = json.loads(self.rfile.read(length))
            text = json.dumps(body.get("messages", []))
            subject = next((index for index in range(2) if f"OWNED_UID_{index}_SEED" in text), None)
            accepted = [row for row in requests if row.get("status") == 200]
            if subject is None or len(accepted) >= 2 or any(row["subject"] == subject for row in accepted):
                observed["status"] = 409
                self.send_error(409)
                return
            observed.update({"status": 200, "subject": subject, "model": body.get("model"), "maxTokens": body.get("max_tokens")})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in [({"role": "assistant", "content": "OWNED_UID_SEED_READY"}, None), ({}, "stop")]:
                chunk = {"id": "owned-uid-seed", "object": "chat.completion.chunk", "model": "owned-uid-peer", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for user in users:
        settings = {"active_provider": "OwnedUid", "credential_store": "file", "permission_mode": "ask", "max_retries": 0,
                    "cross_session_messages": {"enabled": True, "wake_idle": False}, "auto_memory_enabled": False,
                    "auto_tool_memory_enabled": False, "session_memory": {"enabled": False},
                    "memory": {"observer_mode": "disabled", "structured_enabled": False, "legacy_prompt_enabled": False},
                    "providers": {"OwnedUid": {"api_format": "openai_chat_completions", "authentication": {"mode": "none"},
                        "endpoint": f"http://127.0.0.1:{server.server_port}/v1", "default_model": "owned-uid-peer", "no_proxy": True,
                        "discover_models": False, "context_window_tokens": 128000, "max_output_tokens": 256, "output_headroom_tokens": 256}}}
        path = Path(user["home"]) / ".config/kcoder/settings.json"
        path.write_text(json.dumps(settings))
        os.chown(path, user["uid"], user["gid"])
        os.chmod(path, 0o600)
    return server, thread, requests


def native_snapshot(users, identifiers):
    result = []
    image = Path("/runtime/kcoder").stat()
    for index, pid in enumerate(identifiers):
        if index >= len(users) or not isinstance(pid, int) or pid < 2:
            raise RuntimeError("Original Native namespace PID required")
        status = Path(f"/proc/{pid}/status").read_text()
        uids = next(line.split()[1:] for line in status.splitlines() if line.startswith("Uid:"))
        if [int(uid) for uid in uids] != [users[index]["uid"]] * 4:
            raise RuntimeError("Actual Native OS UID differs from authenticated target")
        actual = Path(f"/proc/{pid}/exe").stat()
        if (actual.st_dev, actual.st_ino) != (image.st_dev, image.st_ino):
            raise RuntimeError("Actual Native namespace image differs from immutable mount")
        start = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        cap_eff = next(line.split()[1] for line in status.splitlines() if line.startswith("CapEff:"))
        no_new_privs = next(line.split()[1] for line in status.splitlines() if line.startswith("NoNewPrivs:"))
        if int(cap_eff, 16) != 0 or no_new_privs != "1":
            raise RuntimeError("Native must retain an actual unprivileged token")
        result.append({"pid": pid, "uid": int(uids[0]), "startTimeTicks": start, "imageDevice": actual.st_dev,
                       "imageInode": actual.st_ino, "capEff": cap_eff, "noNewPrivs": no_new_privs})
    return result


def daemon(owner, product=False):
    users, port, sshd, log = initialize(owner)
    server, model_thread, model_requests = product_model(users) if product else (None, None, [])
    emit({"version": 1, "ready": True, "owner": owner, "users": users, "port": port, "hostKey": Path("/control/host-key.pub").read_text().strip(), "sshdPid": sshd.pid, "product": product})
    error = None
    try:
        for raw in sys.stdin:
            request = json.loads(raw)
            if request.get("operation") == "snapshot" and product:
                emit({"version": 1, "snapshot": True, "owner": owner, "requestId": request["requestId"], "native": native_snapshot(users, request.get("nativePids", [])), "modelRequests": model_requests})
                continue
            if request != {"operation": "finish"}:
                raise RuntimeError("Controller accepts original finish only")
            break
        verify_accounts(users)
        if server:
            server.shutdown()
            server.server_close()
            model_thread.join(timeout=5)
        sshd.terminate()
        sshd.wait(timeout=10)
        deadline = time.monotonic() + 5
        while user_processes(users):
            try:
                while os.waitpid(-1, os.WNOHANG)[0]:
                    pass
            except ChildProcessError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("Original test UID process exit unconfirmed")
            time.sleep(0.02)
        Path("/etc/passwd").write_text(BASE_PASSWD)
        Path("/etc/group").write_text(BASE_GROUP)
        Path("/etc/shadow").write_text(BASE_SHADOW)
        emit({"version": 1, "closed": True, "owner": owner, "originalAccountsRetired": True, "originalSshdExited": True, "originalUidProcessesAbsent": True, "modelRequestCount": len(model_requests)})
    except Exception as failure:
        error = failure
        emit({"version": 1, "closed": False, "owner": owner, "code": "owned_namespace_cleanup_unconfirmed"})
    finally:
        log.close()
    if error:
        raise RuntimeError("Owned namespace cleanup unconfirmed") from error


def proxy(owner, port):
    require_owner(owner)
    if not 1024 < port < 65536:
        raise RuntimeError("Original namespace SSH port required")
    stream = socket.create_connection(("127.0.0.1", port), timeout=10)
    stream.settimeout(None)
    selected = selectors.DefaultSelector()
    selected.register(0, selectors.EVENT_READ)
    selected.register(stream, selectors.EVENT_READ)
    try:
        while True:
            for key, _ in selected.select():
                if key.fileobj == 0:
                    data = os.read(0, 65536)
                    if data:
                        stream.sendall(data)
                    else:
                        selected.unregister(0)
                        stream.shutdown(socket.SHUT_WR)
                else:
                    data = stream.recv(65536)
                    if not data:
                        return
                    while data:
                        written = os.write(1, data)
                        data = data[written:]
    finally:
        selected.close()
        stream.close()


def probe(other_home):
    own = pwd.getpwuid(os.getuid())
    blocked = False
    try:
        (Path(other_home) / "private-marker").read_bytes()
    except PermissionError:
        blocked = True
    parents = []
    pid = os.getppid()
    for _ in range(4):
        try:
            status = Path(f"/proc/{pid}/status").read_text()
            uids = next(line.split()[1:] for line in status.splitlines() if line.startswith("Uid:"))
            ppid = int(next(line.split()[1] for line in status.splitlines() if line.startswith("PPid:")))
            item = {"pid": pid, "ppid": ppid, "uids": [int(uid) for uid in uids]}
            try:
                image = Path(f"/proc/{pid}/exe").stat()
                item["imageReadable"] = True
                item["imageDevice"] = image.st_dev
                item["imageInode"] = image.st_ino
            except OSError as failure:
                item["imageReadable"] = False
                item["imageReadErrno"] = failure.errno
            try:
                item["fdDirectoryReadable"] = bool(list(Path(f"/proc/{pid}/fd").iterdir()))
            except OSError as failure:
                item["fdDirectoryReadable"] = False
                item["fdReadErrno"] = failure.errno
            parents.append(item)
            pid = ppid
            if pid < 1:
                break
        except OSError:
            break
    emit({"uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(), "groups": os.getgroups(), "username": own.pw_name,
          "home": os.environ.get("HOME"), "passwdHome": own.pw_dir, "ownMarkerReadable": (Path(own.pw_dir) / "private-marker").is_file(),
          "otherHomeReadBlocked": blocked, "pythonWritable": os.access("/usr/bin/python3", os.W_OK), "sshdWritable": os.access("/usr/sbin/sshd", os.W_OK),
          "nativeWritable": os.access("/runtime/kcoder", os.W_OK),
          "parentChain": parents, "noNewPrivs": next(line.split()[1] for line in Path("/proc/self/status").read_text().splitlines() if line.startswith("NoNewPrivs:"))})


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "daemon": daemon(sys.argv[2])
    elif mode == "product": daemon(sys.argv[2], product=True)
    elif mode == "proxy": proxy(sys.argv[2], int(sys.argv[3]))
    elif mode == "probe": probe(sys.argv[2])
    else: raise SystemExit("Unknown owned namespace fixture mode")
