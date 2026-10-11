import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time

STATIC_ROOT = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root"
REMOTE_PARENT = "/tmp/kc-phone-ux-443-20261007-183008"
CONFIG_PATH = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile"
CONFIG_SHA256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c"
EXPECTED_PID = 255620
EXPECTED_ARGV_SHA256 = "f92e70d2ad0314635789f8f33a43ff2b52641db36378b1f02d7e364c90207c3c"
FORWARD_PORT = 32552
REMOTE_ALARM_SECONDS = 30
MAX_RELATIVE_DEPTH = 10
MAX_DIRECTORIES_PER_TREE = 64
MAX_ROOT_FILES = 37
MAX_STAGE_FILES_INCLUDING_OWNER_MARKER = 29
MAX_ROOT_FILE_BYTES = 6 * 1024 * 1024
MAX_ROOT_TOTAL_BYTES = 8 * 1024 * 1024
MAX_STAGE_FILE_BYTES = 1024 * 1024
MAX_STAGE_TOTAL_BYTES = 2 * 1024 * 1024
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
progress = {
    "mutationStarted": False,
    "removedDataFiles": 0,
    "removedDirectories": 0,
    "ownerMarkerRemoved": False,
    "stageRootRemoved": False,
}


class SafetyGate(Exception):
    pass


class OverallDeadline(Exception):
    pass


def phase(name, **fields):
    print("STAGE_CLEANUP_PHASE " + json.dumps({"phase": name, **fields}, separators=(",", ":")),
          file=sys.stderr, flush=True)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def stable_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def pinned_identity_matches(info, expected, include_size=True, include_nlink=False):
    matches = (
        stat.S_IMODE(info.st_mode) == expected.get("mode")
        and info.st_dev == expected.get("dev")
        and info.st_ino == expected.get("inode")
        and info.st_uid == expected.get("uid")
        and info.st_gid == expected.get("gid")
    )
    if include_size:
        matches = matches and info.st_size == expected.get("size")
    if include_nlink:
        matches = matches and info.st_nlink == expected.get("nlink")
    return matches


def stat_row(path, info):
    return {
        "path": path,
        "mode": stat.S_IMODE(info.st_mode),
        "uid": info.st_uid,
        "gid": info.st_gid,
        "dev": info.st_dev,
        "inode": info.st_ino,
        "size": info.st_size,
        "nlink": info.st_nlink,
        "mtimeNsExact": str(info.st_mtime_ns),
        "ctimeNsExact": str(info.st_ctime_ns),
    }


def projection(rows):
    return sorted([{"path": row["path"], "size": row["size"], "sha256": row["sha256"]} for row in rows],
                  key=lambda row: row["path"])


def projection_matches(actual, expected):
    return {row["path"]: (row["size"], row["sha256"]) for row in projection(actual)} == {
        row["path"]: (row["size"], row["sha256"]) for row in projection(expected)
    }


def bounded_command(name, args, timeout_seconds=4):
    phase(name + "_begin")
    started = time.monotonic_ns()
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        phase(name + "_timeout", boundMs=timeout_seconds * 1000)
        raise SafetyGate(name + "-timeout")
    phase(name + "_end", exitCode=result.returncode,
          durationMs=round((time.monotonic_ns() - started) / 1000000, 3),
          stdoutBytes=len(result.stdout.encode()), stderrBytes=len(result.stderr.encode()))
    return result


def process_info(pid):
    result = bounded_command("caddy_process_probe",
        ["sudo", "-n", "ps", "-p", str(pid), "-o", "pid=,ppid=,euid=,comm=,args="])
    if result.returncode != 0 or not result.stdout.strip():
        return None
    fields = result.stdout.strip().split(None, 4)
    if len(fields) < 5:
        return None
    argv = fields[4]
    return {
        "pid": int(fields[0]), "ppid": int(fields[1]), "euid": int(fields[2]), "comm": fields[3],
        "argvSha256": sha256_bytes(argv.encode()),
        "argvMatchesExpected": argv == "/usr/bin/caddy run --config " + CONFIG_PATH + " --adapter caddyfile",
    }


