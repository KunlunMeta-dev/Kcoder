import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  statfs,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { appRoot, waitFor } from "./run-context.mjs";
import { buildExpoExportArguments, createSourceMapBundleEvidence } from "./render-profile-attribution-contract.mjs";
import { shouldOmitMobileSourceEntry as shouldOmitSourceEntry } from './mobile-source-policy.mjs';

const EXCLUDED_SOURCE_DIRECTORIES = new Set([".expo", ".git", "dist", "node_modules"]);
const DEFAULT_EXPORT_TIMEOUT_MS = 180_000;
const DEFAULT_EXPORT_OVERALL_TIMEOUT_MS = 30 * 60_000;
const MAX_EXPORT_OVERALL_TIMEOUT_MS = 60 * 60_000;
const DEPENDENCY_COPY_TIMEOUT_MS = 10 * 60_000;
const SCRATCH_BUILD_FILES_BUDGET_BYTES = 4n * 1024n * 1024n * 1024n;
const SCRATCH_METRO_WORKING_SET_BYTES = 4n * 1024n * 1024n * 1024n;
const SCRATCH_FILESYSTEM_RESERVE_BYTES = 4n * 1024n * 1024n * 1024n;
const SCRATCH_MEMORY_RESERVE_BYTES = 1n * 1024n * 1024n * 1024n;
const DISK_FILESYSTEM_TYPES = new Set(["0xef53"]);
const MAX_MEMINFO_BYTES = 64 * 1024;
const TERMINAL_HTML_PATH = "src/terminal-webview/generated-html.ts";
const EXPORT_PROGRESS_PHASES = new Set([
  "resolve-inputs",
  "dependency-symlink-check",
  "dependency-hash-before",
  "source-hash-before",
  "prepare-owned-state",
  "copy-source",
  "snapshot-hash-after-copy",
  "copy-dependencies",
  "owned-dependency-hash",
  "prepare-terminal-build",
  "terminal-build",
  "terminal-build-verification",
  "snapshot-hash-before-export",
  "expo-export",
  "source-hash-after",
  "snapshot-hash-after-export",
  "dependency-hash-after",
  "bundle-hash",
]);

/**
 * Build a Mobile platform export from explicit source roots into this RunContext's private state.
 *
 * Both the Mobile app and sibling Studio shared source are copied and hashed. An
 * immutable source snapshot may be selected with `mobileRoot` and `sourceRoots`;
 * its dependency cache can be provided separately with `dependencyRoot`. All
 * dependencies are physically materialized in RunContext state before any build
 * hook runs. Set `scratchBaseDirectory` (or the explicit
 * KCODER_E2E_MOBILE_WEB_SCRATCH_BASE opt-in) to place only the build snapshot,
 * copied dependencies, HOME, and temporary files in RunContext-owned scratch;
 * export output stays in RunContext state. `overallTimeoutMs` is a cooperative
 * deadline checked around awaited work; it does not hard-cancel one filesystem operation
 * that is stuck in the kernel. Final failure evidence and owned-child cleanup
 * are allowed to finish after the deadline.
 */
