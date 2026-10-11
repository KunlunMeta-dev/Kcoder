import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { repoRoot, runE2E } from "../harness/run-context.mjs";
import { readVerifiedMobileExportFile, verifyMobileExportManifestEnvelope } from "../harness/mobile-web-export-input.mjs";
import {
  mapGeneratedProfilePosition,
  resolveScriptMapBinding,
  verifySourceMapBundleEvidence,
} from "../harness/render-profile-attribution-contract.mjs";

const PIN = Object.freeze({
  originalRun: "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-render-profile.e2e.mjs/20261009-091218.874Z",
  originalRunManifestSha256: "9ea86a407c7c95b41af9c5544f552a8d494c5454b2747e4558bc8561bfe36292",
  originalResultSha256: "56a9f5c76bc6a199156f11a85a387a55f66d9b7fc2b71564cf75d26997c480d3",
  unmountedProfileSha256: "88f13a163fe311a1d4059dd7aff670457679494d3308b5dec4a8f151a66a2764",
  mountedHiddenProfileSha256: "3f6f7b274e496940c7b1c6881245a64e4938615b5898f072393eeabe344b1fce",
  originalDiagnosticSha256: "0fbecd2ee7b2776de7b2f596ab31aa8383aa0193d808ac4f288784e0abee0acd",
  exportRoot: "target/private-phone-ux-implementation/mobile-web-export-current336-source-maps-20261009",
  exportManifestSha256: "7641ceac87eb5a611388d0366a2331f2b1a54a06e4674be69f1247329aa6e03f",
  exportProvenanceSha256: "d6b392e700026596e2dbdb4273b3c5c7851b90b466b21172b2db1667fe7f24a5",
  bundleSha256: "f33e10d2b686af7fb03228208ce06e177b54da4eecc700639d6abb18fe248458",
  sourceMapPath: "_expo/static/js/web/entry-67946c84e825296e54a3738bb98ead33.js.map",
  sourceMapSha256: "14f15165311df4112d561775b937f165b8bea8c8a52aa7833f0e99fc1ccd8a01",
  sourceFreezeRoot: "target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104",
  sourceMetadataSha256: "9735c1cf961031e235a2811a6f173794b1946d4f4d9282d50566a686c0fb9d3f",
  sourceManifestSha256: "604d8915c48d56ac58404990183072b73db0c63abd68821a974b311b2f4924a5",
  sourceSha256MapSha256: "d78b6de305d13b7a9ce24798dc8cbd5a9c8afdeae7cc133111634259d97fb916",
  sourceTreeSha256: "effa93130e74c958a4fd6639e79efab1d1a8bc78bcd18648aa9f70fe26f2b233",
  dependencyRoot: "target/private-phone-ux-implementation/mobile-dependency-input-pinned",
  dependencySourceTreeSha256: "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c",
  dependencyCopiedTreeSha256: "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29",
  dependenciesCopiedFileCount: 52252,
});

const PROFILE_FILES = Object.freeze([
  { panelState: "unmounted", name: "phone-render-core-attribution-after-500-unmounted.json", sha256: PIN.unmountedProfileSha256 },
  { panelState: "mounted-hidden", name: "phone-render-core-attribution-after-500-mounted-hidden.json", sha256: PIN.mountedHiddenProfileSha256 },
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function safeRelativePath(value, label) {
  assert.equal(typeof value, "string", `${label} path must be a string`);
  assert.ok(value.length > 0 && !value.startsWith("/") && !value.includes("\\"), `${label} path must be relative`);
  const parts = value.split("/");
  assert.ok(parts.every((part) => part && part !== "." && part !== ".."), `${label} path must not traverse`);
  return parts;
}

async function assertCanonicalDirectory(path, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), resolve(path), `${label} must have a canonical path`);
}

async function readNoSymlinkFile(root, pathRelative, label) {
  const parts = safeRelativePath(pathRelative, label);
  let path = resolve(root);
  for (const part of parts) {
    path = resolve(path, part);
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), `${label} cannot follow a symlink`);
  }
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  return { path, bytes: await readFile(path) };
}

async function readPinnedJson(root, relativePath, expectedSha256, label) {
  const { bytes, path } = await readNoSymlinkFile(root, relativePath, label);
  assert.equal(sha256(bytes), expectedSha256, `${label} bytes changed`);
  return { bytes, path, value: JSON.parse(bytes.toString("utf8")) };
}

