import assert from "node:assert/strict";
import { recordScriptUrlIdentity } from "../../../harness/render-profile-attribution-contract.mjs";

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

function isSafeBundlePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

/** Keep the complete CDP sample stream while removing raw script URLs and unapproved path data. */
export function makeCompleteCpuProfileArtifact(profile, metadata, approvedScriptBaseUrl, approvedBundlePaths) {
  assert.ok(profile && typeof profile === "object", "full V8 CPU profile response is required");
  assert.ok(Array.isArray(profile.nodes) && Array.isArray(profile.samples) && Array.isArray(profile.timeDeltas), "full V8 profile nodes, samples, and timeDeltas are required");
  assert.equal(profile.samples.length, profile.timeDeltas.length, "full V8 profile samples and timeDeltas must be preserved as matching arrays");
  assert.ok(profile.samples.every(Number.isSafeInteger), "V8 profile sample node IDs must be safe integers");
  assert.ok(profile.timeDeltas.every((value) => Number.isFinite(value) && value >= 0), "V8 profile timeDeltas must be finite non-negative numbers");
  assert.ok(Number.isFinite(profile.startTime) && Number.isFinite(profile.endTime) && profile.endTime >= profile.startTime, "full V8 profile start/end timestamps must be finite and ordered");
  assert.ok(metadata && typeof metadata === "object", "full V8 profile metadata is required");
  assert.match(metadata.bundleSha256, SHA256_RE, "full V8 profile must bind to a pinned bundle digest");
  assert.ok(Array.isArray(approvedBundlePaths) && approvedBundlePaths.length > 0, "pinned served bundle paths are required");
  assert.ok(approvedBundlePaths.every(isSafeBundlePath), "approved bundle paths must be safe relative paths");

  const approvedPaths = new Set(approvedBundlePaths);
  const nodes = profile.nodes.map((node) => {
    assert.ok(Number.isSafeInteger(node?.id), "V8 profile node IDs must be retained as integers");
    const callFrame = node.callFrame && typeof node.callFrame === "object" ? node.callFrame : {};
    const observedIdentity = recordScriptUrlIdentity(callFrame.url, approvedScriptBaseUrl);
    const scriptUrlIdentity = observedIdentity.status === "APPROVED_SERVED_ORIGIN"
      ? approvedPaths.has(observedIdentity.bundlePath)
        ? observedIdentity
        : { status: "SAME_ORIGIN_UNPINNED_PATH", bundlePath: null }
      : { status: observedIdentity.status, bundlePath: null };
    const safeCallFrame = {
      ...(typeof callFrame.functionName === "string" ? { functionName: callFrame.functionName } : {}),
      ...(typeof callFrame.scriptId === "string" ? { scriptId: callFrame.scriptId } : {}),
      ...(Number.isInteger(callFrame.lineNumber) ? { lineNumber: callFrame.lineNumber } : {}),
      ...(Number.isInteger(callFrame.columnNumber) ? { columnNumber: callFrame.columnNumber } : {}),
      scriptUrlIdentity,
    };
    return {
      ...(Number.isSafeInteger(node.hitCount) ? { hitCount: node.hitCount } : {}),
      ...(Array.isArray(node.children) ? { children: [...node.children] } : {}),
      ...(typeof node.deoptReason === "string" ? { deoptReason: node.deoptReason } : {}),
      ...(Array.isArray(node.positionTicks) ? {
        positionTicks: node.positionTicks.map((tick) => ({
          ...(Number.isInteger(tick?.line) ? { line: tick.line } : {}),
          ...(Number.isSafeInteger(tick?.ticks) ? { ticks: tick.ticks } : {}),
        })),
      } : {}),
      id: node.id,
      callFrame: safeCallFrame,
    };
  });
  const artifact = {
    schemaVersion: 1,
    classification: "DIAGNOSTIC_ONLY",
    performanceSample: false,
    performanceDistributionEligible: false,
    source: metadata.source,
    requestedMessages: metadata.requestedMessages,
    panelState: metadata.panelState,
    bundleSha256: metadata.bundleSha256,
    profileWindowScope: metadata.profileWindowScope,
    timestamps: {
      cdpStartTimeUs: profile.startTime,
      cdpEndTimeUs: profile.endTime,
      cdpDurationMs: Number(((profile.endTime - profile.startTime) / 1000).toFixed(3)),
      pageClockAlignment: metadata.clockAlignment,
      browserBurstEvents: metadata.profilePageBoundaries,
      externalValidationAfterProfilerStop: {
        rowGeometryValidationAtPageTimeMs: metadata.rowGeometryValidationAtPageTimeMs,
        tailValidation: metadata.externalValidation ? {
          startedAtPageTimeMs: metadata.externalValidation.startedAtPageTimeMs ?? null,
          completedAtPageTimeMs: metadata.externalValidation.completedAtPageTimeMs ?? null,
          elapsedPageTimeMs: metadata.externalValidation.elapsedPageTimeMs ?? null,
          action: metadata.externalValidation.action ?? null,
          pollCount: metadata.externalValidation.pollCount ?? null,
          stableSamples: metadata.externalValidation.stableSamples ?? null,
        } : null,
      },
      profilerControlNodeClock: metadata.profileControlNodeClock,
    },
    completeness: {
      allNodesRetained: true,
      nodeCount: nodes.length,
      allSamplesRetained: true,
      sampleCount: profile.samples.length,
      allTimeDeltasRetained: true,
      timeDeltaCount: profile.timeDeltas.length,
      callFrameUrlPolicy: "raw URLs, query strings, fragments, credentials, and absolute paths are never stored; only exact approved bundle-relative paths or a status code are retained",
    },
    profile: {
      startTime: profile.startTime,
      endTime: profile.endTime,
      nodes,
      samples: [...profile.samples],
      timeDeltas: [...profile.timeDeltas],
    },
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(artifact));
  assert.ok(serializedBytes <= MAX_ARTIFACT_BYTES, "complete sanitized V8 profile exceeds the 64 MiB diagnostic artifact limit");
  artifact.serializedUtf8Bytes = serializedBytes;
  return artifact;
}

