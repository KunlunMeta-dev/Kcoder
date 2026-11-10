"""Actual restricted UID and production policy channel model revocation, no inference."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import select
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from account_fixture_cleanup import cleanup_worker_accounts
from studio_accounts import AccountStore
from studio_account_runtime import ensure_binding, drop_to_worker, trusted_runtime
from studio_account_sessions import supervise
from studio_organization import OrganizationStore
from studio_organization_channel import OrganizationChannel, CHANNEL_ENV
from studio_organization_execution import model_resource_id


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1" and os.environ.get("KCODER_ORGANIZATION_PROBE"), "Explicit restricted UID and current production authority probe required")
class ModelRuntimeTests(unittest.TestCase):
    def test_original_uid_native_channel_rechecks_model_permission_after_rule_revocation(self):
        with tempfile.TemporaryDirectory(prefix="kcoder-org-model-probe-", dir="/usr/local/lib") as installed, tempfile.TemporaryDirectory(prefix="kcoder-org-model-state-") as state, ExitStack() as resources:
            root = Path(state)
            root.chmod(0o711)
            program = Path(installed) / "authority-probe"
            Path(installed).chmod(0o755)
            shutil.copyfile(os.environ["KCODER_ORGANIZATION_PROBE"], program)
            program.chmod(0o755)
            runtime = trusted_runtime(program)
            accounts = AccountStore(root / "accounts")
            resources.callback(cleanup_worker_accounts, accounts)
            member = accounts.create("member", "synthetic-model-password")
            policy = OrganizationStore(accounts)
            policy.configure("owned-model-organization")
            binding = ensure_binding(accounts, member, root / "homes")
            policy.administer(None, {"operation": "organization.member", "principalId": member["id"], "roles": ["member"]})
            member = accounts.authenticate("member", "synthetic-model-password")
            revision = "a" * 64
            model = model_resource_id("CaseProvider", "ExactModel", "https://internal-model.example", revision)
            for resource_id, kind in [(model, "model"), ("workspace:owned-model-probe", "workspace")]:
                policy.administer(None, {"operation": "organization.resource", "expectedRevision": policy._load()["revision"],
                    "resource": {"id": resource_id, "kind": kind, "owner": member["id"], "visibility": "private", "grants": []}})
            execution = {"version": 1, "modelRules": [{"id": "exact-route", "members": [member["id"]],
                "workspaceResourceIds": ["workspace:owned-model-probe"], "provider": "CaseProvider", "model": "ExactModel",
                "endpointOrigin": "https://internal-model.example", "configurationRevision": revision, "enabled": True}], "budgetPolicies": []}
            policy.administer(None, {"operation": "organization.executionPolicy", "expectedRevision": policy._load()["revision"], "executionPolicy": execution})
            class OwnedModelChannel(OrganizationChannel):
                def poll(self, timeout):
                    result = super().poll(timeout)
                    observe()
                    return result

            channel = OwnedModelChannel(accounts, member)
            resources.callback(channel.close)
            command_read, command_write = os.pipe()
            output_read, output_write = os.pipe()
            original = time.monotonic()
            received = bytearray()
            revoked = False

            def start():
                os.close(command_write)
                os.close(output_read)
                os.dup2(command_read, 0)
                os.dup2(output_write, 1)
                os.dup2(output_write, 2)
                environment = drop_to_worker(binding, member)
                descriptor = channel.child_fd()
                environment.update({CHANNEL_ENV: str(descriptor), "KCODER_ORGANIZATION_PROBE_MODEL": "1", "KCODER_ORGANIZATION_PROBE_MODEL_RESOURCE": model})
                os.execve(runtime, [runtime], environment)

            def observe():
                nonlocal revoked
                if time.monotonic() - original > 10:
                    raise TimeoutError("Owned model authority probe deadline")
                if select.select([output_read], [], [], 0)[0]:
                    received.extend(os.read(output_read, 8192))
                if b"organization-model-authority-verified" in received and not revoked:
                    execution["modelRules"][0]["enabled"] = False
                    policy.administer(None, {"operation": "organization.executionPolicy", "expectedRevision": policy._load()["revision"], "executionPolicy": execution})
                    revoked = True
                    os.write(command_write, b"check-original\n")

            try:
                code = supervise(accounts, member, start, interval=0.01, policy_channel=channel)
            finally:
                for descriptor in [command_read, command_write, output_write]:
                    os.close(descriptor)
            with os.fdopen(output_read, "rb") as output:
                received.extend(output.read())
            self.assertTrue(revoked, received.decode())
            self.assertNotEqual(code, 0)
            self.assertIn(b"ORGANIZATION_MODEL_DENIED", received)
            self.assertNotIn(b"revoked model unexpectedly authorized", received)
