import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createShortChromiumTemp } from "../e2e/harness/short-chromium-temp.mjs";
import { appRoot, requireExecutable, runIntegration } from "../e2e/harness/run-context.mjs";

await runIntegration(import.meta.url, {
  testId: "electron-storage-startup-native-linux",
  tier: "manual-live",
  modelPolicy: "model-independent real Electron and Native CLI cache relocation with owned HOME, profile and loopback HTTP; no Gateway or model",
  retainSuccessEvidence: true,
  evidenceReason: "Seed real Electron storage, relocate its HTTP cache through the checkout Native CLI, and verify same-origin restoration",
}, async context => {
  assert.equal(process.platform, "linux", "UNMET_PREREQUISITE: this native fixture targets Linux Electron under Xvfb");
  assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, "1",
    "UNMET_PREREQUISITE: isolated VM no-sandbox opt-in required for source Electron");

  const electron = await requireExecutable(resolve(appRoot, "node_modules/electron/dist/electron"), "Electron 42");
  const xvfb = await requireExecutable("/usr/bin/xvfb-run", "Xvfb runner");
  await requireExecutable("/usr/bin/xauth", "Xauthority helper");

  const home = context.pathInState("electron-home");
  const configDirectory = join(home, ".config");
  const dataRoot = context.pathInState("persistent-data");
  const originalCacheRoot = context.pathInState("rebuildable-cache");
  const migratedCacheRoot = context.pathInState("migrated-cache");
  const chromiumTemp = await createShortChromiumTemp(context);
  const repositoryRoot = resolve(appRoot, "../..");
  const cliBinary = resolve(repositoryRoot, "target/debug/kcoder");
  const fixture = resolve(appRoot, "desktop/fixtures/storage-startup-main.mjs");
  const partition = "persist:kcoder-studio-desktop";
  const partitionName = "kcoder-studio-desktop";
  const desktopRoot = join(dataRoot, "studio", "desktop");
  const sourceCachePath = join(desktopRoot, "Partitions", partitionName, "Cache");
  const originalHttpCacheTarget = join(originalCacheRoot, "browser-cache", "desktop", partitionName, "http");
  const migratedHttpCacheTarget = join(migratedCacheRoot, "browser-cache", "desktop", partitionName, "http");
  const expectedMarker = `storage-marker-${context.seed}`;
  const expectedCookie = `storage-cookie-${context.seed}`;
  const operationId = `electron-cache-${basename(context.runRoot)}`;
  const cacheProbeSize = 64 * 1024;
  const cacheProbeBody = createCacheProbeBody(context.seed, cacheProbeSize);
  const cacheProbeSha256 = createHash("sha256").update(cacheProbeBody).digest("hex");
  let cacheProbeRequests = 0;
  context.registerSecret(expectedMarker);
  context.registerSecret(expectedCookie);

  await Promise.all([
    mkdir(configDirectory, { recursive: true, mode: 0o700 }),
    mkdir(dataRoot, { recursive: true, mode: 0o700 }),
    mkdir(originalCacheRoot, { recursive: true, mode: 0o700 }),
  ]);
  const selectionFile = join(configDirectory, "kcoder-storage.json");
  await writeFile(selectionFile, `${JSON.stringify({ version: 1, revision: 1, dataRoot, cacheRoot: originalCacheRoot })}\n`, { mode: 0o600 });

  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "public, max-age=3600");
    if (path === "/seed") {
      response.setHeader("set-cookie", `kcoder_storage_probe=${expectedCookie}; Path=/; Max-Age=86400; SameSite=Lax`);
      response.end(`<!doctype html><meta charset="utf-8"><script>localStorage.setItem("kcoder-storage-probe", ${JSON.stringify(expectedMarker)});</script><title>seed</title>`);
      return;
    }
    if (path === "/verify") {
      response.end("<!doctype html><meta charset=\"utf-8\"><title>verify</title>");
      return;
    }
    if (path === "/asset.bin") {
      cacheProbeRequests += 1;
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("content-length", cacheProbeBody.length);
      response.setHeader("etag", '"storage-cache-probe-v1"');
      response.end(cacheProbeBody);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  context.addCleanup("close owned storage probe HTTP server", async () => {
    server.closeAllConnections();
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  });
  const port = server.address().port;
  context.registerPort("storage-probe-http", port);

  const configFile = context.pathInState("fixture-config.json");
  await writeFile(configFile, `${JSON.stringify({
    baseUrl: `http://127.0.0.1:${port}`,
    expectedMarker,
    expectedCookie,
  }, null, 2)}\n`, { mode: 0o600 });

  const cliBinaryInfo = await lstat(cliBinary);
  assert.ok(cliBinaryInfo.isFile() && !cliBinaryInfo.isSymbolicLink(), "CLI must be the built Root checkout binary");
  assert.equal(await realpath(cliBinary), cliBinary, "CLI must resolve to this checkout's target/debug binary");
  const cliSha256 = await sha256File(cliBinary);
  const cliEnvironment = context.isolatedEnvironment({
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: configDirectory,
    XDG_CACHE_HOME: join(home, ".cache"),
  });
  for (const name of ["KCODER_HOME", "KCODER_CONFIG_DIR", "KCODER_TARGET_DIR", "CARGO_TARGET_DIR"]) {
    assert.equal(cliEnvironment[name], undefined, `CLI environment must not override ${name}`);
  }
  const versionOutput = await runOwnedCli(context, "kcoder-version", cliBinary, ["--version"], {
    cwd: home, env: cliEnvironment, timeoutMs: 15_000,
  });
  const cliVersion = versionOutput.trim();
  assert.match(cliVersion, /^kcoder \S+$/, "Root CLI returned an unexpected version identity");
  const cliIdentity = {
    path: cliBinary,
    version: cliVersion,
    sha256: cliSha256,
    sizeBytes: cliBinaryInfo.size,
    dev: cliBinaryInfo.dev,
    ino: cliBinaryInfo.ino,
  };
  await context.writeArtifactJson("native-cli-identity.json", cliIdentity);

  const launches = [];
  const cacheLayouts = [];
  let migrationEvidence = null;
  for (const phase of ["seed", "verify"]) {
    const selection = JSON.parse(await readFile(selectionFile, "utf8"));
    const expectedCacheRoot = phase === "seed" ? originalCacheRoot : migratedCacheRoot;
    assert.equal(selection.dataRoot, dataRoot);
    assert.equal(selection.cacheRoot, expectedCacheRoot, `${phase} Electron must load the currently selected cache root`);
    const httpCacheTarget = join(selection.cacheRoot, "browser-cache", "desktop", partitionName, "http");
    const codeCachePath = join(selection.cacheRoot, "browser-cache", "desktop", partitionName, "code");

    const phaseReport = context.pathInState(`${phase}-report.json`);
    const processLabel = `electron-${phase}`;
    const child = context.spawnOwned(processLabel, xvfb, [
      "-a", "-s", "-screen 0 1280x1024x24 -nolisten tcp",
      electron, "--no-sandbox", "--disable-setuid-sandbox", fixture,
    ], {
      cwd: appRoot,
      env: context.isolatedEnvironment({
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: configDirectory,
        TMPDIR: chromiumTemp.path,
        TMP: chromiumTemp.path,
        TEMP: chromiumTemp.path,
        ELECTRON_RUN_AS_NODE: "",
        KCODER_STORAGE_FIXTURE_CONFIG: configFile,
        KCODER_STORAGE_FIXTURE_PHASE: phase,
        KCODER_STORAGE_FIXTURE_REPORT: phaseReport,
      }),
    });
    const exit = await childExitWithin(child, 45_000, `Electron ${phase} launch`);
    await context.stopOwned(processLabel);
    const processRecord = context.processes.get(processLabel);
    assert.equal(processRecord?.stopped, true, `RunContext did not confirm the full Electron ${phase} process group stopped`);
    const report = JSON.parse(await readFile(phaseReport, "utf8"));
    await context.writeArtifactJson(`electron-storage-${phase}.json`, { exit, ownedProcessStopped: processRecord.stopped, report });
    assert.equal(exit.code, 0, `Electron ${phase} exited unsuccessfully: ${JSON.stringify(exit)}; ${report.failure || "no fixture failure recorded"}`);
    assert.equal(report.launchPhase, phase);
    assert.equal(report.failure, null, `Electron ${phase} fixture failed: ${report.failure}`);
    assert.equal(report.completion, "completed", `Electron ${phase} ended at fixture phase ${report.phase}`);
    assert.equal(report.beforeStorage.appReady, false, "Electron was already ready before storage configuration began");
    assert.equal(report.afterStorage.appReady, false, "storage paths must be configured before app.ready");
    assert.equal(report.afterStorage.home, home);
    assert.equal(report.afterStorage.userData, desktopRoot);
    assert.equal(report.afterStorage.sessionData, desktopRoot);
    assert.equal(report.afterStorage.browserCacheRoot, join(selection.cacheRoot, "browser-cache", "desktop"));
    assert.equal(report.pathSetCalls.length, 2);
    assert.ok(report.pathSetCalls.every(call => call.appReady === false), "userData/sessionData must be set before app.ready");
    assert.deepEqual(report.pathSetCalls.map(call => [call.kind, call.value]), [
      ["userData", desktopRoot],
      ["sessionData", desktopRoot],
    ]);
    assert.equal(report.singleInstanceLock, true);
    assert.equal(report.nativeStorage.abiVersion, 1);
    assert.equal(report.nativeStorage.environmentOverridesAbsent, true);
    assert.equal(report.nativeStorage.library.path, resolve(repositoryRoot, "target/debug/libkcoder_native_storage.so"));
    assert.match(report.nativeStorage.library.sha256, /^[a-f0-9]{64}$/);
    assert.ok(report.nativeStorage.library.linkCount === 1 ||
      report.nativeStorage.library.cargoAlias?.sameIdentity === true,
    "Native storage loader must use its permitted checkout Cargo alias layout");
    assert.equal(report.storageLease.provider, "production-default");
    assert.equal(report.storageLease.acquired, true);
    assert.equal(report.storageLease.verifiedAfterConfigure, true);
    assert.equal(report.storageLease.verifiedBeforeExit, true);
    assert.equal(report.storageLease.verifiedImmediatelyBeforeExit, true);
    assert.equal(report.storageLease.heldBeforeExit, true);
    assert.equal(report.storageLease.closeRequestedBeforeExit, false);
    assert.deepEqual(report.storageLease.writerProbes.map(probe => [probe.label, probe.blockedByHeldInstance]), [
      ["data", true], ["cache", true], ["gateway", true], ["desktop", true],
    ]);
    await context.writeArtifactJson(`native-storage-lease-${phase}.json`, {
      nativeStorage: report.nativeStorage,
      storageLease: report.storageLease,
    });
    assert.ok(report.startupPhases.findIndex(item => item.name === "storage-configured")
      < report.startupPhases.findIndex(item => item.name === "single-instance-locked"));
    assert.ok(report.startupPhases.findIndex(item => item.name === "single-instance-locked")
      < report.startupPhases.findIndex(item => item.name === "browser-cache-prepared"));
    assert.ok(report.startupPhases.findIndex(item => item.name === "browser-cache-prepared")
      < report.startupPhases.findIndex(item => item.name === "electron-ready"));
    assert.equal(report.browserCache.partition, partition);
    assert.equal(report.browserCache.httpCachePath, sourceCachePath);
    assert.equal(report.browserCache.httpCacheTarget, httpCacheTarget);
    assert.equal(report.browserCache.codeCachePath, codeCachePath);
    assert.equal(report.browserCache.storagePath, join(desktopRoot, "Partitions", partitionName));
    assert.equal(report.browserCache.codeCacheSetPath, codeCachePath);
    assert.ok(report.startupPhases.findIndex(item => item.name === "partition-session-created")
      < report.startupPhases.findIndex(item => item.name === "code-cache-path-set"));
    assert.ok(report.browserCache.cacheSizeBytes >= cacheProbeSize, "Electron did not report the controlled asset in session cache");
    assert.equal(report.browserState.cacheProbeFirstBytes, cacheProbeSize);
    assert.equal(report.browserState.cacheProbeSecondBytes, cacheProbeSize);
    assert.equal(report.browserState.localStorageValue, expectedMarker);
    assert.equal(report.browserState.persistentMarkerObserved, true);

    const cacheLayout = await inspectCacheLayout({ sourceCachePath, httpCacheTarget, codeCachePath, cacheProbeBody });
    assert.equal(cacheLayout.sourceCache.kind, "symlink", "persistent Cache leaf must link to the selected cache target");
    assert.equal(absoluteLinkTarget(sourceCachePath, cacheLayout.sourceCache), httpCacheTarget,
      "persistent Cache symlink must resolve to the exact HTTP target");
    assert.equal(cacheLayout.httpCacheTarget.kind, "directory");
    assert.equal(cacheLayout.codeCachePath.kind, "directory");
    assert.ok(cacheLayout.physicalCodeCacheEntries.some(entry => entry.kind === "file"),
      "Electron did not write code cache files under the selected physical code cache directory");
    assert.ok(cacheLayout.actualCacheTargetFile, "selected HTTP cache target contains no file with the controlled response bytes");
    const actualCacheTargetBytes = await readFile(cacheLayout.actualCacheTargetFile.path);
    assert.ok(actualCacheTargetBytes.includes(cacheProbeBody), "actualCacheTargetFile does not contain the controlled response bytes");
    assert.equal(cacheLayout.actualCacheTargetFile.matchedBytes, cacheProbeSize);
    await context.writeArtifactJson(`physical-cache-${phase}.json`, cacheLayout);
    cacheLayouts.push({ phase, cacheRoot: selection.cacheRoot, ...cacheLayout });
    launches.push({ phase, exit, ownedProcessStopped: processRecord.stopped, report, cacheProbeRequests, cacheLayout });

    if (phase === "seed") {
      migrationEvidence = await migrateCacheWithNativeCli({
        context,
        cliBinary,
        cliEnvironment,
        home,
        selectionFile,
        dataRoot,
        originalCacheRoot,
        migratedCacheRoot,
        sourceCachePath,
        originalHttpCacheTarget,
        migratedHttpCacheTarget,
        cacheLayout,
        cacheProbeBody,
        operationId,
      });
      await context.writeArtifactJson("native-cli-cache-relocation.json", migrationEvidence);
    }
  }

  const dataEntries = await inspectPhysicalTree(dataRoot);
  const originalCacheEntries = await inspectPhysicalTree(originalCacheRoot);
  const migratedCacheEntries = await inspectPhysicalTree(migratedCacheRoot);
  const dataLayout = dataEntries.map(({ relativePath, kind, target }) => ({ relativePath, kind, ...(target ? { target } : {}) }));
  const originalCacheLayout = originalCacheEntries.map(({ relativePath, kind, target }) => ({ relativePath, kind, ...(target ? { target } : {}) }));
  const migratedCacheLayout = migratedCacheEntries.map(({ relativePath, kind, target }) => ({ relativePath, kind, ...(target ? { target } : {}) }));
  await context.writeArtifactJson("filesystem-layout.json", {
    dataEntries: dataLayout,
    originalCacheEntries: originalCacheLayout,
    migratedCacheEntries: migratedCacheLayout,
    cacheProbeRequests,
  });
  const persistentStores = dataEntries.map(entry => entry.relativePath)
    .filter(path => /(?:^|\/)(?:Cookies(?:-journal)?|Local Storage(?:\/|$))/.test(path));
  const cachePersistentStores = [...originalCacheEntries, ...migratedCacheEntries].map(entry => entry.relativePath)
    .filter(path => /(?:^|\/)(?:Cookies(?:-journal)?|Local Storage(?:\/|$))/.test(path));
  assert.ok(persistentStores.some(path => /(?:^|\/)Cookies(?:-journal)?$/.test(path)),
    "Electron did not place a cookie database under the persistent data root");
  assert.ok(persistentStores.some(path => /(?:^|\/)Local Storage(?:\/|$)/.test(path)),
    "Electron did not place localStorage under the persistent data root");
  assert.deepEqual(cachePersistentStores, [], "persistent Cookies/localStorage files appeared under a cache root");
  assert.ok(originalCacheEntries.some(({ relativePath }) => relativePath.startsWith(`browser-cache/desktop/${partitionName}/http/`)),
    "the original physical HTTP cache target was not retained");
  assert.ok(migratedCacheEntries.some(({ relativePath }) => relativePath.startsWith(`browser-cache/desktop/${partitionName}/http/`)),
    "Chromium did not create cache files under the Native-selected physical HTTP cache target");
  assert.ok(migratedCacheEntries.some(({ relativePath }) => relativePath.startsWith(`browser-cache/desktop/${partitionName}/code`)),
    "the Native-selected code cache directory is absent from the migrated cache root");
  assert.equal(cacheProbeRequests, 2, "each fresh HTTP cache target should fetch the controlled asset once");
  assert.equal(launches[0].report.nativeStorage.library.sha256, launches[1].report.nativeStorage.library.sha256,
    "both Electron launches must use the same checkout Native storage artifact");
  assert.equal(launches.every(launch => launch.ownedProcessStopped), true,
    "both Electron process groups must be confirmed stopped before/after Native CLI execution");

  const evidence = {
    version: 3,
    boundary: "Linux source Electron plus Root checkout Native CLI only; no installed package, Gateway, Cargo build, credential or model request",
    electronVersion: launches[0].report.runtime.electron,
    chromiumVersion: launches[0].report.runtime.chromium,
    home,
    dataRoot,
    originalCacheRoot,
    migratedCacheRoot,
    desktopRoot,
    partition,
    operationId,
    cliIdentity,
    nativeStorage: launches[0].report.nativeStorage,
    storageLeaseByPhase: launches.map(({ phase, report }) => ({ phase, ...report.storageLease })),
    migrationEvidence,
    launches: launches.map(({ phase, exit, ownedProcessStopped, report, cacheProbeRequests: requestCount }) => ({
      phase, exit, ownedProcessStopped, report, cacheProbeRequests: requestCount,
    })),
    cacheProbeRequests,
    cacheProbeSize,
    cacheProbeSha256,
    sameOrigin: new URL(`http://127.0.0.1:${port}`).origin,
    sessionCache: launches.map(({ phase, report }) => ({
      phase,
      storagePath: report.browserCache.storagePath,
      cacheSizeBytes: report.browserCache.cacheSizeBytes,
      codeCacheSetPath: report.browserCache.codeCacheSetPath,
    })),
    cacheLayouts,
    persistentStores,
    cachePersistentStores,
    originalCacheEntries: originalCacheLayout.slice(0, 80),
    migratedCacheEntries: migratedCacheLayout.slice(0, 80),
  };
  await context.writeArtifactJson("electron-storage-startup.json", evidence);
  return {
    appReadyWasFalseAtBothSetPathCalls: true,
    actualHttpCacheBytesFoundBeforeAndAfterNativeRelocation: true,
    sourceCacheLinkTargetsNativeSelectedPhysicalCacheDirectory: true,
    codeCachePathConfiguredAfterPartitionSessionCreation: true,
    nativeCliPlanExecuteStatusQueryComplete: migrationEvidence.receipt.disposition === "complete",
    oldHttpCacheRetainedAfterRelocation: true,
    businessStateRestoredAfterNativeCacheRelocation: true,
    nativeStorageLeaseHeldThroughExit: launches.every(({ report }) => report.storageLease.heldBeforeExit),
    nativeStorageLibrarySha256: evidence.nativeStorage.library.sha256,
    cliVersion: cliIdentity.version,
    cliSha256: cliIdentity.sha256,
    persistentStoresAbsentFromCacheRoots: true,
    electronVersion: evidence.electronVersion,
    chromiumVersion: evidence.chromiumVersion,
    cacheProbeRequests,
    actualCacheTargetFiles: cacheLayouts.map(layout => layout.actualCacheTargetFile),
  };
});

