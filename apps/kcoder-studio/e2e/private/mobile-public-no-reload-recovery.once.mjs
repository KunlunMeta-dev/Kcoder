import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
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
const originalResultPath = resolve(originalRunRoot, "artifacts/result.json");
const privateWebRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
const bundleManifestPath = resolve(
  privateWebRoot,
  "mobile-web-export-after-f643bc69-20261008-manifest.json",
);
const bundleRoot = resolve(privateWebRoot, "mobile-web-export-after-f643bc69-20261008");

const expectedBundleManifestSha256 = "fbe0181a60e42f7ef87f8f9cbac356b88776e416e3d9de9e886a9a1dad52d0b3";
const expectedBundleSha256 = "217a045ecae2f5bc7712455ec198e6546e2a9d1ca4265da8b836877a0323c03c";
const expectedSidecarPid = 255620;
const expectedSidecarConfigSha256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c";
const expectedStaticRoot = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root";
const remoteForwardPort = 32552;

const originalManifestBytes = await readRegularFile(originalManifestPath, originalRunBoundary);
const originalManifest = JSON.parse(originalManifestBytes.toString("utf8"));
assert.match(originalManifest.seed, /^[a-f0-9]{16}$/);
assert.equal(originalManifest.status, "failed", "the failed source run is immutable evidence");
assert.equal(originalManifest.testId, "mobile-high-latency-public-no-reload-setup");

const originalStaticManifestBytes = await readRegularFile(originalStaticManifestPath, originalRunBoundary);
const originalStaticTree = JSON.parse(originalStaticManifestBytes.toString("utf8"));
assert.equal(originalStaticTree.files.length, 37);
assert.equal(originalStaticTree.root.path, "mobile-web-root");

const originalInputsBytes = await readRegularFile(originalInputsPath, originalRunBoundary);
const originalInputs = JSON.parse(originalInputsBytes.toString("utf8"));
assert.equal(originalInputs.isolatedStaticRoot, expectedStaticRoot);
assert.equal(originalInputs.isolatedSidecarPid, expectedSidecarPid);
assert.equal(originalInputs.isolatedSidecarConfigSha256, expectedSidecarConfigSha256);
assert.equal(originalInputs.remoteReverseForwardPort, remoteForwardPort);
assert.equal(originalInputs.productionRelayPortTouched, false);

const bundleManifestBytes = await readRegularFile(bundleManifestPath, privateWebRoot);
assert.equal(sha256(bundleManifestBytes), expectedBundleManifestSha256);
const bundleManifest = JSON.parse(bundleManifestBytes.toString("utf8"));
assert.equal(bundleManifest.bundleSha256, expectedBundleSha256);
assert.equal(bundleManifest.bundleFileCount, 37);
const expectedBundleFiles = normalizeFileRows(bundleManifest.bundleFiles);
const inputBundleFiles = normalizeFileRows(originalInputs.mobileWeb.bundleFiles);
assert.deepEqual(inputBundleFiles, expectedBundleFiles, "the recovery bundle must match the original run's frozen 37-file input");
const expectedBundleDirectories = deriveDirectories(expectedBundleFiles);
await verifyBundleDirectories(bundleRoot, expectedBundleDirectories);

const originalResultBytes = await readRegularFile(originalResultPath, originalRunBoundary);
const originalResult = JSON.parse(originalResultBytes.toString("utf8"));
assert.equal(originalResult.status, "failed");
assert.match(originalResult.error, /owned SSH tar upload must complete/);