async function verifyOriginalRun() {
  const runRoot = resolve(repoRoot, PIN.originalRun);
  await assertCanonicalDirectory(runRoot, "original profile RunContext root");
  const [runManifest, result] = await Promise.all([
    readPinnedJson(runRoot, "manifest.json", PIN.originalRunManifestSha256, "original RunContext manifest"),
    readPinnedJson(runRoot, "artifacts/result.json", PIN.originalResultSha256, "original RunContext result"),
  ]);
  assert.equal(runManifest.value.status, "passed", "original RunContext should have completed cleanup successfully");
  assert.equal(result.value.status, "passed", "original RunContext result status changed");
  assert.deepEqual(result.value.cleanupErrors, [], "original RunContext recorded cleanup errors");
  const profiles = [];
  for (const entry of PROFILE_FILES) {
    const profile = await readPinnedJson(
      runRoot,
      `artifacts/${entry.name}`,
      entry.sha256,
      `original ${entry.panelState} profile`,
    );
    assert.equal(profile.value.sourceAttributionStatus, "UNRESOLVED", "original unresolved state must remain intact");
    assert.equal(profile.value.sourceMapAttributionError, "mapGeneratedProfilePosition is not defined", "original failure cause changed");
    assert.equal(profile.value.classification, "DIAGNOSTIC_ONLY");
    assert.equal(profile.value.performanceSample, false);
    profiles.push({ ...entry, value: profile.value });
  }
  const diagnostic = await readPinnedJson(
    runRoot,
    "artifacts/phone-render-core-attribution-diagnostic.json",
    PIN.originalDiagnosticSha256,
    "original diagnostic aggregate",
  );
  return { runRoot, manifest: runManifest.value, result: result.value, profiles, diagnostic: diagnostic.value };
}

