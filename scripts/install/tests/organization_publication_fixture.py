"""Owned real-UID app-server sessions for organization publication acceptance."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore
from studio_account_runtime import ensure_binding, drop_to_worker, trusted_runtime
from studio_account_sessions import supervise
from studio_organization import OrganizationStore
from studio_organization_channel import OrganizationChannel, CHANNEL_ENV
from account_fixture_cleanup import cleanup_worker_accounts


def resource_key(kind, owner, identity):
    raw = json.dumps(["native-knowledge-resource-v1", kind, owner["accountId"], owner["targetId"],
                      owner.get("workspaceId"), owner.get("organizationId"), identity],
                     ensure_ascii=False, separators=(",", ":")).encode()
    return "knowledge:" + hashlib.sha256(raw).hexdigest()


class Fixture:
    def __init__(self, case, with_seed=True, governed=True):
        self.case, self.resources = case, ExitStack()
        try:
            self.installed = Path(self.resources.enter_context(tempfile.TemporaryDirectory(prefix="kcoder-shared-code-", dir="/usr/local/lib")))
            self.installed.chmod(0o755)
            self.programs = []
            programs = [("kcoder", "KCODER_ORGANIZATION_APP_SERVER")]
            if with_seed:programs.append(("seed", "KCODER_ORGANIZATION_LEGACY_FIXTURE"))
            for name, variable in programs:
                destination = self.installed / name
                shutil.copyfile(os.environ[variable], destination); destination.chmod(0o755)
                self.programs.append(trusted_runtime(destination))
            self.root = Path(self.resources.enter_context(tempfile.TemporaryDirectory(prefix="kcoder-shared-")))
            self.root.chmod(0o711)
            self.accounts = AccountStore(self.root / "accounts")
            self.resources.callback(cleanup_worker_accounts, self.accounts)
            self.identities, self.bindings = {}, {}
            for name in ("publisher", "reader", "administrator"):
                identity = self.accounts.create(name, "synthetic-" + name + "-password", "admin" if name == "administrator" else "user")
                binding = ensure_binding(self.accounts, identity, self.root / "homes")
                self.bindings[name] = binding
                settings = Path(binding["home"]) / ".config/kcoder/settings.json"
                settings.write_text(json.dumps({"active_provider":"fixture", "providers":{"fixture":{"api_format":"openai_chat_completions", "authentication":{"mode":"none"}, "endpoint":"http://127.0.0.1:1/v1", "default_model":"no-model", "context_window_tokens":8192, "output_headroom_tokens":1024, "max_output_tokens":1024}}, "knowledge":{"enabled":True}, "integrations":{"knowledge":{"publications_enabled":True}}, "memory":{"observer_mode":"disabled", "structured_enabled":False}, "session_memory":{"enabled":False}}))
                settings.chmod(0o600)
            self.policy = OrganizationStore(self.accounts)
            self.organization = "owned-cross-uid-org"
            if governed:self.enter_organization()
            else:
                for name in self.bindings:self.identities[name]=self.accounts.authenticate(name,"synthetic-"+name+"-password")

        except BaseException:
            self.resources.close()
            raise

    def enter_organization(self):
        self.policy.configure(self.organization)
        for name in self.bindings:
            identity = self.accounts._load()["accounts"]
            identity = next(record for record in identity if record["username"] == name)
            self.policy.administer(None, {"operation":"organization.member", "principalId":identity["id"], "roles":["member"]})
            self.identities[name] = self.accounts.authenticate(name, "synthetic-" + name + "-password")


    def __enter__(self):return self
    def __exit__(self, *arguments):return self.resources.__exit__(*arguments)

    def seed(self, name, original_profile=False, with_job=False):
        output_read, output_write = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(output_read); os.dup2(output_write, 1)
            environment = drop_to_worker(self.bindings[name], self.identities[name])
            if original_profile:environment.pop("KCODER_ACCOUNT_PRINCIPAL_ID",None)
            environment["KCODER_TEST_ORGANIZATION_LEGACY_FIXTURE"] = "1"
            if with_job:environment["KCODER_TEST_ORGANIZATION_JOB_FIXTURE"] = "1"
            os.execve(self.programs[1], [self.programs[1]], environment)
        os.close(output_write); raw = bytearray()
        while True:
            chunk = os.read(output_read, 65536)
            if not chunk:break
            raw.extend(chunk)
        os.close(output_read); _, status = os.waitpid(child, 0)
        self.case.assertEqual(os.waitstatus_to_exitcode(status), 0)
        result = json.loads(raw)
        self.case.assertEqual(result["actualUid"], self.bindings[name]["uid"])
        return result

    def session(self, name, pause_shared_fd=None, channel_factory=None, capabilities=None):
        identity, binding = self.identities[name], self.bindings[name]
        command_read, command_write = os.pipe(); output_read, output_write = os.pipe()
        error_path = self.root / (name + "-" + uuid.uuid4().hex + ".log")
        error_fd = os.open(error_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        supervisor = os.fork()
        if supervisor == 0:
            os.close(command_write); os.close(output_read)
            if pause_shared_fd is not None:
                import studio_organization_publications as shared
                original_drop, original_current = shared.drop_to_worker, shared.PublicationRead.current
                def owned_pause(binding, principal):
                    environment = original_drop(binding, principal)
                    os.write(pause_shared_fd, (json.dumps({"stage":"publisher-dropped", "pid":os.getpid(), "uid":os.geteuid()})+"\n").encode())
                    os.kill(os.getpid(), signal.SIGSTOP)
                    return environment
                def owned_current(worker):
                    if not getattr(worker, "fixture_announced", False):
                        worker.fixture_announced = True
                        os.write(pause_shared_fd, (json.dumps({"stage":"owner-armed", "pid":os.getpid()})+"\n").encode())
                    return original_current(worker)
                shared.drop_to_worker, shared.PublicationRead.current = owned_pause, owned_current
            channel = (channel_factory(self.accounts, identity, self.programs[0], binding) if channel_factory is not None
                       else OrganizationChannel(self.accounts, identity, runtime=self.programs[0]))
            def execute():
                os.dup2(command_read, 0); os.dup2(output_write, 1); os.dup2(error_fd, 2)
                environment = drop_to_worker(binding, identity)
                organization_fd = channel.child_fd()
                if organization_fd is not None:environment[CHANNEL_ENV] = str(organization_fd)
                home = Path(binding["home"])
                os.execve(self.programs[0], [self.programs[0], "--cwd", str(home / "workspace"), "--settings-file", str(home / ".config/kcoder/settings.json"), "app-server"], environment)
            os._exit(supervise(self.accounts, identity, execute, interval=0.01, policy_channel=channel))
        os.close(command_read); os.close(output_write); os.close(error_fd)
        result = Session(self.case, command_write, output_read, supervisor, error_path)
        self.resources.callback(result.stop)
        experimental = {"integrationScopeV1":True, "knowledgePublicationsV1":True, "modelPoliciesV1":True}
        if capabilities is not None:experimental.update(capabilities)
        result.rpc("initialize", {"protocolVersion":"2026-07-27", "clientInfo":{"name":"owned-cross-uid-publication", "version":"1"}, "capabilities":{"experimental":experimental}})
        result.scope = result.rpc("integrations/scope/read", {})
        result.owner = {key:result.scope[key] for key in ("accountId", "targetId", "workspaceId")}
        result.owner["organizationId"] = result.scope.get("organizationId")
        return result

    def resource(self, identity, owner, kind, reference, readers=(), actions=("read", "use")):
        self.policy.administer(None, {"operation":"organization.resource", "expectedRevision":self.policy._load()["revision"], "resource":{"id":resource_key(kind, owner, reference), "kind":"knowledge", "owner":self.identities[identity]["id"], "visibility":"organization", "grants":[{"subject":self.identities[name]["id"], "actions":list(actions)} for name in readers]}})

    def reader_storage(self, name, foreign_database):
        read, write = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(read)
            drop_to_worker(self.bindings[name], self.identities[name])
            import errno
            import sqlite3
            denied = False
            try:
                descriptor = os.open(foreign_database, os.O_RDONLY | os.O_NOFOLLOW)
                os.close(descriptor)
            except OSError as error:denied = error.errno in (errno.EACCES, errno.EPERM)
            profile = Path(self.bindings[name]["home"]) / ".config/kcoder"
            publications, adoptions, namespaces = 0, 0, 0
            for directory in profile.iterdir():
                if not directory.is_dir() or not (directory / "catalog-binding.json").exists():continue
                namespaces += 1
                connection = sqlite3.connect((directory / "catalog.sqlite").as_uri() + "?mode=ro", uri=True)
                try:
                    publications += connection.execute("SELECT COUNT(*) FROM integration_publications").fetchone()[0]
                    if connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='integration_knowledge_adoptions'").fetchone()[0]:
                        adoptions += connection.execute("SELECT COUNT(*) FROM integration_knowledge_adoptions").fetchone()[0]
                finally:connection.close()
            os.write(write, json.dumps({"actualUid":os.geteuid(), "foreignOsReadDenied":denied,
                "publicationRows":publications, "adoptionRows":adoptions, "namespaces":namespaces}).encode())
            os.close(write);os._exit(0)
        os.close(write);raw = bytearray()
        while True:
            chunk = os.read(read, 65536)
            if not chunk:break
            raw.extend(chunk)
        os.close(read);_,status = os.waitpid(child, 0)
        self.case.assertEqual(os.waitstatus_to_exitcode(status), 0)
        return json.loads(raw)


class Session:
    def __init__(self, case, input_fd, output_fd, supervisor, error_path):
        self.case, self.input_fd, self.output_fd, self.supervisor, self.error_path = case, input_fd, output_fd, supervisor, error_path
        self.buffer, self.sequence, self.stopped = bytearray(), 0, False
        self.messages = []

    def rpc(self, method, parameters, raw_response=False):
        self.sequence += 1
        os.write(self.input_fd, (json.dumps({"id":self.sequence, "method":method, "params":parameters}) + "\n").encode())
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            while b"\n" in self.buffer:
                line, _, remaining = self.buffer.partition(b"\n"); self.buffer[:] = remaining
                response = json.loads(line)
                self.messages.append(response)
                if response.get("id") == self.sequence:
                    if raw_response:return response
                    self.case.assertNotIn("error", response, response)
                    return response["result"]
            if select.select([self.output_fd], [], [], max(0, deadline - time.monotonic()))[0]:
                chunk = os.read(self.output_fd, 65536)
                self.case.assertTrue(chunk, self.error_path.read_text()); self.buffer.extend(chunk)
        self.case.fail("Owned cross-UID native RPC timeout: " + self.error_path.read_text())

    def wait(self, predicate, seconds=20):
        for value in self.messages:
            if predicate(value):return value
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            while b"\n" in self.buffer:
                line, _, remaining = self.buffer.partition(b"\n"); self.buffer[:] = remaining
                value = json.loads(line); self.messages.append(value)
                if predicate(value):return value
            if select.select([self.output_fd], [], [], max(0, deadline - time.monotonic()))[0]:
                chunk = os.read(self.output_fd, 65536)
                self.case.assertTrue(chunk, self.error_path.read_text()); self.buffer.extend(chunk)
                self.case.assertLessEqual(len(self.buffer), 2 * 1024 * 1024)
        self.case.fail("Owned Native event deadline: " + self.error_path.read_text())

    def call(self, method, payload, mutation=False, revision=None):
        request = {"contractVersion":"parallel-v1", "requestId":str(uuid.uuid4()), "scope":self.scope, "timeoutMs":10000, "payload":payload}
        if mutation:request["operationId"] = str(uuid.uuid4())
        if revision is not None:request["expectedRevision"] = str(revision)
        return self.rpc("integrations/knowledge/" + method, request)

    def begin_read(self, method, payload):
        self.sequence += 1
        request = {"contractVersion":"parallel-v1", "requestId":str(uuid.uuid4()), "scope":self.scope, "timeoutMs":10000, "payload":payload}
        os.write(self.input_fd, (json.dumps({"id":self.sequence, "method":"integrations/knowledge/"+method, "params":request})+"\n").encode())

    def stop(self):
        if self.stopped:return
        self.stopped = True
        os.close(self.input_fd)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            done, _ = os.waitpid(self.supervisor, os.WNOHANG)
            if done:break
            time.sleep(0.02)
        else:
            os.kill(self.supervisor, signal.SIGTERM); os.waitpid(self.supervisor, 0)
        os.close(self.output_fd)
