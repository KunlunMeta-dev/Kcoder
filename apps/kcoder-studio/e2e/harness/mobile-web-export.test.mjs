import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { appRoot, RunContext } from "./run-context.mjs";
import { exportMobileWeb, parseMemAvailableBytes, planMobileWebScratchCapacity } from "./mobile-web-export.mjs";

test("Mobile Web scratch capacity separates disk filesystem and memory budgets", () => {
  const fourGiB = 4n * 1024n * 1024n * 1024n;
  const fiveGiB = 5n * 1024n * 1024n * 1024n;
  const nineGiB = 9n * 1024n * 1024n * 1024n;
  const inputs = { sourceBytes: 1_024n, dependencyBytes: 4_096n };
  const disk = planMobileWebScratchCapacity({ ...inputs, filesystemType: 0xef53n });
  assert.equal(disk.sourceBytes, 1_024n);
  assert.equal(disk.dependencyBytes, 4_096n);
  assert.equal(disk.filesystemType, "0xef53");
  assert.equal(disk.filesystemBackingMode, "known-disk-backed");
  assert.equal(disk.buildFilesBudgetBytes, fourGiB);
  assert.equal(disk.metroWorkingSetBytes, fourGiB);
  assert.equal(disk.memoryReserveBytes, 1n * 1024n * 1024n * 1024n);
  assert.equal(disk.requiredBytes, fourGiB + 5_120n);
  assert.equal(disk.reserveBytes, fourGiB);
  assert.equal(disk.totalRequiredBytes, 8n * 1024n * 1024n * 1024n + 5_120n);
  assert.equal(disk.requiredMemoryBytes, fiveGiB);
  assert.equal(disk.memoryAccountingMode, "metro-working-set-plus-memory-reserve");

  const tmpfs = planMobileWebScratchCapacity({ ...inputs, filesystemType: 0x01021994n });
  assert.equal(tmpfs.filesystemType, "0x1021994");
  assert.equal(tmpfs.filesystemBackingMode, "ram-backed-or-unknown");
  assert.equal(tmpfs.requiredBytes, disk.requiredBytes);
  assert.equal(tmpfs.totalRequiredBytes, disk.totalRequiredBytes);
  assert.equal(tmpfs.requiredMemoryBytes, nineGiB + 5_120n);
  assert.equal(tmpfs.memoryAccountingMode, "filesystem-payload-plus-metro-working-set-and-memory-reserve");

  const unknown = planMobileWebScratchCapacity({ ...inputs, filesystemType: 0xdeadn });
  assert.equal(unknown.requiredMemoryBytes, tmpfs.requiredMemoryBytes);
  assert.equal(unknown.filesystemBackingMode, "ram-backed-or-unknown");
  assert.equal(unknown.memoryAccountingMode, tmpfs.memoryAccountingMode);
  assert.throws(() => planMobileWebScratchCapacity({ sourceBytes: -1n, dependencyBytes: 0n, filesystemType: 0xef53n }), /non-negative integer/);
  assert.throws(() => planMobileWebScratchCapacity(inputs), /filesystem type/);
});

test("Mobile Web scratch memory parser requires bounded Linux MemAvailable metadata", () => {
  assert.equal(parseMemAvailableBytes("MemTotal: 1048576 kB\nMemAvailable: 8192 kB\n"), 8n * 1024n * 1024n);
  assert.throws(() => parseMemAvailableBytes("MemTotal: 1048576 kB\n"), /MemAvailable was not present/);
  assert.throws(() => parseMemAvailableBytes("x".repeat(64 * 1024 + 1)), /read bound/);
});

