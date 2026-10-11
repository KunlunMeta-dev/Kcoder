#!/usr/bin/env python3
"""Install the KCoder account command without changing existing SSH authorization."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from studio_account_files import AccountError
from studio_account_deploy import install_command, prepare


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "install-command"])
    parser.add_argument("--command-path", type=Path, default=Path("/usr/local/bin/kcoder-account"))
    parser.add_argument("--prefix", type=Path, default=Path("/usr/local/lib/kcoder-account"))
    parser.add_argument("--state-directory", type=Path, default=Path("/var/lib/kcoder/accounts"))
    parser.add_argument("--homes-directory", type=Path, default=Path("/var/lib/kcoder-users"))
    parser.add_argument("--runtime", type=Path, default=Path("/usr/local/bin/kcoder"))
    args = parser.parse_args()
    if args.action == "prepare":
        result = prepare(args.prefix, Path(__file__).resolve().parent.parent)
    elif args.action == "install-command":
        result = install_command(prefix=args.prefix, command_path=args.command_path, state=args.state_directory,
                                 homes=args.homes_directory, runtime=args.runtime)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (AccountError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"KCoder account gateway deployment failed: {error}", file=sys.stderr)
        sys.exit(1)
