"""Bounded owned helper transport, separate from real Native accounting acceptance."""
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from studio_account_files import AccountError
from studio_organization_budget import _run


@unittest.skipUnless(os.geteuid() == 0, "Requires root-owned helper fixture")
class BudgetTransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kcoder-budget-transport-", dir="/usr/local/lib")
        self.addCleanup(self.temp.cleanup)
        self.program = Path(self.temp.name) / "owned-helper"
        shutil.copyfile(Path(__file__).parent / "fixtures/organization_budget_transport.py", self.program)
        self.program.chmod(0o700)

    def mode(self, value):
        Path(str(self.program) + ".mode").write_text(value, encoding="ascii")

    def test_valid_owned_helper_output_is_not_modified(self):
        self.mode("valid")
        self.assertEqual(_run(str(self.program), {"owned": True}), {"transportFixture": True})

    def test_blocked_input_pipe_is_bounded_and_child_is_reaped(self):
        self.mode("block")
        started = time.monotonic()
        with self.assertRaisesRegex(AccountError, "outcome is unknown"):
            _run(str(self.program), {"bounded": "x" * (100 * 1024)})
        self.assertLess(time.monotonic() - started, 5)

    def test_growth_past_original_output_limit_is_rejected(self):
        self.mode("overflow")
        with self.assertRaisesRegex(AccountError, "too large"):
            _run(str(self.program), {"owned": True})
