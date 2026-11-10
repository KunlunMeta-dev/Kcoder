import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  archiveMobileWebExport,
  inspectMobileWebExportSourceIdentity,
  restoreHistoricalMobileWebExportArchive,
  restoreMobileWebExportArchive,
  verifyMobileWebExportUnchanged,
} from "./mobile-web-export-archive.mjs";

test("archives, restores, and rechecks an exact data-only Mobile Web export", async t => {
  const fixture = await createFixture(t);
  const archive = await archiveMobileWebExport(fixture.context, {
    exportResult: fixture.exportResult,
    sourceIdentity: fixture.sourceIdentity,
  });
  const archiveInfo = await lstat(archive.path);
  const parentInfo = await lstat(join(fixture.root, "artifacts/mobile-web-export-archive"));
  const archiveValue = JSON.parse(await readFile(archive.path, "utf8"));
  const originalManifestBytes = await readFile(fixture.exportResult.bundleManifestPath);
  assert.equal(archiveInfo.mode & 0o777, 0o400);
  assert.equal(parentInfo.mode & 0o777, 0o700);
  assert.equal(archive.resourceCount, 2);
  assert.equal(archive.totalResourceBytes, fixture.exportResult.bundleFiles.reduce((sum, row) => sum + row.size, 0));
  assert.equal(archiveValue.originalManifest.base64, originalManifestBytes.toString("base64"));
  assert.equal(archiveValue.originalManifest.sha256, sha256(originalManifestBytes));

  const restored = await restoreMobileWebExportArchive(fixture.context, {
    archivePath: archive.path,
    expectedArchiveSha256: archive.sha256,
    sourceIdentity: fixture.sourceIdentity,
  });
  assert.equal(restored.bundleSha256, fixture.exportResult.bundleSha256);
  assert.equal(restored.inputKind, "verified-readonly-data-archive");
  assert.equal(fixture.context.temporaryDirectories.at(-1), restored.path);
  assert.equal(await readFile(join(restored.path, "index.html"), "utf8"), "<main>fixture</main>");
  const restoredRoot = await lstat(restored.path);
  assert.equal(restoredRoot.mode & 0o777, 0o700);
  assert.equal((await lstat(join(restored.path, "assets"))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(restored.path, "assets/chunk.js"))).mode & 0o777, 0o400);
  const postflight = await verifyMobileWebExportUnchanged({
    ...restored,
    archivePath: archive.path,
    archiveSha256: archive.sha256,
  });
  assert.equal(postflight.unchanged, true);
});

test('source identity hashes the public private-credential module but continues to exclude adjacent credential data', async t => {
  const fixture = await createFixture(t), directory = join(fixture.root, 'source/apps/kcoder-studio/mobile/src/runtime/migration-source');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const module = join(directory, 'private-credentials.ts');
  await writeFile(module, 'export const publicModule = true;\n');
  const input = { sourceRoots: fixture.sourceIdentity.sourceRoots };
  const before = await inspectMobileWebExportSourceIdentity(input);
  await writeFile(join(directory, 'credentials.json'), 'SYNTHETIC_PRIVATE_DATA_MUST_STAY_EXCLUDED');
  assert.equal((await inspectMobileWebExportSourceIdentity(input)).sourceTreeSha256, before.sourceTreeSha256);
  await writeFile(module, 'export const publicModule = false;\n');
  assert.notEqual((await inspectMobileWebExportSourceIdentity(input)).sourceTreeSha256, before.sourceTreeSha256);
});

test("rejects tampered archive bytes before parsing or restoring", async t => {
  const fixture = await createFixture(t);
  const archive = await archiveMobileWebExport(fixture.context, {
    exportResult: fixture.exportResult,
    sourceIdentity: fixture.sourceIdentity,
  });
  await chmod(archive.path, 0o600);
  await writeFile(archive.path, Buffer.concat([await readFile(archive.path), Buffer.from(" ") ]));
  await chmod(archive.path, 0o400);
  await assert.rejects(restoreMobileWebExportArchive(fixture.context, {
    archivePath: archive.path,
    expectedArchiveSha256: archive.sha256,
    sourceIdentity: fixture.sourceIdentity,
  }), /archive SHA-256 differs/);
  assert.equal(await pathExists(fixture.context.pathInState("mobile-web-export-archive-restored")), false);
});

