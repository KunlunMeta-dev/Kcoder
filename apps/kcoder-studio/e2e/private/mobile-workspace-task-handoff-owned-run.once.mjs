import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const EXPECTED_SUITE_SHA256 = "db199995cd22432ddac16cce226e4fc0fc3cbe43bb61924fa08b898591fa0147";
const EXPECTED_REUSE_HELPER_SHA256 = "d3e84b074e485dd2bf171d690d18e130920689b67711ad3f56a3bd791eb363f3";
const EXPECTED_BINARY_SHA256 = "6dfc9ce6af388f893b12ed1e309f26e640bd0127277e7a5f307ae142134ede02";
const EXPECTED_GATEWAY_SOURCE_SET_SHA256 = "59e94c5f1ab3b7cf7caa81b5cc76bfbaf43f384d2427429d539e4aa6a0ea571d";
const EXPECTED_WEB_MANIFEST_SHA256 = "14818b1a28d76430c25a094f3c09872ee6cf6411d883cc91ce87987d98a6f4aa";
const EXPECTED_WEB_BUNDLE_SHA256 = "19e436780ffcef29bee9cac8aab1943e48fc5f1169d1ce7375d283f32dd18067";
const EXPECTED_WEB_SOURCE_TREE_SHA256 = "8623b4e873e21303b40ea1f04b7107fd67a54f746ac328515542bf6ffee79892";
const EXPECTED_WEB_FILE_COUNT = 37;
const ALL_EXPECTED_SCENARIO_NAMES = [
  "open_ack_loss_same_intent_resume",
  "thread_start_ack_loss_original_id",
  "turn_start_ack_loss_exact_receipt_no_replay",
  "preferences_deferred_reload",
  "worktree_link_ack_loss_reload",
  "existing_thread_ignores_unrelated_handoff",
];
const HANDOFF_CASE_FILTER = process.env.KCODER_E2E_HANDOFF_CASE;
const EXPECTED_SCENARIO_NAMES = HANDOFF_CASE_FILTER === undefined
  ? ALL_EXPECTED_SCENARIO_NAMES
  : ["worktree_link_ack_loss_reload"];
const EXPECTED_MODEL_POLICY = HANDOFF_CASE_FILTER === undefined
  ? "Run all six hash-pinned Mobile handoff cases with an owned immutable app-server copy and a loopback deterministic provider; no real Provider or model-quality claim"
  : "Run only the explicitly selected worktree_link_ack_loss_reload handoff case with an owned immutable app-server copy and a loopback deterministic provider; this is not a six-case suite result, and makes no real Provider or model-quality claim";
const SUITE_RELATIVE = "apps/kcoder-studio/e2e/suites/mobile/mobile-workspace-task-handoff-browser.review.e2e.mjs";
const REUSE_HELPER_RELATIVE = "apps/kcoder-studio/e2e/harness/mobile-web-export-reuse.mjs";
const GATEWAY_SOURCE_PATHS = [
  "apps/kcoder-studio/dev-server.mjs",
  "apps/kcoder-studio/src/workspace-app-server-broker.js",
  "apps/kcoder-studio/src/retention-context.js",
  "apps/kcoder-studio/src/mobile-device-auth.js",
  "apps/kcoder-studio/src/mobile-device-private-storage.js",
  "apps/kcoder-studio/src/server-config.js",
  "apps/kcoder-studio/src/runtime-target-adapter.js",
  "apps/kcoder-studio/src/gateway-channel.js",
  "apps/kcoder-studio/src/request-load.js",
  "apps/kcoder-studio/src/broker-request-budget.js",
  "apps/kcoder-studio/src/workspace-broker-release.js",
];
const BINARY_SOURCE = resolve(repoRoot, "target/debug/kcoder");
const WEB_ARTIFACTS = resolve(
  repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/mobile-web-export-retain-handoff-static02.once.mjs/20261008-134341.700Z/artifacts",
);
const WEB_BUNDLE_ROOT = resolve(WEB_ARTIFACTS, "handoff-mobile-web-export");
const WEB_MANIFEST_PATH = resolve(WEB_ARTIFACTS, "handoff-mobile-web-export-manifest.schema1.json");

