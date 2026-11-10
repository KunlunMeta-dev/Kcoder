"""Organization policy in the existing privileged account boundary.

All actors come from account authentication or the local root operator. Resource
identifiers are locators; neither account-admin nor caller labels grant content.
"""

import copy
import json
import os
import re
from pathlib import Path
import time
import uuid

from studio_account_files import AccountError, locked, read_private_json, write_private_json
from studio_accounts import public_identity

ROLES = {"member", "projectMaintainer", "knowledgePublisher", "applicationAdmin", "auditor"}
ACTIONS = {"read", "use", "write", "publish", "export", "deliver", "execute"}
KINDS = {"model", "workspace", "connection", "knowledge", "artifact", "desktop", "automation", "audit"}


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}", value) or ".." in value:
        raise AccountError("Invalid organization reference")
    return value


def publish_worker_marker(binding, principal_id, organization_id):
    from studio_account_runtime import validate_binding
    from studio_account_files import trusted_directory
    validate_binding(binding, principal_id)
    parent = trusted_directory(Path(binding["home"]).parent)
    marker = parent / (".kcoder-organization-" + str(binding["uid"]) + ".json")
    write_private_json(marker, {"version": 1, "organizationId": organization_id,
                               "principalId": principal_id, "workerUid": binding["uid"], "workerGid": binding["gid"]})
    # Public identity metadata only; the containing directory and file remain
    # owned by root. A worker cannot remove its own governed-launch requirement.
    os.chmod(marker, 0o444)


