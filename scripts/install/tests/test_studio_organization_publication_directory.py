"""Real cross-UID publication discovery has source-bound pages and current PDP."""
import json
import os
from pathlib import Path
import time
import unittest
from organization_publication_fixture import Fixture


@unittest.skipUnless(os.geteuid()==0 and os.environ.get("KCODER_TEST_SYSTEM_USERS")=="1" and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),"Explicit owned UID and current native/seed required")
class SharedPublicationDirectoryTests(unittest.TestCase):
    def test_policy_owner_without_native_worker_is_fingerprinted_without_becoming_a_publisher(self):
        with Fixture(self,governed=False) as fixture:
            original=fixture.session("reader")
            seed=fixture.seed("reader")
            identity="owned-old-policy-reference"
            draft={"publicationId":identity,"title":"Old exact-owner policy record","purpose":"Policy ownership is not publisher registration",
                   "reviewConclusion":None,"visibility":"personal","audienceId":None,"sources":[seed["source"]],
                   "validFromMs":None,"validUntilMs":None,"unresolved":[]}
            published=original.call("publishKnowledge",{"draft":draft},True,0)
            self.assertEqual(published["status"],"completed",published)
            owner=published["result"]["publication"]["owner"]
            original.stop();fixture.enter_organization()
            current=fixture.session("reader")
            fixture.resource("reader",current.owner,"knowledge","current-target")
            fixture.resource("administrator",owner,"publication",identity,readers=("reader",))
            profile=Path(fixture.bindings["administrator"]["home"])/".config/kcoder"
            before=sorted(path.name for path in profile.iterdir())
            listed=current.call("listPublications",{"after":None})
            self.assertEqual(listed["status"],"completed",listed)
            self.assertEqual([(item["owner"],item["draft"]["publicationId"]) for item in listed["result"]["page"]["items"]],[(owner,identity)])
            self.assertEqual(sorted(path.name for path in profile.iterdir()),before)
            self.assertFalse(any(path.name.startswith("integration-") for path in profile.iterdir()))
            # Once a real Native identity exists, a missing publisher source
            # remains unavailable rather than becoming an empty directory.
            administrator=fixture.session("administrator")
            missing=current.call("listPublications",{"after":None})
            self.assertEqual(missing["status"],"unavailable",missing)
            self.assertIsNone(missing.get("result"))
            self.assertEqual(administrator.rpc("integrations/scope/read",{})["organizationId"],fixture.organization)
            print(json.dumps({"policyOwnerDirectoryEvidence":{"actualUid":fixture.bindings["reader"]["uid"],
                "unregisteredOwnerMetadataOnly":True,"noNativeWorkerAllocatedByRead":True,
                "oldExplicitPublicationOwnerPreserved":True,"registeredMissingSourceUnavailable":True,"paidCalls":0}}))

    def test_current_pdp_native_publishers_have_stable_ten_item_pages_and_invalidated_source_cursor(self):
        with Fixture(self) as fixture:
            first,second,reader=(fixture.session(name) for name in ("publisher","administrator","reader"))
            for name,session in (("publisher",first),("administrator",second),("reader",reader)):
                fixture.resource(name,session.owner,"knowledge","current-target")
            seeds={name:fixture.seed(name) for name in ("publisher","administrator")}
            for name,session in (("publisher",first),("administrator",second)):
                fixture.resource(name,session.owner,"knowledge-audience",json.dumps(["organization",fixture.organization],separators=(",",":")))
            def publish(name,session,identity,visible=True,revision=0,**values):
                fixture.resource(name,session.owner,"publication",identity,readers=("reader",) if visible else ())
                draft={"publicationId":identity,"title":"Same approved title","purpose":"Source-bound multi-UID directory","reviewConclusion":None,"visibility":"organization","audienceId":fixture.organization,"sources":[seeds[name]["source"]],"validFromMs":None,"validUntilMs":None,"unresolved":[]}
                draft.update(values)
                result=session.call("publishKnowledge",{"draft":draft},True,revision)
                self.assertEqual(result["status"],"completed",result)
                return draft
            drafts={}
            for index in range(10):drafts[index]=publish("publisher",first,"directory-"+str(index))
            publish("administrator",second,"directory-0")
            publish("publisher",first,"directory-hidden",False)
            publish("publisher",first,"directory-private",visibility="personal",audienceId=None)
            publish("publisher",first,"directory-expired",validUntilMs=int(time.time()*1000)-1)
            fixture.resource("publisher",first.owner,"publication","directory-future",readers=("reader",))
            def listing(after=None):return reader.call("listPublications",{"after":after})
            def page(reply):
                self.assertEqual(reply["status"],"completed",reply)
                return reply["result"]["page"]
            first_page=page(listing());self.assertEqual(len(first_page["items"]),10);self.assertIsNotNone(first_page["nextCursor"])
            second_page=page(listing(first_page["nextCursor"]));self.assertEqual(len(second_page["items"]),1);self.assertIsNone(second_page["nextCursor"])
            union=first_page["items"]+second_page["items"]
            keys=[(item["owner"]["accountId"],item["draft"]["publicationId"]) for item in union]
            self.assertEqual(len(set(keys)),11)
            self.assertIn((first.owner["accountId"],"directory-0"),keys);self.assertIn((second.owner["accountId"],"directory-0"),keys)
            for hidden in ("directory-hidden","directory-private","directory-expired"):self.assertNotIn(hidden,json.dumps(union))
            self.assertEqual(page(listing()),first_page)
            updated=first.call("publishKnowledge",{"draft":drafts[0]},True,1);self.assertEqual(updated["status"],"completed",updated)
            invalid=listing(first_page["nextCursor"]);self.assertNotEqual(invalid["status"],"completed");self.assertIsNone(invalid.get("result"));self.assertEqual(invalid["error"]["code"],"KNOWLEDGE_INVALID_CURSOR")
            fresh=page(listing())
            future={**drafts[0],"publicationId":"directory-future"}
            self.assertEqual(first.call("publishKnowledge",{"draft":future},True,0)["status"],"completed")
            added=listing(fresh["nextCursor"]);self.assertNotEqual(added["status"],"completed");self.assertIsNone(added.get("result"));self.assertEqual(added["error"]["code"],"KNOWLEDGE_INVALID_CURSOR")
            before_revoke=page(listing())
            fixture.resource("publisher",first.owner,"publication","directory-1")
            denied=listing(before_revoke["nextCursor"]);self.assertNotEqual(denied["status"],"completed");self.assertIsNone(denied.get("result"));self.assertEqual(denied["error"]["code"],"KNOWLEDGE_INVALID_CURSOR")
            fresh=page(listing());tail=page(listing(fresh["nextCursor"]))
            self.assertEqual([len(fresh["items"]),len(tail["items"])],[10,1]);self.assertNotIn("directory-1\"",json.dumps(fresh["items"]+tail["items"]))
            profile=Path(fixture.bindings["administrator"]["home"])/".config/kcoder"
            namespace=next(directory for directory in profile.iterdir() if directory.is_dir() and (directory/"catalog-binding.json").exists())
            moved=namespace.with_name("owned-missing-directory-source")
            namespace.rename(moved)
            try:
                missing=listing();self.assertEqual(missing["status"],"unavailable",missing);self.assertIsNone(missing.get("result"))
            finally:moved.rename(namespace)
            self.assertEqual(len(page(listing())["items"]),10)
            expires=int(time.time()*1000)+4000
            publish("publisher",first,"directory-clock",validUntilMs=expires)
            clock=page(listing());self.assertIsNotNone(clock["nextCursor"])
            time.sleep(max(0,(expires-int(time.time()*1000)+80)/1000))
            elapsed=listing(clock["nextCursor"]);self.assertNotEqual(elapsed["status"],"completed");self.assertIsNone(elapsed.get("result"));self.assertEqual(elapsed["error"]["code"],"KNOWLEDGE_INVALID_CURSOR")
            storage=fixture.reader_storage("reader",namespace/"catalog.sqlite")
            self.assertEqual(storage["publicationRows"],0);self.assertEqual(storage["namespaces"],0);self.assertTrue(storage["foreignOsReadDenied"])
            print(json.dumps({"crossUidDirectoryEvidence":{"publisherUids":[fixture.bindings[name]["uid"] for name in ("publisher","administrator")],"readerUid":fixture.bindings["reader"]["uid"],"initialPages":[10,1],"sameIdDifferentOwnersPreserved":True,"hiddenPrivateExpiredNotInItemsOrPagination":True,"sourceVersionAdditionPdpAndClockInvalidateCursor":True,"missingSourceUnavailableAndRestored":True,"receiverBodyStores":0,"paidCalls":0}}))
