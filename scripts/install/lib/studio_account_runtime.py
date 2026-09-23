"""Map authenticated principals to private, non-login Linux worker identities."""

import ctypes
import hashlib
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess

from studio_account_files import AccountError, locked, trusted_directory, write_private_json


def worker_name(principal_id, instance_id):
    return "kcu_" + hashlib.sha256((instance_id + "\0" + principal_id).encode()).hexdigest()[:24]


def validate_binding(binding, principal_id):
    name = worker_name(principal_id, binding["instance"])
    account = pwd.getpwnam(name)
    home = Path(binding["home"])
    info = home.lstat()
    if account.pw_uid != binding["uid"] or account.pw_gid != binding["gid"] or account.pw_uid < 1000 or account.pw_gid == 0:
        raise AccountError("Worker identity does not match its local binding")
    if account.pw_dir != str(home) or not stat.S_ISDIR(info.st_mode) or info.st_uid != account.pw_uid or info.st_mode & 0o077:
        raise AccountError("Worker home is not private")
    return account


def ensure_binding(store, identity, homes_root=Path("/var/lib/kcoder-users")):
    homes = trusted_directory(homes_root)
    os.chmod(homes, 0o711)
    with locked(store.lock):
        data = store._load()
        current = next((item for item in data["accounts"] if item["id"] == identity["id"]), None)
        if not current or current["disabled"] or current["revision"] != identity["revision"]:
            raise AccountError("Account authorization has changed")
        binding = data["bindings"].get(identity["id"])
        if binding:
            validate_binding(binding, identity["id"])
            return binding
        name = worker_name(identity["id"], data["instance"])
        try:
            pwd.getpwnam(name)
        except KeyError:
            pass
        else:
            raise AccountError("Refusing to adopt an unregistered worker account")
        instance_homes = trusted_directory(homes / data["instance"])
        os.chmod(instance_homes, 0o711)
        home = instance_homes / identity["id"]
        if os.path.lexists(home):
            raise AccountError("Worker directory already exists without a binding")
        subprocess.run(["/usr/sbin/useradd", "--user-group", "--no-create-home", "--no-log-init",
                        "--home-dir", str(home), "--shell", "/usr/sbin/nologin", "--password", "*", name],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        account = pwd.getpwnam(name)
        try:
            if account.pw_uid < 1000 or account.pw_gid == 0:
                raise AccountError("Worker allocation produced a privileged identity")
            for directory in [home, home / ".config", home / ".config/kcoder", home / "workspace", home / "tmp"]:
                directory.mkdir(mode=0o700)
                os.chown(directory, account.pw_uid, account.pw_gid)
            settings = home / ".config/kcoder/settings.json"
            write_private_json(settings, {"providers": {}})
            os.chown(settings, account.pw_uid, account.pw_gid)
            binding = {"uid": account.pw_uid, "gid": account.pw_gid, "home": str(home), "instance": data["instance"]}
            validate_binding(binding, identity["id"])
            data["bindings"][identity["id"]] = binding
            write_private_json(store.path, data)
            return binding
        except Exception:
            # The new account has no usable password or SSH key and has not run any client code.
            if pwd.getpwnam(name).pw_uid == account.pw_uid:
                subprocess.run(["/usr/sbin/userdel", name], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if home.exists():
                    shutil.rmtree(home)
            raise


def trusted_runtime(path):
    runtime = Path(path).resolve(strict=True)
    for candidate in [runtime, *runtime.parents]:
        info = candidate.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise AccountError("Worker runtime is writable by an unprivileged user")
    if not runtime.is_file() or not os.access(runtime, os.X_OK):
        raise AccountError("Worker runtime is not executable")
    return str(runtime)


def drop_to_worker(binding, identity):
    account = validate_binding(binding, identity["id"])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise AccountError("Cannot disable privilege acquisition")
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    if os.getuid() != account.pw_uid or os.geteuid() != account.pw_uid or os.getgroups():
        raise AccountError("Privilege drop did not complete")
    os.umask(0o077)
    os.chdir(binding["home"])
    home = binding["home"]
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": home,
            "USER": account.pw_name, "LOGNAME": account.pw_name,
            "XDG_CONFIG_HOME": home + "/.config", "KCODER_CONFIG_DIR": home + "/.config/kcoder",
            "TMPDIR": home + "/tmp"}