const originalRunStatePath = resolve(originalRunRoot, "state/latest-mobile-web-bundle.tar.gz");
const originalArchiveAvailable = await lstat(originalRunStatePath).then(() => true, () => false);
const originalEvidence = {
  originalRunRoot,
  originalRunManifestSha256: sha256(originalManifestBytes),
  originalStaticManifestSha256: sha256(originalStaticManifestBytes),
  originalInputsSha256: sha256(originalInputsBytes),
  originalResultSha256: sha256(originalResultBytes),
  originalFailureMessage: "owned SSH tar upload must complete",
  originalCleanupErrorCount: originalResult.cleanupErrors?.length ?? null,
  originalCleanupErrorFirstLine: originalResult.cleanupErrors?.[0]?.split("\n", 1)[0] ?? null,
  originalArchiveAvailable,
  originalArchiveSizeBytes: originalArchiveAvailable ? (await lstat(originalRunStatePath)).size : null,
  originalStaticFileCount: originalStaticTree.files.length,
  frozenBundleManifestSha256: sha256(bundleManifestBytes),
  frozenBundleSha256: bundleManifest.bundleSha256,
  frozenBundleFileCount: bundleManifest.bundleFiles.length,
};

const remotePython = String.raw`
import ctypes, hashlib, json, os, re, shutil, stat, subprocess, sys

EXPECTED_PID = 255620
CONFIG_PATH = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile"
CONFIG_SHA256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c"
STATIC_ROOT = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root"
REMOTE_PARENT = "/tmp/kc-phone-ux-443-20261007-183008"
FORWARD_PORT = 32552
AT_FDCWD = -100
RENAME_EXCHANGE = 2

def digest_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def stat_row(root, path, info):
    return {
        "path": os.path.relpath(path, root).replace(os.sep, "/"),
        "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid,
        "dev": info.st_dev, "inode": info.st_ino, "size": info.st_size,
        "mtimeNs": info.st_mtime_ns, "ctimeNs": info.st_ctime_ns,
    }

def tree(root):
    if not os.path.lexists(root):
        return None
    if os.path.islink(root) or os.path.realpath(root) != root or not os.path.isdir(root):
        raise RuntimeError("tree-root-not-real-directory")
    directories = []
    files = []
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        dirnames.sort()
        filenames.sort()
        for name in list(dirnames):
            path = os.path.join(current, name)
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise RuntimeError("symlink-or-nondirectory-in-tree")
            directories.append(stat_row(root, path, info))
        for name in filenames:
            path = os.path.join(current, name)
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                raise RuntimeError("symlink-or-nonfile-in-tree")
            row = stat_row(root, path, info)
            row["sha256"] = digest_file(path)
            files.append(row)
    root_info = os.lstat(root)
    return {
        "root": stat_row(os.path.dirname(root), root, root_info),
        "directories": sorted(directories, key=lambda row: row["path"]),
        "files": sorted(files, key=lambda row: row["path"]),
    }

def file_projection(files):
    return sorted(
        [{"path": row["path"], "size": row["size"], "sha256": row["sha256"]} for row in files],
        key=lambda row: row["path"],
    )

def tree_content(tree_value):
    normalized = {
        "root": {key: tree_value["root"][key] for key in ("path", "mode", "uid", "gid", "dev", "inode", "size", "mtimeNs")},
        "directories": [{key: row[key] for key in ("path", "mode", "uid", "gid", "dev", "inode", "size", "mtimeNs")} for row in tree_value["directories"]],
        "files": [{key: row[key] for key in ("path", "mode", "uid", "gid", "dev", "inode", "size", "mtimeNs", "sha256")} for row in tree_value["files"]],
    }
    return hashlib.sha256(json.dumps(normalized, separators=(",", ":")).encode()).hexdigest()

def directory_projection(directories):
    return sorted(row["path"] for row in directories)

def stage_old_matches(stage_tree, original_tree, stage_path):
    if stage_tree is None or any(row["path"] == ".kc-e2e-owner" for row in stage_tree["files"]):
        return False
    expected_root = dict(original_tree["root"])
    expected_root["path"] = os.path.basename(stage_path)
    normalized = {
        "root": {key: expected_root[key] for key in ("path", "mode", "uid", "gid", "dev", "inode", "size", "mtimeNs")},
        "directories": [{key: row[key] for key in ("path", "mode", "uid", "gid", "dev", "inode", "size", "mtimeNs")} for row in original_tree["directories"]],
        "files": [{key: row[key] for key in ("path", "mode", "uid", "gid", "dev", "inode", "size", "mtimeNs", "sha256")} for row in original_tree["files"]],
    }
    expected_sha = hashlib.sha256(json.dumps(normalized, separators=(",", ":")).encode()).hexdigest()
    return tree_content(stage_tree) == expected_sha

def process_info(pid):
    result = subprocess.run(["sudo", "-n", "ps", "-p", str(pid), "-o", "pid=,ppid=,euid=,comm=,args="], capture_output=True, text=True, timeout=5)
    if result.returncode != 0 or not result.stdout.strip():
        return None
    fields = result.stdout.strip().split(None, 4)
    if len(fields) < 5:
        return {"fieldCount": len(fields)}
    argv = fields[4]
    return {
        "pid": int(fields[0]), "ppid": int(fields[1]), "euid": int(fields[2]), "comm": fields[3],
        "argvSha256": hashlib.sha256(argv.encode()).hexdigest(),
        "argvMatchesSidecar": argv == "/usr/bin/caddy run --config " + CONFIG_PATH + " --adapter caddyfile",
    }

def listener_rows(port):
    result = subprocess.run(["sudo", "-n", "ss", "-H", "-ltnp", "sport = :" + str(port)], capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        raise RuntimeError("sudo-ss-read-failed")
    rows = []
    for line in result.stdout.splitlines():
        pids = sorted({int(value) for value in re.findall(r"pid=(\d+)", line)})
        owners = [process_info(pid) for pid in pids]
        rows.append({"ownerPids": pids, "owners": owners})
    return rows

def exchange(left, right):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(AT_FDCWD, os.fsencode(left), AT_FDCWD, os.fsencode(right), RENAME_EXCHANGE)
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))

def main(request):
    owner = request["owner"]
    stage_path = request["stageRoot"]
    if stage_path != STATIC_ROOT + ".stage-" + owner:
        raise RuntimeError("stage-path-does-not-match-exact-owner")
    if os.path.dirname(stage_path) != REMOTE_PARENT or not os.path.basename(stage_path).startswith("mobile-web-root.stage-"):
        raise RuntimeError("stage-path-outside-owned-parent")

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

    original = json.loads(request["originalStaticTreeRawJson"])
    expected_bundle = request["expectedBundleFiles"]
    root_before = tree(STATIC_ROOT)
    stage_before = tree(stage_path)
    root_old = root_before is not None and root_before == original
    root_new = root_before is not None and file_projection(root_before["files"]) == expected_bundle and directory_projection(root_before["directories"]) == request["expectedBundleDirectories"]
    stage_old = stage_old_matches(stage_before, original, stage_path)
    stage_new = stage_before is not None and file_projection([
        row for row in stage_before["files"] if row["path"] != ".kc-e2e-owner"
    ]) == expected_bundle and directory_projection(stage_before["directories"]) == request["expectedBundleDirectories"]
    owner_marker_matches = False
    owner_marker_regular_single_link = False
    if stage_before is not None:
        marker_path = os.path.join(stage_path, ".kc-e2e-owner")
        if os.path.lexists(marker_path):
            marker_stat = os.lstat(marker_path)
            owner_marker_regular_single_link = stat.S_ISREG(marker_stat.st_mode) and marker_stat.st_nlink == 1
            if owner_marker_regular_single_link:
                with open(marker_path, "r", encoding="utf-8") as handle:
                    owner_marker_matches = handle.read() == owner

    stage_data_files = []
    if stage_before is not None:
        stage_data_files = [row for row in stage_before["files"] if row["path"] != ".kc-e2e-owner"]
    stage_data_projection = file_projection(stage_data_files)
    stage_manifest_sha = hashlib.sha256(json.dumps(stage_data_projection, separators=(",", ":")).encode()).hexdigest()
    stage_data_bytes = sum(row["size"] for row in stage_data_projection)
    proof = {
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
        "staticRootExists": root_before is not None,
        "staticRootMatchesOriginalFullManifest": root_old,
        "staticRootMatchesOriginalTreeContentIgnoringCtime": root_before is not None and tree_content(root_before) == tree_content(original),
        "staticRootMatchesFrozenBundleFiles": root_new,
        "staticRootFileCount": len(root_before["files"]) if root_before else None,
        "stageExists": stage_before is not None,
        "stageFileCountIncludingMarker": len(stage_before["files"]) if stage_before else None,
        "stageDataFileCount": len(stage_data_projection),
        "stageDataBytes": stage_data_bytes,
        "stageDataManifestSha256": stage_manifest_sha,
        "stageDataFiles": stage_data_projection,
        "stageOwnerMarkerRegularSingleLink": owner_marker_regular_single_link,
        "stageOwnerMarkerMatchesThisRun": owner_marker_matches,
        "stageMatchesOriginalFullManifest": stage_old,
        "stageMatchesFrozenBundleFiles": stage_new,
        "cleanupAction": "none",
    }

    if sidecar_matches and root_old and stage_before is None:
        proof["cleanupAction"] = "already-clean-original-root-and-no-stage"
    elif sidecar_matches and root_old and owner_marker_matches and owner_marker_regular_single_link:
        shutil.rmtree(stage_path)
        proof["cleanupAction"] = "removed-exact-owner-marked-stage"
    elif sidecar_matches and root_new and stage_old:
        exchange(STATIC_ROOT, stage_path)
        restored = tree(STATIC_ROOT)
        staged_bundle = tree(stage_path)
        if restored is None or tree_content(restored) != tree_content(original):
            raise RuntimeError("exchange-did-not-restore-original-static-root")
        if staged_bundle is None or file_projection(staged_bundle["files"]) != expected_bundle:
            raise RuntimeError("post-exchange-stage-is-not-the-exact-frozen-bundle")
        if directory_projection(staged_bundle["directories"]) != request["expectedBundleDirectories"]:
            raise RuntimeError("post-exchange-stage-has-unexpected-directories")
        if any(row["path"] == ".kc-e2e-owner" for row in staged_bundle["files"]):
            raise RuntimeError("post-exchange-stage-has-unexpected-owner-marker")
        shutil.rmtree(stage_path)
        proof["cleanupAction"] = "exchanged-original-root-back-and-removed-exact-frozen-bundle-stage"
    else:
        proof["cleanupAction"] = "none-unverified-state-retained"

    root_after = tree(STATIC_ROOT)
    stage_after = tree(stage_path)
    proof["staticRootMatchesOriginalAfterCleanup"] = root_after is not None and tree_content(root_after) == tree_content(original)
    proof["staticRootMatchesOriginalFullManifestAfterCleanup"] = root_after is not None and root_after == original
    proof["stageAbsentAfterCleanup"] = stage_after is None
    proof["staticRootAfterFileCount"] = len(root_after["files"]) if root_after else None
    return proof

try:
    result = main(json.loads(sys.stdin.read()))
    print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
except Exception as exc:
    print(json.dumps({"ok": False, "errorType": type(exc).__name__, "error": str(exc)[:240]}, separators=(",", ":")))
    sys.exit(2)
`;

