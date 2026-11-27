"""Verify trusted identity propagation without changing OS users or directories."""
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import studio_account_runtime as runtime


class AccountEnvironment(unittest.TestCase):
    def test_principal_comes_from_authenticated_identity_not_parent_environment(self):
        account = SimpleNamespace(pw_uid=43210, pw_gid=43210, pw_name="kcoder-test")
        principal = "01234567-89ab-4cde-8fab-0123456789ab"
        with patch.object(runtime, "validate_binding", return_value=account), \
             patch.object(runtime.ctypes, "CDLL") as library, \
             patch.object(runtime.os, "setgroups"), patch.object(runtime.os, "setgid"), \
             patch.object(runtime.os, "setuid"), patch.object(runtime.os, "getuid", return_value=43210), \
             patch.object(runtime.os, "geteuid", return_value=43210), \
             patch.object(runtime.os, "getgroups", return_value=[]), \
             patch.object(runtime.os, "umask"), patch.object(runtime.os, "chdir"), \
             patch.dict(runtime.os.environ, {"KCODER_ACCOUNT_PRINCIPAL_ID": "untrusted-parent"}):
            library.return_value.prctl.return_value = 0
            result = runtime.drop_to_worker({"home": "/private/test"}, {"id": principal})
        self.assertEqual(result["KCODER_ACCOUNT_PRINCIPAL_ID"], principal)
        self.assertEqual(result["KCODER_CONFIG_DIR"], "/private/test/.config/kcoder")


if __name__ == "__main__":
    unittest.main()
