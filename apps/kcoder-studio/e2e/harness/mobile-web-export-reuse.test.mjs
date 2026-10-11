import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { RunContext } from "./run-context.mjs";
import { reuseMobileWebExport } from "./mobile-web-export-reuse.mjs";

const expectedSourceTreeSha256 = "2f673d69fc972b84851b52b50dead516f97fa8ca1fffcebf03024ed9aa2b3082";

test("reuses the retained 37-file public export into fresh RunContext state and records provenance", async () => {
  await withFixture("mobile-web-export-reuse-success", async (context, fixture) => {
    const result = await reuseMobileWebExport(context, optionsFor(fixture, "reused-mobile-web"));
    assert.equal(result.exportPerformed, false);
    assert.equal(result.sourceTreeSha256, expectedSourceTreeSha256);
    assert.equal(result.bundleFileCount, 37);
    assert.equal(result.bundleFiles.length, 37);
    assert.deepEqual(result.bundleFiles, fixture.manifest.files);
    assert.match(result.sourceManifestSha256, /^[a-f0-9]{64}$/);
    assert.match(result.bundleSha256, /^[a-f0-9]{64}$/);
    assert.ok(result.path.startsWith(`${context.stateDir}/`));
    assert.equal((await lstat(result.path)).isDirectory(), true);
    assert.equal(await readFile(resolve(result.path, "index.html"), "utf8"), "<html>index</html>\n");
    assert.equal(
      await readFile(resolve(result.path, "assets/node_modules/@react-navigation/elements/lib/module/assets/back.png"), "utf8"),
      "fixture:5:assets/node_modules/@react-navigation/elements/lib/module/assets/back.png\n",
    );

    const provenance = JSON.parse(await readFile(result.provenancePath, "utf8"));
    assert.equal(provenance.status, "complete");
    assert.equal(provenance.kind, "reused-retained-public-mobile-web-export");
    assert.equal(provenance.exportPerformed, false);
    assert.equal(provenance.sourceArtifact.manifestSha256, result.sourceManifestSha256);
    assert.equal(provenance.sourceArtifact.bundleSha256, result.bundleSha256);
    assert.equal(provenance.sourceArtifact.sourceTreeStatus, "manifest-digest-matches-expected-snapshot");
    assert.equal(provenance.ownedCopy.filesVerifiedAgainstManifest, true);
    assert.equal(provenance.ownedCopy.extraFiles, 0);
    assert.equal(provenance.ownedCopy.symlinks, 0);

    const ownedFiles = await listFiles(result.path);
    assert.deepEqual(ownedFiles.sort(), fixture.files.map(file => file.path).sort());
    await assert.rejects(
      reuseMobileWebExport(context, optionsFor(fixture, "reused-mobile-web")),
      /owned output already exists/,
    );
  });
});

test("accepts a caller-pinned export file count while retaining per-file verification", async () => {
  await withFixture("mobile-web-export-reuse-pinned-count", async (context, fixture) => {
    const result = await reuseMobileWebExport(context, {
      ...optionsFor(fixture, "reused-mobile-web"),
      expectedBundleFileCount: 3,
    });
    assert.equal(result.bundleFileCount, 3);
    assert.equal(result.bundleFiles.length, 3);
    assert.deepEqual(result.bundleFiles, fixture.manifest.files);
    assert.equal(aggregate(result.bundleFiles), fixture.manifest.bundleSha256);
  }, { bundleFileCount: 3 });
});

test("rejects a listed file whose bytes no longer match the retained manifest", async () => {
  await withFixture("mobile-web-export-reuse-corruption", async (context, fixture) => {
    await writeFile(resolve(fixture.bundleRoot, "index.html"), "<html>corrupted</html>\n");
    await assert.rejects(
      reuseMobileWebExport(context, optionsFor(fixture, "reused-mobile-web")),
      /bundle file (?:size|SHA-256) does not match the source manifest/,
    );
    await assert.rejects(lstat(context.pathInState("reused-mobile-web")), { code: "ENOENT" });
  });
});

