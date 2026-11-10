import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { createServer } from "node:http";
import { mkdir, lstat, open, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createMobileWebStatic } from "../../src/mobile-web-static.js";
import { startChromium } from "../harness/chromium.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const BASE_TOKEN = "/__kcoder_mobile_mount_v1__";
const EXPECTED_MOBILE_STATIC_SHA256 = "021528a0e87cce5ab642a5dd32435b2a48d97078e1a88467bd3916c233dbbd1e";
const EXPECTED_MOBILE_OFFLINE_SHA256 = "53098555b0c1c01f5e2021d487a655fb666bb85d25b2476389d8450dff97beb1";
const PROFILE_NAME = "mobile-offline-shell-profile";
const SERVER_LABEL = "mobile-offline-shell-fixture-http";
const FIXTURE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; worker-src 'self'; object-src 'none'";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function filePin(path) {
  const normalized = resolve(path);
  return { path: normalized, sha256: sha256(await readFile(normalized)) };
}

async function capturePins(chromiumInputPath) {
  return {
    mobileStatic: await filePin(resolve(repoRoot, "apps/kcoder-studio/src/mobile-web-static.js")),
    mobileOffline: await filePin(resolve(repoRoot, "apps/kcoder-studio/src/mobile-web-offline.js")),
    chromiumHarness: await filePin(resolve(repoRoot, "apps/kcoder-studio/e2e/harness/chromium.mjs")),
    runContext: await filePin(resolve(repoRoot, "apps/kcoder-studio/e2e/harness/run-context.mjs")),
    ownedProcess: await filePin(resolve(repoRoot, "apps/kcoder-studio/e2e/harness/owned-process.mjs")),
    retention: await filePin(resolve(repoRoot, "apps/kcoder-studio/e2e/harness/retention.mjs")),
    playwrightPackage: await filePin(resolve(repoRoot, "apps/kcoder-studio/renderer/node_modules/@playwright/test/package.json")),
    preflightSource: await filePin(resolve(repoRoot, "apps/kcoder-studio/e2e/preflight/mobile-web-offline-shell-browser.mjs")),
    chromiumLauncher: {
      configuredPath: resolve(chromiumInputPath),
      resolvedPath: await realpath(chromiumInputPath),
    },
  };
}

function parseProcessStat(value) {
  const close = value.lastIndexOf(")");
  if (close < 0) throw new Error("invalid owned Chromium process stat record");
  const fields = value.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 20) throw new Error("short owned Chromium process stat record");
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (!Number.isSafeInteger(pgid) || !startTime) throw new Error("invalid owned Chromium process identity");
  return { pgid, startTime };
}

