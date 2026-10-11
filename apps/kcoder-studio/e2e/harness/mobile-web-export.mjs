import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { appRoot, waitFor } from "./run-context.mjs";
import { buildExpoExportArguments, createSourceMapBundleEvidence } from "./render-profile-attribution-contract.mjs";

const EXCLUDED_SOURCE_DIRECTORIES = new Set([".expo", ".git", "dist", "node_modules"]);
const DEFAULT_EXPORT_TIMEOUT_MS = 180_000;
const DEPENDENCY_COPY_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_HTML_PATH = "src/terminal-webview/generated-html.ts";

/**
 * Build Mobile Web from explicit source roots into this RunContext's private state.
 *
 * Both the Mobile app and sibling Studio shared source are copied and hashed. An
 * immutable source snapshot may be selected with `mobileRoot` and `sourceRoots`;
 * its dependency cache can be provided separately with `dependencyRoot`. All
 * dependencies are physically materialized in RunContext state before any build
 * hook runs. The terminal HTML hook and Expo export therefore only mutate/read
 * this run's owned tree.
 */
export async function exportMobileWeb(
  context,
  {
    mobileRoot = resolve(appRoot, "mobile"),
    sourceRoots,
    dependencyRoot,
    label = "mobile-web-export",
    outputName = "mobile-web-export",
    timeoutMs = DEFAULT_EXPORT_TIMEOUT_MS,
    sourceMaps = false,
  } = {},
) {
  assertSafeSlug(label, "export label", 100);
  assertSafeSlug(outputName, "export output name", 127);
  assert.ok(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10 * 60_000,
    "Mobile Web export timeout must be between 1ms and 10 minutes",
  );
  assert.equal(typeof sourceMaps, "boolean", "Mobile Web sourceMaps option must be a boolean");

  const resolvedMobileRoot = await realpath(resolve(mobileRoot));
  const inputRoots = await resolveSourceRoots(resolvedMobileRoot, sourceRoots);
  const resolvedDependencyRoot = await realpath(resolve(
    dependencyRoot ?? resolve(resolvedMobileRoot, "node_modules"),
  ));
  await access(resolve(resolvedDependencyRoot, "expo/package.json"));
  await assertDependencySymlinksConfined(resolvedDependencyRoot);
  const dependencyRootBefore = await hashSourceRoots([{
    name: "mobile-dependencies",
    path: resolvedDependencyRoot,
    destination: "apps/kcoder-studio/mobile/node_modules",
  }], { includeNodeModules: true });

  const sourceHashStartedAtUtc = new Date().toISOString();
  const sourceBefore = await hashSourceRoots(inputRoots);
  const sourceHashCompletedAtUtc = new Date().toISOString();

  const ownedBuildRoot = context.pathInState("mobile-build-source");
  const ownedProjectRoot = resolve(ownedBuildRoot, "apps/kcoder-studio");
  const ownedMobileRoot = resolve(ownedProjectRoot, "mobile");
  assert.ok(
    ownedBuildRoot.startsWith(`${context.stateDir}${sep}`),
    "Mobile Web source snapshot must remain inside this RunContext's state directory",
  );
  await assertPathDoesNotExist(ownedBuildRoot);
  await mkdir(ownedBuildRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory("owned Mobile Web source and dependency snapshot", ownedBuildRoot);

  const ownedDependencyRoot = resolve(ownedMobileRoot, "node_modules");
  const ownedOutput = context.pathInState(outputName);
  assert.ok(
    ownedOutput.startsWith(`${context.stateDir}${sep}`),
    "Mobile Web output must remain inside this RunContext's state directory",
  );
  await assertPathDoesNotExist(ownedOutput);
  await mkdir(ownedOutput, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory(`${label} output`, ownedOutput);

  const temporaryDirectory = context.pathInState("mobile-export-tmp");
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  context.registerTemporaryDirectory("Mobile Web export temporary files", temporaryDirectory);
  const buildEnvironment = context.isolatedEnvironment({
    CI: "1",
    EXPO_NO_TELEMETRY: "1",
    EXPO_NO_DOTENV: "1",
    EXPO_OFFLINE: "1",
    EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP: "0",
    KCODER_STUDIO_ALLOW_HTTP: "0",
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
  });

  let exporterPid = null;
  let terminalBuilderPid = null;
  let dependencyCopierPid = null;
  let exportFailure = null;
  let activePhase = null;
  let failurePhase = null;
  let snapshotBeforeCopy = null;
  let snapshotBeforeTerminalBuild = null;
  let snapshotBeforeTerminalBuildWithoutGenerated = null;
  let snapshotAfterTerminalBuild = null;
  let snapshotBeforeExport = null;
  let snapshotAfterExport = null;
  let dependencyRootAfter = null;
  let ownedDependencyTree = null;
  let generatedTerminalHtmlSha256 = null;
  let generatedTerminalHtmlInputSha256 = null;
  let terminalBuildScriptSha256 = null;
  const exportStartedAtUtc = new Date().toISOString();

  try {
    activePhase = "copy-source";
    for (const root of inputRoots) {
      await copySourceTree(root.path, resolve(ownedBuildRoot, root.destination));
    }
    snapshotBeforeCopy = await hashSourceRoots(ownedSnapshotRoots(ownedBuildRoot, inputRoots));
    if (snapshotBeforeCopy.sha256 !== sourceBefore.sha256) {
      throw new Error("Mobile Web owned source copy does not match its pre-copy source digest");
    }

    activePhase = "copy-dependencies";
    await mkdir(ownedDependencyRoot, { recursive: false, mode: 0o700 });
    const copiedDependencies = await runOwnedProcess(
      context,
      `${label}-dependencies-copy`,
      "cp",
      ["-aL", "--reflink=auto", `${resolvedDependencyRoot}/.`, `${ownedDependencyRoot}/`],
      { cwd: ownedBuildRoot, env: buildEnvironment },
      DEPENDENCY_COPY_TIMEOUT_MS,
    );
    dependencyCopierPid = copiedDependencies.pid;
    ownedDependencyTree = await hashSourceRoots([{
      name: "owned-mobile-dependencies",
      path: ownedDependencyRoot,
      destination: "apps/kcoder-studio/mobile/node_modules",
    }], { includeNodeModules: true, rejectSymlinks: true });
    if (ownedDependencyTree.roots[0].fileCount === 0) {
      throw new Error("Mobile Web dependency copy is empty");
    }

    activePhase = "terminal-build";
    await makeOwnedGeneratedHtmlWritable(context, ownedBuildRoot, ownedMobileRoot);
    snapshotBeforeTerminalBuild = await hashSourceRoots(ownedSnapshotRoots(ownedBuildRoot, inputRoots));
    snapshotBeforeTerminalBuildWithoutGenerated = await hashSourceRoots(
      ownedSnapshotRoots(ownedBuildRoot, inputRoots),
      { omitPaths: new Set([`apps/kcoder-studio/mobile/${TERMINAL_HTML_PATH}`]) },
    );
    if (snapshotBeforeTerminalBuild.sha256 !== sourceBefore.sha256) {
      throw new Error("Mobile Web source snapshot changed before the terminal build hook");
    }
    generatedTerminalHtmlInputSha256 = await hashFileIfPresent(
      resolve(ownedMobileRoot, TERMINAL_HTML_PATH),
    );
    terminalBuildScriptSha256 = await hashFileIfPresent(
      resolve(ownedMobileRoot, "scripts/build-terminal-webview.mjs"),
    );
    assert.ok(terminalBuildScriptSha256, "Mobile Web terminal builder script must exist in the owned source tree");
    const terminalBuilder = await runOwnedProcess(
      context,
      `${label}-terminal-build`,
      process.execPath,
      [resolve(ownedMobileRoot, "scripts/build-terminal-webview.mjs")],
      { cwd: ownedMobileRoot, env: buildEnvironment },
      timeoutMs,
    );
    terminalBuilderPid = terminalBuilder.pid;
    generatedTerminalHtmlSha256 = await hashFileIfPresent(
      resolve(ownedMobileRoot, TERMINAL_HTML_PATH),
    );
    assert.ok(generatedTerminalHtmlSha256, "Mobile Web terminal build must produce generated HTML");
    snapshotAfterTerminalBuild = await hashSourceRoots(
      ownedSnapshotRoots(ownedBuildRoot, inputRoots),
      { omitPaths: new Set([`apps/kcoder-studio/mobile/${TERMINAL_HTML_PATH}`]) },
    );
    if (snapshotAfterTerminalBuild.sha256 !== snapshotBeforeTerminalBuildWithoutGenerated.sha256) {
      throw new Error("Terminal build hook changed files outside its generated HTML output");
    }
    snapshotBeforeExport = await hashSourceRoots(ownedSnapshotRoots(ownedBuildRoot, inputRoots));

    activePhase = "expo-export";
    const expoArguments = buildExpoExportArguments(
      resolve(ownedMobileRoot, "node_modules/expo/bin/cli"),
      ownedOutput,
      sourceMaps,
    );
    const exporter = await runOwnedProcess(
      context,
      `${label}-expo`,
      process.execPath,
      expoArguments,
      { cwd: ownedMobileRoot, env: buildEnvironment },
      timeoutMs,
    );
    exporterPid = exporter.pid;
  } catch (error) {
    exportFailure = error;
    failurePhase = activePhase;
  }

  const exportCompletedAtUtc = new Date().toISOString();
  const sourceHashEndStartedAtUtc = new Date().toISOString();
  const sourceAfter = await hashSourceRoots(inputRoots);
  const sourceHashEndCompletedAtUtc = new Date().toISOString();
  if (await exists(ownedBuildRoot)) {
    snapshotAfterExport = await hashSourceRoots(ownedSnapshotRoots(ownedBuildRoot, inputRoots));
  }
  dependencyRootAfter = await hashSourceRoots([{
    name: "mobile-dependencies",
    path: resolvedDependencyRoot,
    destination: "apps/kcoder-studio/mobile/node_modules",
  }], { includeNodeModules: true });
  const bundleFiles = await hashBundleFiles(ownedOutput);
  const bundleSha256 = hashJson(bundleFiles);
  const sourceMapEvidence = createSourceMapBundleEvidence(sourceMaps, bundleFiles, bundleSha256);
  const sourceMapOutputValid = sourceMaps
    ? sourceMapEvidence.mapFileCount > 0
    : sourceMapEvidence === null && !bundleFiles.some((file) => file.path.endsWith(".map"));
  const indexHtmlSha256 = bundleFiles.find(file => file.path === "index.html")?.sha256 ?? null;
  const sourceUnchanged = sourceBefore.sha256 === sourceAfter.sha256;
  const snapshotUnchangedDuringExport = Boolean(
    snapshotBeforeExport && snapshotAfterExport &&
    snapshotBeforeExport.sha256 === snapshotAfterExport.sha256,
  );
  const snapshotCopyMatchesSource = snapshotBeforeCopy?.sha256 === sourceBefore.sha256;
  const terminalHookChangesOnlyGeneratedHtml = Boolean(
    snapshotBeforeTerminalBuild && snapshotAfterTerminalBuild &&
    snapshotBeforeTerminalBuildWithoutGenerated &&
    snapshotAfterTerminalBuild.sha256 === snapshotBeforeTerminalBuildWithoutGenerated.sha256,
  );
  const dependenciesUnchangedDuringExport = dependencyRootBefore.sha256 === dependencyRootAfter.sha256;
  const sourceOrSnapshotDrift = !sourceUnchanged || !snapshotCopyMatchesSource ||
    !terminalHookChangesOnlyGeneratedHtml || !snapshotUnchangedDuringExport ||
    !dependenciesUnchangedDuringExport;
  const validationErrors = [];
  if (!sourceUnchanged) validationErrors.push("Mobile source changed during export");
  if (!snapshotCopyMatchesSource) validationErrors.push("owned Mobile source copy did not match its input digest");
  if (!terminalHookChangesOnlyGeneratedHtml) validationErrors.push("terminal hook changed unexpected source files");
  if (!snapshotUnchangedDuringExport) validationErrors.push("owned source snapshot changed during Expo export");
  if (!dependenciesUnchangedDuringExport) validationErrors.push("Mobile dependency source changed during export");
  if (!indexHtmlSha256) validationErrors.push("Mobile Web export output is missing index.html");
  if (!sourceMapOutputValid) validationErrors.push(sourceMaps
    ? "sourceMaps=true export did not produce any source map files"
    : "sourceMaps=false export unexpectedly produced source map files");
  const bundleStatus = exportFailure
    ? "export-failed"
    : sourceOrSnapshotDrift
      ? "source-changed-during-export"
      : !indexHtmlSha256
        ? "missing-index-html"
        : !sourceMapOutputValid
          ? "invalid-source-map-output"
        : "complete";
  if (!exportFailure && bundleStatus !== "complete") failurePhase = "post-export-verification";
  const bundleError = exportFailure
    ? context.redactText(errorMessage(exportFailure))
    : validationErrors.length
      ? validationErrors.join("; ")
      : null;
  const bundleManifest = {
    schemaVersion: 2,
    status: bundleStatus,
    failurePhase,
    inputRoots: describeSourceRoots(sourceBefore.roots),
    inputRootsAfter: describeSourceRoots(sourceAfter.roots),
    sourceHashExclusions: [
      ...EXCLUDED_SOURCE_DIRECTORIES,
      "dotenv and credential files",
    ].sort(),
    sourceTreeSha256: sourceBefore.sha256,
    sourceHashBefore: sourceBefore.sha256,
    sourceHashAfter: sourceAfter.sha256,
    sourceUnchanged,
    sourceHashStartedAtUtc,
    sourceHashCompletedAtUtc,
    sourceHashEndStartedAtUtc,
    sourceHashEndCompletedAtUtc,
    ownedBuildRootRelativePath: relative(context.runRoot, ownedBuildRoot),
    buildInputTreeBeforeCopySha256: sourceBefore.sha256,
    buildInputTreeAfterCopySha256: snapshotBeforeCopy?.sha256 ?? null,
    snapshotCopyMatchesSource,
    buildInputTreeBeforeTerminalSha256: snapshotBeforeTerminalBuild?.sha256 ?? null,
    buildInputTreeBeforeTerminalExcludingGeneratedSha256: snapshotBeforeTerminalBuildWithoutGenerated?.sha256 ?? null,
    buildInputTreeAfterTerminalSha256: snapshotBeforeExport?.sha256 ?? null,
    terminalHookChangesOnlyGeneratedHtml,
    buildInputTreeAfterExportSha256: snapshotAfterExport?.sha256 ?? null,
    snapshotUnchangedDuringExport,
    dependencyProvenance: {
      sourceRoot: resolvedDependencyRoot,
      sourceTreeSha256Before: dependencyRootBefore.sha256,
      sourceTreeSha256After: dependencyRootAfter.sha256,
      sourceUnchanged: dependenciesUnchangedDuringExport,
      copiedTreeSha256: ownedDependencyTree?.sha256 ?? null,
      copiedFileCount: ownedDependencyTree?.roots[0]?.fileCount ?? 0,
      copiedSymlinks: false,
      copierPid: dependencyCopierPid,
    },
    terminalWebView: {
      buildScriptSha256: terminalBuildScriptSha256,
      generatedHtmlInputSha256: generatedTerminalHtmlInputSha256,
      generatedHtmlSha256: generatedTerminalHtmlSha256,
      generatedHtmlPath: TERMINAL_HTML_PATH,
      builderPid: terminalBuilderPid,
    },
    exportStartedAtUtc,
    exportCompletedAtUtc,
    exporterPid,
    ownedOutputRelativePath: relative(context.runRoot, ownedOutput),
    bundleSha256,
    bundleFileCount: bundleFiles.length,
    indexHtmlSha256,
    bundleFiles,
    ...(sourceMapEvidence ? { sourceMapEvidence } : {}),
    error: bundleError,
  };
  const bundleManifestPath = await context.writeArtifactJson(
    `mobile-web-export-${label}-manifest.json`,
    bundleManifest,
  );

  if (exportFailure) {
    throw new Error(
      `Mobile Web export failed during ${failurePhase}; see ${relative(context.runRoot, bundleManifestPath)}: ${context.redactText(errorMessage(exportFailure))}`,
    );
  }
  if (bundleStatus !== "complete") {
    throw new Error(
      "Mobile Web export verification failed: " + bundleError + "; see " +
        relative(context.runRoot, bundleManifestPath),
    );
  }

  return {
    path: ownedOutput,
    sourceRoot: resolvedMobileRoot,
    sourceRoots: describeSourceRoots(sourceBefore.roots),
    sourceTreeSha256: sourceBefore.sha256,
    buildInputTreeSha256: snapshotBeforeCopy.sha256,
    dependencyRoot: resolvedDependencyRoot,
    dependencySourceTreeSha256: dependencyRootBefore.sha256,
    dependencyOwnedTreeSha256: ownedDependencyTree.sha256,
    bundleSha256,
    bundleFileCount: bundleFiles.length,
    bundleFiles,
    ...(sourceMapEvidence ? { sourceMapEvidence } : {}),
    bundleManifestPath,
    indexHtmlSha256,
    terminalWebView: bundleManifest.terminalWebView,
    sourceHashStartedAtUtc,
    sourceHashCompletedAtUtc,
    sourceHashEndStartedAtUtc,
    sourceHashEndCompletedAtUtc,
    exportStartedAtUtc,
    exportCompletedAtUtc,
    dependencyCopierPid,
    terminalBuilderPid,
    exporterPid,
  };
}

async function resolveSourceRoots(mobileRoot, sourceRoots) {
  const roots = sourceRoots ?? [
    { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(mobileRoot, "../shared"), destination: "apps/kcoder-studio/shared" },
  ];
  assert.ok(Array.isArray(roots) && roots.length > 0, "Mobile Web requires explicit source roots");
  const resolved = [];
  const seenDestinations = new Set();
  for (const root of roots) {
    assert.ok(root && typeof root.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(root.name), "invalid Mobile Web source root name");
    assert.ok(typeof root.path === "string" && typeof root.destination === "string", "each Mobile Web source root needs path and destination");
    assertSafeRelativeDestination(root.destination);
    assert.ok(!seenDestinations.has(root.destination), `duplicate Mobile Web source destination: ${root.destination}`);
    seenDestinations.add(root.destination);
    const path = await realpath(resolve(root.path));
    await access(path);
    resolved.push({ name: root.name, path, destination: root.destination });
  }
  const mobileSourceRoot = resolved.find(root => root.name === "mobile");
  assert.ok(mobileSourceRoot, "Mobile Web source roots must include the mobile app");
  assert.equal(mobileSourceRoot.path, mobileRoot, "mobileRoot must match the mobile source root path");
  assert.equal(mobileSourceRoot.destination, "apps/kcoder-studio/mobile", "mobile source must use the canonical owned path");
  const sharedSourceRoot = resolved.find(root => root.name === "studio-shared");
  assert.ok(sharedSourceRoot, "Mobile Web source roots must include Studio shared source");
  assert.equal(sharedSourceRoot.destination, "apps/kcoder-studio/shared", "Studio shared source must use the canonical owned path");
  assert.equal(
    sharedSourceRoot.path,
    await realpath(resolve(mobileRoot, "../shared")),
    "Studio shared source must be the sibling of the selected Mobile source root",
  );
  return resolved;
}

function ownedSnapshotRoots(ownedBuildRoot, sourceRoots) {
  return sourceRoots.map(root => ({
    ...root,
    path: resolve(ownedBuildRoot, root.destination),
  }));
}

async function hashSourceRoots(roots, {
  includeNodeModules = false,
  rejectSymlinks = false,
  omitPaths = new Set(),
} = {}) {
  const hashedRoots = [];
  for (const root of roots) {
    const files = await collectTree(root.path, {
      rejectSymlinks,
      omitSourceOnlyFiles: !includeNodeModules,
      omitPaths: new Set([...omitPaths].filter(path => path.startsWith(`${root.destination}/`))
        .map(path => path.slice(root.destination.length + 1))),
    });
    hashedRoots.push({
      name: root.name,
      sourceRoot: root.path,
      destination: root.destination,
      sha256: hashJson(files),
      fileCount: files.length,
    });
  }
  return {
    roots: hashedRoots,
    sha256: hashJson(hashedRoots.map(({ name, destination, sha256 }) => ({ name, destination, sha256 }))),
  };
}

function describeSourceRoots(roots) {
  return roots.map(({ name, sourceRoot, destination, sha256, fileCount }) => ({
    name,
    sourceRoot,
    destination,
    sha256,
    fileCount,
  }));
}

async function copySourceTree(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const children = await readdir(sourceRoot, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (shouldOmitSourceEntry(child.name)) continue;
    const source = resolve(sourceRoot, child.name);
    const destination = resolve(destinationRoot, child.name);
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      throw new Error(`Mobile Web source contains an unsupported symlink: ${relative(sourceRoot, source)}`);
    }
    if (info.isDirectory()) {
      await copySourceTree(source, destination);
    } else if (info.isFile()) {
      await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
    } else {
      throw new Error(`Mobile Web source contains a special file: ${relative(sourceRoot, source)}`);
    }
  }
}

async function makeOwnedGeneratedHtmlWritable(context, ownedBuildRoot, ownedMobileRoot) {
  const expectedBuildRoot = resolve(context.stateDir, "mobile-build-source");
  const expectedMobileRoot = resolve(expectedBuildRoot, "apps/kcoder-studio/mobile");
  const generatedHtmlPath = resolve(expectedMobileRoot, TERMINAL_HTML_PATH);
  assert.equal(ownedBuildRoot, expectedBuildRoot, "terminal HTML output must use this RunContext's owned build root");
  assert.equal(ownedMobileRoot, expectedMobileRoot, "terminal HTML output must use the owned Mobile source root");
  assert.ok(
    generatedHtmlPath.startsWith(`${expectedMobileRoot}${sep}`),
    "terminal HTML output escaped the owned Mobile source root",
  );

  for (const [path, kind] of [
    [context.stateDir, "directory"],
    [expectedBuildRoot, "directory"],
    [expectedMobileRoot, "directory"],
    [generatedHtmlPath, "file"],
  ]) {
    assert.equal(await realpath(path), path, "terminal HTML output path must not traverse a symlink");
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), "terminal HTML output path must not contain a symlink");
    if (kind === "directory") assert.ok(info.isDirectory(), "terminal HTML output parent must be a directory");
    else assert.ok(info.isFile(), "terminal HTML output must be a regular file");
    if (typeof process.getuid === "function") {
      assert.equal(info.uid, process.getuid(), "terminal HTML output path must be owned by this test process");
    }
  }

  const originalInfo = await lstat(generatedHtmlPath);
  assert.equal(originalInfo.nlink, 1, "terminal HTML output must not be a shared hard link");
  if ((originalInfo.mode & 0o200) === 0) await chmod(generatedHtmlPath, 0o600);
  const finalInfo = await lstat(generatedHtmlPath);
  assert.ok(finalInfo.isFile() && !finalInfo.isSymbolicLink(), "terminal HTML output must remain a regular file");
  if (typeof process.getuid === "function") {
    assert.equal(finalInfo.uid, process.getuid(), "terminal HTML output owner changed");
  }
  if ((originalInfo.mode & 0o200) === 0) {
    assert.equal(finalInfo.mode & 0o777, 0o600, "readonly generated HTML input must become owner-writable only");
  }
}

