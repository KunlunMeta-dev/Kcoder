import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_ARCHIVED_BUNDLE_EVIDENCE,
  currentArchivedBundleRequested,
  inspectCurrentArchivedMobileWeb,
  validateCurrentArchivedGateway,
} from "./current-mobile-web-archive.mjs";

const PRIVATE_INPUT_CONTRACT_ENABLED =
  process.env.KCODER_E2E_CURRENT_ARCHIVE_INPUT_CONTRACT === "1";
const privateInputIntegrationOptions = {
  skip: PRIVATE_INPUT_CONTRACT_ENABLED
    ? false
    : "requires explicit KCODER_E2E_CURRENT_ARCHIVE_INPUT_CONTRACT=1; reads private archive/Gateway inputs",
};

test("current archive mode requires one explicit value-free selector", () => {
  assert.equal(currentArchivedBundleRequested(["node", "runner.mjs"]), false);
  assert.equal(currentArchivedBundleRequested(["node", "runner.mjs", "--current-archive"]), true);
  assert.throws(() => currentArchivedBundleRequested(["--current-archive", "--current-archive"]), /only appear once/);
  assert.throws(() => currentArchivedBundleRequested(["--current-archive=/tmp/input"]), /does not accept/);
});

test("private input integration: current archived bundle verifies its archive proof without claiming full Git source",
  privateInputIntegrationOptions, async () => {
    const evidence = await inspectCurrentArchivedMobileWeb();
    assert.equal(evidence.evidenceClass, CURRENT_ARCHIVED_BUNDLE_EVIDENCE);
    assert.equal(evidence.evidenceClass, "CURRENT_ARCHIVED_BUNDLE_FUNCTIONAL");
    assert.equal(evidence.resourceCount, 37);
    assert.equal(evidence.bundleFiles.length, 37);
    assert.equal(evidence.sourceTreeSha256, "91844534e10b4d01a15cbb2c20b02bf9047db5fc8fd251310e3e19d4f5bbc09a");
    assert.equal(evidence.productPins["apps/kcoder-studio/mobile/src/app/new.tsx"],
      "ddd8c358c783412a9f13f77604fd99e28aa53b4f5860c0e30fc4c7fc0da0ddeb");
    assert.equal(evidence.builderCommitIsNotCurrentSourceClaim, true);
    assert.match(evidence.sourceClaim, /not full current Git source provenance/);
  });

test("private input integration: current archive runner binds the shared frozen Gateway snapshot and executable",
  privateInputIntegrationOptions, async () => {
    const runtime = await validateCurrentArchivedGateway();
    assert.equal(runtime.manifestSha256, "0219dce48d65e6413ce60d0aadfe1fe8047426c6570689ecaf77d757f256cda5");
    assert.equal(runtime.sourceTreeSha256, "6a8255fa538d6f2534d1784a088de9757283e8935e69a0d78a95358bb49ae197");
    assert.equal(runtime.dependencyTreeSha256, "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954");
    assert.equal(runtime.binarySha256, "bc985854134edffc02415a5d9e72f8905fdc23e7e2263e84f9554e53619dec29");
  });
