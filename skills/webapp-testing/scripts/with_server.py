#!/usr/bin/env python3
"""Start foreground servers, verify their listeners, run a command, and stop their groups.

Example: with_server.py --server "npm run dev" --port 5173 -- python test.py
Linux verifies listener ownership through /proc; macOS requires lsof and ps.
"""

import argparse
import ctypes
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

LOG_LIMIT = 64 * 1024


class LogTail:
    """Continuously drain a pipe while retaining only its bounded tail."""

    def __init__(self, stream):
        self.stream = stream
        self.data = bytearray()
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.drain, daemon=True)
        self.thread.start()

    def drain(self):
        try:
            while chunk := self.stream.read(8192):
                with self.lock:
                    self.data.extend(chunk)
                    del self.data[:-LOG_LIMIT]
        finally:
            self.stream.close()

    def text(self):
        with self.lock:
            return bytes(self.data).decode("utf-8", errors="replace")


def group_members(group):
    if sys.platform == "linux":
        members = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                if int(fields[2]) == group and fields[0] not in ("Z", "X"):
                    members.append(int(entry.name))
            except (OSError, ValueError, IndexError):
                continue
        return members
    result = subprocess.run(["ps", "-axo", "pid=,pgid=,stat="], capture_output=True,
                            text=True, check=True, timeout=2)
    return [int(pid) for pid, pgid, state in (line.split() for line in result.stdout.splitlines())
            if int(pgid) == group and not state.startswith("Z")]


def owns_listener(group, port):
    if sys.platform == "linux":
        inodes = set()
        for table in ("tcp", "tcp6"):
            for line in (Path("/proc/net") / table).read_text().splitlines()[1:]:
                fields = line.split()
                if fields[3] == "0A" and int(fields[1].split(":")[1], 16) == port:
                    inodes.add(fields[9])
        owned = set()
        for pid in group_members(group):
            try:
                for fd in (Path("/proc") / str(pid) / "fd").iterdir():
                    try:
                        target = os.readlink(fd)
                        if target.startswith("socket:["):
                            owned.add(target[8:-1])
                    except OSError:
                        continue
            except OSError:
                continue
        return bool(inodes) and inodes <= owned
    result = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                            capture_output=True, text=True, timeout=2)
    listeners = {int(pid) for pid in result.stdout.split()}
    return bool(listeners) and listeners <= set(group_members(group))


def port_open(port):
    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return True
        except OSError:
            pass
    return False


def wait_ready(process, port, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        code = process.poll()
        if code is not None:
            raise RuntimeError(f"Server exited {code} before readiness on port {port}")
        if owns_listener(process.pid, port) and port_open(port) and process.poll() is None:
            return
        time.sleep(0.05)
    raise RuntimeError(f"No owned server listener on port {port} within {timeout}s")


def linux_children():
    """All descendants, including children adopted after a daemon parent exits."""
    records = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            records[int(entry.name)] = (int(fields[1]), fields[0], fields[19])
        except (OSError, ValueError, IndexError):
            continue
    descendants = {os.getpid()}
    while True:
        found = {pid for pid, (parent, _state, _born) in records.items() if parent in descendants}
        expanded = descendants | found
        if expanded == descendants:
            break
        descendants = expanded
    return {pid: records[pid] for pid in descendants if pid != os.getpid()}


def stop_adopted_children():
    if sys.platform != "linux":
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid, (_, state, birth) in linux_children().items():
            try:
                current = (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
                if current[19] == birth and state != "Z":
                    os.kill(pid, sig)
            except (OSError, IndexError):
                pass
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            children = linux_children()
            for pid, (parent, state, _birth) in children.items():
                if parent == os.getpid() and state == "Z":
                    try:
                        os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
            if not linux_children():
                return
            time.sleep(0.05)
    raise RuntimeError("Owned descendant cleanup could not be confirmed")


def stop_server(process):
    for sig, grace in ((signal.SIGTERM, 2), (signal.SIGKILL, 2)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + grace
        while group_members(process.pid) and time.monotonic() < deadline:
            process.poll()
            time.sleep(0.05)
        if not group_members(process.pid):
            break
    process.wait(timeout=1)
    if group_members(process.pid):
        raise RuntimeError(f"Server group {process.pid} cleanup could not be confirmed")


def interrupted(signum, _frame):
    raise KeyboardInterrupt(f"Received signal {signum}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", action="append", dest="servers", required=True)
    parser.add_argument("--port", action="append", dest="ports", type=int, required=True)
    parser.add_argument("--timeout", type=float, default=30, help="Startup timeout per server")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command or len(args.servers) != len(args.ports) or args.timeout <= 0:
        parser.error("A command, positive timeout, and one port per server are required")
    if any(not 0 < port < 65536 for port in args.ports) or len(set(args.ports)) != len(args.ports):
        parser.error("Ports must be unique and between 1 and 65535")
    if sys.platform not in ("linux", "darwin"):
        parser.error("Owned server lifecycle currently requires Linux or macOS")
    if sys.platform == "darwin" and not all(shutil.which(tool) for tool in ("lsof", "ps")):
        parser.error("macOS listener verification requires lsof and ps")
    if sys.platform == "linux":
        # Adopt orphaned grandchildren so detaching cannot leave an owned daemon behind.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            parser.error("Linux child-subreaper ownership could not be initialized")
    servers = []
    command_process = None
    exit_code = 1
    signal.signal(signal.SIGTERM, interrupted)
    try:
        # Preflight every port before starting any server. Ownership is checked again at readiness.
        for port in args.ports:
            if port_open(port):
                raise RuntimeError(f"Port {port} already has a listener")
        for command, port in zip(args.servers, args.ports):
            print(f"Starting server on port {port}", flush=True)
            process = subprocess.Popen(command, shell=True, start_new_session=True,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            logs = [LogTail(process.stdout), LogTail(process.stderr)]
            servers.append((process, logs))
            wait_ready(process, port, args.timeout)
            print(f"Owned server ready on port {port}", flush=True)
        command_process = subprocess.Popen(args.command, start_new_session=True)
        exit_code = command_process.wait()
        for process, _ in servers:
            if process.poll() is not None:
                raise RuntimeError(f"Server exited {process.returncode} while the command ran")
    except KeyboardInterrupt:
        exit_code = 130
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        for index, (_, logs) in enumerate(servers, 1):
            for channel, log in zip(("stdout", "stderr"), logs):
                print(f"Server {index} {channel} tail (at most {LOG_LIMIT} bytes):\n{log.text()}", file=sys.stderr)
        exit_code = 1
    finally:
        if command_process is not None:
            try:
                stop_server(command_process)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                print(f"Error: Command cleanup failed: {error}", file=sys.stderr)
                exit_code = 1
        for index, (process, logs) in enumerate(servers, 1):
            try:
                stop_server(process)
                print(f"Server {index} group stopped", flush=True)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                print(f"Error: {error}", file=sys.stderr)
                exit_code = 1
        try:
            stop_adopted_children()
            for _process, logs in servers:
                for log in logs:
                    log.thread.join(timeout=1)
                    if log.thread.is_alive():
                        raise RuntimeError("Owned server log pipes did not close after cleanup")
        except (OSError, RuntimeError) as error:
            print(f"Error: {error}", file=sys.stderr)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