async function verifyFrozenInputs() {
  const exportRoot = resolve(repoRoot, PIN.exportRoot);
  await assertCanonicalDirectory(exportRoot, "pinned source-map export package");
  await assertCanonicalDirectory(resolve(exportRoot, "bundle"), "pinned source-map bundle root");
  const [manifest, provenance] = await Promise.all([
    readPinnedJson(exportRoot, "export-manifest.json", PIN.exportManifestSha256, "source-map export manifest"),
    readPinnedJson(exportRoot, "provenance.json", PIN.exportProvenanceSha256, "source-map export provenance"),
  ]);
  verifyMobileExportManifestEnvelope(manifest.value, manifest.bytes, PIN.exportManifestSha256, "offline source-map recovery");
  verifySourceMapBundleEvidence(manifest.value.sourceMapEvidence, manifest.value);
  assert.equal(manifest.value.bundleSha256, PIN.bundleSha256);
  assert.equal(manifest.value.bundleFileCount, 38);
  assert.equal(provenance.value.status, "complete");
  assert.equal(provenance.value.sourceTreeSha256, PIN.sourceTreeSha256);
  assert.equal(provenance.value.frozenSourceEntryCount, 336);
  assert.equal(provenance.value.frozenSourceManifestSha256, PIN.sourceManifestSha256);
  assert.equal(provenance.value.dependencySourceTreeSha256, PIN.dependencySourceTreeSha256);
  assert.equal(provenance.value.dependencyOwnedTreeSha256, PIN.dependencyCopiedTreeSha256);
  assert.equal(provenance.value.bundleSha256, PIN.bundleSha256);
  assert.equal(provenance.value.bundleManifest, resolve(exportRoot, "export-manifest.json"));
  assert.equal(provenance.value.bundlePath, resolve(exportRoot, "bundle"));
  assert.equal(provenance.value.credentialStateCopied, false);
  assert.equal(provenance.value.exporterSourceUnchanged, true);
  assert.equal(provenance.value.snapshotCopyMatchesSource, true);
  assert.equal(provenance.value.snapshotUnchangedDuringExport, true);
  assert.equal(manifest.value.dependencyProvenance.sourceTreeSha256Before, PIN.dependencySourceTreeSha256);
  assert.equal(manifest.value.dependencyProvenance.sourceTreeSha256After, PIN.dependencySourceTreeSha256);
  assert.equal(manifest.value.dependencyProvenance.copiedTreeSha256, PIN.dependencyCopiedTreeSha256);
  assert.equal(manifest.value.dependencyProvenance.copiedFileCount, PIN.dependenciesCopiedFileCount);
  assert.equal(manifest.value.dependencyProvenance.copiedSymlinks, false);

  const sourceFreeze = resolve(repoRoot, PIN.sourceFreezeRoot);
  await assertCanonicalDirectory(sourceFreeze, "pinned current336 source freeze");
  await assertCanonicalDirectory(resolve(sourceFreeze, "source"), "pinned current336 source tree");
  const [metadata, sourceManifest, shaMap] = await Promise.all([
    readPinnedJson(sourceFreeze, "metadata.json", PIN.sourceMetadataSha256, "current336 source metadata"),
    readPinnedJson(sourceFreeze, "source-manifest.json", PIN.sourceManifestSha256, "current336 source manifest"),
    readPinnedJson(sourceFreeze, "sha256.json", PIN.sourceSha256MapSha256, "current336 SHA map"),
  ]);
  assert.equal(metadata.value.status, "CURRENT_SOURCE_FROZEN_FOR_STATIC_EXPORT");
  assert.equal(metadata.value.sourceDigest, PIN.sourceTreeSha256);
  assert.equal(metadata.value.sourceFiles, 336);
  assert.equal(metadata.value.sourceManifestSha256, PIN.sourceManifestSha256);
  assert.equal(metadata.value.sha256MapSha256, PIN.sourceSha256MapSha256);
  assert.equal(sourceManifest.value.status, "FROZEN_CURRENT_SOURCE_FOR_STATIC_WEB_EXPORT");
  assert.equal(sourceManifest.value.sourceDigest, PIN.sourceTreeSha256);
  assert.equal(sourceManifest.value.fileCount, 336);
  assert.equal(sourceManifest.value.noCredentialStateCopied, true);
  assert.equal(sourceManifest.value.files.length, 336);
  assert.equal(Object.keys(shaMap.value).length, 336);
  assert.deepEqual(Object.keys(shaMap.value).sort(), sourceManifest.value.files.map((entry) => entry.path).sort());
  for (const entry of sourceManifest.value.files) {
    assert.equal(shaMap.value[entry.path], entry.sha256, "source manifest and SHA map differ");
  }
  const dependencyRoot = resolve(repoRoot, PIN.dependencyRoot);
  await assertCanonicalDirectory(dependencyRoot, "pinned Mobile dependency copy");
  const mapFileEntries = manifest.value.bundleFiles.filter((entry) => entry.path.endsWith(".map"));
  assert.deepEqual(mapFileEntries.map((entry) => ({ path: entry.path, sha256: entry.sha256 })), [
    { path: PIN.sourceMapPath, sha256: PIN.sourceMapSha256 },
  ]);
  for (const entry of manifest.value.bundleFiles) {
    await readVerifiedMobileExportFile(resolve(exportRoot, "bundle"), entry, "source-map bundle asset");
  }
  return {
    exportRoot,
    bundleRoot: resolve(exportRoot, "bundle"),
    manifest: manifest.value,
    provenance: provenance.value,
    sourceRoot: resolve(sourceFreeze, "source"),
    sourceManifest: sourceManifest.value,
    sourceShaMap: shaMap.value,
    dependencyRoot,
  };
}

function loadPinnedTraceMapping(dependencyRoot) {
  const mobileRequire = createRequire(resolve(repoRoot, "apps/kcoder-studio/mobile/package.json"));
  const packages = [
    { name: "@jridgewell/trace-mapping", version: "0.3.31", entry: "dist/trace-mapping.umd.js" },
    { name: "@jridgewell/resolve-uri", version: "3.1.2", entry: "dist/resolve-uri.umd.js" },
    { name: "@jridgewell/sourcemap-codec", version: "1.5.5", entry: "dist/sourcemap-codec.umd.js" },
  ];
  const evidence = [];
  for (const pkg of packages) {
    const resolvedEntry = mobileRequire.resolve(pkg.name);
    const liveEntry = readFileSync(resolvedEntry);
    const packageJsonPath = resolve(dirname(resolvedEntry), "../package.json");
    const livePackage = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const pinnedPackageRoot = resolve(dependencyRoot, ...pkg.name.split("/"));
    const pinnedEntry = readFileSync(resolve(pinnedPackageRoot, pkg.entry));
    const pinnedPackage = JSON.parse(readFileSync(resolve(pinnedPackageRoot, "package.json"), "utf8"));
    assert.equal(livePackage.version, pkg.version, `${pkg.name} live version differs from the frozen dependency pin`);
    assert.equal(pinnedPackage.version, pkg.version, `${pkg.name} copied version differs from the frozen dependency pin`);
    assert.equal(sha256(liveEntry), sha256(pinnedEntry), `${pkg.name} loaded entry differs from the frozen dependency copy`);
    evidence.push({ name: pkg.name, version: pkg.version, entrySha256: sha256(pinnedEntry), loadedEntryMatchesPinnedCopy: true });
  }
  return { traceMapping: mobileRequire("@jridgewell/trace-mapping"), packages: evidence };
}