async function assertDependencySymlinksConfined(dependencyRoot) {
  const root = await realpath(dependencyRoot);
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const path = resolve(directory, child.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await realpath(path);
        assert.ok(
          target === root || target.startsWith(`${root}${sep}`),
          "Mobile Web dependency symlink must resolve inside its approved dependency root",
        );
        const targetInfo = await lstat(target);
        if (targetInfo.isDirectory()) {
          const parent = resolve(path, "..");
          assert.ok(
            parent !== target && !parent.startsWith(`${target}${sep}`),
            "Mobile Web dependency symlink cannot point to one of its ancestor directories",
          );
        }
      } else if (info.isDirectory()) {
        await visit(path);
      }
    }
  }
  await visit(root);
}

async function collectTree(root, { rejectSymlinks, omitSourceOnlyFiles = false, omitPaths = new Set() }) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (omitSourceOnlyFiles && shouldOmitSourceEntry(child.name)) continue;
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (omitPaths.has(relativePath)) continue;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        if (rejectSymlinks) throw new Error(`Mobile Web export contains a symlink: ${relativePath}`);
        entries.push({ path: relativePath, type: "symlink", target: await readlink(absolutePath) });
      } else if (info.isDirectory()) {
        if (omitSourceOnlyFiles && EXCLUDED_SOURCE_DIRECTORIES.has(child.name)) continue;
        await visit(absolutePath);
      } else if (info.isFile()) {
        const contents = await readFile(absolutePath);
        entries.push({ path: relativePath, size: contents.length, sha256: hashBytes(contents) });
      } else if (rejectSymlinks) {
        throw new Error(`Mobile Web export contains a non-regular file: ${relativePath}`);
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

async function hashBundleFiles(root) {
  return collectTree(root, { rejectSymlinks: true });
}

async function runOwnedProcess(context, label, command, args, options, timeoutMs) {
  const child = context.spawnOwned(label, command, args, options);
  let spawnError = null;
  child.once("error", error => { spawnError = error; });
  const pid = child.pid ?? null;
  try {
    await waitFor(
      () => spawnError || child.exitCode !== null || child.signalCode !== null,
      timeoutMs,
      `owned Mobile Web process ${label}`,
      100,
      context.abortSignal,
    );
    if (spawnError) throw new Error(`${label} could not start: ${context.redactText(spawnError.message)}`);
    assert.equal(child.exitCode, 0, `${label} exited with ${child.signalCode || `code ${child.exitCode}`}`);
    return { pid };
  } finally {
    await context.stopOwned(label);
  }
}

function shouldOmitSourceEntry(name) {
  if (EXCLUDED_SOURCE_DIRECTORIES.has(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
}

function assertSafeSlug(value, label, maxLength) {
  assert.ok(
    typeof value === "string" && value.length <= maxLength && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value),
    `invalid ${label}`,
  );
}

function assertSafeRelativeDestination(value) {
  assert.ok(
    typeof value === "string" && value.length > 0 && !value.startsWith("/") &&
      value.split(/[\\/]/).every(part => part && part !== "." && part !== ".." && /^[a-zA-Z0-9._-]+$/.test(part)),
    "Mobile Web source destination must be a safe relative path",
  );
}

async function assertPathDoesNotExist(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Mobile Web owned path already exists; refusing to reuse prior bytes");
}

async function hashFileIfPresent(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`expected a regular generated file at ${path}`);
    return hashBytes(await readFile(path));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value) {
  return hashBytes(Buffer.from(JSON.stringify(value)));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
