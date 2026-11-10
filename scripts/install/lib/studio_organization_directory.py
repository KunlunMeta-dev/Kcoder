"""Fixed Linux-PAM/NSS directory adapter; no JWT, proxy headers or password cache."""

import ctypes
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio_account_files import AccountError, locked
from studio_accounts import public_identity

SERVICE = "kcoder"
ISSUER = "linux-pam-nss:kcoder"


def directory_subject(value):
    if not isinstance(value, dict) or set(value) != {"issuer", "username"} or value["issuer"] != ISSUER:
        raise AccountError("Unsupported directory issuer")
    name = value["username"]
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@\\-]{0,127}", name):
        raise AccountError("Invalid directory username")
    account = pwd.getpwnam(name)
    if account.pw_uid < 1000 or account.pw_gid == 0 or name.startswith("kcu_"):
        raise AccountError("Directory identity must be non-privileged and distinct from worker identities")
    return {"issuer": ISSUER, "username": name, "uid": account.pw_uid, "gid": account.pw_gid}


def _subject_current(subject):
    current = directory_subject({"issuer": subject["issuer"], "username": subject["username"]})
    if current != subject:
        raise AccountError("Directory identity has changed")


def password_bytes(password):
    if not isinstance(password, str) or not 1 <= len(password.encode()) <= 1024 or "\0" in password:
        raise AccountError("Invalid directory password")
    return password.encode()


def _pam_policy(configuration_directory=None):
    # A missing file must not fall back to PAM's generic 'other' service.
    path = (configuration_directory or Path("/etc/pam.d")) / SERVICE
    for item in (path, path.parent, path.parent.parent):
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise AccountError("Untrusted directory authentication policy")
    if not path.is_file():
        raise AccountError("Directory authentication policy is unavailable")


def _pam(name, password, configuration_directory=None):
    _pam_policy(configuration_directory)
    libc = ctypes.CDLL(None)
    libc.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
    libc.calloc.restype = ctypes.c_void_p
    libc.strdup.argtypes = [ctypes.c_char_p]
    libc.strdup.restype = ctypes.c_void_p
    libc.free.argtypes = [ctypes.c_void_p]

    class Message(ctypes.Structure):
        _fields_ = [("style", ctypes.c_int), ("message", ctypes.c_char_p)]

    class Response(ctypes.Structure):
        _fields_ = [("response", ctypes.c_void_p), ("code", ctypes.c_int)]

    callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int,
                                    ctypes.POINTER(ctypes.POINTER(Message)),
                                    ctypes.POINTER(ctypes.POINTER(Response)), ctypes.c_void_p)

    @callback_type
    def conversation(count, messages, output, _):
        if not 1 <= count <= 32:
            return 19  # PAM_CONV_ERR
        allocation = libc.calloc(count, ctypes.sizeof(Response))
        if not allocation:
            return 19
        responses = ctypes.cast(allocation, ctypes.POINTER(Response))
        try:
            for index in range(count):
                style = messages[index].contents.style
                if style == 1 and password is not None:
                    answer = password_bytes(password)
                elif style == 2:
                    answer = name.encode()
                elif style in (3, 4):
                    continue
                else:
                    raise AccountError("Unsupported directory authentication conversation")
                responses[index].response = libc.strdup(answer)
                if not responses[index].response:
                    raise AccountError("Directory authentication allocation failed")
            output[0] = responses
            return 0
        except Exception:
            for index in range(count):
                if responses[index].response:
                    libc.free(responses[index].response)
            libc.free(allocation)
            return 19

    class Conversation(ctypes.Structure):
        _fields_ = [("callback", callback_type), ("data", ctypes.c_void_p)]

    pam = ctypes.CDLL("libpam.so.0")
    handle = ctypes.c_void_p()
    pam.pam_start.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(Conversation), ctypes.POINTER(ctypes.c_void_p)]
    pam.pam_authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int]
    pam.pam_acct_mgmt.argtypes = [ctypes.c_void_p, ctypes.c_int]
    pam.pam_end.argtypes = [ctypes.c_void_p, ctypes.c_int]
    pam.pam_get_item.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
    conv = Conversation(conversation, None)
    if configuration_directory is None:
        result = pam.pam_start(SERVICE.encode(), name.encode(), ctypes.byref(conv), ctypes.byref(handle))
    else:
        # Only the owned host test passes a private confdir. Production always
        # uses fixed /etc/pam.d/kcoder and exposes no caller-selected PAM policy.
        pam.pam_start_confdir.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(Conversation), ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        result = pam.pam_start_confdir(SERVICE.encode(), name.encode(), ctypes.byref(conv), os.fsencode(configuration_directory), ctypes.byref(handle))
    if result != 0:
        raise AccountError("Directory authentication failed")
    try:
        if password is not None:
            result = pam.pam_authenticate(handle, 1)  # PAM_DISALLOW_NULL_AUTHTOK
            if result != 0:
                raise AccountError("Directory authentication failed")
        result = pam.pam_acct_mgmt(handle, 1)
        if result != 0:
            raise AccountError("Directory account is unavailable")
        authenticated_name = ctypes.c_void_p()
        result = pam.pam_get_item(handle, 2, ctypes.byref(authenticated_name))  # PAM_USER
        if result != 0 or not authenticated_name.value or ctypes.cast(authenticated_name, ctypes.c_char_p).value != name.encode():
            raise AccountError("Directory canonical identity has changed")
    finally:
        pam.pam_end(handle, result)


def _bounded_pam(name, password=None):
    # PAM/SSSD can contact a directory. A stalled provider cannot hold account
    # locks or the runtime supervisor indefinitely. Passwords travel only stdin.
    frame = json.dumps({"username": name, "password": password}).encode()
    try:
        result = subprocess.run(["/usr/bin/python3", "-I", str(Path(__file__).resolve())], input=frame,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AccountError("Directory authentication unavailable") from error
    if result.returncode:
        raise AccountError("Directory authentication failed")


def directory_current(subject):
    _subject_current(subject)
    _bounded_pam(subject["username"])


def authenticate_directory(store, name, password):
    from studio_organization import OrganizationStore
    password_bytes(password)
    # Expensive authentication occurs outside the authoritative operation lock.
    # All mapping/current facts are rechecked after its completion.
    subject = directory_subject({"issuer": ISSUER, "username": name})
    _bounded_pam(name, password)
    with locked(store.lock):
        data = store._load()
        policy = OrganizationStore(store)._load()
        member = next(((key, value) for key, value in policy["members"].items()
                       if value.get("directory") == subject and not value["disabled"]), None)
        if not member:
            raise AccountError("Directory identity is not mapped to a current organization member")
        _subject_current(subject)
        current = next((item for item in data["accounts"] if item["id"] == member[0]), None)
        if not current or current["disabled"]:
            raise AccountError("Directory member is unavailable")
        # No allocation or adoption of arbitrary NSS users: execution reuses the
        # account service's existing worker binding and its UID/home checks.
        if current["id"] not in data["bindings"]:
            raise AccountError("Directory member requires an existing worker binding")
        return public_identity(current)


if __name__ == "__main__":
    # Isolated mode deliberately ignores ambient PYTHONPATH.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        frame = json.loads(sys.stdin.buffer.read(8193))
        if not isinstance(frame, dict) or set(frame) != {"username", "password"}:
            raise ValueError()
        _pam(frame["username"], frame["password"])
    except Exception:
        sys.exit(1)
