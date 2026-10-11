import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const pinnedNode = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const pinnedNodeSha256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const originalRunRoot = resolve(
  repoRoot,
  "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-no-reload-setup.e2e.mjs/20261008-114641.574Z",
);
const e2eBoundary = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
const privateWebRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
const originalStaticRoot = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root";
const originalStageParent = "/tmp/kc-phone-ux-443-20261007-183008";
const expectedSidecarPid = 255620;
const expectedSidecarArgvSha256 = "f92e70d2ad0314635789f8f33a43ff2b52641db36378b1f02d7e364c90207c3c";
const expectedSidecarConfigPath = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile";
const expectedSidecarConfigSha256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c";
const remoteForwardPort = 32552;
const expectedBundleManifestPath = resolve(privateWebRoot, "mobile-web-export-follow-after-f643bc69-20261008-manifest.json");
const expectedBundleRoot = resolve(privateWebRoot, "mobile-web-export-follow-after-f643bc69-20261008");
const expectedBundleManifestSha256 = "fbe0181a60e42f7ef87f8f9cbac356b88776e416e3d9de9e886a9a1dad52d0b3";
const expectedBundleSha256 = "217a045ecae2f5bc7712455ec198e6546e2a9d1ca4265da8b836877a0323c03c";

const originalManifestBytes = await readRegularFile(resolve(originalRunRoot, "manifest.json"), e2eBoundary);
const originalManifest = JSON.parse(originalManifestBytes.toString("utf8"));
assert.equal(originalManifest.status, "failed", "the original failed upload remains immutable evidence");
assert.equal(originalManifest.testId, "mobile-high-latency-public-no-reload-setup");
assert.match(originalManifest.seed, /^[a-f0-9]{16}$/);

const originalStaticManifestBytes = await readRegularFile(
  resolve(originalRunRoot, "artifacts/existing-static-root-manifest.json"),
  e2eBoundary,
);
const originalStaticTree = JSON.parse(originalStaticManifestBytes.toString("utf8"));
assert.equal(originalStaticTree.root.path, "mobile-web-root");
assert.equal(originalStaticTree.files.length, 37);

const originalInputsBytes = await readRegularFile(resolve(originalRunRoot, "artifacts/public-no-reload-inputs.json"), e2eBoundary);
const originalInputs = JSON.parse(originalInputsBytes.toString("utf8"));
assert.equal(originalInputs.isolatedStaticRoot, originalStaticRoot);
assert.equal(originalInputs.isolatedSidecarPid, expectedSidecarPid);
assert.equal(originalInputs.isolatedSidecarConfigSha256, expectedSidecarConfigSha256);
assert.equal(originalInputs.remoteReverseForwardPort, remoteForwardPort);
assert.equal(originalInputs.productionRelayPortTouched, false);

const bundleManifestBytes = await readRegularFile(expectedBundleManifestPath, privateWebRoot);
assert.equal(sha256(bundleManifestBytes), expectedBundleManifestSha256);
const bundleManifest = JSON.parse(bundleManifestBytes.toString("utf8"));
assert.equal(bundleManifest.bundleSha256, expectedBundleSha256);
assert.equal(bundleManifest.bundleFileCount, 37);
const expectedOriginalRootFiles = normalizeFileRows(originalStaticTree.files);
const expectedBundleFiles = normalizeFileRows(bundleManifest.bundleFiles);
assert.deepEqual(normalizeFileRows(originalInputs.mobileWeb.bundleFiles), expectedBundleFiles);
await verifyBundleFiles(expectedBundleRoot, expectedBundleFiles);

