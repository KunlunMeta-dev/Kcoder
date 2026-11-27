"""Strict OIDC acceptance entry: missing prerequisites and skips are failures."""

import argparse
import os
from pathlib import Path
import sys
import unittest

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "lib"), str(Path(__file__).resolve().parent)]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--native", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0 or (args.native and os.environ.get("KCODER_TEST_SYSTEM_USERS") != "1"):
        raise SystemExit("UNMET_PREREQUISITE: root and explicit native system-user consent required")
    from studio_organization_oidc_provider import libraries
    libraries()  # The unchanged ownership/pin checks run before optional unittest decorators.
    pattern = "test_studio_organization_oidc_runtime.py" if args.native else "test_studio_organization_oidc.py"
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).resolve().parent), pattern=pattern)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.testsRun == 0 or result.skipped or not result.wasSuccessful():
        raise SystemExit(1)
