#!/usr/bin/python3 -I
"""Forced SSH command: authenticate one bounded frame, drop privileges, then exec KCoder."""

import argparse
import base64
import json
import os
from pathlib import Path
import signal
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from studio_accounts import AccountError, AccountStore
from studio_account_sessions import supervise
from studio_account_knowledge import start_knowledge_worker
from studio_account_runtime import drop_to_worker, ensure_binding, trusted_runtime
from studio_organization_channel import CHANNEL_ENV, OrganizationChannel
from studio_organization_directory import authenticate_directory
from studio_organization import publish_worker_marker

PRIVATE_RETENTION_PARENT_ENV_V1 = "KCODER_PRIVATE_RETENTION_PARENT_V1"
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
    if not isinstance(value, dict) or set(value) - {"protocol", "username", "password", "workspace", "mode", "retentionParentV1", "authentication", "logoutToken", "clientBinding", "resumeAuthority", "callbackPort"}:
        raise AccountError("Invalid authentication frame")
    authentication = value.get("authentication", "password")
    if value.get("protocol") != "kcoder-account-v1" or authentication not in ("password", "directory", "oidc", "oidcLogout", "oidcResume"):
        raise AccountError("Invalid authentication protocol")
    if authentication == "oidcLogout":
        if set(value) != {"protocol", "authentication", "logoutToken"} or not isinstance(value["logoutToken"], str):
            raise AccountError("Invalid OIDC logout frame")
        return value
    if not isinstance(value.get("username"), str) or "logoutToken" in value:
        raise AccountError("Invalid account authentication mode")
    if authentication in ("oidc", "oidcResume"):
        if "password" in value:
            raise AccountError("OIDC login does not accept an account password")
    elif not isinstance(value.get("password"), str):
        raise AccountError("Invalid authentication protocol")
    if authentication == "oidc":
        from studio_organization_oidc_resume import BINDING
        if "resumeAuthority" in value or ("clientBinding" in value and (not isinstance(value["clientBinding"], str) or not BINDING.fullmatch(value["clientBinding"]))):
            raise AccountError("Invalid OIDC original owner binding")
        if "callbackPort" in value and (type(value["callbackPort"]) is not int or not 1 <= value["callbackPort"] <= 65535):
            raise AccountError("Invalid OIDC native callback port")
    elif authentication == "oidcResume":
        from studio_organization_oidc_resume import reference
        if "clientBinding" in value:
            raise AccountError("Invalid OIDC resume owner binding")
        reference(value.get("resumeAuthority"))
    elif "clientBinding" in value or "resumeAuthority" in value or "callbackPort" in value:
        raise AccountError("Invalid account authority fields")
    if value.get("mode", "runtime") not in ("runtime", "admin"):
        raise AccountError("Invalid connection mode")
    if "retentionParentV1" in value and not isinstance(value["retentionParentV1"], bool):
        raise AccountError("Invalid private parent launch mode")
    if value.get("mode", "runtime") != "runtime" and value.get("retentionParentV1", False):
        raise AccountError("Private parent launch mode requires runtime")
    workspace = value.get("workspace")
    if workspace is not None and (not isinstance(workspace, str) or len(workspace) > 2048 or not os.path.isabs(workspace) or "\0" in workspace):
        raise AccountError("Invalid workspace")
    return value


