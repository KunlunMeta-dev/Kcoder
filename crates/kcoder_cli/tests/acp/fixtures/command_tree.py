"""Owned foreground command with an independently detached stubborn child."""
import os
from pathlib import Path
import signal
import sys
import time

root = Path(sys.argv[1])
signal.signal(signal.SIGTERM, signal.SIG_IGN)
leaf = os.fork()
if leaf == 0:
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (root / "leaf.pid").write_text(str(os.getpid()))
    while True:
        time.sleep(1)

(root / "command.pid").write_text(str(os.getpid()))
with (root / "writes").open("a") as output:
    output.write("committed\n")
    output.flush()
    os.fsync(output.fileno())
while True:
    time.sleep(1)
