import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  decodeServiceWorkerCacheAssetPathname,
  waitForAnchorGeometry,
} from "../suites/mobile/mobile-session-cache-cold-process.mjs";
import { materializeArchivedMobileWebDeployment } from "./mobile-archived-deployment.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("derives a production Gateway deployment from frozen archive resources without changing the export or archive", async () => {
  await withFixture(async fixture => {
    const archiveBefore = await readFile(fixture.mobileWeb.archivePath);
    const originalResourcesBefore = await readResourceBytes(fixture.bundleRoot, fixture.rows);
    const deployment = await materializeArchivedMobileWebDeployment(fixture.context, fixture.input);

    assert.notEqual(deployment.path, fixture.bundleRoot);
    assert.equal(deployment.path.startsWith(`${fixture.stateDir}/`), true);
    assert.equal(deployment.resourceCount, fixture.rows.length);
    assert.equal(deployment.physicalFileCount, fixture.rows.length + 1);
    assert.equal(deployment.physicalFiles.length, fixture.rows.length + 1);
    assert.equal(deployment.inventoryVerifiedAgainstArchive, true);
    assert.match(deployment.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(fixture.registered.length, 1);
    assert.equal(fixture.registered[0], deployment.path);

    const manifestBytes = await readFile(deployment.manifestPath);
    assert.equal(sha256(manifestBytes), deployment.manifestSha256);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.deepEqual(
      manifest.files.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
      fixture.rows,
      "production manifest inventory must exactly match every archived resource row",
    );
    assert.equal(manifest.files.length, fixture.rows.length);
    assert.ok(manifest.files.some(row => row.path === "assets/[profileId]/screen.js"));
    assert.equal((await lstat(deployment.manifestPath)).mode & 0o777, 0o400);
    assert.deepEqual(await readFile(fixture.mobileWeb.archivePath), archiveBefore);
    assert.deepEqual(await readResourceBytes(fixture.bundleRoot, fixture.rows), originalResourcesBefore);
  });
});

test("fails closed on an invalid archived resource path before creating an external file", async () => {
  await withFixture(async fixture => {
    fixture.mobileWeb.bundleFiles[0].path = "../outside.bin";
    fixture.input.mobileWeb.bundleSha256 = sha256(Buffer.from(JSON.stringify(
      fixture.mobileWeb.bundleFiles.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    )));
    await assert.rejects(
      materializeArchivedMobileWebDeployment(fixture.context, fixture.input),
      /unsafe segment/,
    );
    await assert.rejects(lstat(join(fixture.root, "outside.bin")), { code: "ENOENT" });
    await assert.rejects(lstat(join(fixture.stateDir, "mobile-web-archived-deployment")), { code: "ENOENT" });
  });
});

test("fails closed when a frozen archived resource changes after restore", async () => {
  await withFixture(async fixture => {
    const changedPath = join(fixture.bundleRoot, fixture.rows[1].path);
    await chmod(changedPath, 0o600);
    await writeFile(changedPath, Buffer.from("changed bytes"), { mode: 0o600 });
    await assert.rejects(
      materializeArchivedMobileWebDeployment(fixture.context, fixture.input),
      /size changed|SHA-256 changed/,
    );
    await assert.rejects(lstat(join(fixture.stateDir, "mobile-web-archived-deployment")), { code: "ENOENT" });
  });
});

test("strictly decodes each CacheStorage URL segment to the manifest spelling", () => {
  assert.equal(
    decodeServiceWorkerCacheAssetPathname("/mobile/assets/%5BprofileId%5D/screen.js", "/mobile/"),
    "assets/[profileId]/screen.js",
  );
  assert.equal(decodeServiceWorkerCacheAssetPathname("/mobile/assets/a%20b.js", "/mobile/"), "assets/a b.js");
});

test("rejects encoded separators, dots, NUL, malformed escapes, and unsafe decoded segments", () => {
  const invalid = [
    "/mobile/assets%2Fprofile.js",
    "/mobile/assets%5Cprofile.js",
    "/mobile/%2e%2e/private.js",
    "/mobile/assets/file%2Ejs",
    "/mobile/assets/%00hidden.js",
    "/mobile/assets/%E0%A4%A.js",
    "/mobile/assets/%ZZ.js",
    "/mobile/assets/../private.js",
    "/mobile/assets/%252Fprivate.js",
    "/other/assets/file.js",
    "/mobile/assets/file.js?query=1",
  ];
  for (const pathname of invalid) {
    assert.equal(decodeServiceWorkerCacheAssetPathname(pathname, "/mobile/"), null, pathname);
  }
});