function createCacheProbeBody(seed, size) {
  const body = Buffer.alloc(size);
  for (let index = 0; index < body.length; index += 1) {
    body[index] = (index * 37 + seed.charCodeAt(index % seed.length)) & 0xff;
  }
  Buffer.from(`KCODER_HTTP_CACHE_PROBE_${seed}`).copy(body, 0);
  return body;
}

async function migrateCacheWithNativeCli({
  context,
  cliBinary,
  cliEnvironment,
  home,
  selectionFile,
  dataRoot,
  originalCacheRoot,
  migratedCacheRoot,
  sourceCachePath,
  originalHttpCacheTarget,
  migratedHttpCacheTarget,
  cacheLayout,
  cacheProbeBody,
  operationId,
}) {
  const originalSelectionBytes = await readFile(selectionFile);
  const originalSelection = JSON.parse(originalSelectionBytes.toString("utf8"));
  const originalDataEntries = await inspectPhysicalTree(dataRoot);
  const originalPersistentStores = snapshotPersistentStores(originalDataEntries);
  assert.ok(originalPersistentStores.cookies.length > 0, "seed Electron did not persist a Cookie database before CLI handoff");
  assert.ok(originalPersistentStores.localStorage.length > 0, "seed Electron did not persist localStorage before CLI handoff");

  const originalCacheIdentity = await pathIdentity(originalCacheRoot);
  const originalHttpIdentity = await pathIdentity(originalHttpCacheTarget);
  assert.equal(originalCacheIdentity.kind, "directory");
  assert.equal(originalHttpIdentity.kind, "directory");
  assert.equal(cacheLayout.sourceCache.kind, "symlink");
  assert.equal(absoluteLinkTarget(sourceCachePath, cacheLayout.sourceCache), originalHttpCacheTarget);
  assert.ok(cacheLayout.actualCacheTargetFile, "seed HTTP cache evidence is required before CLI handoff");
  const retainedCacheFileBefore = await readFile(cacheLayout.actualCacheTargetFile.path);
  const retainedCacheShaBefore = createHash("sha256").update(retainedCacheFileBefore).digest("hex");

  const planInputPath = context.pathInState("native-cli-plan.input.json");
  const planInput = {
    operationId,
    dataRoot,
    cacheRoot: migratedCacheRoot,
    launchIntent: "verifyOnly",
  };
  await writeFile(planInputPath, `${JSON.stringify(planInput)}\n`, { flag: "wx", mode: 0o600 });
  const planOutput = await runOwnedCli(context, "native-cli-plan", cliBinary, [
    "--internal-storage-operation-v1", "plan",
  ], {
    cwd: home,
    env: cliEnvironment,
    inputFile: planInputPath,
    timeoutMs: 60_000,
  });
  const plan = JSON.parse(planOutput);
  assert.equal(plan.operationId, operationId);
  assert.equal(plan.launchIntent, "verifyOnly");
  assert.deepEqual(plan.original, originalSelection);
  assert.equal(plan.from.dataRoot, dataRoot);
  assert.equal(plan.from.cacheRoot, originalCacheRoot);
  assert.equal(plan.target.revision, originalSelection.revision + 1);
  assert.equal(plan.target.dataRoot, dataRoot);
  assert.equal(plan.target.cacheRoot, migratedCacheRoot);
  assert.equal(plan.target.operationId, operationId);
  assert.equal(plan.components.length, 1);
  assert.equal(plan.components[0].domain, "persistent-root");
  assert.equal(plan.components[0].source, dataRoot);
  assert.equal(plan.components[0].destination, dataRoot);
  assert.deepEqual(await readFile(selectionFile), originalSelectionBytes,
    "planning must not commit or rewrite the current storage selection");
  assert.equal(await pathIdentity(migratedHttpCacheTarget), null,
    "planning must not create the new HTTP cache directory");
  await context.writeArtifactJson("native-cli-plan.json", plan);

  const statusBefore = JSON.parse(await runOwnedCli(context, "native-cli-status-before", cliBinary, [
    "--internal-storage-operation-v1", "status",
  ], { cwd: home, env: cliEnvironment, timeoutMs: 30_000 }));
  assert.equal(statusBefore, null, "plan must not create a migration receipt before execute");

  const executeInputPath = context.pathInState("native-cli-execute.input.json");
  await writeFile(executeInputPath, `${JSON.stringify(plan)}\n`, { flag: "wx", mode: 0o600 });
  const executeOutput = await runOwnedCli(context, "native-cli-execute", cliBinary, [
    "--internal-storage-operation-v1", "execute",
  ], {
    cwd: home,
    env: cliEnvironment,
    inputFile: executeInputPath,
    timeoutMs: 90_000,
  });
  const receipt = JSON.parse(executeOutput);
  assert.equal(receipt.plan.operationId, operationId);
  assert.deepEqual(receipt.plan, plan, "execute must consume and retain the complete original plan");
  assert.equal(receipt.phase, "verified");
  assert.equal(receipt.disposition, "complete");
  assert.equal(receipt.errorCode ?? null, null);
  const ownerReceipt = receipt.ownerReceipts?.["electron-browser-cache"];
  assert.ok(ownerReceipt, "Native execute must return its Electron browser-cache owner receipt");
  assert.equal(ownerReceipt.operationId, operationId);
  assert.equal(ownerReceipt.source.kind, "directoryLink");
  assert.equal(ownerReceipt.source.target, originalHttpCacheTarget);
  assert.equal(ownerReceipt.retainedEntryIdentity, ownerReceipt.source.identity);
  assert.equal(ownerReceipt.publishedLinkIdentity, ownerReceipt.preparedLinkIdentity);

  const status = JSON.parse(await runOwnedCli(context, "native-cli-status-after", cliBinary, [
    "--internal-storage-operation-v1", "status",
  ], { cwd: home, env: cliEnvironment, timeoutMs: 30_000 }));
  assert.deepEqual(status, receipt, "status must return the original operation's complete receipt");
  const storagePaths = JSON.parse(await runOwnedCli(context, "native-cli-storage-paths", cliBinary, [
    "config", "storage-paths",
  ], { cwd: home, env: cliEnvironment, timeoutMs: 30_000 }));
  assert.equal(storagePaths.layout, "unified");
  assert.equal(storagePaths.dataRoot, dataRoot);
  assert.equal(storagePaths.cacheRoot, migratedCacheRoot);
  assert.equal(storagePaths.operationId, operationId);
  assert.equal(storagePaths.selectionRevision, plan.target.revision);
  const committedSelection = JSON.parse(await readFile(selectionFile, "utf8"));
  assert.deepEqual(committedSelection, plan.target,
    "the selected record must equal the target committed by Native execute");
  await context.writeArtifactJson("native-cli-complete-receipt.json", receipt);
  await context.writeArtifactJson("native-cli-storage-paths.json", storagePaths);

  const currentCacheLink = await pathIdentity(sourceCachePath);
  const retainedLeaf = join(dirname(sourceCachePath), `Cache.retained-${operationId}`);
  const retainedCacheLink = await pathIdentity(retainedLeaf);
  assert.equal(currentCacheLink.kind, "symlink", "Native execute must publish the selected Cache symlink");
  assert.equal(absoluteLinkTarget(sourceCachePath, currentCacheLink), migratedHttpCacheTarget);
  assert.equal(retainedCacheLink.kind, "symlink", "Native execute must retain the original Cache leaf");
  assert.equal(absoluteLinkTarget(retainedLeaf, retainedCacheLink), originalHttpCacheTarget);
  assert.equal(ownerReceipt.source.identity, nativeUnixIdentity(retainedCacheLink));
  assert.equal(ownerReceipt.retainedEntryIdentity, nativeUnixIdentity(retainedCacheLink));
  assert.equal(ownerReceipt.publishedLinkIdentity, nativeUnixIdentity(currentCacheLink));
  assert.equal(ownerReceipt.httpTargetIdentity, nativeUnixIdentity(await pathIdentity(migratedHttpCacheTarget)));
  assert.deepEqual(await pathIdentity(originalCacheRoot), originalCacheIdentity,
    "Native execute must preserve the original cache root identity");
  assert.deepEqual(await pathIdentity(originalHttpCacheTarget), originalHttpIdentity,
    "Native execute must preserve the original physical HTTP cache identity");
  const retainedCacheFileAfter = await readFile(cacheLayout.actualCacheTargetFile.path);
  assert.ok(retainedCacheFileAfter.includes(cacheProbeBody),
    "old physical HTTP cache must still contain the complete controlled response after Native execute");
  assert.equal(createHash("sha256").update(retainedCacheFileAfter).digest("hex"), retainedCacheShaBefore,
    "Native execute must leave the original HTTP cache bytes unchanged");
  assert.equal((await pathIdentity(migratedHttpCacheTarget)).kind, "directory");
  assert.deepEqual(await inspectPhysicalTree(migratedHttpCacheTarget), [],
    "Native CLI must publish an empty rebuildable HTTP cache target before Electron starts");
  const afterDataEntries = await inspectPhysicalTree(dataRoot);
  const afterPersistentStores = snapshotPersistentStores(afterDataEntries);
  assert.deepEqual(afterPersistentStores, originalPersistentStores,
    "Native cache relocation must preserve source Cookie/localStorage filesystem entries");

  const processLabels = [
    "kcoder-version", "native-cli-plan", "native-cli-status-before", "native-cli-execute",
    "native-cli-status-after", "native-cli-storage-paths",
  ];
  const processGroups = processLabels.map(label => {
    const process = context.processes.get(label);
    assert.equal(process?.stopped, true, `RunContext did not confirm CLI process group ${label} stopped`);
    return { label, pid: process.pid, pgid: process.pgid, stopped: process.stopped };
  });
  return {
    operationId,
    planInput: planInputPath,
    executeInput: executeInputPath,
    launchIntent: plan.launchIntent,
    plan,
    receipt,
    status,
    storagePaths,
    selectionFile: committedSelection,
    sourceCacheAfterExecute: currentCacheLink,
    retainedCacheAfterExecute: retainedCacheLink,
    sourceCacheFileSha256Before: retainedCacheShaBefore,
    sourceCacheFileSha256After: createHash("sha256").update(retainedCacheFileAfter).digest("hex"),
    sourcePersistentStoresBefore: originalPersistentStores,
    sourcePersistentStoresAfter: afterPersistentStores,
    processGroups,
  };
}

