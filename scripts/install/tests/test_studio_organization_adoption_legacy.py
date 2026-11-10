"""Old own-profile adoptions remain immutable references under current organization policy."""
import hashlib
import json
import os
from pathlib import Path
import unittest
from organization_publication_fixture import Fixture


@unittest.skipUnless(os.geteuid()==0 and os.environ.get("KCODER_TEST_SYSTEM_USERS")=="1" and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),"Explicit actual UID and current native/seed required")
class LegacyAdoptionTests(unittest.TestCase):
    def test_old_reference_discovery_and_explicit_current_adoption_preserve_original_body_owner_and_disabled_choice(self):
        with Fixture(self,governed=False) as fixture:
            personal=fixture.session("reader")
            self.assertIsNone(personal.scope.get("organizationId"))
            seed=fixture.seed("reader")
            identity="owned-before-governance-reference"
            draft={"publicationId":identity,"title":"Original personal fixed record","purpose":"Old adoption compatibility",
                   "reviewConclusion":None,"visibility":"personal","audienceId":None,"sources":[seed["source"]],
                   "validFromMs":None,"validUntilMs":None,"unresolved":[]}
            published=personal.call("publishKnowledge",{"draft":draft},True,0)
            self.assertEqual(published["status"],"completed",published)
            original=published["result"]["publication"]
            reference={"owner":original["owner"],"publicationId":identity,"version":1}
            old=personal.call("adoptPublication",reference,True,0)
            self.assertEqual(old["status"],"completed",old)
            old_adoption=old["result"]["adoption"]
            profile=Path(fixture.bindings["reader"]["home"])/".config/kcoder"
            namespace=next(directory for directory in profile.iterdir() if directory.is_dir() and (directory/"catalog-binding.json").exists())
            binding=(namespace/"catalog-binding.json").read_bytes()
            file_ids=(namespace.stat().st_ino,(namespace/"catalog.sqlite").stat().st_ino,(namespace/"catalog.sqlite").stat().st_uid)
            personal.stop();fixture.enter_organization()
            current=fixture.session("reader")
            self.assertEqual(current.scope["organizationId"],fixture.organization)
            for key in ("accountId","targetId","workspaceId"):self.assertEqual(current.scope[key],personal.scope[key])
            fixture.resource("reader",current.owner,"knowledge","current-target")
            # Policy management ownership is deliberately separate from original data ownership.
            fixture.resource("administrator",original["owner"],"publication",identity)
            hidden=current.call("listAdoptions",{"after":None})
            self.assertEqual(hidden["status"],"completed",hidden);self.assertEqual(hidden["result"]["page"]["items"],[])
            fixture.resource("administrator",original["owner"],"publication",identity,readers=("reader",),actions=("read",))
            denied=current.call("adoptPublication",reference,True,0)
            self.assertNotEqual(denied["status"],"completed");self.assertIsNone(denied.get("result"))
            fixture.resource("administrator",original["owner"],"publication",identity,readers=("reader",))
            discovered=current.call("listAdoptions",{"after":None})
            self.assertEqual(discovered["status"],"completed",discovered)
            self.assertEqual(discovered["result"]["page"]["items"],[old_adoption])
            query={**reference,"query":"reviewed","limit":3}
            unadopted=current.call("retrieveKnowledge",query)
            self.assertNotEqual(unadopted["status"],"completed");self.assertIsNone(unadopted.get("result"))
            adopted=current.call("adoptPublication",reference,True,0)
            self.assertEqual(adopted["status"],"completed",adopted)
            selected=adopted["result"]["adoption"]
            self.assertEqual(selected["owner"],current.owner);self.assertEqual(selected["publicationOwner"],original["owner"])
            visible=current.call("listAdoptions",{"after":None})
            self.assertEqual(visible["status"],"completed",visible);self.assertEqual(visible["result"]["page"]["items"],[selected])
            consumed=current.call("retrieveKnowledge",query)
            self.assertEqual(consumed["status"],"completed",consumed)
            self.assertIn("37 reviewed units",consumed["result"]["retrieval"]["hits"][0]["excerpt"])
            read=current.call("resolvePublication",reference)
            self.assertEqual(read["status"],"completed",read)
            self.assertEqual(hashlib.sha256(read["result"]["publication"]["pages"][0]["markdown"].encode()).hexdigest(),seed["markdownSha256"])
            disabled=current.call("setAdoptionEnabled",{"adoptionId":selected["id"],"enabled":False},True,1)
            self.assertEqual(disabled["status"],"completed",disabled)
            records=current.call("listAdoptions",{"after":None})
            self.assertEqual(records["status"],"completed",records)
            self.assertEqual(len(records["result"]["page"]["items"]),1)
            self.assertEqual(records["result"]["page"]["items"][0]["owner"],current.owner)
            self.assertFalse(records["result"]["page"]["items"][0]["enabled"])
            inactive=current.call("retrieveKnowledge",query)
            self.assertNotEqual(inactive["status"],"completed");self.assertIsNone(inactive.get("result"))
            self.assertEqual((namespace/"catalog-binding.json").read_bytes(),binding)
            self.assertEqual((namespace.stat().st_ino,(namespace/"catalog.sqlite").stat().st_ino,(namespace/"catalog.sqlite").stat().st_uid),file_ids)
            counts=fixture.reader_storage("reader",Path(fixture.bindings["publisher"]["home"])/".config/kcoder/settings.json")
            self.assertEqual(counts["publicationRows"],1);self.assertEqual(counts["adoptionRows"],2);self.assertEqual(counts["namespaces"],2)
            print(json.dumps({"legacyAdoptionEvidence":{"actualUid":fixture.bindings["reader"]["uid"],"sameOwnedProfileNotCrossUidClaim":True,
                "oldBodyOwnerBindingAndFileIdsPreserved":True,"currentCallerStayedOrganization":True,"readWithoutUseCannotAdopt":True,
                "oldReferenceDiscoveryCurrentPdp":True,"explicitCurrentReferenceOnlyMigration":True,"oldBodyFtsConsumedAtOriginalVersion":True,
                "currentDisabledSupersedesOldEnabledInView":True,"publicationBodiesStillOne":True,"originalAndCurrentReferencesBothRetained":True,"paidCalls":0}}))
