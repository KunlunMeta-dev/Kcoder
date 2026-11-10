"""Build evidence must not confuse cache hits, failures and source rebuilds."""

import importlib.util
from pathlib import Path
import unittest
import tempfile
import subprocess


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class BuildEvidenceTests(unittest.TestCase):
    def test_clean_revision_changes_invalidate_source_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args):
                return subprocess.check_output([
                    "git", "-c", "core.hooksPath=/dev/null",
                    "-c", "commit.gpgsign=false",
                    "-c", "user.name=Build Fixture",
                    "-c", "user.email=build-fixture@example.invalid", *args
                ], cwd=root, text=True).strip()
            git("init", "-q")
            source = root / "source.txt"
            source.write_text("first revision\n")
            git("add", "source.txt")
            git("commit", "-qm", "first")
            identity = module("cargo-build").source_identity
            first = identity(root)
            source.write_text("second revision\n")
            git("add", "source.txt")
            git("commit", "-qm", "second")
            self.assertEqual(git("status", "--porcelain"), "")
            self.assertNotEqual(first, identity(root))

    def test_target_isolation_does_not_hide_compiler_flag_changes(self):
        identity = module("cargo-build").build_environment_identity
        baseline = identity({"CARGO_TARGET_DIR": "/owned/before"})
        self.assertEqual(baseline, identity({"CARGO_TARGET_DIR": "/owned/after"}))
        for key in ["CARGO_ENCODED_RUSTFLAGS", "CARGO_INCREMENTAL",
                    "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS",
                    "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER"]:
            self.assertNotEqual(baseline, identity({key: "changed"}))

    def test_primary_checkout_cannot_be_cleaned(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / ".git").mkdir()
            with self.assertRaisesRegex(ValueError, "linked Git worktree"):
                module("cargo-build").checkout_target(root)

    def test_worktree_target_must_not_redirect_into_peer_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root, peer = base / "owned", base / "peer"
            root.mkdir()
            peer.mkdir()
            (root / ".git").write_text("gitdir: fixture\n")
            self.assertEqual(module("cargo-build").checkout_target(root), root / "target")
            (root / "target").symlink_to(peer, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "redirected build directory"):
                module("cargo-build").checkout_target(root)
            (root / "target").unlink()
            (root / "target").mkdir()
            (root / "target/debug").symlink_to(peer, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "redirected build directory"):
                module("cargo-build").checkout_target(root)

    def test_timing_data_ignores_other_javascript_arrays(self):
        data = module("cargo-build").timing_units(
            'const OTHER = [];\nconst UNIT_DATA = [{"name":"kcoder","duration":3.5}];\nconst NEXT = [];'
        )
        self.assertEqual(data[0]["duration"], 3.5)
        self.assertEqual(module("cargo-build").timing_units("incomplete build"), [])

    def test_failed_runs_cannot_become_a_speedup_baseline(self):
        report = module("cargo-build-report").render([
            dict(label="failed", scenario="package-rebuild", elapsed_seconds=1, exit_code=1),
            dict(label="before", scenario="package-rebuild", elapsed_seconds=100, exit_code=0),
            dict(label="after", scenario="package-rebuild", elapsed_seconds=80, exit_code=0),
            dict(label="cache-hit", scenario="as-is-cache", elapsed_seconds=1, exit_code=0),
            dict(label="running", scenario="package-rebuild"),
        ])
        self.assertIn("80.000s | -20.0% | 成功", report)
        self.assertIn("1.000s | +0.0% | 成功", report)
        self.assertIn("1.000s | — | 失败", report)
        self.assertIn("进行中／未完成", report)

    def test_toolchain_jobs_and_profile_changes_do_not_share_a_baseline(self):
        render = module("cargo-build-report").render
        first = dict(label="first", scenario="package-rebuild", elapsed_seconds=100,
                     exit_code=0, command=["cargo", "build", "--jobs", "6"])
        for key, value in [("command", ["cargo", "build", "--jobs", "12"]),
                           ("rustc", "different"), ("root_manifest_sha256", "different"),
                           ("build_environment_sha256", "different"), ("incremental", "0")]:
            second = dict(first, label="second", elapsed_seconds=1)
            second[key] = value
            self.assertNotIn("-99.0%", render([first, second]))

    def test_source_drift_cannot_be_reported_as_a_successful_speedup(self):
        report = module("cargo-build-report").render([
            dict(label="unstable", scenario="package-rebuild", elapsed_seconds=1,
                 exit_code=0, source_consistent=False),
        ])
        self.assertIn("源码在测量中变化", report)
        self.assertNotIn("+0.0%", report)


if __name__ == "__main__":
    unittest.main()