test("rejects an archive whose container is no longer read-only", async t => {
  const fixture = await createFixture(t);
  const archive = await archiveMobileWebExport(fixture.context, {
    exportResult: fixture.exportResult,
    sourceIdentity: fixture.sourceIdentity,
  });
  await chmod(archive.path, 0o600);
  await assert.rejects(restoreMobileWebExportArchive(fixture.context, {
    archivePath: archive.path,
    expectedArchiveSha256: archive.sha256,
    sourceIdentity: fixture.sourceIdentity,
  }), /mode must be 0400/);
});

test("rejects missing or extra archive resources against the unchanged original manifest", async t => {
  await t.test("missing resource", async child => {
    const fixture = await createFixture(child);
    const archive = await archiveMobileWebExport(fixture.context, {
      exportResult: fixture.exportResult,
      sourceIdentity: fixture.sourceIdentity,
    });
    const altered = await rewriteArchive(archive.path, value => {
      const removed = value.bundle.resources.pop();
      value.bundle.resourceCount -= 1;
      value.bundle.totalBytes -= removed.size;
      const rows = value.bundle.resources.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
      value.bundle.bundleSha256 = hashJson(rows);
      value.origin.sourceRootSha256 = value.sourceIdentity.sourceTreeSha256;
    });
    await assert.rejects(restoreMobileWebExportArchive(fixture.context, {
      archivePath: archive.path,
      expectedArchiveSha256: altered.sha256,
      sourceIdentity: fixture.sourceIdentity,
    }), /differ from the original Mobile Web manifest/);
  });

  await t.test("extra resource", async child => {
    const fixture = await createFixture(child);
    const archive = await archiveMobileWebExport(fixture.context, {
      exportResult: fixture.exportResult,
      sourceIdentity: fixture.sourceIdentity,
    });
    const extraBytes = Buffer.from("extra");
    const altered = await rewriteArchive(archive.path, value => {
      value.bundle.resources.push({
        path: "extra.js",
        size: extraBytes.length,
        sha256: sha256(extraBytes),
        base64: extraBytes.toString("base64"),
      });
      value.bundle.resources.sort((left, right) => left.path.localeCompare(right.path));
      value.bundle.resourceCount += 1;
      value.bundle.totalBytes += extraBytes.length;
      value.bundle.bundleSha256 = hashJson(value.bundle.resources.map(({ path, size, sha256 }) => ({ path, size, sha256 })));
    });
    await assert.rejects(restoreMobileWebExportArchive(fixture.context, {
      archivePath: archive.path,
      expectedArchiveSha256: altered.sha256,
      sourceIdentity: fixture.sourceIdentity,
    }), /differ from the original Mobile Web manifest/);
  });
});

test("rejects symlinked resources and archive containers", async t => {
  await t.test("bundle resource", async child => {
    const fixture = await createFixture(child);
    await rm(join(fixture.exportResult.path, "assets/chunk.js"));
    await symlink(join(fixture.root, "source/apps/kcoder-studio/mobile/src/index.ts"),
      join(fixture.exportResult.path, "assets/chunk.js"));
    await assert.rejects(archiveMobileWebExport(fixture.context, {
      exportResult: fixture.exportResult,
      sourceIdentity: fixture.sourceIdentity,
    }), /symlink/);
    assert.equal(await pathExists(join(fixture.root, "artifacts/mobile-web-export-archive")), false);
  });

  await t.test("archive path", async child => {
    const fixture = await createFixture(child);
    const archive = await archiveMobileWebExport(fixture.context, {
      exportResult: fixture.exportResult,
      sourceIdentity: fixture.sourceIdentity,
    });
    const alias = join(fixture.root, "artifacts/mobile-web-export-archive/alias.json");
    await symlink(archive.path, alias);
    await assert.rejects(restoreMobileWebExportArchive(fixture.context, {
      archivePath: alias,
      expectedArchiveSha256: archive.sha256,
      sourceIdentity: fixture.sourceIdentity,
    }), /regular data file/);
  });
});