async function runOwnedCli(context, label, command, args, { cwd, env, inputFile, timeoutMs }) {
  const child = context.spawnOwned(label, command, args, {
    cwd,
    env,
    stdin: inputFile ? "pipe" : "ignore",
  });
  const chunks = [];
  let outputBytes = 0;
  let outputOverflow = false;
  child.stdout.on("data", chunk => {
    outputBytes += chunk.length;
    if (outputBytes <= 1024 * 1024) chunks.push(Buffer.from(chunk));
    else outputOverflow = true;
  });
  if (inputFile) child.stdin.end(await readFile(inputFile));
  let exit;
  try {
    exit = await childExitWithin(child, timeoutMs, label);
  } catch (error) {
    await context.stopOwned(label);
    throw error;
  }
  await context.stopOwned(label);
  assert.equal(context.processes.get(label)?.stopped, true,
    `RunContext did not confirm owned CLI process group ${label} stopped`);
  assert.equal(exit.code, 0, `owned CLI ${label} exited unsuccessfully: ${JSON.stringify(exit)}`);
  assert.equal(outputOverflow, false, `owned CLI ${label} output exceeded the 1 MiB capture bound`);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function snapshotPersistentStores(entries) {
  const cookies = entries.filter(entry => /(?:^|\/)Cookies(?:-journal)?$/.test(entry.relativePath));
  const localStorage = entries.filter(entry => /(?:^|\/)Local Storage(?:\/|$)/.test(entry.relativePath));
  const summarize = values => values.map(({ relativePath, kind, dev, ino, mode }) => ({ relativePath, kind, dev, ino, mode }));
  return { cookies: summarize(cookies), localStorage: summarize(localStorage) };
}

function absoluteLinkTarget(path, identity) {
  assert.equal(identity.kind, "symlink", `expected a symlink at ${path}`);
  return resolve(dirname(path), identity.target);
}

function nativeUnixIdentity(identity) {
  return `unix:${identity.dev}:${identity.ino}`;
}

function childExitWithin(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
  });
}