export async function exportMobileWeb(
  context,
  {
    mobileRoot = resolve(appRoot, "mobile"),
    sourceRoots,
    dependencyRoot,
    scratchBaseDirectory = process.env.KCODER_E2E_MOBILE_WEB_SCRATCH_BASE || undefined,
    label = "mobile-web-export",
    outputName = "mobile-web-export",
    stateNamespace,
    timeoutMs = DEFAULT_EXPORT_TIMEOUT_MS,
    overallTimeoutMs = DEFAULT_EXPORT_OVERALL_TIMEOUT_MS,
    onProgress,
    sourceMaps = false,
    deployMount = false,
    platform = "web",
  } = {},
) {
  assertSafeSlug(label, "export label", 100);
  assertSafeSlug(outputName, "export output name", 127);
  if (stateNamespace !== undefined) {
    assertSafeSlug(stateNamespace, "Mobile Web state namespace", 64);
  }
  assert.ok(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10 * 60_000,
    "Mobile Web export timeout must be between 1ms and 10 minutes",
  );
  assert.ok(
    Number.isInteger(overallTimeoutMs) && overallTimeoutMs > 0 &&
      overallTimeoutMs <= MAX_EXPORT_OVERALL_TIMEOUT_MS,
    "Mobile Web overall export timeout must be between 1ms and 60 minutes",
  );
  assert.ok(onProgress === undefined || typeof onProgress === "function", "onProgress must be a function");
  assert.equal(typeof sourceMaps, "boolean", "Mobile Web sourceMaps option must be a boolean");
  assert.equal(typeof deployMount, "boolean", "Mobile Web deployMount option must be a boolean");
  assert.ok(["android", "ios", "web"].includes(platform), "Mobile export platform must be android, ios, or web");
  assert.ok(!deployMount || platform === "web", "Mobile deploy mount requires a Web export");
  assert.ok(
    scratchBaseDirectory === undefined ||
      (typeof scratchBaseDirectory === "string" && isAbsolute(scratchBaseDirectory)),
    "Mobile Web scratch base directory must be an absolute path",
  );

  const statePath = (...parts) => context.pathInState(
    ...(stateNamespace === undefined ? parts : [stateNamespace, ...parts]),
  );
  let resolvedMobileRoot = null;
  let resolvedDependencyRoot = null;
  let inputRoots = null;
  let dependencyRootBefore = null;
  let dependencyCopyEstimateBytes = null;
  let sourceBefore = null;
  let sourceAfter = null;
  let ownedBuildRoot = statePath("mobile-build-source");
  let ownedProjectRoot = resolve(ownedBuildRoot, "apps/kcoder-studio");
  let ownedMobileRoot = resolve(ownedProjectRoot, "mobile");
  let ownedDependencyRoot = resolve(ownedMobileRoot, "node_modules");
  const ownedOutput = statePath(outputName);
  let temporaryDirectory = statePath("mobile-export-tmp");
  let isolatedHomeDirectory = null;
  let scratchDirectory = null;
  let scratchCapacity = null;
  const budget = createExportDeadline(context, overallTimeoutMs, onProgress);
  let buildEnvironment = null;
  let exporterPid = null;
  let terminalBuilderPid = null;
  let dependencyCopierPid = null;
  let exportFailure = null;
  let failurePhase = null;
  let snapshotBeforeCopy = null;
  let snapshotBeforeTerminalBuild = null;
  let snapshotBeforeTerminalBuildWithoutGenerated = null;
  let snapshotAfterTerminalBuild = null;
  let snapshotBeforeExport = null;
  let snapshotAfterExport = null;
  let dependencyRootAfter = null;
  let ownedDependencyTree = null;
  let bundleFiles = null;
  let bundleWasHashed = false;
  let generatedTerminalHtmlSha256 = null;
  let generatedTerminalHtmlInputSha256 = null;
  let terminalBuildScriptSha256 = null;
  let sourceHashStartedAtUtc = null;
  let sourceHashCompletedAtUtc = null;
  let sourceHashEndStartedAtUtc = null;
  let sourceHashEndCompletedAtUtc = null;
  const verificationFailures = [];
  const exportStartedAtUtc = new Date().toISOString();

  try {
    await budget.runPhase("resolve-inputs", async () => {
      if (stateNamespace !== undefined) {
        const namespaceRoot = context.pathInState(stateNamespace);
        await assertPathDoesNotExist(namespaceRoot, budget);
        await budget.io(async () => {
          await mkdir(namespaceRoot, { recursive: false, mode: 0o700 });
          context.registerTemporaryDirectory(`${label} state namespace`, namespaceRoot);
        });
      }
      resolvedMobileRoot = await budget.io(() => realpath(resolve(mobileRoot)));
      inputRoots = await resolveSourceRoots(resolvedMobileRoot, sourceRoots, budget);
      resolvedDependencyRoot = await budget.io(() => realpath(resolve(
        dependencyRoot ?? resolve(resolvedMobileRoot, "node_modules"),
      )));
      await budget.io(() => access(resolve(resolvedDependencyRoot, "expo/package.json")));
    });
    await budget.runPhase("dependency-symlink-check", async () => {
      dependencyCopyEstimateBytes = await assertDependencySymlinksConfined(
        resolvedDependencyRoot,
        budget,
        { measureCopyBytes: scratchBaseDirectory !== undefined },
      );
    });
    await budget.runPhase("dependency-hash-before", async () => {
      dependencyRootBefore = await hashSourceRoots([{
        name: "mobile-dependencies",
        path: resolvedDependencyRoot,
        destination: "apps/kcoder-studio/mobile/node_modules",
      }], { includeNodeModules: true, budget });
    });
    await budget.runPhase("source-hash-before", async () => {
      sourceHashStartedAtUtc = new Date().toISOString();
      sourceBefore = await hashSourceRoots(inputRoots, { budget });
      sourceHashCompletedAtUtc = new Date().toISOString();
    });
    await budget.runPhase("prepare-owned-state", async () => {
      if (scratchBaseDirectory !== undefined) {
        assert.ok(dependencyCopyEstimateBytes !== null, "Mobile dependency copy size estimate is missing");
        const sourceBytes = sourceBefore.roots.reduce((sum, root) => sum + root.fileBytes, 0n);
        const scratchFilesystem = await budget.io(() => statfs(scratchBaseDirectory, { bigint: true }));
        scratchCapacity = planMobileWebScratchCapacity({
          sourceBytes,
          dependencyBytes: dependencyCopyEstimateBytes,
          filesystemType: scratchFilesystem.type,
        });
        const memoryAvailableBytes = await readMemAvailableBytes(budget);
        scratchDirectory = await budget.io(() => context.createOwnedScratchDirectory(
          "mobile-web-build",
          {
            baseDirectory: scratchBaseDirectory,
            requiredBytes: scratchCapacity.requiredBytes,
            reserveBytes: scratchCapacity.reserveBytes,
            requiredMemoryBytes: scratchCapacity.requiredMemoryBytes,
            expectedFilesystemType: scratchCapacity.filesystemType,
            availableMemoryBytes: memoryAvailableBytes,
          },
        ));
        ownedBuildRoot = context.pathInScratch(scratchDirectory, "mobile-build-source");
        temporaryDirectory = context.pathInScratch(scratchDirectory, "tmp");
        isolatedHomeDirectory = context.pathInScratch(scratchDirectory, "home");
      } else {
        assert.ok(
          ownedBuildRoot.startsWith(`${context.stateDir}${sep}`),
          "Mobile Web source snapshot must remain inside this RunContext's state directory",
        );
      }
      ownedProjectRoot = resolve(ownedBuildRoot, "apps/kcoder-studio");
      ownedMobileRoot = resolve(ownedProjectRoot, "mobile");
      ownedDependencyRoot = resolve(ownedMobileRoot, "node_modules");
      await assertPathDoesNotExist(ownedBuildRoot, budget);
      await budget.io(async () => {
        await mkdir(ownedBuildRoot, { recursive: false, mode: 0o700 });
        if (!scratchDirectory) {
          context.registerTemporaryDirectory("owned Mobile Web source and dependency snapshot", ownedBuildRoot);
        }
      });

      assert.ok(
        ownedOutput.startsWith(`${context.stateDir}${sep}`),
        "Mobile Web output must remain inside this RunContext's state directory",
      );
      await assertPathDoesNotExist(ownedOutput, budget);
      await budget.io(async () => {
        await mkdir(ownedOutput, { recursive: false, mode: 0o700 });
        context.registerTemporaryDirectory(`${label} output`, ownedOutput);
      });

      await budget.io(async () => {
        await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
        if (!scratchDirectory) {
          context.registerTemporaryDirectory("Mobile Web export temporary files", temporaryDirectory);
        }
      });
      if (scratchDirectory) {
        await budget.io(() => mkdir(isolatedHomeDirectory, { recursive: false, mode: 0o700 }));
      }
      const environmentOverrides = {
        CI: "1",
        EXPO_NO_TELEMETRY: "1",
        EXPO_NO_DOTENV: "1",
        EXPO_OFFLINE: "1",
        EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP: "0",
        KCODER_STUDIO_ALLOW_HTTP: "0",
        TMPDIR: temporaryDirectory,
        TMP: temporaryDirectory,
        TEMP: temporaryDirectory,
      };
      if (scratchDirectory) {
        environmentOverrides.HOME = isolatedHomeDirectory;
        environmentOverrides.USERPROFILE = isolatedHomeDirectory;
      }
      buildEnvironment = context.isolatedEnvironment(environmentOverrides);
    });

    await budget.runPhase("copy-source", async () => {
      assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
      for (const root of inputRoots) {
        await copySourceTree(root.path, resolve(ownedBuildRoot, root.destination), budget);
      }
    });
    await budget.runPhase("snapshot-hash-after-copy", async () => {
      assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
      snapshotBeforeCopy = await hashSourceRoots(ownedSnapshotRoots(ownedBuildRoot, inputRoots), { budget });
      if (snapshotBeforeCopy.sha256 !== sourceBefore.sha256) {
        throw new Error("Mobile Web owned source copy does not match its pre-copy source digest");
      }
    });

    await budget.runPhase("copy-dependencies", async () => {
      assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
      await budget.io(() => mkdir(ownedDependencyRoot, { recursive: false, mode: 0o700 }));
      const copiedDependencies = await runOwnedProcess(
        context,
        `${label}-dependencies-copy`,
        "cp",
        ["-aL", "--reflink=auto", `${resolvedDependencyRoot}/.`, `${ownedDependencyRoot}/`],
        { cwd: ownedBuildRoot, env: buildEnvironment },
        DEPENDENCY_COPY_TIMEOUT_MS,
        budget,
      );
      dependencyCopierPid = copiedDependencies.pid;
    });
    await budget.runPhase("owned-dependency-hash", async () => {
      assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
      ownedDependencyTree = await hashSourceRoots([{
        name: "owned-mobile-dependencies",
        path: ownedDependencyRoot,
        destination: "apps/kcoder-studio/mobile/node_modules",
      }], { includeNodeModules: true, rejectSymlinks: true, budget });
      if (ownedDependencyTree.roots[0].fileCount === 0) {
        throw new Error("Mobile Web dependency copy is empty");
      }
    });

    await budget.runPhase("prepare-terminal-build", async () => {
      assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
      await makeOwnedGeneratedHtmlWritable(context, ownedBuildRoot, ownedMobileRoot, stateNamespace, budget, scratchDirectory);
      snapshotBeforeTerminalBuild = await hashSourceRoots(ownedSnapshotRoots(ownedBuildRoot, inputRoots), { budget });
      snapshotBeforeTerminalBuildWithoutGenerated = await hashSourceRoots(
        ownedSnapshotRoots(ownedBuildRoot, inputRoots),
        { omitPaths: new Set([`apps/kcoder-studio/mobile/${TERMINAL_HTML_PATH}`]), budget },
      );
      if (snapshotBeforeTerminalBuild.sha256 !== sourceBefore.sha256) {
        throw new Error("Mobile Web source snapshot changed before the terminal build hook");
      }
      generatedTerminalHtmlInputSha256 = await hashFileIfPresent(
        resolve(ownedMobileRoot, TERMINAL_HTML_PATH), budget,
      );
      terminalBuildScriptSha256 = await hashFileIfPresent(
        resolve(ownedMobileRoot, "scripts/build-terminal-webview.mjs"), budget,
      );
      assert.ok(terminalBuildScriptSha256, "Mobile Web terminal builder script must exist in the owned source tree");
    });
    await budget.runPhase("terminal-build", async () => {
      assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
      const terminalBuilder = await runOwnedProcess(
        context,
        `${label}-terminal-build`,
        process.execPath,
        [resolve(ownedMobileRoot, "scripts/build-terminal-webview.mjs")],
        { cwd: ownedMobileRoot, env: buildEnvironment },
        timeoutMs,
        budget,
      );
      terminalBuilderPid = terminalBuilder.pid;
    });
    await budget.runPhase("terminal-build-verification", async () => {
      assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
      generatedTerminalHtmlSha256 = await hashFileIfPresent(
        resolve(ownedMobileRoot, TERMINAL_HTML_PATH), budget,
      );
      assert.ok(generatedTerminalHtmlSha256, "Mobile Web terminal build must produce generated HTML");
      snapshotAfterTerminalBuild = await hashSourceRoots(
        ownedSnapshotRoots(ownedBuildRoot, inputRoots),
        { omitPaths: new Set([`apps/kcoder-studio/mobile/${TERMINAL_HTML_PATH}`]), budget },
      );
      if (snapshotAfterTerminalBuild.sha256 !== snapshotBeforeTerminalBuildWithoutGenerated.sha256) {
        throw new Error("Terminal build hook changed files outside its generated HTML output");
      }
    });
    await budget.runPhase("snapshot-hash-before-export", async () => {
      assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
      snapshotBeforeExport = await hashSourceRoots(ownedSnapshotRoots(ownedBuildRoot, inputRoots), { budget });
    });

    await budget.runPhase("expo-export", async () => {
      assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
      const expoArguments = buildExpoExportArguments(
        resolve(ownedMobileRoot, "node_modules/expo/bin/cli"),
        ownedOutput,
        sourceMaps,
        platform,
      );
      const expoEnvironment = deployMount
        ? { ...buildEnvironment, KCODER_STUDIO_MOBILE_WEB_DEPLOY: "1" }
        : buildEnvironment;
      const exporter = await runOwnedProcess(
        context,
        `${label}-expo`,
        process.execPath,
        expoArguments,
        { cwd: ownedMobileRoot, env: expoEnvironment },
        timeoutMs,
        budget,
      );
      exporterPid = exporter.pid;
    });
  } catch (error) {
    exportFailure = budget.errorFor(error);
    failurePhase = budget.lastPhase ?? "resolve-inputs";
  }

  const exportCompletedAtUtc = new Date().toISOString();
  const runVerificationPhase = async (phase, callback) => {
    if (!budget.canContinue()) {
      const error = budget.errorFor(new Error("Mobile Web verification skipped after export deadline or owner abort"));
      budget.recordSkippedPhase(phase);
      verificationFailures.push({ phase, error: context.redactText(errorMessage(error)) });
      if (!exportFailure) {
        exportFailure = error;
        failurePhase = phase;
      }
      return;
    }
    try {
      await budget.runPhase(phase, callback);
    } catch (error) {
      const safeError = context.redactText(errorMessage(budget.errorFor(error)));
      verificationFailures.push({ phase, error: safeError });
      if (!exportFailure) {
        exportFailure = budget.errorFor(error);
        failurePhase = phase;
      }
    }
  };
  try {
    if (inputRoots && sourceBefore) {
      await runVerificationPhase("source-hash-after", async () => {
        sourceHashEndStartedAtUtc = new Date().toISOString();
        sourceAfter = await hashSourceRoots(inputRoots, { budget });
        sourceHashEndCompletedAtUtc = new Date().toISOString();
      });
    }
    if (ownedBuildRoot && inputRoots && snapshotBeforeCopy) {
      await runVerificationPhase("snapshot-hash-after-export", async () => {
        assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath);
        if (await exists(ownedBuildRoot, budget)) {
          snapshotAfterExport = await hashSourceRoots(ownedSnapshotRoots(ownedBuildRoot, inputRoots), { budget });
        }
      });
    }
    if (resolvedDependencyRoot && dependencyRootBefore) {
      await runVerificationPhase("dependency-hash-after", async () => {
        dependencyRootAfter = await hashSourceRoots([{
          name: "mobile-dependencies",
          path: resolvedDependencyRoot,
          destination: "apps/kcoder-studio/mobile/node_modules",
        }], { includeNodeModules: true, budget });
      });
    }
    if (ownedOutput) {
      await runVerificationPhase("bundle-hash", async () => {
        if (await exists(ownedOutput, budget)) {
          bundleFiles = await hashBundleFiles(ownedOutput, budget);
          bundleWasHashed = true;
        }
      });
    }
  } finally {
    budget.dispose();
  }

  if (scratchDirectory) {
    try {
      await context.removeOwnedScratchDirectory(scratchDirectory);
    } catch (error) {
      exportFailure ??= error;
      failurePhase ??= "scratch-cleanup";
    }
  }

  const files = bundleFiles ?? [];
  const bundleSha256 = bundleWasHashed ? hashJson(files) : null;
  const sourceMapEvidence = bundleWasHashed
    ? createSourceMapBundleEvidence(sourceMaps, files, bundleSha256)
    : null;
  const sourceMapOutputValid = sourceMaps
    ? Boolean(sourceMapEvidence && sourceMapEvidence.mapFileCount > 0 && bundleWasHashed)
    : sourceMapEvidence === null && !files.some((file) => file.path.endsWith(".map")) && bundleWasHashed;
  const indexHtmlSha256 = platform === "web" ? files.find(file => file.path === "index.html")?.sha256 ?? null : null;
  const platformOutputInspection = await inspectPlatformOutput(ownedOutput, files, platform);
  const sourceUnchanged = Boolean(sourceBefore && sourceAfter && sourceBefore.sha256 === sourceAfter.sha256);
  const snapshotUnchangedDuringExport = Boolean(
    snapshotBeforeExport && snapshotAfterExport &&
    snapshotBeforeExport.sha256 === snapshotAfterExport.sha256,
  );
  const snapshotCopyMatchesSource = Boolean(sourceBefore && snapshotBeforeCopy?.sha256 === sourceBefore.sha256);
  const terminalHookChangesOnlyGeneratedHtml = Boolean(
    snapshotBeforeTerminalBuild && snapshotAfterTerminalBuild &&
    snapshotBeforeTerminalBuildWithoutGenerated &&
    snapshotAfterTerminalBuild.sha256 === snapshotBeforeTerminalBuildWithoutGenerated.sha256,
  );
  const dependenciesUnchangedDuringExport = Boolean(
    dependencyRootBefore && dependencyRootAfter && dependencyRootBefore.sha256 === dependencyRootAfter.sha256,
  );
  const sourceOrSnapshotDrift = !sourceUnchanged || !snapshotCopyMatchesSource ||
    !terminalHookChangesOnlyGeneratedHtml || !snapshotUnchangedDuringExport ||
    !dependenciesUnchangedDuringExport;
  const validationErrors = [];
  if (!sourceBefore) validationErrors.push("Mobile source pre-export hash did not complete");
  if (!dependencyRootBefore) validationErrors.push("Mobile dependency pre-export hash did not complete");
  if (!sourceAfter) validationErrors.push("Mobile source post-export hash did not complete");
  if (!dependencyRootAfter) validationErrors.push("Mobile dependency post-export hash did not complete");
  if (!sourceUnchanged) validationErrors.push("Mobile source changed during export");
  if (!snapshotCopyMatchesSource) validationErrors.push("owned Mobile source copy did not match its input digest");
  if (!terminalHookChangesOnlyGeneratedHtml) validationErrors.push("terminal hook changed unexpected source files");
  if (!snapshotUnchangedDuringExport) validationErrors.push("owned source snapshot changed during Expo export");
  if (!dependenciesUnchangedDuringExport) validationErrors.push("Mobile dependency source changed during export");
  if (!bundleWasHashed) validationErrors.push("Mobile Web bundle post-export hash did not complete");
  if (!platformOutputInspection.valid) validationErrors.push(platformOutputInspection.error);
  if (!sourceMapOutputValid) validationErrors.push(sourceMaps
    ? "sourceMaps=true export did not produce any source map files"
    : "sourceMaps=false export unexpectedly produced source map files");
  const bundleStatus = exportFailure
    ? "export-failed"
    : sourceOrSnapshotDrift
      ? "source-changed-during-export"
      : !platformOutputInspection.valid
        ? platformOutputInspection.status
        : !sourceMapOutputValid
          ? "invalid-source-map-output"
        : "complete";
  if (!exportFailure && bundleStatus !== "complete") failurePhase = "post-export-verification";
  const bundleError = exportFailure
    ? [
      context.redactText(errorMessage(exportFailure)),
      ...verificationFailures.map(entry => `${entry.phase}: ${entry.error}`),
    ].join("; ")
    : validationErrors.length
      ? validationErrors.join("; ")
      : null;
  const bundleManifest = {
    schemaVersion: 2,
    status: bundleStatus,
    failurePhase,
    inputRoots: sourceBefore ? describeSourceRoots(sourceBefore.roots) : [],
    inputRootsAfter: sourceAfter ? describeSourceRoots(sourceAfter.roots) : [],
    sourceHashExclusions: [
      ...EXCLUDED_SOURCE_DIRECTORIES,
      "dotenv and credential files",
    ].sort(),
    sourceTreeSha256: sourceBefore?.sha256 ?? null,
    sourceHashBefore: sourceBefore?.sha256 ?? null,
    sourceHashAfter: sourceAfter?.sha256 ?? null,
    sourceUnchanged,
    sourceHashStartedAtUtc,
    sourceHashCompletedAtUtc,
    sourceHashEndStartedAtUtc,
    sourceHashEndCompletedAtUtc,
    ownedBuildRootRelativePath: scratchDirectory ? null : relative(context.runRoot, ownedBuildRoot),
    ...(scratchDirectory ? {
      buildScratch: {
        label: scratchDirectory.label,
        path: scratchDirectory.path,
        basePath: scratchDirectory.basePath,
        dev: scratchDirectory.dev,
        ino: scratchDirectory.ino,
        uid: scratchDirectory.uid,
        mode: scratchDirectory.mode,
        filesystemType: scratchDirectory.filesystemType,
        filesystemBackingMode: scratchCapacity.filesystemBackingMode,
        filesystemAccountingMode: scratchCapacity.filesystemAccountingMode,
        memoryAccountingMode: scratchCapacity.memoryAccountingMode,
        sourceBytes: scratchCapacity.sourceBytes.toString(),
        dependencyCopyBytes: scratchCapacity.dependencyBytes.toString(),
        buildFilesBudgetBytes: scratchCapacity.buildFilesBudgetBytes.toString(),
        metroWorkingSetBytes: scratchCapacity.metroWorkingSetBytes.toString(),
        memoryReserveBytes: scratchCapacity.memoryReserveBytes.toString(),
        requiredBytes: scratchCapacity.requiredBytes.toString(),
        reserveBytes: scratchCapacity.reserveBytes.toString(),
        totalRequiredBytes: scratchCapacity.totalRequiredBytes.toString(),
        requiredMemoryBytes: scratchCapacity.requiredMemoryBytes.toString(),
        filesystemAvailableBytes: scratchDirectory.filesystemAvailableBytes,
        memoryAvailableBytes: scratchDirectory.memoryAvailableBytes,
        cleanupStatus: scratchDirectory.cleanupStatus,
      },
    } : {}),
    buildInputTreeBeforeCopySha256: sourceBefore?.sha256 ?? null,
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
      sourceTreeSha256Before: dependencyRootBefore?.sha256 ?? null,
      sourceTreeSha256After: dependencyRootAfter?.sha256 ?? null,
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
    platform,
    platformOutputEvidence: platformOutputInspection.evidence,
    bundleSha256,
    bundleFileCount: files.length,
    indexHtmlSha256,
    bundleFiles: files,
    ...(sourceMapEvidence ? { sourceMapEvidence } : {}),
    deployMount,
    overallDeadline: {
      timeoutMs: overallTimeoutMs,
      elapsedMs: budget.elapsedMs(),
      cooperative: true,
      outcome: budget.signal.aborted
        ? budget.signal.reason?.code === "MOBILE_WEB_EXPORT_OVERALL_DEADLINE"
          ? "deadline-exceeded"
          : "owner-aborted"
        : exportFailure
          ? "failed"
          : "completed",
      phases: budget.snapshot(),
    },
    verificationFailures,
    error: bundleError,
  };
  const bundleManifestName = `mobile-web-export-${label}-manifest.json`;
  let bundleManifestPath;
  try {
    if (exportFailure && context.abortReason && !context.finishing && !context.finished) {
      bundleManifestPath = await context.writeArtifactJsonInternal(bundleManifestName, bundleManifest);
    } else {
      bundleManifestPath = await context.writeArtifactJson(bundleManifestName, bundleManifest);
    }
  } catch (manifestWriteError) {
    if (!exportFailure) throw manifestWriteError;
    const primaryMessage = context.redactText(errorMessage(exportFailure));
    const writeMessage = context.redactText(errorMessage(manifestWriteError));
    throw new AggregateError(
      [exportFailure, manifestWriteError],
      `Mobile Web export failed during ${failurePhase} (${primaryMessage}); failure manifest write also failed (${writeMessage})`,
      { cause: exportFailure },
    );
  }

  if (exportFailure) {
    throw new Error(
      `Mobile Web export failed during ${failurePhase}; see ${relative(context.runRoot, bundleManifestPath)}: ${context.redactText(errorMessage(exportFailure))}`,
    );
  }
  if (bundleStatus !== "complete") {
    throw new Error(
      "Mobile export verification failed: " + bundleError + "; see " +
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
    bundleFiles: files,
    ...(sourceMapEvidence ? { sourceMapEvidence } : {}),
    platform,
    platformOutputEvidence: platformOutputInspection.evidence,
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

async function resolveSourceRoots(mobileRoot, sourceRoots, budget) {
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
    const path = await budget.io(() => realpath(resolve(root.path)));
    await budget.io(() => access(path));
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
    await budget.io(() => realpath(resolve(mobileRoot, "../shared"))),
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
  budget,
} = {}) {
  const hashedRoots = [];
  for (const root of roots) {
    const files = await collectTree(root.path, {
      rejectSymlinks,
      omitSourceOnlyFiles: !includeNodeModules,
      omitPaths: new Set([...omitPaths].filter(path => path.startsWith(`${root.destination}/`))
        .map(path => path.slice(root.destination.length + 1))),
      budget,
    });
    hashedRoots.push({
      name: root.name,
      sourceRoot: root.path,
      destination: root.destination,
      sha256: hashJson(files),
      fileCount: files.length,
      fileBytes: files.reduce((sum, file) => sum + BigInt(file.size ?? 0), 0n),
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

async function copySourceTree(sourceRoot, destinationRoot, budget, originalRoot = sourceRoot) {
  await budget.io(() => mkdir(destinationRoot, { recursive: true, mode: 0o700 }));
  const children = await budget.io(() => readdir(sourceRoot, { withFileTypes: true }));
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (shouldOmitSourceEntry(child.name, relative(originalRoot, resolve(sourceRoot, child.name)).split(sep).join('/'), child.isDirectory())) continue;
    const source = resolve(sourceRoot, child.name);
    const destination = resolve(destinationRoot, child.name);
    const info = await budget.io(() => lstat(source));
    if (info.isSymbolicLink()) {
      throw new Error(`Mobile Web source contains an unsupported symlink: ${relative(sourceRoot, source)}`);
    }
    if (info.isDirectory()) {
      await copySourceTree(source, destination, budget, originalRoot);
    } else if (info.isFile()) {
      await budget.io(() => mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 }));
      await budget.io(() => copyFile(source, destination));
      budget.fileCompleted();
    } else {
      throw new Error(`Mobile Web source contains a special file: ${relative(sourceRoot, source)}`);
    }
  }
}

async function makeOwnedGeneratedHtmlWritable(
  context,
  ownedBuildRoot,
  ownedMobileRoot,
  stateNamespace,
  budget,
  scratchDirectory,
) {
  const expectedBuildRoot = scratchDirectory
    ? context.pathInScratch(scratchDirectory, "mobile-build-source")
    : stateNamespace === undefined
      ? context.pathInState("mobile-build-source")
      : context.pathInState(stateNamespace, "mobile-build-source");
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
    assert.equal(await budget.io(() => realpath(path)), path, "terminal HTML output path must not traverse a symlink");
    const info = await budget.io(() => lstat(path));
    assert.ok(!info.isSymbolicLink(), "terminal HTML output path must not contain a symlink");
    if (kind === "directory") assert.ok(info.isDirectory(), "terminal HTML output parent must be a directory");
    else assert.ok(info.isFile(), "terminal HTML output must be a regular file");
    if (typeof process.getuid === "function") {
      assert.equal(info.uid, process.getuid(), "terminal HTML output path must be owned by this test process");
    }
  }

  const originalInfo = await budget.io(() => lstat(generatedHtmlPath));
  assert.equal(originalInfo.nlink, 1, "terminal HTML output must not be a shared hard link");
  if ((originalInfo.mode & 0o200) === 0) await budget.io(() => chmod(generatedHtmlPath, 0o600));
  const finalInfo = await budget.io(() => lstat(generatedHtmlPath));
  assert.ok(finalInfo.isFile() && !finalInfo.isSymbolicLink(), "terminal HTML output must remain a regular file");
  if (typeof process.getuid === "function") {
    assert.equal(finalInfo.uid, process.getuid(), "terminal HTML output owner changed");
  }
  if ((originalInfo.mode & 0o200) === 0) {
    assert.equal(finalInfo.mode & 0o777, 0o600, "readonly generated HTML input must become owner-writable only");
  }
}

async function assertDependencySymlinksConfined(dependencyRoot, budget, { measureCopyBytes = false } = {}) {
  const root = await budget.io(() => realpath(dependencyRoot));
  if (measureCopyBytes) {
    let totalBytes = 0n;
    async function visit(directory, ancestors) {
      const directoryInfo = await budget.io(() => lstat(directory, { bigint: true }));
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new Error("Mobile Web dependency copy estimate encountered a non-directory");
      }
      const identity = `${directoryInfo.dev}:${directoryInfo.ino}`;
      if (ancestors.has(identity)) {
        throw new Error("Mobile Web dependency symlink traversal contains a directory cycle");
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(identity);
      const children = await budget.io(() => readdir(directory, { withFileTypes: true }));
      for (const child of children) {
        const path = resolve(directory, child.name);
        const info = await budget.io(() => lstat(path, { bigint: true }));
        if (info.isSymbolicLink()) {
          const target = await budget.io(() => realpath(path));
          assertDependencyTargetInsideRoot(root, target);
          const targetInfo = await budget.io(() => lstat(target, { bigint: true }));
          if (targetInfo.isDirectory()) {
            await visit(target, nextAncestors);
          } else if (targetInfo.isFile()) {
            totalBytes += targetInfo.size;
            budget.fileCompleted();
          } else {
            throw new Error("Mobile Web dependency symlink resolves to a special file");
          }
        } else if (info.isDirectory()) {
          await visit(path, nextAncestors);
        } else if (info.isFile()) {
          totalBytes += info.size;
          budget.fileCompleted();
        } else {
          throw new Error("Mobile Web dependency copy estimate encountered a special file");
        }
      }
    }
    await visit(root, new Set());
    return totalBytes;
  }

  async function visit(directory) {
    const children = await budget.io(() => readdir(directory, { withFileTypes: true }));
    for (const child of children) {
      const path = resolve(directory, child.name);
      const info = await budget.io(() => lstat(path));
      if (info.isSymbolicLink()) {
        const target = await budget.io(() => realpath(path));
        assertDependencyTargetInsideRoot(root, target);
        const targetInfo = await budget.io(() => lstat(target));
        if (targetInfo.isDirectory()) {
          const parent = resolve(path, "..");
          assert.ok(
            parent !== target && !parent.startsWith(`${target}${sep}`),
            "Mobile Web dependency symlink cannot point to one of its ancestor directories",
          );
        }
      } else if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile()) {
        budget.fileCompleted();
      }
    }
  }
  await visit(root);
  return null;
}