async function hashFileStream(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function captureOwnedChromiumExecutable(context, label, child, expectedPath) {
  assert.equal(process.platform, "linux", "actual ELF provenance requires Linux /proc");
  const record = context.processes.get(label);
  assert.ok(record, "Chromium must be a registered owned RunContext child");
  assert.equal(record.child, child);
  assert.equal(record.pid, child.pid);
  assert.equal(record.pgid, child.pid, "Chromium must own its detached process group");

  const processRoot = `/proc/${child.pid}`;
  const statPath = `${processRoot}/stat`;
  const executablePath = `${processRoot}/exe`;
  const before = parseProcessStat(await readFile(statPath, "utf8"));
  assert.equal(before.pgid, record.pgid, "the inspected PID must still belong to this RunContext process group");
  const linkBefore = await readlink(executablePath);
  assert.ok(!linkBefore.endsWith(" (deleted)"), "owned Chromium executable must not be unlinked during evidence capture");
  const actualPath = resolve(linkBefore);
  assert.equal(actualPath, expectedPath, "owned process leader must execute the resolved Chromium binary");
  const actualSha256 = await hashFileStream(executablePath);
  const linkAfter = await readlink(executablePath);
  const after = parseProcessStat(await readFile(statPath, "utf8"));
  assert.equal(after.pgid, before.pgid, "owned process group changed during executable hashing");
  assert.equal(after.startTime, before.startTime, "owned PID changed during executable hashing");
  assert.equal(linkAfter, linkBefore, "owned executable changed during hashing");

  return {
    pid: child.pid,
    pgid: record.pgid,
    executablePath: actualPath,
    sha256: actualSha256,
    processStartTimeTicks: before.startTime,
  };
}

function fixtureClientScript() {
  return [
    "(() => {",
    "  const scriptPath = new URL(document.currentScript.src).pathname;",
    "  const mountPath = scriptPath.replace(/\\/_expo\\/app\\.js$/, '');",
    "  document.querySelector('#fixture-mount').textContent = mountPath;",
    "  document.querySelector('#fixture-path').textContent = location.pathname;",
    "  document.querySelector('#fixture-kind').textContent = document.body.dataset.fixtureKind;",
    "  const image = document.querySelector('#fixture-image');",
    "  const updateImageState = () => { image.dataset.loaded = String(image.complete && image.naturalWidth > 0); };",
    "  image.addEventListener('load', updateImageState, { once: true });",
    "  image.addEventListener('error', updateImageState, { once: true });",
    "  updateImageState();",
    "  const database = new Promise((resolve, reject) => {",
    "    const request = indexedDB.open('kcoder-mobile-offline-fixture', 1);",
    "    request.onupgradeneeded = () => request.result.createObjectStore('sentinels', { keyPath: 'id' });",
    "    request.onsuccess = () => resolve(request.result);",
    "    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));",
    "  });",
    "  const saveSentinel = value => database.then(db => new Promise((resolve, reject) => {",
    "    const transaction = db.transaction('sentinels', 'readwrite');",
    "    transaction.objectStore('sentinels').put(value);",
    "    transaction.oncomplete = () => resolve(true);",
    "    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));",
    "    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));",
    "  }));",
    "  const readSentinel = id => database.then(db => new Promise((resolve, reject) => {",
    "    const transaction = db.transaction('sentinels', 'readonly');",
    "    const request = transaction.objectStore('sentinels').get(id);",
    "    request.onsuccess = () => resolve(request.result || null);",
    "    request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));",
    "  }));",
    "  const fixture = { saveSentinel, readSentinel, databaseReady: false, apiState: 'pending' };",
    "  window.mobileOfflineFixture = fixture;",
    "  database.then(() => { fixture.databaseReady = true; });",
    "  const gatewayPrefix = mountPath.replace(/\\/mobile$/, '');",
    "  fetch(gatewayPrefix + '/api/cache-probe?probe=mobile-offline-shell', { cache: 'no-store' })",
    "    .then(response => { if (!response.ok) throw new Error('API fixture returned a non-200 response'); return response.json(); })",
    "    .then(result => {",
    "      if (result.source !== 'live-api-fixture') throw new Error('API fixture response identity mismatch');",
    "      fixture.apiState = 'online';",
    "      document.querySelector('#fixture-api').dataset.state = 'online';",
    "      document.querySelector('#fixture-api').textContent = 'live';",
    "    })",
    "    .catch(() => {",
    "      fixture.apiState = 'failed';",
    "      document.querySelector('#fixture-api').dataset.state = 'failed';",
    "      document.querySelector('#fixture-api').textContent = 'unavailable';",
    "    });",
    "})();",
  ].join("\n");
}

function fixtureHtml(kind) {
  return [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<link rel=\"stylesheet\" href=\"" + BASE_TOKEN + "/assets/shell.css\"></head>",
    "<body data-fixture-kind=\"" + kind + "\"><main>",
    "<h1 id=\"fixture-kind\">" + kind + "</h1>",
    "<p>Mount: <output id=\"fixture-mount\"></output></p>",
    "<p>Path: <output id=\"fixture-path\"></output></p>",
    "<p>API: <output id=\"fixture-api\" data-state=\"pending\">pending</output></p>",
    "<img id=\"fixture-image\" data-loaded=\"false\" alt=\"fixture resource\" src=\"" + BASE_TOKEN + "/assets/pixel.svg\">",
    "<script src=\"" + BASE_TOKEN + "/_expo/app.js\"></script></main></body></html>",
  ].join("");
}

async function createFixture(context) {
  const root = context.pathInState("mobile-offline-shell-fixture");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const source = new Map([
    ["index.html", fixtureHtml("home")],
    ["h/[profileId]/index.html", fixtureHtml("profile")],
    ["_expo/app.js", fixtureClientScript()],
    ["assets/shell.css", "html{font-family:Arial,sans-serif}body{background:rgb(1,2,3);color:white}main{padding:12px}img{width:2px;height:2px}"],
    ["assets/pixel.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"2\" height=\"2\"><rect width=\"2\" height=\"2\" fill=\"#00aaff\"/></svg>"],
  ]);
  const rows = [];
  for (const [path, contents] of source) {
    const bytes = Buffer.from(contents, "utf8");
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: 0o600 });
    rows.push({
      path,
      size: bytes.length,
      sha256: sha256(bytes),
      text: true,
      replacements: contents.split(BASE_TOKEN).length - 1,
    });
  }
  const manifest = Buffer.from(JSON.stringify({ version: 1, baseToken: BASE_TOKEN, files: rows }));
  await writeFile(join(root, "kcoder-mobile-web.json"), manifest, { mode: 0o600 });
  return {
    root,
    fileCount: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + row.size, 0),
    manifestSha256: sha256(manifest),
  };
}

