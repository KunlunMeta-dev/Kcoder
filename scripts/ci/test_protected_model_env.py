import os
from pathlib import Path
import subprocess
import sys
import unittest

from protected_model_env import validate_name


class ProtectedModelEnvironmentTests(unittest.TestCase):
    def test_provider_names_remain_supported(self):
        for name in ("CUSTOM_API_KEY", "KUNLUNMETA_BASE_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
            validate_name(name)

    def test_loader_and_process_configuration_names_are_rejected(self):
        for name in ("", "bad=name", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "HOME", "BASH_ENV",
                     "ENV", "NODE_OPTIONS", "PYTHONPATH", "GIT_CONFIG_COUNT", "CARGO_BUILD_RUSTC", "RUSTC_WRAPPER"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_name(name)

    def test_only_the_requested_command_receives_the_selected_credential(self):
        environment = dict(os.environ, KCODER_E2E_MODEL_CREDENTIAL_ENV="FIXTURE_API_KEY",
                           KCODER_E2E_MODEL_CREDENTIAL_VALUE="synthetic-protected-credential")
        helper = Path(__file__).with_name("protected_model_env.py")
        code = "import os,sys; sys.exit(0 if os.environ['FIXTURE_API_KEY']=='synthetic-protected-credential' else 9)"
        completed = subprocess.run([sys.executable, str(helper), sys.executable, "-c", code],
                                   env=environment, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn("synthetic-protected-credential", completed.stdout + completed.stderr)

    def test_unsafe_selection_fails_before_starting_the_command(self):
        helper = Path(__file__).with_name("protected_model_env.py")
        environment = dict(os.environ, KCODER_E2E_MODEL_CREDENTIAL_ENV="NODE_OPTIONS",
                           KCODER_E2E_MODEL_CREDENTIAL_VALUE="synthetic-protected-credential")
        completed = subprocess.run([sys.executable, str(helper), sys.executable, "-c", "raise SystemExit(7)"],
                                   env=environment, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 1)
        self.assertNotIn("synthetic-protected-credential", completed.stdout + completed.stderr)

    def test_credential_preflight_rejects_a_missing_value(self):
        helper = Path(__file__).with_name("protected_model_env.py")
        environment = dict(os.environ, KCODER_E2E_MODEL_CREDENTIAL_ENV="FIXTURE_API_KEY")
        environment.pop("KCODER_E2E_MODEL_CREDENTIAL_VALUE", None)
        completed = subprocess.run([sys.executable, str(helper), "--check-credential"],
                                   env=environment, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 1)
        self.assertIn("credential is missing", completed.stderr)


if __name__ == "__main__":
    unittest.main()