function sourceContentHash(traceMap, originalSource, traceMapping) {
  const content = traceMapping.sourceContentFor(traceMap, originalSource, true);
  if (typeof content !== "string") return { status: "NO_SOURCE_CONTENT", content: null, sha256: null, size: null };
  const bytes = Buffer.from(content, "utf8");
  return { status: "SOURCE_CONTENT_HASHED", content, sha256: sha256(bytes), size: bytes.length };
}

function collectProfileFrames(profiles, traceMap, traceMapping, mapPath) {
  const frames = [];
  for (const profile of profiles) {
    const value = profile.value;
    for (let index = 0; index < (value.profile?.topFunctions ?? []).length; index += 1) {
      frames.push({
        id: `${profile.panelState}:top:${index}`,
        panelState: profile.panelState,
        kind: "top-function",
        weight: value.profile.topFunctions[index].samples,
        sampledMs: value.profile.topFunctions[index].selfSampledMs,
        frame: value.profile.topFunctions[index],
      });
    }
    for (let taskIndex = 0; taskIndex < (value.profile?.longTaskStackAttribution ?? []).length; taskIndex += 1) {
      const task = value.profile.longTaskStackAttribution[taskIndex];
      for (let stackIndex = 0; stackIndex < (task.topStacks ?? []).length; stackIndex += 1) {
        const stack = task.topStacks[stackIndex];
        for (let frameIndex = 0; frameIndex < (stack.stack ?? []).length; frameIndex += 1) {
          frames.push({
            id: `${profile.panelState}:long-task:${taskIndex}:stack:${stackIndex}:frame:${frameIndex}`,
            panelState: profile.panelState,
            kind: "long-task-overlap-stack",
            weight: stack.sampleCount,
            sampledMs: stack.sampledMs,
            frame: stack.stack[frameIndex],
          });
        }
      }
    }
  }

  for (const entry of frames) {
    const frame = entry.frame;
    const binding = resolveScriptMapBinding(frame?.scriptUrlIdentity, [mapPath]);
    entry.bindingStatus = binding.status;
    entry.contentMatch = null;
    entry.position = null;
    if (binding.status !== "EXACT_BUNDLE_PATH_MATCH") continue;
    if (frame.scriptPath !== `/${binding.generatedPath}`) {
      entry.bindingStatus = "PROFILE_SCRIPT_PATH_MISMATCH";
      continue;
    }
    const mapped = mapGeneratedProfilePosition(traceMap, frame, traceMapping);
    entry.position = {
      status: mapped.status,
      sourcePathStatus: mapped.sourcePathStatus ?? null,
      line: mapped.line,
      column: mapped.column,
      name: mapped.name,
    };
    if (mapped.status !== "MAPPED" && mapped.status !== "UNSCOPED_ABSOLUTE_SOURCE_REDACTED") continue;
    const original = traceMapping.originalPositionFor(traceMap, {
      line: frame.lineNumber + 1,
      column: frame.columnNumber,
      bias: traceMapping.GREATEST_LOWER_BOUND,
    });
    if (!original?.source || !Number.isInteger(original.line)) continue;
    const content = sourceContentHash(traceMap, original.source, traceMapping);
    entry.contentMatch = {
      status: content.status,
      sha256: content.sha256,
      size: content.size,
    };
  }
  return frames;
}

