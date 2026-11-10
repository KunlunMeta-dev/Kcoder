"""Real directory identity checks; NSS identity is a declared fixture here."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_account_files import AccountError
from studio_organization_workspace import WorkspaceBudgetBinding


@unittest.skipUnless(os.geteuid() == 0, "Requires root-owned directory fixture")
class WorkspaceBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kcoder-budget-workspace-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / ".config").mkdir(mode=0o700)
        (self.home / ".config/kcoder").mkdir(mode=0o700)
        self.workspace = self.home / "workspace"
        self.workspace.mkdir(mode=0o700)
        self.identity = {"id": "owned-member"}
        self.binding = {"uid": 0, "home": str(self.home)}
        mocked = patch("studio_organization_workspace.validate_binding")
        mocked.start()
        self.addCleanup(mocked.stop)

    def test_original_handles_are_rechecked_and_replacement_is_not_adopted(self):
        scope = WorkspaceBudgetBinding(self.binding, self.identity, self.workspace)
        self.addCleanup(scope.close)
        self.assertTrue(scope.verify(self.identity).startswith("native-"))
        self.workspace.rename(self.home / "retained-original")
        self.workspace.mkdir(mode=0o700)
        with self.assertRaisesRegex(AccountError, "directory changed"):
            scope.verify(self.identity)

    def test_link_ancestor_and_other_principal_are_rejected(self):
        link = self.home / "linked-workspace"
        link.symlink_to(self.workspace, target_is_directory=True)
        with self.assertRaises(OSError):
            WorkspaceBudgetBinding(self.binding, self.identity, link)
        scope = WorkspaceBudgetBinding(self.binding, self.identity, self.workspace)
        self.addCleanup(scope.close)
        with self.assertRaisesRegex(AccountError, "owner changed"):
            scope.verify({"id": "other"})


if __name__ == "__main__":
    unittest.main()
