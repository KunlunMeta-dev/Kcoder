"""Root policy routing to the original Rust NativeBudgetStore, never a second ledger."""
import hashlib
import json
import os
import subprocess
import selectors
import time

from studio_account_files import AccountError, locked, read_private_json, write_private_json
from studio_account_runtime import trusted_runtime
from studio_organization import OrganizationStore, identifier
from studio_organization_execution import LIMIT_FIELDS


class BudgetAdmissionError(AccountError):
    def __init__(self, code):
        self.code = code if code in {"BUDGET_BUSY", "BUDGET_EXHAUSTED", "BUDGET_POLICY_STALE", "BUDGET_OPERATION_CONFLICT"} else "ORGANIZATION_BUDGET_UNAVAILABLE"
        super().__init__(self.code)


def _run(runtime, envelope):
    runtime = trusted_runtime(runtime)
    data = json.dumps(envelope, separators=(",", ":")).encode()
    if len(data) > 128 * 1024:
        raise AccountError("Organization budget request is too large")
    process = subprocess.Popen([runtime, "--internal-organization-budget-v1"], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True,
                               env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
    try:
        deadline = time.monotonic() + 3
        output = bytearray()
        written = 0
        output_closed = False
        os.set_blocking(process.stdin.fileno(), False)
        os.set_blocking(process.stdout.fileno(), False)
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            selector.register(process.stdin, selectors.EVENT_WRITE)
            while not output_closed or not process.stdin.closed:
                remaining = deadline - time.monotonic()
                ready = selector.select(max(0, remaining))
                if remaining <= 0 or not ready:
                    raise AccountError("Organization budget outcome is unknown")
                for key, _ in ready:
                    if key.fileobj is process.stdin:
                        written += os.write(process.stdin.fileno(), data[written:written + 8192])
                        if written == len(data):
                            selector.unregister(process.stdin)
                            process.stdin.close()
                    else:
                        chunk = os.read(process.stdout.fileno(), min(8192, 128 * 1024 - len(output) + 1))
                        if not chunk:
                            selector.unregister(process.stdout)
                            output_closed = True
                        elif len(output) + len(chunk) > 128 * 1024:
                            raise AccountError("Organization budget response is too large")
                        else:
                            output.extend(chunk)
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
        if process.returncode != 0:
            raise AccountError("Organization budget outcome is unknown")
        response = json.loads(output)
        if not isinstance(response, dict) or response.get("ok") is not True or "result" not in response:
            raise BudgetAdmissionError(response.get("error") if isinstance(response, dict) else None)
        return response["result"]
    except (subprocess.TimeoutExpired, ValueError):
        raise AccountError("Organization budget outcome is unknown") from None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        if not process.stdin.closed:
            process.stdin.close()
        process.stdout.close()


def _owner(accounts, policy):
    instance = accounts["instance"]
    return {"accountId": "organization-budget-service:" + instance, "targetId": "organization-budget-target:" + instance,
            "workspaceId": None, "identityGeneration": "organization-budget:" + instance,
            "targetRevision": "organization-budget-v1", "organizationId": policy["id"]}


def _policies(execution, organization, member, workspace, root_operation):
    expected = {"organization": organization, "account": member, "workspace": workspace, "task": root_operation}
    policies = [item for item in execution["budgetPolicies"] if expected.get(item["scope"]["kind"]) == item["scope"]["id"]]
    if not policies or len(policies) > 16 or not any(item["scope"]["kind"] == "organization" for item in policies):
        raise AccountError("Current shared organization budget required")
    return policies


def initialize(store, runtime, actor=None):
    if os.geteuid() != 0:
        raise AccountError("Local root operator required")
    organization = OrganizationStore(store)
    with locked(store.lock):
        accounts, policy = store._load(), organization._load()
        current = organization._administrator(accounts, actor)
        if current is not None:
            organization._require_member(policy, current, actor)
        execution = policy.get("executionPolicy")
        if execution is None or not execution["budgetPolicies"]:
            raise AccountError("Explicit organization budgets required")
        marker = store.root / "organization-budget-binding.json"
        try:
            binding = read_private_json(marker)
        except FileNotFoundError:
            if os.path.lexists(store.root / "organization-budget"):
                raise AccountError("Existing organization budget requires explicit recovery")
            binding = {"version": 1, "instance": accounts["instance"], "organizationId": policy["id"], "phase": "preparing", "directoryIdentity": None}
            write_private_json(marker, binding, replace=False)
            action = "create"
        else:
            _verify_binding(store, accounts, policy, binding)
            action = "initialize"
        result = _run(runtime, {"version": 1, "root": str(store.root), "owner": _owner(accounts, policy),
                               "memberId": "organization-budget-service", "workspaceId": "initialization",
                               "policyRevision": policy["revision"], "policies": _policies(execution, policy["id"], "organization-budget-service", "initialization", "initialization"),
                               "action": {"kind": action}})
        info = os.stat(store.root / "organization-budget", follow_symlinks=False)
        binding.update(phase="ready", directoryIdentity=[info.st_dev, info.st_ino])
        write_private_json(marker, binding)
        organization._event(policy, current, "budget-initialize", policy["id"], "allow", "organization-budget-initialize")
        return result


def _verify_binding(store, accounts, policy, binding):
    import stat
    if not isinstance(binding, dict) or set(binding) != {"version", "instance", "organizationId", "phase", "directoryIdentity"} or type(binding["version"]) is not int or binding["version"] != 1 or binding["instance"] != accounts["instance"] or binding["organizationId"] != policy["id"] or binding["phase"] not in {"preparing", "ready"}:
        raise AccountError("Organization budget binding changed")
    info = os.stat(store.root / "organization-budget", follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise AccountError("Organization budget directory is unsafe")
    if binding["phase"] == "ready" and binding["directoryIdentity"] != [info.st_dev, info.st_ino]:
        raise AccountError("Organization budget directory changed")


def inspect(store, runtime, actor=None, *, expected_revision, after=None):
    """Read ten original journal windows without installing or repairing policy."""
    if os.geteuid() != 0:
        raise AccountError("Original organization budget host required")
    if type(expected_revision) is not int or expected_revision < 1 or (after is not None and (type(after) is not int or not 0 <= after <= 128)):
        raise AccountError("Invalid organization budget inspection")
    organization = OrganizationStore(store)
    with locked(store.lock):
        accounts, policy = store._load(), organization._load()
        current = organization._administrator(accounts, actor)
        if current is not None:
            organization._require_member(policy, current, actor)
        if expected_revision != policy["revision"]:
            raise AccountError("Organization policy changed; reload before inspecting")
        configured = (policy.get("executionPolicy") or {}).get("budgetPolicies", [])
        offset = after or 0
        if offset > len(configured):
            raise AccountError("Invalid organization budget page")
        selected = configured[offset:offset + 10]
        result = {"version": 1, "organizationId": policy["id"], "policyRevision": policy["revision"],
                  "status": "not_configured" if not configured else "uninitialized",
                  "items": [{"configured": row, "observation": None, "current": False} for row in selected],
                  "nextAfter": offset + len(selected) if offset + len(selected) < len(configured) else None}
        try:
            binding = read_private_json(store.root / "organization-budget-binding.json")
        except FileNotFoundError:
            if os.path.lexists(store.root / "organization-budget"):
                raise AccountError("Existing organization budget requires explicit recovery")
            return result
        if not isinstance(binding, dict):
            raise AccountError("Organization budget binding changed")
        if type(binding.get("version")) is not int:
            raise AccountError("Organization budget binding changed")
        if binding.get("phase") == "preparing" and not os.path.lexists(store.root / "organization-budget"):
            expected = {"version": 1, "instance": accounts["instance"], "organizationId": policy["id"],
                        "phase": "preparing", "directoryIdentity": None}
            if binding != expected:
                raise AccountError("Organization budget binding changed")
            result["status"] = "preparing"
            return result
        _verify_binding(store, accounts, policy, binding)
        result["status"] = binding["phase"]
        if binding["phase"] != "ready" or not selected:
            return result
        response = _run(runtime, {"version": 1, "root": str(store.root), "owner": _owner(accounts, policy),
            "memberId": "organization-budget-service", "workspaceId": "inspection",
            "policyRevision": policy["revision"], "policies": selected, "action": {"kind": "inspect"}})
        observations = response.get("observations") if isinstance(response, dict) else None
        _verify_binding(store, accounts, policy, binding)
        if not isinstance(observations, list) or len(observations) != len(selected):
            raise AccountError("Organization budget inspection is unavailable")
        result["items"] = []
        for definition, observed in zip(selected, observations):
            expected = {"id": definition["id"], "version": policy["revision"],
                        "revision": "organization-policy-" + str(policy["revision"]),
                        "scope": definition["scope"], "window": definition["window"]}
            observed_limits = observed.get("limits") if isinstance(observed, dict) else None
            limits_match = (isinstance(observed_limits, dict) and not set(observed_limits) - LIMIT_FIELDS
                            and {key: value for key, value in observed_limits.items() if value is not None} == definition["limits"])
            matches = (isinstance(observed, dict) and observed.get("policy") == expected
                       and limits_match and observed.get("currency") == definition["currency"])
            result["items"].append({"configured": definition, "observation": observed, "current": matches})
        return result


def request(store, identity, runtime, workspace_resource, frame, cache=None):
    if os.geteuid() != 0 or not runtime or not workspace_resource:
        raise AccountError("Original organization budget host required")
    if not isinstance(frame, dict) or set(frame) != {"operation", "rootOperationId", "action"} or frame["operation"] != "budget.request":
        raise AccountError("Invalid organization budget request")
    action = frame["action"]
    root_operation = identifier(frame["rootOperationId"])
    if not isinstance(action, dict) or action.get("kind") not in {"reserve", "dispatch", "read", "observe", "check", "calls_closed"}:
        raise AccountError("Invalid organization budget action")
    organization = OrganizationStore(store)
    with locked(store.lock):
        accounts, policy = store._load(), organization._load()
        current = organization._actor(accounts, identity)
        if current is None:
            raise AccountError("Actual organization member required")
        organization._require_member(policy, current, identity)
        if policy["resources"].get(workspace_resource, {}).get("kind") != "workspace" or (action["kind"] != "observe" and not organization._allowed(policy, current, "use", workspace_resource, None)):
            raise AccountError("Organization workspace permission required")
        execution = policy.get("executionPolicy")
        if execution is None or not execution["budgetPolicies"]:
            raise AccountError("Explicit organization budgets required")
        binding = read_private_json(store.root / "organization-budget-binding.json")
        _verify_binding(store, accounts, policy, binding)
        if binding["phase"] != "ready":
            raise AccountError("Organization budget initialization is unconfirmed")
        # A member's public operation ID never collides with another member's original call.
        action = dict(action)
        if action.get("kind") == "reserve" and (not isinstance(action.get("task"), dict) or action["task"].get("rootOperationId") != root_operation):
            raise AccountError("Original budget operation mismatch")
        raw_id = identifier(action.get("reservation_id"))
        qualify = lambda value: "org-" + hashlib.sha256((current["id"] + "\0" + identifier(value)).encode()).hexdigest()
        action["reservation_id"] = qualify(raw_id)
        if action.get("kind") == "reserve" and action["task"].get("parentReservationId") is not None:
            action["task"] = dict(action["task"])
            action["task"]["parentReservationId"] = qualify(action["task"]["parentReservationId"])
        data_path = store.root / "organization-budget/ledger.json"
        info = os.stat(data_path, follow_symlinks=False)
        import stat
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
            raise AccountError("Organization budget ledger is unsafe")
        stamp = (policy["revision"], info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        key = (current["id"], workspace_resource, root_operation, action["reservation_id"])
        applicable = _policies(execution, policy["id"], current["id"], workspace_resource, root_operation)
        if action["kind"] != "observe":
            now_ms = int(time.time() * 1000)
            if any(not item["window"]["startsAtMs"] <= now_ms < item["window"]["endsAtMs"] for item in applicable):
                raise BudgetAdmissionError("BUDGET_POLICY_STALE")
        if action["kind"] == "check" and cache is not None and cache.get(key, (None,))[0] == stamp:
            result = cache[key][1]
        else:
            result = _run(runtime, {"version": 1, "root": str(store.root), "owner": _owner(accounts, policy),
                                   "memberId": current["id"], "workspaceId": workspace_resource,
                                   "policyRevision": policy["revision"], "policies": applicable, "action": action})
            after = os.stat(data_path, follow_symlinks=False)
            if action["kind"] == "check" and cache is not None and stamp == (policy["revision"], after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                if len(cache) >= 256:
                    cache.clear()
                cache[key] = (stamp, result)
        if result is not None and result.get("task", {}).get("rootOperationId") != root_operation:
            raise AccountError("Original budget operation mismatch")
        # The root channel does not disclose other members' observations or global totals.
        return {"organizationId": policy["id"], "principalId": current["id"], "policyRevision": policy["revision"], "reservation": result}