async function scanDependencyContentCandidates(root, wantedHashes, wantedSizes) {
  const matches = new Map([...wantedHashes].map((digest) => [digest, []]));
  const pending = [root];
  let inspectedEntries = 0;
  let contentReads = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      inspectedEntries += 1;
      const absolute = resolve(directory, child.name);
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), "pinned dependency tree unexpectedly contains a symlink");
      if (info.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      assert.ok(info.isFile(), "pinned dependency tree contains a non-regular entry");
      if (!wantedSizes.has(info.size)) continue;
      contentReads += 1;
      const bytes = await readFile(absolute);
      const digest = sha256(bytes);
      if (matches.has(digest)) matches.get(digest).push(relative(root, absolute).split(sep).join("/"));
    }
  }
  for (const paths of matches.values()) paths.sort((a, b) => a.localeCompare(b));
  return { matches, inspectedEntries, contentReads };
}

async function resolveContentMatches(frames, frozen, context) {
  const contentByHash = new Map();
  for (const entry of frames) {
    const content = entry.contentMatch;
    if (content?.status !== "SOURCE_CONTENT_HASHED" || !content.sha256) continue;
    contentByHash.set(content.sha256, { size: content.size });
  }
  const wantedHashes = new Set(contentByHash.keys());
  const wantedSizes = new Set([...contentByHash.values()].map((entry) => entry.size));
  if (wantedHashes.size === 0) {
    throw new Error("no verified source-map sourceContent hashes were available for exact candidate matching");
  }
  const appCandidates = new Map([...wantedHashes].map((digest) => [digest, []]));
  const manifestByDigest = new Map();
  for (const entry of frozen.sourceManifest.files) {
    if (!wantedHashes.has(entry.sha256)) continue;
    const candidates = manifestByDigest.get(entry.sha256) ?? [];
    candidates.push(entry);
    manifestByDigest.set(entry.sha256, candidates);
  }
  for (const [digest, entries] of manifestByDigest) {
    for (const entry of entries) {
      const { bytes } = await readNoSymlinkFile(frozen.sourceRoot, entry.path, "matched current336 source file");
      assert.equal(bytes.length, entry.size, "matched source content size differs from current336 freeze");
      assert.equal(sha256(bytes), digest, "matched source content differs from current336 SHA inventory");
      appCandidates.get(digest).push(entry.path);
    }
  }
  const dependencyScan = await scanDependencyContentCandidates(frozen.dependencyRoot, wantedHashes, wantedSizes);
  const resolved = new Map();
  for (const digest of wantedHashes) {
    const candidates = [
      ...appCandidates.get(digest).map((path) => ({ class: "application", path })),
      ...dependencyScan.matches.get(digest).map((path) => ({ class: "dependency", path })),
    ];
    const unique = new Map(candidates.map((candidate) => [`${candidate.class}\0${candidate.path}`, candidate]));
    const matches = [...unique.values()].sort((a, b) => `${a.class}/${a.path}`.localeCompare(`${b.class}/${b.path}`));
    if (matches.length === 1) resolved.set(digest, { status: "UNIQUE_EXACT_CONTENT_MATCH", ...matches[0] });
    else if (matches.length > 1) resolved.set(digest, {
      status: "AMBIGUOUS_EXACT_CONTENT_MATCH",
      candidateCount: matches.length,
      candidateClasses: [...new Set(matches.map((item) => item.class))].sort(),
    });
    else resolved.set(digest, { status: "NO_EXACT_CONTENT_MATCH" });
  }
  for (const entry of frames) {
    const content = entry.contentMatch;
    if (content?.status !== "SOURCE_CONTENT_HASHED" || !content.sha256) {
      entry.attribution = { category: classifyHostFrame(entry.frame), status: "UNRESOLVED_NO_SOURCE_CONTENT" };
      continue;
    }
    const match = resolved.get(content.sha256);
    if (match?.status === "UNIQUE_EXACT_CONTENT_MATCH") {
      entry.attribution = {
        category: match.class,
        status: match.status,
        verifiedPath: match.path,
        sourceContentSha256: content.sha256,
      };
    } else {
      entry.attribution = {
        category: "unknown",
        status: match?.status ?? "NO_EXACT_CONTENT_MATCH",
        candidateCount: match?.candidateCount ?? 0,
        sourceContentSha256: content.sha256,
      };
    }
  }
  await context.writeArtifactJson("offline-source-content-match-index.json", {
    schemaVersion: 1,
    uniqueContentHashCount: resolved.size,
    dependencyEntriesInspectedForCandidateMatches: dependencyScan.inspectedEntries,
    dependencyFilesReadBecauseSizeMatched: dependencyScan.contentReads,
    fullDependencyTreeRehashPerformed: false,
    dependencyTreePin: {
      sourceTreeSha256: PIN.dependencySourceTreeSha256,
      copiedTreeSha256: PIN.dependencyCopiedTreeSha256,
      copiedFileCount: PIN.dependenciesCopiedFileCount,
      provenanceSource: "pinned export manifest/provenance; selected candidates independently byte-verified",
    },
    matches: [...resolved.entries()].map(([sourceContentSha256, match]) => ({ sourceContentSha256, ...match })),
  });
  return resolved;
}

