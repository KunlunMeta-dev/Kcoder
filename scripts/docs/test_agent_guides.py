import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from agent_guides import guide_inventory
from check_documentation import check


class AgentGuideContracts(unittest.TestCase):
    def workspace(self):
        temporary = tempfile.TemporaryDirectory(prefix="kcoder-agent-guide-contract-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        (root / "docs").mkdir()
        return root

    def write_inventory(self, root, entries):
        (root / "docs/agent-guides.json").write_text(json.dumps({
            "schemaVersion": 1, "guides": entries,
        }))

    def guide(self, root, scope, parent=None):
        name = "AGENTS.md" if scope == "." else f"{scope}/AGENTS.md"
        file = root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        title = f"Guide for {scope}"
        file.write_text(f"# {title}\n\nScoped instructions.\n")
        return {"path": name, "scope": scope, "parent": parent, "title": title}

    def test_nested_scope_and_module_coverage(self):
        root = self.workspace()
        entries = [self.guide(root, "."), self.guide(root, "crates", "AGENTS.md"),
                   self.guide(root, "crates/new", "crates/AGENTS.md")]
        self.write_inventory(root, entries)
        paths, errors = guide_inventory(root, [{"path": "crates/new"}])
        self.assertEqual(errors, [])
        self.assertEqual(len(paths), 3)

    def test_missing_file_and_uncovered_module_are_not_completion(self):
        root = self.workspace()
        entries = [self.guide(root, "."), self.guide(root, "module", "AGENTS.md")]
        (root / "module/AGENTS.md").unlink()
        self.write_inventory(root, entries)
        _, errors = guide_inventory(root, [{"path": "new-module"}])
        self.assertIn("Missing required agent guide: module/AGENTS.md", errors)
        self.assertIn("Uncovered module agent guide: new-module", errors)

    def test_self_parent_skipped_ancestor_and_copied_title_are_rejected(self):
        root = self.workspace()
        entries = [self.guide(root, "."), self.guide(root, "crates", "crates/AGENTS.md"),
                   self.guide(root, "crates/new", "AGENTS.md")]
        (root / "crates/new/AGENTS.md").write_text((root / "AGENTS.md").read_text())
        self.write_inventory(root, entries)
        _, errors = guide_inventory(root, [])
        self.assertEqual(sum("parent must be nearest" in e for e in errors), 2)
        self.assertIn("Agent-guide title/scope drift: crates/new/AGENTS.md", errors)

    def test_escaping_mismatched_and_duplicate_scopes_are_rejected(self):
        root = self.workspace()
        entry = self.guide(root, ".")
        self.write_inventory(root, [entry, entry, {
            "path": "../outside/AGENTS.md", "scope": "../outside",
        }, {"path": "wrong/AGENTS.md", "scope": "other"}])
        _, errors = guide_inventory(root, [])
        self.assertTrue(any("Duplicate" in e for e in errors))
        self.assertTrue(any("Invalid agent-guide path/scope" in e for e in errors))
        self.assertTrue(any("scope does not match path" in e for e in errors))

    def test_uninventoried_tracked_guide_is_rejected(self):
        root = self.workspace()
        self.write_inventory(root, [self.guide(root, ".")])
        self.guide(root, "unlisted", "AGENTS.md")
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        _, errors = guide_inventory(root, [])
        self.assertIn("Uninventoried tracked agent guide: unlisted/AGENTS.md", errors)

    def test_malformed_inventory_is_an_actionable_failure(self):
        root = self.workspace()
        (root / "docs/agent-guides.json").write_text('{broken')
        _, errors = guide_inventory(root, [])
        self.assertTrue(errors[0].startswith("Cannot read agent-guide inventory:"))

    def test_public_snapshot_rejects_nested_private_guides(self):
        root = self.workspace()
        (root / "README.md").write_text("# KCoder\n")
        self.guide(root, "module", None)
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        errors = check(root, public_snapshot=True)
        self.assertIn("Public source snapshot contains private agent guide: module/AGENTS.md", errors)


if __name__ == "__main__":
    unittest.main()
