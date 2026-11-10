import test from "node:test";
import assert from "node:assert/strict";
import {
  MATCHED_DEPLOY_MOUNTED_PINS as pins,
  selectMatchedDeployMountedModes,
  validateMatchedDeployMountedInputs,
} from "./matched-deploy-mounted-inputs.mjs";

function matchedFormalInput(overrides = {}) {
  const repoRoot = "/repo";
  const sourceLabel = "before-10feb";
  const exportRoot = `${repoRoot}/${pins.exportRunRoot}/${sourceLabel}`;
  return {
    argv: ["--reuse-matched-deploy-mounted-formal"],
    repoRoot,
    snapshotMode: "before",
    snapshotDirectory: pins.beforeSourceAdapter,
    snapshotSourceSha256: pins.beforeSourceTreeSha256,
    beforeComplementDirectory: pins.beforeSourceAdapter,
    beforeComplementSha256: pins.beforeComplementSha256,
    reuseExportDirectory: `${exportRoot}/bundle`,
    reuseExportManifest: `${exportRoot}/export-manifest.json`,
    reuseExportManifestSha256: pins.exportManifestSha256.before,
    currentOfficialDistMode: false,
    refreshSmokeMode: false,
    refreshSingleSampleMode: false,
    refreshHomeN30OnlyMode: false,
    refreshSendDiagnosticMode: false,
    refreshBackgroundDiagnosticMode: false,
    refreshAuthCleanupUiGateMode: false,
    refreshSendDiagnostic: null,
    refreshBackgroundDiagnostic: null,
    navigationOnly: false,
    drawerCloseDiagnosticsEnabled: false,
    sampleCount: 30,
    delayValues: [0, 300, 600, 1000],
    defaultSamples: 30,
    defaultDelays: [0, 300, 600, 1000],
    ...overrides,
  };
}

test("matched mode selection keeps the paired smoke and historical formal mode exclusive", () => {
  assert.deepEqual(selectMatchedDeployMountedModes([]), {
    reuseDeployMountedMode: false,
    reuseMatchedDeployMountedFormalMode: false,
    matchedDeployMountedInputMode: false,
  });
  assert.equal(selectMatchedDeployMountedModes(["--reuse-deploy-mounted"]).matchedDeployMountedInputMode, true);
  assert.equal(selectMatchedDeployMountedModes(["--reuse-matched-deploy-mounted-formal"]).matchedDeployMountedInputMode, true);
  assert.throws(
    () => validateMatchedDeployMountedInputs(matchedFormalInput({ argv: ["--reuse-deploy-mounted", "--reuse-matched-deploy-mounted-formal"] })),
    /choose either paired deploy-mounted smoke or formal mode/,
  );
});

test("historical formal mode accepts only its pinned 30 x 4 input contract", () => {
  const selected = validateMatchedDeployMountedInputs(matchedFormalInput());
  assert.equal(selected.reuseDeployMountedMode, false);
  assert.equal(selected.reuseMatchedDeployMountedFormalMode, true);
  assert.equal(selected.matchedDeployMountedInputMode, true);

  for (const overrides of [
    { reuseExportManifestSha256: "0".repeat(64) },
    { snapshotSourceSha256: "0".repeat(64) },
    { sampleCount: 29 },
    { delayValues: [0, 300, 600] },
    { navigationOnly: true },
    { drawerCloseDiagnosticsEnabled: true },
    { currentOfficialDistMode: true },
  ]) {
    assert.throws(() => validateMatchedDeployMountedInputs(matchedFormalInput(overrides)));
  }
});

test("paired zero-delay smoke still requires the smoke selector", () => {
  const input = matchedFormalInput({
    argv: ["--reuse-deploy-mounted"],
    refreshSmokeMode: true,
    refreshSingleSampleMode: true,
    sampleCount: 1,
    delayValues: [0],
  });
  assert.equal(validateMatchedDeployMountedInputs(input).reuseDeployMountedMode, true);

  assert.throws(
    () => validateMatchedDeployMountedInputs({ ...input, refreshSmokeMode: false }),
    /reserved for the paired zero-delay functional smoke/,
  );
});

test("after mode cannot inherit before-complement pins", () => {
  const root = "/repo";
  const exportRoot = `${root}/${pins.exportRunRoot}/comparison-9925461c`;
  const input = matchedFormalInput({
    snapshotMode: "after",
    snapshotDirectory: pins.afterSourceAdapter,
    snapshotSourceSha256: pins.afterSourceDigest,
    beforeComplementDirectory: null,
    beforeComplementSha256: null,
    reuseExportDirectory: `${exportRoot}/bundle`,
    reuseExportManifest: `${exportRoot}/export-manifest.json`,
    reuseExportManifestSha256: pins.exportManifestSha256.after,
  });
  assert.equal(validateMatchedDeployMountedInputs(input).matchedDeployMountedInputMode, true);
  assert.throws(
    () => validateMatchedDeployMountedInputs({ ...input, beforeComplementDirectory: pins.beforeSourceAdapter }),
    /matched after mode cannot accept a before complement/,
  );
});

test("unmatched mode rejects the historical manifest digest selector", () => {
  const input = matchedFormalInput({
    argv: [],
    reuseExportManifestSha256: pins.exportManifestSha256.before,
  });
  assert.throws(
    () => validateMatchedDeployMountedInputs(input),
    /only accepted with a paired deploy-mounted mode/,
  );
});