await runE2E(import.meta.url, {
  testId: "mobile-workspace-task-handoff-owned-binary-runner-once",
  tier: "full-integration",
  modelPolicy: EXPECTED_MODEL_POLICY,
  retainSuccessLogs: true,
  cleanupTimeoutMs: 15_000,
  survivorCheckTimeoutMs: 10_000,
}, async context => {
  const invalidCaseFilter = HANDOFF_CASE_FILTER !== undefined
    && HANDOFF_CASE_FILTER !== "worktree_link_ack_loss_reload";
  await context.writeArtifactJson("case-selection-preflight.json", {
    status: invalidCaseFilter ? "FAIL" : "PASS",
    mode: HANDOFF_CASE_FILTER === undefined ? "all-cases" : "single-case",
    filterPresent: HANDOFF_CASE_FILTER !== undefined,
    filterAccepted: !invalidCaseFilter,
    expectedScenarioNames: invalidCaseFilter ? [] : EXPECTED_SCENARIO_NAMES,
    expectedScenarioCount: invalidCaseFilter ? 0 : EXPECTED_SCENARIO_NAMES.length,
    modelPolicy: EXPECTED_MODEL_POLICY,
  });
  assert.equal(invalidCaseFilter, false,
    "KCODER_E2E_HANDOFF_CASE only accepts worktree_link_ack_loss_reload; omit it to run all six cases");

  const suitePath = resolve(repoRoot, SUITE_RELATIVE);
  const helperPath = resolve(repoRoot, REUSE_HELPER_RELATIVE);
  assert.equal(await hashRegularFile(suitePath), EXPECTED_SUITE_SHA256, "handoff suite source differs from its approved pin");
  assert.equal(await hashRegularFile(helperPath), EXPECTED_REUSE_HELPER_SHA256, "Mobile export reuse helper differs from its approved pin");
  const gatewaySourceSet = await hashGatewaySources();
  assert.equal(gatewaySourceSet.aggregateSha256, EXPECTED_GATEWAY_SOURCE_SET_SHA256,
    "the named 11-file Gateway source set differs from its approved pin");

  const webManifestBytes = await readRegularFile(WEB_MANIFEST_PATH, 1024 * 1024);
  assert.equal(sha256(webManifestBytes), EXPECTED_WEB_MANIFEST_SHA256, "retained Web manifest differs from its approved pin");
  const webManifest = parseJson(webManifestBytes, "retained Web manifest");
  assert.equal(webManifest.schemaVersion, 1);
  assert.equal(webManifest.sourceTreeSha256, EXPECTED_WEB_SOURCE_TREE_SHA256);
  assert.equal(webManifest.bundleSha256, EXPECTED_WEB_BUNDLE_SHA256);
  assert.equal(webManifest.bundleFileCount, EXPECTED_WEB_FILE_COUNT);
  assert.equal(webManifest.files?.length, EXPECTED_WEB_FILE_COUNT);
  assert.equal(webManifest.directory, "artifacts/handoff-mobile-web-export");
  assert.equal(resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/mobile-web-export-retain-handoff-static02.once.mjs/20261008-134341.700Z", webManifest.directory), WEB_BUNDLE_ROOT,
    "retained Web bundle must match the RunContext artifact manifest");

  const suiteRunParent = resolve(repoRoot, "target/test", SUITE_RELATIVE);
  const suiteRunsBefore = await listRunDirectories(suiteRunParent);
  const sourceBefore = await hashRegularFileWithStat(BINARY_SOURCE);
  assert.equal(sourceBefore.sha256, EXPECTED_BINARY_SHA256, "source app-server binary differs from its approved pin before copying");

  const copyDirectory = context.pathInState("immutable-app-server-binary");
  await mkdir(copyDirectory, { recursive: false, mode: 0o700 });
  const binaryCopy = resolve(copyDirectory, "kcoder");
  const copySha256 = await copyExecutableNoFollow(BINARY_SOURCE, binaryCopy, sourceBefore.size);
  assert.equal(copySha256, EXPECTED_BINARY_SHA256, "owned executable copy differs from its approved pin");
  await chmod(binaryCopy, 0o555);
  const copyBefore = await hashRegularFileWithStat(binaryCopy);
  assert.equal(copyBefore.sha256, EXPECTED_BINARY_SHA256);
  assert.equal(copyBefore.mode, 0o555, "owned app-server copy must be immutable mode 0555");
  const sourceAfterCopy = await hashRegularFileWithStat(BINARY_SOURCE);
  assert.equal(sourceAfterCopy.sha256, EXPECTED_BINARY_SHA256, "source app-server binary changed during copy");
  assert.equal(sourceAfterCopy.size, sourceBefore.size);

  await context.writeArtifactJson("binary-copy-preflight.json", {
    status: "PASS",
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    suiteSourceSha256: EXPECTED_SUITE_SHA256,
    reuseHelperSha256: EXPECTED_REUSE_HELPER_SHA256,
    gatewaySourceSetSha256: gatewaySourceSet.aggregateSha256,
    gatewaySourceFileCount: gatewaySourceSet.files.length,
    sourceBinaryPath: BINARY_SOURCE,
    sourceBinarySha256BeforeCopy: sourceBefore.sha256,
    sourceBinarySha256AfterCopy: sourceAfterCopy.sha256,
    ownedCopyRelativePath: relative(context.runRoot, binaryCopy).split(sep).join("/"),
    ownedCopySha256: copyBefore.sha256,
    ownedCopyMode: copyBefore.mode,
    webManifestSha256: EXPECTED_WEB_MANIFEST_SHA256,
    webBundleSha256: EXPECTED_WEB_BUNDLE_SHA256,
    webSourceTreeSha256: EXPECTED_WEB_SOURCE_TREE_SHA256,
    webBundleFileCount: EXPECTED_WEB_FILE_COUNT,
    expectedScenarioNames: EXPECTED_SCENARIO_NAMES,
    expectedScenarioCount: EXPECTED_SCENARIO_NAMES.length,
    modelPolicy: EXPECTED_MODEL_POLICY,
  });

  const env = context.isolatedEnvironment({
    KCODER_E2E_CHROMIUM_NO_SANDBOX: "1",
    KCODER_E2E_KCODER_BIN: binaryCopy,
    KCODER_E2E_EXPECTED_KCODER_SHA256: EXPECTED_BINARY_SHA256,
    KCODER_E2E_HANDOFF_WEB_BUNDLE_ROOT: WEB_BUNDLE_ROOT,
    KCODER_E2E_HANDOFF_WEB_MANIFEST: WEB_MANIFEST_PATH,
    KCODER_E2E_HANDOFF_WEB_SOURCE_TREE_SHA256: EXPECTED_WEB_SOURCE_TREE_SHA256,
    KCODER_E2E_HANDOFF_WEB_MANIFEST_SHA256: EXPECTED_WEB_MANIFEST_SHA256,
    KCODER_E2E_HANDOFF_WEB_BUNDLE_SHA256: EXPECTED_WEB_BUNDLE_SHA256,
    KCODER_E2E_HANDOFF_GATEWAY_SOURCE_SET_SHA256: EXPECTED_GATEWAY_SOURCE_SET_SHA256,
    ...(HANDOFF_CASE_FILTER === undefined ? {} : { KCODER_E2E_HANDOFF_CASE: HANDOFF_CASE_FILTER }),
  });
  const suiteLabel = HANDOFF_CASE_FILTER === undefined
    ? "handoff-six-case-pinned-suite"
    : "handoff-worktree-case-pinned-suite";
  const child = context.spawnOwned(suiteLabel, process.execPath, [suitePath], {
    cwd: repoRoot,
    env,
  });
  const childOwner = context.processes.get(suiteLabel);
  assert.ok(childOwner?.pid === child.pid && childOwner.pgid > 0, "RunContext must own the exact pinned suite subprocess and process group");

  let childOutcome;
  let childFailure = null;
  try {
    childOutcome = await waitForChild(child, 600_000);
  } catch (error) {
    childFailure = error;
  }

  let forcedStopFailure = null;
  if (childFailure) {
    try {
      await context.stopOwned(suiteLabel);
    } catch (error) {
      forcedStopFailure = error;
    }
  }

  const sourceAfterRun = await hashRegularFileWithStat(BINARY_SOURCE);
  const copyAfterRun = await hashRegularFileWithStat(binaryCopy);
  const suiteShaAfterRun = await hashRegularFile(suitePath);
  const helperShaAfterRun = await hashRegularFile(helperPath);
  const gatewaySourcesAfterRun = await hashGatewaySources();
  const webManifestAfterRun = await readRegularFile(WEB_MANIFEST_PATH, 1024 * 1024);
  const suiteUnchanged = suiteShaAfterRun === EXPECTED_SUITE_SHA256;
  const helperUnchanged = helperShaAfterRun === EXPECTED_REUSE_HELPER_SHA256;
  const gatewaySourcesUnchanged = gatewaySourcesAfterRun.aggregateSha256 === EXPECTED_GATEWAY_SOURCE_SET_SHA256
    && JSON.stringify(gatewaySourcesAfterRun) === JSON.stringify(gatewaySourceSet);
  const webManifestUnchanged = sha256(webManifestAfterRun) === EXPECTED_WEB_MANIFEST_SHA256;
  const sourceBinaryUnchanged = sourceAfterRun.sha256 === EXPECTED_BINARY_SHA256;
  const copyUnchanged = copyAfterRun.sha256 === EXPECTED_BINARY_SHA256 && copyAfterRun.mode === 0o555;

  const suiteRunsAfter = await listRunDirectories(suiteRunParent);
  const newSuiteRuns = suiteRunsAfter.filter(name => !suiteRunsBefore.includes(name));
  const suiteRunRoot = newSuiteRuns.length === 1 ? resolve(suiteRunParent, newSuiteRuns[0]) : null;
  let suiteEvidence = null;
  if (suiteRunRoot) suiteEvidence = await readSuiteEvidence(suiteRunRoot);
  const actualScenarioNames = suiteEvidence?.scenarioResults?.map(result => result.name) ?? [];
  const scenarioSelectionMatches = actualScenarioNames.length === EXPECTED_SCENARIO_NAMES.length
    && JSON.stringify(actualScenarioNames) === JSON.stringify(EXPECTED_SCENARIO_NAMES);
  const postflight = {
    status: childFailure || childOutcome?.code !== 0 || !suiteUnchanged || !helperUnchanged
      || !gatewaySourcesUnchanged || !webManifestUnchanged || !sourceBinaryUnchanged || !copyUnchanged
      || !scenarioSelectionMatches ? "FAIL" : "PASS",
    suiteChildPid: child.pid,
    suiteChildPgid: childOwner.pgid,
    suiteExitCode: childOutcome?.code ?? null,
    suiteSignal: childOutcome?.signal ?? null,
    suiteRunDirectoriesCreated: newSuiteRuns,
    suiteRunRoot,
    innerRunStatus: suiteEvidence?.runStatus ?? null,
    scenarioSelection: HANDOFF_CASE_FILTER === undefined ? "all-cases" : "single-case",
    selectedCaseFilter: HANDOFF_CASE_FILTER ?? null,
    expectedScenarioNames: EXPECTED_SCENARIO_NAMES,
    expectedScenarioCount: EXPECTED_SCENARIO_NAMES.length,
    actualScenarioNames,
    actualScenarioCount: actualScenarioNames.length,
    scenarioSelectionMatches,
    modelPolicy: EXPECTED_MODEL_POLICY,
    scenarioResults: suiteEvidence?.scenarioResults ?? null,
    actualGatewayAndChromiumOwners: suiteEvidence?.owners ?? null,
    actualAppServerProvenance: suiteEvidence?.appServer ?? null,
    suiteUnchanged,
    reuseHelperUnchanged: helperUnchanged,
    gatewaySourceSetUnchanged: gatewaySourcesUnchanged,
    webManifestUnchanged,
    sourceBinarySha256BeforeCopy: sourceBefore.sha256,
    sourceBinarySha256AfterCopy: sourceAfterCopy.sha256,
    sourceBinarySha256AfterSuite: sourceAfterRun.sha256,
    sourceBinaryUnchanged,
    ownedCopySha256BeforeSuite: copyBefore.sha256,
    ownedCopySha256AfterSuite: copyAfterRun.sha256,
    ownedCopyModeBeforeSuite: copyBefore.mode,
    ownedCopyModeAfterSuite: copyAfterRun.mode,
    ownedCopyUnchanged: copyUnchanged,
    gatewaySourceSetSha256: gatewaySourceSet.aggregateSha256,
    webManifestSha256: EXPECTED_WEB_MANIFEST_SHA256,
    webBundleSha256: EXPECTED_WEB_BUNDLE_SHA256,
    webSourceTreeSha256: EXPECTED_WEB_SOURCE_TREE_SHA256,
    webBundleFileCount: EXPECTED_WEB_FILE_COUNT,
    failureName: childFailure?.name ?? null,
    failureMessage: childFailure?.message ?? null,
    forcedStopFailureName: forcedStopFailure?.name ?? null,
    forcedStopFailureMessage: forcedStopFailure?.message ?? null,
  };
  await context.writeArtifactJson("binary-copy-postflight.json", postflight);
  assert.equal(newSuiteRuns.length, 1, "expected exactly one newly created selected-case RunContext directory");
  if (childFailure) throw childFailure;
  if (forcedStopFailure) throw forcedStopFailure;
  assert.equal(childOutcome.code, 0, `pinned handoff suite exited with code ${childOutcome.code}`);
  assert.equal(sourceBinaryUnchanged, true, "source app-server binary must retain the fixed SHA after the suite run");
  assert.equal(copyUnchanged, true, "owned app-server copy must retain SHA and mode 0555 after the suite run");
  assert.equal(suiteUnchanged, true, "handoff suite source changed during its run");
  assert.equal(helperUnchanged, true, "Mobile export reuse helper changed during its run");
  assert.equal(gatewaySourcesUnchanged, true, "Gateway source files changed during the run");
  assert.equal(webManifestUnchanged, true, "retained Web manifest changed during the run");
  assert.equal(suiteEvidence?.runStatus, "passed", "selected-case suite RunContext must finish passed");
  assert.equal(suiteEvidence?.scenarioResults?.length, EXPECTED_SCENARIO_NAMES.length,
    "every expected selected handoff case must be present in suite evidence");
  assert.deepEqual(actualScenarioNames, EXPECTED_SCENARIO_NAMES,
    "suite evidence must contain exactly the expected selected scenario IDs in order");
  assert.ok(suiteEvidence.scenarioResults.every(result => result.status === "PASS"),
    "every selected handoff case must pass");
  assert.equal(suiteEvidence?.owners?.length, 2, "suite evidence must include exact Gateway and Chromium owners");
  assert.ok(suiteEvidence.owners.every(owner => owner.stopped), "suite-owned Gateway and Chromium process groups must be stopped");
  assert.equal(suiteEvidence?.appServer?.configuredPath, binaryCopy, "Gateway must launch the app-server from the immutable copy");
  assert.equal(suiteEvidence?.appServer?.configuredSha256, EXPECTED_BINARY_SHA256);
  assert.equal(suiteEvidence?.appServer?.gatewayPgid, suiteEvidence.owners.find(owner => owner.label === "handoff-review-gateway")?.pgid);
  assert.ok(suiteEvidence.appServer.actualProcesses.some(process => process.sha256 === EXPECTED_BINARY_SHA256
    && process.executablePath === binaryCopy), "actual /proc executable evidence must match the pinned owned copy");

  return {
    status: "PASS",
    scenarioSelection: HANDOFF_CASE_FILTER === undefined ? "all-cases" : "single-case",
    selectedCaseFilter: HANDOFF_CASE_FILTER ?? null,
    expectedScenarioNames: EXPECTED_SCENARIO_NAMES,
    expectedScenarioCount: EXPECTED_SCENARIO_NAMES.length,
    modelPolicy: EXPECTED_MODEL_POLICY,
    suiteRunRoot,
    suiteChildPid: child.pid,
    suiteChildPgid: childOwner.pgid,
    scenarioResults: suiteEvidence.scenarioResults.map(({ name, status }) => ({ name, status })),
    appServerBinarySha256: copyAfterRun.sha256,
    appServerBinaryCopyMode: copyAfterRun.mode,
    gatewaySourceSetSha256: gatewaySourceSet.aggregateSha256,
    mobileWebManifestSha256: EXPECTED_WEB_MANIFEST_SHA256,
    mobileWebBundleSha256: EXPECTED_WEB_BUNDLE_SHA256,
    mobileWebSourceTreeSha256: EXPECTED_WEB_SOURCE_TREE_SHA256,
    mobileWebBundleFileCount: EXPECTED_WEB_FILE_COUNT,
  };
});

