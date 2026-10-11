"""Root-owned, bounded and atomic storage for the privileged account service."""

import contextlib
import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile


class AccountError(RuntimeError):
    pass


def trusted_directory(path):
    path = Path(path)
    if os.geteuid() != 0 or not path.is_absolute() or ".." in path.parts:
        raise AccountError("An administrator-owned absolute directory is required")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise AccountError("Administrative storage has an untrusted ancestor")
    return path


def read_private_json(path, limit=4 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > limit:
            raise AccountError("Identity data must be a bounded root-private regular file")
        raw = source.read(limit + 1)
        if len(raw) > limit:
            raise AccountError("Identity data exceeds its size limit")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise AccountError("Invalid identity document") from error


def write_private_json(path, value, replace=True):
    path = Path(path)
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
    if len(raw) > 4 * 1024 * 1024:
        raise AccountError("Identity data exceeds its size limit")
    fd, temporary = tempfile.mkstemp(prefix=".identity-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path, follow_symlinks=False)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def locked(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, "r+") as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise AccountError("Unsafe account lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield
