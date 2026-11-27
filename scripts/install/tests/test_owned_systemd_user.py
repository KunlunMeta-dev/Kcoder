"""Real isolated Linux user-manager lifecycle; never runs in default checks."""

import os
from pathlib import Path
import pwd
import shutil
import tempfile
import unittest

from owned_systemd_user import OwnedSystemdUser


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get("KCODER_TEST_SYSTEM_USERS") == "1",
                     "Explicit root KCODER_TEST_SYSTEM_USERS=1 required")
class OwnedSystemdUserTests(unittest.TestCase):
    def test_actual_bus_runs_as_new_uid_and_manager_exits_before_account_deletion(self):
        root = Path(tempfile.mkdtemp(prefix="kcoder-systemd-user-"))
        root.chmod(0o711)
        fixture = OwnedSystemdUser(root / "identity")
        try:
            fixture.start()
            account = fixture.account()
            self.assertGreaterEqual(account["uid"], 1000)
            self.assertEqual(fixture.run(["/usr/bin/id", "-u"]).stdout.strip(), str(account["uid"]))
            self.assertEqual(fixture.run(["/usr/bin/systemctl", "--user", "is-system-running"]).stdout.strip(), "running")
            user = account["user"]
            fixture.close()
            self.assertTrue(fixture.closed)
            with self.assertRaises(KeyError):
                pwd.getpwnam(user)
            fixture.close()
        finally:
            fixture.close()
            if fixture.closed:
                shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