test("Mobile Web export is fresh, RunContext-owned, and hashes every published asset", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-owned-manifest",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    const ownerAbort = new AbortController();
    context.abortSignal = ownerAbort.signal;
    const progressEvents = [];
    const exported = await exportMobileWeb(context, {
      mobileRoot: fixture.mobileRoot,
      label: "fixture-mobile-export",
      outputName: "mobile-web-export",
      onProgress: event => progressEvents.push(event),
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
    assert.equal(bundleManifest.ownedBuildRootRelativePath, "state/mobile-build-source");
    assert.equal(Object.hasOwn(bundleManifest, "buildScratch"), false);
    assert.equal(bundleManifest.sourceUnchanged, true);
    assert.equal(bundleManifest.snapshotCopyMatchesSource, true);
    assert.equal(bundleManifest.terminalHookChangesOnlyGeneratedHtml, true);
    assert.equal(bundleManifest.snapshotUnchangedDuringExport, true);
    assert.equal(bundleManifest.dependencyProvenance.sourceUnchanged, true);
    assert.equal(bundleManifest.dependencyProvenance.copiedSymlinks, false);
    assert.equal(bundleManifest.overallDeadline.timeoutMs, 30 * 60_000);
    assert.equal(bundleManifest.overallDeadline.cooperative, true);
    assert.equal(bundleManifest.overallDeadline.outcome, "completed");
    assert.ok(bundleManifest.overallDeadline.elapsedMs >= 0);
    assert.ok(bundleManifest.overallDeadline.phases.length > 0);
    assert.ok(bundleManifest.overallDeadline.phases.length <= 20);
    assert.ok(bundleManifest.overallDeadline.phases.every(phase =>
      phase.endedAtElapsedMs !== null && phase.elapsedMs >= 0 && phase.completedFiles >= 0));
    assert.ok(progressEvents.length <= bundleManifest.overallDeadline.phases.length * 2 + 2);
    assert.ok(progressEvents.every(event =>
      Object.keys(event).sort().join(",") === "completedFiles,elapsedMs,phase,state" &&
      /^[a-z-]+$/.test(event.phase) && Number.isInteger(event.completedFiles) &&
      Number.isInteger(event.elapsedMs)));
    assert.ok(progressEvents.every((event, index) =>
      index === 0 || event.elapsedMs >= progressEvents[index - 1].elapsedMs));
    assert.equal(getEventListeners(ownerAbort.signal, "abort").length, 0, "exporter must remove its owner-abort listener after success");
    assert.ok(bundleManifest.overallDeadline.phases.find(phase => phase.phase === "copy-source").completedFiles > 0);
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
    for (const path of ['src/runtime/migration-client/credential-sources-contracts.ts',
      'src/runtime/migration-source/private-credential-controller.ts', 'src/runtime/migration-source/private-credentials.ts']) {
      assert.equal(await readFile(resolve(ownedDependencyRoot, '..', path), 'utf8'), 'export const publicModule = true;\n');
    }
    for (const name of ['migrationPrivateCredentialController.ts', 'migrationPrivateCredentialRecovery.ts', 'migrationPrivatePrepareRecovery.ts',
      'migrationPrivateCredentials.ts', 'migrationPrivateCredentialSelections.ts', 'migrationCredentialSources.ts']) {
      assert.equal(await readFile(resolve(ownedDependencyRoot, '../../shared', name), 'utf8'), 'export const publicModule = true;\n');
    }
    assert.equal(await readFile(resolve(ownedDependencyRoot, '../../shared/generated/contracts.migration-source-credentials.ts'), 'utf8'), 'export const publicModule = true;\n');
    assert.equal(await exists(resolve(ownedDependencyRoot, '../src/runtime/migration-source/credentials.json')), false);
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

test("Mobile Android export reuses the owned source and dependency snapshot", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-android-export-owned-snapshot",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    const exported = await exportMobileWeb(context, {
      mobileRoot: fixture.mobileRoot,
      label: "fixture-android-export",
      outputName: "android-export",
      platform: "android",
    });

    assert.equal(exported.platform, "android");
    assert.equal(exported.indexHtmlSha256, null);
    assert.equal(exported.platformOutputEvidence.platform, "android");
    assert.equal(exported.platformOutputEvidence.bundlePath, "index.android.bundle");
    assert.match(exported.platformOutputEvidence.bundleSha256, /^[a-f0-9]{64}$/);
    const bundleManifest = JSON.parse(await readFile(exported.bundleManifestPath, "utf8"));
    assert.equal(bundleManifest.status, "complete");
    assert.equal(bundleManifest.platform, "android");
    assert.equal(bundleManifest.snapshotCopyMatchesSource, true);
    assert.equal(bundleManifest.snapshotUnchangedDuringExport, true);
    assert.equal(bundleManifest.dependencyProvenance.sourceUnchanged, true);
    assert.equal(bundleManifest.platformOutputEvidence.bundlePath, "index.android.bundle");
    assert.ok(bundleManifest.bundleFiles.some(file => file.path === "metadata.json"));
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { ownedAndroidSnapshotExport: status === "passed" });
  }
  const runManifest = JSON.parse(await readFile(resolve(context.runRoot, "manifest.json"), "utf8"));
  assert.ok(runManifest.processes.some(process => process.label === "fixture-android-export-expo" && process.pid > 0));
  assert.ok(runManifest.cleanupSteps.some(step => step.label === "stop process fixture-android-export-expo" && step.status === "completed"));
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web export records an overall deadline reached at the first cooperative checkpoint", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-overall-deadline-before-input-read",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    let blocked = false;
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-overall-deadline",
        overallTimeoutMs: 10,
        onProgress: event => {
          if (blocked || event.phase !== "resolve-inputs" || event.state !== "started") return;
          blocked = true;
          // Advance the monotonic clock synchronously. This tests the deadline
          // checkpoint itself without racing an asynchronous timer callback.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        },
      }),
      /overall cooperative deadline exceeded/,
    );
    assert.equal(blocked, true);
    assert.equal(context.processes.size, 0);
    const manifest = JSON.parse(await readFile(
      resolve(context.runRoot, "artifacts/mobile-web-export-fixture-mobile-overall-deadline-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.status, "export-failed");
    assert.equal(manifest.failurePhase, "resolve-inputs");
    assert.equal(manifest.overallDeadline.outcome, "deadline-exceeded");
    assert.match(manifest.error, /overall cooperative deadline exceeded/);
    assert.deepEqual(manifest.overallDeadline.phases.map(phase => [phase.phase, phase.state]), [
      ["resolve-inputs", "failed"],
      ["bundle-hash", "skipped"],
    ]);
    assert.equal(manifest.sourceHashBefore, null);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { overallDeadlineCheckpointRecorded: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web source-map export preserves an early deadline failure manifest", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-source-map-overall-deadline-before-input-read",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    let blocked = false;
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-source-map-overall-deadline",
        sourceMaps: true,
        overallTimeoutMs: 10,
        onProgress: event => {
          if (blocked || event.phase !== "resolve-inputs" || event.state !== "started") return;
          blocked = true;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        },
      }),
      /overall cooperative deadline exceeded/,
    );
    assert.equal(blocked, true);
    assert.equal(context.processes.size, 0);
    const manifest = JSON.parse(await readFile(
      resolve(context.runRoot, "artifacts/mobile-web-export-fixture-mobile-source-map-overall-deadline-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.status, "export-failed");
    assert.equal(manifest.failurePhase, "resolve-inputs");
    assert.equal(manifest.overallDeadline.outcome, "deadline-exceeded");
    assert.match(manifest.error, /overall cooperative deadline exceeded/);
    assert.equal(Object.hasOwn(manifest, "sourceMapEvidence"), false);
    assert.deepEqual(manifest.overallDeadline.phases.map(phase => [phase.phase, phase.state]), [
      ["resolve-inputs", "failed"],
      ["bundle-hash", "skipped"],
    ]);
    assert.equal(manifest.sourceHashBefore, null);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { sourceMapDeadlineCheckpointRecorded: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web records a deadline skipped post-export verification instead of source drift", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-deadline-skips-verification",
  });
  let status = "passed";
  let deadlineTriggeredAtExport = false;
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-deadline-skipped-verification",
        overallTimeoutMs: 10_000,
        onProgress: event => {
          if (deadlineTriggeredAtExport || event.phase !== "expo-export" || event.state !== "completed") return;
          deadlineTriggeredAtExport = true;
          // The callback blocks the event loop after export completion. The next
          // cooperative verification checkpoint observes elapsed monotonic time.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_020);
        },
      }),
      /overall cooperative deadline exceeded/,
    );
    assert.equal(deadlineTriggeredAtExport, true);
    const manifest = JSON.parse(await readFile(
      resolve(context.runRoot, "artifacts/mobile-web-export-fixture-mobile-deadline-skipped-verification-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.status, "export-failed");
    assert.equal(manifest.failurePhase, "source-hash-after");
    assert.equal(manifest.overallDeadline.outcome, "deadline-exceeded");
    assert.match(manifest.error, /overall cooperative deadline exceeded/);
    assert.match(manifest.error, /source-hash-after: Mobile Web export overall cooperative deadline exceeded/);
    assert.ok(manifest.sourceHashBefore);
    assert.equal(manifest.sourceHashAfter, null);
    assert.equal(
      manifest.overallDeadline.phases.find(phase => phase.phase === "source-hash-after").state,
      "skipped",
    );
    assert.equal(manifest.verificationFailures[0].phase, "source-hash-after");
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { deadlineSkippedVerificationRecorded: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web progress callback non-Error throws remain failures", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-progress-callback-non-error-throw",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-progress-callback-non-error",
        onProgress: event => {
          if (event.phase === "resolve-inputs" && event.state === "started") throw null;
        },
      }),
      /null/,
    );
    const manifest = JSON.parse(await readFile(
      resolve(context.runRoot, "artifacts/mobile-web-export-fixture-mobile-progress-callback-non-error-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.status, "export-failed");
    assert.equal(manifest.failurePhase, "resolve-inputs");
    assert.equal(manifest.overallDeadline.outcome, "failed");
    assert.match(manifest.error, /null/);
    assert.equal(manifest.overallDeadline.phases[0].state, "failed");
    assert.equal(context.processes.size, 0);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { nonErrorProgressThrowRecorded: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web export forwards owner abort and stops an in-flight owned child", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-owner-abort-stops-child",
  });
  const ownerAbort = new AbortController();
  context.abortSignal = ownerAbort.signal;
  let status = "passed";
  let abortTimer = null;
  let abortRequest = null;
  let childWasRunningWhenAborted = false;
  try {
    const fixture = await fixtureMobileRoot(context, {
      sourceDriftDuringExport: false,
      terminalBuilderDelayMs: 5_000,
    });
    const originalSpawnOwned = context.spawnOwned.bind(context);
    context.spawnOwned = (label, ...args) => {
      const child = originalSpawnOwned(label, ...args);
      if (label === "fixture-mobile-owner-abort-terminal-build") {
        abortTimer = setTimeout(() => {
          const record = context.processes.get(label);
          childWasRunningWhenAborted = Boolean(record && !record.stopped && child.exitCode === null);
          const abortError = new Error("fixture RunContext owner abort");
          abortRequest = context.requestAbort(abortError);
          ownerAbort.abort(abortError);
        }, 40);
      }
      return child;
    };
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-owner-abort",
      }),
      /fixture RunContext owner abort/,
    );
    clearTimeout(abortTimer);
    abortTimer = null;
    await abortRequest;
    assert.equal(context.abortSignal, ownerAbort.signal, "exporter must not replace the external RunContext signal");
    assert.equal(getEventListeners(ownerAbort.signal, "abort").length, 0, "exporter must remove its owner-abort listener");
    assert.equal(childWasRunningWhenAborted, true);
    const childRecord = context.processes.get("fixture-mobile-owner-abort-terminal-build");
    assert.ok(childRecord?.stopped, "aborted owned child must be stopped before exportMobileWeb rejects");
    const manifest = JSON.parse(await readFile(
      resolve(context.runRoot, "artifacts/mobile-web-export-fixture-mobile-owner-abort-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.status, "export-failed");
    assert.equal(manifest.failurePhase, "terminal-build");
    assert.equal(manifest.overallDeadline.outcome, "owner-aborted");
    assert.match(manifest.error, /fixture RunContext owner abort/);
    assert.equal(manifest.overallDeadline.phases.find(phase => phase.phase === "terminal-build").state, "failed");
    assert.equal(context.abortReason?.message, "fixture RunContext owner abort");
    assert.ok([...context.processes.values()].every(record => record.stopped));
    const failureManifestPath = resolve(
      context.runRoot,
      "artifacts/mobile-web-export-fixture-mobile-owner-abort-manifest.json",
    );
    assert.equal((await lstat(failureManifestPath)).mode & 0o777, 0o600);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    if (abortTimer !== null) clearTimeout(abortTimer);
    await context.finish(status, { ownerAbortStoppedOwnedChild: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);

  const runManifest = JSON.parse(await readFile(resolve(context.runRoot, "manifest.json"), "utf8"));
  const childProcess = runManifest.processes.find(process =>
    process.label === "fixture-mobile-owner-abort-terminal-build");
  assert.ok(childProcess);
  assert.equal(childProcess.stopped, true);
  assert.ok(runManifest.cleanupSteps.some(step =>
    step.label === "stop process fixture-mobile-owner-abort-terminal-build" && step.status === "completed"));
});

test("Mobile Web export preserves abort and artifact-write failures without claiming a manifest", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-abort-manifest-write-failure",
  });
  const ownerAbort = new AbortController();
  context.abortSignal = ownerAbort.signal;
  const originalWriteArtifactJsonInternal = context.writeArtifactJsonInternal.bind(context);
  const manifestName = "mobile-web-export-fixture-mobile-abort-manifest-write-failure-manifest.json";
  context.writeArtifactJsonInternal = async (name, value) => {
    if (name === manifestName) throw new Error("fixture failure-manifest write failure");
    return originalWriteArtifactJsonInternal(name, value);
  };
  let status = "passed";
  let abortTimer = null;
  let abortRequest = null;
  const childLabel = "fixture-mobile-abort-manifest-write-failure-terminal-build";
  try {
    const fixture = await fixtureMobileRoot(context, {
      sourceDriftDuringExport: false,
      terminalBuilderDelayMs: 5_000,
    });
    const originalSpawnOwned = context.spawnOwned.bind(context);
    context.spawnOwned = (label, ...args) => {
      const child = originalSpawnOwned(label, ...args);
      if (label === childLabel) {
        abortTimer = setTimeout(() => {
          const abortError = new Error("fixture manifest-write owner abort");
          abortRequest = context.requestAbort(abortError);
          ownerAbort.abort(abortError);
        }, 40);
      }
      return child;
    };
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-abort-manifest-write-failure",
      }),
      error => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /fixture manifest-write owner abort/);
        assert.match(error.errors[1].message, /fixture failure-manifest write failure/);
        assert.match(error.message, /fixture manifest-write owner abort/);
        assert.match(error.message, /fixture failure-manifest write failure/);
        return true;
      },
    );
    await abortRequest;
    assert.equal(await exists(resolve(context.runRoot, `artifacts/${manifestName}`)), false);
    assert.ok([...context.processes.values()].every(record => record.stopped));
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    if (abortTimer !== null) clearTimeout(abortTimer);
    context.writeArtifactJsonInternal = originalWriteArtifactJsonInternal;
    await context.finish(status, { abortAndArtifactWriteFailuresPreserved: status === "passed" });
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web state namespaces isolate sequential exports and refuse reuse", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-state-namespaces",
  });
  let status = "passed";
  try {
    const fixture = await fixtureMobileRoot(context, { sourceDriftDuringExport: false });
    const before = await exportMobileWeb(context, {
      mobileRoot: fixture.mobileRoot,
      label: "fixture-before-export",
      outputName: "before-output",
      stateNamespace: "before-source",
    });
    const beforeIndex = await readFile(resolve(before.path, "index.html"));
    const beforeManifest = await readFile(before.bundleManifestPath);
    const beforeManifestSha256 = createHash("sha256").update(beforeManifest).digest("hex");

    const after = await exportMobileWeb(context, {
      mobileRoot: fixture.mobileRoot,
      label: "fixture-after-export",
      outputName: "after-output",
      stateNamespace: "after-source",
    });

    assert.equal(before.path, resolve(context.stateDir, "before-source", "before-output"));
    assert.equal(after.path, resolve(context.stateDir, "after-source", "after-output"));
    assert.notEqual(before.path, after.path);
    for (const [namespace, outputName] of [["before-source", "before-output"], ["after-source", "after-output"]]) {
      for (const path of [
        resolve(context.stateDir, namespace, "mobile-build-source"),
        resolve(context.stateDir, namespace, outputName),
        resolve(context.stateDir, namespace, "mobile-export-tmp"),
      ]) {
        assert.equal((await lstat(path)).isDirectory(), true, `${namespace} state path is missing`);
      }
    }
    assert.equal(after.bundleFileCount, 6);
    assert.deepEqual(await readFile(resolve(before.path, "index.html")), beforeIndex);
    assert.equal(
      createHash("sha256").update(await readFile(before.bundleManifestPath)).digest("hex"),
      beforeManifestSha256,
      "the second export changed the first export manifest",
    );
    assert.equal(
      JSON.parse(beforeManifest.toString("utf8")).bundleSha256,
      before.bundleSha256,
    );

    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-before-duplicate",
        outputName: "duplicate-output",
        stateNamespace: "before-source",
      }),
      /Mobile Web owned path already exists; refusing to reuse prior bytes/,
    );
    assert.deepEqual(await readFile(resolve(before.path, "index.html")), beforeIndex);
    assert.equal(
      createHash("sha256").update(await readFile(before.bundleManifestPath)).digest("hex"),
      beforeManifestSha256,
      "a rejected duplicate namespace changed the first export",
    );
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { sequentialStateNamespacesIsolated: status === "passed" });
  }

  const manifest = JSON.parse(await readFile(resolve(context.runRoot, "manifest.json"), "utf8"));
  for (const label of [
    "fixture-before-export-dependencies-copy",
    "fixture-before-export-terminal-build",
    "fixture-before-export-expo",
    "fixture-after-export-dependencies-copy",
    "fixture-after-export-terminal-build",
    "fixture-after-export-expo",
  ]) {
    assert.ok(manifest.processes.some(process => process.label === label && process.pid > 0));
    assert.ok(manifest.cleanupSteps.some(step => step.label === `stop process ${label}` && step.status === "completed"));
  }
  assert.equal(await exists(resolve(context.runRoot, "state")), false);
});

