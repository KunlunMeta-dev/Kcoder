import json
from pathlib import Path
import tempfile
import unittest

from check_quality_contracts import check, covered_cli_targets, ignored_differences


class QualityContracts(unittest.TestCase):
    def workspace(self):
        temporary = tempfile.TemporaryDirectory(prefix="kcoder-quality-contract-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for name in ("apps/kcoder-studio", "apps/kcoder-studio/renderer"):
            directory = root / name
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "package.json").write_text(json.dumps({"packageManager": "pnpm@11.24.0"}))
        (root / ".github/workflows").mkdir(parents=True)
        (root / ".github/workflows/ci.yml").write_text('name: CI\njobs:\n  rust:\n    steps:\n      - run: |\n          corepack prepare pnpm@11.24.0 --activate\n          pnpm --dir apps/kcoder-studio install\n')
        (root / "crates/kcoder_cli/tests").mkdir(parents=True)
        (root / "crates/kcoder_cli/Cargo.toml").write_text('[package]\nname="kcoder_cli"\nversion="0.1.0"\n')
        (root / "crates/kcoder_cli/tests/contract.rs").write_text('// Public integration fixture.\n')
        (root / "tests").mkdir()
        (root / "tests/matrix.toml").write_text('[[suite]]\nid="rust-workspace"\ntiers=["pr","full"]\ncommand=["cargo","test","--workspace","--exclude","kcoder_cli"]\nsummary={expected_skips={linux=0}}\n\n[[suite]]\nid="cli-contract"\ntiers=["pr","full"]\ncommand=["cargo","test","-p","kcoder_cli","--test","contract"]\n')
        (root / "tests/ignored-tests.linux.json").write_text('{"schemaVersion":1,"platform":"linux","cases":[]}')
        return root

    def test_valid_contracts_and_new_target_without_a_suite(self):
        root = self.workspace()
        self.assertEqual(check(root), [])
        (root / "crates/kcoder_cli/tests/new_contract.rs").write_text('// New target.\n')
        errors = check(root)
        self.assertEqual(len(errors), 2)
        self.assertTrue(all("new_contract" in error for error in errors))

    def test_clippy_and_bin_tests_do_not_cover_integration_targets(self):
        targets = {"contract"}
        for command in [["cargo", "clippy", "--workspace", "--all-targets"],
                        ["cargo", "test", "-p", "kcoder_cli", "--bin", "kcoder"],
                        ["cargo", "test", "--workspace", "--exclude", "kcoder_cli"]]:
            self.assertEqual(covered_cli_targets(command, targets), set())
        self.assertEqual(covered_cli_targets(["cargo", "test", "-p", "kcoder_cli"], targets), targets)

    def test_unpinned_or_divergent_package_manager_is_rejected(self):
        root = self.workspace()
        (root / "apps/kcoder-studio/renderer/package.json").write_text('{"packageManager":"pnpm@12.0.0"}')
        self.assertTrue(any("disagree" in error for error in check(root)))
        (root / "apps/kcoder-studio/package.json").write_text('{}')
        self.assertTrue(any("exact pnpm" in error for error in check(root)))

    def test_a_new_pnpm_job_must_pin_the_same_version(self):
        root = self.workspace()
        with (root / ".github/workflows/ci.yml").open("a") as file:
            file.write('  new-job:\n    steps:\n      - run: pnpm --dir apps/kcoder-studio/renderer build\n')
        self.assertIn("Unpinned pnpm job: new-job", check(root))

    def test_equal_skip_count_cannot_hide_replaced_ignored_cases(self):
        errors = ignored_differences(["old_case"], "new_case: test\n\n1 test, 0 benchmarks\n")
        self.assertEqual(len(errors), 2)
        self.assertIn("Unreviewed ignored cases: new_case", errors)
        self.assertEqual(ignored_differences(["known"], "known: test\n"), [])

    def test_policy_and_named_roster_must_agree(self):
        root = self.workspace()
        (root / "tests/ignored-tests.linux.json").write_text('{"cases":["new_case"]}')
        self.assertIn("Linux ignored count disagrees with the reviewed named roster", check(root))


if __name__ == "__main__":
    unittest.main()
