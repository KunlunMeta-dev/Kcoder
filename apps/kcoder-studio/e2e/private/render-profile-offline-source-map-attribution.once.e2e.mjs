import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapGeneratedProfilePosition,
  resolveScriptMapBinding,
  resolvePinnedMetroSourcePath,
  verifyPinnedSourceInventoryBytes,
} from "../harness/render-profile-attribution-contract.mjs";
import {
  assertPathWithinApprovedRoots,
  readVerifiedMobileExportFile,
  verifyMobileExportManifestEnvelope,
} from "../harness/mobile-web-export-input.mjs";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));
const ORIGINAL_RUN = resolve(repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/candidates/render-profile-full-v8-capture-20261009/mobile-render-profile.full-capture.candidate.mjs/20261009-173854.273Z");
const ORIGINAL_ARTIFACTS = resolve(ORIGINAL_RUN, "artifacts");
const CONTRACT_TEST_RUN = resolve(repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/render-profile-offline-source-map-attribution.once.e2e.mjs/20261009-181635.914Z");
const CONTRACT_TEST_LOG_PATH = resolve(CONTRACT_TEST_RUN, "logs/attribution-contract-tests.log");
const CONTRACT_TEST_SUMMARY_PATH = resolve(CONTRACT_TEST_RUN, "artifacts/attribution-contract-tests.json");
const CONTRACT_TEST_RUN_RESULT_PATH = resolve(CONTRACT_TEST_RUN, "artifacts/result.json");
const FULL_PROFILE_PATH = resolve(ORIGINAL_ARTIFACTS, "phone-render-core-v8-full-after-500-unmounted.json");
const ATTRIBUTION_PATH = resolve(ORIGINAL_ARTIFACTS, "phone-render-core-attribution-diagnostic.json");
const ORIGINAL_UNRESOLVED_PATH = resolve(ORIGINAL_ARTIFACTS, "phone-render-core-attribution-after-500-unmounted.json");
const ORIGINAL_RESULT_PATH = resolve(ORIGINAL_ARTIFACTS, "result.json");
const BUNDLE_PROVENANCE_PATH = resolve(ORIGINAL_ARTIFACTS, "render-profile-after-bundle-provenance.json");
const SOURCE_PROVENANCE_PATH = resolve(repoRoot,
  "target/private-phone-ux-implementation/mobile-web-export-current-source-profile-input-20261009/profile-source-provenance.json");
const SOURCE_INVENTORY_PATH = resolve(repoRoot,
  "target/private-phone-ux-implementation/mobile-web-export-current-source-profile-input-20261009/candidate-source-inventory.json");
const EXPORT_MANIFEST_PATH = resolve(repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/mobile-web-export-current349-source-maps.once.mjs/20261009-161652.452Z/artifacts/current-source-diagnostic-export-manifest.json");
const SOURCE_MAP_SHA256 = "8b4df33b032d35bc8eaf4a8a25e5e213614cec16f6b4620f895c1a5ec6774f18";
const FULL_PROFILE_SHA256 = "dab6fdfc54aad94501593ab5b40b232e2f5497590bddf2797a06189196756bec";
const ATTRIBUTION_DIAGNOSTIC_SHA256 = "b1259263dcc5592e801ca7f4dbe4256e89b0fc29ed1b0f56a4f5c619e479a1b0";
const ORIGINAL_UNRESOLVED_SHA256 = "fa06bee20b864aa6af0c0f7701df78f536e4608fcf97142f4eeb92429c00be97";
const PROFILE_BUNDLE_JS_SHA256 = "6b5e5c0b42fc11b1d3ecf7f7f4d748fddc7d7b8e99b850c70662595bc1735b92";
const SOURCE_PROVENANCE_SHA256 = "87e566ab6887cba6f7a783958a4900c52c681939272124a68d665430235e13be";
const SOURCE_INVENTORY_SHA256 = "c516f5678387fdb0c866cb403ef08ac43a23a9340bc3bb4ee5d2005fc699a03b";
const SOURCE_TREE_SHA256 = "a999d4cde3c0217789c355f0d91245fccb0b0268f2aadedbb97e12ef8360b994";
const EXPORT_MANIFEST_SHA256 = "ab71b7e88cd864739e505181019d30f61873a0099cf840309f8bb08c04916aad";
const BUNDLE_SHA256 = "b584d5085ea7fbcbcf728cde63937f14c2179fe593b27af29356d1a47d84ae5c";
const TRUSTED_MOUNT_PATH = "/__kcoder_mobile_mount_v1__";
const TEST_PATH = resolve(repoRoot, "apps/kcoder-studio/e2e/harness/render-profile-attribution-contract.test.mjs");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function normalizedFrameKey(frame) {
  return JSON.stringify([
    typeof frame?.functionName === "string" && frame.functionName ? frame.functionName : "(anonymous)",
    Number.isInteger(frame?.lineNumber) ? frame.lineNumber : null,
    Number.isInteger(frame?.columnNumber) ? frame.columnNumber : null,
  ]);
}

function deriveScriptIdBundleBinding({ rawProfile, topFunctions, mapPaths, bundleFiles, trustedMountPath }) {
  assert.ok(rawProfile && Array.isArray(rawProfile.nodes) && Array.isArray(rawProfile.samples), "raw V8 profile nodes and samples are required for script binding");
  assert.ok(Array.isArray(rawProfile.timeDeltas) && rawProfile.timeDeltas.length === rawProfile.samples.length, "raw V8 timeDeltas must pair exactly with samples");
  assert.ok(Array.isArray(topFunctions) && topFunctions.length > 0, "same-profile top functions are required for script binding");
  assert.ok(Array.isArray(mapPaths) && Array.isArray(bundleFiles), "pinned map and bundle inventories are required for script binding");

  const nodesById = new Map();
  const nodesByFrame = new Map();
  for (const node of rawProfile.nodes) {
    assert.ok(Number.isSafeInteger(node?.id) && node.callFrame && typeof node.callFrame === "object", "raw V8 node IDs and call frames must be present");
    assert.ok(!nodesById.has(node.id), "raw V8 profile contains duplicate node IDs");
    nodesById.set(node.id, node);
    const key = normalizedFrameKey(node.callFrame);
    const matches = nodesByFrame.get(key) ?? [];
    matches.push(node);
    nodesByFrame.set(key, matches);
  }
  const sampleCountsByNodeId = new Map();
  for (const nodeId of rawProfile.samples) {
    assert.ok(nodesById.has(nodeId), "raw V8 sample references an unknown node ID");
    sampleCountsByNodeId.set(nodeId, (sampleCountsByNodeId.get(nodeId) ?? 0) + 1);
  }

  const approvedFunctions = topFunctions.filter(frame => frame?.scriptUrlIdentity?.status === "APPROVED_SERVED_ORIGIN");
  assert.ok(approvedFunctions.length > 0, "top functions must contain an approved served bundle path");
  const servedPaths = new Set(approvedFunctions.map(frame => frame.scriptUrlIdentity.bundlePath));
  assert.equal(servedPaths.size, 1, "approved top functions resolve to different served bundle paths");
  const servedBundlePath = [...servedPaths][0];
  const identity = { status: "APPROVED_SERVED_ORIGIN", bundlePath: servedBundlePath };
  const bundleBinding = resolveScriptMapBinding(identity, mapPaths, { trustedMountPath });
  assert.equal(bundleBinding.status, "EXACT_BUNDLE_PATH_MATCH", "approved served path must bind through the exact trusted mount to one pinned map");
  const jsEntries = bundleFiles.filter(entry => entry?.path === bundleBinding.generatedPath);
  assert.equal(jsEntries.length, 1, "exact generated JS path must have one bundle manifest entry");
  assert.match(jsEntries[0].sha256 ?? "", /^[a-f0-9]{64}$/, "generated JS bytes must have a pinned SHA-256");

  let derivedScriptId = null;
  const crosswalk = [];
  for (const frame of approvedFunctions) {
    assert.ok(Number.isSafeInteger(frame.samples) && frame.samples > 0, "approved top-function sample counts must be positive integers");
    const matches = nodesByFrame.get(normalizedFrameKey(frame)) ?? [];
    assert.ok(matches.length > 0, "approved top-function frame must match a raw node by normalized function/line/column");
    const scriptIds = new Set(matches.map(node => node.callFrame.scriptId).filter(value => typeof value === "string" && value.length > 0));
    assert.equal(scriptIds.size, 1, "approved top-function frame maps to ambiguous or missing raw script IDs");
    const [scriptId] = scriptIds;
    if (derivedScriptId === null) derivedScriptId = scriptId;
    assert.equal(scriptId, derivedScriptId, "approved top-function frames do not share one V8 scriptId");
    const rawSampleCount = matches.reduce((sum, node) => sum + (sampleCountsByNodeId.get(node.id) ?? 0), 0);
    assert.equal(rawSampleCount, frame.samples, "approved top-function sample count differs from exact raw-profile node hits");
    for (const node of matches) {
      const rawIdentity = node.callFrame.scriptUrlIdentity;
      assert.ok(rawIdentity?.status === "SAME_ORIGIN_UNPINNED_PATH"
        || (rawIdentity?.status === "APPROVED_SERVED_ORIGIN" && rawIdentity.bundlePath === servedBundlePath),
      "matched raw node has a conflicting or unsupported URL identity");
    }
    crosswalk.push({
      functionName: typeof frame.functionName === "string" && frame.functionName ? frame.functionName : "(anonymous)",
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
      topFunctionSamples: frame.samples,
      matchedRawNodeIds: matches.map(node => node.id).sort((left, right) => left - right),
      matchedRawSampleCount: rawSampleCount,
      scriptId,
      servedBundlePath,
    });
  }
  assert.equal(typeof derivedScriptId, "string", "unique raw scriptId could not be derived");

  const nodesForScript = rawProfile.nodes.filter(node => node.callFrame.scriptId === derivedScriptId);
  assert.ok(nodesForScript.length > 0, "derived scriptId has no raw profile nodes");
  for (const node of nodesForScript) {
    const rawIdentity = node.callFrame.scriptUrlIdentity;
    assert.ok(rawIdentity?.status === "SAME_ORIGIN_UNPINNED_PATH"
      || (rawIdentity?.status === "APPROVED_SERVED_ORIGIN" && rawIdentity.bundlePath === servedBundlePath),
    "derived scriptId contains a node with a conflicting or unsupported URL identity");
  }
  const sampleCountForScript = rawProfile.samples.reduce((sum, nodeId) =>
    sum + (nodesById.get(nodeId).callFrame.scriptId === derivedScriptId ? 1 : 0), 0);
  const sampledMicrosForScript = rawProfile.samples.reduce((sum, nodeId, index) =>
    sum + (nodesById.get(nodeId).callFrame.scriptId === derivedScriptId ? rawProfile.timeDeltas[index] : 0), 0);
  return {
    scriptId: derivedScriptId,
    servedBundlePath,
    generatedBundlePath: bundleBinding.generatedPath,
    sourceMapPath: bundleBinding.mapPath,
    crosswalk,
    approvedTopFunctionCount: approvedFunctions.length,
    approvedTopFunctionSamples: crosswalk.reduce((sum, row) => sum + row.topFunctionSamples, 0),
    rawNodeCountForScript: nodesForScript.length,
    rawSampleCountForScript: sampleCountForScript,
    rawSampledMicrosForScript: sampledMicrosForScript,
    rawSampledMsForScript: Number((sampledMicrosForScript / 1000).toFixed(3)),
    generatedJsManifestEntry: jsEntries[0],
  };
}

function runScriptIdBindingContractChecks() {
  const jsPath = "_expo/static/js/web/entry-test.js";
  const servedPath = `__kcoder_mobile_mount_v1__/${jsPath}`;
  const rawIdentity = { status: "SAME_ORIGIN_UNPINNED_PATH", bundlePath: null };
  const makeNode = (id, scriptId, functionName, lineNumber, columnNumber) => ({
    id,
    callFrame: { scriptId, functionName, lineNumber, columnNumber, scriptUrlIdentity: rawIdentity },
  });
  const makeFrame = (functionName, lineNumber, columnNumber, samples, bundlePath = servedPath) => ({
    functionName,
    lineNumber,
    columnNumber,
    samples,
    scriptUrlIdentity: { status: "APPROVED_SERVED_ORIGIN", bundlePath },
  });
  const base = {
    rawProfile: {
      nodes: [makeNode(1, "dynamic-script-id", "alpha", 10, 20), makeNode(2, "dynamic-script-id", "beta", 30, 40)],
      samples: [1, 2],
      timeDeltas: [1000, 2000],
    },
    topFunctions: [makeFrame("alpha", 10, 20, 1), makeFrame("beta", 30, 40, 1)],
    mapPaths: [`${jsPath}.map`],
    bundleFiles: [{ path: jsPath, sha256: "a".repeat(64) }],
    trustedMountPath: TRUSTED_MOUNT_PATH,
  };
  const valid = deriveScriptIdBundleBinding(base);
  assert.equal(valid.scriptId, "dynamic-script-id", "binding must derive the observed scriptId, not use a fixed ID");
  assert.equal(valid.rawSampleCountForScript, 2);

  const collision = structuredClone(base);
  collision.rawProfile.nodes.push(makeNode(3, "other-script-id", "alpha", 10, 20));
  collision.rawProfile.samples.push(3);
  collision.rawProfile.timeDeltas.push(1000);
  assert.throws(() => deriveScriptIdBundleBinding(collision), /ambiguous or missing raw script IDs/);

  const wrongCount = structuredClone(base);
  wrongCount.topFunctions[0].samples = 2;
  assert.throws(() => deriveScriptIdBundleBinding(wrongCount), /sample count differs/);

  const differentPath = structuredClone(base);
  differentPath.topFunctions[1].scriptUrlIdentity.bundlePath = "__kcoder_mobile_mount_v1__/_expo/static/js/web/other.js";
  assert.throws(() => deriveScriptIdBundleBinding(differentPath), /different served bundle paths/);
  return { status: "PASS", checks: 4, labels: ["dynamic-script-id-binding", "cross-script-collision-rejected", "sample-count-mismatch-rejected", "different-approved-paths-rejected"] };
}

await runE2E(import.meta.url, {
  testId: "render-profile-offline-source-map-attribution",
  tier: "offline-evidence-analysis",
  modelPolicy: "no provider, no model turn, no browser, no gateway",
  retainSuccessLogs: true,
  processSignalTimeoutMs: 5_000,
  cleanupTimeoutMs: 10_000,
}, async context => {
  const scriptIdBindingContractChecks = runScriptIdBindingContractChecks();
  await context.writeArtifactJson("script-id-bundle-binding-contract.json", scriptIdBindingContractChecks);

  const assertRegularPinnedFile = async (path, label, expectedSha256) => {
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
    const bytes = await readFile(path);
    const digest = sha256(bytes);
    if (expectedSha256) assert.equal(digest, expectedSha256, `${label} differs from its recorded SHA-256`);
    return { path, bytes, sha256: digest, size: bytes.length };
  };

  const [contractTestLogFile, contractTestSummaryFile, contractTestRunResultFile] = await Promise.all([
    assertRegularPinnedFile(CONTRACT_TEST_LOG_PATH),
    assertRegularPinnedFile(CONTRACT_TEST_SUMMARY_PATH),
    assertRegularPinnedFile(CONTRACT_TEST_RUN_RESULT_PATH),
  ]);
  const rawTestLog = contractTestLogFile.bytes.toString("utf8");
  const priorTestSummary = JSON.parse(contractTestSummaryFile.bytes.toString("utf8"));
  const priorTestRunResult = JSON.parse(contractTestRunResultFile.bytes.toString("utf8"));
  const testExitCode = Number(rawTestLog.match(/^# fail (\d+)$/m)?.[1] ?? -1) === 0 ? 0 : 1;
  const testsSummary = {
    exitCode: testExitCode,
    signal: null,
    tests: Number(rawTestLog.match(/^# tests (\d+)$/m)?.[1] ?? 0),
    pass: Number(rawTestLog.match(/^# pass (\d+)$/m)?.[1] ?? 0),
    fail: Number(rawTestLog.match(/^# fail (\d+)$/m)?.[1] ?? 0),
    priorRunRoot: relative(repoRoot, CONTRACT_TEST_RUN),
    rawLogPath: relative(repoRoot, CONTRACT_TEST_LOG_PATH),
    rawLogSha256: contractTestLogFile.sha256,
    summaryArtifactSha256: contractTestSummaryFile.sha256,
    priorRunStatus: priorTestRunResult.status,
    priorRunFailedAfterContractTests: priorTestRunResult.status === "failed" && priorTestSummary.exitCode === 0,
  };
  assert.equal(priorTestSummary.exitCode, 0, "retained contract test subprocess must have exited 0");
  assert.equal(priorTestSummary.tests, 13, "retained contract test run must contain 13 cases");
  assert.equal(priorTestSummary.pass, 13, "retained contract test run must have 13 passing cases");
  assert.equal(priorTestSummary.fail, 0, "retained contract test run must have zero failures");
  assert.equal(rawTestLog.match(/^# tests (\d+)$/m)?.[1], "13");
  assert.equal(rawTestLog.match(/^# pass (\d+)$/m)?.[1], "13");
  assert.equal(rawTestLog.match(/^# fail (\d+)$/m)?.[1], "0");

  const originalRunInfo = await lstat(ORIGINAL_RUN);
  assert.ok(originalRunInfo.isDirectory() && !originalRunInfo.isSymbolicLink(), "original profile run must be a real directory");
  await assertPathWithinApprovedRoots(ORIGINAL_RUN, [resolve(repoRoot, "target/test/apps/kcoder-studio/e2e")], "original profile run");

  const [runResultFile, fullProfileFile, attributionFile, unresolvedFile, bundleProvenanceFile,
    sourceProvenanceFile, sourceInventoryFile, exportManifestFile, helperFile, contractTestFile, captureCandidateFile] = await Promise.all([
    assertRegularPinnedFile(ORIGINAL_RESULT_PATH),
    assertRegularPinnedFile(FULL_PROFILE_PATH, "retained full V8 profile", FULL_PROFILE_SHA256),
    assertRegularPinnedFile(ATTRIBUTION_PATH, "retained top-function attribution", ATTRIBUTION_DIAGNOSTIC_SHA256),
    assertRegularPinnedFile(ORIGINAL_UNRESOLVED_PATH, "original unresolved attribution", ORIGINAL_UNRESOLVED_SHA256),
    assertRegularPinnedFile(BUNDLE_PROVENANCE_PATH),
    assertRegularPinnedFile(SOURCE_PROVENANCE_PATH, "source provenance", SOURCE_PROVENANCE_SHA256),
    assertRegularPinnedFile(SOURCE_INVENTORY_PATH, "source inventory", SOURCE_INVENTORY_SHA256),
    assertRegularPinnedFile(EXPORT_MANIFEST_PATH, "diagnostic export manifest", EXPORT_MANIFEST_SHA256),
    assertRegularPinnedFile(resolve(repoRoot, "apps/kcoder-studio/e2e/harness/render-profile-attribution-contract.mjs")),
    assertRegularPinnedFile(TEST_PATH),
    assertRegularPinnedFile(resolve(repoRoot, "apps/kcoder-studio/e2e/private/candidates/render-profile-full-v8-capture-20261009/mobile-render-profile.full-capture.candidate.mjs")),
  ]);

  const originalResult = JSON.parse(runResultFile.bytes.toString("utf8"));
  const fullCapture = JSON.parse(fullProfileFile.bytes.toString("utf8"));
  const originalAttribution = JSON.parse(attributionFile.bytes.toString("utf8"));
  const oldUnresolved = JSON.parse(unresolvedFile.bytes.toString("utf8"));
  const bundleProvenance = JSON.parse(bundleProvenanceFile.bytes.toString("utf8"));
  const sourceProvenance = JSON.parse(sourceProvenanceFile.bytes.toString("utf8"));
  const sourceInventoryBytes = sourceInventoryFile.bytes;
  const exportManifest = JSON.parse(exportManifestFile.bytes.toString("utf8"));
  const runManifestPath = resolve(ORIGINAL_RUN, "manifest.json");
  const originalRunManifestFile = await assertRegularPinnedFile(runManifestPath);
  const originalRunManifest = JSON.parse(originalRunManifestFile.bytes.toString("utf8"));

  assert.equal(originalResult.status, "passed", "the retained capture run must itself be terminal passed");
  assert.equal(originalRunManifest.status, "passed", "the retained run manifest must be terminal passed");
  assert.equal(originalRunManifest.source, "apps/kcoder-studio/e2e/private/candidates/render-profile-full-v8-capture-20261009/mobile-render-profile.full-capture.candidate.mjs");
  assert.equal(fullCapture.source, "after", "retained full profile must be the after diagnostic capture");
  assert.equal(fullCapture.requestedMessages, 500, "retained full profile must be the 500-message diagnostic capture");
  assert.equal(fullCapture.panelState, "unmounted", "retained full profile must be the unmounted-panel capture");
  assert.equal(fullCapture.bundleSha256, BUNDLE_SHA256, "retained full profile must bind to the pinned diagnostic bundle");
  assert.equal(originalAttribution.cases[0].source, fullCapture.source, "top-function attribution and raw profile must describe the same source case");
  assert.equal(originalAttribution.cases[0].requestedMessages, fullCapture.requestedMessages, "top-function attribution and raw profile must use the same message count");
  assert.equal(originalAttribution.cases[0].panelState, fullCapture.panelState, "top-function attribution and raw profile must use the same panel state");
  assert.equal(originalAttribution.cases[0].bundleSha256, fullCapture.bundleSha256, "top-function attribution and raw profile must bind the same bundle");
  assert.equal(oldUnresolved.sourceAttributionStatus, "UNRESOLVED", "preserved original attribution must remain unresolved and untouched");
  assert.equal(originalAttribution.outcomeStatus, "CORE_PROFILES_CAPTURED_SOURCE_MAP_UNRESOLVED");
  assert.equal(originalAttribution.performanceDistributionEligible, false);
  assert.equal(originalAttribution.cases.length, 1);
  assert.equal(originalAttribution.cases[0].profileCaptureStatus, "CAPTURED");
  assert.equal(originalAttribution.cases[0].bundleSha256, BUNDLE_SHA256);
  assert.deepEqual(fullCapture.profile.startTime, originalAttribution.cases[0].profile.profileWindow.startTimeUs,
    "raw profile and top-function summary must share the exact CDP start timestamp");
  assert.deepEqual(fullCapture.profile.endTime, originalAttribution.cases[0].profile.profileWindow.endTimeUs,
    "raw profile and top-function summary must share the exact CDP end timestamp");
  assert.equal(bundleProvenance.status, "complete");
  assert.equal(bundleProvenance.source.bundleSha256, BUNDLE_SHA256);
  assert.equal(bundleProvenance.source.manifestSha256, EXPORT_MANIFEST_SHA256);
  assert.equal(sourceProvenance.status, "complete");
  assert.equal(sourceProvenance.candidateDigest, SOURCE_INVENTORY_SHA256);
  assert.equal(sourceProvenance.sourceTreeSha256, SOURCE_TREE_SHA256);
  assert.equal(sourceProvenance.bundleSha256, BUNDLE_SHA256);
  assert.equal(sourceProvenance.sourceMapEvidence.bundleFileCount, 38);

  verifyMobileExportManifestEnvelope(exportManifest, exportManifestFile.bytes, EXPORT_MANIFEST_SHA256, "retained current-source diagnostic export");
  assert.equal(exportManifest.bundleSha256, BUNDLE_SHA256);
  assert.deepEqual(originalAttribution.cases[0].sourceMapEvidence, exportManifest.sourceMapEvidence);
  assert.equal(exportManifest.bundleFiles.length, 38);

  const pinnedInventory = verifyPinnedSourceInventoryBytes({
    inventoryBytes: sourceInventoryBytes,
    candidateDigest: SOURCE_INVENTORY_SHA256,
    candidateFiles: sourceProvenance.candidateFiles,
    sourceTreeSha256: SOURCE_TREE_SHA256,
    sourceRoots: sourceProvenance.sourceRoots,
    inputRoots: exportManifest.inputRoots,
  });
  assert.equal(pinnedInventory.files.length, 368);
  assert.equal(sourceProvenance.candidateMobileManifestFiles, 349);
  assert.equal(sourceProvenance.candidateSharedManifestFiles, 19);

  const bundleRoot = resolve(repoRoot, bundleProvenance.source.bundleRoot);
  await assertPathWithinApprovedRoots(bundleRoot, [resolve(repoRoot, "target/test/apps/kcoder-studio/e2e")], "diagnostic source-map bundle");
  const listedPaths = new Set();
  for (const entry of exportManifest.bundleFiles) {
    const bytes = await readVerifiedMobileExportFile(bundleRoot, entry, "retained diagnostic bundle entry");
    listedPaths.add(entry.path);
    if (entry.path.endsWith(".map")) assert.equal(sha256(bytes), SOURCE_MAP_SHA256);
  }
  const actualFiles = [];
  const walkBundle = async (folder, prefix = "") => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const absolute = resolve(folder, item.name);
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), "retained diagnostic bundle cannot contain symlinks");
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (info.isDirectory()) await walkBundle(absolute, path);
      else {
        assert.ok(info.isFile(), "retained diagnostic bundle must contain only regular files");
        actualFiles.push(path);
      }
    }
  };
  await walkBundle(bundleRoot);
  assert.deepEqual(actualFiles.sort(), [...listedPaths].sort(), "retained bundle file set must match its exact export manifest");

  const mapEntry = exportManifest.bundleFiles.find(entry => entry.path.endsWith(".map"));
  assert.ok(mapEntry, "exactly retained source map must be listed");
  const mapBytes = await readVerifiedMobileExportFile(bundleRoot, mapEntry, "retained source map");
  const mapJson = JSON.parse(mapBytes.toString("utf8"));
  assert.equal(mapJson.version, 3);
  assert.ok(Array.isArray(mapJson.sources) && Array.isArray(mapJson.sourcesContent));
  const mapSourceAliases = { mobile: 0, shared: 0, virtualOrOther: 0, pinnedMobile: 0, pinnedShared: 0, rejectedContentOrShape: 0 };
  for (let index = 0; index < mapJson.sources.length; index += 1) {
    const source = mapJson.sources[index];
    if (source.startsWith("/src/")) mapSourceAliases.mobile += 1;
    else if (source.startsWith("/../shared/")) mapSourceAliases.shared += 1;
    else mapSourceAliases.virtualOrOther += 1;
    const resolved = resolvePinnedMetroSourcePath(source, {
      sourceRoots: pinnedInventory.sourceRoots,
      candidateSourceFiles: pinnedInventory.files,
      sourceMapSources: mapJson.sources,
      sourcesContent: mapJson.sourcesContent,
    });
    if (resolved.status === "PINNED_METRO_SOURCE" && resolved.root === "mobile") mapSourceAliases.pinnedMobile += 1;
    else if (resolved.status === "PINNED_METRO_SOURCE" && resolved.root === "studio-shared") mapSourceAliases.pinnedShared += 1;
    else if (source.startsWith("/src/") || source.startsWith("/../shared/")) mapSourceAliases.rejectedContentOrShape += 1;
  }

  const mobileRequire = createRequire(resolve(repoRoot, "apps/kcoder-studio/mobile/package.json"));
  const { TraceMap, originalPositionFor, GREATEST_LOWER_BOUND } = mobileRequire("@jridgewell/trace-mapping");
  const traceMap = new TraceMap(mapJson, mapEntry.path);
  const mapPaths = exportManifest.bundleFiles.filter(entry => entry.path.endsWith(".map")).map(entry => entry.path);
  const rawProfile = fullCapture.profile;
  const topFunctions = originalAttribution.cases[0].profile.topFunctions ?? [];
  assert.equal(rawProfile.samples.length, rawProfile.timeDeltas.length);
  assert.equal(rawProfile.samples.length, originalAttribution.cases[0].profile.sampleCount);
  const scriptIdPathBinding = deriveScriptIdBundleBinding({
    rawProfile,
    topFunctions,
    mapPaths,
    bundleFiles: exportManifest.bundleFiles,
    trustedMountPath: TRUSTED_MOUNT_PATH,
  });
  assert.equal(scriptIdPathBinding.generatedJsManifestEntry.sha256, PROFILE_BUNDLE_JS_SHA256,
    "derived scriptId binding must resolve to the exactly pinned generated JS bytes");
  const generatedJsBytes = await readVerifiedMobileExportFile(bundleRoot, scriptIdPathBinding.generatedJsManifestEntry, "scriptId-bound generated JS");
  assert.equal(sha256(generatedJsBytes), PROFILE_BUNDLE_JS_SHA256,
    "scriptId-bound generated JS bytes must match the pinned digest");
  const sourceEvidence = {
    sourceRoots: pinnedInventory.sourceRoots,
    candidateSourceFiles: pinnedInventory.files,
    sourceMapSources: mapJson.sources,
    sourcesContent: mapJson.sourcesContent,
  };
  const mapFrame = frame => {
    const identity = frame.scriptUrlIdentity;
    if (!identity) return { bindingStatus: "SCRIPT_URL_IDENTITY_MISSING", mapped: null, dependencyLabel: false };
    const binding = resolveScriptMapBinding(identity, mapPaths, { trustedMountPath: TRUSTED_MOUNT_PATH });
    if (binding.status !== "EXACT_BUNDLE_PATH_MATCH") return { bindingStatus: binding.status, mapped: null, dependencyLabel: false };
    const mapped = mapGeneratedProfilePosition(traceMap, frame, { originalPositionFor, GREATEST_LOWER_BOUND }, sourceEvidence);
    let dependencyLabel = false;
    if (Number.isInteger(frame.lineNumber) && frame.lineNumber >= 0 && Number.isInteger(frame.columnNumber) && frame.columnNumber >= 0) {
      const raw = originalPositionFor(traceMap, { line: frame.lineNumber + 1, column: frame.columnNumber, bias: GREATEST_LOWER_BOUND });
      dependencyLabel = typeof raw?.source === "string" && raw.source.split(/[\\/]/).includes("node_modules");
    }
    return { bindingStatus: binding.status, mapped, dependencyLabel };
  };

  const categories = new Map();
  const addCategory = (name, frame) => {
    const record = categories.get(name) ?? { frameCount: 0, samples: 0, sampledMs: 0 };
    record.frameCount += 1;
    record.samples += Number.isSafeInteger(frame.samples) ? frame.samples : 0;
    record.sampledMs += Number.isFinite(frame.selfSampledMs) ? frame.selfSampledMs : 0;
    categories.set(name, record);
  };
  const mappedTopFunctions = [];
  for (const frame of originalAttribution.cases[0].profile.topFunctions ?? []) {
    const mapped = mapFrame(frame);
    const name = frame.functionName ?? "";
    let category = "UNMAPPED_OR_UNVERIFIED";
    if (name === "(program)") category = "PROGRAM";
    else if (name === "(idle)") category = "IDLE";
    else if (name === "(garbage collector)") category = "GARBAGE_COLLECTOR";
    else if (mapped.mapped?.status === "MAPPED" && mapped.mapped.sourcePathStatus === "PINNED_METRO_SOURCE") {
      category = mapped.mapped.source.startsWith("apps/kcoder-studio/mobile/") ? "PINNED_MOBILE" : "PINNED_SHARED";
    } else if (mapped.dependencyLabel) category = "MAP_LABELED_DEPENDENCY_UNPINNED_SOURCE_CONTENT";
    addCategory(category, frame);
    mappedTopFunctions.push({
      functionName: name || "(anonymous)",
      samples: frame.samples,
      selfSampledMs: frame.selfSampledMs,
      scriptBindingStatus: mapped.bindingStatus,
      mappedSourceStatus: mapped.mapped?.status ?? null,
      sourcePathStatus: mapped.mapped?.sourcePathStatus ?? null,
      ...(mapped.mapped?.sourcePathStatus === "PINNED_METRO_SOURCE" ? { pinnedSource: mapped.mapped.source, line: mapped.mapped.line, column: mapped.mapped.column } : {}),
      category,
    });
  }

  const topFunctionSampledMs = topFunctions.reduce((sum, frame) => sum + (frame.selfSampledMs ?? 0), 0);
  const topFunctionSamples = topFunctions.reduce((sum, frame) => sum + (frame.samples ?? 0), 0);
  assert.equal(rawProfile.samples.length, rawProfile.timeDeltas.length);
  const rawSampledMicros = rawProfile.timeDeltas.reduce((sum, value) => sum + value, 0);
  const rawSampledMs = rawSampledMicros / 1000;
  assert.equal(rawProfile.samples.length, originalAttribution.cases[0].profile.sampleCount);
  assert.equal(Number(rawSampledMs.toFixed(3)), originalAttribution.cases[0].profile.totalSampledMs);
  const remainderMs = Number((rawSampledMs - topFunctionSampledMs).toFixed(3));

  const taskStacks = originalAttribution.cases[0].profile.longTaskStackAttribution ?? [];
  const mappedLongTasks = taskStacks.map(task => ({
    status: task.status,
    sampleCount: task.sampleCount,
    sampledMs: task.sampledMs,
    topStacks: (task.topStacks ?? []).map(stack => {
      const frames = (stack.stack ?? []).map(frame => ({
        functionName: frame.functionName ?? "(anonymous)",
        ...mapFrame(frame),
      }));
      return { sampleCount: stack.sampleCount, sampledMs: stack.sampledMs, frames };
    }),
  }));

  const bundleEntries = exportManifest.bundleFiles.length;
  const completeSampleCategoryMicros = new Map();
  const completeSampleLedger = [];
  const addCompleteSampleCategory = (name, micros) => {
    const current = completeSampleCategoryMicros.get(name) ?? { samples: 0, sampledMicros: 0 };
    current.samples += 1;
    current.sampledMicros += micros;
    completeSampleCategoryMicros.set(name, current);
  };
  const rawNodesById = new Map(rawProfile.nodes.map(node => [node.id, node]));
  for (let index = 0; index < rawProfile.samples.length; index += 1) {
    const nodeId = rawProfile.samples[index];
    const node = rawNodesById.get(nodeId);
    assert.ok(node, `sample ${index} must reference an existing raw V8 node`);
    const frame = node.callFrame ?? {};
    const functionName = typeof frame.functionName === "string" && frame.functionName ? frame.functionName : "(anonymous)";
    const sampledMicros = rawProfile.timeDeltas[index];
    assert.ok(Number.isFinite(sampledMicros) && sampledMicros >= 0, `sample ${index} must have a non-negative timeDelta`);
    let category = "UNMAPPED_OR_UNVERIFIED";
    let mapping = null;
    if (functionName === "(program)") category = "PROGRAM";
    else if (functionName === "(idle)") category = "IDLE";
    else if (functionName === "(garbage collector)") category = "GARBAGE_COLLECTOR";
    else if (frame.scriptId === scriptIdPathBinding.scriptId) {
      const boundFrame = {
        functionName,
        scriptPath: `/${scriptIdPathBinding.servedBundlePath}`,
        scriptUrlIdentity: { status: "APPROVED_SERVED_ORIGIN", bundlePath: scriptIdPathBinding.servedBundlePath },
        lineNumber: Number.isInteger(frame.lineNumber) ? frame.lineNumber : null,
        columnNumber: Number.isInteger(frame.columnNumber) ? frame.columnNumber : null,
      };
      mapping = mapFrame(boundFrame);
      if (mapping.mapped?.status === "MAPPED" && mapping.mapped.sourcePathStatus === "PINNED_METRO_SOURCE") {
        category = mapping.mapped.source.startsWith("apps/kcoder-studio/mobile/") ? "PINNED_MOBILE" : "PINNED_SHARED";
      } else if (mapping.dependencyLabel) {
        category = "DEPENDENCY_SOURCE_UNPINNED_CONTENT";
      }
    }
    addCompleteSampleCategory(category, sampledMicros);
    completeSampleLedger.push({
      sampleIndex: index,
      nodeId,
      scriptId: typeof frame.scriptId === "string" ? frame.scriptId : null,
      functionName,
      lineNumber: Number.isInteger(frame.lineNumber) ? frame.lineNumber : null,
      columnNumber: Number.isInteger(frame.columnNumber) ? frame.columnNumber : null,
      timeDeltaMicros: sampledMicros,
      sampledMs: Number((sampledMicros / 1000).toFixed(6)),
      bindingStatus: frame.scriptId === scriptIdPathBinding.scriptId
        ? "DERIVED_FROM_UNIQUE_SAME_PROFILE_CROSSWALK"
        : "NO_APPROVED_SCRIPT_BINDING",
      category,
      mappedSourceStatus: mapping?.mapped?.status ?? null,
      sourcePathStatus: mapping?.mapped?.sourcePathStatus ?? null,
      ...(mapping?.mapped?.sourcePathStatus === "PINNED_METRO_SOURCE" ? {
        mappedSource: mapping.mapped.source,
        mappedLine: mapping.mapped.line,
        mappedColumn: mapping.mapped.column,
      } : {}),
    });
  }
  const completeSampleCategorySummary = Object.fromEntries([...completeSampleCategoryMicros.entries()].map(([name, value]) => [name, {
    samples: value.samples,
    sampledMs: Number((value.sampledMicros / 1000).toFixed(3)),
  }]));
  const completeSampleCount = [...completeSampleCategoryMicros.values()].reduce((sum, value) => sum + value.samples, 0);
  const completeSampleMicros = [...completeSampleCategoryMicros.values()].reduce((sum, value) => sum + value.sampledMicros, 0);
  assert.equal(completeSampleCount, rawProfile.samples.length, "complete sample categories must partition each raw V8 sample exactly once");
  assert.equal(completeSampleMicros, rawProfile.timeDeltas.reduce((sum, value) => sum + value, 0),
    "complete sample categories must preserve the actual V8 timeDelta total without overlap");

  const methods = {
    sourceInventory: "candidate-source-inventory.json bytes SHA-pinned and matched to provenance + export inputRoots; exact source-map sourcesContent SHA checked against the pinned 368-file inventory",
    mount: `only exact trusted served path prefix ${TRUSTED_MOUNT_PATH} is stripped; remaining path must exactly match a listed map output path on the approved origin`,
    scriptIdRecovery: "scriptId-to-bundle binding is derived only from exact normalized frame tuples in the same CDP profile; every approved top-function row must uniquely resolve to one raw scriptId and its observed sample count must equal raw node hits",
    originalCapture: "retained raw node URLs remain status-only; exact bundle path recovery uses the same-profile top-function crosswalk plus pinned generated-JS/map paths; original UNRESOLVED artifact is neither rewritten nor replaced",
  };

  const categorized = Object.fromEntries([...categories.entries()].map(([name, value]) => [name, {
    frameCount: value.frameCount,
    samples: value.samples,
    sampledMs: Number(value.sampledMs.toFixed(3)),
  }]));
  const output = {
    schemaVersion: 1,
    status: "OFFLINE_REMAP_COMPLETE",
    classification: "SINGLE_CAPTURE_DIAGNOSTIC_ONLY",
    performanceSample: false,
    performanceDistributionEligible: false,
    originalRun: {
      runRoot: relative(repoRoot, ORIGINAL_RUN),
      manifestSha256: originalRunManifestFile.sha256,
      manifestStatus: originalRunManifest.status,
      resultSha256: runResultFile.sha256,
      resultStatus: originalResult.status,
      originalUnresolvedArtifactSha256: unresolvedFile.sha256,
      originalUnresolvedStatus: oldUnresolved.sourceAttributionStatus,
      candidateSourceAtRunHash: "UNAVAILABLE_IN_ORIGINAL_MANIFEST; no historical suite-byte claim is made",
    },
    frozenInputs: {
      sourceProvenancePath: relative(repoRoot, SOURCE_PROVENANCE_PATH),
      sourceProvenanceSha256: sourceProvenanceFile.sha256,
      sourceInventoryPath: relative(repoRoot, SOURCE_INVENTORY_PATH),
      sourceInventorySha256: sourceInventoryFile.sha256,
      sourceTreeSha256: SOURCE_TREE_SHA256,
      frozenSourceEntryCount: pinnedInventory.files.length,
      sourceRootCounts: Object.fromEntries(pinnedInventory.sourceRoots.map(root => [root.name, root.fileCount])),
      exportManifestPath: relative(repoRoot, EXPORT_MANIFEST_PATH),
      exportManifestSha256: exportManifestFile.sha256,
      bundleRoot: relative(repoRoot, bundleRoot),
      bundleSha256: BUNDLE_SHA256,
      bundleFileCount: bundleEntries,
      sourceMapPath: mapEntry.path,
      sourceMapSha256: sha256(mapBytes),
      generatedJsPath: scriptIdPathBinding.generatedBundlePath,
      generatedJsSha256: sha256(generatedJsBytes),
      sourceMapSourceCount: mapJson.sources.length,
      sourceMapAliasChecks: mapSourceAliases,
      dependencySourceTreeSha256: sourceProvenance.dependencySourceTreeSha256,
      helperSha256: helperFile.sha256,
      contractTestSha256: contractTestFile.sha256,
      contractTestSourceSha256AtOfflineRun: contractTestFile.sha256,
      captureCandidateCurrentSha256: captureCandidateFile.sha256,
      offlineEntrySha256: sha256(await readFile(SCRIPT_PATH)),
    },
    mappingContract: methods,
    rawProfile: {
      v8SampleCount: rawProfile.samples.length,
      fullProfileSampledMs: Number(rawSampledMs.toFixed(3)),
      topFunctionFrameCount: topFunctions.length,
      topFunctionSampleCount: topFunctionSamples,
      topFunctionSampledMs: Number(topFunctionSampledMs.toFixed(3)),
      topFunctionUnclassifiedTailMs: remainderMs,
      rawNodes: rawProfile.nodes.length,
      rawNodeUrlLimitation: "Raw node URLs remain status-only; the single scriptId binding below is derived from exact same-profile function/line/column crosswalks and exact sample-count equality, not from same-origin status alone.",
    },
    scriptIdPathBinding: {
      method: "SAME_PROFILE_APPROVED_TOP_FUNCTION_CROSSWALK",
      status: "DERIVED_AND_PINNED",
      scriptId: scriptIdPathBinding.scriptId,
      servedBundlePath: scriptIdPathBinding.servedBundlePath,
      generatedBundlePath: scriptIdPathBinding.generatedBundlePath,
      generatedJsSha256: sha256(generatedJsBytes),
      sourceMapPath: scriptIdPathBinding.sourceMapPath,
      sourceMapSha256: sha256(mapBytes),
      approvedTopFunctionCount: scriptIdPathBinding.approvedTopFunctionCount,
      approvedTopFunctionSamples: scriptIdPathBinding.approvedTopFunctionSamples,
      rawNodeCountForScript: scriptIdPathBinding.rawNodeCountForScript,
      rawSampleCountForScript: scriptIdPathBinding.rawSampleCountForScript,
      rawSampledMsForScript: scriptIdPathBinding.rawSampledMsForScript,
      crosswalk: scriptIdPathBinding.crosswalk,
      negativeContractChecks: scriptIdBindingContractChecks,
    },
    completeSampleCategories: {
      classification: "NON_OVERLAPPING_PARTITION_BY_RAW_V8_TIMEDELTAS",
      sampleCount: completeSampleCount,
      sampledMs: Number((completeSampleMicros / 1000).toFixed(3)),
      categories: completeSampleCategorySummary,
      sampleLedger: completeSampleLedger,
      additiveWithTopFunctionOrLongTaskViews: false,
    },
    topFunctionCategories: categorized,
    mappedTopFunctions,
    longTaskAttribution: mappedLongTasks,
    contractTests: testsSummary,
    evidenceBoundary: "Offline remapping of one retained mock-only 500-message capture. This does not establish a performance distribution, product-wide hotspot, native/mobile-device result, Rust Gateway result, or performance gain. CDP profiler overhead and browser program/idle/GC time are reported separately and are not React execution time.",
  };
  await context.writeArtifactJson("offline-profile-attribution.json", output);
  assert.ok(mapSourceAliases.pinnedMobile + mapSourceAliases.pinnedShared > 0, "frozen app source aliases must map by source-content SHA");
  return {
    status: "OFFLINE_REMAP_COMPLETE",
    testCases: testsSummary.tests,
    testsPassed: testsSummary.pass,
    v8Samples: rawProfile.samples.length,
    v8SampledMs: Number(rawSampledMs.toFixed(3)),
    bundleFiles: bundleEntries,
    sourceFiles: pinnedInventory.files.length,
    mappedMobileAliases: mapSourceAliases.pinnedMobile,
    mappedSharedAliases: mapSourceAliases.pinnedShared,
    distributionEligible: false,
  };
});
