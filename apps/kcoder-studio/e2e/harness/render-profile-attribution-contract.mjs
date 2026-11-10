import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const SHA256_RE = /^[a-f0-9]{64}$/;
const APPROVED_SOURCE_ROOT_MARKERS = [
  "apps/kcoder-studio/mobile/",
  "apps/kcoder-studio/shared/",
];

function normalizeServedPath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || /%(?:2f|5c)/i.test(pathname)) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const parts = decoded.slice(1).split("/");
  if (parts.length === 0 || parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

export function recordScriptUrlIdentity(scriptUrl, approvedBaseUrl) {
  let script;
  let approved;
  try {
    script = new URL(scriptUrl);
    approved = new URL(approvedBaseUrl);
  } catch {
    return { status: "INVALID_SCRIPT_URL", bundlePath: null };
  }
  if (!["http:", "https:"].includes(script.protocol)
    || !["http:", "https:"].includes(approved.protocol)
    || script.username || script.password || approved.username || approved.password) {
    return { status: "UNSUPPORTED_SCRIPT_URL", bundlePath: null };
  }
  if (script.origin !== approved.origin) return { status: "FOREIGN_SCRIPT_ORIGIN", bundlePath: null };
  const bundlePath = normalizeServedPath(script.pathname);
  return bundlePath
    ? { status: "APPROVED_SERVED_ORIGIN", bundlePath }
    : { status: "INVALID_SERVED_BUNDLE_PATH", bundlePath: null };
}

export function resolveScriptMapBinding(scriptUrlIdentity, mapPaths, { trustedMountPath } = {}) {
  if (scriptUrlIdentity?.status !== "APPROVED_SERVED_ORIGIN"
    || typeof scriptUrlIdentity.bundlePath !== "string") {
    return { status: "SCRIPT_URL_IDENTITY_UNVERIFIED", mapPath: null, generatedPath: null };
  }
  if (!normalizeBundleInventoryPath(scriptUrlIdentity.bundlePath)) {
    return { status: "INVALID_SERVED_BUNDLE_PATH", mapPath: null, generatedPath: null };
  }
  let bundlePath = scriptUrlIdentity.bundlePath;
  let mountNormalization = null;
  if (trustedMountPath !== undefined) {
    const normalizedMountPath = normalizeServedPath(trustedMountPath);
    if (!normalizedMountPath || trustedMountPath !== `/${normalizedMountPath}`) {
      return { status: "INVALID_TRUSTED_MOUNT_PATH", mapPath: null, generatedPath: null };
    }
    const exactPrefix = `${normalizedMountPath}/`;
    if (!bundlePath.startsWith(exactPrefix)) {
      return { status: "SERVED_PATH_OUTSIDE_TRUSTED_MOUNT", mapPath: null, generatedPath: null };
    }
    bundlePath = bundlePath.slice(exactPrefix.length);
    if (!normalizeBundleInventoryPath(bundlePath)) {
      return { status: "INVALID_MOUNT_RELATIVE_BUNDLE_PATH", mapPath: null, generatedPath: null };
    }
    mountNormalization = "EXACT_TRUSTED_MOUNT_PREFIX_STRIPPED";
  }
  const matches = (Array.isArray(mapPaths) ? mapPaths : []).filter((mapPath) => {
    if (typeof mapPath !== "string" || !mapPath.endsWith(".map")) return false;
    const generatedPath = mapPath.slice(0, -4);
    return normalizeBundleInventoryPath(generatedPath) === bundlePath;
  });
  if (matches.length === 0) return { status: "NO_EXACT_BUNDLE_PATH_MAP", mapPath: null, generatedPath: null, ...(mountNormalization ? { mountNormalization } : {}) };
  if (matches.length !== 1) return { status: "AMBIGUOUS_BUNDLE_PATH_MAP", mapPath: null, generatedPath: null, ...(mountNormalization ? { mountNormalization } : {}) };
  return {
    status: "EXACT_BUNDLE_PATH_MATCH",
    mapPath: matches[0],
    generatedPath: matches[0].slice(0, -4),
    ...(mountNormalization ? { mountNormalization, servedBundlePath: scriptUrlIdentity.bundlePath } : {}),
  };
}

function normalizeBundleInventoryPath(value) {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\")) return null;
  const parts = value.split("/");
  return parts.length > 0 && parts.every((part) => part && part !== "." && part !== "..") ? value : null;
}

function comparableSourceRoots(roots) {
  if (!Array.isArray(roots)) return null;
  const mapped = roots.map((root) => {
    if (!root || typeof root !== "object") return null;
    return {
      name: root.name,
      sourceRoot: root.sourceRoot,
      destination: root.destination,
      sha256: root.sha256,
      fileCount: root.fileCount,
    };
  });
  if (mapped.some((root) => !root)) return null;
  mapped.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return mapped;
}

function validateCandidateSourceRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\\") || value.includes("\0")) return false;
  const parts = value.split("/");
  return !value.startsWith("/") && parts.every((part) => part && part !== "." && part !== "..");
}