function recordNetworkResponses(cdp, origin, rows, failures = []) {
  const pending = new Map();
  cdp.on("Network.requestWillBeSent", event => {
    if (pending.size >= 128) return;
    try {
      const url = new URL(event.request.url);
      if (url.origin === origin) pending.set(event.requestId, { path: url.pathname, responseRow: null });
    } catch {}
  });
  cdp.on("Network.responseReceived", event => {
    let url;
    try {
      url = new URL(event.response.url);
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    const request = pending.get(event.requestId);
    if (!request || rows.length >= 128) return;
    const row = {
      requestId: event.requestId,
      path: url.pathname,
      resourceType: event.type,
      status: event.response.status,
      fromServiceWorker: event.response.fromServiceWorker === true,
      finished: false,
      failureCode: null,
    };
    rows.push(row);
    request.responseRow = row;
  });
  cdp.on("Network.loadingFinished", event => {
    const request = pending.get(event.requestId);
    if (!request) return;
    if (request.responseRow) request.responseRow.finished = true;
    pending.delete(event.requestId);
  });
  cdp.on("Network.loadingFailed", event => {
    const request = pending.get(event.requestId);
    if (!request) return;
    const errorText = typeof event.errorText === "string" ? event.errorText.slice(0, 96) : "unknown";
    if (request.responseRow) request.responseRow.failureCode = errorText;
    if (failures.length < 128) failures.push({ requestId: event.requestId, path: request.path, resourceType: event.type, errorText });
    pending.delete(event.requestId);
  });
}

async function readCompleteCache(page) {
  return page.evaluate(async () => {
    const cacheNames = await caches.keys();
    const results = [];
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      const markerRequest = requests.find(request => new URL(request.url).pathname.includes("/__kcoder_offline_complete__/"));
      if (!markerRequest) continue;
      const markerResponse = await cache.match(markerRequest);
      results.push({
        cacheName,
        scopePath: new URL(markerRequest.url).pathname.split("/__kcoder_offline_complete__/")[0] + "/",
        complete: markerResponse?.ok === true,
        marker: markerResponse ? await markerResponse.json() : null,
        paths: requests.map(request => new URL(request.url).pathname),
      });
    }
    return results;
  });
}

async function waitForFixture(page, apiState) {
  await page.waitForFunction(() => window.mobileOfflineFixture?.databaseReady === true, null, { timeout: 10_000 });
  await page.waitForFunction(expected => document.querySelector("#fixture-api")?.dataset.state === expected, apiState, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector("#fixture-image")?.dataset.loaded === "true", null, { timeout: 10_000 });
}

function processTerminal(child) {
  if (child.exitCode === null && child.signalCode === null) return null;
  return { exitCode: child.exitCode, signalCode: child.signalCode };
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function classifyActivePortContents(buffer) {
  const lines = buffer.toString("utf8").split(/\r?\n/);
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) lines.pop();
  const portLineNumeric = /^\d+$/.test(lines[0] || "");
  const port = portLineNumeric ? Number(lines[0]) : NaN;
  const portInRange = Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
  const websocketPathShapeValid = /^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(lines[1] || "");
  return {
    bytesRead: buffer.length,
    lineCount: lines.length,
    trailingNewline,
    portLinePresent: Boolean(lines[0]),
    portLineNumeric,
    portInRange,
    websocketPathPresent: Boolean(lines[1]),
    websocketPathShapeValid,
    extraLineCount: Math.max(0, lines.length - 2),
    completeFormat: lines.length === 2 && portInRange && websocketPathShapeValid,
  };
}

