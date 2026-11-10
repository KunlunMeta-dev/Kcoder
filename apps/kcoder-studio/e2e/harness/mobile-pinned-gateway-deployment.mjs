import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import {
  inspectMobileWebExportSourceIdentity,
  restoreMobileWebExportArchive,
  verifyMobileWebExportUnchanged,
} from "./mobile-web-export-archive.mjs";
import { materializeArchivedMobileWebDeployment } from "./mobile-archived-deployment.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/;

/** Restore a caller-pinned Mobile archive and derive its production Gateway /mobile root. */
export async function restorePinnedGatewayMobileDeployment(context, {
  outputName = "mobile-web-pinned-gateway-deployment",
} = {}) {
  assertRunContext(context);
  assertSlug(outputName);

  const sourceRoot = requiredAbsolutePath("KCODER_E2E_MOBILE_SOURCE_ROOT");
  const sourceManifestPath = requiredAbsolutePath("KCODER_E2E_MOBILE_SOURCE_MANIFEST");
  const sourceManifestSha256 = requiredSha256("KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256");
  const archivePath = requiredAbsolutePath("KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE");
  const archiveSha256 = requiredSha256("KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256");

  const sourceRoots = [
    { name: "mobile", path: sourceRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(sourceRoot, "../shared"), destination: "apps/kcoder-studio/shared" },
  ];
  const sourceIdentity = await inspectMobileWebExportSourceIdentity({
    sourceRoots,
    snapshotManifestPath: sourceManifestPath,
    expectedSnapshotManifestSha256: sourceManifestSha256,
  });
  assert.ok(sourceIdentity.snapshotProof, "pinned Mobile source manifest proof is required");

  const mobileWeb = await restoreMobileWebExportArchive(context, {
    archivePath,
    expectedArchiveSha256: archiveSha256,
    sourceIdentity,
    outputName: `${outputName}-archive-restored`,
  });
  const sourcePins = {
    archivePath: mobileWeb.archivePath,
    archiveSha256: mobileWeb.archiveSha256,
    originalManifestSha256: mobileWeb.originalManifestSha256,
    sourceRoot: mobileWeb.sourceRoot,
    sourceManifestPath: sourceIdentity.snapshotProof.manifestPath,
    sourceManifestSha256: sourceIdentity.snapshotProof.manifestSha256,
    sourceTreeSha256: mobileWeb.sourceTreeSha256,
    sourceSnapshotProof: sourceIdentity.snapshotProof,
  };

  context.addCleanup("verify pinned Mobile archive bundle remains unchanged", async () => {
    try {
      const result = await verifyMobileWebExportUnchanged(mobileWeb);
      await context.writeArtifactJsonInternal("mobile-pinned-deployment-archive-postflight.json", result);
    } catch (error) {
      await context.writeArtifactJsonInternal("mobile-pinned-deployment-archive-postflight.json", {
        unchanged: false,
        error: context.redactText(error?.message || String(error)),
      }).catch(() => {});
      throw error;
    }
  });
  context.addCleanup("verify pinned Mobile source identity remains unchanged", async () => {
    try {
      const current = await inspectMobileWebExportSourceIdentity({
        sourceRoots,
        snapshotManifestPath: sourceManifestPath,
        expectedSnapshotManifestSha256: sourceManifestSha256,
      });
      assert.deepEqual(current, sourceIdentity, "caller-pinned Mobile source identity changed during the E2E run");
      await context.writeArtifactJsonInternal("mobile-pinned-deployment-source-postflight.json", {
        unchanged: true,
        sourceTreeSha256: current.sourceTreeSha256,
        sourceManifestPath,
        sourceManifestSha256,
      });
    } catch (error) {
      await context.writeArtifactJsonInternal("mobile-pinned-deployment-source-postflight.json", {
        unchanged: false,
        error: context.redactText(error?.message || String(error)),
      }).catch(() => {});
      throw error;
    }
  });

  const deployment = await materializeArchivedMobileWebDeployment(context, {
    mobileWeb,
    sourcePins,
    outputName,
  });
  await context.writeArtifactJson("mobile-pinned-gateway-deployment-provenance.json", {
    sourceIdentity,
    sourcePins,
    deployment,
  });
  return { mobileWeb, deployment, sourceIdentity, sourcePins };
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} is required; exports are not created by this helper`);
  assert.ok(isAbsolute(value), `${name} must be an explicit absolute path`);
  return resolve(value);
}

function requiredSha256(name) {
  const value = process.env[name];
  assert.match(value ?? "", sha256Pattern, `${name} must be an explicit lowercase SHA-256 pin`);
  return value;
}

function assertRunContext(context) {
  assert.ok(context && typeof context === "object", "RunContext is required");
  assert.ok(typeof context.stateDir === "string" && isAbsolute(context.stateDir), "RunContext state directory is required");
  assert.equal(typeof context.pathInState, "function", "RunContext state path helper is required");
  assert.equal(typeof context.addCleanup, "function", "RunContext cleanup registration is required");
  assert.equal(typeof context.writeArtifactJson, "function", "RunContext artifact writer is required");
  assert.equal(typeof context.writeArtifactJsonInternal, "function", "RunContext cleanup artifact writer is required");
  assert.equal(typeof context.redactText, "function", "RunContext redactor is required");
}

function assertSlug(value) {
  assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "outputName must be a safe RunContext slug");
}