export function verifyPinnedSourceInventoryBytes({
  inventoryBytes,
  candidateDigest,
  candidateFiles,
  sourceTreeSha256,
  sourceRoots,
  inputRoots,
}) {
  assert.ok(Buffer.isBuffer(inventoryBytes) || inventoryBytes instanceof Uint8Array, "candidate source inventory bytes are required");
  assert.match(candidateDigest, SHA256_RE, "candidate source inventory digest must be a lowercase SHA-256 digest");
  const observedDigest = createHash("sha256").update(inventoryBytes).digest("hex");
  assert.equal(observedDigest, candidateDigest, "candidate source inventory bytes differ from their pinned digest");

  const inventory = JSON.parse(Buffer.from(inventoryBytes).toString("utf8"));
  assert.equal(inventory.schemaVersion, 1, "candidate source inventory schema is unsupported");
  assert.equal(inventory.status, "derived-post-export-exact-source-inventory", "candidate source inventory must identify its exact-source derivation");
  assert.equal(inventory.sourceTreeSha256, sourceTreeSha256, "candidate source inventory source-tree digest differs from the export input");
  assert.equal(inventory.fileCount, candidateFiles, "candidate source inventory file count differs from the pinned provenance");
  assert.ok(Array.isArray(inventory.files), "candidate source inventory file list is required");
  assert.equal(inventory.files.length, candidateFiles, "candidate source inventory file list is incomplete");

  const provenanceRoots = comparableSourceRoots(sourceRoots);
  const manifestRoots = comparableSourceRoots(inputRoots);
  const inventoryRoots = comparableSourceRoots(inventory.sourceRoots);
  assert.ok(provenanceRoots && manifestRoots && inventoryRoots, "candidate source roots are required");
  assert.deepEqual(provenanceRoots, manifestRoots, "candidate source roots differ from the actual export input roots");
  assert.deepEqual(inventoryRoots, manifestRoots, "candidate inventory roots differ from the actual export input roots");
  assert.match(sourceTreeSha256, SHA256_RE, "candidate source tree digest must be a lowercase SHA-256 digest");
  assert.ok(Number.isSafeInteger(candidateFiles) && candidateFiles > 0, "candidate source inventory file count must be positive");
  for (const root of manifestRoots) {
    assert.ok(typeof root.sourceRoot === "string" && root.sourceRoot.startsWith("/"), "candidate source root must be an absolute pinned path");
    assert.ok(!root.sourceRoot.split("/").some((part) => part === ".."), "candidate source root cannot contain traversal");
    assert.match(root.sha256, SHA256_RE, "candidate source root digest must be a lowercase SHA-256 digest");
    assert.ok(Number.isSafeInteger(root.fileCount) && root.fileCount > 0, "candidate source root file count must be positive");
  }
  assert.deepEqual(
    manifestRoots.map(({ name, destination }) => ({ name, destination })),
    [
      { name: "mobile", destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", destination: "apps/kcoder-studio/shared" },
    ],
    "candidate source roots must be exactly the approved Mobile and Studio shared roots",
  );

  const rootsByName = new Map(manifestRoots.map((root) => [root.name, root]));
  const fileKeys = new Set();
  const countsByRoot = new Map([...rootsByName.keys()].map((name) => [name, 0]));
  for (const entry of inventory.files) {
    assert.ok(entry && typeof entry === "object", "candidate source inventory entries must be objects");
    assert.ok(rootsByName.has(entry.root), "candidate source inventory contains an unapproved source root");
    assert.ok(validateCandidateSourceRelativePath(entry.path), "candidate source inventory contains a noncanonical path");
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0, "candidate source inventory contains an invalid file size");
    assert.match(entry.sha256, SHA256_RE, "candidate source inventory contains an invalid file digest");
    const key = `${entry.root}\0${entry.path}`;
    assert.ok(!fileKeys.has(key), "candidate source inventory contains a duplicate file path");
    fileKeys.add(key);
    countsByRoot.set(entry.root, countsByRoot.get(entry.root) + 1);
  }
  for (const root of manifestRoots) {
    assert.equal(countsByRoot.get(root.name), root.fileCount, `candidate source inventory count differs for ${root.name}`);
  }
  return {
    status: "PINNED_CANDIDATE_SOURCE_INVENTORY",
    candidateDigest: observedDigest,
    sourceTreeSha256,
    fileCount: candidateFiles,
    sourceRoots: manifestRoots,
    files: inventory.files,
  };
}

