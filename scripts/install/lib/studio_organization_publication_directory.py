"""Current-PDP publication discovery; root observes metadata, publishers read bodies."""
import array
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import time

from studio_account_files import AccountError, locked
from studio_account_runtime import validate_binding
from studio_accounts import public_identity
from studio_organization_workspace import WorkspaceBudgetBinding
from studio_organization_publications import PublicationRead, SharedPublicationError, _resource, _own_other_workspace


def encoded(value):return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
def digest(value):return hashlib.sha256(encoded(value)).hexdigest()
def native(domain, value):return "native-"+hashlib.sha256(b"kcoder-native-integrations-v1\0"+domain.encode()+b"\0"+value.encode()).hexdigest()
def namespace(owner, domain):return "integration-"+digest(["native-domain-v1", owner, domain])


def sealed(value):
    raw = encoded(value)
    if len(raw)>4*1024*1024:raise AccountError("Directory metadata capacity exceeded")
    descriptor = os.memfd_create("kcoder-directory-metadata", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        os.fchmod(descriptor,0o600)
        view=memoryview(raw)
        while view:view=view[os.write(descriptor, view):]
        os.lseek(descriptor, 0, os.SEEK_SET)
        fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL)
        return descriptor, len(raw), hashlib.sha256(raw).hexdigest()
    except BaseException:
        os.close(descriptor);raise


def fact(parent, name, uid, directory=False, volatile=False):
    try:descriptor=os.open(name, os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC, dir_fd=parent)
    except FileNotFoundError:return None
    try:
        value=os.fstat(descriptor)
        if value.st_uid!=uid or value.st_mode & 0o077 or (not directory and (not stat.S_ISREG(value.st_mode) or value.st_nlink!=1)) or (directory and not stat.S_ISDIR(value.st_mode)):
            raise AccountError("Directory source metadata is unsafe")
        identity=[value.st_dev,value.st_ino,stat.S_IMODE(value.st_mode),value.st_uid,value.st_nlink]
        if not directory:identity += [value.st_size] if volatile else [value.st_size,value.st_mtime_ns,value.st_ctime_ns]
        return identity
    finally:os.close(descriptor)


def source_metadata(binding, principal, organization, expected_owner=None):
    # Existing verified handles supply names and FileIDs only. No read/open of a
    # member DB, binding document, identity record or publication body occurs here.
    anchor=WorkspaceBudgetBinding(binding, principal, Path(binding["home"])/"workspace")
    try:
        profile,workspace=[os.fstat(handle) for handle in anchor.handles]
        profile_id=f"unix:{profile.st_dev}:{profile.st_ino}"
        workspace_id=f"unix:{workspace.st_dev}:{workspace.st_ino}"
        owner={"accountId":native("account-profile",profile_id),"targetId":native("native-target",profile_id),
               "workspaceId":native("native-workspace",profile_id+"\0"+workspace_id),"organizationId":organization}
        if expected_owner is not None:
            if (set(expected_owner)!={"accountId","targetId","workspaceId","organizationId"}
                    or any(expected_owner[key]!=owner[key] for key in ("accountId","targetId","organizationId"))
                    or not isinstance(expected_owner["workspaceId"],str)):
                raise AccountError("Directory publisher source owner changed")
            # This is a source locator, not a path or an authorization fact.
            # The actual publisher UID verifies the registered workspace FD.
            owner={key:expected_owner[key] for key in ("accountId","targetId","workspaceId","organizationId")}
        root=anchor.handles[0];name=namespace(owner,"knowledge");uid=binding["uid"]
        marker=fact(root,"."+name+".jsonl",uid);child=fact(root,name,uid,directory=True)
        if (marker is None)!=(child is None):raise AccountError("Directory source initialization is unconfirmed")
        facts=[anchor.identities,marker,child]
        if child is not None:
            descriptor=os.open(name,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root)
            try:
                facts += [fact(descriptor,leaf,uid,directory=leaf=="catalog.objects",volatile=leaf=="catalog.sqlite-shm")
                          for leaf in ("catalog-binding.json","catalog.lock","catalog.sqlite","catalog.sqlite-wal","catalog.sqlite-shm","catalog.objects")]
                if any(facts[index] is None for index in (3,4,5,8)):
                    raise AccountError("Directory source is missing")
            finally:os.close(descriptor)
        identity_owner={"accountId":owner["accountId"],"targetId":owner["targetId"],"workspaceId":None,"organizationId":None}
        identity_name=namespace(identity_owner,"identity")
        facts += [fact(root,"."+identity_name+".jsonl",uid),fact(root,identity_name,uid,directory=True)]
        registered=facts[-1] is not None
        if (facts[-2] is None)!= (not registered):raise AccountError("Directory native identity initialization is unconfirmed")
        if registered:
            descriptor=os.open(identity_name,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root)
            try:facts += [fact(descriptor,leaf,uid) for leaf in ("native-identity.jsonl","native-identity-head.jsonl","native-identity.lock")]
            finally:os.close(descriptor)
        anchor.verify(principal)
        return owner,digest(facts),child is not None,registered
    finally:anchor.close()