await runE2E(import.meta.url, {
  testId: "mobile-public-no-reload-owned-recovery-once",
  tier: "manual-live",
  modelPolicy: "no model; one bounded recovery SSH under a new RunContext, exact owner/root/stage gates, never edits Caddy config or production 8451",
  cleanupTimeoutMs: 90_000,
  processSignalTimeoutMs: 5_000,
}, async context => {
  assert.equal(process.version, "v22.17.0");
  assert.equal(await realpath(process.execPath), await realpath(pinnedNode));
  assert.equal(sha256(await readFile(process.execPath)), pinnedNodeSha256);
  context.registerSecret(originalManifest.seed);

  const request = {
    owner: originalManifest.seed,
    stageRoot: `${expectedStaticRoot}.stage-${originalManifest.seed}`,
    originalStaticTreeRawJson: originalStaticManifestBytes.toString("utf8"),
    expectedBundleFiles,
    expectedBundleDirectories,
  };
  const encodedPython = Buffer.from(remotePython).toString("base64");
  const remoteCommand = `python3 -c 'import base64;exec(base64.b64decode("${encodedPython}"))'`;
  const label = "readonly-static-root-and-owned-stage-recovery";
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
    if (stdoutBytes <= 64 * 1024) stdout.push(Buffer.from(chunk));
  });
  const childClosed = new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  child.stdin.end(JSON.stringify(request));
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    void context.stopOwned(label).catch(() => undefined);
  }, 30_000);
  let exit;
  try {
    exit = await childClosed;
  } finally {
    clearTimeout(timer);
  }

  const stdoutText = Buffer.concat(stdout).toString("utf8");
  let envelope;
  try {
    envelope = JSON.parse(stdoutText.trim());
  } catch {
    envelope = { ok: false, errorType: "InvalidRemoteJson", error: "remote response was absent or not one JSON envelope" };
  }
  const summary = {
    originalEvidence,
    originalStaticTreeRawJson: originalStaticManifestBytes.toString("utf8"),
    remoteAttemptBoundMs: 30_000,
    remoteChild: {
      pid: child.pid,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut: didTimeout,
      argvSha256: sha256(Buffer.from(JSON.stringify(child.spawnargs || []))),
      stdoutBytes,
    },
    remote: envelope.ok ? envelope.result : { ok: false, errorType: envelope.errorType, error: envelope.error },
    noBrowserStarted: true,
    noRelayOrGatewayStarted: true,
    noCaddyReloadOrSignal: true,
    productionRelayPortTouched: false,
  };
  await context.writeArtifactJson("owned-static-root-recovery-proof.json", summary);

  assert.equal(didTimeout, false, "the one recovery SSH must finish inside its 30-second bound");
  assert.equal(exit.code, 0, "the owned recovery SSH must exit successfully");
  assert.equal(exit.signal, null);
  assert.equal(envelope.ok, true, "the recovery agent must return a structured proof");
  assert.equal(envelope.result.sidecarMatchesExpected, true, "the exact isolated Caddy owner/config must remain in place");
  assert.equal(envelope.result.staticRootMatchesOriginalAfterCleanup, true, "the full original static tree must be restored");
  assert.equal(envelope.result.stageAbsentAfterCleanup, true, "the exact owned stage must be absent after recovery");
  assert.ok(
    envelope.result.cleanupAction === "already-clean-original-root-and-no-stage"
      || envelope.result.cleanupAction === "removed-exact-owner-marked-stage"
      || envelope.result.cleanupAction === "exchanged-original-root-back-and-removed-exact-frozen-bundle-stage",
    "cleanup must be justified by an exact owner or full-tree match",
  );
  return summary;
});

async function readRegularFile(path, boundary) {
  const normalized = resolve(path);
  const canonicalBoundary = await realpath(boundary);
  const rel = relative(canonicalBoundary, normalized);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`));
  const info = await lstat(normalized);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `expected a regular non-symlink input: ${normalized}`);
  assert.equal(await realpath(normalized), normalized, "recovery input path must resolve without symlink traversal");
  return readFile(normalized);
}

function normalizeFileRows(rows) {
  return rows.map(row => ({ path: row.path, size: row.size, sha256: row.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function deriveDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let parent = dirname(file.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

async function verifyBundleDirectories(root, expected) {
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
  assert.equal(await realpath(root), root);
  const found = [];
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `frozen bundle cannot contain symlinks: ${entry.name}`);
      assert.ok(info.isDirectory() || info.isFile(), `frozen bundle entries must be regular files or directories: ${entry.name}`);
      if (!info.isDirectory()) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      found.push(relativePath);
      await visit(path, relativePath);
    }
  }
  await visit(root);
  found.sort((left, right) => left.localeCompare(right));
  assert.deepEqual(found, expected, "frozen bundle directory inventory must match the file manifest");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
