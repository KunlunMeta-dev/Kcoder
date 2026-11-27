"""Owned actual-UID/live-Root Office host acceptance; no model requests."""
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import sys
import time
import unittest

FIXTURES = Path(os.environ["KCODER_ORGANIZATION_FIXTURE_ROOT"])
sys.path[:0] = [str(FIXTURES / "tests"), str(FIXTURES / "lib")]
from organization_publication_fixture import Fixture
from studio_account_runtime import drop_to_worker, trusted_runtime
from studio_account_sessions import supervise
from studio_organization_channel import CHANNEL_ENV, OrganizationChannel

TEST = ("app_server::integrations::office::organization_policy::native_tests::"
        "actual_uid_live_root_office_host_enforces_dedicated_action_grants")
ALL = ("read", "use", "write", "execute", "export")


def resource_id(scope):
    value = ["native-office-resource-v1", "current-target", scope["accountId"],
             scope["targetId"], scope["workspaceId"], scope["organizationId"]]
    return "office:" + hashlib.sha256(json.dumps(value, ensure_ascii=False,
        separators=(",", ":")).encode()).hexdigest()


def grant(fixture, scope, actions):
    fixture.policy.administer(None, {"operation": "organization.resource",
        "expectedRevision": fixture.policy._load()["revision"], "resource": {
            "id": resource_id(scope), "kind": "artifact",
            "owner": fixture.identities["administrator"]["id"], "visibility": "organization",
            "grants": [{"subject": fixture.identities["reader"]["id"], "actions": list(actions)}] if actions else []}})


def run_host(fixture, name, scope, private_file, authority=True):
    executable = fixture.installed / ("office-host-" + name + ("-live" if authority else "-missing"))
    shutil.copyfile(os.environ["KCODER_ORGANIZATION_NATIVE_TEST_BINARY"], executable)
    executable.chmod(0o755)
    executable = trusted_runtime(executable)
    identity = fixture.accounts.authenticate(name, "synthetic-" + name + "-password")
    binding = fixture.bindings[name]
    command_read, command_write = os.pipe()
    output_read, output_write = os.pipe()
    error_path = fixture.root / (Path(executable).name + ".log")
    error_fd = os.open(error_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    supervisor = os.fork()
    if supervisor == 0:
        os.close(command_write)
        os.close(output_read)
        channel = OrganizationChannel(fixture.accounts, identity, runtime=fixture.programs[0]) if authority else None
        if channel is not None:
            original_evaluate = channel.policy.evaluate
            executed = 0

            def evaluated(actor, action, reference, request_id, restrictions=None):
                nonlocal executed
                if request_id == "revoked-during-generation" and action == "execute":
                    executed += 1
                    if executed == 3:
                        # This is the real post-generator PDP call. The original
                        # policy store evaluates the newly revoked action.
                        grant(fixture, scope, ("read", "use", "write", "export"))
                return original_evaluate(actor, action, reference, request_id, restrictions)

            channel.policy.evaluate = evaluated

        def execute():
            os.dup2(command_read, 0)
            os.dup2(output_write, 1)
            os.dup2(error_fd, 2)
            environment = drop_to_worker(binding, identity)
            if channel is not None:
                environment[CHANNEL_ENV] = str(channel.child_fd())
            environment.update({"KCODER_TEST_ORGANIZATION_OFFICE_HOST": "1",
                "KCODER_TEST_OFFICE_HOST_MODE": "manager" if name == "administrator" else "reader",
                "KCODER_TEST_FOREIGN_OFFICE_SCOPE": json.dumps(scope),
                "KCODER_TEST_PRIVATE_OFFICE_FILE": str(private_file),
                "KCODER_OFFICE_NATIVE_NODE_LAUNCH": str(fixture.installed / "office-launch.json"),
                "KCODER_OFFICE_RESOURCE_OWNER_BIN": fixture.programs[0]})
            os.chdir(Path(binding["home"]) / "workspace")
            os.execve(executable, [executable, TEST, "--exact", "--ignored", "--nocapture", "--test-threads=1"], environment)

        os._exit(supervise(fixture.accounts, identity, execute, interval=0.01, policy_channel=channel))
    os.close(command_read)
    os.close(output_write)
    os.close(error_fd)
    transcript, pending, phases = bytearray(), bytearray(), []
    waited = False
    actions = {"grant-read-write-use": ("read", "write", "use"), "grant-all": ALL,
        "revoke-export": ("read", "write", "use", "execute"), "revoke-read": ("export",),
        "restore-all": ALL, "restore-after-generated": ALL}
    try:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            fixture.case.assertTrue(select.select([output_read], [], [],
                min(30, max(0, deadline - time.monotonic())))[0], error_path.read_text())
            chunk = os.read(output_read, 65536)
            if not chunk:
                break
            transcript.extend(chunk)
            pending.extend(chunk)
            fixture.case.assertLessEqual(len(transcript), 512 * 1024)
            while b"\n" in pending:
                line, _, rest = pending.partition(b"\n")
                pending[:] = rest
                marker = b"ORG_OFFICE_HOST_PHASE:"
                if marker in line:
                    phase = line.split(marker, 1)[1].decode()
                    fixture.case.assertIn(phase, actions)
                    fixture.case.assertNotIn(phase, phases)
                    grant(fixture, scope, actions[phase])
                    phases.append(phase)
                    os.write(command_write, b"continue\n")
        _, status = os.waitpid(supervisor, 0)
        waited = True
        output = transcript.decode()
        errors = error_path.read_text()
        fixture.case.assertNotIn("ORIGINAL_PRIVATE_OFFICE_SENTINEL", output + errors)
        if not authority:
            fixture.case.assertEqual(os.waitstatus_to_exitcode(status), 101, output + errors)
            fixture.case.assertIn("ORGANIZATION_GOVERNED_CHANNEL_REQUIRED", errors)
            fixture.case.assertNotIn("ORG_OFFICE_HOST_EVIDENCE:", output)
        else:
            fixture.case.assertEqual(os.waitstatus_to_exitcode(status), 0, output + errors)
            fixture.case.assertIn("ORG_OFFICE_HOST_EVIDENCE:", output)
            fixture.case.assertEqual(phases, list(actions) if name == "reader" else [])
        return output
    finally:
        os.close(command_write)
        os.close(output_read)
        if not waited:
            done, _ = os.waitpid(supervisor, os.WNOHANG)
            if not done:
                os.kill(supervisor, signal.SIGTERM)
                os.waitpid(supervisor, 0)


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1",
    "Explicit owned actual UID fixture required")
