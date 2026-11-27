import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { readVerifiedMobileExportFile, verifyMobileExportManifestEnvelope } from "../../../harness/mobile-web-export-input.mjs";
import { resolveScriptMapBinding, verifySourceMapBundleEvidence } from "../../../harness/render-profile-attribution-contract.mjs";

const expected = {
  rawProfileSha256: "23d565cba127e21a37a5f37cdbeeec0f37544c0fee6cd5f622f7421db69979aa",
  coreAttributionSha256: "db514bfa27dc53253d80167ac6f05565c92a25f855af5921208b68cd4a748e6b",
  exportManifestSha256: "7641ceac87eb5a611388d0366a2331f2b1a54a06e4674be69f1247329aa6e03f",
  bundleSha256: "f33e10d2b686af7fb03228208ce06e177b54da4eecc700639d6abb18fe248458",
  sourceFreezeManifestSha256: "604d8915c48d56ac58404990183072b73db0c63abd68821a974b311b2f4924a5",
  sourceFreezeDigest: "effa93130e74c958a4fd6639e79efab1d1a8bc78bcd18648aa9f70fe26f2b233",
};

const runRoot = resolve("target/test/apps/kcoder-studio/e2e/private/candidates/render-profile-full-v8-capture-20261009/mobile-render-profile.full-capture.candidate.mjs/20261009-103704.785Z");
const artifactsRoot = resolve(runRoot, "artifacts");
const rawPath = resolve(artifactsRoot, "phone-render-core-v8-full-after-500-unmounted.json");
const corePath = resolve(artifactsRoot, "phone-render-core-attribution-after-500-unmounted.json");
const exportRoot = resolve("target/private-phone-ux-implementation/mobile-web-export-current336-source-maps-20261009");
const bundleRoot = resolve(exportRoot, "bundle");
const manifestPath = resolve(exportRoot, "export-manifest.json");
const sourceFreezeRoot = resolve("target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104/source");
const sourceFreezeManifestPath = resolve("target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104/source-manifest.json");
const outputPath = resolve("target/private-phone-ux-implementation/render-profile-offline-recovery-20261009/full-profile-after-500-unmounted-r2.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function addSampledFrame(durations, frame, microseconds) {
  const identity = frame.scriptUrlIdentity;
  assert.ok(identity && typeof identity.status === "string", "sanitized profile frame must retain its captured URL identity");
  const functionName = frame.functionName || "(anonymous)";
  const key = `${functionName}|${JSON.stringify(identity)}|${frame.lineNumber ?? 0}:${frame.columnNumber ?? 0}`;
  const record = durations.get(key) ?? {
    functionName,
    scriptUrlIdentity: identity,
    lineNumber: frame.lineNumber ?? null,
    columnNumber: frame.columnNumber ?? null,
    selfSampledMs: 0,
    samples: 0,
  };
  record.selfSampledMs += microseconds / 1000;
  record.samples += 1;
  durations.set(key, record);
}

function summarizeSanitizedProfile(profile) {
  assert.ok(Array.isArray(profile.nodes) && Array.isArray(profile.samples) && Array.isArray(profile.timeDeltas));
  assert.equal(profile.samples.length, profile.timeDeltas.length, "complete profile sample and time-delta counts must agree");
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const durations = new Map();
  let sampledMicros = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const microseconds = profile.timeDeltas[index];
    assert.ok(Number.isFinite(microseconds) && microseconds >= 0, "profile time deltas must be finite nonnegative microseconds");
    sampledMicros += microseconds;
    const node = nodes.get(profile.samples[index]);
    if (node) addSampledFrame(durations, node.callFrame ?? {}, microseconds);
  }
  const topFunctions = [...durations.values()]
    .map((entry) => ({ ...entry, selfSampledMs: Number(entry.selfSampledMs.toFixed(3)) }))
    .sort((left, right) => right.selfSampledMs - left.selfSampledMs)
    .slice(0, 40);
  return {
    sampleCount: profile.samples.length,
    totalSampledMs: Number((sampledMicros / 1000).toFixed(3)),
    topFunctions,
  };
}

