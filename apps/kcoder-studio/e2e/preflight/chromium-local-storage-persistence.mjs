import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeChromiumProfileAndWaitForExit } from "../harness/chromium-profile-exit.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { runE2E } from "../harness/run-context.mjs";

const FIXTURE_HTML = Buffer.from(`<!doctype html>
<html><head><meta charset="utf-8"><title>Owned profile persistence probe</title></head>
<body><main>Owned local storage profile persistence probe</main></body></html>`);
const PROFILE_SCAN_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxRegularFileBytes: 512 * 1024 * 1024,
  maxDepth: 32,
  deadlineMs: 750,
});

function timestamp() {
  return new Date().toISOString();
}

function safeError(error) {
  const knownCodes = new Set([
    "EACCES", "EIO", "ELOOP", "EMFILE", "ENFILE", "ENOENT", "ENOTDIR", "EPERM",
  ]);
  const knownNames = new Set(["AssertionError", "Error", "RangeError", "TypeError", "unknown"]);
  return {
    name: knownNames.has(error?.name) ? error.name : "other",
    code: knownCodes.has(error?.code) ? error.code : null,
  };
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function withinDeadline(operation, deadline) {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) return { kind: "timeout" };
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(
        value => ({ kind: "value", value }),
        error => ({ kind: "error", error }),
      ),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function addExitObserver(child) {
  let event = null;
  const listener = (code, signal) => {
    event = { code: code ?? null, signal: signal ?? null };
  };
  child.once("exit", listener);
  return {
    read: () => event,
    remove: () => child.removeListener("exit", listener),
  };
}

async function inspectOwnedProfileMetadata(profileRoot, limits = PROFILE_SCAN_LIMITS) {
  const startedAt = performance.now();
  const deadline = startedAt + limits.deadlineMs;
  const totals = {
    entriesVisited: 0,
    directoriesVisited: 0,
    regularFilesVisited: 0,
    regularFileBytes: 0,
    symlinkEntries: 0,
    specialEntries: 0,
    metadataErrors: 0,
    localStorageLevelDbDirectories: 0,
    localStorageLevelDbRegularFiles: 0,
    localStorageLevelDbBytes: 0,
  };
  const incomplete = reason => ({
    status: "incomplete",
    reason,
    ...totals,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
  });

  const rootResult = await withinDeadline(() => lstat(profileRoot), deadline);
  if (rootResult.kind === "timeout") return incomplete("deadline-limit");
  if (rootResult.kind === "error") {
    if (rootResult.error?.code === "ENOENT") {
      return {
        status: "missing",
        reason: "profile-root-absent",
        entriesVisited: null,
        directoriesVisited: null,
        regularFilesVisited: null,
        regularFileBytes: null,
        symlinkEntries: null,
        specialEntries: null,
        metadataErrors: null,
        localStorageLevelDbDirectories: null,
        localStorageLevelDbRegularFiles: null,
        localStorageLevelDbBytes: null,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    }
    return incomplete("profile-root-metadata-error");
  }
  const rootStat = rootResult.value;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return incomplete("unsafe-profile-root");

  const pending = [{ path: profileRoot, depth: 0, underLocalStorage: false, insideLevelDb: false }];
  while (pending.length > 0) {
    if (performance.now() >= deadline) return incomplete("deadline-limit");
    const directory = pending.pop();
    const directoryStat = await withinDeadline(() => lstat(directory.path), deadline);
    if (directoryStat.kind === "timeout") return incomplete("deadline-limit");
    if (directoryStat.kind !== "value") {
      totals.metadataErrors += 1;
      return incomplete("directory-metadata-error");
    }
    if (directoryStat.value.isSymbolicLink() || !directoryStat.value.isDirectory()) {
      return incomplete("directory-changed-during-scan");
    }

    const directoryEntries = await withinDeadline(() => readdir(directory.path, { withFileTypes: true }), deadline);
    if (directoryEntries.kind === "timeout") return incomplete("deadline-limit");
    if (directoryEntries.kind !== "value") {
      totals.metadataErrors += 1;
      return incomplete("directory-read-error");
    }
    const entries = directoryEntries.value;

    for (const entry of entries) {
      if (performance.now() >= deadline) return incomplete("deadline-limit");
      if (totals.entriesVisited >= limits.maxEntries) return incomplete("entry-limit");
      totals.entriesVisited += 1;
      const entryPath = join(directory.path, entry.name);
      const entryMetadata = await withinDeadline(() => lstat(entryPath), deadline);
      if (entryMetadata.kind === "timeout") return incomplete("deadline-limit");
      if (entryMetadata.kind !== "value") {
        totals.metadataErrors += 1;
        return incomplete(entryMetadata.error?.code === "ENOENT" ? "entry-changed-during-scan" : "entry-metadata-error");
      }
      const stat = entryMetadata.value;

      if (stat.isSymbolicLink()) {
        totals.symlinkEntries += 1;
        continue;
      }
      if (stat.isDirectory()) {
        totals.directoriesVisited += 1;
        const isLocalStorageDirectory = directory.underLocalStorage || entry.name === "Local Storage";
        const isLevelDbDirectory = isLocalStorageDirectory && entry.name === "leveldb";
        if (isLevelDbDirectory) totals.localStorageLevelDbDirectories += 1;
        if (directory.depth + 1 > limits.maxDepth) return incomplete("depth-limit");
        pending.push({
          path: entryPath,
          depth: directory.depth + 1,
          underLocalStorage: isLocalStorageDirectory,
          insideLevelDb: directory.insideLevelDb || isLevelDbDirectory,
        });
        continue;
      }
      if (stat.isFile()) {
        const size = stat.size;
        if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxRegularFileBytes - totals.regularFileBytes) {
          return incomplete("byte-limit");
        }
        totals.regularFilesVisited += 1;
        totals.regularFileBytes += size;
        if (directory.insideLevelDb) {
          totals.localStorageLevelDbRegularFiles += 1;
          totals.localStorageLevelDbBytes += size;
        }
        continue;
      }
      totals.specialEntries += 1;
    }
  }

  return {
    status: "complete",
    reason: null,
    ...totals,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function installDocumentStartStorageProbe(page, { origin, sentinelKey, sentinelValue }) {
  return page.addInitScript(({ expectedOrigin, key, value }) => {
    if (window.location.origin !== expectedOrigin || window.__kcoderProfileStorageProbe) return;
    const sample = {
      sameOrigin: true,
      storageReadable: false,
      keyCount: null,
      sentinelPresent: null,
    };
    try {
      const storage = window.localStorage;
      const keyCount = storage.length;
      const sentinelPresent = storage.getItem(key) === value;
      sample.storageReadable = true;
      sample.keyCount = keyCount;
      sample.sentinelPresent = sentinelPresent;
    } catch {
      sample.sameOrigin = true;
    }
    Object.defineProperty(window, "__kcoderProfileStorageProbe", {
      configurable: false,
      enumerable: false,
      value: sample,
    });
  }, {
    expectedOrigin: origin,
    key: sentinelKey,
    value: sentinelValue,
  });
}

async function readDocumentStartProbe(page) {
  return page.evaluate(() => {
    const probe = window.__kcoderProfileStorageProbe;
    if (!probe || typeof probe !== "object") return null;
    return {
      sameOrigin: probe.sameOrigin === true,
      storageReadable: probe.storageReadable === true,
      keyCount: Number.isSafeInteger(probe.keyCount) ? probe.keyCount : null,
      sentinelPresent: typeof probe.sentinelPresent === "boolean" ? probe.sentinelPresent : null,
    };
  });
}

async function runProfileTrial(context, { name, port, closeMode, artifactName }) {
  const origin = `http://127.0.0.1:${port}`;
  const sentinelKey = `kcoder-profile-probe-${randomBytes(12).toString("hex")}`;
  const sentinelValue = randomBytes(24).toString("hex");
  const trial = {
    closeMode,
    originScheme: "http",
    originHost: "127.0.0.1",
    profileSameAcrossProcesses: null,
    processIdsDiffer: null,
    warmDocumentStart: null,
    warmStorageAfterWrite: null,
    warmMetadataBeforeClose: null,
    warmClose: null,
    warmMetadataAfterClose: null,
    coldDocumentStart: null,
    coldStorageAfterNavigation: null,
    coldClose: null,
    failure: null,
  };
  let phase = "warm-startup";
  let warm = null;
  let cold = null;
  let warmPage = null;
  let coldPage = null;

  try {
    warm = await startChromium(context, {
      label: `profile-persistence-${name}-warm`,
      profileName: `profile-persistence-${name}`,
      startTimeoutMs: 15_000,
      connectTimeoutMs: 8_000,
      pageTimeoutMs: 8_000,
      closeTimeoutMs: 5_000,
    });
    const warmRecord = context.processes.get(`profile-persistence-${name}-warm`);
    assert.ok(warmRecord && warmRecord.child === warm.child, "warm Chromium must be the exact RunContext-owned process");
    assert.equal(warmRecord.pid, warm.child.pid, "warm process record PID must match its child");

    phase = "warm-page-and-document-start";
    warmPage = await warm.newPersistentPage();
    await installDocumentStartStorageProbe(warmPage, { origin, sentinelKey, sentinelValue });
    const warmResponse = await warmPage.goto(origin, { waitUntil: "load", timeout: 8_000 });
    assert.equal(warmResponse?.status(), 200, "warm owned loopback document must load");
    trial.warmDocumentStart = await readDocumentStartProbe(warmPage);
    assert.equal(trial.warmDocumentStart?.sameOrigin, true, "warm document-start sample must be same-origin");
    assert.equal(trial.warmDocumentStart?.storageReadable, true, "warm document-start localStorage must be readable");

    trial.warmStorageAfterWrite = await warmPage.evaluate(({ key, value }) => {
      try {
        window.localStorage.setItem(key, value);
        return {
          storageReadable: true,
          sentinelPresent: window.localStorage.getItem(key) === value,
          keyCount: window.localStorage.length,
        };
      } catch {
        return { storageReadable: false, sentinelPresent: false, keyCount: null };
      }
    }, { key: sentinelKey, value: sentinelValue });
    assert.equal(trial.warmStorageAfterWrite.storageReadable, true, "warm localStorage write must succeed");
    assert.equal(trial.warmStorageAfterWrite.sentinelPresent, true, "warm localStorage must contain the random sentinel");
    trial.warmMetadataBeforeClose = await inspectOwnedProfileMetadata(warm.profileDir);

    phase = "warm-page-close";
    await warmPage.goto("about:blank", { waitUntil: "load", timeout: 5_000 });
    await warmPage.close();
    warmPage = null;

    if (closeMode === "browser-target-cdp") {
      phase = "explicit-browser-target-close";
      trial.warmClose = await closeChromiumProfileAndWaitForExit(context, warm, {
        exitTimeoutMs: 10_000,
        cleanupTimeoutMs: 15_000,
      });
    } else {
      phase = "existing-handle-close";
      const exitObserver = addExitObserver(warm.child);
      let closeError = null;
      try {
        await warm.close();
      } catch (error) {
        closeError = safeError(error);
      } finally {
        const event = exitObserver.read();
        exitObserver.remove();
        trial.warmClose = {
          mechanism: "existing-handle-close",
          exitObserved: event !== null,
          exitCode: warm.child.exitCode ?? event?.code ?? null,
          signalCode: warm.child.signalCode ?? event?.signal ?? null,
          closeError,
        };
      }
      assert.equal(trial.warmClose.exitObserved, true, "existing close must observe the exact warm child exit before relaunch");
      assert.equal(trial.warmClose.closeError, null, "existing handle close must complete");
    }
    assert.equal(trial.warmClose.handleCloseOutcome ?? "completed", "completed", "profile owner close must complete");
    trial.warmMetadataAfterClose = await inspectOwnedProfileMetadata(warm.profileDir);

    phase = "cold-startup-and-profile-identity";
    cold = await startChromium(context, {
      label: `profile-persistence-${name}-cold`,
      profileName: `profile-persistence-${name}`,
      startTimeoutMs: 15_000,
      connectTimeoutMs: 8_000,
      pageTimeoutMs: 8_000,
      closeTimeoutMs: 5_000,
    });
    const coldRecord = context.processes.get(`profile-persistence-${name}-cold`);
    assert.ok(coldRecord && coldRecord.child === cold.child, "cold Chromium must be the exact RunContext-owned process");
    assert.equal(coldRecord.pid, cold.child.pid, "cold process record PID must match its child");
    trial.profileSameAcrossProcesses = cold.profileDir === warm.profileDir;
    trial.processIdsDiffer = Number.isSafeInteger(cold.child.pid) && Number.isSafeInteger(warm.child.pid)
      ? cold.child.pid !== warm.child.pid
      : false;
    assert.equal(trial.profileSameAcrossProcesses, true, "cold process must reopen the same RunContext profile");
    assert.equal(trial.processIdsDiffer, true, "cold process must use a different Chromium PID");

    phase = "cold-document-start-and-storage-read";
    coldPage = await cold.newPersistentPage();
    await installDocumentStartStorageProbe(coldPage, { origin, sentinelKey, sentinelValue });
    const coldResponse = await coldPage.goto(origin, { waitUntil: "load", timeout: 8_000 });
    assert.equal(coldResponse?.status(), 200, "cold owned loopback document must load");
    trial.coldDocumentStart = await readDocumentStartProbe(coldPage);
    trial.coldStorageAfterNavigation = await coldPage.evaluate(({ expectedOrigin, key, value }) => {
      try {
        const storage = window.localStorage;
        return {
          sameOrigin: window.location.origin === expectedOrigin,
          storageReadable: true,
          keyCount: storage.length,
          sentinelPresent: storage.getItem(key) === value,
        };
      } catch {
        return { sameOrigin: false, storageReadable: false, keyCount: null, sentinelPresent: false };
      }
    }, { expectedOrigin: origin, key: sentinelKey, value: sentinelValue });
    assert.equal(trial.coldDocumentStart?.sameOrigin, true, "cold document-start sample must be same-origin");
    assert.equal(trial.coldDocumentStart?.storageReadable, true, "cold document-start localStorage must be readable");
    assert.equal(trial.coldStorageAfterNavigation.sameOrigin, true, "cold storage sample must remain on the same loopback origin");
    assert.equal(trial.coldStorageAfterNavigation.storageReadable, true, "cold localStorage must be readable after navigation");

    if (closeMode === "browser-target-cdp") {
      assert.equal(trial.warmClose.outcome, "graceful-exit-observed", "explicit Browser.close must precede a clean owned child exit");
      assert.equal(trial.warmClose.handleCloseOutcome, "completed", "profile owner handle close must complete");
      assert.ok(
        ["detached", "session-already-closed", "session-transport-closed"].includes(trial.warmClose.sessionCleanup),
        "browser CDP session cleanup must complete, have an observed close event, or have a proven closed transport",
      );
      if (trial.warmClose.sessionCleanup === "session-already-closed") {
        assert.equal(trial.warmClose.sessionCloseObserved, true, "an already-closed session must have emitted close");
      }
      if (trial.warmClose.sessionCleanup === "session-transport-closed") {
        assert.equal(trial.warmClose.browserDisconnectEvidenceBeforeOwnerClose, true, "a dead session transport must have public Browser disconnect evidence");
      }
      assert.equal(
        trial.warmClose.browserDisconnectEvidenceBeforeOwnerClose,
        true,
        "the public Playwright Browser must be disconnected before releasing the profile owner",
      );
      assert.equal(trial.warmClose.browserDisconnectListenerCleanup, "removed", "the public disconnect watcher must be removed");
      assert.equal(trial.warmClose.fallbackUsed, false, "the helper trial must not rely on handle-close to terminate Chromium");
      assert.equal(trial.warmClose.processTreeClearBeforeRelease, true, "the owned process group must be gone before releasing the profile");
      assert.equal(trial.coldDocumentStart.sentinelPresent, true, "the helper trial must retain the random sentinel before application scripts");
      assert.equal(trial.coldStorageAfterNavigation.sentinelPresent, true, "the helper trial must retain the random sentinel after navigation");
    }

    phase = "cold-process-close";
    await coldPage.goto("about:blank", { waitUntil: "load", timeout: 5_000 });
    await coldPage.close();
    coldPage = null;
    const coldExitObserver = addExitObserver(cold.child);
    try {
      await cold.close();
    } finally {
      const event = coldExitObserver.read();
      coldExitObserver.remove();
      trial.coldClose = {
        exitObserved: event !== null,
        exitCode: cold.child.exitCode ?? event?.code ?? null,
        signalCode: cold.child.signalCode ?? event?.signal ?? null,
      };
    }

    return trial;
  } catch (error) {
    trial.failure = { phase, ...safeError(error) };
    throw error;
  } finally {
    if (warmPage) await warmPage.close().catch(() => {});
    if (coldPage) await coldPage.close().catch(() => {});
    if (cold) await cold.close().catch(() => {});
    if (warm) await warm.close().catch(() => {});
    trial.endedAt = timestamp();
    await context.writeArtifactJson(artifactName, trial);
  }
}

await runE2E(import.meta.url, {
  testId: "chromium-local-storage-persistence",
  modelPolicy: "model-independent owned Chromium profile close and localStorage persistence preflight",
  processSignalTimeoutMs: 5_000,
  cleanupTimeoutMs: 30_000,
  survivorCheckTimeoutMs: 5_000,
  retainSuccessLogs: true,
}, async context => {
  const evidence = {
    sourceSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
    nodeVersion: process.version,
    chromiumExecutableSelection: process.env.KCODER_E2E_CHROMIUM_BIN
      ? "environment override"
      : "harness default",
    startedAt: timestamp(),
    fixture: { bindAddress: "127.0.0.1", port: null, requests: 0 },
    profileScanLimits: PROFILE_SCAN_LIMITS,
    baselineDefaultClose: null,
    explicitBrowserTargetClose: null,
    failure: null,
  };
  let phase = "fixture-listen";
  const server = createServer((request, response) => {
    const method = request.method || "UNKNOWN";
    let path = "<invalid>";
    try {
      path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    } catch {
      // Retain only the path category; never store request text.
    }
    let status = 404;
    let body = Buffer.from("Not found");
    let contentType = "text/plain; charset=utf-8";
    if (path === "/" && (method === "GET" || method === "HEAD")) {
      status = 200;
      body = FIXTURE_HTML;
      contentType = "text/html; charset=utf-8";
      evidence.fixture.requests += 1;
    } else if (path === "/favicon.ico" && (method === "GET" || method === "HEAD")) {
      status = 204;
      body = Buffer.alloc(0);
    }
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": contentType,
      "content-length": body.length,
      "x-content-type-options": "nosniff",
    });
    response.end(method === "HEAD" || status === 204 ? undefined : body);
  });
  server.on("error", error => {
    evidence.fixture.error = safeError(error);
  });
  context.addCleanup("close owned local-storage persistence HTTP fixture", () => closeServer(server));

  try {
    await new Promise((resolve, reject) => {
      const onError = error => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const port = server.address().port;
    context.registerPort("chromium-local-storage-persistence-http", port);
    evidence.fixture.port = port;

    phase = "default-close-baseline";
    evidence.baselineDefaultClose = await runProfileTrial(context, {
      name: "baseline",
      port,
      closeMode: "existing-handle-close",
      artifactName: "chromium-local-storage-persistence-baseline.json",
    });

    phase = "explicit-browser-target-close";
    evidence.explicitBrowserTargetClose = await runProfileTrial(context, {
      name: "explicit",
      port,
      closeMode: "browser-target-cdp",
      artifactName: "chromium-local-storage-persistence-explicit-close.json",
    });
    assert.equal(evidence.explicitBrowserTargetClose.warmClose.outcome, "graceful-exit-observed");
    assert.equal(evidence.explicitBrowserTargetClose.coldStorageAfterNavigation.sentinelPresent, true);

    return {
      baselineSentinelPresentAtColdDocumentStart:
        evidence.baselineDefaultClose.coldDocumentStart?.sentinelPresent ?? null,
      explicitCloseOutcome: evidence.explicitBrowserTargetClose.warmClose.outcome,
      explicitSentinelPresentAtColdDocumentStart:
        evidence.explicitBrowserTargetClose.coldDocumentStart.sentinelPresent,
      metadataScanStatusAfterBaselineExit: evidence.baselineDefaultClose.warmMetadataAfterClose.status,
      metadataScanStatusAfterExplicitExit: evidence.explicitBrowserTargetClose.warmMetadataAfterClose.status,
    };
  } catch (error) {
    const failure = { phase, ...safeError(error) };
    evidence.failure = failure;
    throw new Error(`Chromium profile persistence preflight failed during ${phase} (${failure.name}/${failure.code ?? "no-code"})`);
  } finally {
    evidence.endedAt = timestamp();
    await context.writeArtifactJson("chromium-local-storage-persistence.json", evidence);
  }
});
