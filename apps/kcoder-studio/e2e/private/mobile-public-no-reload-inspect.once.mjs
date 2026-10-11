import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const pinnedNode = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const pinnedNodeSha256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const originalRunRoot = resolve(
  repoRoot,
  "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-no-reload-setup.e2e.mjs/20261008-114641.574Z",
);
const originalRunBoundary = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
const originalManifestPath = resolve(originalRunRoot, "manifest.json");
const originalStaticManifestPath = resolve(originalRunRoot, "artifacts/existing-static-root-manifest.json");
const originalInputsPath = resolve(originalRunRoot, "artifacts/public-no-reload-inputs.json");
const originalStaticRoot = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root";
const originalStageParent = "/tmp/kc-phone-ux-443-20261007-183008";
const expectedSidecarPid = 255620;
const expectedSidecarConfigPath = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile";
const expectedSidecarConfigSha256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c";
const remoteForwardPort = 32552;

const originalManifestBytes = await readRegularFile(originalManifestPath, originalRunBoundary);
const originalManifest = JSON.parse(originalManifestBytes.toString("utf8"));
assert.equal(originalManifest.status, "failed", "the failed setup run remains immutable evidence");
assert.equal(originalManifest.testId, "mobile-high-latency-public-no-reload-setup");
assert.match(originalManifest.seed, /^[a-f0-9]{16}$/);

const originalStaticManifestBytes = await readRegularFile(originalStaticManifestPath, originalRunBoundary);
const originalStaticTree = JSON.parse(originalStaticManifestBytes.toString("utf8"));
assert.equal(originalStaticTree.root.path, "mobile-web-root");
assert.equal(originalStaticTree.files.length, 37);

const originalInputsBytes = await readRegularFile(originalInputsPath, originalRunBoundary);
const originalInputs = JSON.parse(originalInputsBytes.toString("utf8"));
assert.equal(originalInputs.isolatedStaticRoot, originalStaticRoot);
assert.equal(originalInputs.isolatedSidecarPid, expectedSidecarPid);
assert.equal(originalInputs.isolatedSidecarConfigSha256, expectedSidecarConfigSha256);
assert.equal(originalInputs.remoteReverseForwardPort, remoteForwardPort);
assert.equal(originalInputs.productionRelayPortTouched, false);

const legacyTimestampPrecision = analyzeLegacyTimestampPrecision(originalStaticManifestBytes.toString("utf8"));
const expectedRootFiles = normalizeFileRows(originalStaticTree.files);
const originalManifestEvidence = {
  originalRunRoot,
  originalRunManifestSha256: sha256(originalManifestBytes),
  originalStaticManifestSha256: sha256(originalStaticManifestBytes),
  originalInputsSha256: sha256(originalInputsBytes),
  originalSeedRegisteredAsSecret: true,
  originalStaticFileCount: originalStaticTree.files.length,
  originalStaticFileProjectionSha256: sha256(Buffer.from(JSON.stringify(expectedRootFiles))),
  legacyTimestampPrecision,
  oldArtifactContainsActualRootFileProjection: true,
  priorRecoveryArtifactContainsActualRootFileProjection: false,
};