async function main() {
  const [rawBytes, coreBytes, manifestBytes, sourceFreezeManifestBytes] = await Promise.all([
    readFile(rawPath),
    readFile(corePath),
    readFile(manifestPath),
    readFile(sourceFreezeManifestPath),
  ]);
  assert.equal(sha256(rawBytes), expected.rawProfileSha256, "raw full-profile artifact pin mismatch");
  assert.equal(sha256(coreBytes), expected.coreAttributionSha256, "core attribution evidence pin mismatch");
  assert.equal(sha256(manifestBytes), expected.exportManifestSha256, "source-map export manifest pin mismatch");
  assert.equal(sha256(sourceFreezeManifestBytes), expected.sourceFreezeManifestSha256, "source freeze manifest pin mismatch");
  const raw = JSON.parse(rawBytes.toString("utf8"));
  const core = JSON.parse(coreBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceFreezeManifest = JSON.parse(sourceFreezeManifestBytes.toString("utf8"));
  verifyMobileExportManifestEnvelope(manifest, manifestBytes, expected.exportManifestSha256, "offline profile recovery");
  assert.equal(raw.classification, "DIAGNOSTIC_ONLY");
  assert.equal(raw.performanceDistributionEligible, false);
  assert.equal(raw.bundleSha256, expected.bundleSha256);
  assert.equal(core.bundleSha256, expected.bundleSha256);
  assert.equal(core.fullCpuProfileCapture?.status, "CAPTURED");
  assert.equal(core.fullCpuProfileCapture?.artifact, "phone-render-core-v8-full-after-500-unmounted.json");
  assert.equal(sourceFreezeManifest.status, "FROZEN_CURRENT_SOURCE_FOR_STATIC_WEB_EXPORT");
  assert.equal(sourceFreezeManifest.sourceDigest, expected.sourceFreezeDigest);
  assert.equal(sourceFreezeManifest.fileCount, 336);
  assert.equal(raw.profile?.nodes?.length, raw.completeness?.nodeCount);
  assert.equal(raw.profile?.samples?.length, raw.completeness?.sampleCount);
  assert.equal(raw.profile?.timeDeltas?.length, raw.completeness?.timeDeltaCount);

  const sourceMapEvidence = core.sourceMapEvidence;
  assert.equal(sourceMapEvidence?.enabled, true);
  assert.equal(sourceMapEvidence.bundleSha256, expected.bundleSha256);
  verifySourceMapBundleEvidence(sourceMapEvidence, manifest);
  const profile = summarizeSanitizedProfile(raw.profile);
  const mobileRequire = createRequire(resolve("apps/kcoder-studio/mobile/package.json"));
  const traceMapping = mobileRequire("@jridgewell/trace-mapping");
  const traceMaps = new Map();
  const mapStatuses = new Map();
  const mappedBySource = new Map();
  const frozenFilesByDigest = new Map();
  for (const entry of sourceFreezeManifest.files) {
    const list = frozenFilesByDigest.get(entry.sha256) ?? [];
    list.push(entry);
    frozenFilesByDigest.set(entry.sha256, list);
  }
  const frozenSourceEntriesVerified = new Set();
  for (const frame of profile.topFunctions) {
    const binding = resolveScriptMapBinding(frame.scriptUrlIdentity, sourceMapEvidence.mapFiles.map((entry) => entry.path));
    if (binding.status !== "EXACT_BUNDLE_PATH_MATCH") {
      mapStatuses.set(binding.status, (mapStatuses.get(binding.status) ?? 0) + 1);
      frame.sourceMapStatus = binding.status;
      frame.originalPosition = null;
      continue;
    }
    const mapPath = binding.mapPath;
    if (!traceMaps.has(mapPath)) {
      const mapEntry = sourceMapEvidence.mapFiles.find((entry) => entry.path === mapPath);
      const mapBytes = await readVerifiedMobileExportFile(bundleRoot, mapEntry, "offline profile source map");
      const mapJson = JSON.parse(mapBytes.toString("utf8"));
      assert.equal(mapJson.version, 3);
      assert.ok(Array.isArray(mapJson.sources) && Array.isArray(mapJson.sourcesContent));
      assert.equal(mapJson.sources.length, mapJson.sourcesContent.length);
      traceMaps.set(mapPath, { traceMap: new traceMapping.TraceMap(mapJson, mapPath), mapJson });
    }
    const { traceMap, mapJson } = traceMaps.get(mapPath);
    const originalPosition = Number.isInteger(frame.lineNumber) && frame.lineNumber >= 0
      && Number.isInteger(frame.columnNumber) && frame.columnNumber >= 0
      ? traceMapping.originalPositionFor(traceMap, {
          line: frame.lineNumber + 1,
          column: frame.columnNumber,
          bias: traceMapping.GREATEST_LOWER_BOUND,
        })
      : null;
    frame.sourceMapStatus = "EXACT_BUNDLE_PATH_MATCH";
    const sourceIndexes = originalPosition?.source
      ? mapJson.sources.flatMap((source, index) => source === originalPosition.source ? [index] : [])
      : [];
    if (sourceIndexes.length !== 1 || !Number.isInteger(originalPosition.line)) {
      const status = sourceIndexes.length > 1 ? "AMBIGUOUS_SOURCE_MAP_ENTRY" : "NO_UNIQUE_SOURCE_MAP_POSITION";
      frame.originalPosition = { status, source: null, line: null, column: null, name: null };
      mapStatuses.set(status, (mapStatuses.get(status) ?? 0) + 1);
      continue;
    }
    const sourceIndex = sourceIndexes[0];
    const sourceContent = mapJson.sourcesContent[sourceIndex];
    if (typeof sourceContent !== "string") {
      frame.originalPosition = { status: "SOURCE_CONTENT_MISSING", source: null, line: null, column: null, name: null };
      mapStatuses.set("SOURCE_CONTENT_MISSING", (mapStatuses.get("SOURCE_CONTENT_MISSING") ?? 0) + 1);
      continue;
    }
    const sourceContentSha256 = sha256(Buffer.from(sourceContent));
    const frozenMatches = frozenFilesByDigest.get(sourceContentSha256) ?? [];
    if (frozenMatches.length !== 1) {
      const status = frozenMatches.length === 0 ? "NO_EXACT_FROZEN_SOURCE_CONTENT_MATCH" : "AMBIGUOUS_FROZEN_SOURCE_CONTENT_MATCH";
      frame.originalPosition = { status, source: null, line: null, column: null, name: null };
      mapStatuses.set(status, (mapStatuses.get(status) ?? 0) + 1);
      continue;
    }
    const frozenEntry = frozenMatches[0];
    const frozenFilePath = resolve(sourceFreezeRoot, frozenEntry.path);
    const relativeFrozenPath = relative(sourceFreezeRoot, frozenFilePath);
    assert.ok(relativeFrozenPath && relativeFrozenPath !== ".." && !relativeFrozenPath.startsWith(`..${sep}`), "frozen source path must stay inside its pinned source root");
    if (!frozenSourceEntriesVerified.has(frozenEntry.path)) {
      const info = await lstat(frozenFilePath);
      assert.ok(info.isFile() && !info.isSymbolicLink(), "matched frozen source must be a regular file");
      assert.equal(info.size, frozenEntry.size, "matched frozen source size must agree with its manifest");
      const frozenBytes = await readFile(frozenFilePath);
      assert.equal(sha256(frozenBytes), frozenEntry.sha256, "matched frozen source bytes must agree with its manifest");
      assert.equal(sha256(frozenBytes), sourceContentSha256, "source-map content must exactly match frozen source bytes");
      frozenSourceEntriesVerified.add(frozenEntry.path);
    }
    frame.originalPosition = {
      status: "EXACT_FROZEN_SOURCE_CONTENT_SHA_MATCH",
      source: frozenEntry.path,
      sourceContentSha256,
      line: originalPosition.line,
      column: originalPosition.column,
      name: originalPosition.name ?? null,
    };
    mapStatuses.set("EXACT_FROZEN_SOURCE_CONTENT_SHA_MATCH", (mapStatuses.get("EXACT_FROZEN_SOURCE_CONTENT_SHA_MATCH") ?? 0) + 1);
    {
      const record = mappedBySource.get(frozenEntry.path) ?? { selfSampledMs: 0, functionCount: 0 };
      record.selfSampledMs += frame.selfSampledMs;
      record.functionCount += 1;
      mappedBySource.set(frozenEntry.path, record);
    }
  }
  const longTaskCount = Array.isArray(core.burst?.longTasks) ? core.burst.longTasks.length : null;
  const output = {
    schemaVersion: 1,
    classification: "DIAGNOSTIC_ONLY_OFFLINE_RECOVERY",
    performanceSample: false,
    performanceDistributionEligible: false,
    source: raw.source,
    requestedMessages: raw.requestedMessages,
    panelState: raw.panelState,
    inputPins: {
      rawProfileSha256: expected.rawProfileSha256,
      coreAttributionSha256: expected.coreAttributionSha256,
      exportManifestSha256: expected.exportManifestSha256,
      bundleSha256: expected.bundleSha256,
      sourceFreezeManifestSha256: expected.sourceFreezeManifestSha256,
      sourceFreezeDigest: expected.sourceFreezeDigest,
      sourceMapEvidenceDigest: sha256(Buffer.from(JSON.stringify(sourceMapEvidence))),
    },
    capture: {
      profileNodeCount: raw.completeness.nodeCount,
      sampleCount: profile.sampleCount,
      timeDeltaCount: raw.completeness.timeDeltaCount,
      totalSampledMs: profile.totalSampledMs,
      cdpProfileDurationMs: raw.timestamps.cdpDurationMs,
      coreBurstStatus: core.coreBurstStatus,
      pageClockAlignmentPersisted: raw.timestamps.pageClockAlignment !== null,
      longTaskRecordsInCoreEvidence: longTaskCount,
      longTaskCorrelation: "UNAVAILABLE: captured full-profile artifact persisted no page/CDP clock anchors; do not infer temporal overlap",
    },
    mapping: {
      method: "exact captured scriptUrlIdentity bundlePath -> exact recorded .map inventory entry -> TraceMap position -> unique sourceContent SHA match to pinned 336-file freeze; no path, basename, or suffix fallback",
      mappedTopFunctionSourceCount: mappedBySource.size,
      verifiedFrozenSourceFileCount: frozenSourceEntriesVerified.size,
      topFunctionFrameStatusCounts: Object.fromEntries([...mapStatuses.entries()].sort(([left], [right]) => left.localeCompare(right))),
      mappedTopFunctionsBySource: [...mappedBySource.entries()]
        .map(([source, value]) => ({ source, functionCount: value.functionCount, selfSampledMs: Number(value.selfSampledMs.toFixed(3)) }))
        .sort((left, right) => right.selfSampledMs - left.selfSampledMs),
      topFunctions: profile.topFunctions,
    },
  };
  const outputBytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, outputBytes, { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ outputPath, outputSha256: sha256(outputBytes), classification: output.classification, sampleCount: output.capture.sampleCount, totalSampledMs: output.capture.totalSampledMs, cdpProfileDurationMs: output.capture.cdpProfileDurationMs, mappedTopFunctionSourceCount: output.mapping.mappedTopFunctionSourceCount, mappingStatusCounts: output.mapping.topFunctionFrameStatusCounts, longTaskCorrelation: output.capture.longTaskCorrelation }) + "\n");
}

await main();