def main():
    global identity_verified
    # An ambient declaration is never authentication or worker configuration.
    os.environ.pop(PRIVATE_RETENTION_PARENT_ENV_V1, None)
    os.environ.pop(CHANNEL_ENV, None)
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
    if login.get("authentication") == "oidcLogout":
        from studio_organization_oidc_logout import logout
        result = logout(store, login["logoutToken"])
        signal.alarm(0)
        reply({"protocol": "kcoder-account-v1", "logoutAccepted": True, "result": result})
        return
    private_resume = None
    if login.get("authentication") == "oidcResume":
        from studio_organization_oidc_resume import resume_identity
        identity = resume_identity(store, login["username"], login["resumeAuthority"])
        private_resume = login["resumeAuthority"]
    elif login.get("authentication") == "oidc":
        from studio_organization_oidc import LOGIN_TTL, OidcLogin
        signal.alarm(LOGIN_TTL + 45)
        flow = OidcLogin(store, login["username"], login.get("callbackPort"))
        try:
            reply(flow.challenge())
            identity = flow.complete(read_frame())
        finally:
            flow.close()
        signal.alarm(20)
    else:
        authenticate = authenticate_directory if login.get("authentication") == "directory" else lambda account_store, name, password: account_store.authenticate(name, password)
        identity = authenticate(store, login["username"], login["password"])
    identity_verified = True
    login.pop("password", None)
    if login.get("mode") == "admin":
        request = read_frame(4 * 1024 * 1024)
        if identity["role"] != "admin" and not (isinstance(request, dict) and request.get("operation") in ("organization.self", "organization.export")):
            raise AccountError("Account administrator role required")
        if isinstance(request, dict) and request.get("operation") == "organization.budget.initialize":
            if set(request) != {"operation"} or identity["role"] != "admin":
                raise AccountError("Account administrator role required")
            from studio_organization_budget import initialize as initialize_budget
            result = initialize_budget(store, runtime, actor=identity)
        elif isinstance(request, dict) and request.get("operation") == "organization.budget.inspect":
            if set(request) != {"operation", "expectedRevision", "after"} or identity["role"] != "admin":
                raise AccountError("Invalid organization budget inspection")
            from studio_organization_budget import inspect as inspect_budget
            result = inspect_budget(store, runtime, actor=identity,
                                    expected_revision=request["expectedRevision"], after=request["after"])
        else:
            result = store.administer(identity, request)
            if isinstance(request, dict) and request.get("operation") == "organization.inspect":
                result["executionServices"] = {"budgetInspectionV1": True, "budgetInitializationV1": True}
        signal.alarm(0)
        reply({"protocol": "kcoder-account-v1", "authenticated": True,
               "principalId": identity["id"], "username": identity["username"],
               "role": identity["role"], "result": result})
        return
    binding = ensure_binding(store, identity, args.homes_directory)
    policy_channel = OrganizationChannel(store, identity, runtime=runtime)
    if policy_channel.snapshot is not None:
        from studio_organization_workspace import WorkspaceBudgetBinding
        candidate = login.get("workspace") or binding["home"] + "/workspace"
        try:
            policy_channel.workspace_resource = WorkspaceBudgetBinding(binding, identity, candidate)
        except (OSError, AccountError):
            # Existing launch/fallback behavior remains intact; inference cannot
            # obtain a budget from an unverified or substituted directory.
            policy_channel.workspace_resource = None
    if login.get("authentication") == "oidc":
        import secrets
        from studio_organization_oidc_resume import OidcResumeAuthority
        policy_channel.resume_authority = OidcResumeAuthority(store, identity, login.get("clientBinding") or secrets.token_urlsafe(32))
        private_resume = policy_channel.resume_authority.reference
    if policy_channel.snapshot is not None:
        publish_worker_marker(binding, identity["id"], policy_channel.snapshot["organizationId"])
    signal.alarm(0)
    start_knowledge_worker(store, identity, binding, runtime)
    def start_runtime():
        environment = drop_to_worker(binding, identity)
        organization_fd = policy_channel.child_fd()
        if organization_fd is not None:
            environment[CHANNEL_ENV] = str(organization_fd)
            # Revalidate the actual dropped worker against its original root
            # owner immediately before publishing authentication or executing.
            channel = policy_channel.child
            channel.settimeout(6)
            channel.send(b'{"operation":"inspect"}')
            confirmed = json.loads(channel.recv(8192))
            if not confirmed.get("ok") or confirmed["result"].get("principalId") != identity["id"] or confirmed["result"].get("identityRevision") != identity["revision"] or confirmed["result"].get("workerUid") != os.geteuid():
                raise AccountError("Account authority changed before runtime startup")
            channel.settimeout(None)
        # Only this authenticated app-server exec receives the OS-parent fact.
        # Do not modify the shared worker/Wiki environment constructor.
        parent = {"version": 1, "mode": "verifiedAccount", "principalId": identity["id"], "uid": os.geteuid()}
        environment[PRIVATE_RETENTION_PARENT_ENV_V1] = "v1." + base64.urlsafe_b64encode(json.dumps(parent, separators=(",", ":")).encode()).decode().rstrip("=")
        environment["KCODER_WIKI_WORKER_MANAGED"] = "1"
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
                    "role": identity["role"], "uid": os.geteuid(), "runtimePid": os.getpid()}
        if private_resume is not None:
            response["privateOidcResume"] = private_resume
        reply(response)
        close_limit = min(os.sysconf("SC_OPEN_MAX"), 1048576)
        if organization_fd is None:
            os.closerange(3, close_limit)
        else:
            os.closerange(3, organization_fd)
            os.closerange(organization_fd + 1, close_limit)
        runtime_args = [runtime, "--cwd", workspace, "app-server"]
        if login.get("retentionParentV1", False):
            # Root-owned account launcher facts, after verified identity and UID drop.
            runtime_args.extend(["--retention-parent-v1", "account",
                                 "--retention-account-principal-id", identity["id"],
                                 "--retention-account-uid", str(os.geteuid())])
        os.execve(runtime, runtime_args, environment)
    code = supervise(store, identity, start_runtime, policy_channel=policy_channel)
    raise SystemExit(max(0, code) if code >= 0 else 1)



if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never include input, provider details, filesystem paths or exception values here.
        reply({"protocol": "kcoder-account-v1", "authenticated": False,
               "errorCode": "runtime_start_failed" if identity_verified else "authentication_failed",
               "error": "Account authentication or isolated startup failed"})
        sys.exit(1)
