"""Source-launcher input validation uses Cargo's dependency graph."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class LauncherContracts(unittest.TestCase):
    def test_cargo_checks_skills_and_path_dependencies_on_every_source_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'target/debug').mkdir(parents=True)
            (root / 'skills/example').mkdir(parents=True)
            (root / 'third_party/sdk').mkdir(parents=True)
            (root / 'crates/example').mkdir(parents=True)
            for path in ['Cargo.toml', 'Cargo.lock', 'skills/example/SKILL.md', 'third_party/sdk/lib.rs', 'crates/example/lib.rs']:
                (root / path).write_text('fixture')
            binary = root / 'target/debug/kcoder'
            binary.write_text('#!/bin/sh\ncase "$*" in *auth*) echo login;; *) echo --provider;; esac\n')
            binary.chmod(0o755)
            (root / 'target/release').mkdir()
            release = root / 'target/release/kcoder'
            release.write_text(binary.read_text())
            release.chmod(0o755)
            (root / 'bin').mkdir()
            cargo = root / 'bin/cargo'
            cargo.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$KCODER_FIXTURE_CALLS"\n')
            cargo.chmod(0o755)
            env = os.environ | {'PATH':str(root / 'bin') + os.pathsep + os.environ['PATH'], 'KCODER_REPO_DIR':directory, 'KCODER_FIXTURE_CALLS':str(root / 'calls')}
            command = ['bash', '-c', 'source "$1"; kcoder_prepare_binary "$2"', 'fixture', str(ROOT / 'scripts/install/lib/binary.sh')]
            for changed in [None, 'skills/example/SKILL.md', 'third_party/sdk/lib.rs', 'crates/example/lib.rs']:
                if changed:
                    (root / changed).write_text('changed')
                subprocess.run(command + ['debug'], env=env, check=True, capture_output=True)
            calls = (root / 'calls').read_text().splitlines()
            self.assertEqual(len(calls), 4)
            self.assertTrue(all('--locked' in call for call in calls))
            subprocess.run(command + ['latest'], env=env, check=True, capture_output=True)
            self.assertEqual((root / 'calls').read_text().splitlines(), calls)
            subprocess.run(command + ['debug'], env=env | {'KCODER_REAL_BIN':str(binary)}, check=True, capture_output=True)
            self.assertEqual((root / 'calls').read_text().splitlines(), calls)


if __name__ == '__main__':
    unittest.main()
