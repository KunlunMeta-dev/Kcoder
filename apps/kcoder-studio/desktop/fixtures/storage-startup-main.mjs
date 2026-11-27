import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { app, BrowserWindow, session } from "electron";
import { readFileSync } from "node:fs";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureDesktopStorage } from "../storage-startup.mjs";
import { DESKTOP_BROWSER_PARTITION, prepareBrowserCache } from "../storage-browser-cache.mjs";
import { loadStorageNative } from "../../src/storage-lease.mjs";

const config = JSON.parse(readFileSync(process.env.KCODER_STORAGE_FIXTURE_CONFIG, "utf8"));
const phase = process.env.KCODER_STORAGE_FIXTURE_PHASE;
const reportPath = process.env.KCODER_STORAGE_FIXTURE_REPORT;
const report = {
  version: 2,
  launchPhase: phase,
  phase: "module-loaded",
  completion: null,
  lifecycle: "module-loaded",
  startupPhases: [],
  runtime: { electron: process.versions.electron, chromium: process.versions.chrome },
  beforeStorage: { appReady: app.isReady() },
  pathSetCalls: [],
  afterStorage: null,
  singleInstanceLock: null,
  nativeStorage: null,
  storageLease: null,
  browserCache: null,
  browserState: null,
  failure: null,
};
let completed = false;

