import assert from "node:assert/strict";
import { resolve } from "node:path";
import { appRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import {
  fingerprintRegularFile,
  fingerprintRegularTree,
  fingerprintRendererSource,
  fingerprintSharedAssets,
} from "../harness/settings-fingerprints.mjs";

// Type checking is a separate verification gate. This diagnostic builds current
// product assets and binds their bytes to the source inventory used by the suite.
await runE2E(import.meta.url, {
  testId: "renderer-current-product-build-diagnostic",
  tier: "manual-live",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: "offline renderer product build; no Gateway, Provider or model request",
}, async context => {
  const renderer = resolve(appRoot, "renderer");
  const before = await fingerprintRendererSource(renderer);
  await context.writeArtifactJson("renderer-source-before.json", before);
  const sharedRoot = resolve(appRoot, "shared/generated");
  const sharedBefore = await fingerprintRegularTree(sharedRoot);
  await context.writeArtifactJson("shared-source-before.json", sharedBefore);
  // This separate inventory records shared assets, including local fonts,
  // without claiming they are covered by the generated-contract source digest.
  const sharedAssetsRoot = resolve(appRoot, "shared/assets");
  const sharedAssetsBefore = await fingerprintSharedAssets(sharedAssetsRoot);
  await context.writeArtifactJson("shared-assets-before.json", sharedAssetsBefore);
  const sharedCodeRoot = resolve(appRoot, "shared");
  const readingContractBefore = await fingerprintRegularFile(sharedCodeRoot, "conversationReading.ts");
  await context.writeArtifactJson("shared-reading-contract-before.json", readingContractBefore);
  const output = context.pathInArtifacts("renderer-web");
  const child = context.spawnOwned("renderer-product-build", process.execPath, [
    resolve(renderer, "node_modules/vite/bin/vite.js"),
    "build", "--outDir", output, "--emptyOutDir",
  ], {
    cwd: renderer,
    env: context.isolatedEnvironment({ CI: "1" }),
  });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null,
    45 * 60_000, "normal renderer product build", 100, context.abortSignal);
  assert.equal(child.signalCode, null);
  assert.equal(child.exitCode, 0, "normal renderer product build must complete");
  const after = await fingerprintRendererSource(renderer);
  await context.writeArtifactJson("renderer-source-after.json", after);
  assert.deepEqual(after, before, "Renderer implementation changed during build");
  const sharedAfter = await fingerprintRegularTree(sharedRoot);
  await context.writeArtifactJson("shared-source-after.json", sharedAfter);
  assert.deepEqual(sharedAfter, sharedBefore, "Shared contracts changed during Renderer build");
  const sharedAssetsAfter = await fingerprintSharedAssets(sharedAssetsRoot);
  await context.writeArtifactJson("shared-assets-after.json", sharedAssetsAfter);
  assert.deepEqual(sharedAssetsAfter, sharedAssetsBefore, "Shared assets changed during Renderer build");
  const readingContractAfter = await fingerprintRegularFile(sharedCodeRoot, "conversationReading.ts");
  await context.writeArtifactJson("shared-reading-contract-after.json", readingContractAfter);
  assert.deepEqual(readingContractAfter, readingContractBefore, "Shared reading contract changed during Renderer build");
  const assets = await fingerprintRegularTree(output);
  await context.writeArtifactJson("renderer-assets.json", assets);
  assert(assets.entries.some(entry => entry.path === "index.html"));
  return {
    output,
    sourceDigest: before.digest,
    outputDigest: assets.digest,
    sharedSourceDigest: sharedBefore.digest,
    sharedAssetsDigest: sharedAssetsBefore.digest,
    sharedAssetsFileCount: sharedAssetsBefore.entries.length,
    notoSansScFontSourceDigest: sharedAssetsBefore.notoSansSc.digest,
    notoSansScFontSourceFiles: sharedAssetsBefore.notoSansSc.entries,
    sharedReadingContractDigest: readingContractBefore.digest,
    sourceUnchanged: true,
    typecheckPerformed: false,
    prebuiltManualDiagnostic: true,
    frozenDependencyIntegration: false,
  };
});