def current_directory(channel, reader_scope):
    snapshot=channel.policy.inspect_session(channel.identity)
    if snapshot is None or reader_scope.get("organizationId")!=snapshot["organizationId"]:
        raise AccountError("Directory caller organization changed")
    with locked(channel.store.lock):
        accounts=channel.store._load();policy=channel.policy._load()
        if policy["revision"]!=snapshot["policyRevision"]:raise SharedPublicationError("KNOWLEDGE_INVALID_CURSOR")
        records={record["id"]:record for record in accounts["accounts"]}
        approved={}
        for key,resource in policy["resources"].items():
            if not (resource["kind"]=="knowledge" and resource["visibility"]=="organization"
                    and channel.policy._allowed(policy,channel.identity,"read",key,None)):
                continue
            locator=resource.get("nativeKnowledgeSource")
            principal=resource["owner"];owner=None
            if locator is not None:
                channel.policy._validate_resource(resource,accounts,policy,require_source_binding=True)
                principal=locator["publisherPrincipalId"];owner=locator["publicationOwner"]
                if _resource(owner,locator["publicationId"])!=key:
                    raise AccountError("Directory source reference changed")
                if owner["organizationId"] is None and principal!=channel.identity["id"]:
                    # A private historical owner cannot become cross-member
                    # shared content merely because a policy record exists.
                    continue
            if principal==channel.identity["id"]:
                if locator is None:continue
                if not _own_other_workspace(owner,reader_scope):
                    if all(owner[field]==reader_scope.get(field) for field in ("accountId","targetId","workspaceId")):
                        continue
                    raise AccountError("Directory own source scope is unavailable")
            scope=None if owner is None else tuple(owner[field] for field in ("accountId","targetId","workspaceId","organizationId"))
            entry=approved.setdefault((principal,scope),{"owner":owner,"resources":[]})
            entry["resources"].append(key)
        groups=[];unbound=[]
        merged={}
        for (principal,_),entry in sorted(approved.items(),key=lambda item:repr(item[0])):
            resources=entry["resources"];expected_owner=entry["owner"]
            record=records.get(principal);member=policy["members"].get(principal);binding=accounts["bindings"].get(principal)
            if not record or record["disabled"] or not member or member["disabled"]:
                raise AccountError("Directory publisher authority unavailable")
            if binding is None:
                if expected_owner is not None:raise AccountError("Directory source binding unavailable")
                # A generic policy owner without a registered native endpoint is
                # not silently promoted to a publisher or allocated by a read.
                unbound.append([principal,record["revision"],sorted(resources),None]);continue
            if member.get("directory"):
                from studio_organization_directory import directory_current
                directory_current(member["directory"])
            if member.get("oidc"):
                from studio_organization_oidc_provider import oidc_subject
                if oidc_subject(channel.store,member["oidc"])!=member["oidc"]:
                    raise AccountError("Directory publisher enrollment changed")
            validate_binding(binding,principal)
            identity=public_identity(record)
            owner,stamp,initialized,registered=source_metadata(binding,identity,snapshot["organizationId"],expected_owner)
            if not registered:
                if expected_owner is not None:raise AccountError("Directory declared source has no native identity")
                if initialized:raise AccountError("Directory source has no native identity")
                # A policy administrator can own a resource without ever
                # registering a Native worker. Its metadata still fences the
                # directory; no read allocates authority or launches a worker.
                unbound.append([principal,record["revision"],sorted(resources),stamp]);continue
            group_key=(principal,tuple(owner[field] for field in ("accountId","targetId","workspaceId","organizationId")))
            if group_key in merged:
                merged[group_key]["resources"].extend(resources);continue
            group={"publisher":identity,"binding":copy.deepcopy(binding),"owner":owner,"resources":resources,
                   "stamp":stamp,"initialized":initialized}
            merged[group_key]=group
        for _,group in sorted(merged.items(),key=lambda item:repr(item[0])):
            principal=group["publisher"]["id"];owner=group["owner"];resources=sorted(set(group["resources"]))
            group["resources"]=resources
            group["handle"]=digest([snapshot,owner,principal,resources])
            groups.append(group)
    stamp=digest([snapshot,reader_scope,[(group["handle"],group["stamp"]) for group in groups],unbound])
    return snapshot,groups,stamp