async function inspectActivePortForDiagnostics(path) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    return { exists: false, metadataErrorCode: error?.code || "UNKNOWN" };
  }
  const mode = before.mode & 0o7777;
  const safe = {
    regularFile: before.isFile() && !before.isSymbolicLink(),
    ownedByCurrentUser: typeof process.getuid !== "function" || before.uid === process.getuid(),
    singleLink: before.nlink === 1,
    permissionsSafe: (mode & 0o022) === 0,
    withinReadLimit: before.size <= 1024,
  };
  const snapshot = {
    exists: true,
    ...safe,
    mode: mode.toString(8).padStart(4, "0"),
    size: before.size,
    linkCount: before.nlink,
    modifiedAt: before.mtime.toISOString(),
    safeToRead: Object.values(safe).every(Boolean),
    identityStable: null,
    format: null,
  };
  if (!snapshot.safeToRead) return snapshot;

  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    snapshot.openErrorCode = error?.code || "UNKNOWN";
    return snapshot;
  }
  try {
    const opened = await file.stat();
    const currentBeforeRead = await lstat(path);
    if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, currentBeforeRead)) {
      snapshot.identityStable = false;
      return snapshot;
    }
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const currentAfterRead = await lstat(path);
    snapshot.identityStable = sameFileIdentity(opened, currentAfterRead);
    if (bytesRead > 1024) {
      snapshot.format = { oversizedWhileReading: true };
      return snapshot;
    }
    if (snapshot.identityStable) snapshot.format = classifyActivePortContents(buffer.subarray(0, bytesRead));
    return snapshot;
  } catch (error) {
    snapshot.readErrorCode = error?.code || "UNKNOWN";
    return snapshot;
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function inspectProfileDirectories(context, profileDirectory) {
  const rows = [
    ["run", context.runRoot],
    ["state", context.stateDir],
    ["chromium-root", dirname(profileDirectory)],
    ["profile", profileDirectory],
  ];
  return Promise.all(rows.map(async ([label, path]) => {
    try {
      const stat = await lstat(path);
      const mode = stat.mode & 0o7777;
      return {
        label,
        exists: true,
        directory: stat.isDirectory() && !stat.isSymbolicLink(),
        ownedByCurrentUser: typeof process.getuid !== "function" || stat.uid === process.getuid(),
        mode: mode.toString(8).padStart(4, "0"),
        groupOrOtherWritable: (mode & 0o022) !== 0,
      };
    } catch (error) {
      return { label, exists: false, errorCode: error?.code || "UNKNOWN" };
    }
  }));
}

function startChromiumStartupMonitor(context, label, profileDirectory) {
  const requestedAt = new Date().toISOString();
  const startedAtMonotonic = performance.now();
  const activePortPath = join(profileDirectory, "DevToolsActivePort");
  const evidence = {
    launchRequestedAt: requestedAt,
    profileRelativeToRunRoot: relative(context.runRoot, profileDirectory),
    ownedProcessFirstObservedAt: null,
    ownedProcess: null,
    activePortFirstObservedAt: null,
    activePortFirstCompleteAt: null,
    activePortLastSnapshot: null,
    pollErrors: [],
  };
  let observing = true;

  const inspect = async () => {
    const record = context.processes.get(label);
    if (record && !evidence.ownedProcessFirstObservedAt) {
      evidence.ownedProcessFirstObservedAt = new Date().toISOString();
      evidence.ownedProcess = { pid: record.pid, pgid: record.pgid, processStartTimeTicks: null };
      if (process.platform === "linux" && Number.isSafeInteger(record.pid) && record.pid > 0) {
        try {
          const identity = parseProcessStat(await readFile(`/proc/${record.pid}/stat`, "utf8"));
          if (identity.pgid === record.pgid) evidence.ownedProcess.processStartTimeTicks = identity.startTime;
        } catch (error) {
          if (!evidence.pollErrors.includes(error?.code || "PROC_STAT_UNAVAILABLE")) {
            evidence.pollErrors.push(error?.code || "PROC_STAT_UNAVAILABLE");
          }
        }
      }
    }
    const activePort = await inspectActivePortForDiagnostics(activePortPath);
    if (activePort.exists) {
      evidence.activePortFirstObservedAt ||= new Date().toISOString();
      evidence.activePortLastSnapshot = activePort;
      if (activePort.format?.completeFormat) evidence.activePortFirstCompleteAt ||= new Date().toISOString();
    }
  };

  const polling = (async () => {
    while (observing) {
      try {
        await inspect();
      } catch (error) {
        const code = error?.code || error?.name || "UNKNOWN";
        if (!evidence.pollErrors.includes(code)) evidence.pollErrors.push(code);
      }
      if (observing) await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
  })();

  return async ({ ready = false, failure = null } = {}) => {
    observing = false;
    await polling;
    try {
      await inspect();
    } catch (error) {
      const code = error?.code || error?.name || "UNKNOWN";
      if (!evidence.pollErrors.includes(code)) evidence.pollErrors.push(code);
    }
    evidence.completedAt = new Date().toISOString();
    evidence.elapsedMs = Math.round(performance.now() - startedAtMonotonic);
    evidence.ready = ready;
    evidence.failureKind = failure
      ? /Timed out waiting for .* CDP endpoint/.test(failure.message || "")
        ? "cdp-endpoint-timeout"
        : /exited before CDP became ready/.test(failure.message || "")
          ? "chromium-exited-before-cdp"
          : "other-startup-failure"
      : null;
    evidence.profileDirectories = await inspectProfileDirectories(context, profileDirectory);
    return evidence;
  };
}

async function startChromiumWithStartupEvidence(context, options) {
  const profileDirectory = context.pathInState("chromium", `${options.profileName}-profile`);
  const finishMonitor = startChromiumStartupMonitor(context, options.label, profileDirectory);
  try {
    const browser = await startChromium(context, options);
    const startup = await finishMonitor({ ready: true });
    startup.browserVersion = browser.browser.version();
    return { browser, startup };
  } catch (error) {
    const startup = await finishMonitor({ failure: error });
    startup.errorChain = summarizeStartupErrorChain(error);
    await context.writeArtifactJson(`${options.label}-startup-diagnostic.json`, startup);
    throw error;
  }
}

const SAFE_ERROR_NAMES = new Set([
  "Error", "AggregateError", "TypeError", "RangeError", "SyntaxError", "TimeoutError", "AbortError", "ProtocolError",
]);
const SAFE_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "ERR_INVALID_URL",
]);