class OrganizationStore:
    def __init__(self, accounts):
        self.accounts = accounts
        self.path = accounts.root / "organization.json"
        self.audit = accounts.root / "organization-audit.jsonl"

    def _load(self):
        accounts = self.accounts._load()
        try:
            data = read_private_json(self.path)
        except FileNotFoundError as error:
            if accounts.get("organizationId") is not None:
                raise AccountError("Organization policy is unavailable") from error
            raise
        fields = {"version", "id", "revision", "members", "resources"}
        if not isinstance(data, dict) or not fields <= set(data) or set(data) - fields - {"executionPolicy"} or data["version"] != 1:
            raise AccountError("Invalid organization policy")
        identifier(data["id"])
        if accounts.get("organizationId") != data["id"]:
            raise AccountError("Organization account authority has changed")
        if type(data["revision"]) is not int or data["revision"] < 1 or not isinstance(data["members"], dict) or not isinstance(data["resources"], dict):
            raise AccountError("Invalid organization policy")
        if "executionPolicy" in data:
            from studio_organization_execution import validate
            data["executionPolicy"] = validate(data["executionPolicy"], accounts)
        return data

    def _actor(self, accounts, actor):
        if actor is None:
            if os.geteuid() != 0:
                raise AccountError("Local root operator required")
            return None
        current = next((item for item in accounts["accounts"] if item["id"] == actor.get("id")), None)
        if not current or current["disabled"] or current["revision"] != actor.get("revision"):
            raise AccountError("Account authorization has changed")
        return current

    def _administrator(self, accounts, actor):
        current = self._actor(accounts, actor)
        if current is not None and current["role"] != "admin":
            raise AccountError("Account administrator role required")
        return current

    def _require_member(self, policy, current, actor=None):
        member = policy["members"].get(current["id"])
        if not member or member["disabled"]:
            raise AccountError("Organization membership revoked")
        if member.get("directory"):
            from studio_organization_directory import directory_current
            directory_current(member["directory"])
        if member.get("oidc"):
            from studio_organization_oidc import require_oidc_identity
            require_oidc_identity(self.accounts, current, member, actor)
        return member

    def require_current_account(self, current, actor=None):
        # Caller already holds the existing account operation lock.
        try:
            policy = self._load()
        except FileNotFoundError:
            return
        self._require_member(policy, current, actor)

    def mapped_directory_login(self, name):
        with locked(self.accounts.lock):
            accounts = self.accounts._load()
            try:
                policy = self._load()
            except FileNotFoundError:
                return None
            current = next((item for item in accounts["accounts"] if item["username"] == name), None)
            if not current:
                return None
            member = policy["members"].get(current["id"])
            if current["disabled"] or not member or member["disabled"]:
                raise AccountError("Account authentication failed")
            if member.get("oidc") is not None:
                raise AccountError("OIDC browser authentication is required")
            directory = member.get("directory")
            if directory is None:
                return None
            return {"principalId": current["id"], "revision": current["revision"], "subject": copy.deepcopy(directory)}

    def _event(self, policy, actor, action, resource, decision, request_id):
        # There is deliberately no arbitrary metadata, exception text or body.
        event = {"id": str(uuid.uuid4()), "timeMs": int(time.time() * 1000),
                 "actor": actor["id"] if actor else "local-root", "onBehalfOf": None,
                 "organizationId": policy["id"], "policyRevision": policy["revision"],
                 "action": identifier(action), "resource": identifier(resource),
                 "decision": decision, "requestId": identifier(request_id)}
        raw = (json.dumps(event, separators=(",", ":")) + "\n").encode()
        fd = os.open(self.audit, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            import stat
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
                raise AccountError("Unsafe organization audit storage")
            if info.st_size + len(raw) > 4 * 1024 * 1024:
                raise AccountError("Organization audit capacity reached; export and archive required")
            view = memoryview(raw)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)

    def configure(self, organization_id, *, actor=None):
        organization_id = identifier(organization_id)
        with locked(self.accounts.lock):
            accounts = self.accounts._load()
            current = self._administrator(accounts, actor)
            if self.path.exists():
                raise AccountError("Organization already configured")
            if accounts.get("organizationId") not in (None, organization_id):
                raise AccountError("Organization account authority has changed")
            policy = {"version": 1, "id": organization_id, "revision": 1, "members": {}, "resources": {}}
            # The existing account store durably declares governance before any
            # separate policy IO. Loss of that file never restores personal mode.
            accounts["organizationId"] = organization_id
            write_private_json(self.accounts.path, accounts)
            for principal_id, binding in accounts["bindings"].items():
                publish_worker_marker(binding, principal_id, organization_id)
            self._event(policy, current, "configure", organization_id, "allow", str(uuid.uuid4()))
            write_private_json(self.path, policy, replace=False)
            return {"organizationId": organization_id, "revision": 1}

    def administer(self, actor, request):
        if not isinstance(request, dict):
            raise AccountError("Invalid organization operation")
        operation = request.get("operation")
        fields = {"organization.inspect": {"operation"}, "organization.self": {"operation"},
                  "organization.member": {"operation", "principalId", "roles", "disabled", "directory", "oidc", "expectedRevision"},
                  "organization.resource": {"operation", "resource", "expectedRevision"},
                  "organization.executionPolicy": {"operation", "executionPolicy", "expectedRevision"},
                  "organization.export": {"operation", "resourceId"}}
        if operation not in fields or set(request) - fields[operation]:
            raise AccountError("Unsupported organization operation")
        with locked(self.accounts.lock):
            accounts = self.accounts._load()
            current = self._actor(accounts, actor)
            policy = self._load()
            if current is not None:
                self._require_member(policy, current, actor)
            if operation == "organization.self":
                member = policy["members"].get(current["id"])
                if not member or member["disabled"]:
                    raise AccountError("Organization membership revoked")
                return {"organizationId": policy["id"], "revision": policy["revision"],
                        "currentPrincipalId": current["id"],
                        "members": [{"principalId": current["id"], "roles": member["roles"], "disabled": False,
                                     "directoryMapped": member.get("directory") is not None}], "resources": [],
                        "auditExportResources": [key for key, value in policy["resources"].items() if value["kind"] == "audit" and self._allowed(policy, current, "export", key, None)]}
            if operation == "organization.export":
                resource = identifier(request.get("resourceId"))
                if not self._allowed(policy, current, "export", resource, None):
                    self._event(policy, current, "export", resource, "deny", str(uuid.uuid4()))
                    raise AccountError("Organization audit export permission required")
                entry = policy["resources"].get(resource)
                if not entry or entry["kind"] != "audit":
                    raise AccountError("Organization audit scope required")
                events = self._read_events(policy, entry.get("auditScope"))
                self._event(policy, current, "export", resource, "allow", str(uuid.uuid4()))
                # Events contain bounded public references only. No identity
                # password hashes, UID/home mappings or resource bodies export.
                return {"format": "kcoder-organization-audit", "version": 1,
                        "organizationId": policy["id"], "policyRevision": policy["revision"],
                        "scope": copy.deepcopy(entry.get("auditScope")),
                        "events": events}
            self._administrator(accounts, actor)
            if operation == "organization.inspect":
                return {"organizationId": policy["id"], "revision": policy["revision"],
                        "currentPrincipalId": current["id"] if current else None,
                        "members": [{"principalId": key, "roles": item["roles"], "disabled": item["disabled"],
                                     "directoryMapped": item.get("directory") is not None} for key, item in policy["members"].items()],
                        "resources": list(policy["resources"].values()),
                        "executionPolicy": copy.deepcopy(policy.get("executionPolicy")),
                        "auditExportResources": [key for key, value in policy["resources"].items() if value["kind"] == "audit" and self._allowed(policy, current, "export", key, None)]}
            if operation == "organization.executionPolicy":
                if request.get("expectedRevision") != policy["revision"]:
                    raise AccountError("Organization policy revision conflict")
                from studio_organization_execution import validate, validate_transition
                execution = validate(request.get("executionPolicy"), accounts)
                validate_transition(policy.get("executionPolicy"), execution, explicit_limit_adjustment=True)
                for item in execution["budgetPolicies"]:
                    if item["scope"]["kind"] == "organization" and item["scope"]["id"] != policy["id"]:
                        raise AccountError("Budget organization is unavailable")
                for rule in execution["modelRules"]:
                    for workspace in rule["workspaceResourceIds"]:
                        resource = policy["resources"].get(workspace)
                        if not resource or resource["kind"] != "workspace":
                            raise AccountError("Registered workspace resource required")
                policy["executionPolicy"] = execution
                resource = policy["id"]
            elif operation == "organization.member":
                if actor is not None and request.get("expectedRevision") != policy["revision"]:
                    raise AccountError("Organization policy revision conflict")
                principal = identifier(request.get("principalId"))
                record = next((item for item in accounts["accounts"] if item["id"] == principal), None)
                roles = request.get("roles", ["member"])
                disabled = request.get("disabled", False)
                if not record or not isinstance(roles, list) or not roles or len(roles) != len(set(roles)) or set(roles) - ROLES or type(disabled) is not bool:
                    raise AccountError("Invalid organization membership")
                existing_member = policy["members"].get(principal, {})
                directory = request.get("directory", existing_member.get("directory"))
                if directory is not None and "directory" in request:
                    from studio_organization_directory import directory_subject
                    directory = directory_subject(directory)
                    if any(item.get("directory") == directory and key != principal for key, item in policy["members"].items()):
                        raise AccountError("Directory subject is already mapped")
                oidc = request.get("oidc", existing_member.get("oidc"))
                if "oidc" in request:
                    if actor is not None:
                        raise AccountError("OIDC identity enrollment requires the local root operator")
                    if oidc is not None:
                        from studio_organization_oidc_provider import oidc_subject
                        oidc = oidc_subject(self.accounts, oidc)
                        if any(item.get("oidc") == oidc and key != principal for key, item in policy["members"].items()):
                            raise AccountError("OIDC subject is already mapped")
                if oidc is not None and directory is not None:
                    raise AccountError("A member cannot combine directory and OIDC authentication")
                updated = {"roles": roles, "disabled": disabled, "directory": directory}
                if oidc is not None:
                    updated["oidc"] = oidc
                if policy["members"].get(principal) != updated:
                    # Commit revocation first: a failed policy write can only
                    # invalidate old authority, never preserve an old session.
                    record["revision"] += 1
                    write_private_json(self.accounts.path, accounts)
                    binding = accounts["bindings"].get(principal)
                    if binding:
                        publish_worker_marker(binding, principal, policy["id"])
                    policy["members"][principal] = updated
                resource = principal
            else:
                if request.get("expectedRevision") != policy["revision"]:
                    raise AccountError("Organization policy revision conflict")
                entry = self._validate_resource(request.get("resource"), accounts, policy, require_source_binding=True)
                resource = entry["id"]
                existing = policy["resources"].get(resource)
                if existing and (existing["owner"] != entry["owner"] or existing["kind"] != entry["kind"]):
                    raise AccountError("Organization resource ownership is immutable")
                if existing and existing.get("nativeKnowledgeSource") is not None and existing["nativeKnowledgeSource"] != entry.get("nativeKnowledgeSource"):
                    raise AccountError("Knowledge source locator is immutable")
                if current is not None and entry["visibility"] == "private" and current["id"] != entry["owner"]:
                    raise AccountError("Private resource registration requires its owner")
                if existing and existing["visibility"] == "private" and current is not None and current["id"] != existing["owner"]:
                    raise AccountError("Private resource changes require its owner")
                policy["resources"][resource] = entry
            policy["revision"] += 1
            self._event(policy, current, operation, resource, "allow", str(uuid.uuid4()))
            write_private_json(self.path, policy)
            return {"organizationId": policy["id"], "revision": policy["revision"]}

    def backup(self):
        if os.geteuid() != 0:
            raise AccountError("Local root operator required")
        with locked(self.accounts.lock):
            policy = self._load()
            self._event(policy, None, "backup", policy["id"], "allow", str(uuid.uuid4()))
            # Machine-specific NSS UID mappings are intentionally absent.
            members = {key: {"roles": value["roles"], "disabled": value["disabled"]} for key, value in policy["members"].items()}
            result = {"format": "kcoder-organization-policy", "version": 1, "organizationId": policy["id"],
                      "sourceRevision": policy["revision"], "members": members, "resources": copy.deepcopy(policy["resources"])}
            if "executionPolicy" in policy:
                result["executionPolicy"] = copy.deepcopy(policy["executionPolicy"])
            return result

    def restore(self, bundle, expected_revision):
        if os.geteuid() != 0:
            raise AccountError("Local root operator required")
        fields = {"format", "version", "organizationId", "sourceRevision", "members", "resources"}
        if not isinstance(bundle, dict) or not fields <= set(bundle) or set(bundle) - fields - {"executionPolicy"} or bundle["format"] != "kcoder-organization-policy" or bundle["version"] != 1:
            raise AccountError("Unsupported organization backup")
        with locked(self.accounts.lock):
            accounts = self.accounts._load()
            policy = self._load()
            if bundle["organizationId"] != policy["id"] or expected_revision != policy["revision"]:
                raise AccountError("Organization restore revision conflict")
            if not isinstance(bundle["members"], dict) or not isinstance(bundle["resources"], dict):
                raise AccountError("Invalid organization backup")
            records = {item["id"]: item for item in accounts["accounts"]}
            members = {}
            for principal, member in bundle["members"].items():
                if principal not in records or not isinstance(member, dict) or set(member) != {"roles", "disabled"} or not isinstance(member["roles"], list) or not member["roles"] or set(member["roles"]) - ROLES or type(member["disabled"]) is not bool:
                    raise AccountError("Organization restore requires existing portable members")
                # Existing local directory mappings stay current. A destination
                # without such an enrollment must explicitly rebind the subject.
                directory = policy["members"].get(principal, {}).get("directory")
                members[principal] = {**copy.deepcopy(member), "directory": directory}
                if policy["members"].get(principal, {}).get("oidc") is not None:
                    members[principal]["oidc"] = copy.deepcopy(policy["members"][principal]["oidc"])
            resources = {}
            for resource_id, value in bundle["resources"].items():
                resource = self._validate_resource(value, accounts, {**policy, "members": members})
                if resource_id != resource["id"]:
                    raise AccountError("Invalid organization resource reference")
                existing = policy["resources"].get(resource_id)
                if existing and (existing["owner"] != resource["owner"] or existing["kind"] != resource["kind"]):
                    raise AccountError("Organization resource ownership is immutable")
                if existing and existing.get("nativeKnowledgeSource") is not None and existing["nativeKnowledgeSource"] != resource.get("nativeKnowledgeSource"):
                    raise AccountError("Knowledge source locator is immutable")
                resources[resource_id] = resource
            execution = None
            if "executionPolicy" in bundle:
                from studio_organization_execution import validate, validate_transition
                execution = validate(bundle["executionPolicy"], accounts)
                validate_transition(policy.get("executionPolicy"), execution)
                for item in execution["budgetPolicies"]:
                    if item["scope"]["kind"] == "organization" and item["scope"]["id"] != policy["id"]:
                        raise AccountError("Budget organization is unavailable")
                for rule in execution["modelRules"]:
                    if any(resources.get(key, {}).get("kind") != "workspace" for key in rule["workspaceResourceIds"]):
                        raise AccountError("Registered workspace resource required")
            for principal in set(members) | set(policy["members"]):
                if principal in records:
                    records[principal]["revision"] += 1
                    binding = accounts["bindings"].get(principal)
                    if binding:
                        publish_worker_marker(binding, principal, policy["id"])
            write_private_json(self.accounts.path, accounts)
            policy.update(members=members, resources=resources, revision=policy["revision"] + 1)
            # Old portable backups cannot silently remove a current execution restriction.
            if execution is not None:
                policy["executionPolicy"] = execution
            self._event(policy, None, "restore", policy["id"], "allow", str(uuid.uuid4()))
            write_private_json(self.path, policy)
            return {"organizationId": policy["id"], "revision": policy["revision"], "directoryEnrollment": "existing-local-only"}

    @staticmethod
    def _validate_resource(value, accounts, policy=None, *, require_source_binding=False):
        fields = {"id", "kind", "owner", "visibility", "grants"}
        if isinstance(value, dict) and value.get("kind") == "audit":
            fields.add("auditScope")
        if isinstance(value, dict) and value.get("kind") == "knowledge" and "nativeKnowledgeSource" in value:
            fields.add("nativeKnowledgeSource")
        if not isinstance(value, dict) or set(value) != fields:
            raise AccountError("Invalid organization resource")
        identifier(value["id"])
        ids = {item["id"] for item in accounts["accounts"]}
        if value["kind"] not in KINDS or value["owner"] not in ids or value["visibility"] not in ("private", "organization") or not isinstance(value["grants"], list) or len(value["grants"]) > 1000:
            raise AccountError("Invalid organization resource")
        for grant in value["grants"]:
            if not isinstance(grant, dict) or set(grant) != {"subject", "actions"}:
                raise AccountError("Invalid organization resource grant")
            if grant["subject"] not in ids | {"role:" + role for role in ROLES} or not isinstance(grant["actions"], list) or not grant["actions"] or set(grant["actions"]) - ACTIONS:
                raise AccountError("Invalid organization resource grant")
        if value["visibility"] == "private" and value["grants"]:
            raise AccountError("Private resources cannot grant other members access")
        if value["kind"] == "audit":
            scope = value["auditScope"]
            if scope != "organization":
                if not isinstance(scope, dict) or set(scope) != {"resourceIds"} or not isinstance(scope["resourceIds"], list) or not 1 <= len(scope["resourceIds"]) <= 1000 or len(scope["resourceIds"]) != len(set(scope["resourceIds"])):
                    raise AccountError("Explicit audit export scope required")
                for resource_id in scope["resourceIds"]:
                    identifier(resource_id)
        if "nativeKnowledgeSource" in value:
            locator = value["nativeKnowledgeSource"]
            if not isinstance(locator, dict) or set(locator) != {"version", "publisherPrincipalId", "publicationOwner", "publicationId"} or type(locator["version"]) is not int or locator["version"] != 1:
                raise AccountError("Invalid native knowledge source locator")
            principal = locator["publisherPrincipalId"]
            try:
                if str(uuid.UUID(principal)) != principal:
                    raise ValueError()
            except (ValueError, TypeError, AttributeError):
                raise AccountError("Invalid knowledge publisher reference") from None
            source_owner = locator["publicationOwner"]
            if not isinstance(source_owner, dict) or set(source_owner) != {"accountId", "targetId", "workspaceId", "organizationId"}:
                raise AccountError("Invalid knowledge source owner")
            for field in ("accountId", "targetId"):
                identifier(source_owner[field])
            for field in ("workspaceId", "organizationId"):
                if source_owner[field] is not None:
                    identifier(source_owner[field])
            publication_id = identifier(locator["publicationId"])
            record = next((item for item in accounts["accounts"] if item["id"] == principal), None)
            member = policy.get("members", {}).get(principal) if policy is not None else None
            if not record or record["disabled"] or not member or member["disabled"] or source_owner["organizationId"] not in (None, policy["id"]):
                raise AccountError("Current organization publisher required")
            if value["visibility"] == "private" and value["owner"] != principal:
                raise AccountError("Private knowledge source requires its publisher as owner")
            from studio_organization_publications import _resource
            if value["id"] != _resource(source_owner, publication_id):
                raise AccountError("Knowledge resource and source locator differ")
            if require_source_binding:
                binding = accounts["bindings"].get(principal)
                if binding is None:
                    raise AccountError("Registered native publisher binding required")
                from studio_account_runtime import validate_binding
                validate_binding(binding, principal)
        return copy.deepcopy(value)

    @staticmethod
    def _allowed(policy, actor, action, resource_id, restrictions):
        if actor is None:
            return True
        member = policy["members"].get(actor["id"])
        resource = policy["resources"].get(resource_id)
        if not member or member["disabled"] or not resource:
            return False
        if restrictions is not None and action not in restrictions:
            return False
        source = resource.get("nativeKnowledgeSource")
        owns_source = source is None or source["publisherPrincipalId"] == actor["id"]
        if resource["owner"] == actor["id"] and resource["kind"] != "audit" and owns_source:
            return True
        if resource["visibility"] == "private":
            return False
        subjects = {actor["id"]} | {"role:" + role for role in member["roles"]}
        return any(grant["subject"] in subjects and action in grant["actions"] for grant in resource["grants"])

    def evaluate(self, actor, action, resource_id, request_id, restrictions=None):
        if action not in ACTIONS:
            raise AccountError("Invalid organization action")
        resource_id, request_id = identifier(resource_id), identifier(request_id)
        if restrictions is not None and (not isinstance(restrictions, list) or set(restrictions) - ACTIONS):
            raise AccountError("Invalid personal policy restriction")
        with locked(self.accounts.lock):
            accounts = self.accounts._load()
            current = self._actor(accounts, actor)
            policy = self._load()
            if current is not None:
                self._require_member(policy, current, actor)
            allowed = self._allowed(policy, current, action, resource_id, restrictions)
            self._event(policy, current, action, resource_id, "allow" if allowed else "deny", request_id)
            return {"allowed": allowed, "organizationId": policy["id"], "policyRevision": policy["revision"],
                    "principalId": current["id"] if current else "local-root"}

    def inspect_session(self, actor):
        with locked(self.accounts.lock):
            accounts = self.accounts._load()
            current = self._actor(accounts, actor)
            try:
                policy = self._load()
            except FileNotFoundError:
                return None
            self._require_member(policy, current, actor)
            binding = accounts["bindings"].get(current["id"])
            result = {"organizationId": policy["id"], "policyRevision": policy["revision"],
                      "principalId": current["id"], "identityRevision": current["revision"]}
            if binding:
                from studio_account_runtime import validate_binding
                validate_binding(binding, current["id"])
                result.update(workerUid=binding["uid"], workerGid=binding["gid"])
            return result

    def evaluate_model(self, actor, request):
        from studio_organization_execution import exact_name, permits_model, model_resource_id
        fields = {"operation", "provider", "model", "endpointOrigin", "configurationRevision", "workspaceResourceId", "modelResourceId", "requestId"}
        if not isinstance(request, dict) or set(request) != fields or request["operation"] != "model.evaluate":
            raise AccountError("Invalid organization model request")
        provider, model = exact_name(request["provider"]), exact_name(request["model"])
        workspace = identifier(request["workspaceResourceId"])
        resource_id = identifier(request["modelResourceId"])
        request_id = identifier(request["requestId"])
        revision = request["configurationRevision"]
        if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{64}", revision):
            raise AccountError("Invalid exact model configuration revision")
        with locked(self.accounts.lock):
            accounts = self.accounts._load()
            current = self._actor(accounts, actor)
            if current is None:
                raise AccountError("Actual organization member required")
            policy = self._load()
            self._require_member(policy, current, actor)
            execution = policy.get("executionPolicy")
            allowed = bool(execution is not None
                           and resource_id == model_resource_id(provider, model, request["endpointOrigin"], revision)
                           and policy["resources"].get(workspace, {}).get("kind") == "workspace"
                           and policy["resources"].get(resource_id, {}).get("kind") == "model"
                           and self._allowed(policy, current, "use", workspace, None)
                           and self._allowed(policy, current, "use", resource_id, None)
                           and permits_model(execution, current["id"], workspace, provider, model, request["endpointOrigin"], revision))
            self._event(policy, current, "model-use", resource_id, "allow" if allowed else "deny", request_id)
            return {"allowed": allowed, "organizationId": policy["id"], "policyRevision": policy["revision"], "principalId": current["id"]}

    def _read_events(self, policy, scope):
        if scope != "organization" and (not isinstance(scope, dict) or set(scope) != {"resourceIds"}):
            raise AccountError("Explicit audit export scope required")
        import stat
        fd = os.open(self.audit, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 4 * 1024 * 1024:
                raise AccountError("Unsafe organization audit storage")
            events = [json.loads(line) for line in source]
        return [event for event in events if event["organizationId"] == policy["id"] and
                (scope == "organization" or event["resource"] in scope["resourceIds"])]
