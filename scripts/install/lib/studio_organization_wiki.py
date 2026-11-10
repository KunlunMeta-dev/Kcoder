"""Root-owned Wiki job scope tickets; metadata is not a caller authorization."""
import hashlib
import json
from pathlib import Path
import struct
import socket
import uuid

from studio_account_files import AccountError, locked, read_private_json, trusted_directory, write_private_json
from studio_organization import identifier
from studio_organization_workspace import WorkspaceBudgetBinding


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()).hexdigest()


def native_id(label, value):
    return "native-" + hashlib.sha256(b"kcoder-native-integrations-v1\0" + label.encode() + b"\0" + value.encode()).hexdigest()


def directory(channel):
    return trusted_directory(channel.store.root / "organization-wiki-jobs")


def path_for(channel, job_id):
    return directory(channel) / (digest([channel.identity["id"], identifier(job_id)]) + ".json")


def require_peer(channel, ancillary):
    actual=[struct.unpack("3i", data) for level, kind, data in ancillary
            if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(data) == struct.calcsize("3i")]
    if actual != [(channel.runtime_pid, channel.snapshot["workerUid"], channel.snapshot["workerGid"])]:
        raise AccountError("Original Wiki runtime credentials required")


def job_fields(value):
    expected={"libraryId","jobId","sourceId","sourceRevision","recipeKey"}
    if not isinstance(value,dict) or set(value)!=expected:
        raise AccountError("Fixed original Wiki job required")
    return {key:identifier(value[key]) for key in sorted(expected)}


def verify_scope(channel, scope, workspace):
    if not isinstance(scope,dict):
        raise AccountError("Original Wiki scope required")
    workspace.verify(channel.identity)
    profile="unix:%s:%s" % workspace.identities[0]
    expected={"accountId":native_id("account-profile",profile), "targetId":native_id("native-target",profile),
        "workspaceId":workspace.resource_id,"organizationId":channel.snapshot["organizationId"]}
    if any(scope.get(key)!=value for key,value in expected.items()):
        raise AccountError("Original Wiki scope changed")
    for key in ("identityGeneration","targetRevision"):
        identifier(scope.get(key))
    return expected


def resource_id(scope):
    owner=[scope["accountId"],scope["targetId"],scope["workspaceId"],scope["organizationId"]]
    value=["native-knowledge-resource-v1","knowledge",*owner,"current-target"]
    return "knowledge:"+hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(",",":")).encode()).hexdigest()


def authorize(channel, scope):
    channel.policy.inspect_session(channel.identity)
    for action in ("read","write"):
        if not channel.policy.evaluate(channel.identity,action,resource_id(scope),str(uuid.uuid4()))["allowed"]:
            raise AccountError("Wiki resource permission revoked")


def load(channel, job_id):
    record=read_private_json(path_for(channel,job_id))
    if (record.get("version")!=1 or record.get("principalId")!=channel.identity["id"]
        or record.get("identityRevision")!=channel.identity["revision"]):
        raise AccountError("Original Wiki job identity revoked")
    metadata={key:value for key,value in record.items() if key not in
        {"receiptId","sha256","claims","currentClaimFingerprint"}}
    if digest(metadata)!=record.get("sha256"):
        raise AccountError("Original Wiki job ticket integrity changed")
    return record


def workspace_for(channel, record):
    workspace=WorkspaceBudgetBinding(channel.worker_binding,channel.identity,Path(record["workspacePath"]))
    if workspace.identities!=[tuple(value) for value in record["directoryIdentities"]]:
        workspace.close()
        raise AccountError("Original Wiki directory changed")
    verify_scope(channel,record["scope"],workspace)
    return workspace


def descriptor(record):
    return {"version":1,"receiptId":record["receiptId"],"sha256":record["sha256"],
        "scope":record["scope"],"workspacePath":record["workspacePath"],"job":record["job"],
        "currentClaimFingerprint":record.get("currentClaimFingerprint")}


