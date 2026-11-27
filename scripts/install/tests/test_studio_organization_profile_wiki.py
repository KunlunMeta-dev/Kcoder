"""An original same-profile Wiki principal is data routing, not current organization identity."""
import hashlib
import json
import os
from pathlib import Path
import unittest
from organization_publication_fixture import Fixture


@unittest.skipUnless(os.geteuid()==0 and os.environ.get("KCODER_TEST_SYSTEM_USERS")=="1" and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),"Explicit owned UID and current native/seed required")
class OriginalProfileWikiTests(unittest.TestCase):
    def test_fixed_old_profile_page_publishes_and_observes_under_current_account_scope_without_owner_rewrite(self):
        with Fixture(self) as fixture:
            current=fixture.session("reader")
            seed=fixture.seed("reader",original_profile=True)
            wiki=Path(fixture.bindings["reader"]["home"])/".config/kcoder/knowledge/state.sqlite"
            original=(wiki.stat().st_ino,wiki.stat().st_uid)
            fixture.resource("reader",current.owner,"knowledge","current-target")
            identity="owned-original-profile-principal"
            fixture.resource("reader",current.owner,"publication",identity)
            draft={"publicationId":identity,"title":"Original profile fixed page","purpose":"Read-only principal compatibility",
                   "reviewConclusion":None,"visibility":"personal","audienceId":None,"sources":[seed["source"]],
                   "validFromMs":None,"validUntilMs":None,"unresolved":[]}
            published=current.call("publishKnowledge",{"draft":draft},True,0)
            self.assertEqual(published["status"],"completed",published)
            reference={"owner":published["result"]["publication"]["owner"],"publicationId":identity,"version":1}
            resolved=current.call("resolvePublication",reference)
            self.assertEqual(resolved["status"],"completed",resolved)
            self.assertEqual(hashlib.sha256(resolved["result"]["publication"]["pages"][0]["markdown"].encode()).hexdigest(),seed["markdownSha256"])
            states=current.call("readPublicationSources",reference)
            self.assertEqual(states["status"],"completed",states)
            self.assertEqual((wiki.stat().st_ino,wiki.stat().st_uid),original)
            self.assertEqual(current.rpc("integrations/scope/read",{}),current.scope)
            self.assertEqual(current.scope["organizationId"],fixture.organization)
            print(json.dumps({"originalProfileWikiEvidence":{"actualUid":fixture.bindings["reader"]["uid"],
                "sameProfileDataPrincipalOnly":True,"currentCallerOrganizationPreserved":True,
                "fixedRevisionPublishAndSourceObservation":True,"originalWikiFileIdAndOwnerPreserved":True,"paidCalls":0}}))