function classifyHostFrame(frame) {
  if (frame?.functionName === "(program)") return "program-runtime-or-profiler";
  if (frame?.functionName === "(idle)") return "idle";
  if (frame?.functionName === "(garbage collector)") return "garbage-collection";
  return "unknown";
}

function aggregateProfileTopFunctions(profiles, framesById) {
  return profiles.map((profile) => {
    const value = profile.value;
    const top = value.profile.topFunctions ?? [];
    assert.equal(top.length, 40, `${profile.panelState} original CPU profile must retain exactly the top 40 functions`);
    const aggregate = new Map();
    let listedSamples = 0;
    let listedMs = 0;
    for (let index = 0; index < top.length; index += 1) {
      const frame = top[index];
      const evidence = framesById.get(`${profile.panelState}:top:${index}`);
      const category = evidence?.attribution?.category ?? classifyHostFrame(frame);
      const current = aggregate.get(category) ?? { category, samples: 0, selfSampledMs: 0 };
      current.samples += frame.samples;
      current.selfSampledMs += frame.selfSampledMs;
      aggregate.set(category, current);
      listedSamples += frame.samples;
      listedMs += frame.selfSampledMs;
    }
    const totalSamples = value.profile.sampleCount;
    const totalSampledMs = value.profile.totalSampledMs;
    return {
      panelState: profile.panelState,
      classification: "DIAGNOSTIC_ONLY",
      topFunctionsLimit: 40,
      topFunctionsListed: top.length,
      totalProfileSamples: totalSamples,
      totalProfileSampledMs: totalSampledMs,
      listedSamples,
      listedSelfSampledMs: Number(listedMs.toFixed(3)),
      omittedSamples: Math.max(0, totalSamples - listedSamples),
      omittedSampledMs: Number(Math.max(0, totalSampledMs - listedMs).toFixed(3)),
      omittedAttribution: "unknown-top-functions-truncated",
      aggregateTop40: [...aggregate.values()].map((item) => ({ ...item, selfSampledMs: Number(item.selfSampledMs.toFixed(3)) }))
        .sort((left, right) => right.selfSampledMs - left.selfSampledMs),
      profileWallTimeMs: value.profile.profileWallTimeMs,
      profileWallTimeInterpretation: "Profiler collection window, not render duration",
      originalSourceAttributionStatus: value.sourceAttributionStatus,
      originalSourceAttributionError: value.sourceMapAttributionError,
    };
  });
}

function sanitizeFrame(frame, evidence) {
  const identity = frame?.scriptUrlIdentity;
  return {
    functionName: frame?.functionName ?? null,
    samples: frame?.samples ?? null,
    selfSampledMs: frame?.selfSampledMs ?? null,
    lineNumber: Number.isInteger(frame?.lineNumber) ? frame.lineNumber : null,
    columnNumber: Number.isInteger(frame?.columnNumber) ? frame.columnNumber : null,
    scriptIdentityStatus: identity?.status ?? "NO_SCRIPT_IDENTITY",
    bundlePath: identity?.bundlePath ?? null,
    exactMapBindingStatus: evidence?.bindingStatus ?? null,
    mappedPosition: evidence?.position ?? null,
    attribution: evidence?.attribution ?? { category: classifyHostFrame(frame), status: "UNRESOLVED" },
  };
}

