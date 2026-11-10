"""Read-only kernel observations for one RunContext-owned service manager.

This fixture never signals a process. PIDs only locate the manager's actual
direct children; retained pidfds, UID, image bytes and exact entry arguments
establish which live processes the fixture observes.
"""
import hashlib
import json
import os
import select
import sys


def readable(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return bool(poll.poll(0))


def image(pid, expected_uid, expected_sha):
    metadata = os.stat(f"/proc/{pid}")
    if metadata.st_uid != expected_uid:
        raise ValueError("OWNED_UID_MISMATCH")
    with open(f"/proc/{pid}/exe", "rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != expected_sha:
        raise ValueError("OWNED_IMAGE_MISMATCH")


def main():
    manager, uid, digest = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    manager_fd = os.pidfd_open(manager)
    image(manager, uid, digest)
    if readable(manager_fd):
        raise ValueError("OWNED_MANAGER_ENDED")
    workers = {}
    try:
        for line in sys.stdin:
            request = json.loads(line)
            result = None
            try:
                method = request.get("method")
                lease = request.get("params", {}).get("leaseId")
                if method == "attach":
                    if not isinstance(lease, str) or not lease.startswith("native-code-"):
                        raise ValueError("OWNED_LEASE_INVALID")
                    if lease not in workers:
                        if readable(manager_fd):
                            raise ValueError("OWNED_MANAGER_ENDED")
                        with open(f"/proc/{manager}/task/{manager}/children", encoding="ascii") as source:
                            candidates = [int(value) for value in source.read().split()]
                        matches = []
                        for pid in candidates:
                            try:
                                with open(f"/proc/{pid}/cmdline", "rb") as source:
                                    arguments = source.read().split(b"\0")
                                if len(arguments) < 5 or arguments[1] != b"--internal-native-code-service-v1" or arguments[4] != lease.encode():
                                    continue
                                fd = os.pidfd_open(pid)
                                try:
                                    image(pid, uid, digest)
                                    with open(f"/proc/{pid}/stat", encoding="ascii") as source:
                                        actual_parent = int(source.read().rsplit(")", 1)[1].split()[1])
                                    if actual_parent != manager or readable(fd):
                                        raise ValueError("OWNED_PARENT_CHANGED")
                                    matches.append((pid, fd))
                                except BaseException:
                                    os.close(fd)
                                    raise
                            except FileNotFoundError:
                                continue
                        if len(matches) != 1:
                            for _, fd in matches:
                                os.close(fd)
                            raise ValueError("OWNED_WORKER_NOT_OBSERVED")
                        workers[lease] = matches[0]
                    pid, fd = workers[lease]
                    result = {"leaseId": lease, "pid": pid, "alive": not readable(fd), "kernelPidfd": True, "uid": uid, "imageSha256": digest}
                elif method == "observe":
                    result = {"managerAlive": not readable(manager_fd), "workers": [
                        {"leaseId": key, "pid": pid, "alive": not readable(fd), "kernelPidfd": True}
                        for key, (pid, fd) in workers.items()
                    ]}
                else:
                    raise ValueError("OWNED_OBSERVER_METHOD_UNAVAILABLE")
                response = {"id": request.get("id"), "result": result}
            except (OSError, ValueError):
                response = {"id": request.get("id"), "error": {"message": "OWNED_KERNEL_OBSERVATION_UNAVAILABLE"}}
            print(json.dumps(response), flush=True)
    finally:
        for _, fd in workers.values():
            os.close(fd)
        os.close(manager_fd)


if __name__ == "__main__":
    main()