export function resolvePinnedMetroSourcePath(source, {
  sourceRoots,
  candidateSourceFiles,
  sourceMapSources,
  sourcesContent,
} = {}) {
  if (typeof source !== "string") return { status: "INVALID_METRO_SOURCE_ALIAS", source: null };
  let rootName;
  let candidatePath;
  let destination;
  if (source.startsWith("/src/")) {
    rootName = "mobile";
    destination = "apps/kcoder-studio/mobile";
    candidatePath = `src/${source.slice("/src/".length)}`;
  } else if (source.startsWith("/../shared/")) {
    rootName = "studio-shared";
    destination = "apps/kcoder-studio/shared";
    candidatePath = source.slice("/../shared/".length);
  } else if (source.startsWith("/src") || source.startsWith("/../shared")) {
    return { status: "INVALID_METRO_SOURCE_ALIAS", source: null };
  } else {
    return { status: "NOT_PINNED_METRO_ALIAS", source: null };
  }

  const suffix = rootName === "mobile" ? source.slice("/src/".length) : source.slice("/../shared/".length);
  if (!validateCandidateSourceRelativePath(suffix) || /[%?#]/.test(suffix)) {
    return { status: "INVALID_METRO_SOURCE_ALIAS", source: null };
  }
  if (!Array.isArray(sourceRoots) || !Array.isArray(candidateSourceFiles)) {
    return { status: "PINNED_SOURCE_INVENTORY_MISSING", source: null };
  }
  const roots = sourceRoots.filter((root) => root?.name === rootName && root?.destination === destination
    && SHA256_RE.test(root?.sha256 ?? "") && Number.isSafeInteger(root?.fileCount) && root.fileCount > 0);
  if (roots.length !== 1) return { status: "PINNED_SOURCE_ROOT_MISSING_OR_AMBIGUOUS", source: null };

  const fileMatches = candidateSourceFiles.filter((entry) => entry?.root === rootName && entry?.path === candidatePath);
  if (fileMatches.length !== 1 || !SHA256_RE.test(fileMatches[0]?.sha256 ?? "")) {
    return { status: "PINNED_SOURCE_FILE_MISSING_OR_AMBIGUOUS", source: null };
  }
  if (!Array.isArray(sourceMapSources) || !Array.isArray(sourcesContent)) {
    return { status: "SOURCE_MAP_CONTENT_UNAVAILABLE", source: null };
  }
  const sourceIndices = [];
  for (let index = 0; index < sourceMapSources.length; index += 1) {
    if (sourceMapSources[index] === source) sourceIndices.push(index);
  }
  if (sourceIndices.length !== 1) return { status: "SOURCE_MAP_SOURCE_MISSING_OR_AMBIGUOUS", source: null };
  const sourceContent = sourcesContent[sourceIndices[0]];
  if (typeof sourceContent !== "string") return { status: "SOURCE_CONTENT_MISSING", source: null };
  const observedContentSha256 = createHash("sha256").update(sourceContent, "utf8").digest("hex");
  if (observedContentSha256 !== fileMatches[0].sha256) return { status: "SOURCE_CONTENT_SHA256_MISMATCH", source: null };
  return {
    status: "PINNED_METRO_SOURCE",
    source: `${destination}/${candidatePath}`,
    root: rootName,
    sourceSha256: observedContentSha256,
  };
}

export function sanitizeMappedSourcePath(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > 4096) {
    return { status: "INVALID_SOURCE_PATH", source: null };
  }
  const normalized = source.replaceAll("\\", "/");
  const absolute = normalized.startsWith("/")
    || /^[a-zA-Z]:\//.test(normalized)
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized);
  if (absolute) {
    for (const marker of APPROVED_SOURCE_ROOT_MARKERS) {
      let markerIndex = normalized.indexOf(marker);
      while (markerIndex >= 0 && markerIndex > 0 && normalized[markerIndex - 1] !== "/") {
        markerIndex = normalized.indexOf(marker, markerIndex + 1);
      }
      if (markerIndex >= 0) {
        return { status: "SCOPED_ABSOLUTE_SOURCE", source: normalized.slice(markerIndex) };
      }
    }
    return { status: "UNSCOPED_ABSOLUTE_SOURCE_REDACTED", source: null };
  }
  const parts = normalized.replace(/^\.\//, "").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return { status: "UNSCOPED_RELATIVE_SOURCE_REDACTED", source: null };
  }
  return { status: "RELATIVE_SOURCE", source: parts.join("/") };
}