test("rejects a self-consistent retained manifest or bundle that differs from caller pins", async () => {
  await withFixture("mobile-web-export-reuse-pinned-artifact", async (context, fixture) => {
    await assert.rejects(
      reuseMobileWebExport(context, {
        ...optionsFor(fixture, "reused-mobile-web"),
        expectedBundleSha256: "f".repeat(64),
      }),
      /bundle does not match the expected SHA-256 pin/,
    );

    const originalManifestSha256 = fixture.manifestSha256;
    fixture.manifest.purpose = "replaced manifest with a self-consistent file table";
    await writeManifest(fixture);
    await assert.rejects(
      reuseMobileWebExport(context, {
        ...optionsFor(fixture, "reused-mobile-web"),
        expectedManifestSha256: originalManifestSha256,
      }),
      /manifest does not match the expected SHA-256 pin/,
    );
    await assert.rejects(lstat(context.pathInState("reused-mobile-web")), { code: "ENOENT" });
  });
});

test("rejects a traversal path in the source manifest before copying", async () => {
  await withFixture("mobile-web-export-reuse-traversal", async (context, fixture) => {
    fixture.manifest.files[0].path = "../escape.html";
    fixture.manifest.bundleSha256 = aggregate(fixture.manifest.files);
    await writeManifest(fixture);
    await assert.rejects(
      reuseMobileWebExport(context, optionsFor(fixture, "reused-mobile-web")),
      /bundle file path contains an unsafe path segment/,
    );
    await assert.rejects(lstat(context.pathInState("reused-mobile-web")), { code: "ENOENT" });
  });
});

test("rejects duplicate file paths in the source manifest", async () => {
  await withFixture("mobile-web-export-reuse-duplicate", async (context, fixture) => {
    fixture.manifest.files[1].path = fixture.manifest.files[0].path;
    fixture.manifest.bundleSha256 = aggregate(fixture.manifest.files);
    await writeManifest(fixture);
    await assert.rejects(
      reuseMobileWebExport(context, optionsFor(fixture, "reused-mobile-web")),
      /duplicate path/,
    );
    await assert.rejects(lstat(context.pathInState("reused-mobile-web")), { code: "ENOENT" });
  });
});

test("rejects a symlinked parent directory inside the retained public bundle", async () => {
  await withFixture("mobile-web-export-reuse-parent-symlink", async (context, fixture) => {
    const sourceJsParent = resolve(fixture.bundleRoot, "_expo/static/js");
    const externalTarget = context.pathInState("symlink-target");
    await rm(sourceJsParent, { recursive: true, force: true });
    await mkdir(resolve(externalTarget, "web"), { recursive: true, mode: 0o700 });
    await writeFile(resolve(externalTarget, "web/entry.js"), fixture.contents.get("_expo/static/js/web/entry.js"));
    await symlink(externalTarget, sourceJsParent, "dir");
    await assert.rejects(
      reuseMobileWebExport(context, optionsFor(fixture, "reused-mobile-web")),
      /cannot contain symlinks/,
    );
    await assert.rejects(lstat(context.pathInState("reused-mobile-web")), { code: "ENOENT" });
  });
});

test("rejects unlisted files and forbidden sensitive paths", async () => {
  await withFixture("mobile-web-export-reuse-extra-file", async (context, fixture) => {
    await writeFile(resolve(fixture.bundleRoot, "unlisted.css"), "extra\n");
    await assert.rejects(
      reuseMobileWebExport(context, optionsFor(fixture, "reused-mobile-web")),
      /missing or extra files/,
    );
  });

  await withFixture("mobile-web-export-reuse-private-path", async (context, fixture) => {
    fixture.manifest.files[0].path = "assets/.env";
    fixture.manifest.bundleSha256 = aggregate(fixture.manifest.files);
    await writeManifest(fixture);
    await assert.rejects(
      reuseMobileWebExport(context, optionsFor(fixture, "reused-mobile-web")),
      /environment files/,
    );
  });

  await withFixture("mobile-web-export-reuse-node-modules-code", async (context, fixture) => {
    fixture.manifest.files[0].path = "assets/node_modules/example/runtime.js";
    fixture.manifest.bundleSha256 = aggregate(fixture.manifest.files);
    await writeManifest(fixture);
    await assert.rejects(
      reuseMobileWebExport(context, optionsFor(fixture, "reused-mobile-web")),
      /node_modules except manifest-listed static image assets/,
    );
  });
});

