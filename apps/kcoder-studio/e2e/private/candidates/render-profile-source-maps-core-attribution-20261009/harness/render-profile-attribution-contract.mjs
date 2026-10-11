import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const SHA256_RE = /^[a-f0-9]{64}$/;
const APPROVED_SOURCE_ROOT_MARKERS = [
  "apps/kcoder-studio/mobile/",
  "apps/kcoder-studio/studio-shared/",
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

export function resolveScriptMapBinding(scriptUrlIdentity, mapPaths) {
  if (scriptUrlIdentity?.status !== "APPROVED_SERVED_ORIGIN"
    || typeof scriptUrlIdentity.bundlePath !== "string") {
    return { status: "SCRIPT_URL_IDENTITY_UNVERIFIED", mapPath: null, generatedPath: null };
  }
  const matches = (Array.isArray(mapPaths) ? mapPaths : []).filter((mapPath) => {
    if (typeof mapPath !== "string" || !mapPath.endsWith(".map")) return false;
    const generatedPath = mapPath.slice(0, -4);
    return normalizeBundleInventoryPath(generatedPath) === scriptUrlIdentity.bundlePath;
  });
  if (matches.length === 0) return { status: "NO_EXACT_BUNDLE_PATH_MAP", mapPath: null, generatedPath: null };
  if (matches.length !== 1) return { status: "AMBIGUOUS_BUNDLE_PATH_MAP", mapPath: null, generatedPath: null };
  return { status: "EXACT_BUNDLE_PATH_MATCH", mapPath: matches[0], generatedPath: matches[0].slice(0, -4) };
}

function normalizeBundleInventoryPath(value) {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\")) return null;
  const parts = value.split("/");
  return parts.length > 0 && parts.every((part) => part && part !== "." && part !== "..") ? value : null;
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

export function buildExpoExportArguments(expoCliPath, outputPath, sourceMaps) {
  assert.equal(typeof sourceMaps, "boolean", "source map option must be explicit boolean");
  const args = [expoCliPath, "export", "--platform", "web", "--output-dir", outputPath];
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

export function mapGeneratedProfilePosition(traceMap, frame, traceMapping) {
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
  const sanitizedSource = sanitizeMappedSourcePath(original.source);
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
