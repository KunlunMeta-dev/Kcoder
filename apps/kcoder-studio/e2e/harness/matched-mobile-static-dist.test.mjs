import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  inspectMatchedMobileWebExport,
  materializeMatchedMobileStaticDist,
} from "./matched-mobile-static-dist.mjs";
import { repoRoot } from "./run-context.mjs";

const fixtureInputRoots = [
  { name: "mobile", destination: "apps/kcoder-studio/mobile", sha256: "a".repeat(64), fileCount: 350 },
  { name: "studio-shared", destination: "apps/kcoder-studio/shared", sha256: "b".repeat(64), fileCount: 19 },
];
const fixtureDependencySource = "c".repeat(64);
const fixtureDependencyOwned = "d".repeat(64);
const fixtureDependencyCount = 17;
const fixtureSourceTreeSha256 = sourceAggregate(fixtureInputRoots);

test("matched Mobile export validates the exact manifest, bundle and source/dependency pins before copying", async () => {
  await withMatchedFixture(async fixture => {
    await withFakeContext(fixture.root, async context => {
      const inspected = await inspectMatchedMobileWebExport(fixture.input);
      assert.equal(inspected.manifestSha256, fixture.input.expectedExportManifestSha256);
      assert.equal(inspected.bundleSha256, fixture.input.expectedBundleSha256);
      assert.equal(inspected.sourceTreeSha256, fixture.input.expectedSourceTreeSha256);
      assert.equal(inspected.bundleFiles.length, 37);

      const copied = await materializeMatchedMobileStaticDist(context, fixture.input);
      assert.equal(copied.inputKind, "matched-export-derived-deploy-mount-manifest");
      assert.equal(copied.sourceExportManifestSha256, fixture.input.expectedExportManifestSha256);
      assert.equal(copied.sourceBundleSha256, fixture.input.expectedBundleSha256);
      assert.equal(copied.manifestSha256, copied.matchedEvidence.derivedManifestSha256);
      assert.equal(copied.resourceCount, 37);
      assert.equal(copied.ownedCopyVerified, true);
      assert.equal(copied.sourceStableDuringCopy, true);
      assert.equal(copied.bundleFiles.length, 37);
      assert.equal(copied.matchedEvidence.claimBoundary.includes("not an official Expo RunContext receipt"), true);
      assert.equal(context.artifacts.get("matched-deploy-mounted-mobile-dist.json").inputKind, copied.inputKind);
      assert.deepEqual(context.registered.map(row => row.path), [
        join(context.stateDir, "matched-mobile-static-dist-source"),
        copied.ownedRoot,
      ]);
      assert.equal(copied.ownedRoot.startsWith(`${context.stateDir}/`), true);
      assert.equal((await lstat(copied.ownedRoot)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(copied.ownedRoot, "index.html"))).mode & 0o777, 0o600);
      const derived = JSON.parse(await readFile(join(copied.ownedRoot, "kcoder-mobile-web.json"), "utf8"));
      assert.equal(derived.files.length, 37);
      assert.equal(derived.baseToken, "/__kcoder_mobile_mount_v1__");

      await cleanupRegistered(context);
      assert.deepEqual(await readdir(context.stateDir), [], "registered matched materializations must be removable during RunContext cleanup");
    });
  });
});

test("matched Mobile export rejects a manifest SHA mismatch before allocating RunContext state", async () => {
  await withMatchedFixture(async fixture => {
    await withFakeContext(fixture.root, async context => {
      await assert.rejects(materializeMatchedMobileStaticDist(context, {
        ...fixture.input,
        expectedExportManifestSha256: "f".repeat(64),
      }), /manifest SHA-256 changed/);
      assert.deepEqual(context.registered, []);
      assert.deepEqual(await readdir(context.stateDir), []);
    });
  });
});

test("matched Mobile export rejects an extra bundle file", async () => {
  await withMatchedFixture(async fixture => {
    await writeFile(join(fixture.bundleRoot, "unlisted.txt"), "extra", { mode: 0o600 });
    await withFakeContext(fixture.root, async context => {
      await assert.rejects(materializeMatchedMobileStaticDist(context, fixture.input), /file set or per-file SHA-256 differs/);
      assert.deepEqual(context.registered, []);
    });
  });
});

