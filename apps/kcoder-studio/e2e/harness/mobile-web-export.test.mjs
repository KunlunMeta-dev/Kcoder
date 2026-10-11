import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { appRoot, RunContext } from "./run-context.mjs";
import { exportMobileWeb } from "./mobile-web-export.mjs";

test("Mobile Web export is fresh, RunContext-owned, and hashes every published asset", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-owned-manifest",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    const exported = await exportMobileWeb(context, {
      mobileRoot: fixture.mobileRoot,
      label: "fixture-mobile-export",
      outputName: "mobile-web-export",
    });

    assert.ok(exported.path.startsWith(`${context.stateDir}/`));
    assert.notEqual(exported.path, resolve(appRoot, "mobile/dist"));
    assert.match(exported.sourceTreeSha256, /^[a-f0-9]{64}$/);
    assert.match(exported.buildInputTreeSha256, /^[a-f0-9]{64}$/);
    assert.match(exported.bundleSha256, /^[a-f0-9]{64}$/);
    assert.ok(exported.exporterPid > 0);
    assert.ok(exported.terminalBuilderPid > 0);
    assert.ok(exported.dependencyCopierPid > 0);
    assert.deepEqual(exported.sourceRoots.map(root => root.name), ["mobile", "studio-shared"]);

    const ownedDependencyRoot = resolve(context.stateDir, "mobile-build-source/apps/kcoder-studio/mobile/node_modules");
    assert.equal((await lstat(ownedDependencyRoot)).isSymbolicLink(), false);
    assert.equal((await lstat(resolve(ownedDependencyRoot, "expo-alias"))).isSymbolicLink(), false);
    assert.equal(
      await readFile(resolve(ownedDependencyRoot, "expo-alias/package.json"), "utf8"),
      JSON.stringify({ name: "expo" }),
    );

    const bundleManifest = JSON.parse(await readFile(exported.bundleManifestPath, "utf8"));
    assert.equal(bundleManifest.status, "complete");
    assert.equal(bundleManifest.failurePhase, null);
    assert.equal(bundleManifest.error, null);
    assert.equal(bundleManifest.sourceUnchanged, true);
    assert.equal(bundleManifest.snapshotCopyMatchesSource, true);
    assert.equal(bundleManifest.terminalHookChangesOnlyGeneratedHtml, true);
    assert.equal(bundleManifest.snapshotUnchangedDuringExport, true);
    assert.equal(bundleManifest.dependencyProvenance.sourceUnchanged, true);
    assert.equal(bundleManifest.dependencyProvenance.copiedSymlinks, false);
    assert.equal(bundleManifest.bundleSha256, exported.bundleSha256);
    assert.equal(bundleManifest.bundleFileCount, 6);
    assert.deepEqual(
      bundleManifest.bundleFiles.map(file => file.path),
      [
        "_expo/static/css/site.css",
        "_expo/static/js/web/entry.js",
        "assets/font.bin",
        "assets/shared-contract-sha256.txt",
        "assets/terminal-html-sha256.txt",
        "index.html",
      ],
    );
    assert.ok(bundleManifest.bundleFiles.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
    const generatedHtml = await readFile(resolve(context.runRoot, "state/mobile-build-source/apps/kcoder-studio/mobile/src/terminal-webview/generated-html.ts"));
    const generatedHtmlSha256 = createHash("sha256").update(generatedHtml).digest("hex");
    assert.equal(exported.terminalWebView.generatedHtmlSha256, generatedHtmlSha256);
    assert.equal(
      exported.terminalWebView.generatedHtmlInputSha256,
      createHash("sha256").update("// stale generated html\n").digest("hex"),
    );
    assert.equal(
      (await readFile(resolve(exported.path, "assets/terminal-html-sha256.txt"), "utf8")).trim(),
      generatedHtmlSha256,
    );
    const sharedContractHash = createHash("sha256").update("export const contract = 'stable';\n").digest("hex");
    assert.equal(
      (await readFile(resolve(exported.path, "assets/shared-contract-sha256.txt"), "utf8")).trim(),
      sharedContractHash,
    );
    assert.equal(await exists(resolve(context.runRoot, "state/mobile-build-source/apps/kcoder-studio/shared/contract.ts")), true);
    assert.equal(await exists(resolve(context.runRoot, "state/mobile-build-source/apps/kcoder-studio/mobile/secret.env")), false);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { verified: status === "passed" });
  }

  const runManifest = JSON.parse(await readFile(resolve(context.runRoot, "manifest.json"), "utf8"));
  for (const label of [
    "fixture-mobile-export-dependencies-copy",
    "fixture-mobile-export-terminal-build",
    "fixture-mobile-export-expo",
  ]) {
    assert.ok(runManifest.processes.some(process => process.label === label && process.pid > 0));
    assert.ok(runManifest.cleanupSteps.some(step => step.label === `stop process ${label}` && step.status === "completed"));
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web terminal build can write a readonly input only in its owned snapshot", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-readonly-generated-html",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    const sourceGeneratedHtml = resolve(fixture.mobileRoot, "src/terminal-webview/generated-html.ts");
    const sourceEntry = resolve(fixture.mobileRoot, "src/terminal-webview/entry.ts");
    const sourceGeneratedBytes = await readFile(sourceGeneratedHtml);
    const sourceEntryMode = (await lstat(sourceEntry)).mode & 0o777;
    await chmod(sourceGeneratedHtml, 0o400);

    const exported = await exportMobileWeb(context, {
      mobileRoot: fixture.mobileRoot,
      label: "fixture-mobile-readonly-generated-html",
      outputName: "readonly-mobile-web-export",
    });

    const ownedMobileRoot = resolve(context.runRoot, "state/mobile-build-source/apps/kcoder-studio/mobile");
    const ownedGeneratedHtml = resolve(ownedMobileRoot, "src/terminal-webview/generated-html.ts");
    const ownedEntry = resolve(ownedMobileRoot, "src/terminal-webview/entry.ts");
    const bundleManifest = JSON.parse(await readFile(exported.bundleManifestPath, "utf8"));
    assert.equal(bundleManifest.status, "complete");
    assert.equal(bundleManifest.snapshotCopyMatchesSource, true);
    assert.equal(bundleManifest.terminalHookChangesOnlyGeneratedHtml, true);
    assert.equal(bundleManifest.snapshotUnchangedDuringExport, true);
    assert.equal((await lstat(ownedGeneratedHtml)).mode & 0o777, 0o600);
    assert.equal((await lstat(ownedEntry)).mode & 0o777, sourceEntryMode);
    assert.equal((await lstat(sourceGeneratedHtml)).mode & 0o777, 0o400);
    assert.deepEqual(await readFile(sourceGeneratedHtml), sourceGeneratedBytes);
    assert.notDeepEqual(await readFile(ownedGeneratedHtml), sourceGeneratedBytes);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { readonlyGeneratedHtmlBuiltInOwnedCopy: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web export refuses a mixed source tree and retains its digest evidence", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-source-drift",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: true });
    const result = exportMobileWeb(context, {
      mobileRoot: fixture.mobileRoot,
      label: "fixture-mobile-drift-export",
      outputName: "drifted-mobile-web-export",
    });
    await waitForFile(fixture.startedPath);
    await writeFile(fixture.sharedRoot + "/contract.ts", "export const contract = 'changed during export';\n");
    await assert.rejects(
      result,
      /source changed during export/,
    );
    const manifest = JSON.parse(await readFile(
      resolve(context.runRoot, "artifacts/mobile-web-export-fixture-mobile-drift-export-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.status, "source-changed-during-export");
    assert.equal(manifest.failurePhase, "post-export-verification");
    assert.match(manifest.error, /Mobile source changed during export/);
    assert.equal(manifest.sourceUnchanged, false);
    assert.notEqual(manifest.sourceHashBefore, manifest.sourceHashAfter);
    assert.equal(manifest.snapshotUnchangedDuringExport, true);
    assert.ok(manifest.bundleFileCount > 0);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { sourceDriftRejected: status === "passed" });
  }
});