function safeErrorProperty(error, key) {
  try {
    return error?.[key];
  } catch {
    return undefined;
  }
}

function startupErrorPhase(error) {
  const message = safeErrorProperty(error, "message");
  const stack = safeErrorProperty(error, "stack");
  const text = `${typeof message === "string" ? message.slice(0, 4096) : ""}\n${typeof stack === "string" ? stack.slice(0, 4096) : ""}`;
  if (/WebSocketTransport|websocket/i.test(text)) return "websocket-connect";
  if (/SyntaxError|JSON\.parse/i.test(text)) return "discovery-json";
  if (/Unexpected status|urlToWSEndpoint|fetchData|httpRequest/i.test(text)) return "discovery-http";
  if (/Protocol error|CDPConnection|CRBrowser\.connect/i.test(text)) return "cdp-protocol";
  if (/timed? out|timeout|ETIMEDOUT/i.test(text) || safeErrorProperty(error, "name") === "TimeoutError") return "timeout";
  return "unknown";
}

function summarizeStartupErrorChain(rootError) {
  const rows = [];
  const pending = [{ error: rootError, depth: 0 }];
  const seen = new Set();
  while (pending.length && rows.length < 6) {
    const { error, depth } = pending.shift();
    if (!error || (typeof error !== "object" && typeof error !== "function") || seen.has(error)) continue;
    seen.add(error);
    const rawName = safeErrorProperty(error, "name");
    const rawCode = safeErrorProperty(error, "code");
    const rawStatus = safeErrorProperty(error, "statusCode") ?? safeErrorProperty(error, "status");
    const message = safeErrorProperty(error, "message");
    const statusFromMessage = typeof message === "string"
      ? /^Unexpected status ([1-5]\d\d) when connecting\b/.exec(message)?.[1]
      : undefined;

    // Raw messages and stacks may contain URLs or credentials, so persist normalized fields only.
    rows.push({
      phase: startupErrorPhase(error),
      name: SAFE_ERROR_NAMES.has(rawName) ? rawName : "unknown",
      code: SAFE_ERROR_CODES.has(rawCode) ? rawCode : "unknown",
      status: Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
        ? rawStatus
        : statusFromMessage ? Number(statusFromMessage) : null,
    });

    if (depth >= 3) continue;
    const nestedErrors = safeErrorProperty(error, "errors");
    let isErrorList = false;
    try {
      isErrorList = Array.isArray(nestedErrors);
    } catch {
      // Ignore malformed error chains and preserve the original startup failure.
    }
    if (isErrorList) {
      const length = safeErrorProperty(nestedErrors, "length");
      const childLimit = Math.min(Number.isSafeInteger(length) ? length : 0, 6 - rows.length - pending.length);
      for (let index = 0; index < childLimit; index += 1) {
        const nestedError = safeErrorProperty(nestedErrors, index);
        if (nestedError && pending.length + rows.length < 6) pending.push({ error: nestedError, depth: depth + 1 });
      }
    }
    const cause = safeErrorProperty(error, "cause");
    if (cause && pending.length + rows.length < 6) pending.push({ error: cause, depth: depth + 1 });
  }
  return rows;
}