test("rejects an archive when the caller-selected current source tree changed", async t => {
  const fixture = await createFixture(t);
  const archive = await archiveMobileWebExport(fixture.context, {
    exportResult: fixture.exportResult,
    sourceIdentity: fixture.sourceIdentity,
  });
  await writeFile(join(fixture.root, "source/apps/kcoder-studio/mobile/src/index.ts"), "changed");
  await assert.rejects(restoreMobileWebExportArchive(fixture.context, {
    archivePath: archive.path,
    expectedArchiveSha256: archive.sha256,
    sourceIdentity: fixture.sourceIdentity,
  }), /source tree or snapshot proof changed/);
  assert.equal(await pathExists(fixture.context.pathInState("mobile-web-export-archive-restored")), false);
});

test("restores a historical baseline only under explicit archived identity and source HEAD pins", async t => {
  const fixture = await createFixture(t);
  const archive = await archiveMobileWebExport(fixture.context, {
    exportResult: fixture.exportResult,
    sourceIdentity: fixture.sourceIdentity,
  });
  const historicalSourceHead = "a".repeat(40);
  await writeFile(join(fixture.root, "manifest.json"), JSON.stringify({ schemaVersion: 1, gitCommit: historicalSourceHead }));
  const historicalRunManifestSha256 = sha256(await readFile(join(fixture.root, "manifest.json")));
  await writeFile(join(fixture.root, "source/apps/kcoder-studio/mobile/src/index.ts"), "current source changed after archive\n");

  const restored = await restoreHistoricalMobileWebExportArchive(fixture.context, {
    archivePath: archive.path,
    expectedArchiveSha256: archive.sha256,
    expectedHistoricalSourceIdentity: fixture.sourceIdentity,
    historicalSourceHead,
    expectedHistoricalRunManifestSha256: historicalRunManifestSha256,
  });
  assert.equal(restored.inputKind, "archived-baseline");
  assert.equal(restored.sourceTreeSha256, fixture.sourceIdentity.sourceTreeSha256);
  assert.equal(restored.historicalSourceHead, historicalSourceHead);
  assert.equal(restored.originalRunManifestSha256, sha256(await readFile(join(fixture.root, "manifest.json"))));
  assert.equal(fixture.context.temporaryDirectories.at(-1), restored.path);
  assert.equal(await readFile(join(restored.path, "index.html"), "utf8"), "<main>fixture</main>");

  await assert.rejects(restoreHistoricalMobileWebExportArchive(fixture.context, {
    archivePath: archive.path,
    expectedArchiveSha256: archive.sha256,
    expectedHistoricalSourceIdentity: fixture.sourceIdentity,
    historicalSourceHead: "b".repeat(40),
    expectedHistoricalRunManifestSha256: historicalRunManifestSha256,
    outputName: "historical-baseline-wrong-head",
  }), /RunContext HEAD differs from the caller pin/);
  const wrongIdentity = {
    ...fixture.sourceIdentity,
    sourceTreeSha256: "f".repeat(64),
  };
  await assert.rejects(restoreHistoricalMobileWebExportArchive(fixture.context, {
    archivePath: archive.path,
    expectedArchiveSha256: archive.sha256,
    expectedHistoricalSourceIdentity: wrongIdentity,
    historicalSourceHead,
    expectedHistoricalRunManifestSha256: historicalRunManifestSha256,
    outputName: "historical-baseline-wrong-identity",
  }), /digest does not match its roots/);
  assert.equal(await pathExists(fixture.context.pathInState("historical-baseline-wrong-head")), false);
  assert.equal(await pathExists(fixture.context.pathInState("historical-baseline-wrong-identity")), false);
});