function summarizeLongTaskEvidence(profiles) {
  return profiles.map((profile) => ({
    panelState: profile.panelState,
    profilerOverlapStacks: (profile.value.profile?.longTaskStackAttribution ?? []).map((task) => {
      const retainedStackSamples = (task.topStacks ?? []).reduce((sum, stack) => sum + (stack.sampleCount ?? 0), 0);
      const retainedStackMs = (task.topStacks ?? []).reduce((sum, stack) => sum + (stack.sampledMs ?? 0), 0);
      return {
        status: task.status,
        longTaskStartTimeMs: task.longTask?.startTimeMs ?? null,
        longTaskDurationMs: task.longTask?.durationMs ?? null,
        overlappingProfileSamples: task.sampleCount,
        overlappingProfileSampledMs: task.sampledMs,
        retainedTopStacks: task.topStacks?.length ?? 0,
        retainedStackSamples,
        retainedStackSampledMs: Number(retainedStackMs.toFixed(3)),
        omittedOverlapSamples: Math.max(0, (task.sampleCount ?? 0) - retainedStackSamples),
        omittedOverlapSampledMs: Number(Math.max(0, (task.sampledMs ?? 0) - retainedStackMs).toFixed(3)),
        retentionBoundary: "original capture retained only topStacks[0..12]",
      };
    }),
    entries: (profile.value.burst?.longTasks ?? []).map((task) => ({
      startTimeMs: task.startTimeMs,
      durationMs: task.durationMs,
      name: task.name ?? null,
      attributionCount: Array.isArray(task.attribution) ? task.attribution.length : 0,
      sourceKinds: (task.attribution ?? []).map((entry) =>
        typeof entry.containerSrcPath === "string" && entry.containerSrcPath.includes("/task/backend4a/mock-active-session")
          ? "RunContext-owned mock task route"
          : "unresolved-source",
      ),
    })),
    longAnimationFrames: (profile.value.burst?.longAnimationFrames?.entries ?? []).map((entry) => ({
      startTimeMs: entry.startTimeMs,
      durationMs: entry.durationMs,
      blockingDurationMs: entry.blockingDurationMs,
      renderStartMs: entry.renderStartMs,
      scripts: (entry.scripts ?? []).map((script) => ({
        startTimeMs: script.startTimeMs,
        durationMs: script.durationMs,
        executionStartMs: script.executionStartMs,
        sourceFunctionName: script.sourceFunctionName || null,
        sourceCharPosition: script.sourceCharPosition,
        invoker: script.invoker ?? null,
        invokerType: script.invokerType ?? null,
        windowAttribution: script.windowAttribution ?? null,
        sourceUrlPathRecorded: typeof script.sourceUrlPath === "string" && script.sourceUrlPath.length > 0,
      })),
    })),
  }));
}

