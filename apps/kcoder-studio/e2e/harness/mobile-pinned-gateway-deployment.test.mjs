import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { archiveMobileWebExport, inspectMobileWebExportSourceIdentity } from "./mobile-web-export-archive.mjs";
import { restorePinnedGatewayMobileDeployment } from "./mobile-pinned-gateway-deployment.mjs";

const ENV_NAMES = [
  "KCODER_E2E_MOBILE_SOURCE_ROOT",
  "KCODER_E2E_MOBILE_SOURCE_MANIFEST",
  "KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256",
  "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE",
  "KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256",
];

test("restores an explicitly pinned Mobile archive into a production Gateway mount and postflights its inputs", async t => {
  const fixture = await createFixture(t);
  withPins(fixture, t);

  const result = await restorePinnedGatewayMobileDeployment(fixture.context, {
    outputName: "receipt-test-deployment",
  });

  assert.equal(result.mobileWeb.inputKind, "verified-readonly-data-archive");
  assert.equal(result.mobileWeb.archivePath, fixture.archive.path);
  assert.equal(result.mobileWeb.archiveSha256, fixture.archive.sha256);
  assert.equal(result.sourceIdentity.snapshotProof.manifestPath, fixture.sourceManifestPath);
  assert.equal(result.sourcePins.sourceManifestSha256, fixture.sourceManifestSha256);
  assert.equal(result.deployment.path, fixture.context.pathInState("receipt-test-deployment"));
  assert.equal(result.deployment.inventoryVerifiedAgainstArchive, true);
  assert.equal(result.deployment.resourceCount, 2);
  assert.equal(result.deployment.physicalFileCount, 3);
  assert.equal(fixture.context.cleanups.length, 2);
  assert.equal(fixture.context.temporaryDirectories.length, 2);

  const deploymentManifest = JSON.parse(await readFile(result.deployment.manifestPath, "utf8"));
  assert.deepEqual(
    deploymentManifest.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    result.mobileWeb.bundleFiles,
  );
  for (const cleanup of [...fixture.context.cleanups].reverse()) await cleanup.callback();
  assert.equal(fixture.context.artifacts.get("mobile-pinned-deployment-archive-postflight.json")?.unchanged, true);
  assert.equal(fixture.context.artifacts.get("mobile-pinned-deployment-source-postflight.json")?.unchanged, true);
  assert.ok(fixture.context.artifacts.has("mobile-pinned-gateway-deployment-provenance.json"));
});

