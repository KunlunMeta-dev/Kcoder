#!/usr/bin/python3
"""Owned host acceptance driver; it starts no model or business operation."""

import json
import os
from pathlib import Path
import socket
import struct
import sys
import time

if "--internal-wiki-pause" in sys.argv:
    raise SystemExit(0)
if "--internal-wiki-worker" in sys.argv:
    path = Path(os.environ["HOME"]) / "tmp/oidc-owned-wiki-parents.jsonl"
    with path.open("a") as output:
        output.write(json.dumps({"parentPid": os.getppid(), "workerPid": os.getpid()}) + "\n")
    while True:
        time.sleep(1)

descriptor = int(os.environ["KCODER_PRIVATE_ORGANIZATION_FD_V1"])
channel = socket.socket(fileno=descriptor)
peer_pid, peer_uid, _ = struct.unpack("3i", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
if peer_uid != 0 or peer_pid != os.getppid() or os.geteuid() < 1000 or os.getgroups():
    raise SystemExit(2)
channel.send(b'{"operation":"inspect"}')
snapshot = json.loads(channel.recv(8192))
if not snapshot.get("ok") or snapshot["result"]["workerUid"] != os.geteuid() or snapshot["result"]["workerGid"] != os.getegid():
    raise SystemExit(3)
first = True
while True:
    channel.send(b'{"operation":"evaluate","action":"read","resourceId":"knowledge:oidc-host","requestId":"oidc-host-read"}')
    decision = json.loads(channel.recv(8192))
    if not decision.get("ok") or not decision["result"].get("allowed"):
        raise SystemExit(4)
    if first:
        print(json.dumps({"hostProbe": True, "uid": os.geteuid(), "gid": os.getegid(), "peerUid": peer_uid,
                          "allowed": True, "ambientTokenLeaked": "OIDC_ACCESS_TOKEN" in os.environ}), flush=True)
        first = False
    time.sleep(0.1)
