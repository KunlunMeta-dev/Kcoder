#!/usr/bin/env python3
"""Administer portable KCoder accounts; passwords never appear in command arguments."""

import argparse
import getpass
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from studio_accounts import AccountError, AccountStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-directory", type=Path, default=Path("/var/lib/kcoder/accounts"))
    actions = parser.add_subparsers(dest="action", required=True)
    create = actions.add_parser("create")
    create.add_argument("--username", required=True)
    create.add_argument("--role", choices=["admin", "user"], default="user")
    create.add_argument("--password-stdin", action="store_true")
    password = actions.add_parser("password")
    password.add_argument("--username", required=True)
    password.add_argument("--password-stdin", action="store_true")
    actions.add_parser("list")
    for action in ["disable", "enable"]:
        actions.add_parser(action).add_argument("--username", required=True)
    actions.add_parser("export").add_argument("--output", type=Path, required=True)
    actions.add_parser("import").add_argument("--input", type=Path, required=True)
    args = parser.parse_args()
    store = AccountStore(args.state_directory)
    if args.action in ("create", "password"):
        password = sys.stdin.readline(1026).removesuffix("\n") if args.password_stdin else getpass.getpass("New account password: ")
        result = store.create(args.username, password, args.role) if args.action == "create" else store.change_password(args.username, password)
    elif args.action == "list":
        result = store.list()
    elif args.action in ("disable", "enable"):
        result = store.set_disabled(args.username, args.action == "disable")
    elif args.action == "export":
        result = store.export_identities(args.output)
    else:
        result = store.import_identities(args.input)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (AccountError, OSError, ValueError) as error:
        print(f"KCoder account operation failed: {error}", file=sys.stderr)
        sys.exit(1)