const remotePython = String.raw`
import hashlib, json, os, re, stat, subprocess, sys

EXPECTED_PID = 255620
CONFIG_PATH = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile"
CONFIG_SHA256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c"
STATIC_ROOT = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root"
REMOTE_PARENT = "/tmp/kc-phone-ux-443-20261007-183008"
FORWARD_PORT = 32552

def digest_fd(fd):
    h = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        h.update(chunk)
    return h.hexdigest()

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

def stable_tree(root_path, root_label):
    if not os.path.lexists(root_path):
        return None
    if os.path.islink(root_path) or os.path.realpath(root_path) != root_path or not os.path.isdir(root_path):
        raise RuntimeError("tree-root-is-not-canonical-directory")
    root_before = os.lstat(root_path)
    directory_infos = {".": root_before}
    directories = []
    files = []
    for current, dirnames, filenames in os.walk(root_path, topdown=True, followlinks=False):
        dirnames.sort()
        filenames.sort()
        rel_current = os.path.relpath(current, root_path).replace(os.sep, "/")
        if rel_current == ".":
            rel_current = ""
        for name in list(dirnames):
            path = os.path.join(current, name)
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise RuntimeError("symlink-or-nondirectory-in-tree")
            rel = (rel_current + "/" + name).strip("/")
            directory_infos[rel] = info
            directories.append(stat_row(rel, info))
        for name in filenames:
            path = os.path.join(current, name)
            before = os.lstat(path)
            if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
                raise RuntimeError("symlink-or-nonfile-in-tree")
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(path, flags)
            try:
                fd_before = os.fstat(fd)
                if not stat.S_ISREG(fd_before.st_mode) or stat_identity(fd_before) != stat_identity(before):
                    raise RuntimeError("file-changed-before-hash")
                digest = digest_fd(fd)
                fd_after = os.fstat(fd)
                path_after = os.lstat(path)
                if stat_identity(fd_before) != stat_identity(fd_after) or stat_identity(fd_after) != stat_identity(path_after):
                    raise RuntimeError("file-changed-during-hash")
            finally:
                os.close(fd)
            rel = (rel_current + "/" + name).strip("/")
            row = stat_row(rel, fd_after)
            row["sha256"] = digest
            files.append(row)
    for rel, before in directory_infos.items():
        path = root_path if rel == "." else os.path.join(root_path, *rel.split("/"))
        after = os.lstat(path)
        if stat_identity(before) != stat_identity(after):
            raise RuntimeError("directory-changed-during-inspection")
    root_after = os.lstat(root_path)
    if stat_identity(root_before) != stat_identity(root_after):
        raise RuntimeError("root-changed-during-inspection")
    return {
        "root": stat_row(root_label, root_after),
        "directories": sorted(directories, key=lambda row: row["path"]),
        "files": sorted(files, key=lambda row: row["path"]),
    }

def file_projection(files):
    return sorted(
        [{"path": row["path"], "size": row["size"], "sha256": row["sha256"]} for row in files],
        key=lambda row: row["path"],
    )

def process_info(pid):
    result = subprocess.run(
        ["sudo", "-n", "ps", "-p", str(pid), "-o", "pid=,ppid=,euid=,comm=,args="],
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    fields = result.stdout.strip().split(None, 4)
    if len(fields) < 5:
        return {"fieldCount": len(fields)}
    argv = fields[4]
    return {
        "pid": int(fields[0]),
        "ppid": int(fields[1]),
        "euid": int(fields[2]),
        "comm": fields[3],
        "argvSha256": hashlib.sha256(argv.encode()).hexdigest(),
        "argvMatchesSidecar": argv == "/usr/bin/caddy run --config " + CONFIG_PATH + " --adapter caddyfile",
    }

def listener_rows(port):
    result = subprocess.run(
        ["sudo", "-n", "ss", "-H", "-ltnp", "sport = :" + str(port)],
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode != 0:
        raise RuntimeError("sudo-ss-read-failed")
    rows = []
    for line in result.stdout.splitlines():
        pids = sorted({int(value) for value in re.findall(r"pid=(\d+)", line)})
        owners = [process_info(pid) for pid in pids]
        rows.append({"ownerPids": pids, "owners": owners})
    return rows

def main(request):
    owner = request["owner"]
    stage_path = request["stageRoot"]
    if stage_path != STATIC_ROOT + ".stage-" + owner:
        raise RuntimeError("stage-path-does-not-match-exact-owner")
    if os.path.dirname(stage_path) != REMOTE_PARENT:
        raise RuntimeError("stage-path-outside-known-parent")
    caddy = process_info(EXPECTED_PID)
    listeners_443 = listener_rows(443)
    config_sha = hashlib.sha256(open(CONFIG_PATH, "rb").read()).hexdigest()
    config_text = open(CONFIG_PATH, "r", encoding="utf-8").read()
    listeners_match = bool(listeners_443) and all(
        row["ownerPids"] == [EXPECTED_PID]
        and len(row["owners"]) == 1
        and row["owners"][0] is not None
        and row["owners"][0]["euid"] == 0
        and row["owners"][0]["comm"] == "caddy"
        and row["owners"][0]["argvMatchesSidecar"] is True
        for row in listeners_443
    )
    sidecar_matches = bool(
        caddy and caddy.get("pid") == EXPECTED_PID and caddy.get("euid") == 0
        and caddy.get("comm") == "caddy" and caddy.get("argvMatchesSidecar") is True
        and config_sha == CONFIG_SHA256 and "root * " + STATIC_ROOT in config_text
        and listeners_match
    )
    forward_listeners = listener_rows(FORWARD_PORT)
    root = stable_tree(STATIC_ROOT, "mobile-web-root")
    stage = stable_tree(stage_path, "owned-stage-root")
    marker_matches = False
    marker_regular_single_link = False
    stage_data_files = []
    if stage is not None:
        marker_path = os.path.join(stage_path, ".kc-e2e-owner")
        if os.path.lexists(marker_path):
            marker_stat = os.lstat(marker_path)
            marker_regular_single_link = stat.S_ISREG(marker_stat.st_mode) and marker_stat.st_nlink == 1
            if marker_regular_single_link:
                with open(marker_path, "r", encoding="utf-8") as handle:
                    marker_matches = handle.read() == owner
        stage_data_files = [row for row in stage["files"] if row["path"] != ".kc-e2e-owner"]
    return {
        "sidecarPid": caddy.get("pid") if caddy else None,
        "sidecarEuid": caddy.get("euid") if caddy else None,
        "sidecarComm": caddy.get("comm") if caddy else None,
        "sidecarArgvSha256": caddy.get("argvSha256") if caddy else None,
        "sidecarMatchesExpected": sidecar_matches,
        "sidecarConfigSha256": config_sha,
        "sidecarListenerCount443": len(listeners_443),
        "all443ListenersOwnedByExpectedSidecar": listeners_match,
        "remoteForwardListenerCount32552": len(forward_listeners),
        "remoteForwardFree32552": len(forward_listeners) == 0,
        "staticRoot": root,
        "staticRootFileProjection": file_projection(root["files"]) if root else None,
        "stage": stage,
        "stageDataFileProjection": file_projection(stage_data_files),
        "stageOwnerMarkerRegularSingleLink": marker_regular_single_link,
        "stageOwnerMarkerMatchesThisRun": marker_matches,
        "readOnlyActionsOnly": True,
        "exchangeOrDeleteAttempted": False,
        "caddyReloadOrSignalAttempted": False,
        "serviceStartupAttempted": False,
        "productionRelayPortTouched": False,
    }

try:
    response = main(json.loads(sys.stdin.read()))
    print(json.dumps({"ok": True, "result": response}, separators=(",", ":")))
except Exception as exc:
    print(json.dumps({"ok": False, "errorType": type(exc).__name__, "error": str(exc)[:240]}, separators=(",", ":")))
    sys.exit(2)
`;