class DirectoryRead(PublicationRead):
    def __init__(self, channel, request, state, group, mode):
        self.channel,self.request=channel,request
        self.directory_snapshot,self.groups,self.stat_fingerprint=state
        self.group,self.mode=group,mode
        self.result=self.body_fd=self.source_error=None
        self.failure=self.closed=False
        self.deadline=time.monotonic()+3
        self.snapshot,self.publisher,self.binding=self._state(initial=True)
        self.parent,self.child=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);self.parent.setblocking(False)

    def _state(self,initial=False,audit=True):
        if audit:
            snapshot,groups,stamp=current_directory(self.channel,self.request["readerScope"])
            if stamp!=self.stat_fingerprint:raise SharedPublicationError("KNOWLEDGE_INVALID_CURSOR")
            current=next((group for group in groups if group["handle"]==self.group["handle"]),None)
        else:
            snapshot=self.channel.policy.inspect_session(self.channel.identity)
            with locked(self.channel.store.lock):
                accounts=self.channel.store._load();policy=self.channel.policy._load()
                record=next((record for record in accounts["accounts"] if record["id"]==self.group["publisher"]["id"]),None)
                current=self.group if record and public_identity(record)==self.group["publisher"] and policy["revision"]==self.directory_snapshot["policyRevision"] else None
        if snapshot!=self.directory_snapshot or current is None:raise SharedPublicationError("KNOWLEDGE_INVALID_CURSOR")
        return snapshot,current["publisher"],current["binding"]

    def parent_started(self,runtime_pid=None):
        self.child.close()
        descriptor,size,sha=sealed(self.group["resources"])
        try:
            payload={"directory":True,"requestId":self.request["requestId"],"organizationId":self.snapshot["organizationId"],
                     "publisherPrincipalId":self.publisher["id"],"readerScope":self.request["readerScope"],"owner":self.group["owner"],
                     "mode":self.mode,"after":self.request.get("after"),"allowlistBytes":size,"allowlistSha256":sha,
                     "expectedSha256":self.request.get("expectedSha256")}
            raw=encoded(payload)
            if len(raw)>8192 or self.parent.sendmsg([raw],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array("i",[descriptor]))])!=len(raw):
                raise AccountError("Directory request incomplete")
        finally:os.close(descriptor)

    def _receive(self):
        if self.result is not None or self.source_error is not None:return
        from studio_organization_publications import SOURCE_ERRORS
        raw,ancillary,flags,_=self.parent.recvmsg(8192,socket.CMSG_SPACE(8*array.array("i").itemsize),socket.MSG_CMSG_CLOEXEC)
        descriptors=[]
        try:
            for level,kind,value in ancillary:
                if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:
                    numbers=array.array("i");numbers.frombytes(value[:len(value)-len(value)%numbers.itemsize]);descriptors.extend(numbers)
            if flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC) or not raw:raise AccountError("Directory response incomplete")
            response=json.loads(raw)
            if response.get("ok") is False and not descriptors and response.get("error") in SOURCE_ERRORS:
                self.source_error=response["error"];return
            metadata=response.get("result")
            if (response.get("ok") is not True or not isinstance(metadata,dict)
                    or len(descriptors)!=(1 if self.mode=="list" else 0)
                    or metadata.get("format")!="kcoder-shared-directory/1" or metadata.get("mode")!=self.mode
                    or metadata.get("owner")!=self.group["owner"] or metadata.get("requestId")!=self.request["requestId"]
                    or metadata.get("publisherUid")!=self.binding["uid"] or not 1<=metadata.get("bodyBytes",0)<=768*1024):
                raise AccountError("Directory response invalid")
            self.result=metadata
            if descriptors:self.body_fd=descriptors.pop()
        finally:
            for descriptor in descriptors:os.close(descriptor)


