import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeCompleteCpuProfileArtifact, makeFullProfileCaptureFailureEvidence, validateProfileWindowBoundaries } from "./profile-capture-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const candidatePath = resolve(here, "mobile-render-profile.full-capture.candidate.mjs");
const baseMetadata = {
  source: "after",
  requestedMessages: 500,
  panelState: "mounted-hidden",
  bundleSha256: "a".repeat(64),
  profileWindowScope: "one actual burst; diagnostic only",
  clockAlignment: { status: "ALIGNED_WITHIN_10MS" },
  profilePageBoundaries: {},
  profileControlNodeClock: { clockDomain: "node monotonic clock" },
  rowGeometryValidationAtPageTimeMs: 25,
  externalValidation: { startedAtPageTimeMs: 26, completedAtPageTimeMs: 30, action: "natural-follow", pollCount: 2, stableSamples: 2 },
};

function profileFixture(overrides = {}) {
  return {
    startTime: 10_000,
    endTime: 13_000,
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "renderRoot",
          scriptId: "17",
          lineNumber: 3,
          columnNumber: 9,
          url: "http://127.0.0.1:4173/index.bundle?access_token=do-not-store#private-fragment",
          privateCallFrameField: "drop-this",
        },
        hitCount: 5,
        children: [2],
        positionTicks: [{ line: 4, ticks: 5, privateTickField: "drop-this" }],
        privateNodeField: "drop-this",
      },
      {
        id: 2,
        callFrame: { functionName: "foreign", scriptId: "18", url: "https://foreign.invalid/index.bundle?token=also-private" },
      },
      {
        id: 3,
        callFrame: { functionName: "same-origin-unpinned", url: "http://127.0.0.1:4173/unlisted.bundle?token=unlisted-secret" },
      },
    ],
    samples: [1, 2, 1],
    timeDeltas: [500, 500, 2000],
    ...overrides,
  };
}