test("Mobile Web export records the terminal builder failure phase and error", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-terminal-build-failure-phase",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    await writeFile(
      resolve(fixture.mobileRoot, "scripts/build-terminal-webview.mjs"),
      'throw new Error("fixture terminal builder failure");\n',
    );
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-terminal-failure-export",
      }),
      /failed during terminal-build/,
    );
    const manifest = JSON.parse(await readFile(
      resolve(context.runRoot, "artifacts/mobile-web-export-fixture-mobile-terminal-failure-export-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.status, "export-failed");
    assert.equal(manifest.failurePhase, "terminal-build");
    assert.match(manifest.error, /fixture-mobile-terminal-failure-export-terminal-build exited with code 1/);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { terminalBuildFailurePhaseRecorded: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web export records the Expo exporter failure phase and error", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-expo-failure-phase",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    await writeFile(
      resolve(fixture.mobileRoot, "node_modules/expo/bin/cli"),
      'throw new Error("fixture Expo export failure");\n',
    );
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-expo-failure-export",
      }),
      /failed during expo-export/,
    );
    const manifest = JSON.parse(await readFile(
      resolve(context.runRoot, "artifacts/mobile-web-export-fixture-mobile-expo-failure-export-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.status, "export-failed");
    assert.equal(manifest.failurePhase, "expo-export");
    assert.match(manifest.error, /fixture-mobile-expo-failure-export-expo exited with code 1/);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { expoExportFailurePhaseRecorded: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web export rejects dependency symlinks outside the approved cache", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-dependency-boundary",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    const unapprovedRoot = context.pathInState("fixtures/unapproved-dependency-target");
    await mkdir(unapprovedRoot, { recursive: true });
    await writeFile(resolve(unapprovedRoot, "outside-package.json"), "{}\n");
    await symlink(unapprovedRoot, resolve(fixture.mobileRoot, "node_modules/outside-alias"), "dir");
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-boundary-export",
        outputName: "boundary-mobile-web-export",
      }),
      /dependency symlink must resolve inside its approved dependency root/,
    );
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { externalDependencySymlinkRejected: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web export rejects Mobile and Studio shared roots from different snapshots", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-source-root-boundary",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    const otherSharedRoot = context.pathInState("fixtures/other-checkout/shared");
    await mkdir(otherSharedRoot, { recursive: true });
    await writeFile(resolve(otherSharedRoot, "contract.ts"), "export const contract = 'other';\n");
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        sourceRoots: [
          { name: "mobile", path: fixture.mobileRoot, destination: "apps/kcoder-studio/mobile" },
          { name: "studio-shared", path: otherSharedRoot, destination: "apps/kcoder-studio/shared" },
        ],
        label: "fixture-mobile-mixed-roots-export",
      }),
      /Studio shared source must be the sibling of the selected Mobile source root/,
    );
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { mixedSourceRootsRejected: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

async function fixtureMobileRoot(context, { sourceDriftDuringExport }) {
  const root = context.pathInState(sourceDriftDuringExport ? "fixtures/mobile-drift" : "fixtures/mobile");
  const sharedRoot = resolve(root, "../shared");
  const startedPath = context.pathInState("fixtures/export-started");
  const cli = resolve(root, "node_modules/expo/bin/cli");
  await mkdir(resolve(root, "node_modules/expo/bin"), { recursive: true });
  await mkdir(resolve(root, "scripts"), { recursive: true });
  await mkdir(resolve(root, "src/terminal-webview"), { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await writeFile(resolve(root, "package.json"), JSON.stringify({ name: "mobile-export-fixture" }));
  await writeFile(resolve(root, "node_modules/expo/package.json"), JSON.stringify({ name: "expo" }));
  await symlink("expo", resolve(root, "node_modules/expo-alias"), "dir");
  await writeFile(resolve(root, "src/screen.tsx"), "export const Screen = () => null;\n");
  await writeFile(resolve(root, "src/terminal-webview/entry.ts"), "export const terminalEntry = true;\n");
  await writeFile(resolve(root, "src/terminal-webview/generated-html.ts"), "// stale generated html\n");
  await writeFile(resolve(root, "secret.env"), "DUMMY_SECRET_VALUE\n");
  await writeFile(resolve(root, ".env.local"), "DUMMY_ENV_VALUE\n");
  await writeFile(resolve(root, "scripts/build-terminal-webview.mjs"), fakeTerminalBuilder());
  await writeFile(sharedRoot + "/contract.ts", "export const contract = 'stable';\n");
  await writeFile(resolve(sharedRoot, "token.secret.json"), "DUMMY_SECRET_VALUE\n");
  await writeFile(cli, fakeExpoCli({
    markerPath: sourceDriftDuringExport ? startedPath : null,
    delayMs: sourceDriftDuringExport ? 250 : 0,
  }));
  return { mobileRoot: root, sharedRoot, startedPath };
}

function fakeTerminalBuilder() {
  return `
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
writeFileSync(resolve(process.cwd(), "src/terminal-webview/generated-html.ts"), "export const terminalWebViewHtml = \\\"owned terminal html\\\";\\n");
`;
}

function fakeExpoCli({ markerPath, delayMs }) {
  return `
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const outputIndex = process.argv.indexOf("--output-dir");
if (outputIndex < 0) throw new Error("missing --output-dir");
  const outputRoot = process.argv[outputIndex + 1];
(async () => {
  ${markerPath ? `fs.writeFileSync(${JSON.stringify(markerPath)}, "started\\n");` : ""}
  await new Promise(resolve => setTimeout(resolve, ${delayMs}));
  const generatedTerminalHtml = fs.readFileSync(path.join(process.cwd(), "src/terminal-webview/generated-html.ts"));
  const terminalHtmlSha256 = crypto.createHash("sha256").update(generatedTerminalHtml).digest("hex");
  const sharedContract = fs.readFileSync(path.resolve(process.cwd(), "../shared/contract.ts"));
  const sharedContractSha256 = crypto.createHash("sha256").update(sharedContract).digest("hex");
  for (const [file, contents] of [
    ["index.html", "<!doctype html><html><body>fixture</body></html>"],
    ["_expo/static/css/site.css", "body { color: black; }"],
    ["_expo/static/js/web/entry.js", "window.fixture = true;"],
    ["assets/font.bin", Buffer.from([0, 7, 255])],
    ["assets/shared-contract-sha256.txt", sharedContractSha256 + "\\n"],
    ["assets/terminal-html-sha256.txt", terminalHtmlSha256 + "\\n"],
  ]) {
    const target = path.join(outputRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
}

async function waitForFile(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
  }
  throw new Error("fixture Expo export did not reach its owned start marker");
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") return false;
    throw error;
  }
}
