"""Bounded root-owned execution policy; labels never establish data location."""

import copy
import hashlib
import json
import re
import time
from urllib.parse import urlsplit

from studio_account_files import AccountError

MAX_RULES = 128
MAX_POLICIES = 128
MAX_INTEGER = 9_007_199_254_740_991
LIMIT_FIELDS = {"tokens", "modelCalls", "runMillis", "costMicros", "concurrentTasks", "concurrentCalls"}


def reference(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}", value) or ".." in value:
        raise AccountError("Invalid execution policy reference")
    return value


def exact_name(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 256 or value != value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise AccountError("Invalid exact model identity")
    return value


def endpoint_origin(value):
    if not isinstance(value, str) or len(value) > 2048 or any(c.isspace() or ord(c) < 32 for c in value) or "\\" in value:
        raise AccountError("Invalid model endpoint origin")
    try:
        parsed = urlsplit(value)
        port = parsed.port
        host = parsed.hostname
    except ValueError:
        raise AccountError("Invalid model endpoint origin") from None
    if parsed.scheme not in {"https", "http"} or not host or parsed.username is not None or parsed.password is not None or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise AccountError("Exact HTTP origin without credentials or path required")
    try:
        host = host.encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise AccountError("Invalid model endpoint origin") from None
    if host.endswith(".") or "%" in host or not re.fullmatch(r"[a-z0-9.:-]+", host):
        raise AccountError("Invalid model endpoint origin")
    host = "[" + host + "]" if ":" in host else host
    suffix = "" if port is None or (parsed.scheme, port) in {("https", 443), ("http", 80)} else ":" + str(port)
    return parsed.scheme + "://" + host + suffix


def _subjects(value, accounts):
    if not isinstance(value, list) or not value or len(value) > 1000 or any(not isinstance(item, str) for item in value) or len(value) != len(set(value)):
        raise AccountError("Explicit execution policy members required")
    known = {item["id"] for item in accounts["accounts"]}
    if any(not isinstance(item, str) or item not in known for item in value):
        raise AccountError("Execution policy requires existing members")
    return list(value)


def validate(value, accounts):
    if not isinstance(value, dict) or set(value) != {"version", "modelRules", "budgetPolicies"} or type(value["version"]) is not int or value["version"] != 1:
        raise AccountError("Unsupported organization execution policy")
    if not isinstance(value["modelRules"], list) or len(value["modelRules"]) > MAX_RULES or not isinstance(value["budgetPolicies"], list) or len(value["budgetPolicies"]) > MAX_POLICIES:
        raise AccountError("Organization execution policy capacity exceeded")
    result = {"version": 1, "modelRules": [], "budgetPolicies": []}
    seen = set()
    for rule in value["modelRules"]:
        if not isinstance(rule, dict) or set(rule) != {"id", "members", "workspaceResourceIds", "provider", "model", "endpointOrigin", "configurationRevision", "enabled"}:
            raise AccountError("Invalid organization model rule")
        rule_id = reference(rule["id"])
        if rule_id in seen or type(rule["enabled"]) is not bool:
            raise AccountError("Duplicate or invalid organization model rule")
        seen.add(rule_id)
        workspaces = rule["workspaceResourceIds"]
        if not isinstance(workspaces, list) or not workspaces or len(workspaces) > 256 or any(not isinstance(item, str) for item in workspaces) or len(workspaces) != len(set(workspaces)):
            raise AccountError("Explicit workspace resources required")
        for workspace in workspaces:
            reference(workspace)
        revision = rule["configurationRevision"]
        if revision is not None and (not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{64}", revision)):
            raise AccountError("Invalid exact model configuration revision")
        provider, model = exact_name(rule["provider"]), exact_name(rule["model"])
        if "::" in provider:
            raise AccountError("Invalid exact provider identity")
        result["modelRules"].append({**copy.deepcopy(rule), "provider": provider, "model": model,
                                     "members": _subjects(rule["members"], accounts), "endpointOrigin": endpoint_origin(rule["endpointOrigin"])})
    seen = set()
    scopes = set()
    for policy in value["budgetPolicies"]:
        if not isinstance(policy, dict) or set(policy) != {"id", "scope", "window", "limits", "currency"}:
            raise AccountError("Invalid organization budget policy")
        policy_id = reference(policy["id"])
        if policy_id in seen:
            raise AccountError("Duplicate organization budget policy")
        seen.add(policy_id)
        scope, window, limits = policy["scope"], policy["window"], policy["limits"]
        if not isinstance(scope, dict) or set(scope) != {"kind", "id"} or scope["kind"] not in {"organization", "account", "workspace", "task"}:
            raise AccountError("Invalid organization budget scope")
        reference(scope["id"])
        scope_key = (scope["kind"], scope["id"])
        if scope_key in scopes:
            raise AccountError("Duplicate organization budget scope")
        scopes.add(scope_key)
        if scope["kind"] == "account" and scope["id"] not in {item["id"] for item in accounts["accounts"]}:
            raise AccountError("Budget account is unavailable")
        if not isinstance(window, dict) or set(window) != {"id", "startsAtMs", "endsAtMs"}:
            raise AccountError("Explicit budget window required")
        reference(window["id"])
        if any(type(window[k]) is not int or not 0 <= window[k] <= MAX_INTEGER for k in ("startsAtMs", "endsAtMs")) or window["startsAtMs"] >= window["endsAtMs"]:
            raise AccountError("Invalid budget window")
        if not isinstance(limits, dict) or not limits or set(limits) - LIMIT_FIELDS or any(type(v) is not int or not 0 <= v <= MAX_INTEGER for v in limits.values()):
            raise AccountError("Invalid budget limits")
        if any(limits.get(k, 0) > 2**32 - 1 for k in ("concurrentTasks", "concurrentCalls")):
            raise AccountError("Invalid concurrency limit")
        currency = policy["currency"]
        if currency is not None and (not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency)):
            raise AccountError("Explicit currency required")
        if "costMicros" in limits and currency is None:
            raise AccountError("Cost limit requires an explicit currency")
        result["budgetPolicies"].append(copy.deepcopy(policy))
    return result


def permits_model(execution, principal, workspace_resource, provider, model, origin, revision):
    origin = endpoint_origin(origin)
    return any(rule["enabled"] and principal in rule["members"] and workspace_resource in rule["workspaceResourceIds"]
               and rule["provider"] == provider and rule["model"] == model and rule["endpointOrigin"] == origin
               and (rule["configurationRevision"] is None or rule["configurationRevision"] == revision)
               for rule in execution["modelRules"])


def model_resource_id(provider, model, origin, revision):
    # JSON tuple encoding is versioned and shared with the Native adapter.
    encoded = json.dumps(["organization-model-v1", exact_name(provider), exact_name(model), endpoint_origin(origin), revision],
                         ensure_ascii=False, separators=(",", ":")).encode()
    return "model:" + hashlib.sha256(encoded).hexdigest()


def validate_transition(previous, current, *, explicit_limit_adjustment=False):
    """Configuration edits cannot recreate a live budget family or erase a hold."""
    if previous is None:
        return
    next_by_id = {item["id"]: item for item in current["budgetPolicies"]}
    for old in previous["budgetPolicies"]:
        new = next_by_id.get(old["id"])
        if new is None or new["scope"] != old["scope"] or new["currency"] != old["currency"]:
            raise AccountError("Existing budget family cannot be removed or rebound")
        if new["window"] == old["window"]:
            for key, value in old["limits"].items():
                if key not in new["limits"]:
                    raise AccountError("Existing budget dimension cannot be removed")
                if new["limits"][key] > value and not explicit_limit_adjustment:
                    raise AccountError("Restored budget window cannot be relaxed")
        elif new["window"]["startsAtMs"] < old["window"]["endsAtMs"] or int(time.time() * 1000) < old["window"]["endsAtMs"]:
            raise AccountError("Budget window cannot overlap, move backward or end early")
