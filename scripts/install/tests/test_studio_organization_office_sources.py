"""Actual UID/live-PDP checks for the Accepted Office knowledge-source adapter only."""
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import time
import unittest

from organization_publication_fixture import Fixture
from studio_account_runtime import drop_to_worker, trusted_runtime
from studio_account_sessions import supervise
from studio_organization_channel import CHANNEL_ENV, OrganizationChannel


TEST = ("app_server::integrations::knowledge::office_assets::tests::organization_native_tests::"
        "actual_uid_accepted_knowledge_sources_recheck_original_pdp")


def canonical_sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()


def run_adapter(fixture, source_refs, expected, phases, authority=True):
    """The ordinary supervisor owns the sole test process and its real Root peer."""
    executable = fixture.installed / "office-source-adapter-test"
    shutil.copyfile(os.environ["KCODER_ORGANIZATION_NATIVE_TEST_BINARY"], executable)
    executable.chmod(0o755)
    executable = trusted_runtime(executable)
    identity = fixture.accounts.authenticate("reader", "synthetic-reader-password")
    binding = fixture.bindings["reader"]
    command_read, command_write = os.pipe()
    output_read, output_write = os.pipe()
    error_path = fixture.root / ("office-source-adapter-" + ("authorized" if authority else "missing-authority") + ".log")
    error_fd = os.open(error_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    supervisor = os.fork()
    if supervisor == 0:
        os.close(command_write); os.close(output_read)
        channel = OrganizationChannel(fixture.accounts, identity, runtime=fixture.programs[0]) if authority else None

        def execute():
            os.dup2(command_read, 0); os.dup2(output_write, 1); os.dup2(error_fd, 2)
            environment = drop_to_worker(binding, identity)
            if channel is not None:
                environment[CHANNEL_ENV] = str(channel.child_fd())
            environment["KCODER_TEST_ORGANIZATION_OFFICE_SOURCE"] = "1"
            environment["KCODER_TEST_OFFICE_SOURCE_REFS"] = json.dumps({"sourceRefs": source_refs,
                                                                         "expectedSha256": expected})
            os.chdir(Path(binding["home"]) / "workspace")
            os.execve(executable, [executable, TEST, "--exact", "--ignored", "--nocapture", "--test-threads=1"], environment)

        os._exit(supervise(fixture.accounts, identity, execute, interval=0.01, policy_channel=channel))
    os.close(command_read); os.close(output_write); os.close(error_fd)
    transcript, pending, seen = bytearray(), bytearray(), []
    waited = False
    try:
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if not select.select([output_read], [], [], max(0, deadline - time.monotonic()))[0]:
                fixture.case.fail("Owned Office source adapter deadline: " + error_path.read_text())
            chunk = os.read(output_read, 65536)
            if not chunk:
                break
            transcript.extend(chunk); pending.extend(chunk)
            fixture.case.assertLessEqual(len(transcript), 512 * 1024)
            while b"\n" in pending:
                line, _, rest = pending.partition(b"\n"); pending[:] = rest
                marker = b"ORG_OFFICE_SOURCE_PHASE:"
                if marker in line:
                    phase = line.split(marker, 1)[1].decode()
                    fixture.case.assertIn(phase, phases)
                    fixture.case.assertNotIn(phase, seen)
                    phases[phase](); seen.append(phase)
                    os.write(command_write, b"continue\n")
        _, status = os.waitpid(supervisor, 0); waited = True
        output = transcript.decode()
        if not authority:
            fixture.case.assertEqual(os.waitstatus_to_exitcode(status), 101)
            fixture.case.assertIn("ORGANIZATION_GOVERNED_CHANNEL_REQUIRED", error_path.read_text())
            fixture.case.assertEqual(seen, [])
            fixture.case.assertNotIn("ORG_OFFICE_SOURCE_EVIDENCE:", output)
            return output
        fixture.case.assertEqual(os.waitstatus_to_exitcode(status), 0, output + error_path.read_text())
        fixture.case.assertEqual(seen, ["revoke-use", "restore-use", "revoke-read"])
        fixture.case.assertIn("ORG_OFFICE_SOURCE_EVIDENCE:", output)
        return output
    finally:
        os.close(command_write); os.close(output_read)
        if not waited:
            terminal, _ = os.waitpid(supervisor, os.WNOHANG)
            if not terminal:
                os.kill(supervisor, signal.SIGTERM); os.waitpid(supervisor, 0)


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE")
    and os.environ.get("KCODER_ORGANIZATION_NATIVE_TEST_BINARY"), "Explicit owned actual UID, Native, seed and native test executables required")