test("does not produce an archive from a failed or incomplete exporter manifest", async t => {
  const fixture = await createFixture(t);
  const manifest = JSON.parse(await readFile(fixture.exportResult.bundleManifestPath, "utf8"));
  manifest.status = "export-failed";
  manifest.error = "controlled fixture failure";
  await writeFile(fixture.exportResult.bundleManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(archiveMobileWebExport(fixture.context, {
    exportResult: fixture.exportResult,
    sourceIdentity: fixture.sourceIdentity,
  }), /only complete Mobile Web exports can be archived/);
  assert.equal(await pathExists(join(fixture.root, "artifacts/mobile-web-export-archive")), false);
});

test("rejects source, copy, terminal, and dependency digest contradictions", async t => {
  const cases = [
    ["source-after digest", manifest => { manifest.sourceHashAfter = "a".repeat(64); }, /sourceHashAfter differs/],
    ["copied source digest", manifest => { manifest.buildInputTreeAfterCopySha256 = "b".repeat(64); }, /copied source digest differs/],
    ["terminal snapshot digest", manifest => { manifest.buildInputTreeAfterTerminalSha256 = "9".repeat(64); }, /changed during export/],
    ["dependency source digests", manifest => { manifest.dependencyProvenance.sourceTreeSha256After = "f".repeat(64); }, /dependency source digests disagree/],
    ["dependency symlink summary", manifest => { manifest.dependencyProvenance.copiedSymlinks = true; }, /contains symlinks/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async child => {
      const fixture = await createFixture(child);
      await rewriteExportManifest(fixture.exportResult.bundleManifestPath, mutate);
      await assert.rejects(archiveMobileWebExport(fixture.context, {
        exportResult: fixture.exportResult,
        sourceIdentity: fixture.sourceIdentity,
      }), pattern);
      assert.equal(await pathExists(join(fixture.root, "artifacts/mobile-web-export-archive")), false);
    });
  }
});

test("binds the export result path to the manifest-owned RunContext state path", async t => {
  const fixture = await createFixture(t);
  fixture.exportResult.path = join(fixture.context.stateDir, "different-bundle");
  await assert.rejects(archiveMobileWebExport(fixture.context, {
    exportResult: fixture.exportResult,
    sourceIdentity: fixture.sourceIdentity,
  }), /export result path differs from the manifest-owned Mobile Web output/);
  assert.equal(await pathExists(join(fixture.root, "artifacts/mobile-web-export-archive")), false);
});

test("rejects a manifest-owned output path that escapes RunContext state", async t => {
  const fixture = await createFixture(t);
  await rewriteExportManifest(fixture.exportResult.bundleManifestPath, manifest => {
    manifest.ownedOutputRelativePath = "state/../outside";
  });
  await assert.rejects(archiveMobileWebExport(fixture.context, {
    exportResult: fixture.exportResult,
    sourceIdentity: fixture.sourceIdentity,
  }), /unsafe segment/);
});

test("binds copied-source and dependency digests to the export result", async t => {
  const fixture = await createFixture(t);
  fixture.exportResult.dependencyOwnedTreeSha256 = "9".repeat(64);
  await assert.rejects(archiveMobileWebExport(fixture.context, {
    exportResult: fixture.exportResult,
    sourceIdentity: fixture.sourceIdentity,
  }), /export result copied dependency digest differs from the manifest/);
});

test("restore revalidates source and dependency summaries in the archived exporter manifest", async t => {
  const cases = [
    ["source digest", manifest => { manifest.sourceHashAfter = "a".repeat(64); }, /sourceHashAfter differs/],
    ["post-export source roots", manifest => { manifest.inputRootsAfter[0].sha256 = "b".repeat(64); }, /post-export source roots differ/],
    ["dependency digest", manifest => { manifest.dependencyProvenance.sourceTreeSha256After = "f".repeat(64); }, /dependency source digests disagree/],
    ["dependency symlink summary", manifest => { manifest.dependencyProvenance.copiedSymlinks = true; }, /contains symlinks/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async child => {
      const fixture = await createFixture(child);
      const archive = await archiveMobileWebExport(fixture.context, {
        exportResult: fixture.exportResult,
        sourceIdentity: fixture.sourceIdentity,
      });
      const altered = await rewriteArchivedManifest(archive.path, mutate);
      await assert.rejects(restoreMobileWebExportArchive(fixture.context, {
        archivePath: archive.path,
        expectedArchiveSha256: altered.sha256,
        sourceIdentity: fixture.sourceIdentity,
      }), pattern);
      assert.equal(await pathExists(fixture.context.pathInState("mobile-web-export-archive-restored")), false);
    });
  }
});

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mobile-web-export-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = join(root, "artifacts");
  const stateDir = join(root, "state");
  const sourceRoot = join(root, "source");
  const mobileRoot = join(sourceRoot, "apps/kcoder-studio/mobile");
  const sharedRoot = join(sourceRoot, "apps/kcoder-studio/shared");
  const bundleRoot = join(stateDir, "mobile-web-export");
  await Promise.all([
    mkdir(artifactsDir, { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
    mkdir(join(mobileRoot, "src"), { recursive: true, mode: 0o700 }),
    mkdir(join(mobileRoot, "scripts"), { recursive: true, mode: 0o700 }),
    mkdir(sharedRoot, { recursive: true, mode: 0o700 }),
    mkdir(join(bundleRoot, "assets"), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, gitCommit: "a".repeat(40) }));
  await writeFile(join(mobileRoot, "src/index.ts"), "export const app = true;\n");
  await writeFile(join(mobileRoot, "scripts/build.mjs"), "export const build = true;\n");
  await writeFile(join(sharedRoot, "contracts.ts"), "export type Contract = string;\n");
  await writeFile(join(bundleRoot, "index.html"), "<main>fixture</main>");
  await writeFile(join(bundleRoot, "assets/chunk.js"), "window.fixture = true;");
  const sourceRoots = [
    { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
  ];
  const sourceIdentity = await inspectMobileWebExportSourceIdentity({ sourceRoots });
  const bundleFiles = [
    await resource(bundleRoot, "index.html"),
    await resource(bundleRoot, "assets/chunk.js"),
  ].sort((left, right) => left.path.localeCompare(right.path));
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
    bundleSha256,
    bundleFileCount: bundleFiles.length,
    indexHtmlSha256: bundleFiles.find(file => file.path === "index.html").sha256,
    bundleFiles,
    overallDeadline: { outcome: "completed" },
    verificationFailures: [],
    error: null,
  };
  await writeFile(bundleManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const context = {
    runRoot: root,
    artifactsDir,
    stateDir,
    temporaryDirectories: [],
    pathInArtifacts(...parts) { return resolve(artifactsDir, ...parts); },
    pathInState(...parts) { return resolve(stateDir, ...parts); },
    registerTemporaryDirectory(_label, path) { this.temporaryDirectories.push(resolve(path)); },
  };
  return {
    root,
    context,
    sourceIdentity,
    exportResult: {
      path: bundleRoot,
      sourceTreeSha256: sourceIdentity.sourceTreeSha256,
      buildInputTreeSha256: sourceIdentity.sourceTreeSha256,
      dependencySourceTreeSha256: "d".repeat(64),
      dependencyOwnedTreeSha256: "e".repeat(64),
      bundleSha256,
      bundleFileCount: bundleFiles.length,
      bundleFiles,
      bundleManifestPath,
    },
  };
}

async function resource(root, path) {
  const bytes = await readFile(join(root, path));
  return { path, size: bytes.length, sha256: sha256(bytes) };
}

async function rewriteArchive(path, mutate) {
  await chmod(path, 0o600);
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  const bytes = Buffer.from(JSON.stringify(value));
  await writeFile(path, bytes);
  await chmod(path, 0o400);
  return { sha256: sha256(bytes) };
}

async function rewriteExportManifest(path, mutate) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteArchivedManifest(path, mutate) {
  return rewriteArchive(path, value => {
    const manifestBytes = Buffer.from(value.originalManifest.base64, "base64");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    mutate(manifest);
    const updatedManifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const digest = sha256(updatedManifestBytes);
    value.originalManifest = {
      sha256: digest,
      base64: updatedManifestBytes.toString("base64"),
    };
    value.origin.exportManifestSha256 = digest;
  });
}

async function pathExists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