await runE2E(import.meta.url, {
  testId: "mobile-web-offline-shell-browser-preflight",
  tier: "full-integration",
  modelPolicy: "model-independent Chromium mechanism check using a tiny public static fixture through createMobileWebStatic; no Mobile bundle, Gateway, Relay, or external Provider",
  cleanupTimeoutMs: 15_000,
  survivorCheckTimeoutMs: 5_000,
  bodyAbortTimeoutMs: 10_000,
}, async context => {
  const chromiumInputPath = process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium";
  const pinsBefore = await capturePins(chromiumInputPath);
  assert.equal(pinsBefore.mobileStatic.sha256, EXPECTED_MOBILE_STATIC_SHA256, "frozen production Mobile static handler changed");
  assert.equal(pinsBefore.mobileOffline.sha256, EXPECTED_MOBILE_OFFLINE_SHA256, "frozen production Mobile offline helper changed");
  const fixture = await createFixture(context);
  let port = null;
  const httpEvidence = { totalRequests: 0, staticRequests: 0, apiRequests: 0, errors: [] };
  const serveMobile = createMobileWebStatic({
    root: fixture.root,
    publicOrigins: new Set(),
    contentSecurityPolicy: FIXTURE_CSP,
    directPort: () => port,
  });
  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url, "http://" + request.headers.host);
    } catch {
      response.writeHead(400, { "cache-control": "no-store" });
      response.end();
      return;
    }
    httpEvidence.totalRequests += 1;
    if (url.pathname === "/api/cache-probe" && request.method === "GET") {
      httpEvidence.apiRequests += 1;
      const body = Buffer.from(JSON.stringify({ source: "live-api-fixture", ordinal: httpEvidence.apiRequests }));
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-length": body.length,
      });
      response.end(body);
      return;
    }
    httpEvidence.staticRequests += 1;
    serveMobile(request, response, url.pathname).then(handled => {
      if (!handled) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end("Not found");
      }
    }).catch(error => {
      httpEvidence.errors.push(context.redactText(error?.message || String(error)));
      if (!response.headersSent) response.writeHead(500, { "cache-control": "no-store" });
      response.end("Fixture handler failed");
    });
  });
  let fixtureServerClosed = false;
  const closeFixtureServer = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    });
    fixtureServerClosed = true;
  };
  context.addCleanup("close owned Mobile offline fixture HTTP server", closeFixtureServer);
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  port = server.address().port;
  context.registerPort(SERVER_LABEL, port);
  const origin = "http://localhost:" + port;
  const profileId = "offline-" + randomBytes(4).toString("hex");
  const sentinel = {
    id: "sentinel-" + randomBytes(6).toString("hex"),
    marker: "persisted-after-owned-chromium-restart",
  };
  const rootUrl = origin + "/mobile/";
  const dynamicUrl = origin + "/mobile/h/" + profileId;
  const firstResponses = [];
  const firstFailures = [];
  const offlineResponses = [];
  const offlineFailures = [];

  const firstStartup = await startChromiumWithStartupEvidence(context, {
    label: "mobile-offline-shell-first-chromium",
    profileName: PROFILE_NAME,
    startTimeoutMs: 90_000,
  });
  const firstChrome = firstStartup.browser;
  const firstStartupEvidence = firstStartup.startup;
  const firstChild = firstChrome.child;
  const firstExecutable = await captureOwnedChromiumExecutable(
    context,
    "mobile-offline-shell-first-chromium",
    firstChild,
    pinsBefore.chromiumLauncher.resolvedPath,
  );
  const firstBrowserVersion = firstChrome.browser.version();
  const firstPage = await firstChrome.newPersistentPage();
  const firstCdp = await firstPage.context().newCDPSession(firstPage);
  await firstCdp.send("Network.enable");
  await firstCdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  recordNetworkResponses(firstCdp, origin, firstResponses, firstFailures);

  const initialResponse = await firstPage.goto(rootUrl, { waitUntil: "load", timeout: 15_000 });
  assert.equal(initialResponse?.status(), 200, "initial public shell response must be served by the actual static handler");
  const firstHeaders = initialResponse.headers();
  assert.equal(firstHeaders["x-kcoder-mobile-build-sha256"], fixture.manifestSha256);
  await waitForFixture(firstPage, "online");
  assert.equal(await firstPage.locator("#fixture-kind").innerText(), "home");
  assert.equal(await firstPage.locator("#fixture-mount").innerText(), "/mobile");
  assert.equal(await firstPage.locator("body").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(1, 2, 3)");
  await firstPage.waitForFunction(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const registration = await navigator.serviceWorker.getRegistration("/mobile/");
    return registration?.active?.state === "activated";
  }, null, { timeout: 10_000 });
  const firstCacheEvidence = {
    ...(await firstPage.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return {
        secureContext: window.isSecureContext,
        serviceWorkerSupported: "serviceWorker" in navigator,
        registrationActive: registration.active?.state === "activated",
        scope: registration.scope,
      };
    })),
    cachesWithMarker: await readCompleteCache(firstPage),
  };
  assert.equal(firstCacheEvidence.secureContext, true, "localhost must be a secure browser context");
  assert.equal(firstCacheEvidence.serviceWorkerSupported, true);
  assert.equal(firstCacheEvidence.registrationActive, true);
  assert.equal(firstCacheEvidence.scope, origin + "/mobile/");
  assert.equal(firstCacheEvidence.cachesWithMarker.length, 1, "the direct mount must install one complete cache");
  const firstCache = firstCacheEvidence.cachesWithMarker[0];
  assert.equal(firstCache.complete, true);
  assert.equal(firstCache.marker.manifestSha256, fixture.manifestSha256);
  assert.ok(firstCache.paths.some(path => path.endsWith("/h/%5BprofileId%5D/index.html")), "the dynamic page template must be in the complete cache");

  await firstPage.evaluate(value => window.mobileOfflineFixture.saveSentinel(value), sentinel);
  assert.equal(httpEvidence.apiRequests, 1, "online API probe must reach the owned API fixture exactly once");
  await firstCdp.detach();
  await firstChrome.close();
  const firstExit = await waitFor(() => processTerminal(firstChild), 5_000, "first owned Chromium process exit", 50, context.abortSignal);
  assert.ok(context.processes.get("mobile-offline-shell-first-chromium")?.stopped, "first owned Chromium process group must be marked stopped");
  await closeFixtureServer();
  assert.equal(fixtureServerClosed, true, "owned fixture server must be closed before the restarted browser can load a prior page");

  const secondStartup = await startChromiumWithStartupEvidence(context, {
    label: "mobile-offline-shell-restarted-chromium",
    profileName: PROFILE_NAME,
    startTimeoutMs: 60_000,
  });
  const secondChrome = secondStartup.browser;
  const secondStartupEvidence = secondStartup.startup;
  const secondChild = secondChrome.child;
  const secondExecutable = await captureOwnedChromiumExecutable(
    context,
    "mobile-offline-shell-restarted-chromium",
    secondChild,
    pinsBefore.chromiumLauncher.resolvedPath,
  );
  const secondBrowserVersion = secondChrome.browser.version();
  assert.equal(secondExecutable.sha256, firstExecutable.sha256, "both owned Chromium launches must use the same actual ELF");
  assert.equal(secondBrowserVersion, firstBrowserVersion, "both owned Chromium launches must report the same browser version");
  const secondPage = await secondChrome.newPersistentPage();
  const secondCdp = await secondPage.context().newCDPSession(secondPage);
  await secondCdp.send("Network.enable");
  await secondCdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  recordNetworkResponses(secondCdp, origin, offlineResponses, offlineFailures);
  await secondPage.context().setOffline(true);
  const requestCountBeforeOfflineNavigation = httpEvidence.totalRequests;

  const offlineRootResponse = await secondPage.goto(rootUrl, { waitUntil: "load", timeout: 15_000 });
  assert.equal(offlineRootResponse?.status(), 200, "offline root navigation must be served from the service worker");
  await waitForFixture(secondPage, "failed");
  assert.equal(await secondPage.locator("#fixture-kind").innerText(), "home");
  assert.equal(await secondPage.locator("#fixture-mount").innerText(), "/mobile");
  assert.equal(await secondPage.locator("body").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(1, 2, 3)");
  const offlineRootSentinel = await secondPage.evaluate(id => window.mobileOfflineFixture.readSentinel(id), sentinel.id);
  assert.deepEqual(offlineRootSentinel, sentinel, "IndexedDB sentinel must persist after the owned browser process exits");
  const offlineRootFromServiceWorker = offlineResponses.some(row => row.path === "/mobile/" && row.resourceType === "Document" && row.fromServiceWorker);
  await context.writeArtifactJson("mobile-web-offline-shell-root-checkpoint.json", {
    sourcePins: pinsBefore,
    rootStatus: offlineRootResponse?.status() ?? null,
    rootFromServiceWorker: offlineRootFromServiceWorker,
    idbSentinelReadable: true,
  });

  let offlineDynamicResponse;
  try {
    offlineDynamicResponse = await secondPage.goto(dynamicUrl, { waitUntil: "load", timeout: 15_000 });
  } catch (navigationError) {
    let timer;
    const navigationState = await Promise.race([
      secondPage.evaluate(() => ({ readyState: document.readyState, path: location.pathname })).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 2_000); }),
    ]);
    clearTimeout(timer);
    await context.writeArtifactJson("mobile-web-offline-shell-dynamic-navigation-failure.json", {
      stage: "offline-dynamic-navigation",
      errorName: navigationError instanceof Error ? navigationError.name : "Error",
      navigationState,
      rootStatus: offlineRootResponse?.status() ?? null,
      rootFromServiceWorker: offlineRootFromServiceWorker,
      idbSentinelReadable: true,
      firstResponses,
      firstFailures,
      offlineResponses,
      offlineFailures,
    }).catch(() => undefined);
    throw navigationError;
  }
  assert.equal(offlineDynamicResponse?.status(), 200, "offline dynamic route navigation must be served from the service worker");
  await waitForFixture(secondPage, "failed");
  assert.equal(await secondPage.locator("#fixture-kind").innerText(), "profile");
  assert.equal(await secondPage.locator("#fixture-mount").innerText(), "/mobile");
  assert.equal(await secondPage.locator("#fixture-path").innerText(), "/mobile/h/" + profileId);
  assert.equal(await secondPage.locator("body").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(1, 2, 3)");
  const offlineDynamicSentinel = await secondPage.evaluate(id => window.mobileOfflineFixture.readSentinel(id), sentinel.id);
  assert.deepEqual(offlineDynamicSentinel, sentinel, "IndexedDB sentinel must remain readable on the offline dynamic route");
  assert.equal(httpEvidence.totalRequests, requestCountBeforeOfflineNavigation, "offline navigations and API probes must make no HTTP requests");
  assert.equal(httpEvidence.apiRequests, 1, "offline API fetch must not be replayed from a service-worker cache");

  await waitFor(() => offlineResponses.some(row => row.path === "/mobile/" && row.resourceType === "Document" && row.fromServiceWorker), 5_000, "offline root response from service worker", 50, context.abortSignal);
  await waitFor(() => offlineResponses.some(row => row.path === "/mobile/h/" + profileId && row.resourceType === "Document" && row.fromServiceWorker), 5_000, "offline dynamic response from service worker", 50, context.abortSignal);
  for (const path of ["/mobile/_expo/app.js", "/mobile/assets/shell.css", "/mobile/assets/pixel.svg"]) {
    assert.ok(offlineResponses.some(row => row.path === path && row.fromServiceWorker), "offline static resource must come from service worker: " + path);
  }
  assert.ok(httpEvidence.errors.length === 0, "fixture server must not report handler errors");

  const secondCacheEvidence = await readCompleteCache(secondPage);
  assert.equal(secondCacheEvidence.length, 1);
  assert.equal(secondCacheEvidence[0].complete, true);
  assert.equal(secondCacheEvidence[0].marker.manifestSha256, fixture.manifestSha256);
  await secondCdp.detach();
  await secondChrome.close();
  const secondExit = await waitFor(() => processTerminal(secondChild), 5_000, "restarted owned Chromium process exit", 50, context.abortSignal);
  assert.ok(context.processes.get("mobile-offline-shell-restarted-chromium")?.stopped, "restarted Chromium process group must be marked stopped");
  await closeFixtureServer();
  assert.equal(fixtureServerClosed, true, "owned fixture HTTP server must be closed before completion");

  const pinsAfter = await capturePins(chromiumInputPath);
  assert.deepEqual(pinsAfter, pinsBefore, "pinned production sources, harness, RunContext, and Chromium binary must remain unchanged");
  const evidence = {
    boundary: "real Chromium service-worker and IndexedDB mechanism using the production createMobileWebStatic handler with a generated public fixture; no Mobile bundle, Gateway process, Relay process, or product UX claim",
    runContextRoot: context.runRoot,
    sourcePins: { before: pinsBefore, after: pinsAfter },
    fixture: {
      fileCount: fixture.fileCount,
      totalBytes: fixture.totalBytes,
      manifestSha256: fixture.manifestSha256,
      initialHandlerBuildDigest: firstHeaders["x-kcoder-mobile-build-sha256"],
    },
    origin: origin,
    profileName: PROFILE_NAME,
    firstChromium: {
      pid: firstChild.pid,
      pgid: context.processes.get("mobile-offline-shell-first-chromium").pgid,
      browserVersion: firstBrowserVersion,
      actualExecutable: firstExecutable,
      startup: firstStartupEvidence,
      exitCode: firstExit.exitCode,
      signalCode: firstExit.signalCode,
      processGroupStopped: true,
      serviceWorkerScope: firstCacheEvidence.scope,
      completedCache: firstCache,
      onlineApiRequestCount: 1,
    },
    restartedChromium: {
      pid: secondChild.pid,
      pgid: context.processes.get("mobile-offline-shell-restarted-chromium").pgid,
      browserVersion: secondBrowserVersion,
      actualExecutable: secondExecutable,
      startup: secondStartupEvidence,
      exitCode: secondExit.exitCode,
      signalCode: secondExit.signalCode,
      processGroupStopped: true,
      offline: true,
      httpCacheDisabled: true,
      completedCache: secondCacheEvidence[0],
      indexedDbSentinelReadableOnRootAndDynamicRoute: true,
      apiFetchFailedWithoutServerReachability: true,
      httpRequestCountBeforeOffline: requestCountBeforeOfflineNavigation,
      httpRequestCountAfterOffline: httpEvidence.totalRequests,
      serviceWorkerResponses: offlineResponses,
      offlineRequestFailures: offlineFailures,
    },
    cleanup: {
      fixtureServerOwnedPort: port,
      fixtureServerClosed: fixtureServerClosed,
      fixtureServerErrors: httpEvidence.errors.length,
      chromiumProcessesStopped: true,
    },
    limitations: [
      "This checks only the real production static handler, generated service worker, browser CacheStorage, and origin IndexedDB.",
      "It does not prove Mobile UI behavior, a full Gateway or Relay process, public-network behavior, Android, iOS, or device acceptance.",
      "The direct /mobile mount does not test Relay HMAC mount separation; add that only after this bounded direct run is reviewed.",
    ],
  };
  await context.writeArtifactJson("mobile-web-offline-shell-browser-evidence.json", evidence);
  return evidence;
});