test("matched Mobile export rejects a symlinked bundle resource", async () => {
  await withMatchedFixture(async fixture => {
    const row = fixture.bundleFiles[1];
    const resourcePath = join(fixture.bundleRoot, row.path);
    const externalPath = join(fixture.root, "outside-resource.bin");
    await writeFile(externalPath, await readFile(resourcePath), { mode: 0o600 });
    await rm(resourcePath);
    await symlink(externalPath, resourcePath);
    await withFakeContext(fixture.root, async context => {
      await assert.rejects(materializeMatchedMobileStaticDist(context, fixture.input), /symlink/);
      assert.deepEqual(context.registered, []);
    });
  });
});

test("matched Mobile export rejects path traversal in the pinned bundle file table", async () => {
  await withMatchedFixture(async fixture => {
    const manifest = JSON.parse(await readFile(fixture.exportManifestPath, "utf8"));
    manifest.bundleFiles[1].path = "../escape.bin";
    manifest.bundleFiles.sort((left, right) => left.path.localeCompare(right.path));
    manifest.bundleSha256 = sha256(Buffer.from(JSON.stringify(manifest.bundleFiles)));
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(fixture.exportManifestPath, bytes, { mode: 0o600 });
    await withFakeContext(fixture.root, async context => {
      await assert.rejects(materializeMatchedMobileStaticDist(context, {
        ...fixture.input,
        expectedExportManifestSha256: sha256(bytes),
        expectedBundleSha256: manifest.bundleSha256,
      }), /unsafe segment/);
      assert.deepEqual(context.registered, []);
    });
  });
});

test("matched Mobile export does not overwrite an existing RunContext staging path", async () => {
  await withMatchedFixture(async fixture => {
    await withFakeContext(fixture.root, async context => {
      const path = context.pathInState("matched-mobile-static-dist-source");
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "owned-marker"), "preserve", { mode: 0o600 });
      await assert.rejects(materializeMatchedMobileStaticDist(context, fixture.input), /staging path already exists/);
      assert.equal(await readFile(join(path, "owned-marker"), "utf8"), "preserve");
      assert.deepEqual(context.registered, []);
    });
  });
});

test("pinned matched 992 input materializes the verified 37-resource bundle", {
  skip: process.env.KCODER_E2E_MATCHED_MOBILE_DIST_SMOKE !== "1",
}, async () => {
  const comparisonRoot = join(
    repoRoot,
    "target/private-phone-ux-validation/new-common-dependencies-before10feb-after992-20261009/run-d065c8c452c648f7/comparison-9925461c",
  );
  const input = {
    bundleRoot: join(comparisonRoot, "bundle"),
    exportManifestPath: join(comparisonRoot, "export-manifest.json"),
    expectedExportManifestSha256: "f2f262624d4a2286ef31e250fb1752e02ab9a41232196b5591dafc5d8369d14d",
    expectedBundleSha256: "e4a7277de6ecb2afb8f68dee52dfdf3b5a270c0e0c2e7f46cbdba02e83e140ab",
    expectedSourceTreeSha256: "b22dbddabf802b08a4a586de178c875b576a8279efc51d142a6f1948e40dd020",
    expectedDependencySourceTreeSha256: "46b02fc5ac823118f6eb2c034ea3f1d9cbbf79b71041fc2fa848f79a9abca1c6",
    expectedDependencyOwnedTreeSha256: "51b0c6987324fa5b6dbc17d8ea34ff83dd832deaa06c9c1193f84465a89001e4",
    expectedDependencyFileCount: 52_524,
    expectedInputRoots: [
      { name: "mobile", destination: "apps/kcoder-studio/mobile", sha256: "8a0963fb62846395dcdf1162470452d20fff84eed51adb44311fb75c5d327455", fileCount: 350 },
      { name: "studio-shared", destination: "apps/kcoder-studio/shared", sha256: "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88", fileCount: 19 },
    ],
    comparisonId: "matched-992-191920-after",
  };
  await access(input.bundleRoot);
  await withTempContext(async context => {
    const output = await materializeMatchedMobileStaticDist(context, input);
    assert.equal(output.bundleSha256, input.expectedBundleSha256);
    assert.equal(output.sourceTreeSha256, input.expectedSourceTreeSha256);
    assert.equal(output.resourceCount, 37);
    assert.equal(output.ownedCopyVerified, true);
    await cleanupRegistered(context);
  });
});

