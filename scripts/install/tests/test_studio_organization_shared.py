"""Real separate-UID shared publication reads use current reader PDP and original publisher bytes."""
import hashlib
import json
import os
import select
import signal
import time
from pathlib import Path
import unittest

from organization_publication_fixture import Fixture


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1" and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"), "Explicit owned system-user and current native/seed executables required")
class SharedPublicationTests(unittest.TestCase):
    def test_closing_original_reader_session_terminates_only_its_owned_publisher_uid_helper(self):
        with Fixture(self) as fixture:
            notices_read, notices_write = os.pipe()
            fixture.resources.callback(os.close, notices_read)
            fixture.resources.callback(os.close, notices_write)
            publisher = fixture.session("publisher")
            reader = fixture.session("reader", pause_shared_fd=notices_write)
            for name, session in (("publisher", publisher), ("reader", reader)):
                fixture.resource(name, session.owner, "knowledge", "current-target")
            seed = fixture.seed("publisher")
            identity = "owned-session-close-publication"
            fixture.resource("publisher", publisher.owner, "publication", identity, readers=("reader",))
            fixture.resource("publisher", publisher.owner, "knowledge-audience", json.dumps(["organization", fixture.organization], separators=(",", ":")))
            draft = {"publicationId":identity, "title":"Owned close fixture", "purpose":"Original session owns its exact fixed reader", "reviewConclusion":None, "visibility":"organization", "audienceId":fixture.organization, "sources":[seed["source"]], "validFromMs":None, "validUntilMs":None, "unresolved":[]}
            self.assertEqual(publisher.call("publishKnowledge", {"draft":draft}, True, 0)["status"], "completed")
            reader.begin_read("resolvePublication", {"owner":publisher.owner, "publicationId":identity, "version":1})
            notices, buffer = {}, bytearray()
            deadline = time.monotonic()+8
            while len(notices)<2 and time.monotonic()<deadline:
                if not select.select([notices_read], [], [], max(0, deadline-time.monotonic()))[0]:break
                buffer.extend(os.read(notices_read, 4096))
                while b"\n" in buffer:
                    line,_,remaining = buffer.partition(b"\n");buffer[:] = remaining
                    notice = json.loads(line);notices[notice["stage"]] = notice
            self.assertEqual(set(notices), {"publisher-dropped", "owner-armed"})
            owned = notices["publisher-dropped"]
            self.assertEqual(owned["uid"], fixture.bindings["publisher"]["uid"])
            self.assertEqual(notices["owner-armed"]["pid"], reader.supervisor)
            helper = os.pidfd_open(owned["pid"])
            fixture.resources.callback(os.close, helper)
            children = Path(f"/proc/{reader.supervisor}/task/{reader.supervisor}/children").read_text().split()
            runtimes = [int(pid) for pid in children if Path(f"/proc/{pid}").stat().st_uid == fixture.bindings["reader"]["uid"]]
            self.assertEqual(len(runtimes), 1)
            original_runtime = os.pidfd_open(runtimes[0])
            fixture.resources.callback(os.close, original_runtime)
            started = time.monotonic()
            signal.pidfd_send_signal(original_runtime, signal.SIGKILL)
            reader.stop()
            poll = select.poll();poll.register(helper, select.POLLIN)
            self.assertTrue(poll.poll(1000), "Original owned helper has not terminated")
            self.assertLess(time.monotonic()-started, 7)
            self.assertEqual(publisher.rpc("integrations/scope/read", {})["organizationId"], fixture.organization)
            print(json.dumps({"sharedSessionCloseEvidence":{"readerUid":fixture.bindings["reader"]["uid"], "publisherHelperUid":owned["uid"], "distinctUids":True, "originalSessionOwnerExited":True, "ownedHelperPidfdTerminal":True, "publisherPeerSessionStillUsable":True, "paidCalls":0}}))

    def test_distinct_restricted_uids_read_only_finalized_shared_publication_and_recheck_current_pdp(self):
        with Fixture(self) as fixture:
            publisher, reader, administrator = (fixture.session(name) for name in ("publisher", "reader", "administrator"))
            publisher_uid, reader_uid = fixture.bindings["publisher"]["uid"], fixture.bindings["reader"]["uid"]
            self.assertNotEqual(publisher_uid, reader_uid)
            for name, session in (("publisher", publisher), ("reader", reader), ("administrator", administrator)):
                fixture.resource(name, session.owner, "knowledge", "current-target")
            seed = fixture.seed("publisher")
            identity = "owned-shared-publication"
            fixture.resource("publisher", publisher.owner, "publication", identity)
            audience = json.dumps(["organization", fixture.organization], separators=(",", ":"))
            fixture.resource("publisher", publisher.owner, "knowledge-audience", audience)
            draft = {"publicationId":identity, "title":"Owned finalized shared record", "purpose":"Cross-UID fixed-source acceptance", "reviewConclusion":None, "visibility":"organization", "audienceId":fixture.organization, "sources":[seed["source"]], "validFromMs":None, "validUntilMs":None, "unresolved":[]}
            published = publisher.call("publishKnowledge", {"draft":draft}, True, 0)
            self.assertEqual(published["status"], "completed", published)
            reference = {"owner":publisher.owner, "publicationId":identity, "version":1}
            spaces = [path for path in (Path(fixture.bindings["publisher"]["home"]) / ".config/kcoder").iterdir() if path.is_dir() and (path / "catalog-binding.json").exists()]
            self.assertEqual(len(spaces), 1)
            source = spaces[0]; original = (source.stat().st_ino, (source / "catalog.sqlite").stat().st_ino, (source / "catalog.sqlite").stat().st_uid, (source / "catalog-binding.json").read_bytes())
            denied = reader.call("resolvePublication", reference)
            self.assertNotEqual(denied["status"], "completed"); self.assertIsNone(denied.get("result"))
            admin_denied = administrator.call("resolvePublication", reference)
            self.assertNotEqual(admin_denied["status"], "completed"); self.assertIsNone(admin_denied.get("result"))
            fixture.resource("publisher", publisher.owner, "publication", identity, readers=("reader",))
            allowed = reader.call("resolvePublication", reference)
            self.assertEqual(allowed["status"], "completed", allowed)
            loaded = allowed["result"]["publication"]
            self.assertEqual(loaded["owner"], publisher.owner)
            self.assertEqual(hashlib.sha256(loaded["pages"][0]["markdown"].encode()).hexdigest(), seed["markdownSha256"])
            citation = reader.call("readCitation", {**reference, "source":seed["source"]})
            self.assertEqual(citation["status"], "completed", citation)
            objects = source / "catalog.objects"
            held_objects = source / "owned-original-objects"
            objects.rename(held_objects)
            objects.mkdir(mode=0o700);os.chown(objects, publisher_uid, fixture.bindings["publisher"]["gid"])
            try:
                replaced = reader.call("resolvePublication", reference)
                self.assertNotEqual(replaced["status"], "completed");self.assertIsNone(replaced.get("result"))
            finally:
                objects.rmdir();held_objects.rename(objects)
            self.assertEqual(reader.call("resolvePublication", reference)["status"], "completed")
            fixture.resource("publisher", publisher.owner, "publication", identity, readers=("reader",), actions=("read",))
            denied_use = reader.call("adoptPublication", reference, True, 0)
            self.assertNotEqual(denied_use["status"], "completed");self.assertIsNone(denied_use.get("result"))
            before_adopt = fixture.reader_storage("reader", source / "catalog.sqlite")
            self.assertEqual(before_adopt, {"actualUid":reader_uid, "foreignOsReadDenied":True, "publicationRows":0, "adoptionRows":0, "namespaces":0})
            query = {**reference, "query":"reviewed", "limit":3}
            no_adoption = reader.call("retrieveKnowledge", query)
            self.assertNotEqual(no_adoption["status"], "completed");self.assertIsNone(no_adoption.get("result"))
            fixture.resource("publisher", publisher.owner, "publication", identity, readers=("reader",))
            adopted = reader.call("adoptPublication", reference, True, 0)
            self.assertEqual(adopted["status"], "completed", adopted)
            adoption = adopted["result"]["adoption"]
            self.assertEqual(adoption["owner"], reader.owner);self.assertEqual(adoption["publicationOwner"], publisher.owner)
            self.assertEqual(adoption["publicationVersion"], 1)
            discovered = reader.call("listAdoptions", {"after":None})
            self.assertEqual(discovered["status"], "completed", discovered)
            self.assertEqual(discovered["result"]["page"]["items"], [adoption])
            stored = fixture.reader_storage("reader", source / "catalog.sqlite")
            self.assertEqual(stored, {"actualUid":reader_uid, "foreignOsReadDenied":True, "publicationRows":0, "adoptionRows":1, "namespaces":1})
            consumed = reader.call("retrieveKnowledge", query)
            self.assertEqual(consumed["status"], "completed", consumed)
            retrieval = consumed["result"]["retrieval"]
            self.assertEqual(retrieval["outcome"], "matched");self.assertEqual(len(retrieval["hits"]), 1)
            self.assertEqual(retrieval["hits"][0]["source"], seed["source"])
            self.assertIn("37 reviewed units", retrieval["hits"][0]["excerpt"])
            disabled = reader.call("setAdoptionEnabled", {"adoptionId":adoption["id"], "enabled":False}, True, 1)
            self.assertEqual(disabled["status"], "completed", disabled)
            self.assertFalse(disabled["result"]["adoption"]["enabled"])
            inactive = reader.call("retrieveKnowledge", query)
            self.assertNotEqual(inactive["status"], "completed");self.assertIsNone(inactive.get("result"))
            restored = reader.call("setAdoptionEnabled", {"adoptionId":adoption["id"], "enabled":True}, True, 2)
            self.assertEqual(restored["status"], "completed", restored)
            self.assertTrue(restored["result"]["adoption"]["enabled"])
            self.assertEqual(reader.call("retrieveKnowledge", query)["status"], "completed")
            fixture.resource("publisher", publisher.owner, "publication", identity, readers=("reader",), actions=("read",))
            no_use = reader.call("retrieveKnowledge", query)
            self.assertNotEqual(no_use["status"], "completed");self.assertIsNone(no_use.get("result"))
            self.assertEqual(reader.call("resolvePublication", reference)["status"], "completed")
            missing = reader.call("resolvePublication", {**reference, "version":2})
            self.assertNotEqual(missing["status"], "completed"); self.assertIsNone(missing.get("result"))
            fixture.resource("publisher", publisher.owner, "publication", identity)
            revoked = reader.call("resolvePublication", reference)
            self.assertNotEqual(revoked["status"], "completed"); self.assertIsNone(revoked.get("result"))
            hidden = reader.call("listAdoptions", {"after":None})
            self.assertEqual(hidden["status"], "completed", hidden)
            self.assertEqual(hidden["result"]["page"], {"items":[], "nextCursor":None})
            denied_query = reader.call("retrieveKnowledge", query)
            self.assertNotEqual(denied_query["status"], "completed");self.assertIsNone(denied_query.get("result"))
            fixture.resource("publisher", publisher.owner, "publication", identity, readers=("reader",))
            revoked_source = publisher.call("revokePublication", reference, True, 1)
            self.assertEqual(revoked_source["status"], "completed", revoked_source)
            stale = reader.call("retrieveKnowledge", query)
            self.assertNotEqual(stale["status"], "completed");self.assertIsNone(stale.get("result"))
            self.assertEqual(stale["error"]["code"], "KNOWLEDGE_PUBLICATION_REVOKED")
            private_id = "owned-private-publication"
            fixture.resource("publisher", publisher.owner, "publication", private_id, readers=("reader",))
            private = publisher.call("publishKnowledge", {"draft":{**draft, "publicationId":private_id, "visibility":"personal", "audienceId":None}}, True, 0)
            self.assertEqual(private["status"], "completed", private)
            private_read = reader.call("resolvePublication", {**reference, "publicationId":private_id})
            self.assertNotEqual(private_read["status"], "completed");self.assertIsNone(private_read.get("result"))
            self.assertEqual(private_read["error"]["code"], "KNOWLEDGE_RESOURCE_DENIED")
            expired_id = "owned-expired-shared-publication"
            fixture.resource("publisher", publisher.owner, "publication", expired_id, readers=("reader",))
            expired = publisher.call("publishKnowledge", {"draft":{**draft, "publicationId":expired_id, "validUntilMs":int(time.time()*1000)-1}}, True, 0)
            self.assertEqual(expired["status"], "completed", expired)
            expired_read = reader.call("resolvePublication", {**reference, "publicationId":expired_id})
            self.assertNotEqual(expired_read["status"], "completed");self.assertIsNone(expired_read.get("result"))
            self.assertEqual(expired_read["error"]["code"], "KNOWLEDGE_PUBLICATION_EXPIRED")
            draft_id = "owned-draft-not-published"
            fixture.resource("publisher", publisher.owner, "publication", draft_id, readers=("reader",))
            unpublished = reader.call("resolvePublication", {**reference, "publicationId":draft_id})
            self.assertNotEqual(unpublished["status"], "completed");self.assertIsNone(unpublished.get("result"))
            self.assertEqual(unpublished["error"]["code"], "KNOWLEDGE_PUBLICATION_NOT_FOUND")
            self.assertEqual((source.stat().st_ino, (source / "catalog.sqlite").stat().st_ino, (source / "catalog.sqlite").stat().st_uid, (source / "catalog-binding.json").read_bytes()), original)
            self.assertEqual(fixture.reader_storage("reader", source / "catalog.sqlite")["publicationRows"], 0)
            print(json.dumps({"sharedPublicationEvidence":{"publisherUid":publisher_uid, "readerUid":reader_uid, "distinctRestrictedUids":True, "foreignOsReadDenied":True, "originalOwnerBodyBindingAndInodesPreserved":True, "readerHasOnlyOneAdoptionReferenceAndNoPublicationBodies":True, "readPermissionAloneCannotAdopt":True, "currentPdpAdoptionDiscovery":True, "originalPublisherFtsConsumption":True, "disabledAdoptionAndMissingUseAndRevokedSourceDenyConsumption":True, "privateExpiredAndUnpublishedSourcesDenied":True, "administratorDefaultDenied":True, "sameConnectionReadAndCitationThenPdpRevoked":True, "missingFixedVersionDenied":True, "paidCalls":0}}))