await runE2E(import.meta.url, {
  testId: "mobile-public-no-reload-readonly-inspection-once",
  tier: "manual-live",
  modelPolicy: "no model; one bounded read-only SSH for exact isolated Caddy and static-root file projections",
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
  const encodedPython = Buffer.from(remotePython).toString("base64");
  const remoteCommand = `python3 -c 'import base64;exec(base64.b64decode("${encodedPython}"))'`;
  const label = "readonly-static-root-inspection";
  const child = context.spawnOwned(label, "ssh", [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "aliyun", remoteCommand,
  ], {
    cwd: repoRoot,
    env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    stdin: "pipe",
  });
  const stdout = [];
  let stdoutBytes = 0;
  child.stdout.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 512 * 1024) stdout.push(Buffer.from(chunk));
  });
  const childClosed = new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  child.stdin.end(JSON.stringify(request));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void context.stopOwned(label).catch(() => undefined);
  }, 35_000);
  let exit;
  try {
    exit = await childClosed;
  } finally {
    clearTimeout(timer);
  }

  let envelope;
  try {
    envelope = JSON.parse(Buffer.concat(stdout).toString("utf8").trim());
  } catch {
    envelope = { ok: false, errorType: "InvalidRemoteJson", error: "remote response was absent or not one JSON envelope" };
  }
  const rootProjection = envelope.ok ? normalizeFileRows(envelope.result.staticRootFileProjection || []) : [];
  const stageProjection = envelope.ok ? normalizeFileRows(envelope.result.stageDataFileProjection || []) : [];
  const summary = {
    originalManifestEvidence,
    remoteAttemptBoundMs: 35_000,
    remoteChild: {
      pid: child.pid,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      stdoutBytes,
    },
    remote: envelope.ok ? envelope.result : { ok: false, errorType: envelope.errorType, error: envelope.error },
    rootFileComparison: envelope.ok ? {
      actualFileCount: rootProjection.length,
      matchesOriginalPathSizeSha256: sameRows(rootProjection, expectedRootFiles),
      matchesOriginalProjectionSha256: sha256(Buffer.from(JSON.stringify(rootProjection))) === originalManifestEvidence.originalStaticFileProjectionSha256,
    } : null,
    stageDataComparison: envelope.ok ? {
      actualFileCount: stageProjection.length,
      dataBytes: stageProjection.reduce((sum, row) => sum + row.size, 0),
      projectionSha256: sha256(Buffer.from(JSON.stringify(stageProjection))),
    } : null,
    legacyTimestampComparison: envelope.ok ? compareLegacyTimestamps(originalStaticTree, envelope.result.staticRoot) : null,
    noBrowserStarted: true,
    noRelayOrGatewayStarted: true,
    noCaddyReloadOrSignal: true,
    noExchangeOrDelete: true,
    productionRelayPortTouched: false,
  };
  await context.writeArtifactJson("readonly-static-root-inspection.json", summary);

  assert.equal(timedOut, false, "the single read-only SSH must finish within its bound");
  assert.equal(exit.code, 0, "the read-only SSH must return structured evidence");
  assert.equal(exit.signal, null);
  assert.equal(envelope.ok, true, "the remote inspection must return one structured response");
  assert.equal(envelope.result.sidecarMatchesExpected, true, "the exact isolated Caddy owner/config must still match");
  assert.equal(envelope.result.remoteForwardFree32552, true, "the existing forward port must remain unoccupied");
  assert.equal(envelope.result.exchangeOrDeleteAttempted, false);
  assert.equal(envelope.result.caddyReloadOrSignalAttempted, false);
  assert.equal(envelope.result.serviceStartupAttempted, false);
  return summary;
});