class OrganizationOfficeSourceTests(unittest.TestCase):
    def test_actual_uid_accepted_source_adapter_preserves_fixed_bytes_and_current_read_use(self):
        with Fixture(self) as fixture:
            for binding in fixture.bindings.values():
                settings = Path(binding["home"]) / ".config/kcoder/settings.json"
                value = json.loads(settings.read_text())
                value["knowledge"] = {"enabled": True, "retrieval_enabled": True, "organization_enabled": False}
                settings.write_text(json.dumps(value))
            publisher, reader = fixture.session("publisher"), fixture.session("reader")
            for name, session in (("publisher", publisher), ("reader", reader)):
                fixture.resource(name, session.owner, "knowledge", "current-target")
            original = fixture.seed("publisher")
            local = fixture.seed("reader")
            publication_id = "original-organization-office-source"
            fixture.resource("publisher", publisher.owner, "publication", publication_id, readers=("reader",))
            fixture.resource("publisher", publisher.owner, "knowledge-audience",
                json.dumps(["organization", fixture.organization], separators=(",", ":")))
            draft = {"publicationId": publication_id, "title": "Explicit fixed original Office material",
                "purpose": "Real organization source adapter provenance", "reviewConclusion": None,
                "visibility": "organization", "audienceId": fixture.organization, "sources": [original["source"]],
                "validFromMs": None, "validUntilMs": None, "unresolved": []}
            published = publisher.call("publishKnowledge", {"draft": draft}, True, 0)
            self.assertEqual(published["status"], "completed", published)
            publication = published["result"]["publication"]
            adopted = reader.call("adoptPublication", {"owner": publisher.owner,
                "publicationId": publication_id, "version": 1}, True, 0)
            self.assertEqual(adopted["status"], "completed", adopted)
            wiki_id = json.dumps(local["source"], separators=(",", ":"))
            fixture.resource("administrator", reader.owner, "wiki_page", wiki_id, readers=("reader",))
            page = reader.rpc("knowledge/page/read", {"libraryId": local["source"]["libraryId"],
                "pageId": local["source"]["pageId"], "revisionId": local["source"]["pageRevision"]})
            references = [{"kind": "publication", "id": publication_id, "revision": "1"},
                {"kind": "wiki_page", "id": json.dumps([local["source"]["libraryId"], local["source"]["pageId"]], separators=(",", ":")),
                 "revision": local["source"]["pageRevision"]}]
            expected = [canonical_sha({"schemaVersion": 1, "kind": "publication", "publication": publication}),
                canonical_sha({"schemaVersion": 1, "kind": "wiki_page", "source": local["source"],
                               "page": page["draft"], "revision": page["revisionId"]})]
            source_files = []
            for name in ("publisher", "reader"):
                profile = Path(fixture.bindings[name]["home"]) / ".config/kcoder"
                source_files.append(profile / "knowledge/state.sqlite")
                source_files.extend(profile.glob("integration-*/catalog.sqlite"))
                source_files.extend(profile.glob("integration-*/catalog-binding.json"))
                for root in [profile / "knowledge/state.objects", *profile.glob("integration-*/catalog.objects")]:
                    source_files.extend(path for path in root.rglob("*") if path.is_file())
            before = {str(path): (path.stat().st_ino, path.stat().st_uid, hashlib.sha256(path.read_bytes()).hexdigest())
                      for path in source_files}

            def grants(actions):
                readers = ("reader",) if actions else ()
                fixture.resource("publisher", publisher.owner, "publication", publication_id, readers=readers, actions=actions)
                fixture.resource("administrator", reader.owner, "wiki_page", wiki_id, readers=readers, actions=actions)

            run_adapter(fixture, references, expected, {}, authority=False)
            run_adapter(fixture, references, expected, {"revoke-use": lambda: grants(("read",)),
                "restore-use": lambda: grants(("read", "use")), "revoke-read": lambda: grants(())})
            self.assertEqual({str(path): (path.stat().st_ino, path.stat().st_uid, hashlib.sha256(path.read_bytes()).hexdigest())
                              for path in source_files}, before)
            stored = fixture.reader_storage("reader", source_files[0])
            self.assertTrue(stored["foreignOsReadDenied"])
            self.assertEqual(stored["publicationRows"], 0)
            self.assertEqual(stored["adoptionRows"], 1)
            print(json.dumps({"organizationOfficeSourceAdapterEvidence": {
                "publisherUid": fixture.bindings["publisher"]["uid"], "readerUid": fixture.bindings["reader"]["uid"],
                "actualAuthenticatedSupervisorAndLiveRootPeer": True, "originalPrivateAcceptedEpochRequired": True,
                "missingCurrentOrganizationAuthorityDenied": True,
                "crossUidFixedPublicationAndOwnFixedWikiHashes": True, "currentReadUseRevocationAndRestoration": True,
                "completedAttemptCannotReuseModelAuthority": True, "originalSourceInodeUidShaPreserved": True,
                "readerOneReferenceNoBodyCopy": True, "providerCalls": 0, "paidCalls": 0,
                "boundary": "Source adapter acceptance only; actual Office parent/tools/generation remain separately gated"}}))


if __name__ == "__main__":
    unittest.main()