function assertDependencyTargetInsideRoot(root, target) {
  assert.ok(
    target === root || target.startsWith(`${root}${sep}`),
    "Mobile Web dependency symlink must resolve inside its approved dependency root",
  );
}

export function planMobileWebScratchCapacity({ sourceBytes, dependencyBytes, filesystemType }) {
  const sourceSize = nonNegativeBigInt(sourceBytes, "Mobile Web source bytes");
  const dependencySize = nonNegativeBigInt(dependencyBytes, "Mobile Web dependency copy bytes");
  const normalizedFilesystemType = formatFilesystemType(filesystemType);
  const filesystemPayloadBytes = sourceSize + dependencySize;
  const requiredBytes = filesystemPayloadBytes + SCRATCH_BUILD_FILES_BUDGET_BYTES;
  const requiredMemoryBytes = DISK_FILESYSTEM_TYPES.has(normalizedFilesystemType)
    ? SCRATCH_METRO_WORKING_SET_BYTES + SCRATCH_MEMORY_RESERVE_BYTES
    : requiredBytes + SCRATCH_METRO_WORKING_SET_BYTES + SCRATCH_MEMORY_RESERVE_BYTES;
  return {
    sourceBytes: sourceSize,
    dependencyBytes: dependencySize,
    filesystemType: normalizedFilesystemType,
    filesystemBackingMode: DISK_FILESYSTEM_TYPES.has(normalizedFilesystemType)
      ? "known-disk-backed"
      : "ram-backed-or-unknown",
    filesystemAccountingMode: "source-dependencies-plus-build-files-and-reserve",
    memoryAccountingMode: DISK_FILESYSTEM_TYPES.has(normalizedFilesystemType)
      ? "metro-working-set-plus-memory-reserve"
      : "filesystem-payload-plus-metro-working-set-and-memory-reserve",
    buildFilesBudgetBytes: SCRATCH_BUILD_FILES_BUDGET_BYTES,
    metroWorkingSetBytes: SCRATCH_METRO_WORKING_SET_BYTES,
    memoryReserveBytes: SCRATCH_MEMORY_RESERVE_BYTES,
    requiredBytes,
    reserveBytes: SCRATCH_FILESYSTEM_RESERVE_BYTES,
    totalRequiredBytes: requiredBytes + SCRATCH_FILESYSTEM_RESERVE_BYTES,
    requiredMemoryBytes,
  };
}