export function buildExpoExportArguments(expoCliPath, outputPath, sourceMaps, platform = "web") {
  assert.equal(typeof sourceMaps, "boolean", "source map option must be explicit boolean");
  assert.ok(["android", "ios", "web"].includes(platform), "Expo export platform must be android, ios, or web");
  const args = [expoCliPath, "export", "--platform", platform, "--output-dir", outputPath];
  if (sourceMaps) args.push("--source-maps");
  return args;
}

export function createSourceMapBundleEvidence(enabled, bundleFiles, bundleSha256) {
  assert.equal(typeof enabled, "boolean", "source map option must be explicit boolean");
  if (!enabled) return null;
  assert.ok(Array.isArray(bundleFiles), "bundle file inventory is required for source maps");
  assert.match(bundleSha256, SHA256_RE, "full bundle digest must be pinned before source map evidence is recorded");
  const mapFiles = bundleFiles.filter((entry) => typeof entry?.path === "string" && entry.path.endsWith(".map"));
  return {
    schemaVersion: 1,
    enabled: true,
    bundleSha256,
    bundleFileCount: bundleFiles.length,
    mapFileCount: mapFiles.length,
    mapFiles: mapFiles.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  };
}

export function verifySourceMapBundleEvidence(evidence, manifest) {
  assert.ok(evidence && typeof evidence === "object", "source-map-enabled bundle must include sourceMapEvidence");
  assert.equal(evidence.schemaVersion, 1, "unsupported source map evidence schema");
  assert.equal(evidence.enabled, true, "source map evidence must mark maps enabled");
  assert.match(evidence.bundleSha256, SHA256_RE, "source map evidence bundle digest is invalid");
  assert.equal(evidence.bundleSha256, manifest.bundleSha256, "source maps must bind to the full bundle digest");
  assert.equal(evidence.bundleFileCount, manifest.bundleFiles.length, "source map evidence bundle file count differs");

  const mapFiles = manifest.bundleFiles.filter((entry) => entry.path.endsWith(".map"));
  assert.ok(mapFiles.length > 0, "sourceMaps=true export must contain at least one source map");
  assert.equal(evidence.mapFileCount, mapFiles.length, "source map file count differs from the bundle inventory");
  assert.deepEqual(evidence.mapFiles, mapFiles, "source-map file digests must exactly match the full bundle inventory");
  assert.equal(manifest.bundleFiles.length - mapFiles.length, 37, "source-map export must preserve the standard 37-file bundle and add only maps");
  const actualBundleSha256 = createHash("sha256").update(JSON.stringify(manifest.bundleFiles)).digest("hex");
  assert.equal(actualBundleSha256, manifest.bundleSha256, "source map evidence bundle aggregate digest is invalid");
  return true;
}