function analyzeLegacyTimestampPrecision(raw) {
  const values = [...raw.matchAll(/"(?:mtimeNs|ctimeNs)"\s*:\s*(\d+)/g)].map(match => BigInt(match[1]));
  const rounded = values.map(value => BigInt(Number(value.toString())));
  const deltas = rounded.map((value, index) => value - values[index]);
  const absolute = deltas.map(value => value < 0n ? -value : value);
  return {
    numericNsFieldCount: values.length,
    greaterThanNumberMaxSafeInteger: values.filter(value => value > BigInt(Number.MAX_SAFE_INTEGER)).length,
    lexicalIntegerDiffersFromBinary64ExactInteger: values.filter((value, index) => value !== rounded[index]).length,
    minBinary64RoundingDeltaNs: deltas.reduce((min, value) => value < min ? value : min, 0n).toString(),
    maxBinary64RoundingDeltaNs: deltas.reduce((max, value) => value > max ? value : max, 0n).toString(),
    maximumAbsoluteBinary64RoundingDeltaNs: absolute.reduce((max, value) => value > max ? value : max, 0n).toString(),
    exactPreSerializationNsRecoverable: false,
  };
}

function compareLegacyTimestamps(originalTree, currentTree) {
  const oldRows = [
    { kind: "root", row: originalTree.root },
    ...originalTree.directories.map(row => ({ kind: "directory", row })),
    ...originalTree.files.map(row => ({ kind: "file", row })),
  ];
  const currentRows = [
    { kind: "root", row: currentTree.root },
    ...currentTree.directories.map(row => ({ kind: "directory", row })),
    ...currentTree.files.map(row => ({ kind: "file", row })),
  ];
  const currentByKey = new Map(currentRows.map(item => [`${item.kind}:${item.row.path}`, item.row]));
  const compared = [];
  for (const { kind, row } of oldRows) {
    const current = currentByKey.get(`${kind}:${row.path}`);
    if (!current) continue;
    for (const field of ["mtimeNs", "ctimeNs"]) {
      if (typeof row[field] !== "number" || typeof current[`${field}Exact`] !== "string") continue;
      const oldBinary64Ns = BigInt(row[field]);
      const currentExactNs = BigInt(current[`${field}Exact`]);
      compared.push({
        kind,
        path: row.path,
        field,
        oldBinary64Ns: oldBinary64Ns.toString(),
        currentExactNs: currentExactNs.toString(),
        currentMinusOldBinary64Ns: (currentExactNs - oldBinary64Ns).toString(),
      });
    }
  }
  return {
    comparedFieldCount: compared.length,
    exactOldNsUnavailable: true,
    equalAtBinary64PrecisionCount: compared.filter(row => row.currentMinusOldBinary64Ns === "0").length,
    unequalAtBinary64PrecisionCount: compared.filter(row => row.currentMinusOldBinary64Ns !== "0").length,
    comparisons: compared,
  };
}

async function readRegularFile(path, boundary) {
  const normalized = resolve(path);
  const canonicalBoundary = await realpath(boundary);
  const rel = relative(canonicalBoundary, normalized);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`));
  const info = await lstat(normalized);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `expected a regular non-symlink input: ${normalized}`);
  assert.equal(await realpath(normalized), normalized, "read-only inspection inputs must not traverse symlinks");
  return readFile(normalized);
}

function normalizeFileRows(rows) {
  return rows.map(row => ({ path: row.path, size: row.size, sha256: row.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sameRows(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
