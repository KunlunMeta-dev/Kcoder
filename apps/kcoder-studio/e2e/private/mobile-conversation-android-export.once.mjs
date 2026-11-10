import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { appRoot, runE2E } from "../harness/run-context.mjs";
import { fingerprintSharedAssets } from "../harness/settings-fingerprints.mjs";

const REQUIRED_ASSETS = [
  { path: "fonts/noto-sans-sc/NotoSansSC-Regular.otf", ext: "otf" },
  { path: "fonts/noto-sans-sc/NotoSansSC-Bold.otf", ext: "otf" },
  { path: "fonts/noto-sans-sc/OFL.txt", ext: "txt", fullOfl: true },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeBundlePath(value) {
  assert.equal(typeof value, "string", "Android asset path must be a string");
  assert.ok(value.length > 0 && !value.startsWith("/") && !value.includes("\\"), "Android asset path must be relative");
  const parts = value.split("/");
  assert.ok(parts.every(part => part && part !== "." && part !== ".."), "Android asset path contains a traversal segment");
  return parts.join("/");
}

function assertCompleteOfl(bytes) {
  const text = bytes.toString("utf8");
  assert.ok(bytes.length >= 4_000, "OFL.txt must contain the complete OFL 1.1 text");
  assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(text, /Permission is hereby granted, free of charge/);
  assert.match(text, /THE FONT SOFTWARE IS PROVIDED "AS IS"/);
  assert.match(text, /This license is copied below/);
}

await runE2E(import.meta.url, {
  testId: "mobile-conversation-android-js-assets-export",
  tier: "manual-live",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: "offline Android Metro JS/assets export only; no Gateway, provider, model, signing, native build, or install",
}, async context => {
  const mobileRoot = resolve(appRoot, "mobile");
  const sharedAssetsRoot = resolve(appRoot, "shared/assets");
  const fontRoot = resolve(sharedAssetsRoot, "fonts/noto-sans-sc");
  const sharedAssetsBefore = await fingerprintSharedAssets(sharedAssetsRoot);
  const sourceEntries = new Map(sharedAssetsBefore.entries.map(entry => [entry.path, entry]));

  const sourceEvidence = [];
  for (const asset of REQUIRED_ASSETS) {
    const sourceEntry = sourceEntries.get(asset.path);
    assert.ok(sourceEntry, `required bundled source asset is missing: ${asset.path}`);
    const sourceBytes = await readFile(resolve(sharedAssetsRoot, asset.path));
    assert.equal(sha256(sourceBytes), sourceEntry.sha256, `source asset changed while recording: ${asset.path}`);
    if (asset.fullOfl) {
      assertCompleteOfl(sourceBytes);
      const upstreamLicense = await readFile(resolve(fontRoot, "LICENSE"));
      assert.deepEqual(sourceBytes, upstreamLicense, "OFL.txt must be the complete bundled LICENSE copy");
    }
    sourceEvidence.push({ ...asset, size: sourceEntry.size, sha256: sourceEntry.sha256 });
  }
  await context.writeArtifactJson("android-font-assets-source.json", {
    sharedAssetsDigest: sharedAssetsBefore.digest,
    notoSansScDigest: sharedAssetsBefore.notoSansSc.digest,
    assets: sourceEvidence,
  });

  const exported = await exportMobileWeb(context, {
    mobileRoot,
    label: "conversation-android",
    outputName: "conversation-android-js-assets",
    timeoutMs: 10 * 60_000,
    platform: "android",
  });
  assert.equal(exported.platform, "android");

  const metadataPath = resolve(exported.path, "metadata.json");
  const metadataBytes = await readFile(metadataPath);
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  const metadataRecord = exported.bundleFiles.find(file => file.path === "metadata.json");
  assert.ok(metadataRecord, "Android metadata.json must appear in the export inventory");
  assert.equal(sha256(metadataBytes), metadataRecord.sha256, "Android metadata digest must match the export inventory");
  await context.writeArtifactJson("android-export-metadata.json", metadata);
  assert.equal(metadata.bundler, "metro");
  const androidMetadata = metadata.fileMetadata?.android;
  assert.ok(androidMetadata && Array.isArray(androidMetadata.assets), "Android Metro metadata must list exported assets");
  const bundlePath = safeBundlePath(androidMetadata.bundle);
  const bundleRecord = exported.bundleFiles.find(file => file.path === bundlePath);
  assert.ok(bundleRecord && bundleRecord.size > 0, "Android JS bundle must be present in the export");

  const exportedAssets = [];
  for (const source of sourceEvidence) {
    const matches = androidMetadata.assets.filter(asset => asset.ext === source.ext);
    const verified = [];
    for (const asset of matches) {
      const assetPath = safeBundlePath(asset.path);
      const outputRecord = exported.bundleFiles.find(file => file.path === assetPath);
      if (!outputRecord) continue;
      const outputBytes = await readFile(resolve(exported.path, assetPath));
      const outputSha256 = sha256(outputBytes);
      if (outputSha256 === source.sha256) {
        assert.equal(outputRecord.sha256, source.sha256, `export inventory digest differs for ${source.path}`);
        verified.push({ path: assetPath, ext: asset.ext, size: outputBytes.length, sha256: outputSha256 });
      }
    }
    assert.ok(verified.length > 0, `Android export is missing the exact source asset: ${source.path}`);
    exportedAssets.push({ sourcePath: source.path, sourceSha256: source.sha256, exported: verified });
  }
  const sharedAssetsAfter = await fingerprintSharedAssets(sharedAssetsRoot);
  assert.deepEqual(sharedAssetsAfter, sharedAssetsBefore, "shared assets changed during the Android export check");

  const evidence = {
    resultType: "android-js-assets-export",
    platform: "android",
    bundleSha256: exported.bundleSha256,
    bundleFileCount: exported.bundleFileCount,
    outputRetainedAfterRun: false,
    androidMetadataSha256: sha256(metadataBytes),
    androidBundle: { path: bundlePath, sha256: bundleRecord.sha256, size: bundleRecord.size },
    sourceTreeSha256: exported.sourceTreeSha256,
    dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
    sourceSnapshotMatches: true,
    sourceAndDependenciesUnchanged: true,
    sharedAssetsDigest: sharedAssetsBefore.digest,
    notoSansScDigest: sharedAssetsBefore.notoSansSc.digest,
    fontAssets: exportedAssets,
    nativeBuild: false,
    signed: false,
    installed: false,
    gatewayOrModelRequest: false,
  };
  await context.writeArtifactJson("android-font-assets-export.json", evidence);
  return evidence;
});