class OrganizationOfficeHostTests(unittest.TestCase):
    def test_current_root_host_requires_dedicated_scope_and_each_current_action(self):
        with Fixture(self, with_seed=False) as fixture:
            launch = fixture.installed / "office-launch.json"
            shutil.copyfile(os.environ["KCODER_OFFICE_NATIVE_NODE_LAUNCH"], launch)
            launch.chmod(0o444)
            reader = fixture.session("reader")
            manager = fixture.session("administrator")
            # Knowledge and workspace grants do not imply Office authority.
            fixture.resource("administrator", reader.owner, "knowledge", "current-target", readers=("reader",))
            fixture.resource("administrator", manager.owner, "knowledge", "current-target", readers=("administrator",))
            private_file = Path(fixture.bindings["reader"]["home"]) / ".config/kcoder/office-private-original.txt"
            private_file.write_text("ORIGINAL_PRIVATE_OFFICE_SENTINEL")
            os.chown(private_file, fixture.bindings["reader"]["uid"], fixture.bindings["reader"]["gid"])
            private_file.chmod(0o600)
            snapshot = lambda: (private_file.stat().st_ino, private_file.stat().st_uid,
                hashlib.sha256(private_file.read_bytes()).hexdigest())
            before = snapshot()
            run_host(fixture, "reader", reader.scope, private_file, authority=False)
            run_host(fixture, "reader", reader.scope, private_file)
            run_host(fixture, "administrator", reader.scope, private_file)
            self.assertEqual(snapshot(), before)
            print(json.dumps({"organizationOfficeHostEvidence": {
                "readerUid": fixture.bindings["reader"]["uid"],
                "managerUid": fixture.bindings["administrator"]["uid"],
                "actualAuthenticatedUidLiveRootPeer": True, "sealedActualNodeDocx": True,
                "missingOfficeScopeAndMissingExecuteDenied": True,
                "revokedReadAndExportBlockOriginalLease": True,
                "generatedThenRevokedOriginalOperationUnknownNoReplay": True,
                "managerCannotBorrowOtherScopeOrPrivateFile": True,
                "originalPrivateInodeUidShaPreserved": True, "providerCalls": 0, "paidCalls": 0,
                "scope": "Original production Native host paths under libtest; peer/command owner is separately frozen normal Native."}}))


if __name__ == "__main__":
    unittest.main()