async function hashGatewaySources() {
  const files = [];
  for (const path of GATEWAY_SOURCE_PATHS) {
    const bytes = await readFile(resolve(repoRoot, path));
    files.push({ path, sha256: sha256(bytes), size: bytes.length });
  }
  const aggregateSha256 = sha256(Buffer.from(files.map(file => `${file.path}\0${file.sha256}\n`).join("")));
  return { aggregateSha256, files };
}

async function hashRegularFile(path) {
  return (await hashRegularFileWithStat(path)).sha256;
}

async function hashRegularFileWithStat(path) {
  await assertNoSymlinkPath(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat({ bigint: true });
    assert.ok(info.isFile(), "pinned executable or source input must be a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    let position = 0;
    while (position < Number(info.size)) {
      const length = Math.min(buffer.length, Number(info.size) - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      assert.ok(bytesRead > 0, "file ended before its stat-reported size");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    assert.equal(position, Number(info.size));
    return {
      sha256: hash.digest("hex"),
      size: Number(info.size),
      mode: Number(info.mode & 0o777n),
      dev: String(info.dev),
      ino: String(info.ino),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs),
    };
  } finally {
    await handle.close();
  }
}

async function copyExecutableNoFollow(sourcePath, destinationPath, expectedSize) {
  await assertNoSymlinkPath(sourcePath);
  const input = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const output = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = await input.stat({ bigint: true });
    assert.ok(info.isFile(), "binary source must be a regular file");
    assert.equal(Number(info.size), expectedSize, "binary source size changed before copy");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    let position = 0;
    while (position < expectedSize) {
      const length = Math.min(buffer.length, expectedSize - position);
      const { bytesRead } = await input.read(buffer, 0, length, position);
      assert.ok(bytesRead > 0, "binary source ended before its pinned size");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(chunk, written, bytesRead - written, position + written);
        assert.ok(result.bytesWritten > 0, "binary copy made no write progress");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    assert.equal(position, expectedSize);
    const sourceAfter = await input.stat({ bigint: true });
    assert.equal(sourceAfter.size, info.size, "binary source size changed while copying");
    assert.equal(sourceAfter.ino, info.ino, "binary source inode changed while copying");
    assert.equal(sourceAfter.dev, info.dev, "binary source device changed while copying");
    assert.equal(sourceAfter.mtimeNs, info.mtimeNs, "binary source modification time changed while copying");
    await output.sync();
    return hash.digest("hex");
  } finally {
    await Promise.all([input.close(), output.close()]);
  }
}

async function readRegularFile(path, maximumBytes) {
  await assertNoSymlinkPath(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.size <= maximumBytes, "pinned artifact must be a bounded regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function listRunDirectories(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort();
}

async function readSuiteEvidence(suiteRunRoot) {
  const runManifest = parseJson(await readRegularFile(resolve(suiteRunRoot, "manifest.json"), 1024 * 1024), "suite run manifest");
  const suiteSummaryPath = resolve(suiteRunRoot, "artifacts/mobile-workspace-task-handoff-browser-review.json");
  let suiteSummary = null;
  try {
    suiteSummary = parseJson(await readRegularFile(suiteSummaryPath, 4 * 1024 * 1024), "suite summary");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const owners = (runManifest.processes ?? [])
    .filter(process => process.label === "handoff-review-gateway" || process.label === "handoff-review-chromium")
    .map(({ label, pid, pgid, command, stopped }) => ({ label, pid, pgid, command, stopped }));
  let appServer = null;
  try {
    const provenance = parseJson(await readRegularFile(resolve(suiteRunRoot, "artifacts/actual-app-server-provenance.json"), 1024 * 1024), "app-server provenance");
    appServer = {
      configuredPath: provenance.configuredPath,
      gatewayPid: provenance.gatewayPid,
      gatewayPgid: provenance.gatewayPgid,
      configuredSha256: provenance.configuredSha256,
      actualProcesses: (provenance.actualProcesses ?? []).map(({ pid, executablePath, sha256 }) => ({ pid, executablePath, sha256 })),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    runStatus: runManifest.status,
    scenarioResults: suiteSummary?.scenarioResults ?? null,
    owners,
    appServer,
  };
}

async function waitForChild(child, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      new Promise((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      }),
      new Promise((_, rejectPromise) => {
        timeout = setTimeout(() => rejectPromise(new Error(`pinned handoff suite exceeded ${timeoutMs}ms outer timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function assertNoSymlinkPath(path) {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let cursor = absolute.startsWith(sep) ? sep : "";
  for (const part of parts) {
    cursor = resolve(cursor || ".", part);
    const info = await lstat(cursor);
    assert.ok(!info.isSymbolicLink(), "pinned executable or artifact path cannot contain symlinks");
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
