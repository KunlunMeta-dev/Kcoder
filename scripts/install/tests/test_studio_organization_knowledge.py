"""Actual app-server reads intersect the current privileged organization policy."""
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
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_accounts import AccountStore
from studio_account_runtime import ensure_binding, drop_to_worker, trusted_runtime
from studio_account_sessions import supervise
from studio_organization import OrganizationStore, publish_worker_marker
from studio_organization_channel import CHANNEL_ENV, OrganizationChannel
from account_fixture_cleanup import cleanup_worker_accounts


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
                     and os.environ.get("KCODER_ORGANIZATION_APP_SERVER"),
                     "Explicit system-user consent and a current app-server binary are required")
class OrganizationKnowledgeRuntimeTests(unittest.TestCase):
    def test_real_native_read_denies_administrator_then_observes_grant_and_revocation(self):
        with ExitStack() as resources:
            installed = Path(resources.enter_context(tempfile.TemporaryDirectory(
                prefix="kcoder-organization-knowledge-probe-", dir="/usr/local/lib")))
            installed.chmod(0o755)
            executable = installed / "kcoder"
            shutil.copyfile(os.environ["KCODER_ORGANIZATION_APP_SERVER"], executable)
            executable.chmod(0o755)
            program = trusted_runtime(executable)
            root = Path(resources.enter_context(tempfile.TemporaryDirectory(prefix="kcoder-org-knowledge-")))
            root.chmod(0o711)
            store = AccountStore(root / "accounts")
            resources.callback(cleanup_worker_accounts, store)
            operator = store.create("operator", "synthetic-operator-password", "admin")
            owner = store.create("owner", "synthetic-owner-password")
            policy = OrganizationStore(store)
            policy.configure("native-knowledge-fixture")
            for identity in (operator, owner):
                policy.administer(None, {"operation": "organization.member", "principalId": identity["id"],
                                         "roles": ["member"]})
            operator = store.authenticate("operator", "synthetic-operator-password")
            binding = ensure_binding(store, operator, root / "homes")
            publish_worker_marker(binding, operator["id"], "native-knowledge-fixture")
            home = Path(binding["home"])
            settings = home / ".config/kcoder/settings.json"
            settings.write_text(json.dumps({"active_provider": "fixture", "model": "no-model-call",
                "providers": {"fixture": {"api_format": "openai_chat_completions", "authentication": {"mode": "none"},
                    "endpoint": "http://127.0.0.1:1/v1", "default_model": "no-model-call", "context_window_tokens": 8192,
                    "max_output_tokens": 1024, "output_headroom_tokens": 1024}},
                "integrations": {"knowledge": {"publications_enabled": True}}, "knowledge": {"enabled": True},
                "memory": {"observer_mode": "disabled", "structured_enabled": False},
                "session_memory": {"enabled": False}}))
            settings.chmod(0o600)
            command_read, command_write = os.pipe()
            output_read, output_write = os.pipe()
            stderr = root / "native-stderr.log"
            error_fd = os.open(stderr, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            supervisor = os.fork()
            if supervisor == 0:
                os.close(command_write)
                os.close(output_read)
                channel = OrganizationChannel(store, operator)
                def start():
                    os.dup2(command_read, 0)
                    os.dup2(output_write, 1)
                    os.dup2(error_fd, 2)
                    environment = drop_to_worker(binding, operator)
                    environment[CHANNEL_ENV] = str(channel.child_fd())
                    os.execve(program, [program, "--cwd", str(home / "workspace"),
                                        "--settings-file", str(settings), "app-server"], environment)
                code = supervise(store, operator, start, interval=0.01, policy_channel=channel)
                os._exit(code)
            os.close(command_read)
            os.close(output_write)
            os.close(error_fd)
            buffer = bytearray()
            sequence = 0
            def rpc(method, params):
                nonlocal sequence
                sequence += 1
                os.write(command_write, (json.dumps({"id": sequence, "method": method, "params": params}) + "\n").encode())
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    while b"\n" in buffer:
                        line, _, remainder = buffer.partition(b"\n")
                        buffer[:] = remainder
                        response = json.loads(line)
                        if response.get("id") == sequence:
                            self.assertNotIn("error", response, response)
                            return response["result"]
                    if select.select([output_read], [], [], max(0, deadline - time.monotonic()))[0]:
                        chunk = os.read(output_read, 65536)
                        self.assertTrue(chunk, "Native app-server exited: " + stderr.read_text())
                        buffer.extend(chunk)
                self.fail("Native app-server response timed out: " + stderr.read_text())
            try:
                initialized = rpc("initialize", {"protocolVersion": "2026-07-27",
                    "clientInfo": {"name": "owned-organization-read", "version": "1"},
                    "capabilities": {"experimental": {"integrationScopeV1": True, "knowledgePublicationsV1": True}}})
                self.assertTrue(initialized["capabilities"]["experimental"]["knowledgePublicationsV1"])
                scope = rpc("integrations/scope/read", {})
                self.assertEqual(scope["organizationId"], "native-knowledge-fixture")
                def read(selected_scope=scope):
                    return rpc("integrations/knowledge/listPublications", {"contractVersion": "parallel-v1",
                        "requestId": str(uuid.uuid4()), "scope": selected_scope, "timeoutMs": 10000, "payload": {}})
                rejected = read()
                self.assertNotEqual(rejected["status"], "completed", "Account administrator cannot bypass the resource policy")
                self.assertIsNone(rejected.get("result"))
                material = ["native-knowledge-resource-v1", "knowledge", scope["accountId"], scope["targetId"],
                            scope["workspaceId"], scope["organizationId"], "publications"]
                key = "knowledge:" + hashlib.sha256(json.dumps(material, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
                resource = {"id": key, "kind": "knowledge", "owner": owner["id"], "visibility": "organization",
                            "grants": [{"subject": operator["id"], "actions": ["read"]}]}
                def save_resource(value):
                    policy.administer(None, {"operation": "organization.resource", "resource": value,
                                             "expectedRevision": policy._load()["revision"]})
                save_resource(resource)
                allowed = read()
                self.assertEqual(allowed["status"], "completed", allowed)
                self.assertEqual(allowed["result"]["page"]["items"], [])
                forged = read({**scope, "organizationId": None})
                self.assertNotEqual(forged["status"], "completed")
                save_resource({**resource, "grants": []})
                revoked = read()
                self.assertNotEqual(revoked["status"], "completed", "An already-open app-server must observe ACL revocation")
                self.assertIsNone(revoked.get("result"))
                events = [json.loads(line) for line in policy.audit.read_text().splitlines()]
                decisions = [event["decision"] for event in events if event["action"] == "read" and event["resource"] == key]
                self.assertIn("allow", decisions)
                self.assertEqual(decisions[-1], "deny")
            finally:
                os.close(command_write)
                os.close(output_read)
                os.kill(supervisor, signal.SIGTERM)
                _, status = os.waitpid(supervisor, 0)
                self.assertTrue(os.WIFEXITED(status), "Owned supervisor must reach its cleanup path")


if __name__ == "__main__":
    unittest.main()