test("requires two consecutive same-anchor viewport geometry readings and resets on a failed reading", async () => {
  const makeGeometry = ({ offset = 100, viewportWidth = 390, intersects = true, rowDomId = "message-anchor" } = {}) => ({
    listFound: true,
    rowDomId,
    rowMatchCount: 1,
    rowIntersectsWindow: true,
    rowIntersectsList: intersects,
    viewport: { width: viewportWidth, height: 844 },
    list: { top: 100, bottom: 800, left: 0, right: 390, width: 390, height: 700 },
    host: {
      testId: "message-list",
      markedScrollHost: true,
      rect: { top: 100, bottom: 800, left: 0, right: 390, width: 390, height: 700 },
    },
    row: { offsetFromHost: offset },
  });
  const samples = [
    makeGeometry(),
    makeGeometry({ intersects: false }),
    makeGeometry(),
    makeGeometry({ viewportWidth: 400 }),
    makeGeometry({ viewportWidth: 400, offset: 99.5 }),
  ];
  let sampleIndex = 0;
  const result = await waitForAnchorGeometry({
    page: {},
    rowDomId: "message-anchor",
    expectedOffset: 100,
    label: "unit anchor geometry",
    readTranscriptViewport: async () => samples[sampleIndex++],
    assertOffsetNear(offset, expected) {
      assert.ok(Math.abs(offset - expected) <= 1, `offset ${offset} must be within one pixel of ${expected}`);
    },
  });
  assert.equal(sampleIndex, 5, "a transient good reading and an invalid middle sample must not pass convergence");
  assert.equal(result.convergence.requiredConsecutiveObservations, 2);
  assert.equal(result.convergence.minimumIntervalMs, 50);
  assert.ok(result.convergence.secondObservedAtMs - result.convergence.firstObservedAtMs >= 50);
  assert.deepEqual(result.convergence.observations.map(row => row.viewport.width), [400, 400]);
  assert.deepEqual(result.convergence.observations.map(row => row.row.offsetFromHost), [100, 99.5]);
});

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "mobile-archived-deployment-"));
  try {
    const stateDir = join(root, "state");
    const bundleRoot = join(root, "restored-export");
    const sourceRoot = join(root, "frozen-mobile-source");
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(bundleRoot, { mode: 0o700 });
    await mkdir(sourceRoot, { mode: 0o700 });
    const resources = new Map();
    resources.set("index.html", Buffer.from('<script src="/__kcoder_mobile_mount_v1__/app.js"></script>', "utf8"));
    resources.set("assets/[profileId]/screen.js", Buffer.from("globalThis.profile = 1;", "utf8"));
    for (let index = 0; index < 40; index += 1) {
      resources.set(`assets/chunk-${String(index).padStart(2, "0")}.bin`, Buffer.from(`resource-${index}`));
    }
    for (const [path, bytes] of resources) {
      const fullPath = join(bundleRoot, path);
      await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
      await writeFile(fullPath, bytes, { mode: 0o400 });
    }
    const rows = [...resources]
      .map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const archivePath = join(root, "bundle.archive.json");
    const archiveBytes = Buffer.from("pinned archive fixture bytes");
    await writeFile(archivePath, archiveBytes, { mode: 0o400 });
    const sourceManifestPath = join(root, "mobile-source-manifest.json");
    const sourceManifestBytes = Buffer.from("pinned source manifest fixture");
    await writeFile(sourceManifestPath, sourceManifestBytes, { mode: 0o400 });
    const sourceRoots = [
      { name: "mobile", destination: "apps/kcoder-studio/mobile", sha256: sha256(Buffer.from("mobile")), fileCount: 1 },
      { name: "studio-shared", destination: "apps/kcoder-studio/shared", sha256: sha256(Buffer.from("shared")), fileCount: 1 },
    ];
    const mobileWeb = {
      inputKind: "verified-readonly-data-archive",
      path: bundleRoot,
      bundleFiles: rows,
      bundleSha256: sha256(Buffer.from(JSON.stringify(rows))),
      sourceRoot,
      sourceRoots,
      sourceTreeSha256: sha256(Buffer.from("source tree")),
      archivePath,
      archiveSha256: sha256(archiveBytes),
      originalManifestSha256: sha256(Buffer.from("original export manifest")),
      dependencyProvenanceIsHistorical: true,
      origin: {
        dependencySourceTreeSha256: sha256(Buffer.from("source dependencies")),
        dependencyOwnedTreeSha256: sha256(Buffer.from("owned dependencies")),
      },
    };
    const sourcePins = {
      archivePath,
      archiveSha256: mobileWeb.archiveSha256,
      originalManifestSha256: mobileWeb.originalManifestSha256,
      sourceRoot,
      sourceManifestPath,
      sourceManifestSha256: sha256(sourceManifestBytes),
      sourceSnapshotProof: {
        manifestPath: sourceManifestPath,
        manifestSha256: sha256(sourceManifestBytes),
      },
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
    };
    const registered = [];
    const context = {
      stateDir,
      pathInState(...parts) { return join(stateDir, ...parts); },
      registerTemporaryDirectory(_label, path) { registered.push(path); },
    };
    await callback({
      root,
      stateDir,
      bundleRoot,
      rows,
      mobileWeb,
      input: { mobileWeb, sourcePins },
      context,
      registered,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readResourceBytes(root, rows) {
  return Promise.all(rows.map(async row => [row.path, await readFile(join(root, row.path))]));
}