/** Classify timestamp evidence without turning a missing measurement into a pass. */
export function validateProfileWindowBoundaries({ browserBurstEvents, profileWindowPageTimeMs, clockAlignmentStatus }) {
  if (clockAlignmentStatus !== "ALIGNED_WITHIN_10MS") {
    return { status: "UNVERIFIED_CLOCK_ALIGNMENT", clockAlignmentStatus: clockAlignmentStatus ?? null };
  }
  const values = {
    profileStart: profileWindowPageTimeMs?.start,
    firstDeltaDispatch: browserBurstEvents?.firstDeltaDispatchAtPageTimeMs,
    completionDispatch: browserBurstEvents?.completionDispatchAtPageTimeMs,
    rowMutationObserved: browserBurstEvents?.agentRowMutationObservedAtPageTimeMs,
    twoAnimationFrames: browserBurstEvents?.twoAnimationFrameOpportunityAtPageTimeMs,
    profileEnd: profileWindowPageTimeMs?.end,
    rowGeometry: browserBurstEvents?.rowGeometryValidationAtPageTimeMs,
    tailValidationStart: browserBurstEvents?.tailValidationStartAtPageTimeMs,
    tailValidationEnd: browserBurstEvents?.tailValidationEndAtPageTimeMs,
  };
  const invalid = Object.entries(values)
    .filter(([, value]) => typeof value !== "number" || !Number.isFinite(value))
    .map(([name]) => name);
  if (invalid.length > 0) return { status: "INCOMPLETE_BOUNDARY_EVIDENCE", missingOrInvalid: invalid };

  const ordered = Object.entries(values);
  const violations = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const [previousName, previousValue] = ordered[index - 1];
    const [name, value] = ordered[index];
    if (value < previousValue) violations.push({ before: previousName, after: name });
  }
  return violations.length > 0
    ? { status: "OUT_OF_ORDER", violations }
    : { status: "VALID_ORDERED_WINDOW", boundaries: values };
}

/** Preserve the capture failure cause before the caller's required-artifact gate throws. */
export function makeFullProfileCaptureFailureEvidence({ source, requestedMessages, panelState, activeStream }) {
  const captureError = typeof activeStream?.evidence?.cpuProfileError === "string"
    ? activeStream.evidence.cpuProfileError.slice(0, 500)
    : null;
  const profileWindow = activeStream?.cpuProfile?.profileWindow;
  return {
    schemaVersion: 1,
    classification: "DIAGNOSTIC_ONLY",
    performanceSample: false,
    performanceDistributionEligible: false,
    source,
    requestedMessages,
    panelState,
    captureRequested: true,
    rawCpuProfileArtifactPresent: Boolean(activeStream?.rawCpuProfileArtifact),
    cpuProfileSummaryPresent: Boolean(activeStream?.cpuProfile),
    cpuProfileSampleCount: Number.isSafeInteger(activeStream?.cpuProfile?.sampleCount)
      ? activeStream.cpuProfile.sampleCount
      : null,
    profileWindow: profileWindow && Number.isFinite(profileWindow.startTimeUs) && Number.isFinite(profileWindow.endTimeUs)
      ? { startTimeUs: profileWindow.startTimeUs, endTimeUs: profileWindow.endTimeUs }
      : null,
    cpuProfileError: captureError,
    cpuProfileErrorPresent: captureError !== null,
  };
}