def inspect_directory(channel,request):
    if set(request)!={"operation","requestId","readerScope"}:raise AccountError("Invalid directory inspect request")
    state=current_directory(channel,request["readerScope"])
    groups=[];deadline=time.monotonic()+8;transition=None
    for group in state[1]:
        if time.monotonic()>=deadline:raise AccountError("Directory observation budget exceeded")
        metadata,descriptor=DirectoryRead(channel,request,state,group,"inspect").execute()
        if descriptor is not None:os.close(descriptor);raise AccountError("Directory inspect unexpectedly returned bytes")
        next_time=metadata["nextTransitionMs"]
        if next_time is not None:transition=next_time if transition is None else min(transition,next_time)
        metadata.pop("requestId",None)
        groups.append({"handle":group["handle"],"owner":group["owner"],"source":metadata})
    if current_directory(channel,request["readerScope"])[2]!=state[2] or transition is not None and int(time.time()*1000)>=transition:
        raise SharedPublicationError("KNOWLEDGE_INVALID_CURSOR")
    epoch=digest([state[2],groups])
    payload={"statFingerprint":state[2],"fingerprint":epoch,"groups":groups,"nextTransitionMs":transition}
    descriptor,size,sha=sealed(payload)
    return {"format":"kcoder-shared-directory-manifest/1","bodyBytes":size,"bodySha256":sha,"fingerprint":epoch,
            "policyRevision":state[0]["policyRevision"],"readerIdentityRevision":state[0]["identityRevision"]},descriptor


def read_directory(channel,request):
    fields={"operation","requestId","readerScope","handle","statFingerprint","after","expectedSha256"}
    if set(request)!=fields or request["operation"] not in ("sharedPublication.directory.list","sharedPublication.directory.verify"):
        raise AccountError("Invalid directory page request")
    state=current_directory(channel,request["readerScope"])
    if state[2]!=request["statFingerprint"]:raise SharedPublicationError("KNOWLEDGE_INVALID_CURSOR")
    group=next((group for group in state[1] if group["handle"]==request["handle"] and group["initialized"]),None)
    if group is None:raise SharedPublicationError("KNOWLEDGE_INVALID_CURSOR")
    mode="list" if request["operation"].endswith(".list") else "verify"
    return DirectoryRead(channel,request,state,group,mode).execute()


def check_directory(channel,request):
    if set(request)!={"operation","requestId","readerScope","statFingerprint","nextTransitionMs"}:
        raise AccountError("Invalid directory snapshot check")
    state=current_directory(channel,request["readerScope"])
    deadline=request["nextTransitionMs"]
    if state[2]!=request["statFingerprint"] or deadline is not None and (type(deadline) is not int or int(time.time()*1000)>=deadline):
        raise SharedPublicationError("KNOWLEDGE_INVALID_CURSOR")
    return {"statFingerprint":state[2],"policyRevision":state[0]["policyRevision"]}


def dispatch(channel,request):
    try:
        if request["operation"]=="sharedPublication.directory.inspect":return inspect_directory(channel,request)
        if request["operation"]=="sharedPublication.directory.check":return check_directory(channel,request),None
        return read_directory(channel,request)
    except SharedPublicationError:raise
    except AccountError as error:
        raise SharedPublicationError("KNOWLEDGE_SHARED_READER_UNAVAILABLE") from error
