import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const candidatePath = resolve(directory, "mobile-home-minute-boundary-samples-only.r2.candidate.e2e.mjs");
const candidateSha256 = "9e365dfec6ec90a2e82756fbf32867a631a67b345e1b6fbbb3442e1e14cc86de";

test("Home samples-only selector skips the separate auth gate and keeps exact per-sample cleanup", async () => {
  const source = await readFile(candidatePath, "utf8");
  assert.equal(createHash("sha256").update(source).digest("hex"), candidateSha256, "reviewed candidate bytes changed");

  assert.match(source, /const refreshHomeMinuteBoundarySamplesOnlyMode = process\.argv\.includes\("--home-minute-boundary-samples-only"\)/);
  assert.match(source, /assert\.ok\(!\(refreshHomeMinuteBoundaryWithAuthGateMode && refreshHomeMinuteBoundarySamplesOnlyMode\)/);
  assert.match(source, /assert\.equal\(refreshAuthCleanupUiGateMode, false, "--home-minute-boundary-samples-only must not rerun the separate 35-cycle auth gate"\)/);
  assert.match(source, /assert\.equal\(sampleCount, 2, "Home samples-only diagnostic requires exactly two Home samples"\)/);
  assert.match(source, /assert\.deepEqual\(delayValues, \[600\], "Home samples-only diagnostic requires only the 600ms HTTP response hold"\)/);
  assert.match(source, /assert\.equal\(snapshotMode, "after", "Home samples-only diagnostic requires the latest explicitly frozen after snapshot"\)/);

  assert.match(source, /refreshPerSampleAuthCleanupMode = formalOwnedAuthLifecycle \|\| refreshHomeMinuteBoundaryDiagnosticMode/);
  assert.match(source, /status: "NOT_RUN",\s+requiredCycles: REFRESH_AUTH_CLEANUP_UI_GATE_CYCLES,\s+attemptedCycles: 0,\s+passedCycles: 0,/);
  assert.match(source, /historicalEvidence:\s*\{\s*status: "PASS",\s*runContext: "20261009-093803\.024Z"/);
  assert.match(source, /artifactSha256: "1de63d1ccc88b7c245ab845bd1684c525cdac888907b9f81a68b484b15cb6342"/);
  assert.match(source, /the prior run failed at both Home fixture-capture setup gates and is not a current-run PASS/);

  assert.match(source, /const expectedFormalSamples = groups\.length \* delayValues\.length \* sampleCount/);
  assert.match(source, /formalAuthCleanupCount === expectedFormalSamples && finalAuthStore\.active === 0 && formalMaxActiveDeviceGrants === 1/);
  assert.match(source, /releaseOwnedMobileAuthSample\(page, gateway, sampleAuth, context\)/);
  assert.match(source, /assert\.equal\(sampleAuthLifecycle\.status, "PASS", "every owned Home sample must pair and release its exact auth grant before the next sample"\)/);
});
