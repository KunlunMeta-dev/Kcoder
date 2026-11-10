import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { copyFrozenMobileWeb } from "../harness/frozen-copy.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { appRoot, runE2E } from "../harness/run-context.mjs";
import {
  fingerprintRegularFile,
  fingerprintRegularTree,
  fingerprintSharedAssets,
} from "../harness/settings-fingerprints.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";

process.umask(0o077);

// Prepare the real product bundle and bind it to source and a RunContext-owned
// full dependency snapshot before the registered settings suites consume it.
await runE2E(import.meta.url, {
  testId: "mobile-current-product-build-diagnostic",
  tier: "manual-live",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: "offline Mobile Web product build from a RunContext-owned full dependency snapshot; no Gateway, Provider or model request",
}, async context => {
  const sourceHeadPin = process.env.KCODER_E2E_SETTINGS_SOURCE_HEAD;
  if (sourceHeadPin !== undefined) {
    assert.match(sourceHeadPin, /^[a-f0-9]{40}$/, "KCODER_E2E_SETTINGS_SOURCE_HEAD must be a full lowercase Git SHA");
    assert.equal(context.gitCommit, sourceHeadPin, "Mobile settings acceptance source HEAD differs from the caller pin");
  }
  const mobile = resolve(appRoot, "mobile");
  const shared = resolve(appRoot, "shared");
  const mobileSource = resolve(mobile, "src");
  const sharedGenerated = resolve(shared, "generated");

  const mobileBefore = await fingerprintRegularTree(mobileSource);
  await context.writeArtifactJson("mobile-source-before.json", mobileBefore);
  const sharedBefore = await fingerprintRegularTree(sharedGenerated);
  await context.writeArtifactJson("shared-source-before.json", sharedBefore);
  // Keep asset and conversation-reading inputs visible outside the generated-contract fingerprint.
  const sharedAssetsRoot = resolve(appRoot, "shared/assets");
  const sharedAssetsBefore = await fingerprintSharedAssets(sharedAssetsRoot);
  await context.writeArtifactJson("shared-assets-before.json", sharedAssetsBefore);
  const sharedCodeRoot = resolve(appRoot, "shared");
  const readingContractBefore = await fingerprintRegularFile(sharedCodeRoot, "conversationReading.ts");
  await context.writeArtifactJson("shared-reading-contract-before.json", readingContractBefore);

  let previousPhase = "";
  const exported = await exportMobileWeb(context, {
    mobileRoot: mobile,
    sourceRoots: [
      { name: "mobile", path: mobile, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: shared, destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot: resolve(mobile, "node_modules"),
    label: "settings-mobile-web",
    outputName: "settings-mobile-web-export",
    deployMount: true,
    timeoutMs: 10 * 60_000,
    overallTimeoutMs: 45 * 60_000,
    onProgress: progress => {
      const phase = progress.phase ?? progress.event ?? "progress";
      if (phase !== previousPhase) {
        console.log(`[mobile-web-export] ${phase}`);
        previousPhase = phase;
      }
    },
  });

  const mobileAfter = await fingerprintRegularTree(mobileSource);
  await context.writeArtifactJson("mobile-source-after.json", mobileAfter);
  assert.deepEqual(mobileAfter, mobileBefore, "Mobile source inventory changed during export");
  const sharedAfter = await fingerprintRegularTree(sharedGenerated);
  await context.writeArtifactJson("shared-source-after.json", sharedAfter);
  assert.deepEqual(sharedAfter, sharedBefore, "shared generated inventory changed during export");
  const sharedAssetsAfter = await fingerprintSharedAssets(sharedAssetsRoot);
  await context.writeArtifactJson("shared-assets-after.json", sharedAssetsAfter);
  assert.deepEqual(sharedAssetsAfter, sharedAssetsBefore, "Shared assets changed during Mobile build");
  const readingContractAfter = await fingerprintRegularFile(sharedCodeRoot, "conversationReading.ts");
  await context.writeArtifactJson("shared-reading-contract-after.json", readingContractAfter);
  assert.deepEqual(readingContractAfter, readingContractBefore, "Shared reading contract changed during Mobile build");

  const output = context.pathInArtifacts("mobile-web");
  const copyProof = await copyFrozenMobileWeb({
    sourceRoot: exported.path,
    destination: output,
    expectedBundleSha256: exported.bundleSha256,
    manifestPath: exported.bundleManifestPath,
    expectedSourceTreeSha256: exported.sourceTreeSha256,
    expectedDependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    expectedDependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
  });
  const gatewayManifest = await buildGatewayMobileWebManifest(output, {
    expectedFiles: exported.bundleFiles,
  });
  await writeGatewayMobileWebManifest(output, gatewayManifest);
  const manifestBytes = await readFile(resolve(output, "kcoder-mobile-web.json"));
  const appManifest = JSON.parse(manifestBytes);
  assert.equal(appManifest.version, 1);
  assert.equal(appManifest.baseToken, "/__kcoder_mobile_mount_v1__");
  const manifestResourceFiles = appManifest.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  assert.deepEqual(manifestResourceFiles, exported.bundleFiles,
    "official Gateway mount manifest must inventory the exact exporter resource bundle");
  const retainedInventory = await fingerprintRegularTree(output);
  const retainedResourceFiles = retainedInventory.entries
    .filter(entry => entry.path !== "kcoder-mobile-web.json")
    .map(({ path, size, sha256 }) => ({ path, size, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(retainedResourceFiles, exported.bundleFiles,
    "retained resource bytes must remain identical to the Expo export after sidecar generation");
  assert.equal(retainedInventory.entries.length, exported.bundleFileCount + 1,
    "retained deploy bundle must contain the Expo resources and one Gateway sidecar");
  const exporterManifestBytes = await readFile(exported.bundleManifestPath);
  const appManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const provenance = {
    schemaVersion: 1,
    testId: "mobile-current-product-build-diagnostic",
    output,
    manifestSha256: appManifestSha256,
    mobileSourceDigest: mobileBefore.digest,
    mobileSourceUnchanged: true,
    sharedSourceDigest: sharedBefore.digest,
    sharedAssetsDigest: sharedAssetsBefore.digest,
    sharedAssetsFileCount: sharedAssetsBefore.entries.length,
    notoSansScFontSourceDigest: sharedAssetsBefore.notoSansSc.digest,
    notoSansScFontSourceFiles: sharedAssetsBefore.notoSansSc.entries,
    sharedReadingContractDigest: readingContractBefore.digest,
    frozenDependencyIntegration: false,
    sourceHead: context.gitCommit,
    evidenceClass: "real current-source Mobile Web export prepared for consumption by the settings suites",
    mobileSource: { root: mobileSource, inventorySha256: mobileBefore.digest, entries: mobileBefore.entries.length },
    sharedGeneratedSource: { root: sharedGenerated, inventorySha256: sharedBefore.digest, entries: sharedBefore.entries.length },
    exporter: {
      manifestPath: exported.bundleManifestPath,
      manifestSha256: createHash("sha256").update(exporterManifestBytes).digest("hex"),
      sourceTreeSha256: exported.sourceTreeSha256,
      buildInputTreeSha256: exported.buildInputTreeSha256,
      bundleSha256: exported.bundleSha256,
      bundleFileCount: exported.bundleFileCount,
      indexHtmlSha256: exported.indexHtmlSha256,
    },
    dependencies: {
      sourceRoot: exported.dependencyRoot,
      sourceTreeSha256Before: exported.dependencySourceTreeSha256,
      copiedTreeSha256: exported.dependencyOwnedTreeSha256,
      physicallyCopiedIntoRunContext: true,
      unchangedDuringExport: true,
    },
    retainedBundle: {
      root: output,
      fullRegularTreeSha256: retainedInventory.digest,
      fullRegularTreeFileCount: retainedInventory.entries.length,
      appManifest: {
        path: resolve(output, "kcoder-mobile-web.json"),
        sha256: appManifestSha256,
        generator: "apps/kcoder-studio/mobile/scripts/gateway-mobile-web-manifest.mjs",
        resourceCount: gatewayManifest.files.length,
        filesMatchExporterBundle: true,
      },
      deployMount: true,
      exporterBundleSha256: copyProof.bundleSha256,
      exporterFileCount: copyProof.fileCount,
      copyStatus: copyProof.status,
    },
    sourceUnchangedDuringExport: true,
    nativeBuildOrRuntimeClaim: false,
    modelOrProviderRequest: false,
  };
  await context.writeArtifactJson("mobile-web-provenance.json", provenance);
  return provenance;
});