function optionsFor(fixture, outputName) {
  return {
    bundleRoot: fixture.bundleRoot,
    manifestPath: fixture.manifestPath,
    expectedSourceTreeSha256,
    expectedManifestSha256: fixture.manifestSha256,
    expectedBundleSha256: fixture.manifest.bundleSha256,
    label: "reuse-fixture",
    outputName,
  };
}

async function withFixture(testId, body, { bundleFileCount = 37 } = {}) {
  const context = await RunContext.create(import.meta.url, { testId });
  let fixture;
  let status = "passed";
  try {
    fixture = await createFixture(context, bundleFileCount);
    await body(context, fixture);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    if (fixture) await fixture.cleanup();
    await context.finish(status, { verified: status === "passed" });
  }
  await assert.rejects(lstat(context.stateDir), { code: "ENOENT" });
}

async function createFixture(context, bundleFileCount = 37) {
  const bundleRoot = context.pathInArtifacts("reuse-fixture-bundle");
  const manifestPath = context.pathInArtifacts("reuse-fixture-manifest.json");
  await mkdir(bundleRoot, { recursive: false });
  const allPaths = [
    "_expo/.routes.json",
    "_expo/static/css/web.css",
    "_expo/static/js/web/entry.js",
    "+not-found.html",
    "index.html",
    "assets/node_modules/@react-navigation/elements/lib/module/assets/back.png",
    "assets/node_modules/expo-router/assets/arrow.svg",
    ...Array.from({ length: 30 }, (_, index) => `pages/page-${String(index).padStart(2, "0")}.html`),
  ];
  assert.ok(Number.isSafeInteger(bundleFileCount) && bundleFileCount > 0 && bundleFileCount <= allPaths.length);
  const paths = allPaths.slice(0, bundleFileCount);
  if (!paths.includes("index.html")) paths[paths.length - 1] = "index.html";
  assert.equal(paths.length, bundleFileCount);
  const contents = new Map();
  const files = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const value = Buffer.from(path === "index.html" ? "<html>index</html>\n" : `fixture:${index}:${path}\n`);
    contents.set(path, value);
    const destination = resolve(bundleRoot, ...path.split("/"));
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    await writeFile(destination, value, { flag: "wx", mode: 0o600 });
    files.push({ path, size: value.length, sha256: hash(value) });
  }
  const manifest = {
    schemaVersion: 1,
    purpose: "test fixture for retained public mobile export reuse",
    sourceCommit: "unverified-fixture-commit",
    sourceTreeSha256: expectedSourceTreeSha256,
    bundleSha256: aggregate(files),
    bundleFileCount: files.length,
    indexHtmlSha256: files.find(file => file.path === "index.html").sha256,
    directory: "artifacts/reuse-fixture-bundle",
    files,
  };
  const fixture = { bundleRoot, manifestPath, manifest, files, contents };
  await writeManifest(fixture);
  fixture.cleanup = async () => {
    await rm(bundleRoot, { recursive: true, force: true });
    await rm(manifestPath, { force: true });
  };
  return fixture;
}

async function writeManifest(fixture) {
  const contents = Buffer.from(`${JSON.stringify(fixture.manifest, null, 2)}\n`);
  await writeFile(fixture.manifestPath, contents, { mode: 0o600 });
  fixture.manifestSha256 = hash(contents);
}

async function listFiles(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relativePath);
      else files.push(relativePath);
    }
  }
  await visit(root);
  return files;
}

function aggregate(files) {
  return hash(Buffer.from(JSON.stringify(files)));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
