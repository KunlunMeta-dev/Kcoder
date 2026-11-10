"""Exercise artifact ownership using real, isolated Git worktrees."""
import os
import json
import hashlib
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class WorktreeArtifacts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kcoder-artifact-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.script = self.root / "scripts/launch/worktree.sh"
        self.script.parent.mkdir(parents=True)
        shutil.copy2(ROOT / "scripts/launch/worktree.sh", self.script)
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "fixture")
        self.checkout = self.root / "target/worktree/dev"
        self.git("worktree", "add", "--detach", str(self.checkout), "HEAD")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              capture_output=True, text=True)

    def allocate(self, cwd, *extra, check=True):
        return subprocess.run(["bash", str(self.script), "artifact", "verification", "owner", *extra],
                              cwd=cwd, capture_output=True, text=True, check=check)

    def test_create_dev_reuses_matching_branch_without_sharing_configuration(self):
        self.git("worktree", "remove", str(self.checkout))
        self.git("branch", "codex/workspace-dev", "HEAD")
        source = self.root / ".env"
        source.write_text("KCODER_RELAY_REGISTRATION_KEY=fixture-first\n")
        source.chmod(0o600)
        command = ["bash", str(self.script), "create", "dev", "HEAD"]
        subprocess.run(command, cwd=self.root, check=True, capture_output=True, text=True)
        self.assertFalse((self.checkout / ".env").is_symlink())
        self.assertFalse((self.checkout / ".env").exists())
        self.assertFalse((self.checkout / "target/home").exists())
        self.assertFalse((self.checkout / "target/studio/relay").exists())
        subprocess.run(command, cwd=self.root, check=True, capture_output=True, text=True)
        self.assertEqual(source.read_text(), "KCODER_RELAY_REGISTRATION_KEY=fixture-first\n")

    def test_create_dev_preserves_a_branch_at_another_revision(self):
        self.git("worktree", "remove", str(self.checkout))
        self.git("branch", "codex/workspace-dev", "HEAD")
        original = self.git("rev-parse", "codex/workspace-dev").stdout.strip()
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--allow-empty", "-qm", "next")
        result = subprocess.run(["bash", str(self.script), "create", "dev", "HEAD"],
                                cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git("rev-parse", "codex/workspace-dev").stdout.strip(), original)

    def test_default_follows_calling_checkout_and_keeps_private_unique_runs(self):
        first = Path(self.allocate(self.checkout).stdout.strip())
        second = Path(self.allocate(self.checkout).stdout.strip())
        self.assertTrue(first.is_relative_to(self.checkout / "target/verification"))
        self.assertRegex(str(first.relative_to(self.checkout)),
                         r"^target/verification/\d{4}/\d{2}/\d{2}/owner\.[A-Za-z0-9]+$")
        self.assertNotEqual(first, second)
        self.assertEqual(first.stat().st_mode & 0o777, 0o700)
        self.assertFalse((self.root / "target/verification").exists())

    def test_explicit_owner_works_from_primary_checkout(self):
        path = Path(self.allocate(self.root, "--checkout", str(self.checkout)).stdout.strip())
        self.assertTrue(path.is_relative_to(self.checkout / "target/verification"))

    def test_unregistered_owner_and_symlink_escape_are_rejected(self):
        other = Path(self.temp.name) / "unrelated"
        other.mkdir()
        self.assertNotEqual(self.allocate(self.root, "--checkout", str(other), check=False).returncode, 0)
        (self.checkout / "target").mkdir()
        (self.checkout / "target/verification").symlink_to(other, target_is_directory=True)
        self.assertNotEqual(self.allocate(self.checkout, check=False).returncode, 0)
        self.assertEqual(list(other.iterdir()), [])

    def prepare_launcher(self):
        launcher = self.root / "scripts/launch/studio-workspace.mjs"
        shutil.copy2(ROOT / "scripts/launch/studio-workspace.mjs", launcher)
        identity_module = self.root / "apps/kcoder-relay/src/client-identity.mjs"
        identity_module.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "apps/kcoder-relay/src/client-identity.mjs", identity_module)
        for relative, source in {
            "apps/kcoder-relay/src/local-update-files.mjs":
                "export const inspectMobile=()=>{}; export const systemdQuote=JSON.stringify;",
            "apps/kcoder-relay/deploy/config.mjs":
                "export const createRelayUrls=({publicUrl,gatewayId})=>({gatewayBase:new URL('/g/'+gatewayId,publicUrl)});",
        }.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source)
        (self.root / "apps/kcoder-studio/mobile").mkdir(parents=True)
        self.runtime = self.checkout / "target"
        (self.runtime / "studio").mkdir(parents=True)
        (self.runtime / "studio/.env.launch").write_text("")
        (self.runtime / "studio/.env.launch").chmod(0o600)
        (self.runtime / "debug").mkdir()
        programs = self.root / "fixture-bin"
        programs.mkdir()
        units = self.root / "fixture-units"
        units.mkdir()
        unit_dir = shlex.quote(str(units))
        scripts = {
            "systemctl": f'if [ "$2" = is-active ]; then test -f {unit_dir}/"$4"; else exit 0; fi',
            "systemd-run": f'for a in "$@"; do case "$a" in --unit=*) touch {unit_dir}/"${{a#--unit=}}";; esac; done',
            "curl": "printf 200",
            "npm": "exit 0",
        }
        for name, body in scripts.items():
            path = programs / name
            path.write_text("#!/bin/sh\n" + body + "\n")
            path.chmod(0o755)
        binary = self.runtime / "debug/kcoder"
        binary.write_text('#!/bin/sh\nprintf "%s\\n" "$KCODER_HOME" "$KCODER_CONFIG_DIR" "$TMPDIR" > '
                          + shlex.quote(str(self.root / "observed-paths")) + '\n')
        binary.chmod(0o755)
        # A stale project-wide value must never silently select runtime state.
        (self.root / ".env").write_text("KCODER_WORKSPACE_DEBUG_HOME=/obsolete\nKCODER_RELAY_KCODER_BIN=/obsolete/kcoder\n")
        return launcher, os.environ | {"PATH": str(programs) + os.pathsep + os.environ["PATH"]}

    def test_launcher_uses_private_profile_and_owned_home_workspace_tmp(self):
        launcher, env = self.prepare_launcher()
        result = subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                                env=env, capture_output=True, text=True, check=True)
        record = json.loads(result.stdout)
        self.assertEqual(record["home"], str(self.runtime / "home"))
        self.assertEqual(record["workspace"], str(self.runtime / "workspace"))
        self.assertEqual(record["binary"], str(self.runtime / "debug/kcoder"))
        self.assertEqual((self.root / "observed-paths").read_text().splitlines(),
                         [str(self.runtime / "home"), str(self.runtime / "home"), str(self.runtime / "tmp")])

    def test_launcher_reuses_selected_relay_profile_without_shared_enrollment_key(self):
        launcher, env = self.prepare_launcher()
        state = self.runtime / "studio"
        profile = state / "relay-profiles/00000000-0000-4000-8000-000000000001"
        profile.mkdir(parents=True)
        identity = profile / "client-identity.json"
        identity.write_text(json.dumps({"id": "selected-gateway"}))
        credential = profile / "gateway-secret"
        credential.write_text("private-fixture-credential-" * 3)
        credential.chmod(0o600)
        (state / "desktop-relay.json").write_text(json.dumps({"selectedProfile": "00000000-0000-4000-8000-000000000001"}))
        module = self.root / "apps/kcoder-studio/src/gateway-relay-instance.js"
        module.parent.mkdir(parents=True)
        module.write_text("export async function prepareGatewayRelay() { return " + json.dumps({
            "relayOrigin": "https://selected-relay.example",
            "identityFile": str(identity), "gatewaySecretFile": str(credential),
        }) + "; }")
        arguments = self.root / "systemd-arguments"
        units = self.root / "fixture-units"
        program = self.root / "fixture-bin/systemd-run"
        program.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" >> " + shlex.quote(str(arguments))
                           + "\nfor a in \"$@\"; do case \"$a\" in --unit=*) touch "
                           + shlex.quote(str(units)) + '/"${a#--unit=}";; esac; done\n')
        program.chmod(0o755)
        result = subprocess.run(["node", str(launcher), "dev", "start", "--relay"], cwd=self.root,
                                env=env, capture_output=True, text=True, check=True)
        record = json.loads(result.stdout)
        self.assertEqual(record["publicGateway"], "https://selected-relay.example/g/selected-gateway")
        captured = arguments.read_text()
        self.assertIn("KCODER_RELAY_GATEWAY_SECRET_FILE=" + str(credential), captured)
        self.assertNotIn(credential.read_text(), captured)
        self.assertFalse((state / "registration.env").exists())

    def test_launcher_rejects_legacy_private_profile_override(self):
        launcher, env = self.prepare_launcher()
        (self.runtime / "studio/.env.launch").write_text("KCODER_WORKSPACE_DEBUG_HOME=/obsolete\n")
        result = subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("remove legacy", result.stderr)
        self.assertEqual(list((self.root / "fixture-units").iterdir()), [])

    def test_configure_initializes_once_from_root_env_or_single_example(self):
        launcher, env = self.prepare_launcher()
        for use_example in [False, True]:
            with self.subTest(use_example=use_example):
                launch = self.runtime / "studio/.env.launch"
                launch.unlink()
                source = self.root / ".env"
                example = self.root / ".env.example"
                expected = "KCODER_RELAY_PUBLIC_URL=https://relay.example\nKCODER_RELAY_REGISTRATION_KEY=fixture\n"
                example.write_text(expected if use_example else "WRONG_SOURCE=1\n")
                if use_example:
                    source.unlink()
                else:
                    source.write_text(expected)
                command = ["node", str(launcher), "dev", "configure"]
                subprocess.run(command, cwd=self.root, env=env, capture_output=True, text=True, check=True)
                self.assertEqual(launch.read_text(), expected)
                self.assertFalse(launch.is_symlink())
                self.assertEqual(launch.stat().st_mode & 0o777, 0o600)
                source.write_text("KCODER_RELAY_PUBLIC_URL=https://changed.example\n")
                example.write_text("WRONG_SOURCE=2\n")
                subprocess.run(command, cwd=self.root, env=env, capture_output=True, text=True, check=True)
                self.assertEqual(launch.read_text(), expected)

    def test_legacy_launch_config_moves_without_changing_content_or_identity(self):
        launcher, env = self.prepare_launcher()
        current = self.runtime / "studio/.env.launch"
        legacy = self.runtime / "studio/launch.env"
        current.rename(legacy)
        legacy.write_text("KCODER_WORKSPACE_DEBUG_PORT=5483\n")
        before = legacy.stat()
        result = subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                                env=env, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["gateway"], "http://127.0.0.1:5483")
        self.assertFalse(legacy.exists())
        self.assertEqual(current.stat().st_ino, before.st_ino)
        self.assertEqual(current.stat().st_mode, before.st_mode)
        self.assertEqual(current.stat().st_nlink, 1)
        self.assertEqual(current.read_text(), "KCODER_WORKSPACE_DEBUG_PORT=5483\n")

    def test_different_launch_configs_are_preserved_and_rejected(self):
        launcher, env = self.prepare_launcher()
        legacy = self.runtime / "studio/launch.env"
        legacy.write_text("KCODER_WORKSPACE_DEBUG_PORT=5483\n")
        legacy.chmod(0o600)
        result = subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Both .env.launch and legacy launch.env exist", result.stderr)
        self.assertEqual(legacy.read_text(), "KCODER_WORKSPACE_DEBUG_PORT=5483\n")
        self.assertEqual((self.runtime / "studio/.env.launch").read_text(), "")
        self.assertEqual(list((self.root / "fixture-units").iterdir()), [])

    def test_interrupted_launch_config_move_can_finish(self):
        launcher, env = self.prepare_launcher()
        current = self.runtime / "studio/.env.launch"
        legacy = self.runtime / "studio/launch.env"
        os.link(current, legacy)
        subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                       env=env, capture_output=True, text=True, check=True)
        self.assertFalse(legacy.exists())
        self.assertEqual(current.stat().st_nlink, 1)

    def test_launch_configuration_stays_independent_of_project_env_changes(self):
        launcher, env = self.prepare_launcher()
        source = self.root / ".env"
        (self.runtime / "studio/.env.launch").write_text("KCODER_WORKSPACE_DEBUG_PORT=5483\n")
        for shared_port in [5283, 5383]:
            source.write_text(f"KCODER_WORKSPACE_DEBUG_PORT={shared_port}\n"
                              "KCODER_WORKSPACE_DEBUG_HOME=/obsolete\n"
                              "KCODER_RELAY_KCODER_BIN=/obsolete/kcoder\n")
            for unit in (self.root / "fixture-units").iterdir():
                unit.unlink()
            result = subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                                    env=env, capture_output=True, text=True, check=True)
            record = json.loads(result.stdout)
            self.assertEqual(record["gateway"], "http://127.0.0.1:5483")
            self.assertEqual(record["home"], str(self.runtime / "home"))
            self.assertEqual(record["binary"], str(self.runtime / "debug/kcoder"))

    def test_launcher_does_not_relocate_relay_identity_while_instance_is_active(self):
        launcher, env = self.prepare_launcher()
        instance = hashlib.sha256(str(self.root).encode()).hexdigest()[:12]
        (self.root / f"fixture-units/kcoder-workspace-{instance}-dev-gateway.service").touch()
        legacy = self.runtime / "studio/relay-identity.json"
        legacy.write_text("original identity must not be touched")
        old_config = self.runtime / "studio/launch.env"
        (self.runtime / "studio/.env.launch").rename(old_config)
        result = subprocess.run(["node", str(launcher), "dev", "start", "--relay"], cwd=self.root,
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Instance is active", result.stderr)
        self.assertEqual(legacy.read_text(), "original identity must not be touched")
        self.assertTrue(old_config.exists())
        self.assertFalse((self.runtime / "studio/.env.launch").exists())
        self.assertFalse((self.runtime / "studio/relay/client-identity.json").exists())

    def test_relay_start_reuses_the_original_id_at_the_shared_relative_path(self):
        launcher, env = self.prepare_launcher()
        state = self.runtime / "studio"
        registration_key = "registration-fixture-key-" * 3
        gateway_secret = "a" * 64
        (state / ".env.launch").write_text(
            "KCODER_RELAY_PUBLIC_URL=https://relay.example\n"
            f"KCODER_RELAY_REGISTRATION_KEY={registration_key}\n")
        registration = state / "registration.env"
        registration.write_text(f"KCODER_RELAY_REGISTRATION_KEY={registration_key}\n"
                                f"KCODER_RELAY_GATEWAY_SECRET={gateway_secret}\n")
        registration.chmod(0o600)
        legacy = state / "relay-identity.json"
        original = json.dumps({"version": 1, "relayOrigin": "https://relay.example",
                               "gatewaySecretHash": hashlib.sha256(gateway_secret.encode()).hexdigest(),
                               "id": "original-fixture-id", "secret": "b" * 64}).encode()
        legacy.write_bytes(original)
        legacy.chmod(0o600)
        result = subprocess.run(["node", str(launcher), "dev", "start", "--relay"], cwd=self.root,
                                env=env, capture_output=True, text=True, check=True)
        record = json.loads(result.stdout)
        self.assertEqual(record["publicGateway"], "https://relay.example/g/original-fixture-id")
        self.assertEqual((state / "relay/client-identity.json").read_bytes(), original)
        self.assertFalse(legacy.exists())
        self.assertIn(gateway_secret, registration.read_text())


if __name__ == "__main__":
    unittest.main()