test("requires every explicit source and archive pin before restoring any files", async t => {
  const fixture = await createFixture(t);
  withPins(fixture, t);
  delete process.env.KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256;
  t.after(() => restoreEnvironment(fixture.originalEnvironment));

  await assert.rejects(
    restorePinnedGatewayMobileDeployment(fixture.context),
    /KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256 must be an explicit lowercase SHA-256 pin/,
  );
  assert.equal(fixture.context.temporaryDirectories.length, 0);
  assert.equal(fixture.context.cleanups.length, 0);
});

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mobile-pinned-gateway-deployment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "frozen-source");
  const mobileRoot = join(sourceRoot, "apps/kcoder-studio/mobile");
  const sharedRoot = join(sourceRoot, "apps/kcoder-studio/shared");
  const artifactsDir = join(root, "artifacts");
  const stateDir = join(root, "state");
  await Promise.all([
    mkdir(join(mobileRoot, "src"), { recursive: true, mode: 0o700 }),
    mkdir(join(mobileRoot, "scripts"), { recursive: true, mode: 0o700 }),
    mkdir(sharedRoot, { recursive: true, mode: 0o700 }),
    mkdir(join(stateDir, "mobile-web-export", "assets"), { recursive: true, mode: 0o700 }),
    mkdir(artifactsDir, { recursive: true, mode: 0o700 }),
  ]);
  const sourceFiles = [
    ["apps/kcoder-studio/mobile/scripts/build.mjs", "export const build = true;\n"],
    ["apps/kcoder-studio/mobile/src/index.ts", "export const app = true;\n"],
    ["apps/kcoder-studio/shared/contracts.ts", "export type Contract = string;\n"],
  ];
  for (const [path, body] of sourceFiles) {
    const fullPath = join(sourceRoot, path);
    await writeFile(fullPath, body);
  }
  const sourceManifestPath = join(root, "mobile-source-manifest.json");
  const sourceManifest = {
    kind: "owned-readonly-p1-mobile-and-shared-input",
    sourceRoot,
    mobileRoot,
    sharedRoot,
    head: "a".repeat(40),
    files: sourceFiles.map(([path, body]) => ({
      path,
      bytes: Buffer.byteLength(body),
      sha256: sha256(Buffer.from(body)),
    })).sort(comparePath),
  };
  const sourceManifestBytes = Buffer.from(JSON.stringify(sourceManifest));
  await writeFile(sourceManifestPath, sourceManifestBytes, { mode: 0o400 });
  const sourceManifestSha256 = sha256(sourceManifestBytes);
  const sourceRoots = [
    { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
  ];
  const sourceIdentity = await inspectMobileWebExportSourceIdentity({
    sourceRoots,
    snapshotManifestPath: sourceManifestPath,
    expectedSnapshotManifestSha256: sourceManifestSha256,
  });

  const bundleRoot = join(stateDir, "mobile-web-export");
  await writeFile(join(bundleRoot, "index.html"), '<script src="/__kcoder_mobile_mount_v1__/app.js"></script>');
  await writeFile(join(bundleRoot, "assets/chunk.js"), "window.fixture = true;");
  const bundleFiles = await Promise.all([resource(bundleRoot, "index.html"), resource(bundleRoot, "assets/chunk.js")]);
  bundleFiles.sort(comparePath);
  const bundleSha256 = hashJson(bundleFiles);
  const bundleManifestPath = join(artifactsDir, "mobile-web-export-manifest.json");
  const manifest = {
    schemaVersion: 2,
    status: "complete",
    failurePhase: null,
    inputRoots: sourceIdentity.sourceRoots,
    inputRootsAfter: sourceIdentity.sourceRoots,
    sourceHashExclusions: [".env and credential files", ".expo", ".git", "dist", "node_modules"],
    sourceTreeSha256: sourceIdentity.sourceTreeSha256,
    sourceHashBefore: sourceIdentity.sourceTreeSha256,
    sourceHashAfter: sourceIdentity.sourceTreeSha256,
    ownedOutputRelativePath: "state/mobile-web-export",
    buildInputTreeBeforeCopySha256: sourceIdentity.sourceTreeSha256,
    buildInputTreeAfterCopySha256: sourceIdentity.sourceTreeSha256,
    buildInputTreeBeforeTerminalSha256: sourceIdentity.sourceTreeSha256,
    buildInputTreeBeforeTerminalExcludingGeneratedSha256: sourceIdentity.sourceTreeSha256,
    buildInputTreeAfterTerminalSha256: "c".repeat(64),
    buildInputTreeAfterExportSha256: "c".repeat(64),
    sourceUnchanged: true,
    snapshotCopyMatchesSource: true,
    terminalHookChangesOnlyGeneratedHtml: true,
    snapshotUnchangedDuringExport: true,
    dependencyProvenance: {
      sourceRoot: "/fixture/dependencies",
      sourceTreeSha256Before: "d".repeat(64),
      sourceTreeSha256After: "d".repeat(64),
      sourceUnchanged: true,
      copiedTreeSha256: "e".repeat(64),
      copiedFileCount: 1,
      copiedSymlinks: false,
    },
    exportStartedAtUtc: "2026-10-10T00:00:00.000Z",
    exportCompletedAtUtc: "2026-10-10T00:00:01.000Z",
    exporterPid: 1234,
    deployMount: true,
    bundleSha256,
    bundleFileCount: bundleFiles.length,
    indexHtmlSha256: bundleFiles.find(file => file.path === "index.html").sha256,
    bundleFiles,
    overallDeadline: { outcome: "completed" },
    verificationFailures: [],
    error: null,
  };
  await writeFile(bundleManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const context = makeContext(root, stateDir, artifactsDir);
  const exportResult = {
    path: bundleRoot,
    sourceTreeSha256: sourceIdentity.sourceTreeSha256,
    buildInputTreeSha256: sourceIdentity.sourceTreeSha256,
    dependencySourceTreeSha256: "d".repeat(64),
    dependencyOwnedTreeSha256: "e".repeat(64),
    bundleSha256,
    bundleFileCount: bundleFiles.length,
    bundleFiles,
    bundleManifestPath,
  };
  const archive = await archiveMobileWebExport(context, { exportResult, sourceIdentity });
  return {
    context,
    archive,
    sourceRoot: mobileRoot,
    sourceManifestPath,
    sourceManifestSha256,
    originalEnvironment: Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]])),
  };
}

function makeContext(runRoot, stateDir, artifactsDir) {
  const cleanups = [];
  const temporaryDirectories = [];
  const artifacts = new Map();
  return {
    runRoot,
    stateDir,
    artifactsDir,
    cleanups,
    temporaryDirectories,
    artifacts,
    pathInState(...parts) { return resolve(stateDir, ...parts); },
    pathInArtifacts(...parts) { return resolve(artifactsDir, ...parts); },
    registerTemporaryDirectory(label, path) { temporaryDirectories.push({ label, path: resolve(path) }); },
    addCleanup(label, callback) { cleanups.push({ label, callback }); },
    async writeArtifactJson(name, value) { artifacts.set(name, value); },
    async writeArtifactJsonInternal(name, value) { artifacts.set(name, value); },
    redactText(value) { return String(value); },
  };
}

function withPins(fixture, t) {
  fixture.originalEnvironment = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  process.env.KCODER_E2E_MOBILE_SOURCE_ROOT = fixture.sourceRoot;
  process.env.KCODER_E2E_MOBILE_SOURCE_MANIFEST = fixture.sourceManifestPath;
  process.env.KCODER_E2E_MOBILE_SOURCE_MANIFEST_SHA256 = fixture.sourceManifestSha256;
  process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE = fixture.archive.path;
  process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256 = fixture.archive.sha256;
  t.after(() => restoreEnvironment(fixture.originalEnvironment));
}

function restoreEnvironment(environment) {
  for (const name of ENV_NAMES) {
    if (environment[name] === undefined) delete process.env[name];
    else process.env[name] = environment[name];
  }
}

async function resource(root, path) {
  const bytes = await readFile(join(root, path));
  return { path, size: bytes.length, sha256: sha256(bytes) };
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparePath(left, right) {
  return left.path.localeCompare(right.path);
}