test("candidate relative imports resolve from its actual private directory", async () => {
  const source = await readFile(candidatePath, "utf8");
  const specifiers = [...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((match) => match[1]);
  assert.ok(specifiers.length >= 5, "candidate should retain its expected local harness imports");
  for (const specifier of specifiers) await access(resolve(here, specifier));
});

test("complete profile keeps all samples and only exact approved bundle-relative URL identities", () => {
  const raw = profileFixture();
  const artifact = makeCompleteCpuProfileArtifact(
    raw,
    baseMetadata,
    "http://127.0.0.1:4173/",
    ["index.bundle"],
  );
  assert.deepEqual(artifact.profile.samples, raw.samples);
  assert.deepEqual(artifact.profile.timeDeltas, raw.timeDeltas);
  assert.equal(artifact.completeness.nodeCount, raw.nodes.length);
  assert.equal(artifact.completeness.sampleCount, raw.samples.length);
  assert.equal(artifact.completeness.timeDeltaCount, raw.timeDeltas.length);
  assert.deepEqual(artifact.profile.nodes[0].callFrame.scriptUrlIdentity, {
    status: "APPROVED_SERVED_ORIGIN",
    bundlePath: "index.bundle",
  });
  assert.deepEqual(artifact.profile.nodes[1].callFrame.scriptUrlIdentity, {
    status: "FOREIGN_SCRIPT_ORIGIN",
    bundlePath: null,
  });
  assert.deepEqual(artifact.profile.nodes[2].callFrame.scriptUrlIdentity, {
    status: "SAME_ORIGIN_UNPINNED_PATH",
    bundlePath: null,
  });
  const serialized = JSON.stringify(artifact);
  for (const secret of ["access_token", "do-not-store", "private-fragment", "also-private", "unlisted-secret", "privateCallFrameField", "privateTickField", "privateNodeField"]) {
    assert.equal(serialized.includes(secret), false, `sanitized profile must omit ${secret}`);
  }
  assert.equal(artifact.profile.nodes[0].positionTicks[0].ticks, 5);
  assert.equal(artifact.profile.nodes[0].positionTicks[0].line, 4);
});

test("full-capture call converts its Set-backed path allowlist to the serializer array contract", async () => {
  const source = await readFile(candidatePath, "utf8");
  assert.ok(source.includes("}, approvedScriptBaseUrl, [...approvedBundlePaths]);"), "the production call site must convert its Set-backed inventory before serialization");
  const approvedBundlePaths = new Set(["index.bundle"]);
  const artifact = makeCompleteCpuProfileArtifact(
    profileFixture(),
    baseMetadata,
    "http://127.0.0.1:4173/",
    [...approvedBundlePaths],
  );
  assert.equal(artifact.profile.nodes[0].callFrame.scriptUrlIdentity.bundlePath, "index.bundle");
});

test("complete-profile contract rejects incomplete or malformed sample streams", () => {
  assert.throws(() => makeCompleteCpuProfileArtifact(
    profileFixture({ timeDeltas: [500] }), baseMetadata, "http://127.0.0.1:4173/", ["index.bundle"],
  ), /matching arrays/);
  assert.throws(() => makeCompleteCpuProfileArtifact(
    profileFixture({ samples: [1, Number.NaN, 1] }), baseMetadata, "http://127.0.0.1:4173/", ["index.bundle"],
  ), /safe integers/);
  assert.throws(() => makeCompleteCpuProfileArtifact(
    profileFixture({ timeDeltas: [500, -1, 2000] }), baseMetadata, "http://127.0.0.1:4173/", ["index.bundle"],
  ), /finite non-negative/);
  assert.throws(() => makeCompleteCpuProfileArtifact(
    profileFixture(), baseMetadata, "http://127.0.0.1:4173/", ["../index.bundle"],
  ), /safe relative paths/);
});

test("full-capture gate failure evidence preserves the helper error before throwing", () => {
  const failure = makeFullProfileCaptureFailureEvidence({
    source: "after",
    requestedMessages: 500,
    panelState: "unmounted",
    activeStream: {
      rawCpuProfileArtifact: null,
      cpuProfile: null,
      evidence: { cpuProfileError: "V8 profile timeDeltas must be finite non-negative numbers" },
    },
  });
  assert.equal(failure.classification, "DIAGNOSTIC_ONLY");
  assert.equal(failure.rawCpuProfileArtifactPresent, false);
  assert.equal(failure.cpuProfileSummaryPresent, false);
  assert.equal(failure.cpuProfileErrorPresent, true);
  assert.match(failure.cpuProfileError, /timeDeltas/);
  assert.equal("profile" in failure, false, "failure summary must not claim or embed a complete raw profile");

  const missingCause = makeFullProfileCaptureFailureEvidence({
    source: "after",
    requestedMessages: 500,
    panelState: "mounted-hidden",
    activeStream: { rawCpuProfileArtifact: null, cpuProfile: null, evidence: {} },
  });
  assert.equal(missingCause.cpuProfileError, null);
  assert.equal(missingCause.cpuProfileErrorPresent, false);
});

test("profile-window validation accepts only aligned ordered event boundaries", () => {
  const browserBurstEvents = {
    firstDeltaDispatchAtPageTimeMs: 10,
    completionDispatchAtPageTimeMs: 15,
    agentRowMutationObservedAtPageTimeMs: 18,
    twoAnimationFrameOpportunityAtPageTimeMs: 22,
    rowGeometryValidationAtPageTimeMs: 24,
    tailValidationStartAtPageTimeMs: 25,
    tailValidationEndAtPageTimeMs: 30,
  };
  assert.equal(validateProfileWindowBoundaries({
    browserBurstEvents,
    profileWindowPageTimeMs: { start: 9, end: 23 },
    clockAlignmentStatus: "ALIGNED_WITHIN_10MS",
  }).status, "VALID_ORDERED_WINDOW");
  assert.equal(validateProfileWindowBoundaries({
    browserBurstEvents,
    profileWindowPageTimeMs: { start: 9, end: 23 },
    clockAlignmentStatus: "UNVERIFIED",
  }).status, "UNVERIFIED_CLOCK_ALIGNMENT");
  const missing = validateProfileWindowBoundaries({
    browserBurstEvents: { ...browserBurstEvents, completionDispatchAtPageTimeMs: null },
    profileWindowPageTimeMs: { start: 9, end: 23 },
    clockAlignmentStatus: "ALIGNED_WITHIN_10MS",
  });
  assert.equal(missing.status, "INCOMPLETE_BOUNDARY_EVIDENCE");
  assert.ok(missing.missingOrInvalid.includes("completionDispatch"));
  const outOfOrder = validateProfileWindowBoundaries({
    browserBurstEvents: { ...browserBurstEvents, agentRowMutationObservedAtPageTimeMs: 14 },
    profileWindowPageTimeMs: { start: 9, end: 23 },
    clockAlignmentStatus: "ALIGNED_WITHIN_10MS",
  });
  assert.equal(outOfOrder.status, "OUT_OF_ORDER");
  assert.ok(outOfOrder.violations.some((entry) => entry.after === "rowMutationObserved"));
});