const inputEvidence = {
  originalRunManifestSha256: sha256(originalManifestBytes),
  originalStaticManifestSha256: sha256(originalStaticManifestBytes),
  originalInputsSha256: sha256(originalInputsBytes),
  originalRootExpectedFileCount: expectedOriginalRootFiles.length,
  originalRootExpectedFileProjectionSha256: sha256(Buffer.from(JSON.stringify(expectedOriginalRootFiles))),
  frozenBundleManifestPath: expectedBundleManifestPath,
  frozenBundleManifestSha256: sha256(bundleManifestBytes),
  frozenBundleSha256: bundleManifest.bundleSha256,
  frozenBundleFileCount: expectedBundleFiles.length,
  frozenBundleFileProjectionSha256: sha256(Buffer.from(JSON.stringify(expectedBundleFiles))),
  sourceOfExpectedRootRows: "114641 existing-static-root-manifest.json; compare relative path/size/sha256 only",
  sourceOfExpectedStagedBundleRows: "original 114641 public-no-reload-inputs.json cross-checked against pinned 37-file bundle manifest",
};

const remotePython = String.raw`
import hashlib, json, os, re, signal, stat, subprocess, sys, time

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

class InspectionLimit(Exception):
    pass

def phase(name, **fields):
    print("READONLY_PHASE " + json.dumps({"phase": name, **fields}, separators=(",", ":")), file=sys.stderr, flush=True)

def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()

def stat_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)

def stat_row(path, info):
    return {
        "path": path,
        "mode": stat.S_IMODE(info.st_mode),
        "uid": info.st_uid,
        "gid": info.st_gid,
        "dev": info.st_dev,
        "inode": info.st_ino,
        "size": info.st_size,
        "mtimeNsExact": str(info.st_mtime_ns),
        "ctimeNsExact": str(info.st_ctime_ns),
    }

def bounded_command(name, args, timeout_seconds=4):
    phase(name + "_begin")
    started = time.monotonic_ns()
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                timeout=timeout_seconds)
        duration_ms = (time.monotonic_ns() - started) / 1000000
        phase(name + "_end", exitCode=result.returncode, durationMs=round(duration_ms, 3),
              stdoutBytes=len(result.stdout.encode()), stderrBytes=len(result.stderr.encode()), timedOut=False)
        return result, {"timedOut": False, "exitCode": result.returncode, "durationMs": round(duration_ms, 3)}
    except subprocess.TimeoutExpired:
        duration_ms = (time.monotonic_ns() - started) / 1000000
        phase(name + "_timeout", durationMs=round(duration_ms, 3), boundMs=timeout_seconds * 1000)
        return None, {"timedOut": True, "exitCode": None, "durationMs": round(duration_ms, 3)}

def process_info(pid):
    result, measured = bounded_command(
        "caddy_process_probe",
        ["sudo", "-n", "ps", "-p", str(pid), "-o", "pid=,ppid=,euid=,comm=,args="],
    )
    if result is None or result.returncode != 0 or not result.stdout.strip():
        return {"probe": measured, "process": None}
    fields = result.stdout.strip().split(None, 4)
    if len(fields) < 5:
        return {"probe": measured, "process": {"fieldCount": len(fields)}}
    argv = fields[4]
    return {
        "probe": measured,
        "process": {
            "pid": int(fields[0]), "ppid": int(fields[1]), "euid": int(fields[2]), "comm": fields[3],
            "argvSha256": sha256_bytes(argv.encode()),
            "argvMatchesExpected": argv == "/usr/bin/caddy run --config " + CONFIG_PATH + " --adapter caddyfile",
        },
    }

def listener_rows(port):
    result, measured = bounded_command(
        "listeners_" + str(port) + "_probe",
        ["sudo", "-n", "ss", "-H", "-ltnp", "sport = :" + str(port)],
    )
    if result is None or result.returncode != 0:
        return {"probe": measured, "rows": None}
    rows = []
    for line in result.stdout.splitlines():
        pids = sorted({int(value) for value in re.findall(r"pid=(\d+)", line)})
        rows.append({"ownerPids": pids})
    return {"probe": measured, "rows": rows}

def inspect_config():
    phase("caddy_config_probe_begin")
    info = os.lstat(CONFIG_PATH)
    if (os.path.realpath(CONFIG_PATH) != CONFIG_PATH or stat.S_ISLNK(info.st_mode)
            or not stat.S_ISREG(info.st_mode) or info.st_size > 65536):
        raise InspectionLimit("caddy-config-not-regular-or-over-size-bound")
    fd = os.open(CONFIG_PATH, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        fd_before = os.fstat(fd)
        if not stat.S_ISREG(fd_before.st_mode) or stat_identity(fd_before) != stat_identity(info):
            raise InspectionLimit("caddy-config-changed-before-read")
        content = os.read(fd, 65537)
        fd_after = os.fstat(fd)
        path_after = os.lstat(CONFIG_PATH)
        if len(content) > 65536:
            raise InspectionLimit("caddy-config-over-size-bound")
        if (stat_identity(fd_before) != stat_identity(fd_after)
                or stat_identity(fd_after) != stat_identity(path_after)):
            raise InspectionLimit("caddy-config-changed-during-read")
    finally:
        os.close(fd)
    actual_sha = sha256_bytes(content)
    contains_expected_root = ("root * " + STATIC_ROOT).encode() in content
    phase("caddy_config_probe_end", bytes=len(content), sha256Matches=(actual_sha == CONFIG_SHA256))
    return {"sha256": actual_sha, "sha256Matches": actual_sha == CONFIG_SHA256,
            "containsExpectedStaticRoot": contains_expected_root, "regularNonSymlink": True}

def tree_identity(path, root_label):
    if not os.path.lexists(path):
        return None
    if os.path.islink(path) or os.path.realpath(path) != path or not os.path.isdir(path):
        raise InspectionLimit("tree-root-not-canonical-directory")
    root_before = os.lstat(path)
    directory_infos = {".": root_before}
    directories = []
    files = []
    owner_marker = None
    file_count_including_marker = 0
    total_bytes = 0
    max_files = MAX_ROOT_FILES if root_label == "mobile-web-root" else MAX_STAGE_FILES_INCLUDING_OWNER_MARKER
    max_bytes = MAX_ROOT_TOTAL_BYTES if root_label == "mobile-web-root" else MAX_STAGE_TOTAL_BYTES
    max_file_bytes = MAX_ROOT_FILE_BYTES if root_label == "mobile-web-root" else MAX_STAGE_FILE_BYTES
    phase(root_label.replace("-", "_") + "_tree_walk_begin")
    def walk_error(error):
        raise InspectionLimit("tree-walk-error-" + type(error).__name__)

    for current, dirnames, filenames in os.walk(path, topdown=True, onerror=walk_error, followlinks=False):
        dirnames.sort()
        filenames.sort()
        rel_current = os.path.relpath(current, path).replace(os.sep, "/")
        if rel_current == ".":
            rel_current = ""
        for name in list(dirnames):
            rel = (rel_current + "/" + name).strip("/")
            depth = len(rel.split("/"))
            if depth > MAX_RELATIVE_DEPTH:
                raise InspectionLimit("relative-directory-depth-limit-exceeded")
            directory_path = os.path.join(current, name)
            info = os.lstat(directory_path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise InspectionLimit("symlink-or-nondirectory-in-tree")
            directory_infos[rel] = info
            directories.append(stat_row(rel, info))
            if len(directories) > MAX_DIRECTORIES_PER_TREE:
                raise InspectionLimit("directory-count-limit-exceeded")
        for name in filenames:
            rel = (rel_current + "/" + name).strip("/")
            depth = len(rel.split("/"))
            if depth > MAX_RELATIVE_DEPTH:
                raise InspectionLimit("relative-file-depth-limit-exceeded")
            file_count_including_marker += 1
            if file_count_including_marker > max_files:
                raise InspectionLimit("file-count-limit-exceeded")
            file_path = os.path.join(current, name)
            before = os.lstat(file_path)
            if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
                raise InspectionLimit("symlink-or-nonfile-in-tree")
            if before.st_size > max_file_bytes:
                raise InspectionLimit("single-file-size-limit-exceeded")
            total_bytes += before.st_size
            if total_bytes > max_bytes:
                raise InspectionLimit("tree-total-byte-limit-exceeded")
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(file_path, flags)
            try:
                fd_before = os.fstat(fd)
                if not stat.S_ISREG(fd_before.st_mode) or stat_identity(fd_before) != stat_identity(before):
                    raise InspectionLimit("file-changed-before-hash")
                is_owner_marker = root_label == "owned-stage-root" and rel == ".kc-e2e-owner"
                if is_owner_marker:
                    payload = os.read(fd, 129)
                    fd_after = os.fstat(fd)
                    path_after = os.lstat(file_path)
                    if len(payload) > 128:
                        raise InspectionLimit("owner-marker-size-limit-exceeded")
                    if (stat_identity(fd_before) != stat_identity(fd_after)
                            or stat_identity(fd_after) != stat_identity(path_after)):
                        raise InspectionLimit("owner-marker-changed-during-read")
                    marker_matches = payload.decode("utf-8", errors="strict") == request_owner
                    owner_marker = {
                        **stat_row(rel, fd_after),
                        "regularSingleLink": stat.S_ISREG(fd_after.st_mode) and fd_after.st_nlink == 1,
                        "matchesRunOwner": marker_matches,
                    }
                else:
                    digest = hashlib.sha256()
                    while True:
                        chunk = os.read(fd, 1024 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
                    fd_after = os.fstat(fd)
                    path_after = os.lstat(file_path)
                    if stat_identity(fd_before) != stat_identity(fd_after) or stat_identity(fd_after) != stat_identity(path_after):
                        raise InspectionLimit("file-changed-during-hash")
                    row = stat_row(rel, fd_after)
                    row["sha256"] = digest.hexdigest()
                    files.append(row)
            finally:
                os.close(fd)
    for rel, before in directory_infos.items():
        directory_path = path if rel == "." else os.path.join(path, *rel.split("/"))
        if stat_identity(before) != stat_identity(os.lstat(directory_path)):
            raise InspectionLimit("directory-changed-during-inspection")
    root_after = os.lstat(path)
    if stat_identity(root_before) != stat_identity(root_after):
        raise InspectionLimit("tree-root-changed-during-inspection")
    result = {
        "complete": True,
        "root": stat_row(root_label, root_after),
        "directories": sorted(directories, key=lambda row: row["path"]),
        "files": sorted(files, key=lambda row: row["path"]),
        "ownerMarker": owner_marker,
        "fileCountIncludingOwnerMarker": file_count_including_marker,
        "dataFileCount": len(files),
        "totalBytesIncludingOwnerMarker": total_bytes,
        "metadataNsEncoding": "decimal strings in mtimeNsExact/ctimeNsExact",
        "contentProjectionFields": ["path", "size", "sha256"],
    }
    phase(root_label.replace("-", "_") + "_tree_walk_end", fileCount=file_count_including_marker,
          dataFileCount=len(files), directoryCount=len(directories), totalBytes=total_bytes)
    return result

def file_projection(files):
    return sorted([{"path": row["path"], "size": row["size"], "sha256": row["sha256"]} for row in files],
                  key=lambda row: row["path"])

def main(request):
    global request_owner
    request_owner = request.get("owner")
    if not isinstance(request_owner, str) or not re.fullmatch(r"[a-f0-9]{16}", request_owner):
        raise InspectionLimit("invalid-run-owner-token-shape")
    stage_path = request.get("stageRoot")
    if stage_path != STATIC_ROOT + ".stage-" + request_owner or os.path.dirname(stage_path) != REMOTE_PARENT:
        raise InspectionLimit("stage-path-outside-exact-owner-boundary")

    phase("owner_probe_begin")
    caddy_probe = process_info(EXPECTED_PID)
    listeners_443 = listener_rows(443)
    listeners_forward = listener_rows(FORWARD_PORT)
    config = inspect_config()
    caddy = caddy_probe["process"]
    rows_443 = listeners_443["rows"]
    rows_forward = listeners_forward["rows"]
    listeners_match = rows_443 is not None and bool(rows_443) and all(
        row["ownerPids"] == [EXPECTED_PID] for row in rows_443
    )
    sidecar_matches = bool(
        caddy and caddy.get("pid") == EXPECTED_PID and caddy.get("euid") == 0 and caddy.get("comm") == "caddy"
        and caddy.get("argvSha256") == EXPECTED_ARGV_SHA256 and caddy.get("argvMatchesExpected") is True
        and config["sha256Matches"] is True and config["containsExpectedStaticRoot"] is True
        and listeners_match
    )
    phase("owner_probe_end", expectedProcessVisible=bool(caddy and caddy.get("pid") == EXPECTED_PID),
          expectedConfig=config["sha256Matches"], listenerOwnerMatches=listeners_match,
          forwardPortFree=(rows_forward is not None and len(rows_forward) == 0))

    phase("static_root_inspection_begin")
    root = tree_identity(STATIC_ROOT, "mobile-web-root")
    phase("static_root_inspection_complete", exists=root is not None)
    phase("stage_inspection_begin")
    stage = tree_identity(stage_path, "owned-stage-root")
    phase("stage_inspection_complete", exists=stage is not None)
    return {
        "caddyProcessProbe": caddy_probe,
        "caddyConfig": config,
        "listeners443": listeners_443,
        "listeners32552": listeners_forward,
        "sidecarMatchesExpected": sidecar_matches,
        "all443ListenersOwnedByExpectedSidecar": listeners_match,
        "forward32552Free": rows_forward is not None and len(rows_forward) == 0,
        "staticRoot": root,
        "stage": stage,
        "readOnlyActionsOnly": True,
        "treeWalkLimits": {
            "remoteOverallAlarmSeconds": REMOTE_ALARM_SECONDS,
            "maxRelativeDepth": MAX_RELATIVE_DEPTH,
            "maxDirectoriesPerTree": MAX_DIRECTORIES_PER_TREE,
            "maxRootFiles": MAX_ROOT_FILES,
            "maxStageFilesIncludingOwnerMarker": MAX_STAGE_FILES_INCLUDING_OWNER_MARKER,
            "maxRootFileBytes": MAX_ROOT_FILE_BYTES,
            "maxRootTotalBytes": MAX_ROOT_TOTAL_BYTES,
            "maxStageFileBytes": MAX_STAGE_FILE_BYTES,
            "maxStageTotalBytes": MAX_STAGE_TOTAL_BYTES,
        },
        "metadataNsAreStrings": True,
        "timestampsUsedForByteComparison": False,
        "byteComparisonFields": ["path", "size", "sha256"],
        "exchangeDeleteReloadSignalOrServiceStartupAttempted": False,
        "production8451Touched": False,
    }

class OverallDeadline(Exception):
    pass

def alarm_handler(_signum, _frame):
    raise OverallDeadline("remote-overall-30s-alarm")

request_owner = None
signal.signal(signal.SIGALRM, alarm_handler)
signal.alarm(REMOTE_ALARM_SECONDS)
try:
    phase("remote_python_started")
    payload = sys.stdin.buffer.read()
    phase("request_stdin_eof", bytes=len(payload), eof=True)
    request = json.loads(payload.decode("utf-8"))
    phase("request_parsed", ownerTokenPresent=isinstance(request.get("owner"), str))
    result = main(request)
    phase("remote_response_ready")
    print(json.dumps({"ok": True, "result": result}, separators=(",", ":")), flush=True)
except OverallDeadline:
    phase("remote_overall_alarm", boundSeconds=REMOTE_ALARM_SECONDS)
    print(json.dumps({"ok": False, "errorType": "RemoteOverallDeadline"}, separators=(",", ":")), flush=True)
    sys.exit(3)
except InspectionLimit as exc:
    phase("remote_inspection_limit", code=str(exc))
    print(json.dumps({"ok": False, "errorType": "InspectionLimit", "code": str(exc)}, separators=(",", ":")), flush=True)
    sys.exit(4)
except Exception as exc:
    phase("remote_inspection_error", errorType=type(exc).__name__)
    print(json.dumps({"ok": False, "errorType": type(exc).__name__}, separators=(",", ":")), flush=True)
    sys.exit(5)
finally:
    signal.alarm(0)
`;