async function recover(context) {
  const original = await verifyOriginalRun();
  const frozen = await verifyFrozenInputs();
  const { traceMapping, packages } = loadPinnedTraceMapping(frozen.dependencyRoot);
  const mapEntry = frozen.manifest.bundleFiles.find((entry) => entry.path === PIN.sourceMapPath);
  const mapBytes = await readVerifiedMobileExportFile(frozen.bundleRoot, mapEntry, "pinned source map");
  const mapJson = JSON.parse(mapBytes.toString("utf8"));
  assert.equal(mapJson.version, 3, "pinned source map must be v3");
  const traceMap = new traceMapping.TraceMap(mapJson, PIN.sourceMapPath);
  const frames = collectProfileFrames(original.profiles, traceMap, traceMapping, PIN.sourceMapPath);
  const resolved = await resolveContentMatches(frames, frozen, context);
  const framesById = new Map(frames.map((entry) => [entry.id, entry]));
  const profileSummaries = aggregateProfileTopFunctions(original.profiles, framesById);
  for (const profile of original.profiles) {
    assert.equal(profile.value.bundleSha256, PIN.bundleSha256, `${profile.panelState} profile is not bound to the pinned full bundle`);
    assert.deepEqual(profile.value.sourceMapEvidence, frozen.manifest.sourceMapEvidence, `${profile.panelState} profile source-map evidence differs`);
  }
  const stackFrames = frames.filter((entry) => entry.kind === "long-task-overlap-stack");
  const topFunctionFrames = frames.filter((entry) => entry.kind === "top-function");
  const mappedFrameCount = frames.filter((entry) => ["application", "dependency"].includes(entry.attribution?.category)).length;
  const result = {
    schemaVersion: 1,
    classification: "OFFLINE_SOURCE_MAP_RECOVERY_DIAGNOSTIC_ONLY",
    retroactivelyChangesOriginalRun: false,
    originalRunStatus: original.result.status,
    originalSourceAttributionStatus: "UNRESOLVED",
    originalSourceAttributionError: "mapGeneratedProfilePosition is not defined",
    sourceRecoveryStatus: mappedFrameCount > 0 ? "RECOVERED_LIMITED_RECORDED_FRAMES" : "NO_VERIFIED_PRODUCT_FRAME",
    performanceSample: false,
    performanceDistributionEligible: false,
    nativeOrRealPhoneValidated: false,
    inputPins: {
      originalRunManifestSha256: PIN.originalRunManifestSha256,
      originalResultSha256: PIN.originalResultSha256,
      originalProfileSha256: PROFILE_FILES.map((entry) => ({ panelState: entry.panelState, sha256: entry.sha256 })),
      bundleSha256: PIN.bundleSha256,
      exportManifestSha256: PIN.exportManifestSha256,
      exportProvenanceSha256: PIN.exportProvenanceSha256,
      sourceMapPath: PIN.sourceMapPath,
      sourceMapSha256: PIN.sourceMapSha256,
      sourceTreeSha256: PIN.sourceTreeSha256,
      sourceManifestSha256: PIN.sourceManifestSha256,
      sourceSha256MapSha256: PIN.sourceSha256MapSha256,
      dependencySourceTreeSha256: PIN.dependencySourceTreeSha256,
      dependencyCopiedTreeSha256: PIN.dependencyCopiedTreeSha256,
    },
    parserPackages: packages,
    profileSamplingScope: "Original CDP CPU profile spans the recorded core burst setup/delivery/visible-tail validation and profiler overhead; it is not pure render time.",
    profileSummaries,
    longTaskEvidence: summarizeLongTaskEvidence(original.profiles),
    topFunctionFrameCount: topFunctionFrames.length,
    longTaskOverlapStackFrameCount: stackFrames.length,
    uniquelyMappedRecordedFrameCount: mappedFrameCount,
    truncatedProfileFrames: "The original artifact retains only topFunctions[0..40]; its remaining sample records were not persisted and cannot be remapped offline.",
    longTaskEvidenceBoundary: "The original Long Task/LoAF entry uses the mock task route and MessagePort.onmessage; the anonymous empty-URL line 4:69 frame remains UNKNOWN because no URL/callsite evidence links it to a specific harness page.evaluate.",
    sourceMapEvidence: {
      exactFullBundleSha256: PIN.bundleSha256,
      exactGeneratedBundlePath: "_expo/static/js/web/entry-67946c84e825296e54a3738bb98ead33.js",
      mapPath: PIN.sourceMapPath,
      mapSha256: PIN.sourceMapSha256,
      status: "EXACT_BUNDLE_PATH_AND_FULL_BUNDLE_DIGEST_VERIFIED",
    },
    frames: frames.map((entry) => ({
      id: entry.id,
      panelState: entry.panelState,
      kind: entry.kind,
      weight: entry.weight,
      sampledMs: entry.sampledMs,
      frame: sanitizeFrame(entry.frame, entry),
    })),
    candidateContentHashCount: resolved.size,
  };
  await context.writeArtifactJson("offline-render-profile-source-map-recovery.json", result);
  return {
    status: result.sourceRecoveryStatus,
    classification: result.classification,
    topFunctionFrameCount: topFunctionFrames.length,
    longTaskOverlapStackFrameCount: stackFrames.length,
    uniquelyMappedRecordedFrameCount: mappedFrameCount,
    omittedSamplesUnmapped: true,
  };
}

await runE2E(import.meta.url, {
  testId: "render-profile-source-map-recovery-091218",
  tier: "manual-live",
  modelPolicy: "offline recovery of source mappings from previously captured Mobile Web CDP profiles; no Browser, Gateway, Provider, model task, public service, or native device; DIAGNOSTIC_ONLY",
  retainSuccessLogs: true,
}, async (context) => {
  try {
    return await recover(context);
  } catch (error) {
    await context.writeArtifactJson("offline-render-profile-source-map-recovery-failure.json", {
      classification: "OFFLINE_SOURCE_MAP_RECOVERY_DIAGNOSTIC_ONLY",
      originalRunWasModified: false,
      errorName: error?.name ?? "Error",
      error: String(error?.message ?? error).slice(0, 600),
    });
    throw error;
  }
});