async function withMatchedFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "matched-mobile-static-dist-contract-"));
  try {
    const bundleRoot = join(root, "bundle");
    await mkdir(bundleRoot, { mode: 0o700 });
    const bundleFiles = [];
    for (let index = 0; index < 37; index += 1) {
      const path = index === 0 ? "index.html" : `assets/group-${String(index % 4)}/resource-${String(index).padStart(2, "0")}.bin`;
      const bytes = index === 0
        ? Buffer.from('<!doctype html><script src="/__kcoder_mobile_mount_v1__/main.js"></script>\n')
        : Buffer.from(`matched-fixture-resource-${index}`);
      const filePath = join(bundleRoot, ...path.split("/"));
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(filePath, bytes, { mode: 0o600 });
      bundleFiles.push({ path, size: bytes.length, sha256: sha256(bytes) });
    }
    bundleFiles.sort((left, right) => left.path.localeCompare(right.path));
    const sourceTreeSha256 = fixtureSourceTreeSha256;
    const manifest = {
      schemaVersion: 2,
      status: "complete",
      failurePhase: null,
      sourceUnchanged: true,
      snapshotUnchangedDuringExport: true,
      sourceTreeSha256,
      inputRoots: fixtureInputRoots.map(rootRow => ({ ...rootRow, sourceRoot: "/matched/source" })),
      inputRootsAfter: fixtureInputRoots.map(rootRow => ({ ...rootRow, sourceRoot: "/matched/source" })),
      dependencyProvenance: {
        sourceTreeSha256Before: fixtureDependencySource,
        sourceTreeSha256After: fixtureDependencySource,
        sourceUnchanged: true,
        copiedTreeSha256: fixtureDependencyOwned,
        copiedFileCount: fixtureDependencyCount,
        copiedSymlinks: false,
      },
      bundleSha256: sha256(Buffer.from(JSON.stringify(bundleFiles))),
      bundleFileCount: bundleFiles.length,
      indexHtmlSha256: bundleFiles.find(row => row.path === "index.html").sha256,
      bundleFiles,
      deployMount: true,
    };
    const exportManifestPath = join(root, "export-manifest.json");
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(exportManifestPath, manifestBytes, { mode: 0o600 });
    const input = {
      bundleRoot,
      exportManifestPath,
      expectedExportManifestSha256: sha256(manifestBytes),
      expectedBundleSha256: manifest.bundleSha256,
      expectedSourceTreeSha256: sourceTreeSha256,
      expectedDependencySourceTreeSha256: fixtureDependencySource,
      expectedDependencyOwnedTreeSha256: fixtureDependencyOwned,
      expectedDependencyFileCount: fixtureDependencyCount,
      expectedInputRoots: fixtureInputRoots,
    };
    await callback({ root, bundleRoot, bundleFiles, exportManifestPath, input });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withFakeContext(parent, callback, { outsideStatePath = null } = {}) {
  const runRoot = join(parent, "fake-run");
  const stateDir = join(runRoot, "state");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const context = {
    runRoot,
    stateDir,
    registered: [],
    artifacts: new Map(),
    pathInState(...parts) { return outsideStatePath ?? join(stateDir, ...parts); },
    registerTemporaryDirectory(label, path) { this.registered.push({ label, path }); },
    async writeArtifactJson(name, value) { this.artifacts.set(name, value); return join(runRoot, "artifacts", name); },
  };
  try {
    await callback(context);
  } finally {
    await cleanupRegistered(context);
    await rm(runRoot, { recursive: true, force: true });
  }
}

async function withTempContext(callback) {
  const root = await mkdtemp(join(tmpdir(), "matched-mobile-static-dist-smoke-"));
  try {
    await withFakeContext(root, callback);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function cleanupRegistered(context) {
  for (const row of [...context.registered].reverse()) {
    const path = row.path;
    assert.ok(path.startsWith(`${context.stateDir}/`), "test cleanup only removes registered state children");
    await rm(path, { recursive: true, force: true });
  }
  context.registered.length = 0;
}

function sourceAggregate(roots) {
  return sha256(Buffer.from(JSON.stringify(roots.map(({ name, destination, sha256: digest }) => ({ name, destination, sha256: digest })))));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
