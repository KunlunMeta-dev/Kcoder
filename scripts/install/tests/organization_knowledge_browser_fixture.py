"""Drive owned real-account knowledge state for the registered browser acceptance."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1] / "lib")]
from organization_publication_fixture import Fixture
from studio_account_deploy import prepare
from studio_organization_publications import _resource


def snapshot(directory):
    return {str(path.relative_to(directory)): (path.stat().st_ino, path.stat().st_uid,
            hashlib.sha256(path.read_bytes()).hexdigest())
            for path in directory.rglob("*") if path.is_file() and path.name != "catalog.lock"}


def main():
    if os.geteuid() != 0 or os.environ.get("KCODER_TEST_SYSTEM_USERS") != "1":
        raise RuntimeError("Explicit owned real-UID gate required")
    case = unittest.TestCase()
    cleanup_complete = False
    fixture = None
    try:
        fixture = Fixture(case, governed=False)
        prepare(fixture.installed / "entry", Path(__file__).resolve().parents[1])
        original = fixture.session("reader")
        source = fixture.seed("reader")
        identity = "owned-browser-fixed-reference"
        draft = {"publicationId": identity, "title": "Original reader fixed knowledge",
                 "purpose": "Explicit current organization adoption", "reviewConclusion": None,
                 "visibility": "personal", "audienceId": None, "sources": [source["source"]],
                 "validFromMs": None, "validUntilMs": None, "unresolved": []}
        publication = original.call("publishKnowledge", {"draft": draft}, True, 0)
        case.assertEqual(publication["status"], "completed", publication)
        reference = {"owner": publication["result"]["publication"]["owner"],
                     "publicationId": identity, "version": 1}
        adoption = original.call("adoptPublication", reference, True, 0)
        case.assertEqual(adoption["status"], "completed", adoption)
        original.stop()
        profile = Path(fixture.bindings["reader"]["home"]) / ".config/kcoder"
        namespace = next(path for path in profile.iterdir() if path.is_dir()
                         and (path / "catalog-binding.json").exists())
        old_source = snapshot(namespace)
        fixture.enter_organization()
        current, publisher = fixture.session("reader"), fixture.session("publisher")
        fixture.policy.administer(None, {"operation": "organization.resource", "expectedRevision": fixture.policy._load()["revision"],
            "resource": {"id": current.scope["workspaceId"], "kind": "workspace", "owner": fixture.identities["reader"]["id"],
                         "visibility": "private", "grants": []}})
        for name, session in (("reader", current), ("publisher", publisher)):
            fixture.resource(name, session.owner, "knowledge", "current-target")
        fixture.resource("administrator", reference["owner"], "publication", identity,
                         readers=("reader",))
        other_source = fixture.seed("publisher")
        fixture.resource("publisher", publisher.owner, "publication", identity, readers=("reader",))
        fixture.resource("publisher", publisher.owner, "knowledge-audience",
                         json.dumps(["organization", fixture.organization], separators=(",", ":")))
        other_draft = {**draft, "title": "Other publisher same identifier", "visibility": "organization",
                       "audienceId": fixture.organization, "sources": [other_source["source"]]}
        other = publisher.call("publishKnowledge", {"draft": other_draft}, True, 0)
        case.assertEqual(other["status"], "completed", other)
        directory = current.call("listPublications", {"after": None})
        case.assertEqual(directory["status"], "completed", directory)
        case.assertEqual(len(directory["result"]["page"]["items"]), 2)
        current.stop()
        print(json.dumps({"ready": True, "entry": str(fixture.installed / "entry/bin/studio-account-entry.py"),
                          "state": str(fixture.accounts.root), "homes": str(fixture.root / "homes"),
                          "runtime": fixture.programs[0], "workspace": str(Path(fixture.bindings["reader"]["home"]) / "workspace"),
                          "readerUid": fixture.bindings["reader"]["uid"], "publisherUid": fixture.bindings["publisher"]["uid"],
                          "workspaceResourceId": current.scope["workspaceId"], "readerPrincipalId": fixture.identities["reader"]["id"],
                          "sourceResourceId": _resource(reference["owner"], identity),
                          "reference": reference, "currentOwner": current.owner,
                          "originalTitle": draft["title"], "otherTitle": other_draft["title"],
                          "runtimeSha256": hashlib.sha256(Path(fixture.programs[0]).read_bytes()).hexdigest()}), flush=True)

        def stop(*_):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        for line in sys.stdin:
            request = json.loads(line)
            operation = request.get("operation")
            if operation == "stop":
                break
            if operation == "inspect":
                observer = fixture.session("reader")
                try:
                    items = observer.call("listAdoptions", {"after": None})
                    case.assertEqual(items["status"], "completed", items)
                    records = items["result"]["page"]["items"]
                    result = {"records": records, "originalSourceUnchanged": snapshot(namespace) == old_source,
                              "scope": observer.scope}
                finally:
                    observer.stop()
            elif operation == "revoke":
                fixture.resource("administrator", reference["owner"], "publication", identity)
                result = {"revoked": True}
            elif operation == "allow":
                fixture.resource("administrator", reference["owner"], "publication", identity,
                                 readers=("reader",))
                result = {"allowed": True}
            elif operation == "execution-inspect":
                result = {"executionPolicy": fixture.policy._load().get("executionPolicy"),
                          "policyRevision": fixture.policy._load()["revision"], "originalSourceUnchanged": snapshot(namespace) == old_source}
            elif operation == "source-inspect":
                policy = fixture.policy._load()
                resource_id = _resource(reference["owner"], identity)
                result = {"resource": policy["resources"][resource_id],
                          "managementOwnerCanRead": fixture.policy._allowed(policy,
                              fixture.identities["administrator"], "read", resource_id, None),
                          "originalSourceUnchanged": snapshot(namespace) == old_source}
            elif operation == "budget-inspect":
                from studio_organization_budget import inspect as inspect_budget
                report = inspect_budget(fixture.accounts, fixture.programs[0],
                                        expected_revision=fixture.policy._load()["revision"])
                ledger = fixture.accounts.root / "organization-budget/ledger.json"
                result = {"report": report, "ledgerSha256": hashlib.sha256(ledger.read_bytes()).hexdigest()}
            elif operation == "policy-backup-restore":
                program = fixture.installed / "entry/bin/studio-account.py"
                backup = fixture.root / "owned-policy-backup.json"
                before_bindings = fixture.accounts._load()["bindings"]
                ledger = fixture.accounts.root / "organization-budget/ledger.json"
                before_ledger = (ledger.stat().st_ino, hashlib.sha256(ledger.read_bytes()).hexdigest())
                command = [sys.executable, "-I", str(program), "--state-directory", str(fixture.accounts.root)]
                subprocess.run([*command, "organization-backup", "--output", str(backup)],
                               check=True, capture_output=True, timeout=10)
                bundle = json.loads(backup.read_text())
                case.assertEqual(set(bundle) - {"executionPolicy"},
                                 {"format", "version", "organizationId", "sourceRevision", "members", "resources"})
                case.assertTrue(all(set(member) == {"roles", "disabled"} for member in bundle["members"].values()))
                marker = "artifact:owned-recovery-marker"
                fixture.policy.administer(None, {"operation": "organization.resource",
                    "expectedRevision": fixture.policy._load()["revision"],
                    "resource": {"id": marker, "kind": "artifact", "owner": fixture.identities["administrator"]["id"],
                                 "visibility": "private", "grants": []}})
                revision = fixture.policy._load()["revision"]
                subprocess.run([*command, "organization-restore", "--input", str(backup),
                                "--expected-revision", str(revision)], check=True, capture_output=True, timeout=10)
                case.assertNotIn(marker, fixture.policy._load()["resources"])
                case.assertEqual(fixture.accounts._load()["bindings"], before_bindings)
                case.assertEqual((ledger.stat().st_ino, hashlib.sha256(ledger.read_bytes()).hexdigest()), before_ledger)
                case.assertEqual(snapshot(namespace), old_source)
                result = {"installedOperatorBackupRestore": True, "portableMetadataOnly": True,
                          "originalWorkerBindingsUnchanged": True, "originalBudgetJournalUnchanged": True,
                          "originalSourceUnchanged": True}
            else:
                raise RuntimeError("Unknown owned knowledge control")
            print(json.dumps({"id": request["id"], **result}), flush=True)
    finally:
        try:
            if fixture is not None:
                fixture.__exit__(None, None, None)
                cleanup_complete = True
        finally:
            print(json.dumps({"cleanupComplete": cleanup_complete}), flush=True)


if __name__ == "__main__":
    main()
