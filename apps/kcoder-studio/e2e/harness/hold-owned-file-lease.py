"""Hold one existing synthetic fixture's private regular file; never create or write it."""
import fcntl
import os
import select
import stat
import sys
import time

root, relative, expected_device, expected_inode = sys.argv[1:]
parts = relative.split(os.sep)
if any(part in ("", ".", "..") for part in parts):
    raise RuntimeError("invalid owned relative component")
directories = [os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)]
fd = None
try:
    root_info = os.fstat(directories[0])
    if (root_info.st_dev, root_info.st_ino) != (int(expected_device), int(expected_inode)):
        raise RuntimeError("owned root identity changed")
    for part in parts[:-1]:
        directories.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directories[-1]))
    for directory in directories:
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise RuntimeError("owned parent is not private")
    fd = os.open(parts[-1], os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directories[-1])
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid():
        raise RuntimeError("unsafe owned fixture lease")
    if stat.S_IMODE(before.st_mode) != 0o600:
        raise RuntimeError("fixture lease must be private")
    deadline = time.monotonic() + 2
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise RuntimeError("fixture lease acquisition timed out")
            time.sleep(0.002)
    current = os.stat(parts[-1], dir_fd=directories[-1], follow_symlinks=False)
    after = os.fstat(fd)
    if (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino) or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
        raise RuntimeError("fixture lease identity changed")
    print("OWNED_LEASE_HELD", flush=True)
    select.select([sys.stdin], [], [], 30)
finally:
    if fd is not None:
        os.close(fd)
    for directory in reversed(directories):
        os.close(directory)