await runE2E(import.meta.url, {
  testId: "mobile-public-no-reload-readonly-byte-inspection-once",
  tier: "manual-live",
  modelPolicy: "no model; one bounded read-only SSH, exact isolated owner gates, bounded static-root/stage path-size-SHA inspection",
  cleanupTimeoutMs: 60_000,
  processSignalTimeoutMs: 5_000,
}, async context => {
  assert.equal(process.version, "v22.17.0");
  assert.equal(await realpath(process.execPath), await realpath(pinnedNode));
  assert.equal(sha256(await readFile(process.execPath)), pinnedNodeSha256);
  context.registerSecret(originalManifest.seed);
  const request = {
    owner: originalManifest.seed,
    stageRoot: `${originalStaticRoot}.stage-${originalManifest.seed}`,
  };
  const remoteCommand = `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(remotePython).toString("base64")}"))'`;
  const label = "readonly-root-stage-byte-inspection";
  const child = context.spawnOwned(label, "ssh", [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1", "aliyun", remoteCommand,
  ], {
    cwd: repoRoot,
    env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    stdin: "pipe",
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 1024 * 1024) stdoutChunks.push(Buffer.from(chunk));
  });
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 128 * 1024) stderrChunks.push(Buffer.from(chunk));
  });
  let spawnError = null;
  child.once("error", error => { spawnError = error.message; });
  const childClosed = new Promise(resolveClose => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  child.stdin.end(JSON.stringify(request));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void context.stopOwned(label).catch(() => undefined);
  }, 48_000);
  let exit;
  try {
    exit = await childClosed;
  } finally {
    clearTimeout(timer);
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8").trim());
  } catch {
    envelope = { ok: false, errorType: "NoStructuredRemoteResponse" };
  }
  const phaseMarkers = parseRemotePhases(Buffer.concat(stderrChunks).toString("utf8"));
  const remote = envelope.ok ? envelope.result : null;
  const remotePythonExecuted = phaseMarkers.some(row => row.phase === "remote_python_started");
  const rootInspectionCompleted = phaseMarkers.some(row => row.phase === "static_root_inspection_complete");
  const stageInspectionCompleted = phaseMarkers.some(row => row.phase === "stage_inspection_complete");
  const rootProjection = normalizeFileRows(remote?.staticRoot?.files || []);
  const stageProjection = normalizeFileRows(remote?.stage?.files || []);
  const rootComparison = remote ? {
    actualFileCount: rootProjection.length,
    againstOriginalRoot: compareProjection(rootProjection, expectedOriginalRootFiles),
    againstFrozenBundle: compareProjection(rootProjection, expectedBundleFiles),
    mtimeNsUsedForComparison: false,
    ctimeNsUsedForComparison: false,
  } : null;
  const stageComparison = remote ? {
    actualDataFileCount: stageProjection.length,
    dataBytes: stageProjection.reduce((sum, row) => sum + row.size, 0),
    againstOriginalRoot: compareProjection(stageProjection, expectedOriginalRootFiles),
    againstFrozenBundle: compareProjection(stageProjection, expectedBundleFiles),
    mtimeNsUsedForComparison: false,
    ctimeNsUsedForComparison: false,
  } : null;
  const summary = {
    inputEvidence,
    remoteAlarmSeconds: 30,
    localSshBoundMs: 48_000,
    child: { pid: child.pid, exitCode: exit.code, signal: exit.signal, timedOut, spawnError, stdoutBytes, stderrBytes },
    remotePhaseMarkers: phaseMarkers,
    sshExecution: {
      authenticationProvenByRemoteCommand: remotePythonExecuted,
      evidence: remotePythonExecuted ? "remote Python emitted remote_python_started" : "remote execution marker absent",
      staticRootInspectionCompleted: rootInspectionCompleted,
      stageInspectionCompleted,
      caddyOwnerGatePassed: remote?.sidecarMatchesExpected === true,
    },
    remote: remote || { ok: false, errorType: envelope.errorType, code: envelope.code || null },
    rootComparison,
    stageComparison,
    noBrowserStarted: true,
    noRelayOrGatewayStarted: true,
    noCaddyReloadOrSignal: true,
    noStaticRootExchangeOrDelete: true,
    noServiceStartup: true,
    production8451Touched: false,
  };
  await context.writeArtifactJson("readonly-root-stage-byte-inspection.json", summary);

  assert.equal(timedOut, false, "single SSH must finish within the outer bound");
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0, "remote inspection must complete without exceeding its alarm or tree bounds");
  assert.equal(remotePythonExecuted, true, "SSH authentication is proven only by execution of the fixed remote Python command");
  assert.equal(rootInspectionCompleted, true, "the remote static-root inspection phase must complete");
  assert.equal(stageInspectionCompleted, true, "the remote owned-stage inspection phase must complete");
  assert.equal(envelope.ok, true, "remote inspection must return complete structured evidence");
  assert.equal(remote.sidecarMatchesExpected, true, "the exact isolated Caddy process/config/443 owner gate must pass");
  assert.equal(remote.forward32552Free, true, "the checked SSH reverse-forward port must remain free");
  assert.equal(remote.exchangeDeleteReloadSignalOrServiceStartupAttempted, false);
  assert.equal(remote.production8451Touched, false);
  return summary;
});

