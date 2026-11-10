import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { archiveMobileWebExport, inspectMobileWebExportSourceIdentity, verifyMobileWebExportUnchanged } from "../harness/mobile-web-export-archive.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { runE2E } from "../harness/run-context.mjs";
const cliArgs = process.argv.slice(2);
assert.ok(
  (cliArgs.length === 1 && cliArgs[0] === "--execute") ||
    (cliArgs.length === 2 && cliArgs[0] === "--execute" && cliArgs[1] === "--deploy-mount"),
  "manual Mobile Web export preflight requires --execute and accepts only an optional --deploy-mount flag",
);
const deployMount = cliArgs.includes("--deploy-mount");
const progressPhases = new Set((
  "resolve-inputs dependency-symlink-check dependency-hash-before source-hash-before prepare-owned-state copy-source " +
  "snapshot-hash-after-copy copy-dependencies owned-dependency-hash prepare-terminal-build terminal-build terminal-build-verification " +
  "snapshot-hash-before-export expo-export source-hash-after snapshot-hash-after-export dependency-hash-after bundle-hash"
).split(/\s+/));
await runE2E(import.meta.url, {
  testId: "mobile-session-cache-web-export-preflight",
  tier: "full-integration",
  modelPolicy: "Mobile Web Expo export and verified data-only archive only; no Browser, Gateway, Rust app-server, cache-recovery flow, Provider, or model call",
}, async context => {
  const mobileRoot = requiredAbsolutePath("KCODER_E2E_MOBILE_SOURCE_ROOT");
  const manifestPath = requiredAbsolutePath("KCODER_E2E_MOBILE_SOURCE_MANIFEST");
  const manifestSha256 = requiredSha256("KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256");
  const dependencyRoot = requiredAbsolutePath("KCODER_E2E_MOBILE_DEPENDENCY_ROOT");
  const sourceRoots = [
    { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(mobileRoot, "../shared"), destination: "apps/kcoder-studio/shared" },
  ];
  const inspectSource = () => inspectMobileWebExportSourceIdentity({
    sourceRoots, snapshotManifestPath: manifestPath, expectedSnapshotManifestSha256: manifestSha256,
  });
  const sourceIdentity = await inspectSource();
  assert.ok(sourceIdentity.snapshotProof, "export-only preflight requires a caller-pinned immutable source snapshot");
  const mobileWeb = await exportMobileWeb(context, {
    mobileRoot,
    sourceRoots,
    dependencyRoot,
    label: "session-cache-pinned-web-export",
    outputName: "mobile-web-export",
    timeoutMs: 10 * 60_000, overallTimeoutMs: 30 * 60_000,
    deployMount,
    onProgress: progress => {
      if (!progressPhases.has(progress?.phase)) return;
      const elapsedMs = Number.isFinite(progress.elapsedMs) ? Math.max(0, Math.round(progress.elapsedMs)) : null;
      process.stdout.write(`${JSON.stringify({ phase: progress.phase, elapsedMs })}\n`);
    },
  });
  context.addCleanup("postflight verify pinned Mobile Web source, bundle, and archive", async () => {
    try {
      const sourceAfter = await inspectSource();
      assert.deepEqual(sourceAfter, sourceIdentity, "caller-pinned Mobile Web source identity changed before cleanup");
      const bundleAfter = await verifyMobileWebExportUnchanged(mobileWeb);
      await context.writeArtifactJsonInternal("mobile-web-export-postflight.json", {
        status: "PASS", sourceIdentityUnchanged: true, ...bundleAfter,
        archiveSha256: mobileWeb.archiveSha256 ?? null,
      });
    } catch (error) {
      await context.writeArtifactJsonInternal("mobile-web-export-postflight.json", {
        status: "FAIL", error: context.redactText(error?.message || String(error)),
      }).catch(() => {});
      throw error;
    }
  });
  const sourceAfterExport = await inspectSource();
  assert.deepEqual(sourceAfterExport, sourceIdentity, "source identity changed during Mobile Web export");
  assert.equal(mobileWeb.sourceTreeSha256, sourceIdentity.sourceTreeSha256,
    "completed Mobile Web export does not match the caller-pinned source tree");
  const sealed = await archiveMobileWebExport(context, { exportResult: mobileWeb, sourceIdentity });
  mobileWeb.archivePath = sealed.path;
  mobileWeb.archiveSha256 = sealed.sha256;
  const provenance = {
    status: "PASS_EXPORT_ONLY",
    boundary: "verified Mobile Web source/export/archive only; no Browser, Gateway, Rust app-server, cache recovery, Provider, or model evidence",
    sourceIdentity,
    dependency: {
      root: mobileWeb.dependencyRoot, sourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
      ownedTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
      provenance: "export-time input and owned-copy hashes from the original export manifest",
    },
    export: {
      deployMount,
      bundlePath: mobileWeb.path, bundleSha256: mobileWeb.bundleSha256, bundleFileCount: mobileWeb.bundleFileCount,
      originalManifestPath: mobileWeb.bundleManifestPath, originalManifestSha256: sealed.originalManifestSha256,
    },
    archive: {
      path: sealed.path, sha256: sealed.sha256, size: sealed.size, bundleSha256: sealed.bundleSha256,
      resourceCount: sealed.resourceCount, totalResourceBytes: sealed.totalResourceBytes,
      mode: sealed.archiveMode, dependencyProvenanceIsHistorical: sealed.dependencyProvenanceIsHistorical,
    },
  };
  await context.writeArtifactJson("mobile-session-cache-web-export-provenance.json", provenance);
  return provenance;
});

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && isAbsolute(value), `${name} must be an explicit absolute input path`);
  return resolve(value);
}

function requiredSha256(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), `${name} must be an explicit lowercase SHA-256 pin`);
  return value;
}
