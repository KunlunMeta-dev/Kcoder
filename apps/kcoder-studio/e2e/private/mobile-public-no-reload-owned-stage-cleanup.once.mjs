import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const pinnedNode = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const pinnedNodeSha256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const pinnedSsh = "/usr/bin/ssh";
const pinnedSshSha256 = "31430165113e51a046f3b9fa2a60ec98e073cc6c0411a081b3b1d76ed6a4eb6a";
const e2eBoundary = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
const privateBoundary = resolve(repoRoot, "target/private-phone-ux-implementation");
const originalRunRoot = resolve(
  repoRoot,
  "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-no-reload-setup.e2e.mjs/20261008-114641.574Z",
);
const observationPath = resolve(
  repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/mobile-public-no-reload-byte-inspect.once.mjs/20261008-130807.395Z/artifacts/readonly-root-stage-byte-inspection.json",
);
const bundleManifestPath = resolve(privateBoundary, "mobile-web-export-follow-after-f643bc69-20261008-manifest.json");
const bundleRoot = resolve(privateBoundary, "mobile-web-export-follow-after-f643bc69-20261008");
const remoteHelperPath = resolve(
  repoRoot,
  "apps/kcoder-studio/e2e/private/mobile-public-no-reload-owned-stage-cleanup.remote.py",
);
const remoteHelperSha256 = "34631aafb4348b548ad89d50852711ccecf93224c1fc429a17129a628b86bed4";
const originalPins = Object.freeze({
  runManifest: "236fe52cb9e32ab53b9236a6a3eb9a94ba955ffba2738a5e95121ce12e5acb31",
  staticManifest: "ef07ec06e7c8e2c66912e32872548256fabc868cf809a4f3267cb3abdd7a5ad7",
  publicInputs: "14c6e23904b51b32ca74b12d7ae296b024e73a6c1fc4bbe0b80d23f8a8487de9",
  observation: "1eafb84601693b25ae61eda6328c3c07ee13307f32a9e6f2a9e6a915cef933df",
  bundleManifest: "fbe0181a60e42f7ef87f8f9cbac356b88776e416e3d9de9e886a9a1dad52d0b3",
  rootProjection: "44e7916aa3cf104b5f9b95666b50f2c44b74a776cc3a55f817c204011ec63b64",
  stageProjection: "f53801bd83d02e4028de537343120b831f084591f3a04a95360ff305ebe1e9c2",
  frozenBundle: "217a045ecae2f5bc7712455ec198e6546e2a9d1ca4265da8b836877a0323c03c",
});
const expectedStaticRoot = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root";
const expectedConfigSha256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c";
const expectedOwnerArgvSha256 = "f92e70d2ad0314635789f8f33a43ff2b52641db36378b1f02d7e364c90207c3c";
const expectedOwnerPid = 255620;
const expectedForwardPort = 32552;
const expectedRootProjectionSha256 = "44e7916aa3cf104b5f9b95666b50f2c44b74a776cc3a55f817c204011ec63b64";
const expectedStageProjectionSha256 = "f53801bd83d02e4028de537343120b831f084591f3a04a95360ff305ebe1e9c2";
const localSshBoundMs = 48_000;
const stdoutLimitBytes = 1_048_576;
const stderrLimitBytes = 131_072;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function statFingerprint(info) {
  return ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"]
    .map(key => String(info[key])).join(":");
}