test("Mobile Web state namespace rejects path traversal before creating owned state", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-state-namespace-validation",
  });
  let status = "passed";
  try {
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: resolve(context.stateDir, "missing-mobile-source"),
        stateNamespace: "../escaped-state",
      }),
      /invalid Mobile Web state namespace/,
    );
    assert.equal(context.processes.size, 0);
    assert.equal(context.temporaryDirectories.some(path => path.includes("escaped-state")), false);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { stateNamespaceTraversalRejected: status === "passed" });
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

test("Mobile Web export preserves a child failure when owned cleanup also fails", async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "mobile-web-export-child-and-cleanup-failure",
  });
  let status = "passed";
  let cleanupFailureInjected = false;
  const childLabel = "fixture-mobile-primary-cleanup-failure-terminal-build";
  const originalStopOwned = context.stopOwned.bind(context);
  context.stopOwned = async label => {
    const result = await originalStopOwned(label);
    if (label === childLabel && !cleanupFailureInjected) {
      cleanupFailureInjected = true;
      throw new Error("fixture owned cleanup failure");
    }
    return result;
  };
  try {
    const fixture = await fixtureMobileRoot(context, {
      sourceDriftDuringExport: false,
      terminalBuilderExitCode: 9,
    });
    await assert.rejects(
      exportMobileWeb(context, {
        mobileRoot: fixture.mobileRoot,
        label: "fixture-mobile-primary-cleanup-failure",
      }),
      error => {
        assert.match(error.message, /exited with code 9/);
        assert.match(error.message, /fixture owned cleanup failure/);
        return true;
      },
    );
    const manifest = JSON.parse(await readFile(
      resolve(context.runRoot, "artifacts/mobile-web-export-fixture-mobile-primary-cleanup-failure-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.status, "export-failed");
    assert.equal(manifest.failurePhase, "terminal-build");
    assert.match(manifest.error, /exited with code 9/);
    assert.match(manifest.error, /fixture owned cleanup failure/);
    assert.equal(cleanupFailureInjected, true);
    assert.equal(context.processes.get(childLabel)?.stopped, true);
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await context.finish(status, { primaryAndCleanupFailuresPreserved: status === "passed" });
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

async function fixtureMobileRoot(context, {
  sourceDriftDuringExport,
  terminalBuilderDelayMs = 0,
  terminalBuilderExitCode = 0,
}) {
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
  await writeFile(resolve(root, "scripts/build-terminal-webview.mjs"),
    fakeTerminalBuilder(terminalBuilderDelayMs, terminalBuilderExitCode));
  await writeFile(sharedRoot + "/contract.ts", "export const contract = 'stable';\n");
  await writeFile(resolve(sharedRoot, "token.secret.json"), "DUMMY_SECRET_VALUE\n");
  await mkdir(resolve(root, 'src/runtime/migration-client'), { recursive: true });
  await mkdir(resolve(root, 'src/runtime/migration-source'), { recursive: true });
  for (const path of ['src/runtime/migration-client/credential-sources-contracts.ts',
    'src/runtime/migration-source/private-credential-controller.ts', 'src/runtime/migration-source/private-credentials.ts']) {
    await writeFile(resolve(root, path), 'export const publicModule = true;\n');
  }
  for (const name of ['migrationPrivateCredentialController.ts', 'migrationPrivateCredentialRecovery.ts', 'migrationPrivatePrepareRecovery.ts',
    'migrationPrivateCredentials.ts', 'migrationPrivateCredentialSelections.ts', 'migrationCredentialSources.ts']) {
    await writeFile(resolve(sharedRoot, name), 'export const publicModule = true;\n');
  }
  await mkdir(resolve(sharedRoot, 'generated'), { recursive: true });
  await writeFile(resolve(sharedRoot, 'generated/contracts.migration-source-credentials.ts'), 'export const publicModule = true;\n');
  await writeFile(resolve(root, 'src/runtime/migration-source/credentials.json'), 'DUMMY_SECRET_VALUE\n');
  await writeFile(cli, fakeExpoCli({
    markerPath: sourceDriftDuringExport ? startedPath : null,
    delayMs: sourceDriftDuringExport ? 250 : 0,
  }));
  return { mobileRoot: root, sharedRoot, startedPath };
}

function fakeTerminalBuilder(delayMs, exitCode) {
  return `
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
await new Promise(resolveDelay => setTimeout(resolveDelay, ${delayMs}));
writeFileSync(resolve(process.cwd(), "src/terminal-webview/generated-html.ts"), "export const terminalWebViewHtml = \\\"owned terminal html\\\";\\n");
process.exitCode = ${exitCode};
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
  const platformIndex = process.argv.indexOf("--platform");
  const platform = platformIndex < 0 ? "web" : process.argv[platformIndex + 1];
  if (platform === "android") {
    const bundlePath = "index.android.bundle";
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, bundlePath), "fixture Android JS bundle");
    fs.writeFileSync(path.join(outputRoot, "metadata.json"), JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: { android: { bundle: bundlePath, assets: [] } },
    }));
    return;
  }
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
