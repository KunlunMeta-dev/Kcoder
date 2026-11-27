#!/usr/bin/env python3
"""Create a private, secret-path-filtered source view for one OCR audit."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess


class ViewError(RuntimeError):
    pass


PRIVATE_COMPONENTS = frozenset({
    '.git', '.gitconfig', '.gitmodules', '.kcoder', '.opencodereview',
    '.ssh', '.aws', '.gnupg', '.kube', '.docker',
})
PRIVATE_NAMES = frozenset({
    '.netrc', '_netrc', '.npmrc', '.pypirc', '.dockercfg',
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
})
PRIVATE_SUFFIXES = ('.pem', '.p12', '.pfx', '.key', '.jsonl', '.log')
SUSPICIOUS_CONTENT = tuple(re.compile(pattern) for pattern in (
    rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
    rb'gh[pousr]_[A-Za-z0-9]{36,}', rb'AKIA[0-9A-Z]{16}',
    rb'xox[baprs]-[A-Za-z0-9-]{20,}', rb'sk-(?:proj-)?[A-Za-z0-9_-]{32,}',
))


def protected(relative: str) -> bool:
    parts = relative.lower().split('/')
    if (not relative or any(not part or part in ('.', '..') for part in parts)
            or any(ord(char) < 32 or ord(char) == 127 or char in '\\:' for char in relative)):
        return True
    if any(part in PRIVATE_COMPONENTS for part in parts):
        return True
    if relative.lower().startswith('apps/kcoder-studio/e2e/private/'):
        return True
    base = parts[-1]
    return (base == '.env' or base.startswith('.env.') or base in PRIVATE_NAMES
            or base.endswith(PRIVATE_SUFFIXES))


def identity(info: os.stat_result) -> tuple[int, ...]:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def read_owned_file(root_fd: int, relative: str, maximum: int = 128 * 1024 * 1024) -> bytes:
    parts = relative.split('/')
    held = [os.dup(root_fd)]
    try:
        for component in parts[:-1]:
            held.append(os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=held[-1]))
        before = os.stat(parts[-1], dir_fd=held[-1], follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
            raise ViewError('source is not a bounded single-link regular file')
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=held[-1])
        held.append(fd)
        opened = os.fstat(fd)
        if identity(before) != identity(opened):
            raise ViewError('source changed before read')
        chunks = []
        size = 0
        while True:
            chunk = os.read(fd, min(65536, opened.st_size - size + 1))
            if not chunk:
                break
            size += len(chunk)
            if size > opened.st_size:
                raise ViewError('source grew during read')
            chunks.append(chunk)
        after = os.stat(parts[-1], dir_fd=held[-2], follow_symlinks=False)
        if size != opened.st_size or identity(opened) != identity(os.fstat(fd)) or identity(opened) != identity(after):
            raise ViewError('source changed during read')
        return b''.join(chunks)
    finally:
        for fd in reversed(held):
            os.close(fd)


def create_view(source: Path, destination: Path) -> dict:
    source, destination = source.absolute(), destination.absolute()
    parent = destination.parent
    info = parent.lstat()
    if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise ViewError('destination parent must be an owned private directory')
    if destination.exists() or destination.is_symlink():
        raise ViewError('destination must not already exist')
    if source == destination or source in destination.parents or destination in source.parents:
        raise ViewError('source and destination must be disjoint')
    # A no-git view must not discover an unrelated ancestor repository.
    for ancestor in (parent, *parent.parents):
        if os.path.lexists(ancestor / '.git'):
            raise ViewError('destination must be outside all Git worktrees')
    environment = {'PATH': os.defpath, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
    probe = subprocess.run(['git', '-C', str(parent), 'rev-parse', '--is-inside-work-tree'],
                           env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if probe.returncode == 0:
        raise ViewError('destination must be outside all Git worktrees')
    root_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    entries = []
    withheld = 0
    content_withheld = 0
    try:
        destination.mkdir(mode=0o700)
        for directory, dirs, files in os.walk(source, followlinks=False):
            parent_rel = Path(directory).relative_to(source)
            kept = []
            for name in dirs:
                rel = (parent_rel / name).as_posix()
                # A trailing slash also protects the private directory itself.
                if protected(rel) or protected(rel + '/entry'):
                    withheld += 1
                    continue
                if (Path(directory) / name).is_symlink():
                    raise ViewError('source directory link is not allowed')
                kept.append(name)
            dirs[:] = sorted(kept)
            for name in sorted(files):
                rel = (parent_rel / name).as_posix()
                if protected(rel):
                    withheld += 1
                    continue
                content = read_owned_file(root_fd, rel)
                if any(pattern.search(content) for pattern in SUSPICIOUS_CONTENT):
                    withheld += 1
                    content_withheld += 1
                    continue
                target = destination / rel
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
                try:
                    view = memoryview(content)
                    while view:
                        written = os.write(fd, view)
                        if written <= 0:
                            raise ViewError('short destination write')
                        view = view[written:]
                finally:
                    os.close(fd)
                entries.append({'path': rel, 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
    finally:
        os.close(root_fd)
    return {'schemaVersion': 1, 'source': str(source), 'view': str(destination),
            'files': entries, 'withheldEntries': withheld, 'contentWithheldEntries': content_withheld}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    if args.manifest.absolute().parent != args.destination.absolute().parent:
        raise ViewError('manifest must share the private view parent')
    result = create_view(args.source, args.destination)
    fd = os.open(args.manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf8') as stream:
        json.dump(result, stream, ensure_ascii=False, separators=(',', ':'))
        stream.write('\n')
    print(json.dumps({'files': len(result['files']), 'withheldEntries': result['withheldEntries'],
                      'contentWithheldEntries': result['contentWithheldEntries']}))


if __name__ == '__main__':
    main()