async function readPinnedFile(path, boundary, expectedSha256, maxBytes = 4 * 1024 * 1024) {
  const normalized = resolve(path);
  const canonicalBoundary = await realpath(boundary);
  const relativePath = relative(canonicalBoundary, normalized);
  assert.ok(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
  assert.equal(await realpath(normalized), normalized, "pinned input must be canonical and non-symlink");
  const pathBefore = await lstat(normalized, { bigint: true });
  assert.ok(pathBefore.isFile() && !pathBefore.isSymbolicLink());
  assert.equal(pathBefore.nlink, 1n);
  assert.ok(pathBefore.size <= BigInt(maxBytes));
  const handle = await open(normalized, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    const fdBefore = await handle.stat({ bigint: true });
    assert.ok(fdBefore.isFile());
    assert.equal(statFingerprint(fdBefore), statFingerprint(pathBefore));
    bytes = await handle.readFile();
    const fdAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(normalized, { bigint: true });
    assert.equal(statFingerprint(fdBefore), statFingerprint(fdAfter));
    assert.equal(statFingerprint(fdAfter), statFingerprint(pathAfter));
  } finally {
    await handle.close();
  }
  const digest = sha256(bytes);
  assert.equal(digest, expectedSha256, `pinned input digest mismatch: ${relativePath}`);
  return { bytes, sha256: digest, relativePath };
}

function normalizeFileRows(rows) {
  assert.ok(Array.isArray(rows));
  return rows.map(row => ({ path: row.path, size: row.size, sha256: row.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function projectionSha256(rows) {
  return sha256(Buffer.from(JSON.stringify(normalizeFileRows(rows))));
}

function assertProjection(actual, expected, label) {
  assert.deepEqual(normalizeFileRows(actual), normalizeFileRows(expected), `${label} projection differs`);
}

async function verifyBundleTree(expectedRows) {
  const rootInfo = await lstat(bundleRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
  assert.equal(await realpath(bundleRoot), bundleRoot);
  const actual = [];
  const pending = [{ absolute: bundleRoot, relative: "", depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    assert.ok(current.depth <= 10, "bundle tree exceeds path-depth bound");
    const entries = await readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolutePath = resolve(current.absolute, entry.name);
      assert.ok(absolutePath.startsWith(bundleRoot + sep));
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), `bundle must contain no symlinks: ${relativePath}`);
      if (entry.isDirectory()) {
        assert.ok(info.isDirectory());
        pending.push({ absolute: absolutePath, relative: relativePath, depth: current.depth + 1 });
      } else {
        assert.ok(entry.isFile() && info.isFile());
        const expected = expectedRows.find(row => row.path === relativePath);
        assert.ok(expected, `unexpected bundle file: ${relativePath}`);
        assert.equal(info.size, expected.size);
        const pinned = await readPinnedFile(absolutePath, bundleRoot, expected.sha256, 6 * 1024 * 1024);
        actual.push({ path: relativePath, size: pinned.bytes.length, sha256: pinned.sha256 });
      }
    }
  }
  assertProjection(actual, expectedRows, "portable Mobile bundle");
  assert.equal(actual.length, 37);
  return { fileCount: actual.length, projectionSha256: projectionSha256(actual) };
}

function safePhaseRows(stderrText) {
  const phases = [];
  for (const line of stderrText.split(/\r?\n/)) {
    const marker = line.indexOf("STAGE_CLEANUP_PHASE ");
    if (marker < 0) continue;
    try {
      const row = JSON.parse(line.slice(marker + "STAGE_CLEANUP_PHASE ".length));
      if (!row || typeof row.phase !== "string" || !/^[a-z0-9_]+$/.test(row.phase)) continue;
      const safe = { phase: row.phase };
      for (const key of [
        "exitCode", "durationMs", "stdoutBytes", "stderrBytes", "timedOut", "boundMs",
        "fileCount", "dataFileCount", "directoryCount", "totalBytes", "ownerMarkerMatches",
        "sidecarMatches", "listeners443Match", "forward32552Free", "bytes", "eof",
        "mutationStarted", "removedDataFiles", "removedDirectories", "ownerMarkerRemoved",
        "stageRootRemoved", "oldRootProjectionExact", "stageRootAbsent",
      ]) {
        if (typeof row[key] === "boolean" || (typeof row[key] === "number" && Number.isFinite(row[key]))) {
          safe[key] = row[key];
        }
      }
      if (row.ownerTokenPresent === true) safe.ownerTokenSupplied = true;
      phases.push(safe);
    } catch {
      phases.push({ phase: "unparsed-phase-marker" });
    }
  }
  return phases;
}

const originalManifestBytes = (await readPinnedFile(
  resolve(originalRunRoot, "manifest.json"), e2eBoundary, originalPins.runManifest,
)).bytes;
const originalManifest = JSON.parse(originalManifestBytes.toString("utf8"));
assert.equal(originalManifest.status, "failed", "the original public upload failure is immutable evidence");
assert.equal(originalManifest.testId, "mobile-high-latency-public-no-reload-setup");
assert.match(originalManifest.seed, /^[a-f0-9]{16}$/);

const staticManifestBytes = (await readPinnedFile(
  resolve(originalRunRoot, "artifacts/existing-static-root-manifest.json"), e2eBoundary, originalPins.staticManifest,
)).bytes;
const staticManifest = JSON.parse(staticManifestBytes.toString("utf8"));
assert.equal(staticManifest.root.path, "mobile-web-root");
assert.equal(staticManifest.files.length, 37);
assert.equal(staticManifest.directories.length, 18);
const rootRows = normalizeFileRows(staticManifest.files);
assert.equal(projectionSha256(rootRows), expectedRootProjectionSha256);
assert.equal(staticManifest.files.reduce((sum, row) => sum + row.size, 0), 4_644_388);

const publicInputsBytes = (await readPinnedFile(
  resolve(originalRunRoot, "artifacts/public-no-reload-inputs.json"), e2eBoundary, originalPins.publicInputs,
)).bytes;
const publicInputs = JSON.parse(publicInputsBytes.toString("utf8"));
assert.equal(publicInputs.isolatedStaticRoot, expectedStaticRoot);
assert.equal(publicInputs.isolatedSidecarPid, expectedOwnerPid);
assert.equal(publicInputs.isolatedSidecarConfigSha256, expectedConfigSha256);
assert.equal(publicInputs.remoteReverseForwardPort, expectedForwardPort);
assert.equal(publicInputs.productionRelayPortTouched, false);

const observationBytes = (await readPinnedFile(observationPath, e2eBoundary, originalPins.observation)).bytes;
const observation = JSON.parse(observationBytes.toString("utf8"));
assert.equal(observation.sshExecution.authenticationProvenByRemoteCommand, true);
assert.equal(observation.sshExecution.staticRootInspectionCompleted, true);
assert.equal(observation.sshExecution.stageInspectionCompleted, true);
assert.equal(observation.remote.sidecarMatchesExpected, true);
assert.equal(observation.remote.all443ListenersOwnedByExpectedSidecar, true);
assert.equal(observation.remote.forward32552Free, true);
assert.equal(observation.remote.production8451Touched, false);
assert.equal(observation.remote.staticRoot.complete, true);
assert.equal(observation.remote.stage.complete, true);
assertProjection(observation.remote.staticRoot.files, rootRows, "last observed static root");
assert.equal(projectionSha256(observation.remote.staticRoot.files), expectedRootProjectionSha256);
assert.equal(observation.remote.stage.files.length, 28);
assert.equal(observation.remote.stage.directories.length, 17);
assert.equal(observation.remote.stage.fileCountIncludingOwnerMarker, 29);
assert.equal(observation.remote.stage.dataFileCount, 28);
assert.equal(observation.remote.stage.totalBytesIncludingOwnerMarker, 385_402);
assert.equal(observation.remote.stage.ownerMarker.regularSingleLink, true);
assert.equal(observation.remote.stage.ownerMarker.matchesRunOwner, true);
assert.equal(projectionSha256(observation.remote.stage.files), expectedStageProjectionSha256);
assert.equal(observation.rootComparison.againstOriginalRoot.exactMatch, true);
assert.equal(observation.stageComparison.againstOriginalRoot.actualProjectionSha256, expectedStageProjectionSha256);
assert.equal(observation.stageComparison.againstFrozenBundle.exactMatch, false,
  "the observed incomplete stage must remain classified as partial, not as the current bundle");
assert.equal(observation.inputEvidence.originalRunManifestSha256, originalPins.runManifest);
assert.equal(observation.inputEvidence.originalStaticManifestSha256, originalPins.staticManifest);
assert.equal(observation.inputEvidence.originalInputsSha256, originalPins.publicInputs);
assert.equal(observation.inputEvidence.frozenBundleManifestSha256, originalPins.bundleManifest);
assert.equal(observation.inputEvidence.frozenBundleSha256, originalPins.frozenBundle);

const bundleManifestBytes = (await readPinnedFile(bundleManifestPath, privateBoundary, originalPins.bundleManifest)).bytes;
const bundleManifest = JSON.parse(bundleManifestBytes.toString("utf8"));
assert.equal(bundleManifest.bundleFileCount, 37);
assert.equal(bundleManifest.bundleSha256, originalPins.frozenBundle);
const bundleRows = normalizeFileRows(bundleManifest.bundleFiles);
assertProjection(publicInputs.mobileWeb.bundleFiles, bundleRows, "pinned bundle rows from original inputs");
const verifiedBundle = await verifyBundleTree(bundleRows);

const remoteHelperBytes = (await readPinnedFile(remoteHelperPath, resolve(repoRoot, "apps/kcoder-studio/e2e"), remoteHelperSha256, 256 * 1024)).bytes;
assert.ok(remoteHelperBytes.length < 256 * 1024);
const inputEvidence = {
  originalFailedRunManifestSha256: originalPins.runManifest,
  originalStaticRootManifestSha256: originalPins.staticManifest,
  originalPublicInputsSha256: originalPins.publicInputs,
  priorReadOnlyInspectionSha256: originalPins.observation,
  bundleManifestSha256: originalPins.bundleManifest,
  bundleSha256: originalPins.frozenBundle,
  bundleFileCount: verifiedBundle.fileCount,
  bundleProjectionSha256: verifiedBundle.projectionSha256,
  rootProjectionSha256: expectedRootProjectionSha256,
  observedPartialStageProjectionSha256: expectedStageProjectionSha256,
  observedStageFileCount: observation.remote.stage.dataFileCount,
  observedStageBytes: observation.remote.stage.files.reduce((sum, row) => sum + row.size, 0),
  observedStageDirectoryCount: observation.remote.stage.directories.length,
  observedStageFileLinkCountHistorical: "not recorded; cleanup revalidates every file with nlink=1 before unlink",
  remoteCleanupHelperSha256: remoteHelperSha256,
  remoteCleanupHelperBytes: remoteHelperBytes.length,
  rootAndStageComparisonFields: ["relative path", "size", "sha256"],
  timestampsUsedForByteComparison: false,
  ownerMarkerValueStoredInEvidence: false,
};

await runE2E(import.meta.url, {
  testId: "mobile-public-no-reload-owned-stage-cleanup-once",
  tier: "manual-live",
  modelPolicy: "no model; one bounded SSH cleanup of the exact prior run-owned partial stage after fresh owner/root gates",
  cleanupTimeoutMs: 60_000,
  processSignalTimeoutMs: 5_000,
}, async context => {
  assert.equal(process.version, "v22.17.0");
  assert.equal(await realpath(process.execPath), await realpath(pinnedNode));
  assert.equal(sha256(await readFile(process.execPath)), pinnedNodeSha256);
  assert.equal(await realpath(pinnedSsh), pinnedSsh);
  assert.equal(sha256(await readFile(pinnedSsh)), pinnedSshSha256);
  context.registerSecret(originalManifest.seed);

  const request = {
    owner: originalManifest.seed,
    stageRoot: `${expectedStaticRoot}.stage-${originalManifest.seed}`,
    expectedRootFiles: rootRows,
    expectedRootDirectories: staticManifest.directories.map(row => ({ path: row.path })),
    expectedRootIdentity: observation.remote.staticRoot.root,
    expectedStageRoot: observation.remote.stage.root,
    expectedStageDirectories: observation.remote.stage.directories,
    expectedStageFiles: observation.remote.stage.files.map(row => ({ ...row, nlink: 1 })),
    expectedOwnerMarker: { ...observation.remote.stage.ownerMarker, nlink: 1 },
  };
  const encodedHelper = Buffer.from(remoteHelperBytes).toString("base64");
  const remoteCommand = `python3 -c 'import base64;exec(base64.b64decode("${encodedHelper}"))'`;
  const label = "remove-exact-observed-owned-partial-stage";
  const child = context.spawnOwned(label, pinnedSsh, [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1",
    "aliyun", remoteCommand,
  ], {
    cwd: repoRoot,
    env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    stdin: "pipe",
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  child.stdout.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= stdoutLimitBytes) stdoutChunks.push(Buffer.from(chunk));
    else stdoutTruncated = true;
  });
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes <= stderrLimitBytes) stderrChunks.push(Buffer.from(chunk));
    else stderrTruncated = true;
  });
  let spawnErrorCode = null;
  child.once("error", error => { spawnErrorCode = typeof error?.code === "string" ? error.code : "spawn-error"; });
  const childClosed = new Promise(resolveClose => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  child.stdin.end(JSON.stringify(request));

  let timedOut = false;
  let stopFailureType = null;
  let stopPromise = null;
  const timer = setTimeout(() => {
    timedOut = true;
    stopPromise = context.stopOwned(label).catch(error => {
      stopFailureType = error?.name || "owned-process-stop-error";
    });
  }, localSshBoundMs);
  let exit;
  try {
    exit = await childClosed;
  } finally {
    clearTimeout(timer);
  }
  if (stopPromise) await stopPromise;

  const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
  let envelope;
  try {
    envelope = stdoutTruncated ? null : JSON.parse(stdoutText);
  } catch {
    envelope = null;
  }
  const remotePhases = safePhaseRows(Buffer.concat(stderrChunks).toString("utf8"));
  const remote = envelope?.ok === true ? envelope.result : null;
  const rootBeforeRows = normalizeFileRows(remote?.rootBefore?.files || []);
  const rootAfterRows = normalizeFileRows(remote?.rootAfter?.files || []);
  const stageBeforeRows = normalizeFileRows(remote?.stageBefore?.files || []);
  const cleanup = remote?.cleanup || null;
  const summary = {
    inputEvidence,
    operation: "remove only the exact prior run-owned partial stage; never exchange or delete the static root",
    attemptBounds: { remoteAlarmSeconds: 30, connectTimeoutSeconds: 15, localSshBoundMs },
    ownedChild: {
      label,
      pid: child.pid || null,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      spawnErrorCode,
      stopFailureType,
      stdoutBytes,
      stderrBytes,
      stdoutTruncated,
      stderrTruncated,
    },
    remotePhases,
    remoteResult: remote,
    rootBeforeProjection: {
      fileCount: rootBeforeRows.length,
      bytes: rootBeforeRows.reduce((sum, row) => sum + row.size, 0),
      projectionSha256: rootBeforeRows.length ? projectionSha256(rootBeforeRows) : null,
      matchesPinnedOldStaticRoot: rootBeforeRows.length === 37 && projectionSha256(rootBeforeRows) === expectedRootProjectionSha256,
    },
    stageBeforeProjection: {
      dataFileCount: stageBeforeRows.length,
      bytes: stageBeforeRows.reduce((sum, row) => sum + row.size, 0),
      projectionSha256: stageBeforeRows.length ? projectionSha256(stageBeforeRows) : null,
      matchesExactPriorObservedPartialStage: stageBeforeRows.length === 28
        && projectionSha256(stageBeforeRows) === expectedStageProjectionSha256,
    },
    cleanupProgress: cleanup,
    rootAfterProjection: {
      fileCount: rootAfterRows.length,
      bytes: rootAfterRows.reduce((sum, row) => sum + row.size, 0),
      projectionSha256: rootAfterRows.length ? projectionSha256(rootAfterRows) : null,
      unchangedFromPinnedOldStaticRoot: remote?.rootProjectionUnchanged === true
        && rootAfterRows.length === 37 && projectionSha256(rootAfterRows) === expectedRootProjectionSha256,
    },
    stageAbsent: remote?.stageRootAbsent === true,
    ownerMarkerValueStoredInEvidence: false,
    noBrowserStarted: true,
    noRelayOrGatewayStarted: true,
    noCaddyReloadOrSignal: true,
    noRootExchangeOrDelete: true,
    noServiceStartup: true,
    production8451Touched: false,
  };
  await context.writeArtifactJson("owned-stage-cleanup-proof.json", summary);

  assert.equal(timedOut, false, "single cleanup SSH must finish within the local bound");
  assert.equal(stopFailureType, null);
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0, "remote cleanup must complete within its alarm and exact input bounds");
  assert.equal(stdoutTruncated, false);
  assert.ok(envelope?.ok === true, "remote cleanup must return one structured proof response");
  assert.equal(remote.gatesBefore.sidecarMatchesExpected, true);
  assert.equal(remote.gatesBefore.all443ListenersOwnedByExpectedSidecar, true);
  assert.equal(remote.gatesBefore.forward32552Free, true);
  assert.equal(remote.gatesAfter.sidecarMatchesExpected, true);
  assert.equal(remote.gatesAfter.all443ListenersOwnedByExpectedSidecar, true);
  assert.equal(remote.gatesAfter.forward32552Free, true);
  assert.equal(remote.rootProjectionUnchanged, true);
  assert.equal(remote.stageBefore.projectionExact, true);
  assert.equal(remote.stageBefore.dataFileCount, 28);
  assert.equal(remote.stageBefore.dataBytes, 385_386);
  assert.equal(remote.cleanup.removedDataFiles, 28);
  assert.equal(remote.cleanup.removedDirectories, 18);
  assert.equal(remote.cleanup.ownerMarkerRemoved, true);
  assert.equal(remote.cleanup.stageRootRemoved, true);
  assert.equal(remote.stageRootAbsent, true);
  assert.equal(remote.readOnlyRootChecksAndExactOwnedStageUnlinkOnly, true);
  assert.equal(remote.rootExchangeDeleteReloadSignalOrServiceStartupAttempted, false);
  assert.equal(remote.production8451Touched, false);
  return summary;
});
