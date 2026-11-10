"""Per-runtime policy channel owned by the existing root account supervisor."""

import json
import array
import stat
import os
import select
import socket
import struct

from studio_account_files import AccountError
from studio_organization import OrganizationStore

CHANNEL_ENV = "KCODER_PRIVATE_ORGANIZATION_FD_V1"


class OrganizationChannel:
    def __init__(self, store, identity, *, runtime=None, workspace_resource=None, purpose="interactive", worker_binding=None):
        self.store, self.identity = store, identity
        if purpose not in ("interactive","wiki_worker") or (purpose=="wiki_worker" and worker_binding is None):
            raise AccountError("Fixed owned organization worker purpose required")
        self.purpose, self.worker_binding = purpose, worker_binding
        self.policy = OrganizationStore(store)
        self.snapshot = self.policy.inspect_session(identity)
        self.parent = self.child = None
        self.resume_authority = None
        self.runtime, self.workspace_resource = runtime, workspace_resource
        self.runtime_pid = None
        self.budget_observations = {}
        self.runtime_fd = None
        self.runtime_path = None
        if runtime is not None and self.snapshot is not None:
            from studio_account_runtime import trusted_runtime
            self.runtime_path = trusted_runtime(runtime)
            self.runtime_fd = os.open(self.runtime_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            info = os.fstat(self.runtime_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1:
                os.close(self.runtime_fd); self.runtime_fd = None
                raise AccountError("Shared publication runtime is not pinned")
        if self.snapshot is not None:
            self.parent, self.child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            self.parent.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            self.parent.setblocking(False)

    def child_fd(self):
        if self.runtime_fd is not None:
            os.close(self.runtime_fd); self.runtime_fd = None
        if self.resume_authority is not None:
            self.resume_authority.child_started()
        if self.child is None:
            return None
        self.parent.close()
        self.child.set_inheritable(True)
        return self.child.fileno()

    def parent_started(self, runtime_pid=None):
        self.runtime_pid = runtime_pid
        if self.child is not None:
            self.child.close()

    def current(self):
        return self.snapshot is None or self.policy.inspect_session(self.identity) is not None

    def poll(self, timeout):
        if self.parent is None:
            return False
        watched = [self.parent]
        if self.resume_authority is not None:
            watched.append(self.resume_authority.listener)
        ready = select.select(watched, [], [], timeout)[0]
        if not ready:
            return False
        if self.resume_authority is not None and self.resume_authority.listener in ready:
            self.resume_authority.process()
            if self.parent not in ready:
                return True
        frame, ancillary, flags, _ = self.parent.recvmsg(8192, socket.CMSG_SPACE(struct.calcsize("3i")))
        if not frame:
            raise AccountError("Organization policy channel closed")
        descriptor = None
        request = None
        try:
            if flags & socket.MSG_TRUNC:
                raise AccountError("Organization policy request too large")
            request = json.loads(frame)
            if not isinstance(request, dict):
                raise AccountError("Invalid organization policy request")
            if request == {"operation": "inspect"}:
                result = self.policy.inspect_session(self.identity)
                if result is not None:result={**result,"workerPurpose":self.purpose}
            elif str(request.get("operation")).startswith("wiki."):
                from studio_organization_wiki import dispatch
                result = dispatch(self,request,ancillary)
            elif request.get("operation") == "evaluate" and set(request) <= {"operation", "action", "resourceId", "requestId", "restrictions"}:
                self.policy.inspect_session(self.identity)
                result = self.policy.evaluate(self.identity, request.get("action"), request.get("resourceId"),
                                              request.get("requestId"), request.get("restrictions"))
            elif request.get("operation") in ("sharedPublication.open", "sharedPublication.verify"):
                from studio_organization_publications import read_publication
                result, descriptor = read_publication(self, request)
            elif request.get("operation") == "sharedPublication.directory.inspect":
                from studio_organization_publication_directory import dispatch
                result, descriptor = dispatch(self, request)
            elif request.get("operation") in ("sharedPublication.directory.list", "sharedPublication.directory.verify"):
                from studio_organization_publication_directory import dispatch
                result, descriptor = dispatch(self, request)
            elif request.get("operation") == "sharedPublication.directory.check":
                from studio_organization_publication_directory import dispatch
                result, descriptor = dispatch(self, request)
            elif request.get("operation") == "model.evaluate":
                result = self.policy.evaluate_model(self.identity, request)
            elif request.get("operation") == "budget.request":
                from studio_organization_budget import request as budget_request
                from studio_organization_workspace import WorkspaceBudgetBinding
                credentials = [struct.unpack("3i", data) for level, kind, data in ancillary
                               if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(data) == struct.calcsize("3i")]
                if credentials != [(self.runtime_pid, self.snapshot.get("workerUid"), self.snapshot.get("workerGid"))]:
                    raise AccountError("Original Native runtime credentials required")
                wiki_workspace = None
                if self.purpose == "wiki_worker":
                    from studio_organization_wiki_budget import workspace_for_budget
                    wiki_workspace = workspace_for_budget(self, request, ancillary)
                    workspace_binding = wiki_workspace
                else:
                    if not isinstance(self.workspace_resource, WorkspaceBudgetBinding):
                        raise AccountError("Original organization workspace binding required")
                    workspace_binding = self.workspace_resource
                from studio_organization_budget import BudgetAdmissionError
                try:
                    workspace = workspace_binding.verify(self.identity)
                    result = budget_request(self.store, self.identity, self.runtime, workspace, request, cache=self.budget_observations)
                    workspace_binding.verify(self.identity)
                except BudgetAdmissionError as error:
                    self.parent.send(json.dumps({"ok": False, "error": error.code}, separators=(",", ":")).encode())
                    return True
                finally:
                    if wiki_workspace is not None:
                        wiki_workspace.close()
            else:
                raise AccountError("Unsupported organization policy request")
            response = {"ok": True, "result": result}
        except Exception as error:
            from studio_organization_publications import SharedPublicationError
            response = {"ok": False, "error": error.code if isinstance(error, SharedPublicationError) else "organization_authorization_denied"}
        try:
            raw = json.dumps(response, separators=(",", ":")).encode()
            if isinstance(request, dict) and (request.get("operation") in ("sharedPublication.open", "sharedPublication.verify") or str(request.get("operation")).startswith("sharedPublication.directory.")):
                rights = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [descriptor]))] if descriptor is not None else []
                if len(raw) > 8192 or self.parent.sendmsg([raw], rights) != len(raw):
                    raise AccountError("Organization response incomplete")
            else:
                self.parent.send(raw)
        finally:
            if descriptor is not None:os.close(descriptor)
        return True

    def close(self):
        if self.runtime_fd is not None:
            os.close(self.runtime_fd);self.runtime_fd = None
        if self.resume_authority is not None:
            self.resume_authority.close()
        if self.workspace_resource is not None:
            self.workspace_resource.close()
        for stream in (self.parent, self.child):
            if stream is not None:
                stream.close()