function formatFilesystemType(type) {
  if (typeof type === "bigint") return `0x${type.toString(16)}`;
  if (typeof type === "number" && Number.isSafeInteger(type)) return `0x${BigInt(type).toString(16)}`;
  if (typeof type === "string" && /^0x[\da-f]+$/i.test(type)) return `0x${BigInt(type).toString(16)}`;
  throw new Error("Mobile Web scratch filesystem type must be an integer statfs type");
}

function nonNegativeBigInt(value, label) {
  let result;
  if (typeof value === "bigint") result = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) result = BigInt(value);
  else if (typeof value === "string" && /^\d+$/.test(value)) result = BigInt(value);
  else throw new Error(`${label} must be a non-negative integer`);
  if (result < 0n) throw new Error(`${label} must be a non-negative integer`);
  return result;
}

export function parseMemAvailableBytes(contents) {
  assert.equal(typeof contents, "string", "Linux memory information must be text");
  assert.ok(Buffer.byteLength(contents, "utf8") <= MAX_MEMINFO_BYTES, "Linux memory information exceeded its read bound");
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(contents);
  if (!match) throw new Error("UNMET_PREREQUISITE: Linux MemAvailable was not present in /proc/meminfo");
  return BigInt(match[1]) * 1024n;
}

async function readMemAvailableBytes(budget) {
  let handle;
  try {
    handle = await budget.io(() => open("/proc/meminfo", "r"));
    const buffer = Buffer.alloc(MAX_MEMINFO_BYTES + 1);
    const { bytesRead } = await budget.io(() => handle.read(buffer, 0, buffer.length, 0));
    if (bytesRead > MAX_MEMINFO_BYTES) {
      throw new Error("UNMET_PREREQUISITE: /proc/meminfo exceeds the 64 KiB read bound");
    }
    return parseMemAvailableBytes(buffer.toString("utf8", 0, bytesRead));
  } catch (error) {
    if (error?.message?.startsWith("UNMET_PREREQUISITE:")) throw error;
    throw new Error(`UNMET_PREREQUISITE: unable to read bounded Linux MemAvailable: ${errorMessage(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertOwnedBuildRoot(context, ownedBuildRoot, scratchDirectory, statePath) {
  const expected = scratchDirectory
    ? context.pathInScratch(scratchDirectory, "mobile-build-source")
    : statePath("mobile-build-source");
  assert.equal(ownedBuildRoot, expected, "Mobile Web build root identity changed");
}

async function collectTree(root, {
  rejectSymlinks,
  omitSourceOnlyFiles = false,
  omitPaths = new Set(),
  budget,
}) {
  const entries = [];
  async function visit(directory) {
    const children = await budget.io(() => readdir(directory, { withFileTypes: true }));
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (omitSourceOnlyFiles && shouldOmitSourceEntry(child.name, relativePath, child.isDirectory())) continue;
      if (omitPaths.has(relativePath)) continue;
      const info = await budget.io(() => lstat(absolutePath));
      if (info.isSymbolicLink()) {
        if (rejectSymlinks) throw new Error(`Mobile Web export contains a symlink: ${relativePath}`);
        entries.push({
          path: relativePath,
          type: "symlink",
          target: await budget.io(() => readlink(absolutePath)),
        });
      } else if (info.isDirectory()) {
        if (omitSourceOnlyFiles && EXCLUDED_SOURCE_DIRECTORIES.has(child.name)) continue;
        await visit(absolutePath);
      } else if (info.isFile()) {
        const contents = await budget.io(
          signal => readFile(absolutePath, { signal }),
          { completedFile: true },
        );
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

async function hashBundleFiles(root, budget) {
  return collectTree(root, { rejectSymlinks: true, budget });
}

async function inspectPlatformOutput(outputRoot, bundleFiles, platform) {
  if (platform === "web") {
    const entry = bundleFiles.find(file => file.path === "index.html");
    return entry
      ? {
          valid: true,
          status: "complete",
          error: null,
          evidence: { platform, entryPath: entry.path, entrySha256: entry.sha256 },
        }
      : {
          valid: false,
          status: "missing-index-html",
          error: "Mobile Web export output is missing index.html",
          evidence: null,
        };
  }

  const metadataEntry = bundleFiles.find(file => file.path === "metadata.json");
  if (!metadataEntry) {
    return {
      valid: false,
      status: "missing-platform-metadata",
      error: `Mobile ${platform} export output is missing metadata.json`,
      evidence: null,
    };
  }
  let metadata;
  try {
    metadata = JSON.parse(await readFile(resolve(outputRoot, metadataEntry.path), "utf8"));
  } catch (error) {
    return {
      valid: false,
      status: "invalid-platform-metadata",
      error: `Mobile ${platform} export metadata.json is invalid: ${errorMessage(error)}`,
      evidence: null,
    };
  }
  const platformMetadata = metadata?.fileMetadata?.[platform];
  if (metadata?.bundler !== "metro" || !platformMetadata || !Array.isArray(platformMetadata.assets)) {
    return {
      valid: false,
      status: "invalid-platform-metadata",
      error: `Mobile ${platform} export metadata does not describe a Metro bundle and asset list`,
      evidence: null,
    };
  }
  const bundlePath = safeExportRelativePath(platformMetadata.bundle);
  const bundleEntry = bundlePath
    ? bundleFiles.find(file => file.path === bundlePath)
    : null;
  if (!bundleEntry) {
    return {
      valid: false,
      status: "missing-platform-bundle",
      error: `Mobile ${platform} export metadata points to a missing bundle`,
      evidence: null,
    };
  }
  return {
    valid: true,
    status: "complete",
    error: null,
    evidence: {
      platform,
      metadataPath: metadataEntry.path,
      metadataSha256: metadataEntry.sha256,
      bundlePath: bundleEntry.path,
      bundleSha256: bundleEntry.sha256,
      assetCount: platformMetadata.assets.length,
    },
  };
}

function safeExportRelativePath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return null;
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

async function runOwnedProcess(context, label, command, args, options, timeoutMs, budget) {
  budget.check();
  const childTimeoutMs = budget.childTimeoutMs(timeoutMs);
  const child = context.spawnOwned(label, command, args, options);
  let spawnError = null;
  child.once("error", error => { spawnError = error; });
  const pid = child.pid ?? null;
  let primaryFailed = false;
  let primaryError;
  try {
    await waitFor(
      () => spawnError || child.exitCode !== null || child.signalCode !== null,
      childTimeoutMs,
      `owned Mobile Web process ${label}`,
      100,
      budget.signal,
    );
    if (spawnError) throw new Error(`${label} could not start: ${context.redactText(spawnError.message)}`);
    assert.equal(child.exitCode, 0, `${label} exited with ${child.signalCode || `code ${child.exitCode}`}`);
  } catch (error) {
    primaryFailed = true;
    primaryError = normalizeThrownError(error);
  }
  let cleanupFailed = false;
  let cleanupError;
  try {
    await context.stopOwned(label);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = normalizeThrownError(error);
  }
  if (primaryFailed && cleanupFailed) {
    const primaryMessage = context.redactText(errorMessage(primaryError));
    const cleanupMessage = context.redactText(errorMessage(cleanupError));
    throw new AggregateError(
      [primaryError, cleanupError],
      `${label} failed (${primaryMessage}) and owned cleanup also failed (${cleanupMessage})`,
      { cause: primaryError },
    );
  }
  if (cleanupFailed) throw cleanupError;
  if (primaryFailed) throw primaryError;
  return { pid };
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

async function assertPathDoesNotExist(path, budget) {
  try {
    await budget.io(() => lstat(path));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Mobile Web owned path already exists; refusing to reuse prior bytes");
}

async function hashFileIfPresent(path, budget) {
  try {
    const info = await budget.io(() => lstat(path));
    if (!info.isFile()) throw new Error(`expected a regular generated file at ${path}`);
    return hashBytes(await budget.io(signal => readFile(path, { signal }), { completedFile: true }));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(path, budget) {
  try {
    await budget.io(() => access(path));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function createExportDeadline(context, timeoutMs, onProgress) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const externalSignal = context.abortSignal;
  const phases = [];
  let currentPhase = null;
  let lastProgressAt = Number.NEGATIVE_INFINITY;

  const normalizeAbortReason = reason => reason instanceof Error
    ? reason
    : new Error(reason === undefined ? "Mobile Web export was aborted by its RunContext owner" : String(reason));
  const abortForDeadline = () => {
    if (controller.signal.aborted) return;
    const error = new Error("Mobile Web export overall cooperative deadline exceeded");
    error.code = "MOBILE_WEB_EXPORT_OVERALL_DEADLINE";
    controller.abort(error);
  };
  const forwardOwnerAbort = () => {
    if (!controller.signal.aborted) controller.abort(normalizeAbortReason(externalSignal?.reason));
  };
  if (externalSignal?.aborted) forwardOwnerAbort();
  else externalSignal?.addEventListener("abort", forwardOwnerAbort, { once: true });

  const timer = setTimeout(abortForDeadline, timeoutMs);

  const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  const remainingMs = () => Math.max(0, timeoutMs - (performance.now() - startedAt));
  const reason = () => controller.signal.aborted
    ? normalizeAbortReason(controller.signal.reason)
    : null;
  const check = phase => {
    if (!controller.signal.aborted && remainingMs() <= 0) abortForDeadline();
    if (controller.signal.aborted) {
      throw reason();
    }
  };
  const emit = (phase, state) => {
    if (!onProgress) return;
    const now = performance.now();
    if (state === "progress" && now - lastProgressAt < 1_000) return;
    lastProgressAt = now;
    onProgress({
      phase: phase.phase,
      state,
      elapsedMs: elapsedMs(),
      completedFiles: phase.completedFiles,
    });
  };

  return {
    signal: controller.signal,
    get lastPhase() { return currentPhase?.phase ?? phases.at(-1)?.phase ?? null; },
    elapsedMs,
    canContinue() {
      if (!controller.signal.aborted && remainingMs() <= 0) abortForDeadline();
      return !controller.signal.aborted;
    },
    check,
    errorFor(error) {
      if (!controller.signal.aborted && remainingMs() <= 0) abortForDeadline();
      return reason() ?? error;
    },
    childTimeoutMs(stageTimeoutMs) {
      check();
      return Math.max(1, Math.min(stageTimeoutMs, Math.floor(remainingMs())));
    },
    async io(operation, { completedFile = false } = {}) {
      check();
      const value = await operation(controller.signal);
      if (completedFile) this.fileCompleted();
      check();
      return value;
    },
    fileCompleted() {
      if (!currentPhase) return;
      currentPhase.completedFiles += 1;
      if (currentPhase.completedFiles % 256 === 0) emit(currentPhase, "progress");
      check(currentPhase.phase);
    },
    async runPhase(phaseName, operation) {
      assert.ok(EXPORT_PROGRESS_PHASES.has(phaseName), "unknown Mobile Web export progress phase");
      assert.equal(currentPhase, null, "Mobile Web export phases cannot overlap");
      const phase = {
        phase: phaseName,
        state: "running",
        startedAtElapsedMs: elapsedMs(),
        endedAtElapsedMs: null,
        elapsedMs: null,
        completedFiles: 0,
      };
      currentPhase = phase;
      phases.push(phase);
      let value;
      let failure = null;
      try {
        emit(phase, "started");
        check(phaseName);
        value = await operation();
        check(phaseName);
      } catch (error) {
        failure = normalizeThrownError(error);
      } finally {
        phase.endedAtElapsedMs = elapsedMs();
        phase.elapsedMs = Math.max(0, phase.endedAtElapsedMs - phase.startedAtElapsedMs);
        phase.state = failure ? "failed" : "completed";
        currentPhase = null;
        try {
          emit(phase, phase.state);
        } catch (progressError) {
          if (!failure) {
            failure = normalizeThrownError(progressError);
            phase.state = "failed";
          }
        }
      }
      if (failure) throw this.errorFor(failure);
      return value;
    },
    recordSkippedPhase(phaseName) {
      assert.ok(EXPORT_PROGRESS_PHASES.has(phaseName), "unknown Mobile Web export progress phase");
      assert.equal(currentPhase, null, "Mobile Web export phases cannot overlap");
      const elapsed = elapsedMs();
      phases.push({
        phase: phaseName,
        state: "skipped",
        startedAtElapsedMs: elapsed,
        endedAtElapsedMs: elapsed,
        elapsedMs: 0,
        completedFiles: 0,
      });
    },
    snapshot() {
      return phases.map(phase => ({ ...phase }));
    },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", forwardOwnerAbort);
    },
  };
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

function normalizeThrownError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
