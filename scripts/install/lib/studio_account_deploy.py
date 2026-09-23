"""Install a forced-command SSH boundary while retaining a distinct administrator key."""

import base64
import hashlib
import os
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import uuid

from studio_account_files import AccountError, locked, trusted_directory
from studio_accounts import AccountStore
from studio_account_runtime import trusted_runtime

KEY_TYPES = {"ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"}


def key_from_line(line):
    try:
        parts = shlex.split(line, comments=True)
    except ValueError as error:
        raise AccountError("Malformed authorized_keys line") from error
    for index, part in enumerate(parts[:-1]):
        if part in KEY_TYPES:
            try:
                blob = base64.b64decode(parts[index + 1], validate=True)
            except ValueError as error:
                raise AccountError("Invalid SSH public key") from error
            fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
            return part + " " + parts[index + 1], fingerprint
    return None


def read_root_file(path, optional=False):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if optional:
            return None
        raise
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 1048576:
            raise AccountError("Deployment input must be a bounded root-owned regular file")
        data = source.read(1048577)
        if len(data) > 1048576:
            raise AccountError("Deployment input is too large")
        return data


def read_public_key(path):
    try:
        lines = read_root_file(path).decode("utf-8").strip().splitlines()
    except UnicodeError as error:
        raise AccountError("Invalid public key text") from error
    if len(lines) != 1 or not lines[0].split() or lines[0].split()[0] not in KEY_TYPES:
        raise AccountError("Provide one public key without SSH options")
    key = key_from_line(lines[0])
    if not key:
        raise AccountError("Invalid public key")
    with tempfile.NamedTemporaryFile(mode="w") as candidate:
        candidate.write(key[0] + "\n")
        candidate.flush()
        result = subprocess.run(["/usr/bin/ssh-keygen", "-l", "-f", candidate.name], capture_output=True)
    if result.returncode:
        raise AccountError("OpenSSH rejected the public key")
    return key


def write_root_file(path, contents, mode):
    fd, temporary = tempfile.mkstemp(prefix=".kcoder-deploy-", dir=Path(path).parent)
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), mode)
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare(prefix, source_root):
    prefix = trusted_directory(prefix)
    for directory in [prefix / "lib", prefix / "bin"]:
        trusted_directory(directory)
    modules = ["studio_account_files.py", "studio_accounts.py", "studio_account_runtime.py", "studio_account_sessions.py"]
    for name in modules:
        write_root_file(prefix / "lib" / name, (source_root / "lib" / name).read_bytes(), 0o600)
    for name in ["studio-account.py", "studio-account-entry.py"]:
        write_root_file(prefix / "bin" / name, (source_root / "installers" / name).read_bytes(), 0o700)
    return {"prepared": str(prefix), "administratorCommand": shlex.join(["/usr/bin/python3", "-I", str(prefix / "bin/studio-account.py")])}


def restricted_keys(existing, shared_key, administrator_key, command):
    shared, shared_fingerprint = shared_key
    administrator, administrator_fingerprint = administrator_key
    if shared_fingerprint == administrator_fingerprint:
        raise AccountError("The administrator backup key must differ from the shared key")
    preserved = []
    shared_found = False
    for line in existing.decode("utf-8").splitlines():
        parsed = key_from_line(line)
        if parsed and parsed[1] == shared_fingerprint:
            shared_found = True
            continue
        if parsed and parsed[1] == administrator_fingerprint:
            continue
        preserved.append(line)
    if not shared_found:
        raise AccountError("The selected shared key is not in the current root authorized_keys")
    escaped = command.replace("\\", "\\\\").replace('"', '\\"')
    preserved.extend([administrator + " kcoder-administrator", f'restrict,command="{escaped}" {shared} kcoder-shared-entry'])
    return ("\n".join(preserved) + "\n").encode()


def install_command(*, prefix, command_path, state, homes, runtime):
    trusted_directory(prefix)
    trusted_directory(command_path.parent)
    trusted_runtime(runtime)
    entry = prefix / "bin/studio-account-entry.py"
    read_root_file(entry)
    marker = b"# Managed KCoder account command; existing SSH authorization is unchanged.\n"
    previous = read_root_file(command_path, optional=True)
    if previous is not None and marker not in previous:
        raise AccountError("Refusing to replace an unrelated command")
    command = shlex.join(["/usr/bin/python3", "-I", str(entry), "--state-directory", str(state),
                          "--homes-directory", str(homes), "--runtime", str(runtime)])
    script = b"#!/bin/sh\n" + marker + b'[ "$#" -eq 0 ] || exit 1\nexport SSH_ORIGINAL_COMMAND=kcoder-account\n'
    write_root_file(command_path, script + ("exec " + command + "\n").encode(), 0o755)
    return {"command": str(command_path), "sshAuthorizationChanged": False,
            "isolationBoundary": "KCoder worker processes; existing root SSH remains privileged"}


def activate(*, prefix, state, homes, runtime, authorized_keys, shared_key, administrator_key,
             sshd_config, dropin, service, reload_daemon=True):
    prefix = trusted_directory(prefix)
    trusted_runtime(runtime)
    trusted_directory(authorized_keys.parent)
    trusted_directory(dropin.parent)
    store = AccountStore(state)
    if not any(account["role"] == "admin" and not account["disabled"] for account in store.list()):
        raise AccountError("Create an active KCoder administrator account before activating the shared entry")
    entry = prefix / "bin/studio-account-entry.py"
    read_root_file(entry)
    command = shlex.join(["/usr/bin/python3", "-I", str(entry), "--state-directory", str(state),
                          "--homes-directory", str(homes), "--runtime", str(runtime)])
    shared = read_public_key(shared_key)
    administrator = read_public_key(administrator_key)
    with locked(prefix / ".deployment.lock"):
        previous_keys = read_root_file(authorized_keys)
        replacement = restricted_keys(previous_keys, shared, administrator, command)
        previous_dropin = read_root_file(dropin, optional=True)
        config = b"# Managed KCoder worker accounts may only run behind the account entry.\nDenyUsers kcu_*\n"
        if previous_dropin is not None and previous_dropin != config:
            raise AccountError("Refusing to replace an unrelated SSH configuration file")
        backup = authorized_keys.with_name(authorized_keys.name + ".kcoder-backup-" + uuid.uuid4().hex)
        write_root_file(backup, previous_keys, 0o600)
        try:
            write_root_file(authorized_keys, replacement, 0o600)
            write_root_file(dropin, config, 0o600)
            checked = subprocess.run(["/usr/sbin/sshd", "-t", "-f", str(sshd_config)], capture_output=True)
            effective = subprocess.run(["/usr/sbin/sshd", "-T", "-f", str(sshd_config), "-C", "user=kcu_probe,host=localhost,addr=127.0.0.1"], capture_output=True)
            if checked.returncode or effective.returncode or not any(
                line.startswith(b"denyusers ") and b"kcu_*" in line.split()[1:] for line in effective.stdout.splitlines()
            ):
                raise AccountError("OpenSSH did not load the worker-account deny rule; check its Include configuration")
            if reload_daemon:
                subprocess.run(["/usr/bin/systemctl", "reload", service], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            write_root_file(authorized_keys, previous_keys, 0o600)
            if previous_dropin is None:
                dropin.unlink(missing_ok=True)
            else:
                write_root_file(dropin, previous_dropin, 0o600)
            raise
    return {"sharedKeyFingerprint": shared[1], "administratorKeyFingerprint": administrator[1],
            "authorizedKeysBackup": str(backup), "daemonReloaded": reload_daemon,
            "existingSharedRootSessionsMustBeClosed": True}