def listener_rows(port):
    result = bounded_command("listeners_" + str(port) + "_probe",
        ["sudo", "-n", "ss", "-H", "-ltnp", "sport = :" + str(port)])
    if result.returncode != 0:
        raise SafetyGate("listener-probe-failed-" + str(port))
    rows = []
    for line in result.stdout.splitlines():
        pids = sorted({int(value) for value in re.findall(r"pid=(\d+)", line)})
        rows.append({"ownerPids": pids})
    return rows


def config_identity():
    phase("config_probe_begin")
    if os.path.realpath(CONFIG_PATH) != CONFIG_PATH:
        raise SafetyGate("config-path-not-canonical")
    path_before = os.lstat(CONFIG_PATH)
    if stat.S_ISLNK(path_before.st_mode) or not stat.S_ISREG(path_before.st_mode) or path_before.st_size > 65536:
        raise SafetyGate("config-not-regular-or-over-bound")
    fd = os.open(CONFIG_PATH, os.O_RDONLY | O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or stable_identity(before) != stable_identity(path_before):
            raise SafetyGate("config-changed-before-read")
        content = os.read(fd, 65537)
        after = os.fstat(fd)
        path_after = os.lstat(CONFIG_PATH)
        if len(content) > 65536:
            raise SafetyGate("config-over-bound")
        if stable_identity(before) != stable_identity(after) or stable_identity(after) != stable_identity(path_after):
            raise SafetyGate("config-changed-during-read")
    finally:
        os.close(fd)
    digest = sha256_bytes(content)
    expected_root = ("root * " + STATIC_ROOT).encode()
    phase("config_probe_end", sha256Matches=(digest == CONFIG_SHA256), byteCount=len(content))
    return {"sha256": digest, "matches": digest == CONFIG_SHA256,
            "containsExpectedRoot": expected_root in content}


def owner_gates():
    phase("owner_gate_begin")
    caddy = process_info(EXPECTED_PID)
    listeners443 = listener_rows(443)
    listeners_forward = listener_rows(FORWARD_PORT)
    config = config_identity()
    listeners_match = bool(listeners443) and all(row["ownerPids"] == [EXPECTED_PID] for row in listeners443)
    sidecar_match = bool(
        caddy and caddy["pid"] == EXPECTED_PID and caddy["euid"] == 0 and caddy["comm"] == "caddy"
        and caddy["argvSha256"] == EXPECTED_ARGV_SHA256 and caddy["argvMatchesExpected"]
        and config["matches"] and config["containsExpectedRoot"] and listeners_match
    )
    forward_free = len(listeners_forward) == 0
    phase("owner_gate_end", sidecarMatches=sidecar_match, listeners443Match=listeners_match,
          forward32552Free=forward_free)
    return {
        "caddyProcess": caddy,
        "config": config,
        "listeners443": listeners443,
        "listeners32552": listeners_forward,
        "sidecarMatchesExpected": sidecar_match,
        "all443ListenersOwnedByExpectedSidecar": listeners_match,
        "forward32552Free": forward_free,
        "production8451Touched": False,
    }


def read_file_at(dirfd, name, rel, expected, max_bytes, owner=None):
    before = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise SafetyGate("tree-entry-not-regular-file")
    if before.st_nlink != 1 or before.st_size > max_bytes:
        raise SafetyGate("file-link-or-size-bound-failed")
    fd = os.open(name, os.O_RDONLY | O_NOFOLLOW, dir_fd=dirfd)
    try:
        fd_before = os.fstat(fd)
        if not stat.S_ISREG(fd_before.st_mode) or stable_identity(fd_before) != stable_identity(before):
            raise SafetyGate("file-changed-before-read")
        byte_count = 0
        digest = hashlib.sha256()
        chunks = []
        while True:
            chunk = os.read(fd, min(65536, max_bytes + 1 - byte_count))
            if not chunk:
                break
            byte_count += len(chunk)
            if byte_count > max_bytes:
                raise SafetyGate("file-read-over-bound")
            chunks.append(chunk)
            digest.update(chunk)
        fd_after = os.fstat(fd)
        path_after = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
        if stable_identity(fd_before) != stable_identity(fd_after) or stable_identity(fd_after) != stable_identity(path_after):
            raise SafetyGate("file-changed-during-read")
    finally:
        os.close(fd)
    if expected is not None and not pinned_identity_matches(fd_after, expected, include_nlink=True):
        raise SafetyGate("file-identity-drift")
    data = b"".join(chunks)
    if owner is not None:
        if data != owner.encode("utf-8"):
            raise SafetyGate("owner-marker-content-mismatch")
        return {"row": stat_row(rel, fd_after), "matchesRunOwner": True}
    row = stat_row(rel, fd_after)
    row["sha256"] = digest.hexdigest()
    if expected is not None and (row["size"] != expected.get("size") or row["sha256"] != expected.get("sha256")):
        raise SafetyGate("file-byte-projection-drift")
    return {"row": row}


def same_directory_identity(info, expected, compare_size=False):
    if not stat.S_ISDIR(info.st_mode):
        return False
    return pinned_identity_matches(info, expected, include_size=compare_size)


def open_directory_at(parent_fd, name, rel, expected=None):
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        raise SafetyGate("tree-entry-not-directory")
    if expected is not None and not same_directory_identity(before, expected, compare_size=True):
        raise SafetyGate("directory-identity-drift")
    fd = os.open(name, os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW, dir_fd=parent_fd)
    after = os.fstat(fd)
    if not stat.S_ISDIR(after.st_mode) or stable_identity(before) != stable_identity(after):
        os.close(fd)
        raise SafetyGate("directory-changed-before-open")
    return fd, stat_row(rel, after)


def scan_directory(fd, rel, kind, owner, expected_files=None, expected_dirs=None,
                   expected_marker=None, counters=None):
    if counters is None:
        counters = {"dirs": 0, "files": 0, "bytes": 0}
    dirs = []
    files = []
    marker = None
    for name in sorted(os.listdir(fd)):
        if name in ("", ".", "..") or "/" in name:
            raise SafetyGate("invalid-directory-entry-name")
        child_rel = (rel + "/" + name).strip("/")
        if len(child_rel.split("/")) > MAX_RELATIVE_DEPTH:
            raise SafetyGate("relative-depth-limit-exceeded")
        before = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISLNK(before.st_mode):
            raise SafetyGate("symlink-in-tree")
        if stat.S_ISDIR(before.st_mode):
            counters["dirs"] += 1
            if counters["dirs"] > MAX_DIRECTORIES_PER_TREE:
                raise SafetyGate("directory-count-limit-exceeded")
            expected = expected_dirs.get(child_rel) if expected_dirs is not None else None
            child_fd, row = open_directory_at(fd, name, child_rel, expected)
            try:
                child_dirs, child_files, child_marker = scan_directory(
                    child_fd, child_rel, kind, owner, expected_files, expected_dirs, expected_marker, counters)
                after = os.fstat(child_fd)
                path_after = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stable_identity(after) != stable_identity(path_after):
                    raise SafetyGate("directory-entry-changed-during-scan")
                dirs.append(row)
                dirs.extend(child_dirs)
                files.extend(child_files)
                if child_marker is not None:
                    if marker is not None:
                        raise SafetyGate("duplicate-owner-marker")
                    marker = child_marker
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(before.st_mode):
            counters["files"] += 1
            max_files = MAX_ROOT_FILES if kind == "root" else MAX_STAGE_FILES_INCLUDING_OWNER_MARKER
            if counters["files"] > max_files:
                raise SafetyGate("file-count-limit-exceeded")
            max_file_bytes = MAX_ROOT_FILE_BYTES if kind == "root" else MAX_STAGE_FILE_BYTES
            expected = expected_files.get(child_rel) if expected_files is not None else None
            is_marker = kind == "stage" and child_rel == ".kc-e2e-owner"
            if is_marker:
                marker_value = read_file_at(fd, name, child_rel, expected_marker, 128, owner)
                marker = {
                    **marker_value["row"],
                    "regularSingleLink": marker_value["row"]["nlink"] == 1,
                    "matchesRunOwner": marker_value["matchesRunOwner"],
                }
            else:
                value = read_file_at(fd, name, child_rel, expected, max_file_bytes)
                row = value["row"]
                counters["bytes"] += row["size"]
                total_limit = MAX_ROOT_TOTAL_BYTES if kind == "root" else MAX_STAGE_TOTAL_BYTES
                if counters["bytes"] > total_limit:
                    raise SafetyGate("tree-total-byte-limit-exceeded")
                files.append(row)
        else:
            raise SafetyGate("nonregular-entry-in-tree")
    return dirs, files, marker


def open_root_directory(path, expected=None, compare_size=True):
    if os.path.realpath(path) != path:
        raise SafetyGate("tree-root-not-canonical")
    before = os.lstat(path)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        raise SafetyGate("tree-root-not-directory")
    if expected is not None and not same_directory_identity(before, expected, compare_size=compare_size):
        raise SafetyGate("tree-root-identity-drift")
    fd = os.open(path, os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    after = os.fstat(fd)
    if stable_identity(before) != stable_identity(after):
        os.close(fd)
        raise SafetyGate("tree-root-changed-before-open")
    return fd, stat_row(".", after)


def scan_root(expected_files, expected_directories, expected_root):
    phase("static_root_projection_begin")
    fd, root_row = open_root_directory(STATIC_ROOT, expected_root, compare_size=True)
    try:
        dirs, files, _marker = scan_directory(fd, "", "root", None)
        after = os.fstat(fd)
        path_after = os.stat(STATIC_ROOT, follow_symlinks=False)
        if stable_identity(after) != stable_identity(path_after):
            raise SafetyGate("static-root-changed-during-scan")
    finally:
        os.close(fd)
    if not projection_matches(files, expected_files):
        raise SafetyGate("static-root-byte-projection-drift")
    if sorted(row["path"] for row in dirs) != sorted(row["path"] for row in expected_directories):
        raise SafetyGate("static-root-directory-projection-drift")
    phase("static_root_projection_end", fileCount=len(files), directoryCount=len(dirs),
          totalBytes=sum(row["size"] for row in files))
    return {"root": root_row, "directories": dirs, "files": files, "projectionExact": True}


def scan_stage(parent_fd, stage_name, owner, expected_root, expected_dirs, expected_files, expected_marker):
    phase("stage_projection_begin")
    stage_fd, root_row = open_directory_at(parent_fd, stage_name, "owned-stage-root", expected_root)
    try:
        dirs, files, marker = scan_directory(
            stage_fd, "", "stage", owner,
            {row["path"]: row for row in expected_files},
            {row["path"]: row for row in expected_dirs},
            expected_marker,
        )
        if marker is None or marker["matchesRunOwner"] is not True or marker["regularSingleLink"] is not True:
            raise SafetyGate("stage-owner-marker-gate-failed")
        if not projection_matches(files, expected_files):
            raise SafetyGate("stage-byte-projection-drift")
        if sorted(row["path"] for row in dirs) != sorted(row["path"] for row in expected_dirs):
            raise SafetyGate("stage-directory-projection-drift")
        phase("stage_projection_end", fileCount=len(files) + 1, dataFileCount=len(files),
              directoryCount=len(dirs), dataBytes=sum(row["size"] for row in files),
              ownerMarkerMatches=True)
        return {"fd": stage_fd, "root": root_row, "directories": dirs, "files": files,
                "ownerMarker": marker, "dataBytes": sum(row["size"] for row in files)}
    except Exception:
        os.close(stage_fd)
        raise


def expected_children(rel, expected_dirs, expected_files):
    children = {}
    for row in expected_dirs:
        parent, _, name = row["path"].rpartition("/")
        if parent == rel:
            children[name] = ("directory", row)
    for row in expected_files:
        parent, _, name = row["path"].rpartition("/")
        if parent == rel:
            children[name] = ("file", row)
    marker_parent, _, marker_name = ".kc-e2e-owner".rpartition("/")
    if marker_parent == rel:
        children[marker_name] = ("owner", None)
    return children


def unlink_verified_file(parent_fd, name, rel, expected, owner):
    marker = rel == ".kc-e2e-owner"
    value = read_file_at(parent_fd, name, rel, expected, 128 if marker else MAX_STAGE_FILE_BYTES,
                         owner if marker else None)
    if not marker and value["row"]["sha256"] != expected["sha256"]:
        raise SafetyGate("stage-byte-projection-drift-before-unlink")
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not pinned_identity_matches(current, expected, include_nlink=True):
        raise SafetyGate("stage-file-identity-drift-before-unlink")
    os.unlink(name, dir_fd=parent_fd)
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise SafetyGate("stage-file-entry-remained-after-unlink")
    if marker:
        progress["ownerMarkerRemoved"] = True
    else:
        progress["removedDataFiles"] += 1
    phase("stage_remove_file_complete", dataFileCount=progress["removedDataFiles"],
          ownerMarkerRemoved=progress["ownerMarkerRemoved"])


def remove_directory_contents(fd, rel, owner, expected_dirs, expected_files, expected_marker):
    expected = expected_children(rel, expected_dirs, expected_files)
    names = sorted(os.listdir(fd))
    if set(names) != set(expected):
        raise SafetyGate("stage-directory-entries-drift-before-unlink")
    for name in names:
        kind, row = expected[name]
        if kind != "directory":
            continue
        child_rel = (rel + "/" + name).strip("/")
        child_fd, _row = open_directory_at(fd, name, child_rel, row)
        try:
            remove_directory_contents(child_fd, child_rel, owner, expected_dirs, expected_files, expected_marker)
            if os.listdir(child_fd):
                raise SafetyGate("stage-child-directory-not-empty-after-unlink")
            child_after = os.fstat(child_fd)
            path_after = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not same_directory_identity(path_after, row, compare_size=False):
                raise SafetyGate("stage-directory-identity-drift-before-rmdir")
            if not stat.S_ISDIR(child_after.st_mode) or child_after.st_dev != path_after.st_dev or child_after.st_ino != path_after.st_ino:
                raise SafetyGate("stage-directory-fd-path-mismatch-before-rmdir")
            os.rmdir(name, dir_fd=fd)
            try:
                os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise SafetyGate("stage-directory-entry-remained-after-rmdir")
            progress["removedDirectories"] += 1
            phase("stage_remove_directory_complete", directoryCount=progress["removedDirectories"])
        finally:
            os.close(child_fd)

    for name in sorted(os.listdir(fd)):
        kind, row = expected.get(name, (None, None))
        if kind == "file":
            unlink_verified_file(fd, name, (rel + "/" + name).strip("/"), row, owner)
        elif kind == "owner":
            if rel != "":
                raise SafetyGate("owner-marker-outside-stage-root")
        else:
            raise SafetyGate("unexpected-stage-entry-during-delete")
    remaining = sorted(os.listdir(fd))
    if rel == "":
        if remaining != [".kc-e2e-owner"]:
            raise SafetyGate("owner-marker-not-last-stage-entry")
        unlink_verified_file(fd, ".kc-e2e-owner", ".kc-e2e-owner", expected_marker, owner)
    elif remaining:
        raise SafetyGate("nested-stage-directory-not-empty-after-delete")
    if os.listdir(fd):
        raise SafetyGate("stage-directory-not-empty-after-delete")


def valid_relative_path(value):
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value:
        return False
    parts = value.split("/")
    return all(part not in ("", ".", "..") and "\x00" not in part for part in parts)


def validate_projection_rows(rows, label, require_stat):
    if not isinstance(rows, list):
        raise SafetyGate(label + "-not-array")
    seen = set()
    total_bytes = 0
    for row in rows:
        if not isinstance(row, dict) or not valid_relative_path(row.get("path")):
            raise SafetyGate(label + "-invalid-path-row")
        path = row["path"]
        if path in seen:
            raise SafetyGate(label + "-duplicate-path")
        seen.add(path)
        size = row.get("size")
        digest = row.get("sha256")
        if type(size) is not int or size < 0 or size > MAX_ROOT_FILE_BYTES:
            raise SafetyGate(label + "-invalid-file-size")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise SafetyGate(label + "-invalid-file-digest")
        total_bytes += size
        if total_bytes > MAX_ROOT_TOTAL_BYTES:
            raise SafetyGate(label + "-total-byte-bound-exceeded")
        if require_stat:
            for key in ("mode", "uid", "gid", "dev", "inode", "nlink"):
                if type(row.get(key)) is not int or row[key] < 0:
                    raise SafetyGate(label + "-missing-stat-identity")
            if row["nlink"] != 1:
                raise SafetyGate(label + "-file-not-single-link")
    return total_bytes


def validate_directory_rows(rows, label, require_stat):
    if not isinstance(rows, list) or len(rows) > MAX_DIRECTORIES_PER_TREE:
        raise SafetyGate(label + "-not-bounded-array")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not valid_relative_path(row.get("path")):
            raise SafetyGate(label + "-invalid-path-row")
        if row["path"] in seen:
            raise SafetyGate(label + "-duplicate-path")
        seen.add(row["path"])
        if require_stat:
            for key in ("mode", "uid", "gid", "dev", "inode"):
                if type(row.get(key)) is not int or row[key] < 0:
                    raise SafetyGate(label + "-missing-stat-identity")
            if type(row.get("size")) is not int or row["size"] < 0:
                raise SafetyGate(label + "-missing-stat-size")
    return seen


def validate_directory_identity(row, label, include_size):
    if not isinstance(row, dict):
        raise SafetyGate(label + "-missing-identity")
    for key in ("mode", "uid", "gid", "dev", "inode"):
        if type(row.get(key)) is not int or row[key] < 0:
            raise SafetyGate(label + "-invalid-identity")
    if include_size and (type(row.get("size")) is not int or row["size"] < 0):
        raise SafetyGate(label + "-invalid-size")


def remove_stage(parent_fd, stage_name, stage_fd, owner, expected_root, expected_dirs,
                 expected_files, expected_marker):
    progress["mutationStarted"] = True
    phase("stage_remove_begin")
    remove_directory_contents(stage_fd, "", owner, expected_dirs, expected_files, expected_marker)
    if os.listdir(stage_fd):
        raise SafetyGate("stage-root-not-empty-before-rmdir")
    path_info = os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
    root_info = os.fstat(stage_fd)
    if not same_directory_identity(path_info, expected_root, compare_size=False):
        raise SafetyGate("stage-root-identity-drift-before-rmdir")
    if (not stat.S_ISDIR(root_info.st_mode) or root_info.st_dev != path_info.st_dev
            or root_info.st_ino != path_info.st_ino):
        raise SafetyGate("stage-root-fd-path-mismatch-before-rmdir")
    os.rmdir(stage_name, dir_fd=parent_fd)
    try:
        os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        progress["stageRootRemoved"] = True
    else:
        raise SafetyGate("stage-root-entry-remained-after-rmdir")
    progress["removedDirectories"] += 1
    phase("stage_remove_complete", removedDataFiles=progress["removedDataFiles"],
          removedDirectories=progress["removedDirectories"], ownerMarkerRemoved=progress["ownerMarkerRemoved"],
          stageRootRemoved=progress["stageRootRemoved"])


def main(request):
    owner = request.get("owner")
    if not isinstance(owner, str) or not re.fullmatch(r"[a-f0-9]{16}", owner):
        raise SafetyGate("invalid-owner-token-shape")
    stage_path = STATIC_ROOT + ".stage-" + owner
    if request.get("stageRoot") != stage_path or os.path.dirname(stage_path) != REMOTE_PARENT:
        raise SafetyGate("stage-path-not-exact-owned-child")
    stage_name = os.path.basename(stage_path)
    if stage_name != "mobile-web-root.stage-" + owner:
        raise SafetyGate("stage-basename-not-exact-owner-child")

    expected_root_files = request.get("expectedRootFiles")
    expected_root_directories = request.get("expectedRootDirectories")
    expected_stage_root = request.get("expectedStageRoot")
    expected_stage_dirs = request.get("expectedStageDirectories")
    expected_stage_files = request.get("expectedStageFiles")
    expected_marker = request.get("expectedOwnerMarker")
    expected_root_identity = request.get("expectedRootIdentity")
    if not all(isinstance(value, list) for value in
               (expected_root_files, expected_root_directories, expected_stage_dirs, expected_stage_files)):
        raise SafetyGate("expected-inputs-not-arrays")
    if len(expected_root_files) != 37 or len(expected_stage_files) != 28 or len(expected_stage_dirs) > 64:
        raise SafetyGate("expected-input-count-bound-failed")
    if validate_projection_rows(expected_root_files, "expected-root-files", False) != 4644388:
        raise SafetyGate("expected-root-byte-total-mismatch")
    if validate_projection_rows(expected_stage_files, "expected-stage-files", True) != 385386:
        raise SafetyGate("expected-stage-byte-total-mismatch")
    expected_root_directory_paths = validate_directory_rows(
        expected_root_directories, "expected-root-directories", False)
    expected_stage_directory_paths = validate_directory_rows(expected_stage_dirs, "expected-stage-directories", True)
    if len(expected_root_directory_paths) != 18 or len(expected_stage_directory_paths) != 17:
        raise SafetyGate("expected-directory-count-mismatch")
    if ".kc-e2e-owner" in expected_stage_directory_paths or ".kc-e2e-owner" in {
            row.get("path") for row in expected_stage_files if isinstance(row, dict)}:
        raise SafetyGate("owner-marker-misclassified")
    validate_directory_identity(expected_stage_root, "expected-stage-root", True)
    if expected_stage_root.get("path") != "owned-stage-root":
        raise SafetyGate("expected-stage-root-label-mismatch")
    validate_directory_identity(expected_root_identity, "expected-static-root", True)
    if expected_root_identity.get("path") != "mobile-web-root":
        raise SafetyGate("expected-static-root-label-mismatch")
    if not isinstance(expected_marker, dict) or expected_marker.get("path") != ".kc-e2e-owner":
        raise SafetyGate("expected-owner-marker-missing")
    if (expected_marker.get("size") != 16 or expected_marker.get("nlink") != 1
            or expected_marker.get("regularSingleLink") is not True
            or expected_marker.get("matchesRunOwner") is not True):
        raise SafetyGate("expected-owner-marker-evidence-invalid")
    for key in ("mode", "uid", "gid", "dev", "inode", "nlink"):
        if type(expected_marker.get(key)) is not int or expected_marker[key] < 0:
            raise SafetyGate("expected-owner-marker-identity-invalid")

    gates_before = owner_gates()
    if not gates_before["sidecarMatchesExpected"] or not gates_before["all443ListenersOwnedByExpectedSidecar"]:
        raise SafetyGate("isolated-caddy-owner-gate-failed")
    if not gates_before["forward32552Free"]:
        raise SafetyGate("remote-forward-port-not-free")
    root_before = scan_root(expected_root_files, expected_root_directories, expected_root_identity)

    if os.path.realpath(REMOTE_PARENT) != REMOTE_PARENT:
        raise SafetyGate("stage-parent-not-canonical")
    parent_before = os.lstat(REMOTE_PARENT)
    if stat.S_ISLNK(parent_before.st_mode) or not stat.S_ISDIR(parent_before.st_mode):
        raise SafetyGate("stage-parent-not-directory")
    parent_fd = os.open(REMOTE_PARENT, os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    stage_snapshot = None
    parent_identity = None
    try:
        if stable_identity(parent_before) != stable_identity(os.fstat(parent_fd)):
            raise SafetyGate("stage-parent-changed-before-open")
        parent_identity = stat_row("stage-parent", os.fstat(parent_fd))
        stage_snapshot = scan_stage(parent_fd, stage_name, owner, expected_stage_root,
                                    expected_stage_dirs, expected_stage_files, expected_marker)
        if len(stage_snapshot["files"]) != 28 or stage_snapshot["dataBytes"] != 385386:
            raise SafetyGate("stage-count-or-byte-bound-mismatch")
        if len(stage_snapshot["directories"]) != len(expected_stage_dirs):
            raise SafetyGate("stage-directory-count-mismatch")
        phase("preflight_gates_complete", rootProjectionExact=True, stageProjectionExact=True,
              ownerMarkerMatches=True)
        remove_stage(parent_fd, stage_name, stage_snapshot["fd"], owner, expected_stage_root,
                     expected_stage_dirs, expected_stage_files, expected_marker)
    finally:
        if stage_snapshot is not None:
            os.close(stage_snapshot["fd"])
        os.close(parent_fd)

    phase("postflight_begin")
    gates_after = owner_gates()
    root_after = scan_root(expected_root_files, expected_root_directories, expected_root_identity)
    post_parent_fd, _post_parent_row = open_root_directory(
        REMOTE_PARENT, parent_identity, compare_size=False)
    try:
        try:
            os.stat(stage_name, dir_fd=post_parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            stage_absent = True
        else:
            stage_absent = False
    finally:
        os.close(post_parent_fd)
    if not gates_after["sidecarMatchesExpected"] or not gates_after["all443ListenersOwnedByExpectedSidecar"]:
        raise SafetyGate("isolated-caddy-owner-gate-changed-after-cleanup")
    if not gates_after["forward32552Free"]:
        raise SafetyGate("remote-forward-port-became-occupied")
    if not stage_absent or not progress["stageRootRemoved"] or not progress["ownerMarkerRemoved"]:
        raise SafetyGate("stage-removal-not-proven")
    phase("postflight_complete", oldRootProjectionExact=True, stageRootAbsent=True)
    return {
        "gatesBefore": gates_before,
        "gatesAfter": gates_after,
        "rootBefore": root_before,
        "rootAfter": root_after,
        "rootProjectionUnchanged": projection_matches(root_after["files"], expected_root_files),
        "stageBefore": {
            "root": stage_snapshot["root"],
            "directories": stage_snapshot["directories"],
            "files": stage_snapshot["files"],
            "ownerMarker": stage_snapshot["ownerMarker"],
            "projectionExact": True,
            "dataFileCount": len(stage_snapshot["files"]),
            "dataBytes": stage_snapshot["dataBytes"],
        },
        "cleanup": dict(progress),
        "stageRootAbsent": stage_absent,
        "readOnlyRootChecksAndExactOwnedStageUnlinkOnly": True,
        "rootExchangeDeleteReloadSignalOrServiceStartupAttempted": False,
        "production8451Touched": False,
        "contentProjectionFields": ["relative path", "size", "sha256"],
        "timestampsUsedForContentComparison": False,
        "metadataNsEncoding": "decimal strings in mtimeNsExact/ctimeNsExact",
    }


def alarm_handler(_signum, _frame):
    raise OverallDeadline("remote-overall-30s-alarm")


def run():
    signal.signal(signal.SIGALRM, alarm_handler)
    signal.alarm(REMOTE_ALARM_SECONDS)
    try:
        phase("remote_python_started")
        payload = sys.stdin.buffer.read()
        phase("request_stdin_eof", bytes=len(payload), eof=True)
        request = json.loads(payload.decode("utf-8"))
        phase("request_parsed", ownerTokenPresent=isinstance(request.get("owner"), str))
        result = main(request)
        phase("remote_response_ready", stageRemoved=result["stageRootAbsent"])
        print(json.dumps({"ok": True, "result": result}, separators=(",", ":")), flush=True)
        return 0
    except OverallDeadline:
        phase("remote_overall_alarm", boundSeconds=REMOTE_ALARM_SECONDS,
              mutationStarted=progress["mutationStarted"])
        print(json.dumps({"ok": False, "errorType": "RemoteOverallDeadline",
                          "cleanupProgress": dict(progress)}, separators=(",", ":")), flush=True)
        return 3
    except SafetyGate as exc:
        phase("remote_safety_gate_failed", code=str(exc), mutationStarted=progress["mutationStarted"])
        print(json.dumps({"ok": False, "errorType": "SafetyGate",
                          "code": str(exc), "cleanupProgress": dict(progress)}, separators=(",", ":")), flush=True)
        return 4
    except Exception as exc:
        phase("remote_inspection_error", errorType=type(exc).__name__,
              mutationStarted=progress["mutationStarted"])
        print(json.dumps({"ok": False, "errorType": type(exc).__name__,
                          "cleanupProgress": dict(progress)}, separators=(",", ":")), flush=True)
        return 5
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(run())
