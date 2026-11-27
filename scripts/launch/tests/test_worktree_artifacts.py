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

ROOT = Path(__file__).resolve().parents[3]


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

    def test_default_follows_calling_checkout_and_keeps_unique_runs(self):
        first = Path(self.allocate(self.checkout).stdout.strip())
        second = Path(self.allocate(self.checkout).stdout.strip())
        self.assertTrue(first.is_relative_to(self.checkout / "target/verification"))
        self.assertRegex(str(first.relative_to(self.checkout)),
                         r"^target/verification/\d{4}/\d{2}/\d{2}/owner\.[A-Za-z0-9]+$")
        self.assertNotEqual(first, second)
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
        runtime = self.root / "apps/kcoder-studio/src/gateway-relay-instance.js"
        runtime.parent.mkdir(parents=True, exist_ok=True)
        runtime.write_text("export async function readRelayConfiguration(){return null;} "
                           "export async function prepareGatewayRelay(){return null;}")
        self.runtime = self.checkout / "target"
        (self.runtime / "studio").mkdir(parents=True)
        (self.runtime / "debug").mkdir()
        (self.runtime / "native/debug").mkdir(parents=True)
        # The fake service checks source selection, not native library loading.
        (self.runtime / "native/debug/libkcoder_native_storage.so").write_bytes(b"fixture native storage addon")
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
        self.service_observations = self.root / "service-environments.jsonl"
        program = programs / "systemd-run"
        program.write_text("#!/usr/bin/env python3\nimport os,sys,json,pathlib\n"
            "keys=[a.removeprefix('--setenv=') for a in sys.argv if a.startswith('--setenv=')]\n"
            "unit=next(a.removeprefix('--unit=') for a in sys.argv if a.startswith('--unit='))\n"
            "with open(" + repr(str(self.service_observations)) + ", 'a') as f: f.write(json.dumps({'unit':unit,'argv':sys.argv,'env':{k:os.environ[k] for k in keys}})+'\\n')\n"
            "pathlib.Path(" + repr(str(units)) + ",unit).touch()\n")
        program.chmod(0o755)
        binary = self.runtime / "debug/kcoder"
        binary.write_text('#!/bin/sh\nprintf "%s\\n" "$KCODER_HOME" "$KCODER_CONFIG_DIR" "$TMPDIR" > '
                          + shlex.quote(str(self.root / "observed-paths")) + '\n')
        binary.chmod(0o755)
        (self.root / ".env").write_text("")
        return launcher, os.environ | {"PATH": str(programs) + os.pathsep + os.environ["PATH"]}

    def test_launcher_uses_private_profile_and_owned_home_workspace_tmp(self):
        launcher, env = self.prepare_launcher()
        addon = self.runtime / "native/debug/libkcoder_native_storage.so"
        original_addon = addon.read_bytes()
        addon.unlink()
        missing = subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                                 env=env, capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("Build the Dev Native storage addon", missing.stderr)
        self.assertFalse((self.runtime / "home").exists())
        self.assertFalse(self.service_observations.exists())
        addon.write_bytes(original_addon)
        result = subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                                env=env, capture_output=True, text=True, check=True)
        record = json.loads(result.stdout)
        self.assertEqual(record["home"], str(self.runtime / "home"))
        self.assertEqual(record["workspace"], str(self.runtime / "workspace"))
        self.assertEqual(record["binary"], str(self.runtime / "debug/kcoder"))
        self.assertEqual((self.root / "observed-paths").read_text().splitlines(),
                         [str(self.runtime / "home"), str(self.runtime / "home"), str(self.runtime / "tmp")])
        services = [json.loads(line) for line in self.service_observations.read_text().splitlines()]
        gateway = next(row for row in services if row["unit"].endswith("-gateway.service"))
        self.assertEqual(gateway["env"]["KCODER_TARGET_DIR"], str(self.runtime / "native"))

    def test_recover_starts_only_the_missing_gateway_and_keeps_peer_services(self):
        launcher, env = self.prepare_launcher()
        command = ["node", str(launcher), "dev", "start"]
        subprocess.run(command, cwd=self.root, env=env, check=True, capture_output=True, text=True)
        instance = hashlib.sha256(str(self.root).encode()).hexdigest()[:12]
        prefix = f"kcoder-workspace-{instance}-dev"
        units = self.root / "fixture-units"
        (units / f"{prefix}-gateway.service").unlink()
        (units / f"{prefix}-relay.service").touch()
        peers = {name: (units / f"{prefix}-{name}.service").stat().st_ino for name in ["expo", "relay"]}
        home_identity = (self.runtime / "home").stat().st_ino
        config = self.root / ".env"
        before = config.read_bytes()
        arguments = self.root / "recovery-arguments"
        program = self.root / "fixture-bin/systemd-run"
        program.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" >> " + shlex.quote(str(arguments))
                           + "\nfor a in \"$@\"; do case \"$a\" in --unit=*) touch "
                           + shlex.quote(str(units)) + '/"${a#--unit=}";; esac; done\n')
        program.chmod(0o755)
        result = subprocess.run(command + ["--recover"], cwd=self.root, env=env,
                                check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout)["home"], str(self.runtime / "home"))
        captured = arguments.read_text()
        self.assertEqual(captured.count("--unit="), 1)
        self.assertIn(f"--unit={prefix}-gateway.service", captured)
        self.assertIn("--property=Restart=on-failure", captured)
        self.assertIn("--property=RestartSec=3s", captured)
        self.assertEqual(config.read_bytes(), before)
        self.assertEqual((self.runtime / "home").stat().st_ino, home_identity)
        self.assertEqual({name: (units / f"{prefix}-{name}.service").stat().st_ino for name in peers}, peers)

    def test_recover_rejects_a_different_recorded_home_before_starting_services(self):
        launcher, env = self.prepare_launcher()
        command = ["node", str(launcher), "dev", "start"]
        subprocess.run(command, cwd=self.root, env=env, check=True, capture_output=True, text=True)
        instance = hashlib.sha256(str(self.root).encode()).hexdigest()[:12]
        gateway = self.root / f"fixture-units/kcoder-workspace-{instance}-dev-gateway.service"
        gateway.unlink()
        record_file = self.runtime / "studio/launch.json"
        record = json.loads(record_file.read_text())
        record["home"] = str(self.root / "other-home")
        record_file.write_text(json.dumps(record))
        result = subprocess.run(command + ["--recover"], cwd=self.root, env=env,
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Recovery does not match", result.stderr)
        self.assertFalse(gateway.exists())
        self.assertFalse((self.root / "other-home").exists())

    def test_launcher_reuses_selected_relay_profile_without_shared_enrollment_key(self):
        launcher, env = self.prepare_launcher()
        state = self.runtime / "studio"
        profile = state / "relay-profiles/00000000-0000-4000-8000-000000000001"
        profile.mkdir(parents=True)
        identity = profile / "client-identity.json"
        identity.write_text(json.dumps({"id": "selected-gateway"}))
        credential = profile / "gateway-secret"
        credential.write_text("private-fixture-credential-" * 3)
        (state / "desktop-relay.json").write_text(json.dumps({"selectedProfile": "00000000-0000-4000-8000-000000000001"}))
        module = self.root / "apps/kcoder-studio/src/gateway-relay-instance.js"
        module.parent.mkdir(parents=True, exist_ok=True)
        module.write_text("export async function readRelayConfiguration(){return {selectedProfile:'00000000-0000-4000-8000-000000000001'};} "
                          "export async function prepareGatewayRelay() { return { ..." + json.dumps({
            "relayOrigin": "https://selected-relay.example",
            "identityFile": str(identity), "gatewaySecretFile": str(credential),
            "publicBaseUrl": "https://selected-relay.example/g/selected-gateway",
        }) + ", close(){} }; }")
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
        self.assertIn("--setenv=KCODER_STUDIO_DATA_DIR", captured)
        self.assertIn("/apps/kcoder-studio/web-dev.mjs", captured)
        self.assertNotIn("/apps/kcoder-relay/src/client.mjs", captured)
        self.assertNotIn(credential.read_text(), captured)
        self.assertFalse((state / "registration.env").exists())

    def test_launcher_rejects_managed_path_overrides_in_root_env(self):
        launcher, env = self.prepare_launcher()
        (self.root / ".env").write_text("KCODER_WORKSPACE_DEBUG_HOME=/obsolete\n")
        result = subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("remove legacy", result.stderr)
        self.assertEqual(list((self.root / "fixture-units").iterdir()), [])

    def test_configure_does_not_copy_root_environment_into_dev(self):
        launcher, env = self.prepare_launcher()
        source = self.root / ".env"
        original = "KCODER_RELAY_PUBLIC_URL=https://relay.example\n"
        source.write_text(original)
        for _ in range(2):
            subprocess.run(["node", str(launcher), "dev", "configure"], cwd=self.root,
                           env=env, capture_output=True, text=True, check=True)
        self.assertEqual(source.read_text(), original)
        for path in [self.checkout / ".env", self.runtime / "studio/.env.launch",
                     self.runtime / "studio/launch.env"]:
            self.assertFalse(path.exists())

    def test_root_env_is_reloaded_and_legacy_startup_files_are_ignored(self):
        launcher, env = self.prepare_launcher()
        source = self.root / ".env"
        stale = "KCODER_WORKSPACE_DEBUG_HOME=/obsolete\nKCODER_WORKSPACE_DEBUG_PORT=5483\n"
        for name in [".env.launch", "launch.env"]:
            (self.runtime / "studio" / name).write_text(stale)
        (self.checkout / ".env").write_text(stale)
        for port in [5283, 5383]:
            source.write_text(f"KCODER_WORKSPACE_DEBUG_PORT={port}\n")
            for unit in (self.root / "fixture-units").iterdir():
                unit.unlink()
            result = subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.checkout,
                                    env=env, capture_output=True, text=True, check=True)
            record = json.loads(result.stdout)
            self.assertEqual(record["gateway"], f"http://127.0.0.1:{port}")
            self.assertEqual(record["home"], str(self.runtime / "home"))
            self.assertEqual(record["binary"], str(self.runtime / "debug/kcoder"))
        self.assertEqual((self.runtime / "studio/launch.env").read_text(), stale)

    def test_root_runtime_values_reach_gateway_but_secrets_do_not_reach_expo_or_argv(self):
        launcher, env = self.prepare_launcher()
        token = "fixture-auth-token-" * 3
        api_key = "fixture-provider-key"
        (self.root / ".env").write_text(
            f"KCODER_STUDIO_AUTH_TOKEN={token}\nKUNLUNMETA_BASE_API_KEY={api_key}\n"
            "DEV_DEBUG=0\nKCODER_STUDIO_VITE_BUNDLED_DEV=0\n"
            "KCODER_RELAY_TEST_PASSWORD=private-test-password\nUNRELATED_SECRET=private-other\n")
        subprocess.run(["node", str(launcher), "dev", "start"], cwd=self.root,
                       env=env, capture_output=True, text=True, check=True)
        records = [json.loads(line) for line in self.service_observations.read_text().splitlines()]
        gateway = next(r for r in records if r['unit'].endswith('-gateway.service'))
        expo = next(r for r in records if r['unit'].endswith('-expo.service'))
        self.assertEqual(gateway['env']['KCODER_STUDIO_AUTH_TOKEN'], token)
        self.assertEqual(gateway['env']['KUNLUNMETA_BASE_API_KEY'], api_key)
        self.assertEqual(gateway['env']['KCODER_STUDIO_VITE_BUNDLED_DEV'], '0')
        self.assertNotIn(token, str(gateway['argv']))
        self.assertNotIn(api_key, str(gateway['argv']))
        for record in records:
            self.assertNotIn('UNRELATED_SECRET', record['env'])
            self.assertNotIn('KCODER_RELAY_TEST_PASSWORD', record['env'])
        self.assertNotIn('KCODER_STUDIO_AUTH_TOKEN', expo['env'])
        self.assertNotIn('KUNLUNMETA_BASE_API_KEY', expo['env'])
        self.assertEqual(expo['env']['EXPO_NO_DOTENV'], '1')

    def test_launcher_does_not_relocate_relay_identity_while_instance_is_active(self):
        launcher, env = self.prepare_launcher()
        instance = hashlib.sha256(str(self.root).encode()).hexdigest()[:12]
        (self.root / f"fixture-units/kcoder-workspace-{instance}-dev-gateway.service").touch()
        legacy = self.runtime / "studio/relay-identity.json"
        legacy.write_text("original identity must not be touched")
        old_config = self.runtime / "studio/launch.env"
        old_config.write_text("legacy config must remain unchanged")
        result = subprocess.run(["node", str(launcher), "dev", "start", "--relay"], cwd=self.root,
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Instance is active", result.stderr)
        self.assertEqual(legacy.read_text(), "original identity must not be touched")
        self.assertTrue(old_config.exists())
        self.assertFalse((self.runtime / "studio/.env.launch").exists())
        self.assertFalse((self.runtime / "studio/relay/client-identity.json").exists())
        recovery = subprocess.run(["node", str(launcher), "dev", "start", "--relay", "--recover"],
                                  cwd=self.root, env=env, capture_output=True, text=True)
        self.assertNotEqual(recovery.returncode, 0)
        self.assertIn("Instance is active", recovery.stderr)
        self.assertEqual(legacy.read_text(), "original identity must not be touched")

    def test_missing_legacy_gateway_secret_keeps_the_local_workspace_available(self):
        launcher, env = self.prepare_launcher()
        state = self.runtime / "studio"
        (self.root / ".env").write_text("KCODER_RELAY_PUBLIC_URL=https://relay.example\n")
        module = self.root / "apps/kcoder-studio/src/gateway-relay-instance.js"
        module.parent.mkdir(parents=True, exist_ok=True)
        module.write_text("export async function readRelayConfiguration(){return null;} "
                          "export async function prepareGatewayRelay(){return null;}")
        registration = state / "registration.env"
        registration.write_text("KCODER_RELAY_REGISTRATION_KEY=" + "r" * 64 + "\n")
        legacy = state / "relay-identity.json"
        original = json.dumps({"version": 1, "relayOrigin": "https://relay.example",
                               "gatewaySecretHash": hashlib.sha256(b"a" * 64).hexdigest(),
                               "id": "original-fixture-id", "secret": "b" * 64}).encode()
        legacy.write_bytes(original)
        result = subprocess.run(["node", str(launcher), "dev", "start", "--relay"], cwd=self.root,
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("original Gateway internal secret", result.stderr)
        self.assertNotIn("Invalid client identity", result.stderr)
        self.assertEqual(legacy.read_bytes(), original)
        self.assertFalse((state / "relay/client-identity.json").exists())
        self.assertIn("\"gateway\": \"http://127.0.0.1:", result.stdout)

    def test_relay_start_reuses_the_original_id_at_the_shared_relative_path(self):
        launcher, env = self.prepare_launcher()
        state = self.runtime / "studio"
        registration_key = "registration-fixture-key-" * 3
        gateway_secret = "a" * 64
        (self.root / ".env").write_text(
            "KCODER_RELAY_PUBLIC_URL=https://relay.example\n"
            f"KCODER_STUDIO_AUTH_TOKEN={'c' * 64}\n")
        registration = state / "registration.env"
        registration.write_text(f"KCODER_RELAY_REGISTRATION_KEY={registration_key}\n"
                                f"KCODER_RELAY_GATEWAY_SECRET={gateway_secret}\n"
                                f"KCODER_STUDIO_AUTH_TOKEN={'d' * 64}\nUNRELATED_SECRET=ignored\n")
        legacy = state / "relay-identity.json"
        original = json.dumps({"version": 1, "relayOrigin": "https://relay.example",
                               "gatewaySecretHash": hashlib.sha256(gateway_secret.encode()).hexdigest(),
                               "id": "original-fixture-id", "secret": "b" * 64}).encode()
        legacy.write_bytes(original)
        result = subprocess.run(["node", str(launcher), "dev", "start", "--relay"], cwd=self.root,
                                env=env, capture_output=True, text=True, check=True)
        record = json.loads(result.stdout)
        self.assertEqual(record["publicGateway"], "https://relay.example/g/original-fixture-id")
        self.assertEqual((state / "relay/client-identity.json").read_bytes(), original)
        self.assertFalse(legacy.exists())
        self.assertIn(gateway_secret, registration.read_text())
        services = [json.loads(line) for line in self.service_observations.read_text().splitlines()]
        gateway = next(r for r in services if r['unit'].endswith('-gateway.service'))
        client = next(r for r in services if r['unit'].endswith('-relay.service'))
        self.assertEqual(gateway['env']['KCODER_STUDIO_AUTH_TOKEN'], 'c' * 64)
        self.assertNotIn('KCODER_STUDIO_AUTH_TOKEN', client['env'])
        for service in [gateway, client]:
            self.assertEqual(service['env']['KCODER_RELAY_NO_DOTENV'], '1')
            self.assertNotIn('KCODER_RELAY_ENV_FILE', service['env'])
            self.assertNotIn('KCODER_RELAY_REGISTRATION_KEY', service['env'])
            self.assertNotIn('UNRELATED_SECRET', service['env'])
            self.assertNotIn(gateway_secret, str(service['argv']))


    @unittest.skipIf(os.name == "nt", "Requires real POSIX SIGKILL")
    def test_before_marker_crash_keeps_pending_proof_and_local_gateway(self):
        launcher, env = self.prepare_launcher()
        state = self.runtime / "studio"
        (self.root / ".env").write_text("KCODER_RELAY_PUBLIC_URL=https://relay.example\n")
        registration = state / "registration.env"
        registration.write_text("KCODER_RELAY_GATEWAY_SECRET=" + "a" * 64 + "\n")
        identity = state / "relay/client-identity.json"
        module = self.root / "apps/kcoder-relay/src/client-identity.mjs"
        program = ("import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';"
                   "fs.link=async()=>process.kill(process.pid,'SIGKILL');syncBuiltinESMExports();"
                   "const api=await import(" + json.dumps(module.as_uri()) + ");"
                   "await api.prepareClientIdentity(" + json.dumps({"identityFile": str(identity),
                       "relayUrl": "https://relay.example", "gatewaySecret": "a" * 64}) + ");")
        killed = subprocess.run(["node", "--input-type=module", "-e", program], cwd=self.root,
                                env=env, capture_output=True, text=True)
        self.assertEqual(killed.returncode, -9)
        reference = identity.with_name(identity.name + ".state-v2") / "reference.json"
        before = reference.read_bytes()
        result = subprocess.run(["node", str(launcher), "dev", "start", "--relay"], cwd=self.root,
                                env=env, capture_output=True, text=True, check=True)
        self.assertIn('"publicGateway": null', result.stdout)
        self.assertEqual(reference.read_bytes(), before)
        self.assertFalse(identity.exists())


if __name__ == "__main__":
    unittest.main()
