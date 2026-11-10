#!/usr/bin/python3 -I
"""Owned transport faults only; never claims to be the production budget ledger."""
import sys
import time

if sys.argv[1:] != ["--internal-organization-budget-v1"]:
    raise SystemExit(2)
mode = open(__file__ + ".mode", encoding="ascii").read().strip()
if mode == "block":
    time.sleep(30)
elif mode == "overflow":
    sys.stdout.buffer.write(b"x" * (128 * 1024 + 1))
    sys.stdout.buffer.flush()
elif mode == "valid":
    sys.stdin.buffer.read()
    sys.stdout.write('{"ok":true,"result":{"transportFixture":true}}')
else:
    raise SystemExit(3)