def dispatch(channel, request, ancillary):
    require_peer(channel,ancillary)
    operation=request.get("operation")
    if operation=="wiki.job.bind":
        if channel.purpose!="interactive" or not isinstance(channel.workspace_resource,WorkspaceBudgetBinding):
            raise AccountError("Original enqueue authority required")
        if set(request)!={"operation","scope","job"}:
            raise AccountError("Unexpected Wiki binding fields")
        job=job_fields(request["job"]);scope=request["scope"]
        verify_scope(channel,scope,channel.workspace_resource);authorize(channel,scope)
        metadata={"version":1,"principalId":channel.identity["id"],"identityRevision":channel.identity["revision"],
            "scope":scope,"job":job,"workspacePath":str(channel.workspace_resource.paths[1]),
            "directoryIdentities":[list(value) for value in channel.workspace_resource.identities]}
        with locked(directory(channel)/"wiki-jobs.lock"):
            target=path_for(channel,job["jobId"])
            if target.exists():
                old=load(channel,job["jobId"])
                if any(old.get(key)!=value for key,value in metadata.items()):
                    raise AccountError("Original Wiki binding immutable")
                return descriptor(old)
            record={**metadata,"receiptId":"wiki-job-"+uuid.uuid4().hex,"sha256":digest(metadata),"claims":{}}
            write_private_json(target,record,replace=False)
        return descriptor(record)
    if channel.purpose!="wiki_worker":
        raise AccountError("Owned Wiki worker purpose required")
    if operation=="wiki.jobs":
        if set(request)!={"operation"}:raise AccountError("Unexpected Wiki list fields")
        records=[]
        for path in sorted(directory(channel).glob("*.json")):
            record=read_private_json(path)
            if record.get("principalId")==channel.identity["id"] and record.get("identityRevision")==channel.identity["revision"]:
                records.append(descriptor(record))
        if len(records)>512:raise AccountError("Wiki job ticket ceiling exceeded")
        return {"items":records}
    if operation=="wiki.job.preflight":
        if set(request)!={"operation","job"}:raise AccountError("Unexpected Wiki preflight fields")
        job=job_fields(request["job"]);record=load(channel,job["jobId"])
        if record["job"]!=job:raise AccountError("Original Wiki job changed")
        workspace=workspace_for(channel,record)
        try:
            authorize(channel,record["scope"])
            return descriptor(record)
        finally:workspace.close()
    if set(request)!={"operation","job","claimFingerprint"}:
        raise AccountError("Unexpected Wiki worker fields")
    job=job_fields(request["job"]);claim=request["claimFingerprint"]
    if not isinstance(claim,str) or len(claim)!=64 or any(c not in "0123456789abcdef" for c in claim):
        raise AccountError("Original Wiki claim required")
    with locked(directory(channel)/"wiki-jobs.lock"):
        record=load(channel,job["jobId"])
        if record["job"]!=job:raise AccountError("Original Wiki job changed")
        with_workspace=workspace_for(channel,record)
        try:
            if operation=="wiki.job.open":
                authorize(channel,record["scope"])
                existing=record["claims"].get(claim)
                if existing is not None and existing.get("runtimePid")!=channel.runtime_pid:
                    raise AccountError("Original Wiki claim owner changed")
                if claim not in record["claims"] and len(record["claims"])>=64:
                    raise AccountError("Wiki claim ticket ceiling exceeded")
                record["claims"][claim]={"runtimePid":channel.runtime_pid}
                record["currentClaimFingerprint"]=claim
                write_private_json(path_for(channel,job["jobId"]),record)
            elif operation=="wiki.job.current":
                if record["claims"].get(claim)!={"runtimePid":channel.runtime_pid}:
                    raise AccountError("Original Wiki claim not held")
                authorize(channel,record["scope"])
            elif operation=="wiki.job.observe":
                if record["claims"].get(claim)!={"runtimePid":channel.runtime_pid}:
                    raise AccountError("Original Wiki claim not held")
                # Only retained accounting; this grants no resource or model effect.
            else:
                raise AccountError("Unsupported Wiki worker operation")
            return descriptor(record)
        finally:
            with_workspace.close()
