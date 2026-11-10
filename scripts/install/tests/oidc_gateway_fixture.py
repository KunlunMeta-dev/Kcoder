"""Owned HTTPS IdP/account fixture controller for registered Studio browser E2E."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import sysconfig
import tempfile
import time

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1] / "lib")]
from oidc_fixture import OidcFixture
from studio_accounts import AccountStore
from studio_account_deploy import prepare
from studio_account_runtime import ensure_binding
from studio_organization import OrganizationStore
from studio_organization_oidc_provider import OidcProviderStore
from account_fixture_cleanup import cleanup_worker_accounts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--prefix", type=Path)
    parser.add_argument("--administrator", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0 or os.environ.get("KCODER_TEST_SYSTEM_USERS") != "1":
        raise RuntimeError("Explicit owned system-user acceptance gate required")
    args.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    issuer = OidcFixture(args.state)
    issuer.require_user_action = True
    store = AccountStore(args.state / "accounts")
    installed = None if args.prefix else tempfile.TemporaryDirectory(prefix="kcoder-oidc-browser-", dir="/usr/local/lib")
    homes = Path(tempfile.mkdtemp(prefix="kcoder-oidc-browser-homes-"))
    runtime_fd, runtime_name = tempfile.mkstemp(prefix=".kcoder-oidc-runtime-", dir="/usr/local/lib")
    os.close(runtime_fd)
    runtime = Path(runtime_name)
    try:
        prefix = args.prefix or Path(installed.name)
        prepare(prefix, Path(__file__).resolve().parents[1])
        shutil.copytree(sysconfig.get_path("purelib"), prefix / "oidc-deps", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copyfile(args.runtime, runtime)
        runtime.chmod(0o755)
        identity = store.create("alice", "synthetic-unused-oidc-fixture-password", "admin" if args.administrator else "user")
        binding = ensure_binding(store, identity, homes)
        alternate = Path(binding["home"]) / "workspace-other"
        alternate.mkdir(mode=0o700); os.chown(alternate, binding["uid"], binding["gid"])
        organization = OrganizationStore(store)
        organization.configure("fixture-browser-organization")
        configured = {**issuer.configuration(), "redirectUri": "http://127.0.0.1:1/api/account/oidc/callback", "loopbackPortNegotiation": True}
        OidcProviderStore(store).configure(configured)
        organization.administer(None, {"operation": "organization.member", "principalId": identity["id"], "roles": ["auditor"] if args.administrator else ["member"],
                                         "oidc": {"issuer": issuer.issuer, "sub": "subject-alice"}})
        print(json.dumps({"ready": True, "entry": str(prefix / "bin/studio-account-entry.py"), "state": str(store.root),
                          "homes": str(homes), "runtime": str(runtime), "runtimeSha256": hashlib.file_digest(runtime.open("rb"), "sha256").hexdigest(),
                          "issuer": issuer.issuer, "uid": binding["uid"], "principalId": identity["id"],
                          "workspace": str(Path(binding["home"]) / "workspace"), "alternateWorkspace": str(alternate)}), flush=True)
        def stop(*_):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        for line in sys.stdin:
            request = json.loads(line)
            if request.get("operation") == "gateway":
                issuer.redirect_uri = request["origin"] + "/api/account/oidc/callback"
                result = {"configured": True}
            elif request.get("operation") == "stop":
                break
            elif request.get("operation") == "snapshot":
                result = {"exchanges": len(issuer.token_requests), "authorizations": len(issuer.authorization_requests),
                          "uid": binding["uid"], "revision": store._load()["accounts"][0]["revision"]}
            elif request.get("operation") == "deliverLogout":
                import requests
                token = issuer.logout_token(sid="session-alice")
                if request.get("corrupt"): token = token[:-4] + "AAAA"
                endpoint = request["endpoint"]
                if not endpoint.startswith(issuer.redirect_uri.split("/api/", 1)[0] + "/api/servers/"):
                    raise RuntimeError("Logout target left the owned Gateway")
                with requests.Session() as client:
                    client.trust_env = False
                    response = client.post(endpoint, data={"logout_token": token}, timeout=20, allow_redirects=False)
                result = {"status": response.status_code, "processed": response.json().get("processed") is True}
            else:
                raise RuntimeError("Unknown owned OIDC fixture operation")
            print(json.dumps({"id": request.get("id"), **result}), flush=True)
    finally:
        cleanup_ok = False
        try:
            state = store._load()
            if any(item["username"] == "alice" for item in state["accounts"]):
                store.revoke_sessions("alice")
                for lock in store.root.glob("wiki-" + identity["id"] + "-*.lock"):
                    descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
                    try:
                        deadline = time.monotonic() + 15
                        while True:
                            try: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB); break
                            except BlockingIOError:
                                if time.monotonic() >= deadline: raise RuntimeError("Owned Wiki authority did not terminate")
                                time.sleep(0.05)
                    finally: os.close(descriptor)
                for binding in state["bindings"].values():
                    path = Path(binding["home"]) / "tmp/oidc-owned-wiki-parents.jsonl"
                    if path.exists():
                        deadline = time.monotonic() + 10
                        for line in path.read_text().splitlines():
                            pid = json.loads(line)["parentPid"]
                            while time.monotonic() < deadline:
                                try: status = Path(f"/proc/{pid}/status").read_text()
                                except FileNotFoundError: break
                                if "State:\tZ" in status: break
                                time.sleep(0.05)
                cleanup_worker_accounts(store)
            shutil.rmtree(homes)
            runtime.unlink()
            cleanup_ok = True
        finally:
            issuer.close()
            if installed is not None:
                if cleanup_ok: installed.cleanup()
                else: installed._finalizer.detach()
            print(json.dumps({"cleanupComplete": cleanup_ok}), flush=True)


if __name__ == "__main__":
    main()