function parseRemotePhases(text) {
  const phases = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = line.indexOf("READONLY_PHASE ");
    if (marker < 0) continue;
    try {
      const row = JSON.parse(line.slice(marker + "READONLY_PHASE ".length));
      if (typeof row.phase === "string" && /^[a-z0-9_]+$/.test(row.phase)) phases.push(row);
    } catch {
      phases.push({ phase: "unparsed-marker" });
    }
  }
  return phases;
}

function compareProjection(actual, expected) {
  const actualByPath = new Map(actual.map(row => [row.path, row]));
  const expectedByPath = new Map(expected.map(row => [row.path, row]));
  const actualPaths = [...actualByPath.keys()].sort((a, b) => a.localeCompare(b));
  const expectedPaths = [...expectedByPath.keys()].sort((a, b) => a.localeCompare(b));
  const missingPaths = expectedPaths.filter(path => !actualByPath.has(path));
  const extraPaths = actualPaths.filter(path => !expectedByPath.has(path));
  const sizeMismatchPaths = [];
  const sha256MismatchPaths = [];
  for (const path of actualPaths) {
    const expectedRow = expectedByPath.get(path);
    if (!expectedRow) continue;
    if (actualByPath.get(path).size !== expectedRow.size) sizeMismatchPaths.push(path);
    if (actualByPath.get(path).sha256 !== expectedRow.sha256) sha256MismatchPaths.push(path);
  }
  return {
    fields: ["relative path", "size", "sha256"],
    exactMatch: missingPaths.length === 0 && extraPaths.length === 0
      && sizeMismatchPaths.length === 0 && sha256MismatchPaths.length === 0,
    actualProjectionSha256: sha256(Buffer.from(JSON.stringify(actual))),
    expectedProjectionSha256: sha256(Buffer.from(JSON.stringify(expected))),
    missingPaths,
    extraPaths,
    sizeMismatchPaths,
    sha256MismatchPaths,
  };
}

async function verifyBundleFiles(root, expected) {
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
  assert.equal(await realpath(root), root);
  const actual = [];
  for (const row of expected) {
    const path = resolve(root, ...row.path.split("/"));
    assert.ok(path.startsWith(root + sep));
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.size, row.size);
    assert.equal(sha256(await readFile(path)), row.sha256);
    actual.push(row);
  }
  assert.deepEqual(actual, expected);
}

async function readRegularFile(path, boundary) {
  const normalized = resolve(path);
  const canonicalBoundary = await realpath(boundary);
  const rel = relative(canonicalBoundary, normalized);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`));
  const info = await lstat(normalized);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `expected regular non-symlink input: ${normalized}`);
  assert.equal(await realpath(normalized), normalized);
  return readFile(normalized);
}

function normalizeFileRows(rows) {
  return rows.map(row => ({ path: row.path, size: row.size, sha256: row.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
