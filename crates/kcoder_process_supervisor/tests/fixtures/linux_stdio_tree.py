"""Private process-tree fixture; no external services or user state."""
import os
import pathlib
import signal
import subprocess
import sys
import time

mode, directory = sys.argv[1], pathlib.Path(sys.argv[2])
if mode == "parent":
    child = subprocess.Popen(
        [sys.argv[3], "--internal-stdio-owner-v1", str(os.getpid()),
         sys.executable, __file__, "stubborn", str(directory)],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    directory.joinpath("owner.pid").write_text(str(child.pid))
    while True:
        time.sleep(1)

if mode == "stubborn":
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
leaf = os.fork()
if leaf == 0:
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    directory.joinpath("leaf.pid").write_text(str(os.getpid()))
    while True:
        time.sleep(1)
directory.joinpath("target.pid").write_text(str(os.getpid()))
for line in sys.stdin.buffer:
    sys.stdout.buffer.write(line)
    sys.stdout.buffer.flush()
if mode == "stubborn":
    while True:
        time.sleep(1)