async function checkpoint() {
  const temporary = `${reportPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, reportPath);
}

async function markPhase(name, details = {}) {
  report.phase = name;
  report.lifecycle = name;
  report.startupPhases.push({ name, appReady: app.isReady(), ...details });
  await checkpoint();
}

async function finish(error) {
  if (completed) return;
  completed = true;
  if (error) report.failure = String(error?.stack || error).slice(0, 1200);
  await checkpoint().catch(() => {});
  if (!error && desktopStorage?.lease) {
    try {
      desktopStorage.lease.verify();
      report.storageLease.verifiedImmediatelyBeforeExit = true;
      await checkpoint();
    } catch (verifyError) {
      error = verifyError;
      report.completion = null;
      report.failure = String(verifyError?.stack || verifyError).slice(0, 1200);
      await checkpoint().catch(() => {});
    }
  }
  app.exit(error ? 1 : 0);
}

const watchdog = setTimeout(() => { void finish(new Error("Electron storage startup fixture timed out")); }, 30_000);

assert.ok(["seed", "verify"].includes(phase), "fixture phase is invalid");
app.setName("KCoder Studio");
const observedApp = {
  getPath(name) { return app.getPath(name); },
  setPath(name, value) {
    report.pathSetCalls.push({ kind: name, value, appReady: app.isReady() });
    return app.setPath(name, value);
  },
};

let initializationFailed = false;
let desktopStorage = null;
let browserCache = null;
let nativeStorageModule = null;
try {
  desktopStorage = await configureDesktopStorage({ app: observedApp, env: process.env });
  assert.equal(typeof desktopStorage.lease?.verify, "function", "Desktop startup must return its production storage lease");
  assert.equal(typeof desktopStorage.lease?.close, "function", "Desktop startup lease must expose its owned close operation");
  desktopStorage.lease.verify();
  nativeStorageModule = await loadStorageNative();
  assert.equal(nativeStorageModule.abiVersion, 1, "fixture did not load the registered Native storage ABI");
  assert.equal(process.env.KCODER_TARGET_DIR, undefined, "fixture must load the default checkout Native artifact");
  assert.equal(process.env.CARGO_TARGET_DIR, undefined, "fixture must load the default checkout Native artifact");
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const nativeLibraryPath = resolve(repositoryRoot, "target/debug/libkcoder_native_storage.so");
  const nativeLibraryInfo = await lstat(nativeLibraryPath);
  assert.ok(nativeLibraryInfo.isFile() && !nativeLibraryInfo.isSymbolicLink(),
    "default checkout Native storage artifact must be a regular file");
  const nativeAliasPath = join(dirname(nativeLibraryPath), "deps", "libkcoder_native_storage.so");
  const nativeAliasInfo = nativeLibraryInfo.nlink === 2 ? await lstat(nativeAliasPath) : null;
  const cargoAliasSameIdentity = nativeAliasInfo?.isFile() && !nativeAliasInfo.isSymbolicLink() &&
    nativeAliasInfo.dev === nativeLibraryInfo.dev && nativeAliasInfo.ino === nativeLibraryInfo.ino &&
    nativeAliasInfo.nlink === 2;
  assert.ok(nativeLibraryInfo.nlink === 1 || cargoAliasSameIdentity,
    "Native artifact must be single-link or the exact Cargo target/debug and target/debug/deps alias pair");
  report.nativeStorage = {
    abiVersion: nativeStorageModule.abiVersion,
    environmentOverridesAbsent: true,
    library: {
      path: nativeLibraryPath,
      sizeBytes: nativeLibraryInfo.size,
      linkCount: nativeLibraryInfo.nlink,
      dev: nativeLibraryInfo.dev,
      ino: nativeLibraryInfo.ino,
      cargoAlias: cargoAliasSameIdentity ? { path: nativeAliasPath, sameIdentity: true, linkCount: nativeAliasInfo.nlink } : null,
      sha256: createHash("sha256").update(await readFile(nativeLibraryPath)).digest("hex"),
    },
  };
  report.storageLease = {
    provider: "production-default",
    acquired: true,
    verifiedAfterConfigure: true,
    closeRequestedBeforeExit: false,
  };
  report.afterStorage = {
    appReady: app.isReady(),
    home: app.getPath("home"),
    appData: app.getPath("appData"),
    userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"),
    browserCacheRoot: desktopStorage.browserCacheRoot,
    resolvedPaths: desktopStorage.paths,
  };
  await markPhase("storage-configured");

  await markPhase("single-instance-lock-requesting");
  report.singleInstanceLock = app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() });
  assert.equal(report.singleInstanceLock, true, "fixture did not acquire its isolated Electron single-instance lock");
  await markPhase("single-instance-locked");

  if (desktopStorage.browserCacheRoot) {
    browserCache = await prepareBrowserCache({
      desktopRoot: desktopStorage.paths.desktopRoot,
      cacheRoot: desktopStorage.paths.cacheRoot,
      partition: DESKTOP_BROWSER_PARTITION,
    });
  }
  assert.ok(browserCache, "fixture requires the selected browser cache root");
  report.browserCache = { ...browserCache };
  await markPhase("browser-cache-prepared", { cacheStatus: browserCache.status });
} catch (error) {
  initializationFailed = true;
  clearTimeout(watchdog);
  await finish(error);
}

async function readyMain() {
  await app.whenReady();
  await markPhase("electron-ready");

  const browserSession = session.fromPartition(DESKTOP_BROWSER_PARTITION);
  report.browserCache.storagePath = browserSession.getStoragePath();
  await markPhase("partition-session-created");
  browserSession.setCodeCachePath(browserCache.codeCachePath);
  report.browserCache.codeCacheSetPath = browserCache.codeCachePath;
  await markPhase("code-cache-path-set");

  browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let allowed = false;
    try { allowed = new URL(details.url).origin === config.baseUrl; } catch {}
    callback({ cancel: !allowed });
  });

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: DESKTOP_BROWSER_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await markPhase("browser-window-created");
  await window.loadURL(`${config.baseUrl}/${phase}`);
  await markPhase("browser-page-loaded");
  const browserState = await window.webContents.executeJavaScript(`(async () => {
    const readCacheProbe = async () => {
      const response = await fetch(${JSON.stringify(`${config.baseUrl}/asset.bin`)}, { cache: "default" });
      return (await response.arrayBuffer()).byteLength;
    };
    return {
      localStorageValue: localStorage.getItem("kcoder-storage-probe"),
      persistentMarkerObserved: document.cookie.split("; ").includes("kcoder_storage_probe=${config.expectedCookie}"),
      cacheProbeFirstBytes: await readCacheProbe(),
      cacheProbeSecondBytes: await readCacheProbe(),
    };
  })()`);
  report.browserState = browserState;
  await markPhase("browser-state-read");
  assert.equal(browserState.localStorageValue, config.expectedMarker);
  assert.equal(browserState.persistentMarkerObserved, true);
  browserSession.flushStorageData();
  report.browserCache.cacheSizeBytes = await browserSession.getCacheSize();
  await markPhase("browser-storage-flushed");
  report.completion = "completed";
  await markPhase("completed");
  const writerProbes = [
    ["data", desktopStorage.paths.dataRoot],
    ["cache", desktopStorage.paths.cacheRoot],
    ["gateway", desktopStorage.paths.gatewayRoot],
    ["desktop", desktopStorage.paths.desktopRoot],
  ].map(([label, root]) => {
    const probe = nativeStorageModule.tryExclusive(root, "kcoder-storage-writers.lock", false);
    const blockedByHeldInstance = probe === null;
    if (probe !== null && probe !== undefined) nativeStorageModule.close(probe);
    return { label, root, blockedByHeldInstance };
  });
  desktopStorage.lease.verify();
  assert.ok(writerProbes.every(probe => probe.blockedByHeldInstance),
    "Native exclusive writer probes must remain blocked while the Desktop instance lease is held");
  report.storageLease = {
    ...report.storageLease,
    verifiedBeforeExit: true,
    writerProbes,
    heldBeforeExit: true,
    closeRequestedBeforeExit: false,
  };
  await markPhase("storage-lease-held-before-exit");
  clearTimeout(watchdog);
  await finish();
}

if (!initializationFailed) {
  void readyMain().catch(error => {
    clearTimeout(watchdog);
    void finish(error);
  });
}