export function validateCoreAttributionMode({
  enabled,
  sampleCount,
  sourceNames,
  messageCounts,
  captureStackDiagnostic,
  captureSeedUiDomTrace,
  runtimeConsumerDiagnostic,
  followGestureRegression,
  tailWindowDiagnostic,
}) {
  assert.equal(typeof enabled, "boolean", "core attribution mode must be an explicit boolean");
  if (!enabled) return { enabled: false };
  assert.equal(sampleCount, 1, "core attribution mode is one diagnostic burst, not a performance sample set");
  assert.deepEqual(sourceNames, ["after"], "core attribution mode requires exactly one frozen after source");
  assert.deepEqual(messageCounts, [500], "core attribution mode uses the existing 500-message hotspot fixture");
  assert.equal(captureStackDiagnostic, false, "core attribution mode profiles the core burst and cannot add a second stack burst");
  assert.equal(captureSeedUiDomTrace, false, "core attribution mode must not add seed DOM observers");
  assert.equal(runtimeConsumerDiagnostic, false, "core attribution mode must not enable the runtime projection probe");
  assert.equal(followGestureRegression, false, "core attribution mode is separate from follow gesture diagnostics");
  assert.equal(tailWindowDiagnostic, false, "core attribution mode is separate from tail-window diagnostics");
  return {
    enabled: true,
    classification: "DIAGNOSTIC_ONLY",
    performanceDistributionEligible: false,
    profileScope: "actual-core-active-markdown-burst",
    sampleCount: 1,
    source: "after",
    requestedMessages: 500,
  };
}

export function makeCoreAttributionRecord({ source, requestedMessages, panelState, bundleSha256, profile, burst, captureError }) {
  const capturedSamples = Number.isSafeInteger(profile?.sampleCount) ? profile.sampleCount : 0;
  const coreBurstPassed = burst?.ok === true;
  return {
    schemaVersion: 1,
    classification: "DIAGNOSTIC_ONLY",
    diagnosticOnly: true,
    performanceSample: false,
    performanceDistributionEligible: false,
    source,
    requestedMessages,
    panelState,
    bundleSha256,
    profileScope: "Profiler is enabled inside the actual core active-Markdown burst; the profile window includes the burst setup, notification delivery, final visible-tail gate, and profiler start/stop overhead.",
    profileCaptureStatus: capturedSamples > 0 ? "CAPTURED" : "FAILED_OR_EMPTY",
    profileSampleCount: capturedSamples,
    coreBurstStatus: coreBurstPassed ? "PASS" : "FAIL",
    profile: profile ?? null,
    burst: burst ?? null,
    ...(captureError ? { captureError: String(captureError).slice(0, 500) } : {}),
  };
}

export function mapGeneratedProfilePosition(traceMap, frame, traceMapping, sourceEvidence = undefined) {
  if (!Number.isInteger(frame?.lineNumber) || frame.lineNumber < 0
    || !Number.isInteger(frame?.columnNumber) || frame.columnNumber < 0) {
    return { status: "MISSING_GENERATED_POSITION", source: null, line: null, column: null, name: null };
  }
  const original = traceMapping.originalPositionFor(traceMap, {
    line: frame.lineNumber + 1,
    column: frame.columnNumber,
    bias: traceMapping.GREATEST_LOWER_BOUND,
  });
  if (!original?.source || !Number.isInteger(original.line)) {
    return { status: "NO_ORIGINAL_POSITION", source: null, line: null, column: null, name: null };
  }
  const metroResolution = resolvePinnedMetroSourcePath(original.source, sourceEvidence);
  const sanitizedSource = metroResolution.status === "PINNED_METRO_SOURCE"
    ? { status: metroResolution.status, source: metroResolution.source }
    : metroResolution.status !== "NOT_PINNED_METRO_ALIAS"
      ? { status: metroResolution.status, source: null }
      : sanitizeMappedSourcePath(original.source);
  if (!sanitizedSource.source) {
    return { status: sanitizedSource.status, source: null, line: null, column: null, name: null };
  }
  return {
    status: "MAPPED",
    source: sanitizedSource.source,
    sourcePathStatus: sanitizedSource.status,
    line: original.line,
    column: original.column,
    name: original.name ?? null,
  };
}
