"""Exact owned scope Main/SDK and inherited kernel-fence observations.

Only an explicitly enabled owned scope fixture may exercise the bounded orphan
negative. Every signal uses its original retained pidfd, UID/image and ancestry.
"""
import hashlib
import json
import os
import select
import signal
import stat
import sys
import time


def alive(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return not poll.poll(0)


def image(pid, uid, expected):
    if os.stat(f"/proc/{pid}").st_uid != uid:
        raise ValueError("OWNED_UID_MISMATCH")
    with open(f"/proc/{pid}/exe", "rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual not in expected:
        raise ValueError("OWNED_IMAGE_MISMATCH")
    return actual


def children(pid):
    result = set()
    for task in os.listdir(f"/proc/{pid}/task"):
        try:
            with open(f"/proc/{pid}/task/{task}/children", encoding="ascii") as source:
                result.update(int(value) for value in source.read().split())
        except FileNotFoundError:
            continue
    return result


def scope_fence(pid, uid, profile, role):
    matches = []
    for name in os.listdir(f"/proc/{pid}/fd"):
        path = f"/proc/{pid}/fd/{name}"
        try:
            target = os.readlink(path)
            if not target.startswith(profile + "/") or not target.endswith("/channel-host-owner.lock"):
                continue
            metadata = os.stat(path)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != uid or metadata.st_nlink != 1:
                raise ValueError("OWNED_SCOPE_FENCE_UNSAFE")
            with open(f"/proc/{pid}/fdinfo/{name}", encoding="ascii") as source:
                details = source.read()
            flags = int(next(line.split()[1] for line in details.splitlines() if line.startswith("flags:")), 8)
            if "FLOCK" not in details:
                raise ValueError("OWNED_SCOPE_FENCE_NOT_LOCKED")
            cloexec = bool(flags & os.O_CLOEXEC)
            if role == "core" and not cloexec:
                raise ValueError("OWNED_CORE_FENCE_LEAKS_TO_GENERIC_EXEC")
            matches.append({"identity": f"{metadata.st_dev}:{metadata.st_ino}", "cloexec": cloexec})
        except FileNotFoundError:
            continue
    if not matches:
        raise ValueError("OWNED_NATIVE_SCOPE_FENCE_MISSING")
    if len({entry["identity"] for entry in matches}) != 1:
        raise ValueError("OWNED_NATIVE_SCOPE_FENCE_CHANGED")
    return {"identity": matches[0]["identity"], "role": role, "handles": len(matches), "allCloexec": all(entry["cloexec"] for entry in matches)}


def main():
    root, uid = int(sys.argv[1]), int(sys.argv[2])
    native, node = sys.argv[3], sys.argv[4]
    profile = sys.argv[5] if len(sys.argv) > 5 else ""
    expected_sdks = int(sys.argv[6]) if len(sys.argv) > 6 else 2
    if not 0 <= expected_sdks <= 8 or (expected_sdks == 0 and not profile):
        raise ValueError("OWNED_TREE_COUNT_INVALID")
    root_fd = os.pidfd_open(root)
    image(root, uid, {native, node})
    retained, keepers, fences, parents = {}, {}, {}, {}
    frozen = set()

    def held(pid):
        return (keepers.get(pid) or retained[pid])[0]

    def release():
        for pid in list(frozen):
            if alive(held(pid)):
                signal.pidfd_send_signal(held(pid), signal.SIGCONT)
            frozen.discard(pid)

    def result(include_wait=False):
        value = {"rootAlive": alive(root_fd), "processes": [{"pid": pid, "role": role, "alive": alive(fd), "kernelPidfd": True} for pid, (fd, role) in retained.items()]}
        if profile:
            value["keepers"] = [{"pid": pid, "role": role, "alive": alive(fd), "kernelPidfd": True} for pid, (fd, role) in keepers.items()]
            value["scopeFences"] = [{"pid": pid, **proof} for pid, proof in fences.items()]
            value["liveScopeFences"] = [{"pid":pid,**scope_fence(pid,uid,profile,role)} for pid,(fd,role) in retained.items() if alive(fd)]
            if include_wait:
                waits = []
                for pid, (fd, role) in keepers.items():
                    if role != "core" or not alive(fd):
                        continue
                    tasks = os.listdir(f"/proc/{pid}/task")
                    if len(tasks) > 512:
                        raise ValueError("OWNED_CORE_THREAD_CAPACITY")
                    for tid in tasks:
                        try:
                            with open(f"/proc/{pid}/task/{tid}/wchan", encoding="ascii") as source:
                                wait = source.read(128).strip()
                            with open(f"/proc/{pid}/task/{tid}/syscall", encoding="ascii") as source:
                                syscall = source.read(512).split()
                            waits.append({"pid": pid, "tid": int(tid), "wait": wait,
                                          "syscall": syscall[:2]})
                        except FileNotFoundError:
                            continue
                    if not alive(fd):
                        raise ValueError("OWNED_CORE_ENDED_DURING_OBSERVATION")
                value["scopeWait"] = waits
        return value

    try:
        for line in sys.stdin:
            request = json.loads(line)
            try:
                method = request.get("method")
                if method == "attach":
                    if retained or not alive(root_fd):
                        raise ValueError("OWNED_TREE_ALREADY_ATTACHED_OR_ENDED")
                    pending, opened = {root}, []
                    fences.clear()
                    parents.clear()
                    try:
                        for _ in range(8):
                            following = set()
                            for parent in pending:
                                for pid in children(parent):
                                    fd = os.pidfd_open(pid)
                                    opened.append(fd)
                                    actual = image(pid, uid, {native, node})
                                    with open(f"/proc/{pid}/stat", encoding="ascii") as source:
                                        actual_parent = int(source.read().rsplit(")", 1)[1].split()[1])
                                    if actual_parent != parent or not alive(fd):
                                        raise ValueError("OWNED_TREE_CHANGED")
                                    with open(f"/proc/{pid}/cmdline", "rb") as source:
                                        args = source.read().split(b"\0")
                                    role = next((role for role, suffix in (("main", b"/src/applications/stdio.mjs"), ("sdk", b"/src/channels/worker.mjs")) if actual == node and any(arg.endswith(suffix) for arg in args)), None)
                                    native_role = None
                                    if actual == native and len(args) > 1:
                                        if args[1] == b"--internal-native-channel-scope-owner-v1":
                                            native_role = "scope_owner"
                                        elif args[1] == b"--internal-native-channel-scope-core-v1":
                                            native_role = "core"
                                        elif args[1] == b"--internal-stdio-owner-v1":
                                            if any(arg.endswith(b"/src/applications/stdio.mjs") for arg in args):
                                                native_role = "main_owner"
                                            elif any(arg.endswith(b"/src/channels/worker.mjs") for arg in args):
                                                native_role = "sdk_owner"
                                    if profile and (role or native_role):
                                        fences[pid] = scope_fence(pid, uid, profile, role or native_role)
                                    if not alive(fd):
                                        raise ValueError("OWNED_TREE_CHANGED")
                                    if role:
                                        retained[pid] = (fd, role)
                                    if profile and native_role:
                                        keepers[pid] = (fd, native_role)
                                    parents[pid] = parent
                                    following.add(pid)
                            if len(opened) > 64:
                                raise ValueError("OWNED_TREE_CAPACITY")
                            pending = following
                            if not pending:
                                break
                        expected_mains = 1 if expected_sdks else 0
                        if sum(role == "main" for _, role in retained.values()) != expected_mains or sum(role == "sdk" for _, role in retained.values()) != expected_sdks:
                            raise ValueError("OWNED_TWO_BOT_TREE_INCOMPLETE")
                        if profile and (len({value["identity"] for value in fences.values()}) != 1 or sum(role == "core" for _, role in keepers.values()) != 1 or sum(role == "scope_owner" for _, role in keepers.values()) != 1):
                            raise ValueError("OWNED_SCOPE_CORE_INCOMPLETE")
                        keep = {fd for fd, _ in list(retained.values()) + list(keepers.values())}
                        for fd in opened:
                            if fd not in keep:
                                os.close(fd)
                    except BaseException:
                        retained.clear()
                        keepers.clear()
                        for fd in opened:
                            os.close(fd)
                        raise
                elif profile and method == "freeze_scope":
                    sdk = next(pid for pid, (fd, role) in retained.items() if role == "sdk" and alive(fd))
                    parent = parents[sdk]
                    if parent not in keepers or keepers[parent][1] != "sdk_owner":
                        raise ValueError("OWNED_SDK_KEEPER_CHANGED")
                    selected = [parent, sdk] + [pid for pid, (_, role) in keepers.items() if role in ("core", "scope_owner")]
                    for pid in selected:
                        if not alive(held(pid)):
                            raise ValueError("OWNED_SCOPE_ALREADY_ENDED")
                        signal.pidfd_send_signal(held(pid), signal.SIGSTOP)
                        frozen.add(pid)
                elif profile and method == "crash_core":
                    original = [fd for fd, role in keepers.values() if role == "core"]
                    if len(original) != 1 or not alive(original[0]):
                        raise ValueError("OWNED_ORIGINAL_CORE_UNAVAILABLE")
                    signal.pidfd_send_signal(original[0], signal.SIGKILL)
                elif profile and method == "lose_scope_owners":
                    for _, (fd, role) in keepers.items():
                        if role in ("scope_owner", "core", "main_owner", "sdk_owner") and alive(fd):
                            signal.pidfd_send_signal(fd, signal.SIGKILL)
                elif profile and method == "retire_scope_control":
                    if not frozen:
                        raise ValueError("OWNED_SCOPE_NOT_FROZEN")
                    for pid, (fd, role) in keepers.items():
                        if role in ("core", "scope_owner") and alive(fd):
                            signal.pidfd_send_signal(fd, signal.SIGKILL)
                            frozen.discard(pid)
                elif profile and method in ("release_scope", "cleanup"):
                    if method == "cleanup":
                        for _, (fd, role) in keepers.items():
                            if role == "core" and alive(fd):
                                signal.pidfd_send_signal(fd, signal.SIGTERM)
                    release()
                    if method == "cleanup":
                        until = time.monotonic() + 15
                        while any(alive(fd) for fd, _ in list(retained.values()) + list(keepers.values())):
                            if time.monotonic() >= until:
                                raise ValueError("OWNED_SCOPE_CLEANUP_UNCONFIRMED")
                            time.sleep(0.02)
                elif method not in ("observe", "inspect_scope_wait"):
                    raise ValueError("OWNED_METHOD_UNSUPPORTED")
                response = {"id": request.get("id"), "result": result(method == "inspect_scope_wait")}
            except (OSError, ValueError, StopIteration) as error:
                # A successful systemd start receipt precedes Core readiness.
                # Only incomplete snapshots may be observed again; identity,
                # image, ancestry and fence validation failures remain fatal.
                incomplete = method == "attach" and alive(root_fd) and (
                    isinstance(error, FileNotFoundError) or str(error) in (
                        "OWNED_TWO_BOT_TREE_INCOMPLETE", "OWNED_SCOPE_CORE_INCOMPLETE",
                    )
                )
                response = {"id": request.get("id"), "error": {
                    "message": "OWNED_FOREGROUND_TREE_UNCONFIRMED",
                    "data": {"incomplete": incomplete},
                }}
            print(json.dumps(response), flush=True)
    finally:
        release()
        for fd in {fd for fd, _ in list(retained.values()) + list(keepers.values())}:
            os.close(fd)
        os.close(root_fd)


if __name__ == "__main__":
    main()
