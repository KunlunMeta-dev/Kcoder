"""Two authenticated real UIDs cannot borrow another browser profile namespace."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import unittest
import uuid

from organization_publication_fixture import Fixture
from studio_account_runtime import worker_name


def snapshot(directory):
    rows = []
    for path in sorted(directory.rglob("*")):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise AssertionError("Browser namespace contains a symbolic link")
        if path.is_file():
            rows.append((str(path.relative_to(directory)), info.st_dev, info.st_ino,
                         info.st_uid, info.st_nlink, info.st_mode, info.st_size,
                         hashlib.sha256(path.read_bytes()).hexdigest()))
    return rows


@unittest.skipUnless(
    os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1"
    and os.environ.get("KCODER_ORGANIZATION_APP_SERVER"),
    "Explicit owned real-UID account fixture and frozen Native required",
)
class BrowserProfileIdentityTests(unittest.TestCase):
    def test_authenticated_uids_keep_same_named_profiles_private_and_reject_foreign_references(self):
        with Fixture(self, with_seed=False, governed=False) as fixture:
            owned_root, owned_code = fixture.root, fixture.installed
            account_state = fixture.accounts._load()
            owned_workers = [worker_name(value["id"], account_state["instance"])
                             for value in account_state["accounts"]]
            names = ("publisher", "reader")
            sessions = [fixture.session(name, capabilities={
                "browserProfilesV1": True, "browserProfileSessionsV1": True,
            }) for name in names]
            first, second = sessions
            self.assertNotEqual(fixture.identities[names[0]]["id"], fixture.identities[names[1]]["id"])
            self.assertNotEqual(fixture.bindings[names[0]]["uid"], fixture.bindings[names[1]]["uid"])
            self.assertNotEqual(first.scope["accountId"], second.scope["accountId"])
            for session in sessions:
                initialization = next(value["result"] for value in session.messages if value.get("id") == 1)
                self.assertTrue(initialization["capabilities"]["experimental"]["browserProfilesV1"])
                self.assertTrue(initialization["capabilities"]["experimental"]["browserProfileSessionsV1"])
                self.assertTrue(session.rpc("browser/preflight", {})["available"],
                                "A missing Chromium executable is not an identity rejection")

            def call(session, method, payload, scope=None, mutation=False):
                parameters = {"contractVersion": "parallel-v1", "requestId": str(uuid.uuid4()),
                              "scope": session.scope if scope is None else scope,
                              "timeoutMs": 1000, "payload": payload}
                if mutation:
                    parameters["operationId"] = str(uuid.uuid4())
                return session.rpc("integrations/browserProfiles/" + method, parameters)

            def listing(session, scope=None):
                return call(session, "list", {}, scope)

            def completed_page(session):
                response = listing(session)
                self.assertEqual(response["status"], "completed", response)
                return response["result"]["page"]["items"]

            for session in sessions:
                self.assertEqual(completed_page(session), [])
            profile_id = "same-business-profile"
            first_saved = call(first, "save", {"draft": {"id": profile_id, "label": "Owner A",
                               "accountLabel": "User label only", "purpose": "business"},
                               "expectedRevision": 0}, mutation=True)
            self.assertEqual(first_saved["status"], "completed", first_saved)
            first_profile = first_saved["result"]["profile"]
            self.assertEqual(first_profile["draft"]["id"], profile_id)

            def catalog(name):
                profile = Path(fixture.bindings[name]["home"]) / ".config/kcoder"
                matches = [path.parent for path in profile.glob("integration-*/catalog/profiles.json")]
                self.assertEqual(len(matches), 1)
                return matches[0]

            first_catalog = catalog(names[0])
            self.assertEqual((first_catalog / "profiles.json").stat().st_uid,
                             fixture.bindings[names[0]]["uid"])
            before = snapshot(first_catalog)
            self.assertEqual(completed_page(second), [])
            foreign_read = listing(second, first.scope)
            self.assertEqual(foreign_read["status"], "rejected", foreign_read)
            self.assertIsNone(foreign_read.get("result"))
            denied_codes = []
            for scope, expected in ((first.scope, "INTEGRATION_SCOPE_MISMATCH"),
                                    (second.scope, "BROWSER_PROFILE_NOT_FOUND")):
                rejected = second.rpc("browser/start", {"url": "http://127.0.0.1:1/",
                    "profile": {"scope": scope, "profileId": profile_id, "expectedRevision": 1,
                                "operationId": "foreign-reference-" + str(uuid.uuid4())}}, raw_response=True)
                self.assertIn("error", rejected, rejected)
                self.assertIn(expected, rejected["error"]["message"], rejected)
                denied_codes.append(expected)
            self.assertEqual(snapshot(first_catalog), before, "Foreign requests cannot change original A storage")
            self.assertEqual(completed_page(second), [])

            second_saved = call(second, "save", {"draft": {"id": profile_id, "label": "Owner B",
                                "accountLabel": "User label only", "purpose": "business"},
                                "expectedRevision": 0}, mutation=True)
            self.assertEqual(second_saved["status"], "completed", second_saved)
            self.assertEqual([value["draft"]["label"] for value in completed_page(first)], ["Owner A"])
            self.assertEqual([value["draft"]["label"] for value in completed_page(second)], ["Owner B"])
            self.assertEqual((catalog(names[1]) / "profiles.json").stat().st_uid,
                             fixture.bindings[names[1]]["uid"])
            self.assertEqual(snapshot(first_catalog), before)
            observation = {
                "authenticatedAccounts": 2, "differentNativeAccountScopes": True,
                "actualUidOwnedFiles": [fixture.bindings[name]["uid"] for name in names],
                "sameNamedProfileIsolation": True, "ownCatalogAvailableBeforeNegative": True,
                "nativeChromiumPreflightAvailable": True, "foreignCatalogReadRejected": True,
                "foreignReferenceErrors": denied_codes, "originalStorageUnchanged": True,
                "browserLaunched": False, "websiteLogins": 0, "modelCalls": 0,
                "scope": "Real authenticated per-account UIDs; not a shared OS-user profile guarantee",
            }
        self.assertFalse(owned_root.exists())
        self.assertFalse(owned_code.exists())
        for name in owned_workers:
            with self.assertRaises(KeyError):
                pwd.getpwnam(name)
        observation["ownedWorkersAbsent"] = len(owned_workers)
        observation["ownedStateAndCodeAbsent"] = True
        print(json.dumps({"actualBrowserProfileIdentity": observation}))


if __name__ == "__main__":
    unittest.main()
