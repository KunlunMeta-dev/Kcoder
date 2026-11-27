"""Resolve Wiki budget scope from its original root-owned worker claim."""
import re

from studio_account_files import AccountError
from studio_organization_wiki import authorize, directory, load, require_peer, workspace_for


def workspace_for_budget(channel, request, ancillary):
    require_peer(channel, ancillary)
    if channel.purpose != "wiki_worker":
        raise AccountError("Original Wiki worker purpose required")
    if (not isinstance(request, dict)
            or set(request) != {"operation", "rootOperationId", "action"}
            or request["operation"] != "budget.request"):
        raise AccountError("Original Wiki budget request required")
    operation = request["rootOperationId"]
    match = re.fullmatch(r"org-wiki-([0-9a-f]{64})", operation) if isinstance(operation, str) else None
    action = request["action"]
    if match is None or not isinstance(action, dict):
        raise AccountError("Original Wiki budget claim required")
    claim = match.group(1)
    # A read cannot initialize missing ticket storage. This is the same root
    # job-ticket directory created by explicit enqueue, not a second ledger.
    if not (channel.store.root / "organization-wiki-jobs").exists():
        raise AccountError("Original Wiki ticket is unavailable")
    # Cache only the locator, never permissions, directory authority or ticket
    # contents. Every observation reopens the original root record and checks it.
    locators = getattr(channel, "wiki_budget_claim_locators", None)
    if locators is None:
        locators = channel.wiki_budget_claim_locators = {}
    job_id = locators.get(claim)
    if job_id is None:
        paths = list(directory(channel).glob("*.json"))
        if len(paths) > 512:
            raise AccountError("Wiki budget ticket ceiling exceeded")
        from studio_account_files import read_private_json
        records = []
        for path in paths:
            value = read_private_json(path)
            if value.get("principalId") != channel.identity["id"]:
                continue
            record = load(channel, value.get("job", {}).get("jobId"))
            if record.get("claims", {}).get(claim, {}).get("runtimePid") == channel.runtime_pid:
                records.append(record)
        if len(records) != 1:
            raise AccountError("Original Wiki claim owner required")
        record = records[0]
        if len(locators) >= 256:
            locators.clear()
        locators[claim] = record["job"]["jobId"]
    else:
        record = load(channel, job_id)
    if record.get("claims", {}).get(claim, {}).get("runtimePid") != channel.runtime_pid:
        raise AccountError("Original Wiki claim owner changed")
    kind = action.get("kind")
    if kind not in {"reserve", "dispatch", "check", "read", "observe", "calls_closed"}:
        raise AccountError("Unsupported Wiki budget action")
    if kind in {"reserve", "dispatch", "check"}:
        if record.get("currentClaimFingerprint") != claim:
            raise AccountError("Original Wiki claim changed")
        authorize(channel, record["scope"])
    if kind == "reserve":
        task = action.get("task")
        if (not isinstance(task, dict) or task.get("rootOperationId") != operation
                or task.get("rootTask") != {"kind": "task", "id": record["job"]["jobId"], "revision": None}):
            raise AccountError("Original Wiki task binding required")
    # Old observations may settle only this authenticated worker's original
    # claim. They do not reauthorize a read, dispatch, or model request.
    return workspace_for(channel, record)