async function pathIdentity(path) {
  let entry;
  try { entry = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory"
    : entry.isFile() ? "file" : "other";
  return {
    path,
    kind,
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    ...(entry.isSymbolicLink() ? { target: await readlink(path) } : {}),
  };
}

async function inspectPhysicalTree(root, prefix = "") {
  const entries = [];
  for (const item of await readdir(join(root, prefix))) {
    const relativePath = prefix ? `${prefix}/${item}` : item;
    const path = join(root, relativePath);
    const identity = await pathIdentity(path);
    entries.push({ relativePath, ...identity });
    if (identity.kind === "directory") entries.push(...await inspectPhysicalTree(root, relativePath));
  }
  return entries;
}

async function inspectCacheLayout({ sourceCachePath, httpCacheTarget, codeCachePath, cacheProbeBody }) {
  const [sourceCache, httpTarget, codeTarget, httpEntries, codeEntries] = await Promise.all([
    pathIdentity(sourceCachePath),
    pathIdentity(httpCacheTarget),
    pathIdentity(codeCachePath),
    inspectPhysicalTree(httpCacheTarget),
    inspectPhysicalTree(codeCachePath),
  ]);
  let actualCacheTargetFile = null;
  for (const entry of httpEntries) {
    if (entry.kind !== "file") continue;
    const path = join(httpCacheTarget, entry.relativePath);
    const bytes = await readFile(path);
    if (bytes.includes(cacheProbeBody)) {
      actualCacheTargetFile = {
        path,
        relativePath: entry.relativePath,
        fileBytes: bytes.length,
        matchedBytes: cacheProbeBody.length,
        fileSha256: createHash("sha256").update(bytes).digest("hex"),
        probeSha256: createHash("sha256").update(cacheProbeBody).digest("hex"),
      };
      break;
    }
  }
  return {
    sourceCache,
    httpCacheTarget: httpTarget,
    codeCachePath: codeTarget,
    physicalHttpCacheFileCount: httpEntries.filter(entry => entry.kind === "file").length,
    physicalCodeCacheEntries: codeEntries.map(({ relativePath, kind }) => ({ relativePath, kind })),
    actualCacheTargetFile,
  };
}
