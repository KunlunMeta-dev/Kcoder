// Full Mobile Web/AppContext cross-tab review against an immutable candidate
// and its already-exported Web bundle. Synthetic credentials only;
// the Gateway runs KCODER_STUDIO_MOCK=1 and never starts a Provider.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "../renderer/node_modules/@playwright/test/index.mjs";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const defaultCandidateLabel = "2050";
const candidateLabel = (process.env.PHONE_AUTH_CANDIDATE_LABEL || defaultCandidateLabel).replace(/[^A-Za-z0-9._-]/g, "_");
const candidateRoot = process.env.PHONE_AUTH_CANDIDATE_ROOT || join(repoRoot, "target/private-phone-latency-implementation/after-final-mobile-gateway-20261007-2050");
const expectedCandidateDigest = process.env.PHONE_AUTH_CANDIDATE_DIGEST || null;
const expectedCandidateFiles = process.env.PHONE_AUTH_CANDIDATE_COUNT ? Number(process.env.PHONE_AUTH_CANDIDATE_COUNT) : null;
let candidateDigest = null;
let candidateFiles = null;
const evidenceRoot = process.env.PHONE_AUTH_EVIDENCE_DIR || join(repoRoot, "target/private-phone-ux-implementation");
const exportRoot = process.env.PHONE_AUTH_WEB_ROOT || join(evidenceRoot, `mobile-web-export-${candidateLabel}`);
const exportManifestPath = process.env.PHONE_AUTH_WEB_MANIFEST || join(evidenceRoot, `mobile-web-export-${candidateLabel}-manifest.json`);
const exportProvenancePath = process.env.PHONE_AUTH_WEB_PROVENANCE || join(evidenceRoot, `mobile-web-export-${candidateLabel}-provenance.json`);
const evidencePath = join(evidenceRoot, `mobile-device-auth-full-ui-${candidateLabel}-review.json`);
const screenshotAPath = join(evidenceRoot, `mobile-device-auth-full-ui-${candidateLabel}-tab-a-final.png`);
const screenshotBPath = join(evidenceRoot, `mobile-device-auth-full-ui-${candidateLabel}-tab-b-final.png`);
const failureScreenshotAPath = join(evidenceRoot, `mobile-device-auth-full-ui-${candidateLabel}-failure-tab-a.png`);
const failureScreenshotBPath = join(evidenceRoot, `mobile-device-auth-full-ui-${candidateLabel}-failure-tab-b.png`);
const apiRecords = [];
const pageErrors = [];
let sensitiveValues = [];

function credential() { return randomBytes(32).toString("hex"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function publicPath(url) { try { return new URL(url).pathname; } catch { return "<invalid-url>"; } }
function scrub(value) {
  let output = String(value);
  for (const secret of sensitiveValues) if (secret) output = output.split(secret).join("[redacted]");
  return output.replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[redacted]").replace(/\b[a-f0-9]{64}\b/gi, "[credential-redacted]");
}

async function verifyFrozenCandidate() {
  assert.ok(candidateRoot, "frozen candidate root is required");
  const metadata = JSON.parse(await readFile(join(candidateRoot, "metadata.json"), "utf8"));
  assert.match(metadata.sourceDigest, /^[0-9a-f]{64}$/);
  if (expectedCandidateDigest) assert.equal(metadata.sourceDigest, expectedCandidateDigest);
  if (expectedCandidateFiles !== null) assert.equal(metadata.files, expectedCandidateFiles);
  const manifest = JSON.parse(await readFile(join(candidateRoot, "sha256.json"), "utf8"));
  assert.equal(Object.keys(manifest).length, metadata.files);
  candidateDigest = metadata.sourceDigest;
  candidateFiles = metadata.files;
  for (const [name, expected] of Object.entries(manifest)) {
    assert.equal(sha256(await readFile(join(candidateRoot, name))), expected, `frozen candidate hash mismatch: ${name}`);
  }
}

async function verifyExport() {
  const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  const provenance = JSON.parse(await readFile(exportProvenancePath, "utf8"));
  assert.equal(provenance.status, "complete");
  assert.equal(provenance.candidateDigest, candidateDigest);
  assert.equal(provenance.bundlePath, exportRoot);
  assert.equal(provenance.bundleFileCount, manifest.bundleFileCount);
  assert.equal(manifest.bundleFiles.length, manifest.bundleFileCount);
  const actualFiles = [];
  async function walk(directory) {
    for (const entry of await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) actualFiles.push(path);
      else assert.fail(`unexpected non-file export entry: ${relative(exportRoot, path)}`);
    }
  }
  await walk(exportRoot);
  assert.equal(actualFiles.length, manifest.bundleFileCount);
  const files = [];
  for (const file of actualFiles) {
    const path = relative(exportRoot, file).split(sep).join("/");
    const digest = sha256(await readFile(file));
    const record = manifest.bundleFiles.find(item => item.path === path);
    assert.ok(record, `unmanifested web export file: ${path}`);
    assert.equal(digest, record.sha256, `web export hash mismatch: ${path}`);
    files.push({ path, sha256: digest });
  }
  return { bundleSha256: provenance.bundleSha256, bundleFileCount: files.length, indexHtmlSha256: provenance.indexHtmlSha256, files };
}

async function stageCandidateRuntime(root) {
  const source = join(candidateRoot, "apps/kcoder-studio");
  const target = join(root, "apps/kcoder-studio");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await Promise.all([
    cp(join(source, "dev-server.mjs"), join(target, "dev-server.mjs")),
    cp(join(source, "package.json"), join(target, "package.json")),
    cp(join(source, "src"), join(target, "src"), { recursive: true }),
    cp(join(source, "shared"), join(target, "shared"), { recursive: true }),
    symlink(join(repoRoot, "apps/kcoder-studio/node_modules"), join(target, "node_modules"), "dir"),
  ]);
  return target;
}

function mime(path) {
  return ({
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  })[extname(path).toLowerCase()] || "application/octet-stream";
}

async function startStaticWeb(root) {
  const rootReal = await realpath(root);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      let relativePath = decoded.replace(/^\/+/, "");
      let path = resolve(rootReal, relativePath || "index.html");
      if (path !== rootReal && !path.startsWith(rootReal + sep)) {
        response.writeHead(400); response.end(); return;
      }
      let info = await stat(path).catch(() => null);
      if (!info && !extname(path)) {
        const htmlPath = `${path}.html`;
        const htmlInfo = await stat(htmlPath).catch(() => null);
        if (htmlInfo?.isFile()) { path = htmlPath; info = htmlInfo; }
      }
      if (!info && /^\/h\/[^/]+(?:\/|$)/.test(decoded)) {
        path = resolve(rootReal, "h/[profileId]/index.html");
        info = await stat(path).catch(() => null);
      }
      if (info?.isDirectory()) {
        path = join(path, "index.html");
        info = await stat(path).catch(() => null);
      }
      if (!info?.isFile()) {
        path = join(rootReal, "index.html");
        info = await stat(path).catch(() => null);
      }
      if (!info?.isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-type": mime(path), "cache-control": "no-store", "x-content-type-options": "nosniff" });
      const { createReadStream } = await import("node:fs");
      createReadStream(path).pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}

async function startGateway(root, studioRoot, webOrigin, authToken) {
  const home = join(root, "home");
  const config = join(home, "config");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(config, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
  ]);
  const serversStore = join(config, "servers.json");
  await writeFile(serversStore, JSON.stringify([
    { id: "local", label: "Synthetic UI Gateway", runtime: "kcoder", transport: "local", workspace },
  ]), { mode: 0o600 });
  const child = spawn(process.execPath, ["dev-server.mjs"], {
    cwd: studioRoot,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), LANG: "C.UTF-8",
      KCODER_CONFIG_DIR: config, KCODER_STUDIO_HOST: "127.0.0.1", KCODER_STUDIO_PORT: "0",
      KCODER_STUDIO_AUTH_TOKEN: authToken, KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: "600000",
      KCODER_STUDIO_MOBILE_SOCKET_GRACE_MS: "1000", KCODER_STUDIO_MOBILE_WEB_ORIGINS: webOrigin,
      KCODER_STUDIO_ALLOWED_HOSTS: "127.0.0.1,localhost", KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_WORKSPACE: workspace, KCODER_STUDIO_SERVERS_STORE: serversStore,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => { resolveReady = resolvePromise; rejectReady = rejectPromise; });
  const timer = setTimeout(() => {
    if (!settled) { settled = true; rejectReady(new Error("isolated UI Gateway startup timed out")); }
  }, 10_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    output = (output + chunk).slice(-4096);
    const match = output.match(/KCoder Studio: http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && !settled) { settled = true; clearTimeout(timer); resolveReady(Number(match[1])); }
  });
  child.stderr.on("data", () => {});
  child.once("error", () => { if (!settled) { settled = true; clearTimeout(timer); rejectReady(new Error("isolated UI Gateway failed to start")); } });
  child.once("exit", () => { if (!settled) { settled = true; clearTimeout(timer); rejectReady(new Error("isolated UI Gateway exited early")); } });
  const port = await ready;
  return {
    child,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit").catch(() => {});
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise(resolveDone => setTimeout(resolveDone, 2_000))]);
      if (child.exitCode === null && child.signalCode === null) {
        const killed = once(child, "exit").catch(() => {});
        child.kill("SIGKILL");
        await Promise.race([killed, new Promise(resolveDone => setTimeout(resolveDone, 1_000))]);
      }
    },
  };
}

function attachRequestRecords(page, label) {
  page.on("request", request => {
    const path = publicPath(request.url());
    if (path.startsWith("/api/")) apiRecords.push({ page: label, method: request.method(), path, event: "request" });
  });
  page.on("response", response => {
    const path = publicPath(response.url());
    if (path.startsWith("/api/")) apiRecords.push({ page: label, method: response.request().method(), path, event: "response", status: response.status() });
  });
  page.on("requestfailed", request => {
    const path = publicPath(request.url());
    if (path.startsWith("/api/")) apiRecords.push({ page: label, method: request.method(), path, event: "failed", error: scrub(request.failure()?.errorText || "unknown") });
  });
  page.on("pageerror", error => pageErrors.push({ page: label, name: error.name, message: scrub(error.message).slice(0, 300) }));
}

async function waitForProfile(page) {
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2");
    if (!raw) return false;
    const value = JSON.parse(raw);
    return value.profiles?.length === 1 && value.activeId === value.profiles[0].id;
  }, null, { timeout: 30_000 });
  return await page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2"));
    const profile = value.profiles[0];
    return {
      id: profile.id,
      label: profile.label,
      baseUrl: profile.baseUrl,
      authMode: profile.authMode,
      deviceId: profile.deviceId,
      authorizationGeneration: profile.authorizationGeneration,
      expiresAt: profile.expiresAt,
      accessTtlMs: profile.accessTtlMs,
      secretFieldsInIndex: ["accessToken", "refreshToken", "rpcToken", "pendingRotationId"].filter(key => key in profile),
      secretRecordKeyPresent: typeof profile.secretKey === "string",
      active: value.activeId === profile.id,
    };
  });
}

function captureDevicePair(page) {
  let settle;
  const promise = new Promise(resolvePair => { settle = resolvePair; });
  page.on("response", async response => {
    if (response.request().method() !== "POST" || publicPath(response.url()) !== "/api/mobile/session" || response.status() !== 200) return;
    try {
      const payload = await response.json();
      if (typeof payload.deviceId !== "string" || typeof payload.authorizationGeneration !== "string" || typeof payload.refreshToken !== "string") return;
      sensitiveValues.push(payload.accessToken, payload.rpcToken, payload.refreshToken);
      settle({
        deviceId: payload.deviceId,
        authorizationGeneration: payload.authorizationGeneration,
        expiresAt: payload.expiresAt,
        refreshTokenSha256: sha256(payload.refreshToken),
      });
    } catch { /* Synthetic credentials stay in memory; evidence contains hashes or booleans only. */ }
  });
  return promise;
}

async function readDeviceSecretSummary(page, expectedRefreshTokenSha256) {
  return page.evaluate(async expectedHash => {
    const index = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") || "{\"profiles\":[]}");
    const profile = index.profiles?.[0];
    if (!profile) return null;
    let secret;
    try { secret = JSON.parse(localStorage.getItem(profile.secretKey) || "null"); } catch { secret = null; }
    const hash = async value => {
      if (typeof value !== "string" || !globalThis.crypto?.subtle) return null;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    };
    return {
      id: profile.id,
      deviceId: profile.deviceId,
      authorizationGeneration: profile.authorizationGeneration,
      expiresAt: profile.expiresAt,
      active: index.activeId === profile.id,
      secretScopeMatchesProfile: Boolean(secret && secret.profileId === profile.id && secret.baseUrl === profile.baseUrl && secret.deviceId === profile.deviceId && secret.authorizationGeneration === profile.authorizationGeneration),
      accessTokenPresent: typeof secret?.accessToken === "string" && secret.accessToken.length > 0,
      rpcTokenPresent: typeof secret?.rpcToken === "string" && secret.rpcToken.length > 0,
      refreshTokenPresent: typeof secret?.refreshToken === "string" && secret.refreshToken.length > 0,
      refreshTokenMatchesExpected: expectedHash ? await hash(secret?.refreshToken) === expectedHash : false,
    };
  }, expectedRefreshTokenSha256);
}

async function waitForDeviceSecretSummary(page, expected, timeout = 15_000) {
  await page.waitForFunction(async target => {
    const index = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") || "{\"profiles\":[]}");
    const profile = index.profiles?.find(item => item.id === target.id);
    if (!profile || index.activeId !== target.id || profile.deviceId !== target.deviceId || profile.authorizationGeneration !== target.authorizationGeneration || profile.expiresAt < target.minimumExpiresAt) return false;
    let secret;
    try { secret = JSON.parse(localStorage.getItem(profile.secretKey) || "null"); } catch { return false; }
    if (!secret || secret.profileId !== profile.id || secret.baseUrl !== profile.baseUrl || secret.deviceId !== profile.deviceId || secret.authorizationGeneration !== profile.authorizationGeneration) return false;
    if (typeof secret.accessToken !== "string" || typeof secret.rpcToken !== "string" || typeof secret.refreshToken !== "string" || !globalThis.crypto?.subtle) return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret.refreshToken));
    const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return actual === target.refreshTokenSha256;
  }, expected, { timeout });
  return readDeviceSecretSummary(page, expected.refreshTokenSha256);
}

function reviewDeferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function reviewWithTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function pair(page, webOrigin, gatewayOrigin, token, waitForRuntime = true) {
  await page.goto(`${webOrigin.replace(/\/$/, "")}/welcome?gateway=${encodeURIComponent(gatewayOrigin)}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("gateway-endpoint").fill(gatewayOrigin);
  await page.getByTestId("gateway-token").fill(token);
  await page.getByTestId("gateway-connect").click();
  await page.waitForURL(/\/h\/[^/?#]+(?:\/|$)/, { timeout: 30_000 });
  if (waitForRuntime) {
    await page.getByText("Synthetic UI Gateway", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="online"]').length > 0, null, { timeout: 30_000 });
  }
}

test(`${candidateLabel} full Mobile Web two-tab AppContext, auth generation swap and removal review`, { timeout: 120_000 }, async t => {
  await verifyFrozenCandidate();
  const exported = await verifyExport();
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const tempRoot = await mkdtemp(join(tmpdir(), "kcoder-device-auth-full-ui-review-"));
  let gateway;
  let site;
  let browser;
  let browserServer;
  let browserContext;
  let releaseTabBServers;
  let pageA;
  let pageB;
  let currentStage = "fixture-startup";
  let failure = null;
  const authToken = credential();
  sensitiveValues = [authToken];
  const scenario = {
    status: "in-progress",
    candidateLabel,
    candidateRoot,
    candidateDigest,
    candidateFiles,
    webBundleSha256: exported.bundleSha256,
    webBundleFileCount: exported.bundleFileCount,
    browserEngine: "system Chromium; mobile emulation; two pages share one browser context/origin/localStorage/Web Locks",
    fixture: "candidate Gateway KCODER_STUDIO_MOCK=1; synthetic target and credentials; no Engine/Provider/user session",
    scenarios: [],
    apiRecords,
    pageErrors,
    credentialsRecorded: false,
    testRunnerPid: process.pid,
    ownedRuntimePids: {},
  };
  try {
    const studioRoot = await stageCandidateRuntime(tempRoot);
    site = await startStaticWeb(exportRoot);
    gateway = await startGateway(tempRoot, studioRoot, site.origin, authToken);
    browserServer = await chromium.launchServer({ headless: true, executablePath: process.env.KCODER_E2E_CHROMIUM_BIN || process.env.KCODER_STUDIO_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    scenario.ownedRuntimePids = {
      gateway: gateway.child.pid,
      chromium: browserServer.process().pid,
    };
    browser = await chromium.connect(browserServer.wsEndpoint());
    browserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await browserContext.addInitScript(() => {
      const key = "kcoder-studio-mobile.gateway-profiles.v2";
      window.__deviceAuthReviewStorage = [];
      window.addEventListener("storage", event => {
        if (event.key === key || event.key === null) window.__deviceAuthReviewStorage.push({ key: event.key, oldLength: event.oldValue?.length ?? 0, newLength: event.newValue?.length ?? 0 });
      });
    });
    pageA = await browserContext.newPage();
    pageB = await browserContext.newPage();
    attachRequestRecords(pageA, "tab-a");
    attachRequestRecords(pageB, "tab-b");
    const pageAAccessTokens = [];
    let resolvePageAPairToken;
    const pageAPairTokenReady = new Promise(resolveToken => { resolvePageAPairToken = resolveToken; });
    pageA.on("response", async response => {
      if (response.request().method() !== "POST" || publicPath(response.url()) !== "/api/mobile/session" || response.status() !== 200) return;
      try {
        const payload = await response.json();
        if (typeof payload.accessToken === "string") {
          pageAAccessTokens.push(payload.accessToken);
          sensitiveValues.push(payload.accessToken);
          resolvePageAPairToken(payload.accessToken);
        }
      } catch { /* The product fetch owns its response; evidence only reads the synthetic response body. */ }
    });
    const pageBAccessTokens = [];
    let resolvePageBPairToken;
    const pageBPairTokenReady = new Promise(resolveToken => { resolvePageBPairToken = resolveToken; });
    pageB.on("response", async response => {
      if (response.request().method() !== "POST" || publicPath(response.url()) !== "/api/mobile/session" || response.status() !== 200) return;
      try {
        const payload = await response.json();
        if (typeof payload.accessToken === "string") {
          pageBAccessTokens.push(payload.accessToken);
          sensitiveValues.push(payload.accessToken);
          resolvePageBPairToken(payload.accessToken);
        }
      } catch { /* Keep synthetic credentials in memory; evidence only stores match booleans. */ }
    });

    let holdNextServers = true;
    let heldServerRoute;
    let signalHeld;
    const held = new Promise(resolveHeld => { signalHeld = resolveHeld; });
    let releaseHeld;
    const release = new Promise(resolveRelease => { releaseHeld = resolveRelease; });
    let oldBearerMatched = false;
    await pageA.route("**/api/servers", async route => {
      if (!holdNextServers || heldServerRoute) { await route.continue(); return; }
      holdNextServers = false;
      heldServerRoute = route;
      const authorization = route.request().headers()["authorization"] || "";
      const pairedToken = await pageAPairTokenReady;
      oldBearerMatched = authorization === `Bearer ${pairedToken}`;
      signalHeld();
      await release;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ servers: [{ id: "local", label: "STALE_OLD_ACCOUNT_RESPONSE_SENTINEL", runtime: "kcoder", transport: "local", workspacePath: "/synthetic/old-account" }] }),
      });
    });
    currentStage = "initial-pair-and-old-servers-hold";
    await pair(pageA, site.origin, gateway.origin, authToken, false);
    await Promise.race([held, pageA.waitForTimeout(30_000).then(() => { throw new Error("old-generation servers request was not held"); })]);
    const initial = await waitForProfile(pageA);
    assert.equal(initial.authMode, "device", "supported Gateway exposes durable device authorization in the actual Web export");
    assert.deepEqual(initial.secretFieldsInIndex, [], "profile index contains no bearer/refresh/RPC/pending secret fields");
    assert.equal(initial.secretRecordKeyPresent, true, "Web credentials are stored behind a separate immutable secret record key");
    const cookiesAfterPair = await browserContext.cookies(gateway.origin);
    const visibleCookieNames = cookiesAfterPair.map(cookie => cookie.name);
    assert.equal((await pageA.evaluate(() => document.cookie)).includes("kcoder_studio_session"), false, "mobile browser JS does not receive a pairing auth cookie");

    await pageB.goto(site.origin, { waitUntil: "domcontentloaded" });
    await pageB.getByText("Synthetic UI Gateway", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await pageB.waitForURL(new RegExp(`/h/${initial.id}(?:/|$)`), { timeout: 30_000 });
    const sharedFromB = await waitForProfile(pageB);
    assert.equal(sharedFromB.deviceId, initial.deviceId, "second actual page hydrates the same persisted device grant");
    assert.equal(sharedFromB.authorizationGeneration, initial.authorizationGeneration);
    assert.equal(await pageA.evaluate(() => window.isSecureContext && typeof navigator.locks?.request === "function"), true, "Chromium exposes origin-scoped Web Locks to the actual Mobile Web app");
    await pageA.evaluate(() => localStorage.setItem("__device_auth_review_shared_probe", "same-origin"));
    assert.equal(await pageB.evaluate(() => localStorage.getItem("__device_auth_review_shared_probe")), "same-origin", "two actual app pages share one origin's LocalStorage");
    await pageA.evaluate(() => localStorage.removeItem("__device_auth_review_shared_probe"));
    await pageB.getByText("Synthetic UI Gateway", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await pageB.waitForFunction(() => document.querySelectorAll('[aria-label="online"]').length > 0, null, { timeout: 30_000 });
    assert.equal(oldBearerMatched, true, "delayed response belongs to an authenticated old-generation request");

    currentStage = "same-route-repair-with-new-authorization-generation";
    const indexBefore = await waitForProfile(pageB);
    await pageB.goto(`${site.origin}/welcome?gateway=${encodeURIComponent(gateway.origin)}&reauth=${encodeURIComponent(indexBefore.id)}`, { waitUntil: "domcontentloaded" });
    await pageB.getByTestId("gateway-endpoint").waitFor({ state: "visible", timeout: 30_000 });
    await pageB.getByTestId("gateway-endpoint").fill(gateway.origin);
    await pageB.getByTestId("gateway-token").fill(authToken);
    let captureNextTabBServersRequest = false;
    let heldTabBServersRoute;
    let resolveHeldTabBServers;
    const heldTabBServers = new Promise(resolveHeld => { resolveHeldTabBServers = resolveHeld; });
    const tabBServersRelease = new Promise(resolveRelease => { releaseTabBServers = resolveRelease; });
    let replacementBearer = "";
    let replacementBearerMatched = false;
    await pageB.route("**/api/servers", async route => {
      if (!captureNextTabBServersRequest || heldTabBServersRoute) { await route.continue(); return; }
      captureNextTabBServersRequest = false;
      heldTabBServersRoute = route;
      replacementBearer = route.request().headers()["authorization"] || "";
      const pairedToken = await pageBPairTokenReady;
      replacementBearerMatched = replacementBearer === `Bearer ${pairedToken}`;
      resolveHeldTabBServers();
      await tabBServersRelease;
      await route.continue();
    });
    captureNextTabBServersRequest = true;
    await pageB.getByTestId("gateway-connect").click();
    await pageB.waitForURL(new RegExp(`/h/${indexBefore.id}(?:/|$)`), { timeout: 30_000 });
    await Promise.race([heldTabBServers, pageB.waitForTimeout(30_000).then(() => { throw new Error("replacement AppContext servers request was not held"); })]);
    const replacement = await waitForProfile(pageB);
    assert.equal(replacement.id, indexBefore.id, "same full Gateway route replaces the profile projection in place");
    assert.equal(replacement.baseUrl, indexBefore.baseUrl, "the re-pair targets the identical normalized Gateway route");
    assert.notEqual(replacement.deviceId, indexBefore.deviceId, "re-pair represents a distinct synthetic device authorization");
    assert.notEqual(replacement.authorizationGeneration, indexBefore.authorizationGeneration, "re-pair changes the identity generation");
    assert.deepEqual(replacement.secretFieldsInIndex, [], "replacement profile index still contains no secret material");
    await pageBPairTokenReady;
    assert.equal(replacementBearerMatched, true, "the new AppContext /api/servers request carries the access token returned by the re-pair flow");
    const replacementProjectionBeforeResponse = await pageB.getByText("Synthetic UI Gateway", { exact: true }).count();
    assert.equal(replacementProjectionBeforeResponse, 0, "old server projection is cleared while the new-generation request is still pending");
    releaseTabBServers();
    await pageB.getByText("Synthetic UI Gateway", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await pageB.waitForFunction(() => document.querySelectorAll('[aria-label="online"]').length > 0, null, { timeout: 30_000 });
    const replacementServersResponse = [...apiRecords].reverse().find(item => item.page === "tab-b" && item.path === "/api/servers" && item.event === "response");
    assert.equal(replacementServersResponse?.status, 200, "replacement AppContext published data only after the authenticated Gateway server-list response succeeded");
    await pageA.waitForFunction(() => window.__deviceAuthReviewStorage.length > 0, null, { timeout: 30_000 });
    const storageEventsBeforeRelease = await pageA.evaluate(() => window.__deviceAuthReviewStorage.map(event => ({ ...event })));
    await pageA.waitForTimeout(500);
    releaseHeld();
    await pageA.waitForTimeout(1_000);
    const afterStaleResponse = {
      url: new URL(pageA.url()).pathname,
      bodyContainsOldSentinel: (await pageA.locator("body").innerText()).includes("STALE_OLD_ACCOUNT_RESPONSE_SENTINEL"),
      visibleSyntheticServer: await pageA.getByText("Synthetic UI Gateway", { exact: true }).count(),
      missingGatewayMessage: await pageA.getByText("Gateway 已不存在", { exact: true }).count(),
      profile: await waitForProfile(pageA),
      statusesRequests: apiRecords.filter(item => item.page === "tab-a" && item.path === "/api/servers/status" && item.event === "request").length,
    };
    const staleResponseScenario = {
      name: "cross-tab-auth-generation-replacement-drops-late-old-response",
      result: afterStaleResponse.bodyContainsOldSentinel ? "FINDING_STALE_PROJECTION_PUBLISHED" : "STALE_RESPONSE_DROPPED",
      pageAStorageEvents: storageEventsBeforeRelease,
      profileIdStable: replacement.id === initial.id,
      deviceChanged: replacement.deviceId !== initial.deviceId,
      authorizationGenerationChanged: replacement.authorizationGeneration !== initial.authorizationGeneration,
      oldRequestHadExplicitAuthorization: oldBearerMatched,
      replacementRequestUsedNewAuthorization: replacementBearerMatched,
      replacementServersResponseStatus: replacementServersResponse.status,
      replacementAppContextClearedProjectionBeforeResponse: replacementProjectionBeforeResponse === 0,
      replacementAppContextPublishedAfterResponse: await pageB.getByText("Synthetic UI Gateway", { exact: true }).isVisible(),
      staleProjectionPublished: afterStaleResponse.bodyContainsOldSentinel,
      observedStatusRequestsFromTabA: afterStaleResponse.statusesRequests,
      postResponsePage: { path: afterStaleResponse.url, visibleSyntheticServer: afterStaleResponse.visibleSyntheticServer, missingGatewayMessage: afterStaleResponse.missingGatewayMessage },
    };
    scenario.scenarios.push(staleResponseScenario);
    scenario.status = staleResponseScenario.result;
    await writeFile(evidencePath, JSON.stringify({ ...scenario, apiRecords: [...apiRecords], export: exported }, null, 2) + "\n", { mode: 0o600 });
    assert.equal(afterStaleResponse.bodyContainsOldSentinel, false, "late response from replaced authorization generation is not published in the actual AppContext/UI");
    assert.equal(afterStaleResponse.profile.authorizationGeneration, replacement.authorizationGeneration);
    const recoverableWithoutReload = afterStaleResponse.visibleSyntheticServer > 0;
    if (!recoverableWithoutReload) {
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await pageA.waitForURL(new RegExp(`/h/${initial.id}(?:/|$)`), { timeout: 30_000 });
      await pageA.getByText("Synthetic UI Gateway", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    }
    Object.assign(staleResponseScenario, {
      autoRecoveredBeforeReload: recoverableWithoutReload,
      recoveredAfterReload: !recoverableWithoutReload,
      finalVisibleServer: await pageA.getByText("Synthetic UI Gateway", { exact: true }).isVisible(),
    });

    currentStage = "cross-tab-device-removal";
    await pageB.goto(`${site.origin}/settings`, { waitUntil: "domcontentloaded" });
    await pageB.getByText(replacement.label, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    pageB.once("dialog", dialog => { void dialog.accept(); });
    await pageB.getByRole("button", { name: /^(?:移除|Remove)$/ }).click({ timeout: 10_000 });
    await pageB.getByText("暂无 Gateway", { exact: true }).waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    await pageA.getByText("Gateway 已不存在", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const finalA = {
      url: new URL(pageA.url()).pathname,
      visibleMissingGateway: await pageA.getByText("Gateway 已不存在", { exact: true }).isVisible(),
      body: (await pageA.locator("body").innerText()).slice(0, 1000),
      profileCount: await pageA.evaluate(() => JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") || "{\"profiles\":[]}").profiles?.length || 0),
      storageEvents: await pageA.evaluate(() => window.__deviceAuthReviewStorage.map(event => ({ ...event }))),
    };
    assert.equal(finalA.visibleMissingGateway, true, "cross-tab removal clears the active route's AppContext profile projection");
    assert.equal(finalA.profileCount, 0, "profile index removal is visible from the other browser page");
    const pairResponses = apiRecords.filter(item => item.path === "/api/mobile/session" && item.method === "POST" && item.event === "response");
    const revokeResponses = apiRecords.filter(item => item.path === "/api/mobile/session" && item.method === "DELETE" && item.event === "response");
    scenario.status = "completed-with-recovery-finding";
    scenario.result = {
      twoPageSharedProfileIndex: sharedFromB.id === initial.id,
      durableDevicePairing: initial.authMode === "device",
      noSecretFieldsInIndex: initial.secretFieldsInIndex.length === 0,
      refreshOrRPCSecretFieldsInIndex: initial.secretFieldsInIndex,
      noVisiblePairingCookie: !visibleCookieNames.includes("kcoder_studio_session") && !(await pageA.evaluate(() => document.cookie)).includes("kcoder_studio_session"),
      pairResponseCount: pairResponses.length,
      deleteSessionResponseCount: revokeResponses.length,
      deleteSessionStatus: revokeResponses.at(-1)?.status ?? null,
      finalTabA: finalA,
      autoRecoveryAfterAuthGenerationSwap: recoverableWithoutReload ? "PASS" : "PARTIAL: stale response dropped but AppContext did not restore the new profile projection until page reload",
      activeDeviceRevocationConfirmedByApi: revokeResponses.some(item => item.status === 204),
      pageErrors: [...pageErrors],
    };
    assert.ok(pairResponses.length >= 2, "two UI pair flows reached the real candidate Gateway");
    assert.ok(revokeResponses.some(item => item.status === 204), "settings removal revoked the synthetic device family at the Gateway");
    await pageA.screenshot({ path: screenshotAPath, fullPage: true });
    await pageB.screenshot({ path: screenshotBPath, fullPage: true });
    assert.deepEqual(pageErrors, [], "full Mobile Web pages have no uncaught page errors");
    scenario.status = recoverableWithoutReload ? "PASS" : "PARTIAL";
    await writeFile(evidencePath, JSON.stringify({ ...scenario, apiRecords: [...apiRecords], export: exported }, null, 2) + "\n", { mode: 0o600 });
    t.diagnostic(`sanitized full AppContext/Web UI evidence written to ${evidencePath}`);
    t.diagnostic(`real final pages saved to ${screenshotAPath} and ${screenshotBPath}`);
    t.diagnostic(`authorization generation replacement result: ${scenario.status}`);
  } catch (error) {
    failure = error;
    const snapshotPage = async (page, label, screenshotPath) => {
      if (!page) return { label, unavailable: true };
      const snapshot = await page.evaluate(() => {
        for (const input of document.querySelectorAll('input[type="password"], [data-testid="gateway-token"]')) {
          if ("value" in input) input.value = "";
          input.setAttribute("value", "");
        }
        const isVisible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        return {
          path: location.pathname,
          title: document.title,
          visibleText: (document.body?.innerText || "").slice(0, 3000),
          visibleTestIds: [...document.querySelectorAll("[data-testid]")].filter(isVisible).map(element => element.getAttribute("data-testid")).slice(0, 100),
        };
      }).catch(errorValue => ({ snapshotError: scrub(errorValue?.message || "snapshot failed") }));
      let screenshot = "not-captured";
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 3_000 }).then(async () => { await chmod(screenshotPath, 0o600); screenshot = screenshotPath; }).catch(errorValue => { screenshot = `failed: ${scrub(errorValue?.message || "screenshot failed")}`; });
      return { label, ...snapshot, visibleText: typeof snapshot.visibleText === "string" ? scrub(snapshot.visibleText) : undefined, screenshot };
    };
    scenario.status = "failed";
    scenario.failure = { stage: currentStage, name: error?.name || "Error", message: scrub(error?.message || String(error)).slice(0, 1000) };
    scenario.failurePages = await Promise.all([
      snapshotPage(pageA, "tab-a", failureScreenshotAPath),
      snapshotPage(pageB, "tab-b", failureScreenshotBPath),
    ]);
    scenario.apiRecords = [...apiRecords];
    scenario.pageErrors = [...pageErrors];
  } finally {
    releaseTabBServers?.();
    await browserContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await browserServer?.close().catch(() => {});
    await gateway?.close().catch(() => {});
    await site?.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
    const processState = pid => {
      if (!Number.isInteger(pid) || pid <= 0) return "not-recorded";
      try { process.kill(pid, 0); return "still-alive"; }
      catch (error) { return error?.code === "ESRCH" ? "exited" : `check-failed:${error?.code || "unknown"}`; }
    };
    scenario.ownedPidCleanup = Object.fromEntries(Object.entries(scenario.ownedRuntimePids || {}).map(([name, pid]) => [name, processState(pid)]));
    if (failure) {
      scenario.fixtureCleanup = "completed";
      await writeFile(evidencePath, JSON.stringify({ ...scenario, apiRecords: [...apiRecords], export: exported }, null, 2) + "\n", { mode: 0o600 });
      t.diagnostic(`sanitized failure diagnostics written to ${evidencePath}`);
      t.diagnostic(`failure screenshots: ${failureScreenshotAPath} and ${failureScreenshotBPath}`);
    }
  }
  if (failure) throw failure;
});

test(`${candidateLabel} full Mobile Web two-tab refresh-pending generation isolation review`, { timeout: 120_000 }, async t => {
  await verifyFrozenCandidate();
  const exported = await verifyExport();
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const tempRoot = await mkdtemp(join(tmpdir(), "kcoder-device-auth-refresh-pending-review-"));
  const refreshEvidencePath = join(evidenceRoot, `mobile-device-auth-refresh-pending-${candidateLabel}-review.json`);
  const refreshScreenshotAPath = join(evidenceRoot, `mobile-device-auth-refresh-pending-${candidateLabel}-tab-a-final.png`);
  const refreshScreenshotBPath = join(evidenceRoot, `mobile-device-auth-refresh-pending-${candidateLabel}-tab-b-final.png`);
  const refreshFailureAPath = join(evidenceRoot, `mobile-device-auth-refresh-pending-${candidateLabel}-failure-tab-a.png`);
  const refreshFailureBPath = join(evidenceRoot, `mobile-device-auth-refresh-pending-${candidateLabel}-failure-tab-b.png`);
  let gateway;
  let site;
  let browser;
  let browserServer;
  let browserContext;
  let pageA;
  let pageB;
  let oldRefreshReleased = false;
  let currentStage = "fixture-startup";
  let failure = null;
  const oldRefreshStarted = reviewDeferred();
  const oldRefreshClientResponse = reviewDeferred();
  const oldRefreshRelease = reviewDeferred();
  const replacementPairReady = reviewDeferred();
  const newRefreshRequests = [];
  const newRefreshResponses = [];
  const requestWaiters = new Map();
  const responseWaiters = new Map();
  const unexpectedRequests = [];
  const authToken = credential();
  let initialPair;
  let replacementPair;
  let oldGatewayRefreshRecord = null;
  let initialDeviceId;
  let oldRefreshRequestCount = 0;
  let currentNewRefreshTokenSha256 = null;
  const clockOffsetMs = 545_000;
  const scenario = {
    status: "in-progress",
    candidateLabel,
    candidateRoot,
    candidateDigest,
    candidateFiles,
    webBundleSha256: exported.bundleSha256,
    webBundleFileCount: exported.bundleFileCount,
    browserEngine: "system Chromium; mobile emulation; two same-origin pages sharing LocalStorage and Web Locks",
    fixture: "candidate Gateway KCODER_STUDIO_MOCK=1; synthetic credentials/workspace; no Engine, Provider, or user session",
    testBoundary: "manager and full AppContext/UI race with a page-realm Date.now offset; this does not measure natural elapsed-time production renewal or OS clock behavior",
    scenarios: [],
    apiRecords,
    pageErrors,
    credentialsRecorded: false,
    testRunnerPid: process.pid,
    ownedRuntimePids: {},
  };

  function corsJsonHeaders(origin) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
      "content-type": "application/json; charset=utf-8",
      vary: "Origin",
      "cache-control": "no-store",
    };
  }
  function copyCorsHeaders(headers, origin) {
    const result = corsJsonHeaders(origin);
    for (const key of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-max-age", "vary"]) {
      if (headers[key]) result[key] = headers[key];
    }
    return result;
  }
  function waitForOrdinal(records, waiters, ordinal) {
    if (records.length >= ordinal) return Promise.resolve(records[ordinal - 1]);
    if (!waiters.has(ordinal)) waiters.set(ordinal, reviewDeferred());
    return waiters.get(ordinal).promise;
  }
  function notifyOrdinal(records, waiters, record) {
    records.push(record);
    waiters.get(records.length)?.resolve(record);
  }

  sensitiveValues = [authToken];
  try {
    const studioRoot = await stageCandidateRuntime(tempRoot);
    site = await startStaticWeb(exportRoot);
    gateway = await startGateway(tempRoot, studioRoot, site.origin, authToken);
    browserServer = await chromium.launchServer({ headless: true, executablePath: process.env.KCODER_E2E_CHROMIUM_BIN || process.env.KCODER_STUDIO_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    scenario.ownedRuntimePids = { gateway: gateway.child.pid, chromium: browserServer.process().pid };
    browser = await chromium.connect(browserServer.wsEndpoint());
    browserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await browserContext.addInitScript(() => {
      const key = "kcoder-studio-mobile.gateway-profiles.v2";
      window.__deviceAuthReviewStorage = [];
      window.__deviceAuthReviewClockOffset = 0;
      const originalNow = Date.now;
      Date.now = () => originalNow() + window.__deviceAuthReviewClockOffset;
      window.__setDeviceAuthReviewClockOffset = offset => { window.__deviceAuthReviewClockOffset = offset; };
      window.__restoreDeviceAuthReviewClock = () => { window.__deviceAuthReviewClockOffset = 0; Date.now = originalNow; };
      window.__activateDeviceAuthReviewAppState = () => document.dispatchEvent(new Event("visibilitychange"));
      window.addEventListener("storage", event => {
        if (event.key === key || event.key === null) window.__deviceAuthReviewStorage.push({ key: event.key, oldLength: event.oldValue?.length ?? 0, newLength: event.newValue?.length ?? 0 });
      });
    });
    pageA = await browserContext.newPage();
    pageB = await browserContext.newPage();
    attachRequestRecords(pageA, "refresh-tab-a");
    attachRequestRecords(pageB, "refresh-tab-b");
    const initialPairPromise = captureDevicePair(pageA);
    await pair(pageA, site.origin, gateway.origin, authToken, false);
    initialPair = await reviewWithTimeout(initialPairPromise, 10_000, "initial synthetic device pair response was not observed");
    const initialProfile = await waitForProfile(pageA);
    assert.equal(initialProfile.authMode, "device");
    assert.equal(initialProfile.deviceId, initialPair.deviceId);
    assert.equal(initialProfile.authorizationGeneration, initialPair.authorizationGeneration);
    assert.equal(initialProfile.accessTtlMs, 600_000, "Gateway fixture uses the configured ten-minute access TTL");
    assert.deepEqual(initialProfile.secretFieldsInIndex, []);
    assert.equal(initialProfile.secretRecordKeyPresent, true);
    await pageA.getByText("Synthetic UI Gateway", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await pageA.waitForFunction(() => document.querySelectorAll('[aria-label="online"]').length > 0, null, { timeout: 15_000 });
    initialDeviceId = initialProfile.deviceId;

    await browserContext.route("**/api/mobile/session/refresh", async route => {
      const request = route.request();
      if (request.method() !== "POST") { await route.continue(); return; }
      let body;
      try { body = request.postDataJSON(); } catch { body = {}; }
      const requestDeviceId = typeof body.deviceId === "string" ? body.deviceId : "";
      const requestRefreshSha256 = typeof body.refreshToken === "string" ? sha256(body.refreshToken) : null;
      if (requestDeviceId === initialDeviceId) {
        oldRefreshRequestCount += 1;
        if (oldRefreshRequestCount > 1) {
          unexpectedRequests.push({ kind: "duplicate-old-generation-refresh", ordinal: oldRefreshRequestCount });
          await route.fulfill({ status: 429, headers: corsJsonHeaders(site.origin), body: JSON.stringify({ error: "review old refresh request bound exceeded" }) });
          return;
        }
        const upstream = await route.fetch({ timeout: 5_000 });
        let payload = {};
        try { payload = await upstream.json(); } catch { /* Status below remains the primary observation. */ }
        if (typeof payload.accessToken === "string") sensitiveValues.push(payload.accessToken);
        if (typeof payload.rpcToken === "string") sensitiveValues.push(payload.rpcToken);
        if (typeof payload.refreshToken === "string") sensitiveValues.push(payload.refreshToken);
        const record = {
          status: upstream.status(),
          requestDeviceMatchesInitialPair: requestDeviceId === initialPair.deviceId,
          requestRefreshMatchesInitialPair: requestRefreshSha256 === initialPair.refreshTokenSha256,
          responseDeviceMatchesInitialPair: payload.deviceId === initialPair.deviceId,
          responseRefreshTokenPresent: typeof payload.refreshToken === "string",
          responseExpiresAtPresent: Number.isFinite(payload.expiresAt),
          upstreamGateway: "actual frozen candidate Gateway response received before browser response is held",
        };
        oldGatewayRefreshRecord = record;
        oldRefreshStarted.resolve(record);
        await oldRefreshRelease.promise;
        const upstreamHeaders = upstream.headers();
        await route.fulfill({
          status: 503,
          headers: copyCorsHeaders(upstreamHeaders, site.origin),
          body: JSON.stringify({ error: "REVIEW_OLD_REFRESH_FAILURE_SENTINEL" }),
        });
        oldRefreshClientResponse.resolve({ status: 503, injection: "test-only browser response after Gateway returned 200" });
        return;
      }
      const expectedReplacementPair = replacementPair || await reviewWithTimeout(replacementPairReady.promise, 8_000, "replacement pair identity was not available for a refresh request");
      if (requestDeviceId !== expectedReplacementPair.deviceId) {
        unexpectedRequests.push({ kind: "refresh-for-unexpected-device", deviceMatchesReplacementPair: false });
        await route.fulfill({ status: 409, headers: corsJsonHeaders(site.origin), body: JSON.stringify({ error: "review unexpected device route" }) });
        return;
      }

      const ordinal = newRefreshRequests.length + 1;
      const requestRecord = {
        ordinal,
        requestDeviceMatchesReplacementPair: requestDeviceId === expectedReplacementPair.deviceId,
        requestRefreshMatchesExpectedWinner: requestRefreshSha256 === (ordinal === 1 ? expectedReplacementPair.refreshTokenSha256 : currentNewRefreshTokenSha256),
        oldGenerationBrowserResponseStillHeld: !oldRefreshReleased,
      };
      notifyOrdinal(newRefreshRequests, requestWaiters, requestRecord);
      if (ordinal > 2) {
        unexpectedRequests.push({ kind: "extra-new-generation-refresh", ordinal });
        await route.fulfill({ status: 429, headers: corsJsonHeaders(site.origin), body: JSON.stringify({ error: "review new refresh request bound exceeded" }) });
        return;
      }
      const upstream = await route.fetch({ timeout: 5_000 });
      const bodyBytes = await upstream.body();
      let payload = {};
      try { payload = JSON.parse(bodyBytes.toString("utf8")); } catch { /* Record a failed real response without copying its body to evidence. */ }
      if (typeof payload.accessToken === "string") sensitiveValues.push(payload.accessToken);
      if (typeof payload.rpcToken === "string") sensitiveValues.push(payload.rpcToken);
      if (typeof payload.refreshToken === "string") {
        sensitiveValues.push(payload.refreshToken);
        currentNewRefreshTokenSha256 = sha256(payload.refreshToken);
      }
      const responseRecord = {
        ordinal,
        status: upstream.status(),
        requestDeviceMatchesReplacementPair: requestDeviceId === expectedReplacementPair.deviceId,
        requestRefreshMatchesExpectedWinner: requestRecord.requestRefreshMatchesExpectedWinner,
        responseDeviceMatchesReplacementPair: payload.deviceId === expectedReplacementPair.deviceId,
        responseGenerationMatchesReplacementPair: payload.authorizationGeneration === expectedReplacementPair.authorizationGeneration,
        responseRefreshTokenPresent: typeof payload.refreshToken === "string",
        responseExpiresAt: Number.isFinite(payload.expiresAt) ? payload.expiresAt : null,
        accessTtlMs: Number.isFinite(payload.accessTtlMs) ? payload.accessTtlMs : null,
        oldGenerationBrowserResponseStillHeld: !oldRefreshReleased,
      };
      notifyOrdinal(newRefreshResponses, responseWaiters, responseRecord);
      await Promise.all([
        pageA.evaluate(() => window.__setDeviceAuthReviewClockOffset(0)).catch(() => {}),
        pageB.evaluate(() => window.__setDeviceAuthReviewClockOffset(0)).catch(() => {}),
      ]);
      await route.fulfill({ status: upstream.status(), headers: copyCorsHeaders(upstream.headers(), site.origin), body: bodyBytes });
    });

    currentStage = "hold-real-old-generation-refresh-response";
    await pageA.bringToFront();
    await pageA.evaluate(offset => {
      window.__setDeviceAuthReviewClockOffset(offset);
      window.__activateDeviceAuthReviewAppState();
    }, clockOffsetMs);
    const oldGatewayRefresh = await reviewWithTimeout(oldRefreshStarted.promise, 8_000, "actual old-generation refresh did not reach the candidate Gateway");
    assert.equal(oldGatewayRefresh.status, 200, "old-generation refresh reaches the real candidate Gateway and receives 200 before the browser response is held");
    assert.equal(oldGatewayRefresh.requestDeviceMatchesInitialPair, true);
    assert.equal(oldGatewayRefresh.requestRefreshMatchesInitialPair, true);
    assert.equal(oldGatewayRefresh.responseDeviceMatchesInitialPair, true);
    assert.equal(oldGatewayRefresh.responseRefreshTokenPresent, true);

    currentStage = "same-profile-repair-while-old-refresh-response-held";
    const replacementPairPromise = captureDevicePair(pageB).then(pairResult => {
      replacementPair = pairResult;
      replacementPairReady.resolve(pairResult);
      return pairResult;
    });
    await pageB.goto(`${site.origin}/welcome?gateway=${encodeURIComponent(gateway.origin)}&reauth=${encodeURIComponent(initialProfile.id)}`, { waitUntil: "domcontentloaded" });
    await pageB.getByTestId("gateway-endpoint").waitFor({ state: "visible", timeout: 15_000 });
    await pageB.getByTestId("gateway-endpoint").fill(gateway.origin);
    await pageB.getByTestId("gateway-token").fill(authToken);
    await pageB.getByTestId("gateway-connect").click();
    await pageB.waitForURL(new RegExp(`/h/${initialProfile.id}(?:/|$)`), { timeout: 20_000 });
    replacementPair = await reviewWithTimeout(replacementPairPromise, 10_000, "replacement synthetic pair response was not observed");
    const replacementProfile = await waitForProfile(pageB);
    assert.equal(replacementProfile.id, initialProfile.id, "re-pair keeps the same public profile ID");
    assert.notEqual(replacementProfile.deviceId, initialProfile.deviceId, "re-pair creates a separate device family");
    assert.notEqual(replacementProfile.authorizationGeneration, initialProfile.authorizationGeneration, "re-pair advances authorization generation");
    assert.equal(replacementProfile.deviceId, replacementPair.deviceId);
    assert.equal(replacementProfile.authorizationGeneration, replacementPair.authorizationGeneration);
    assert.deepEqual(replacementProfile.secretFieldsInIndex, []);
    await pageA.waitForFunction(expected => {
      const index = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") || "{\"profiles\":[]}");
      return index.profiles?.some(profile => profile.id === expected.id && profile.deviceId === expected.deviceId && profile.authorizationGeneration === expected.authorizationGeneration);
    }, { id: initialProfile.id, deviceId: replacementPair.deviceId, authorizationGeneration: replacementPair.authorizationGeneration }, { timeout: 10_000 });
    await pageA.bringToFront();
    await pageA.evaluate(() => window.__activateDeviceAuthReviewAppState());

    const firstNewRefreshRequest = await reviewWithTimeout(waitForOrdinal(newRefreshRequests, requestWaiters, 1, "new generation request was not observed"), 10_000, "new-generation refresh request did not start while old refresh response remained held");
    const firstNewRefresh = await reviewWithTimeout(waitForOrdinal(newRefreshResponses, responseWaiters, 1, "new generation Gateway response was not observed"), 8_000, "new-generation refresh did not complete against the real candidate Gateway");
    assert.equal(firstNewRefreshRequest.ordinal, 1);
    assert.equal(firstNewRefreshRequest.requestDeviceMatchesReplacementPair, true);
    assert.equal(firstNewRefreshRequest.requestRefreshMatchesExpectedWinner, true);
    assert.equal(firstNewRefreshRequest.oldGenerationBrowserResponseStillHeld, true, "new scope rotates independently while old generation remains pending");
    assert.equal(firstNewRefresh.status, 200, "new-generation refresh receives an actual 200 from the candidate Gateway");
    assert.equal(firstNewRefresh.responseDeviceMatchesReplacementPair, true);
    assert.equal(firstNewRefresh.responseGenerationMatchesReplacementPair, true);
    assert.equal(firstNewRefresh.responseRefreshTokenPresent, true);
    assert.ok(firstNewRefresh.responseExpiresAt > replacementPair.expiresAt);
    assert.notEqual(currentNewRefreshTokenSha256, replacementPair.refreshTokenSha256, "Gateway rotates the persisted refresh credential");
    const firstRefreshExpected = {
      id: initialProfile.id,
      deviceId: replacementPair.deviceId,
      authorizationGeneration: replacementPair.authorizationGeneration,
      minimumExpiresAt: firstNewRefresh.responseExpiresAt,
      refreshTokenSha256: currentNewRefreshTokenSha256,
    };
    const firstTabASummary = await waitForDeviceSecretSummary(pageA, firstRefreshExpected);
    const firstTabBSummary = await waitForDeviceSecretSummary(pageB, firstRefreshExpected);
    assert.equal(firstTabASummary.secretScopeMatchesProfile, true);
    assert.equal(firstTabASummary.refreshTokenMatchesExpected, true);
    assert.equal(firstTabBSummary.secretScopeMatchesProfile, true);
    assert.equal(firstTabBSummary.refreshTokenMatchesExpected, true);

    currentStage = "release-late-old-refresh-error-and-check-new-scope-backoff";
    const oldClientVisibleResponse = pageA.waitForResponse(response => response.request().method() === "POST" && publicPath(response.url()) === "/api/mobile/session/refresh" && response.status() === 503, { timeout: 5_000 });
    oldRefreshReleased = true;
    oldRefreshRelease.resolve();
    const oldInjectedResult = await reviewWithTimeout(oldRefreshClientResponse.promise, 5_000, "held old refresh response was not released");
    const oldResponse = await reviewWithTimeout(oldClientVisibleResponse, 5_000, "old generation's injected 503 was not visible to the browser request");
    await pageA.waitForTimeout(120);
    assert.equal(oldInjectedResult.status, 503);
    assert.equal(oldResponse.status(), 503);
    const afterOldErrorText = await pageA.locator("body").innerText();
    assert.equal(afterOldErrorText.includes("REVIEW_OLD_REFRESH_FAILURE_SENTINEL"), false, "late old-generation refresh error is not published into the replacement UI");
    const currentAfterOldError = await waitForProfile(pageA);
    assert.equal(currentAfterOldError.deviceId, replacementPair.deviceId);
    assert.equal(currentAfterOldError.authorizationGeneration, replacementPair.authorizationGeneration);

    currentStage = "new-generation-authorize-immediately-after-old-error";
    await pageA.bringToFront();
    const secondTriggerStartedAt = Date.now();
    await pageA.evaluate(offset => {
      window.__setDeviceAuthReviewClockOffset(offset);
      window.__activateDeviceAuthReviewAppState();
    }, clockOffsetMs);
    const secondNewRefreshRequest = await reviewWithTimeout(waitForOrdinal(newRefreshRequests, requestWaiters, 2, "second new generation request was not observed"), 800, "current generation was blocked by stale refresh failure backoff or did not refresh promptly");
    const secondRequestElapsedMs = Date.now() - secondTriggerStartedAt;
    const secondNewRefresh = await reviewWithTimeout(waitForOrdinal(newRefreshResponses, responseWaiters, 2, "second new generation Gateway response was not observed"), 8_000, "second new-generation refresh did not receive its Gateway result");
    assert.equal(secondNewRefreshRequest.ordinal, 2);
    assert.ok(secondRequestElapsedMs <= 800, "current-scope refresh starts inside the stale-error backoff window");
    assert.equal(secondNewRefreshRequest.requestDeviceMatchesReplacementPair, true);
    assert.equal(secondNewRefreshRequest.requestRefreshMatchesExpectedWinner, true, "second refresh sends the current first-rotation winner");
    assert.equal(secondNewRefresh.status, 200, "second new-generation refresh also receives an actual Gateway 200");
    assert.equal(secondNewRefresh.responseDeviceMatchesReplacementPair, true);
    assert.equal(secondNewRefresh.responseGenerationMatchesReplacementPair, true);
    assert.equal(secondNewRefresh.responseRefreshTokenPresent, true);
    const finalRefreshExpected = {
      ...firstRefreshExpected,
      minimumExpiresAt: secondNewRefresh.responseExpiresAt,
      refreshTokenSha256: currentNewRefreshTokenSha256,
    };
    const finalTabASummary = await waitForDeviceSecretSummary(pageA, finalRefreshExpected);
    const finalTabBSummary = await waitForDeviceSecretSummary(pageB, finalRefreshExpected);
    assert.equal(finalTabASummary.secretScopeMatchesProfile, true);
    assert.equal(finalTabASummary.refreshTokenMatchesExpected, true);
    assert.equal(finalTabBSummary.secretScopeMatchesProfile, true);
    assert.equal(finalTabBSummary.refreshTokenMatchesExpected, true);
    await pageA.waitForTimeout(400);
    assert.equal(newRefreshRequests.length, 2, "test route caps actual new-generation refreshes at two observations and no renewal loop remains");
    assert.equal(newRefreshResponses.length, 2, "both bounded new-generation refreshes received actual candidate Gateway responses");
    assert.deepEqual(unexpectedRequests, [], "no duplicate old-generation, wrong-device, or extra new-generation refresh was observed");
    const finalBodyA = await pageA.locator("body").innerText();
    const finalBodyB = await pageB.locator("body").innerText();
    assert.equal(finalBodyA.includes("REVIEW_OLD_REFRESH_FAILURE_SENTINEL"), false);
    assert.equal(finalBodyB.includes("REVIEW_OLD_REFRESH_FAILURE_SENTINEL"), false);
    const result = {
      endpoint: "POST /api/mobile/session/refresh",
      trigger: "AppContext due check uses access TTL 600000 ms, refresh lead 60000 ms, and a test-only page Date.now offset of +545000 ms plus RNW visibilitychange/AppState active; Gateway wall clock is unchanged",
      sameProfileIdRepaired: initialProfile.id === replacementProfile.id,
      deviceIdChanged: initialProfile.deviceId !== replacementPair.deviceId,
      authorizationGenerationChanged: initialProfile.authorizationGeneration !== replacementPair.authorizationGeneration,
      oldRequest: { ...oldGatewayRefresh, heldUntilAfterReplacement: true, browserReceivedStatus: oldInjectedResult.status, responseInjection: oldInjectedResult.injection },
      newGenerationGatewayResponses: newRefreshResponses.map(record => ({ ...record })),
      newGenerationActualRefreshCount: newRefreshResponses.length,
      secondNewGenerationRequestElapsedMs: secondRequestElapsedMs,
      bothTabsPersistedCurrentSecretAfterFirstRefresh: firstTabASummary.refreshTokenMatchesExpected && firstTabBSummary.refreshTokenMatchesExpected,
      bothTabsPersistedCurrentSecretAfterSecondRefresh: finalTabASummary.refreshTokenMatchesExpected && finalTabBSummary.refreshTokenMatchesExpected,
      bothTabsSecretScopeBoundToNewIdentity: [finalTabASummary, finalTabBSummary].every(summary => summary.secretScopeMatchesProfile && summary.authorizationGeneration === replacementPair.authorizationGeneration && summary.deviceId === replacementPair.deviceId && summary.active && summary.accessTokenPresent && summary.rpcTokenPresent && summary.refreshTokenPresent && summary.refreshTokenMatchesExpected),
      tabASecretSummary: finalTabASummary,
      tabBSecretSummary: finalTabBSummary,
      extraRefreshCount: unexpectedRequests.filter(item => item.kind === "extra-new-generation-refresh").length,
      staleOldErrorVisibleInEitherTab: finalBodyA.includes("REVIEW_OLD_REFRESH_FAILURE_SENTINEL") || finalBodyB.includes("REVIEW_OLD_REFRESH_FAILURE_SENTINEL"),
      boundary: "This is a real mounted Web/AppContext + real Gateway HTTP refresh race with synthetic credentials; browser Date.now is offset only to trigger the due path quickly. It is not a nine-minute elapsed-time or OS clock validation. The old Gateway response is observed as 200, then the harness injects a client-visible 503 after re-pair to exercise stale-failure handling. 800 ms is only the bound used to detect a stale one-second backoff, not a latency percentile. Browser timer APIs are not overridden; the Date.now offset is reset after each renewal and the original Date.now is restored in cleanup.",
    };
    scenario.scenarios.push({ name: "same-profile-new-generation-refresh-while-old-refresh-held-and-late-failure", result: "PASS_TEST_CLOCK_AND_RESPONSE_INJECTION", ...result });
    scenario.status = "PASS_TEST_CLOCK_AND_RESPONSE_INJECTION";
    scenario.result = result;
    scenario.apiRecords = [...apiRecords];
    scenario.pageErrors = [...pageErrors];
    await pageA.screenshot({ path: refreshScreenshotAPath, fullPage: true });
    await pageB.screenshot({ path: refreshScreenshotBPath, fullPage: true });
    await Promise.all([chmod(refreshScreenshotAPath, 0o600), chmod(refreshScreenshotBPath, 0o600)]);
    assert.deepEqual(pageErrors, [], "full Mobile Web pages have no uncaught errors after the held refresh race");
    t.diagnostic(`sanitized refresh-pending evidence will include post-cleanup PIDs in ${refreshEvidencePath}`);
  } catch (error) {
    failure = error;
    const snapshotPage = async (page, label, screenshotPath) => {
      if (!page) return { label, unavailable: true };
      const snapshot = await page.evaluate(() => {
        for (const input of document.querySelectorAll('input[type="password"], [data-testid="gateway-token"]')) {
          if ("value" in input) input.value = "";
          input.setAttribute("value", "");
        }
        const isVisible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        return {
          path: location.pathname,
          title: document.title,
          visibleText: (document.body?.innerText || "").slice(0, 3000),
          visibleTestIds: [...document.querySelectorAll("[data-testid]")].filter(isVisible).map(element => element.getAttribute("data-testid")).slice(0, 100),
        };
      }).catch(errorValue => ({ snapshotError: scrub(errorValue?.message || "snapshot failed") }));
      let screenshot = "not-captured";
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 3_000 }).then(async () => { await chmod(screenshotPath, 0o600); screenshot = screenshotPath; }).catch(errorValue => { screenshot = `failed: ${scrub(errorValue?.message || "screenshot failed")}`; });
      return { label, ...snapshot, visibleText: typeof snapshot.visibleText === "string" ? scrub(snapshot.visibleText) : undefined, screenshot };
    };
    scenario.status = "failed";
    scenario.failure = { stage: currentStage, name: error?.name || "Error", message: scrub(error?.message || String(error)).slice(0, 1000) };
    scenario.failurePages = await Promise.all([
      snapshotPage(pageA, "tab-a", refreshFailureAPath),
      snapshotPage(pageB, "tab-b", refreshFailureBPath),
    ]);
    scenario.refreshObservations = {
      oldRefreshRequestCount,
      oldGatewayResponse: oldGatewayRefreshRecord,
      newRefreshRequests: newRefreshRequests.map(record => ({ ...record })),
      newRefreshResponses: newRefreshResponses.map(record => ({ ...record })),
      unexpectedRequests: [...unexpectedRequests],
    };
    scenario.apiRecords = [...apiRecords];
    scenario.pageErrors = [...pageErrors];
  } finally {
    oldRefreshReleased = true;
    oldRefreshRelease.resolve();
    if (oldGatewayRefreshRecord) await reviewWithTimeout(oldRefreshClientResponse.promise, 1_000, "held old refresh handler did not finish during cleanup").catch(() => {});
    await Promise.all([
      pageA?.evaluate(() => window.__restoreDeviceAuthReviewClock?.()).catch(() => {}),
      pageB?.evaluate(() => window.__restoreDeviceAuthReviewClock?.()).catch(() => {}),
    ]);
    await browserContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await browserServer?.close().catch(() => {});
    await gateway?.close().catch(() => {});
    await site?.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
    const processState = async pid => {
      if (!Number.isInteger(pid) || pid <= 0) return "not-recorded";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { process.kill(pid, 0); await new Promise(resolveDelay => setTimeout(resolveDelay, 50)); }
        catch (error) { return error?.code === "ESRCH" ? "exited" : `check-failed:${error?.code || "unknown"}`; }
      }
      return "still-alive";
    };
    scenario.ownedPidCleanup = Object.fromEntries(await Promise.all(Object.entries(scenario.ownedRuntimePids || {}).map(async ([name, pid]) => [name, await processState(pid)])));
    scenario.fixtureCleanup = "completed";
    await writeFile(refreshEvidencePath, JSON.stringify({ ...scenario, apiRecords: [...apiRecords], export: exported }, null, 2) + "\n", { mode: 0o600 });
    const pidCleanupPath = join(evidenceRoot, `mobile-device-auth-refresh-pending-${candidateLabel}-pid-cleanup.json`);
    await writeFile(pidCleanupPath, JSON.stringify({ testRunnerPid: process.pid, ownedRuntimePids: scenario.ownedRuntimePids, ownedPidCleanup: scenario.ownedPidCleanup, fixtureCleanup: scenario.fixtureCleanup }, null, 2) + "\n", { mode: 0o600 });
    t.diagnostic(`sanitized refresh-pending evidence written to ${refreshEvidencePath}`);
    t.diagnostic(`PID cleanup evidence written to ${pidCleanupPath}`);
    t.diagnostic(`actual candidate Gateway refresh responses observed: ${newRefreshResponses.length}`);
    if (failure) {
      t.diagnostic(`failure diagnostics written to ${refreshEvidencePath}`);
      t.diagnostic(`failure screenshots: ${refreshFailureAPath} and ${refreshFailureBPath}`);
    } else {
      t.diagnostic(`final pages saved to ${refreshScreenshotAPath} and ${refreshScreenshotBPath}`);
    }
  }
  if (failure) throw failure;
});
function workspaceStateRoutePrefix(profileId, serverId, threadId) {
  return "kcoder-studio:mobile-workspace-state:v3:" +
    encodeURIComponent(profileId) + ":" +
    encodeURIComponent(serverId) + ":" +
    encodeURIComponent(threadId) + ":scope:";
}

function workspaceScopeIndexLockName(profileId, serverId, threadId) {
  // Mirrors workspace-preferences.ts scopeIndexKey + context-lock.ts Web Lock namespace.
  const indexKey = "kcoder-studio:mobile-workspace-scope-index:v1:" +
    encodeURIComponent(profileId) + ":" +
    encodeURIComponent(serverId) + ":" +
    encodeURIComponent(threadId);
  return "kcoder-mobile:workspace-scope-index:" + indexKey;
}

async function openMockReviewTask(page, profileId) {
  await page.getByTestId("sessions").click();
  await page.getByTestId("session-mock-active-session").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("session-mock-active-session").click();
  await page.waitForURL(url => url.pathname === "/h/" + profileId + "/task/local/mock-active-session", { timeout: 20_000 });
  await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 20_000 });
}

async function waitForStoredWorkspaceDraft(page, profileId, generation, expectedDraft) {
  const prefix = workspaceStateRoutePrefix(profileId, "local", "mock-active-session");
  await page.waitForFunction(({ keyPrefix, targetGeneration, draft }) => {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(keyPrefix) && key.includes(targetGeneration)) keys.push(key);
    }
    return keys.some(key => {
      try { return JSON.parse(localStorage.getItem(key) || "null")?.composerDraft === draft; }
      catch { return false; }
    });
  }, { keyPrefix: prefix, targetGeneration: generation, draft: expectedDraft }, { timeout: 15_000 });
  return page.evaluate(({ keyPrefix, targetGeneration }) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(keyPrefix) || !key.includes(targetGeneration)) continue;
      try {
        const state = JSON.parse(localStorage.getItem(key) || "null");
        if (state) return { key, composerDraft: state.composerDraft, queuedCount: state.queuedMessages?.length ?? 0 };
      } catch { /* The test caller asserts a readable persisted key. */ }
    }
    return null;
  }, { keyPrefix: prefix, targetGeneration: generation });
}

const taskScopeCleanupTimeoutMs = 5_000;
const taskScopePidExitTimeoutMs = 3_000;

function taskScopeCleanupError(error) {
  return {
    name: error?.name || "Error",
    message: scrub(error?.message || String(error)).slice(0, 500),
  };
}

async function taskScopeCleanupStep(action, timeoutMs = taskScopeCleanupTimeoutMs) {
  if (!action) return { status: "not-started" };
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`cleanup timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { status: "completed" };
  } catch (error) {
    return { status: "failed", error: taskScopeCleanupError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForTaskScopePidExit(pid, child, timeoutMs = taskScopePidExitTimeoutMs) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "not-started", pid: null };
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { status: "gone", pid, childExitCode: child?.exitCode ?? null, childSignalCode: child?.signalCode ?? null };
      }
      return { status: "probe-failed", pid, error: taskScopeCleanupError(error), childExitCode: child?.exitCode ?? null, childSignalCode: child?.signalCode ?? null };
    }
    if (Date.now() >= deadline) {
      return { status: "still-present-at-deadline", pid, timeoutMs, childExitCode: child?.exitCode ?? null, childSignalCode: child?.signalCode ?? null };
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
}

async function persistTaskScopeEvidence(path, scenario) {
  const temporaryPath = `${path}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(scenario, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    const { rename } = await import("node:fs/promises");
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    const cleanupErrors = [];
    for (const artifactPath of [temporaryPath, path]) {
      try { await rm(artifactPath, { force: true }); }
      catch (cleanupError) { cleanupErrors.push(taskScopeCleanupError(cleanupError)); }
    }
    const artifactStates = await Promise.all([temporaryPath, path].map(async artifactPath => {
      try { await stat(artifactPath); return true; }
      catch (stateError) {
        if (stateError?.code === "ENOENT") return false;
        cleanupErrors.push(taskScopeCleanupError(stateError));
        return null;
      }
    }));
    error.artifactsRemoved = artifactStates.every(state => state === false);
    error.artifactCleanupErrors = cleanupErrors;
    throw error;
  }
}

test(candidateLabel + " TaskScreen new-scope storage read failure after cross-tab re-pair review", { timeout: 120_000 }, async t => {
  let exported;
  let tempRoot;
  let evidenceDir;
  let caseEvidencePath;
  let gateway;
  let site;
  let browser;
  let browserServer;
  let browserContext;
  let pageA;
  let pageB;
  let currentStage = "fixture-startup";
  let faultInstalled = false;
  let failure = null;
  const authToken = credential();
  const oldDraft = "A_OLD_SCOPE_DRAFT_REVIEW_SENTINEL";
  const readFailure = "REVIEW_NEW_SCOPE_STORAGE_READ_FAILURE";
  const apiStart = apiRecords.length;
  const pageErrorStart = pageErrors.length;
  const scenario = {
    candidateLabel,
    candidateRoot,
    candidateDigest,
    candidateFiles,
    webBundleSha256: null,
    evidencePath: null,
    fixture: "candidate Gateway KCODER_STUDIO_MOCK=1; synthetic profile and workspace; no Provider or user session",
    boundary: "A stays on the same TaskScreen URL and browser document while B performs actual Gateway re-pair; this does not assert React component instance identity. The injected failure is only A's new-generation scoped workspace LocalStorage read, translated by Web AsyncStorage into a rejected Promise.",
    testRunnerPid: process.pid,
    resourceStartAttempts: { gateway: false, chromium: false },
    ownedRuntimePids: {},
  };
  sensitiveValues = [authToken];
  try {
    evidenceDir = await mkdtemp(join(evidenceRoot, `mobile-device-auth-full-ui-${candidateLabel}-read-review-`));
    caseEvidencePath = join(evidenceDir, "review.json");
    scenario.evidencePath = caseEvidencePath;
    await chmod(evidenceDir, 0o700);
    await verifyFrozenCandidate();
    exported = await verifyExport();
    scenario.webBundleSha256 = exported.bundleSha256;
    tempRoot = await mkdtemp(join(tmpdir(), "kcoder-device-auth-task-read-review-"));
    const studioRoot = await stageCandidateRuntime(tempRoot);
    site = await startStaticWeb(exportRoot);
    scenario.resourceStartAttempts.gateway = true;
    gateway = await startGateway(tempRoot, studioRoot, site.origin, authToken);
    scenario.ownedRuntimePids.gateway = gateway.child.pid;
    scenario.resourceStartAttempts.chromium = true;
    browserServer = await chromium.launchServer({ headless: true, executablePath: process.env.KCODER_E2E_CHROMIUM_BIN || process.env.KCODER_STUDIO_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    scenario.ownedRuntimePids.chromium = browserServer.process().pid;
    browser = await chromium.connect(browserServer.wsEndpoint());
    browserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await browserContext.addInitScript(() => {
      const key = "kcoder-studio-mobile.gateway-profiles.v2";
      window.__taskScopeReviewStorageEvents = [];
      window.addEventListener("storage", event => {
        if (event.key === key || event.key === null) window.__taskScopeReviewStorageEvents.push({ key: event.key, oldValuePresent: event.oldValue !== null, newValuePresent: event.newValue !== null });
      });
    });
    pageA = await browserContext.newPage();
    pageB = await browserContext.newPage();
    attachRequestRecords(pageA, "task-read-a");
    attachRequestRecords(pageB, "task-read-b");

    currentStage = "pair-a-and-open-task";
    const initialPairPromise = captureDevicePair(pageA);
    await pair(pageA, site.origin, gateway.origin, authToken);
    const initialPair = await reviewWithTimeout(initialPairPromise, 10_000, "A's synthetic Gateway pair response was not observed");
    const initialProfile = await waitForProfile(pageA);
    assert.equal(initialProfile.deviceId, initialPair.deviceId);
    assert.equal(initialProfile.authorizationGeneration, initialPair.authorizationGeneration);
    await openMockReviewTask(pageA, initialProfile.id);
    const taskPath = new URL(pageA.url()).pathname;
    let documentRequestsAfterTaskOpen = 0;
    pageA.on("request", request => {
      if (request.isNavigationRequest() && request.resourceType() === "document") documentRequestsAfterTaskOpen += 1;
    });
    await pageA.getByTestId("message-input").fill(oldDraft);
    const oldStoredState = await waitForStoredWorkspaceDraft(pageA, initialProfile.id, initialProfile.authorizationGeneration, oldDraft);
    assert.equal(oldStoredState?.composerDraft, oldDraft, "A's old-scope draft is persisted before the generation swap");

    currentStage = "install-new-generation-read-failure-on-a-only";
    const keyPrefix = workspaceStateRoutePrefix(initialProfile.id, "local", "mock-active-session");
    await pageA.evaluate(({ profileId, oldGeneration, routeKeyPrefix }) => {
      const prototype = Storage.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "getItem");
      if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) throw new Error("Storage.prototype.getItem is not patchable in this browser");
      const original = descriptor.value;
      const profileKey = "kcoder-studio-mobile.gateway-profiles.v2";
      const fault = { enabled: true, hits: [] };
      const wrapped = function(key) {
        if (this === window.localStorage && fault.enabled && typeof key === "string" && key.startsWith(routeKeyPrefix)) {
          let currentProfile;
          try {
            const index = JSON.parse(original.call(window.localStorage, profileKey) || "{}");
            currentProfile = index.profiles?.find(profile => profile.id === profileId);
          } catch { /* Do not turn profile-index reads into the injected failure. */ }
          if (currentProfile?.authorizationGeneration && currentProfile.authorizationGeneration !== oldGeneration && key.includes(currentProfile.authorizationGeneration)) {
            fault.hits.push({ profileId, authorizationGeneration: currentProfile.authorizationGeneration, keyMatchesCurrentGeneration: true });
            throw new Error("REVIEW_NEW_SCOPE_STORAGE_READ_FAILURE");
          }
        }
        return original.call(this, key);
      };
      Object.defineProperty(prototype, "getItem", { ...descriptor, value: wrapped });
      window.__taskScopeReviewReadFault = {
        hits: fault.hits,
        restore() {
          fault.enabled = false;
          Object.defineProperty(prototype, "getItem", descriptor);
        },
      };
    }, { profileId: initialProfile.id, oldGeneration: initialProfile.authorizationGeneration, routeKeyPrefix: keyPrefix });
    faultInstalled = true;

    currentStage = "b-repairs-same-profile-with-a-task-open";
    const replacementPairPromise = captureDevicePair(pageB);
    await pageB.goto(site.origin + "/welcome?gateway=" + encodeURIComponent(gateway.origin) + "&reauth=" + encodeURIComponent(initialProfile.id), { waitUntil: "domcontentloaded" });
    await pageB.getByTestId("gateway-endpoint").waitFor({ state: "visible", timeout: 15_000 });
    await pageB.getByTestId("gateway-endpoint").fill(gateway.origin);
    await pageB.getByTestId("gateway-token").fill(authToken);
    await pageB.getByTestId("gateway-connect").click();
    await pageB.waitForURL(url => url.pathname === "/h/" + initialProfile.id, { timeout: 20_000 });
    const replacementPair = await reviewWithTimeout(replacementPairPromise, 10_000, "B's replacement pair response was not observed");
    const replacementProfile = await waitForProfile(pageB);
    assert.equal(replacementProfile.id, initialProfile.id);
    assert.equal(replacementPair.deviceId === initialPair.deviceId, false, "B receives a distinct device family");
    assert.equal(replacementPair.authorizationGeneration === initialPair.authorizationGeneration, false, "the actual Gateway pair response advances authorization generation");
    assert.equal(replacementProfile.authorizationGeneration, replacementPair.authorizationGeneration);

    currentStage = "a-storage-event-and-new-scope-read-failure";
    await pageA.waitForFunction(expected => {
      const index = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") || "{\"profiles\":[]}");
      return index.profiles?.some(profile => profile.id === expected.id && profile.authorizationGeneration === expected.generation);
    }, { id: initialProfile.id, generation: replacementPair.authorizationGeneration }, { timeout: 10_000 });
    await pageA.waitForFunction(key => window.__taskScopeReviewStorageEvents.some(event => event.key === key), "kcoder-studio-mobile.gateway-profiles.v2", { timeout: 10_000 });
    await pageA.waitForFunction(() => window.__taskScopeReviewReadFault?.hits.length > 0, null, { timeout: 15_000 });
    await pageA.getByText("无法恢复本机工作区", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    const failureBody = await pageA.locator("body").innerText();
    assert.ok(failureBody.includes(readFailure), "the actual new-scope read rejection is shown as a recoverable workspace error");
    assert.equal(failureBody.includes(oldDraft), false, "the old draft is not rendered in the replacement authorization scope");
    assert.equal(await pageA.getByTestId("message-input").count(), 0, "the failed new-scope hydration does not leave A's composer mounted with old contents");
    assert.equal(await pageA.getByTestId("queued-messages").count(), 0);
    assert.equal(new URL(pageA.url()).pathname, taskPath, "A remains on the exact TaskScreen route while AppContext processes the cross-tab update");
    assert.equal(documentRequestsAfterTaskOpen, 0, "A did not reload its document to hide stale state");
    const readFaultHits = await pageA.evaluate(() => window.__taskScopeReviewReadFault.hits.map(hit => ({ ...hit })));
    assert.ok(readFaultHits.some(hit => hit.profileId === initialProfile.id && hit.authorizationGeneration === replacementPair.authorizationGeneration && hit.keyMatchesCurrentGeneration), "the injected rejection hit the current profile generation's scoped task key");
    const preservedOldState = await waitForStoredWorkspaceDraft(pageA, initialProfile.id, initialProfile.authorizationGeneration, oldDraft);
    assert.equal(preservedOldState?.composerDraft, oldDraft, "a read failure does not delete or rewrite the old-scope draft");

    currentStage = "disable-read-fault-and-retry-current-scope";
    await pageA.evaluate(() => window.__taskScopeReviewReadFault.restore());
    faultInstalled = false;
    await pageA.getByText("重试恢复", { exact: true }).click();
    await pageA.getByTestId("message-input").waitFor({ state: "visible", timeout: 20_000 });
    await pageA.getByText(/其他授权范围的本机草稿已保留/).waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await pageA.getByTestId("message-input").inputValue(), "", "retry hydrates the new scope without restoring A's old draft");
    const recoveredBody = await pageA.locator("body").innerText();
    assert.equal(recoveredBody.includes(oldDraft), false);
    assert.equal(new URL(pageA.url()).pathname, taskPath);
    assert.equal(documentRequestsAfterTaskOpen, 0);
    scenario.result = {
      profileIdStable: replacementProfile.id === initialProfile.id,
      authorizationGenerationChanged: replacementProfile.authorizationGeneration !== initialProfile.authorizationGeneration,
      actualStorageEventObservedInA: true,
      actualNewGenerationTaskKeyRejectedInA: readFaultHits.some(hit => hit.authorizationGeneration === replacementPair.authorizationGeneration),
      recoverableErrorShown: failureBody.includes(readFailure),
      oldScopePreserved: preservedOldState?.composerDraft === oldDraft,
      manualRetryRecoveredCurrentScope: recoveredBody.includes("其他授权范围的本机草稿已保留") && await pageA.getByTestId("message-input").inputValue() === "",
      aTaskRouteUnchanged: new URL(pageA.url()).pathname === taskPath,
      documentReloadsAfterTaskOpen: documentRequestsAfterTaskOpen,
      pageErrors: pageErrors.slice(pageErrorStart),
      apiRecords: apiRecords.slice(apiStart),
    };
    assert.equal(scenario.result.manualRetryRecoveredCurrentScope, true);
    assert.deepEqual(scenario.result.pageErrors, [], "the handled storage failure does not create an uncaught page error");
    t.diagnostic("TaskScreen read-failure scope result: " + JSON.stringify(scenario.result));
  } catch (error) {
    failure = error;
    scenario.failure = { stage: currentStage, ...taskScopeCleanupError(error) };
  } finally {
    const cleanup = { steps: {}, ownedPidDisappearance: {} };
    cleanup.steps.readFaultRestore = faultInstalled
      ? await taskScopeCleanupStep(() => pageA.evaluate(() => window.__taskScopeReviewReadFault?.restore()))
      : { status: "not-needed" };
    if (cleanup.steps.readFaultRestore.status === "completed") faultInstalled = false;
    cleanup.steps.browserContextClose = await taskScopeCleanupStep(browserContext ? () => browserContext.close() : null);
    cleanup.steps.browserClose = await taskScopeCleanupStep(browser ? () => browser.close() : null);
    cleanup.steps.browserServerClose = browserServer
      ? await taskScopeCleanupStep(() => browserServer.close())
      : scenario.resourceStartAttempts.chromium
        ? { status: "failed", error: { name: "MissingOwnedHandle", message: "Chromium startup was attempted but did not return a BrowserServer handle" } }
        : { status: "not-started" };
    cleanup.steps.gatewayClose = gateway
      ? await taskScopeCleanupStep(() => gateway.close())
      : scenario.resourceStartAttempts.gateway
        ? { status: "failed", error: { name: "MissingOwnedHandle", message: "Gateway startup was attempted but did not return its ChildProcess handle" } }
        : { status: "not-started" };
    cleanup.steps.staticWebClose = site
      ? await taskScopeCleanupStep(async () => {
          await new Promise((resolveClose, rejectClose) => site.server.close(error => error ? rejectClose(error) : resolveClose()));
          if (site.server.listening) throw new Error("static web server still listening after close");
        })
      : { status: "not-started" };
    cleanup.ownedPidDisappearance.gateway = Number.isInteger(scenario.ownedRuntimePids.gateway)
      ? await waitForTaskScopePidExit(scenario.ownedRuntimePids.gateway, gateway?.child)
      : scenario.resourceStartAttempts.gateway
        ? { status: "unavailable", pid: null, reason: "Gateway startup returned no owned PID" }
        : { status: "not-started", pid: null };
    cleanup.ownedPidDisappearance.chromium = Number.isInteger(scenario.ownedRuntimePids.chromium)
      ? await waitForTaskScopePidExit(scenario.ownedRuntimePids.chromium, browserServer?.process?.())
      : scenario.resourceStartAttempts.chromium
        ? { status: "unavailable", pid: null, reason: "Chromium startup returned no owned PID" }
        : { status: "not-started", pid: null };
    const ownedPidsGone = Object.values(cleanup.ownedPidDisappearance).every(result => ["gone", "not-started"].includes(result.status));
    cleanup.steps.fixtureRootRemove = !tempRoot
      ? { status: "not-started" }
      : !ownedPidsGone
        ? { status: "failed", retained: true, reason: "owned PID disappearance was not confirmed; fixture root retained" }
        : await taskScopeCleanupStep(async () => {
            await rm(tempRoot, { recursive: true, force: true });
            const exists = await stat(tempRoot).then(() => true, error => {
              if (error?.code === "ENOENT") return false;
              throw error;
          });
          if (exists) throw new Error("temporary fixture root remains after removal");
        });
    if (tempRoot) {
      cleanup.steps.fixtureRootRemove.path = tempRoot;
      if (cleanup.steps.fixtureRootRemove.status === "completed") cleanup.steps.fixtureRootRemove.retained = false;
      else if (cleanup.steps.fixtureRootRemove.retained !== true) cleanup.steps.fixtureRootRemove.retained = "unconfirmed";
    }
    scenario.ownedPidCleanup = cleanup.ownedPidDisappearance;
    const failedSteps = Object.entries(cleanup.steps).filter(([, result]) => result.status === "failed");
    const failedPids = Object.entries(cleanup.ownedPidDisappearance).filter(([, result]) => !["gone", "not-started"].includes(result.status));
    cleanup.status = failedSteps.length === 0 && failedPids.length === 0 ? "complete" : "failed";
    scenario.cleanup = cleanup;
    scenario.fixtureCleanup = cleanup.status;
    if (cleanup.status === "failed") {
      const cleanupSummary = { failedSteps, failedPids };
      if (!failure) failure = new Error("owned fixture cleanup failed");
      scenario.failure = { ...(scenario.failure || { stage: currentStage, ...taskScopeCleanupError(failure) }), cleanup: cleanupSummary };
    }
    scenario.status = failure ? "failed" : "passed";
    scenario.apiRecords = apiRecords.slice(apiStart);
    scenario.pageErrors = pageErrors.slice(pageErrorStart);
    if (caseEvidencePath) {
      try {
        await persistTaskScopeEvidence(caseEvidencePath, scenario);
        t.diagnostic(`sanitized TaskScreen read-failure evidence written to ${caseEvidencePath}`);
      } catch (error) {
        const evidencePersistence = {
          status: "failed",
          persisted: error?.artifactsRemoved === true ? false : "unconfirmed",
          path: caseEvidencePath,
          error: taskScopeCleanupError(error),
          artifactCleanupErrors: error?.artifactCleanupErrors || [],
        };
        scenario.status = "failed";
        scenario.evidencePersistence = evidencePersistence;
        scenario.failure = { ...(scenario.failure || { stage: currentStage, ...taskScopeCleanupError(error) }), evidencePersistence };
        if (!failure) failure = new Error("failed to persist TaskScreen read-failure evidence");
        t.diagnostic("TaskScreen read-failure evidence write failed: " + JSON.stringify({ ...evidencePersistence, note: evidencePersistence.persisted === false ? "no artifact persisted" : "artifact state unconfirmed" }));
      }
    } else {
      const evidencePersistence = { status: "failed", persisted: false, path: null, reason: "private evidence directory was not created" };
      scenario.status = "failed";
      scenario.evidencePersistence = evidencePersistence;
      scenario.failure = { ...(scenario.failure || { stage: currentStage, message: "private evidence directory was not created" }), evidencePersistence };
      if (!failure) failure = new Error("TaskScreen read-failure evidence directory was not created");
      t.diagnostic("TaskScreen read-failure evidence unavailable: no artifact persisted; private evidence directory was not created");
    }
    sensitiveValues = [];
    t.diagnostic("TaskScreen read-failure PID and cleanup result: " + JSON.stringify({ runnerPid: scenario.testRunnerPid, ownedRuntimePids: scenario.ownedRuntimePids, cleanup: scenario.cleanup, fixtureCleanup: scenario.fixtureCleanup, status: scenario.status }));
  }
  if (failure) throw failure;
});

test(candidateLabel + " TaskScreen delayed old-scope draft save after cross-tab re-pair review", { timeout: 120_000 }, async t => {
  let exported;
  let tempRoot;
  let evidenceDir;
  let caseEvidencePath;
  let gateway;
  let site;
  let browser;
  let browserServer;
  let browserContext;
  let pageA;
  let pageB;
  let lockPage;
  let currentStage = "fixture-startup";
  let lockHeld = false;
  let failure = null;
  const authToken = credential();
  const baselineDraft = "A_OLD_SCOPE_BASELINE_REVIEW_SENTINEL";
  const delayedDraft = "A_LATE_OLD_SCOPE_DRAFT_REVIEW_SENTINEL";
  const apiStart = apiRecords.length;
  const pageErrorStart = pageErrors.length;
  const scenario = {
    candidateLabel,
    candidateRoot,
    candidateDigest,
    candidateFiles,
    webBundleSha256: null,
    evidencePath: null,
    fixture: "candidate Gateway KCODER_STUDIO_MOCK=1; synthetic profile and workspace; no Provider or user session",
    boundary: "This holds A's actual save transaction at the product Web Lock before synchronous Web AsyncStorage.setItem. It validates a late composer-draft save only; it does not claim queued-message persistence coverage.",
    testRunnerPid: process.pid,
    resourceStartAttempts: { gateway: false, chromium: false },
    ownedRuntimePids: {},
  };
  sensitiveValues = [authToken];
  try {
    evidenceDir = await mkdtemp(join(evidenceRoot, `mobile-device-auth-full-ui-${candidateLabel}-write-review-`));
    caseEvidencePath = join(evidenceDir, "review.json");
    scenario.evidencePath = caseEvidencePath;
    await chmod(evidenceDir, 0o700);
    await verifyFrozenCandidate();
    exported = await verifyExport();
    scenario.webBundleSha256 = exported.bundleSha256;
    tempRoot = await mkdtemp(join(tmpdir(), "kcoder-device-auth-task-write-review-"));
    const studioRoot = await stageCandidateRuntime(tempRoot);
    site = await startStaticWeb(exportRoot);
    scenario.resourceStartAttempts.gateway = true;
    gateway = await startGateway(tempRoot, studioRoot, site.origin, authToken);
    scenario.ownedRuntimePids.gateway = gateway.child.pid;
    scenario.resourceStartAttempts.chromium = true;
    browserServer = await chromium.launchServer({ headless: true, executablePath: process.env.KCODER_E2E_CHROMIUM_BIN || process.env.KCODER_STUDIO_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    scenario.ownedRuntimePids.chromium = browserServer.process().pid;
    browser = await chromium.connect(browserServer.wsEndpoint());
    browserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await browserContext.addInitScript(() => {
      const key = "kcoder-studio-mobile.gateway-profiles.v2";
      window.__taskScopeReviewStorageEvents = [];
      window.addEventListener("storage", event => {
        if (event.key === key || event.key === null) window.__taskScopeReviewStorageEvents.push({ key: event.key, oldValuePresent: event.oldValue !== null, newValuePresent: event.newValue !== null });
      });
    });
    pageA = await browserContext.newPage();
    pageB = await browserContext.newPage();
    lockPage = await browserContext.newPage();
    attachRequestRecords(pageA, "task-write-a");
    attachRequestRecords(pageB, "task-write-b");
    attachRequestRecords(lockPage, "task-write-lock-holder");

    currentStage = "pair-a-and-persist-baseline-draft";
    const initialPairPromise = captureDevicePair(pageA);
    await pair(pageA, site.origin, gateway.origin, authToken);
    const initialPair = await reviewWithTimeout(initialPairPromise, 10_000, "A's synthetic Gateway pair response was not observed");
    const initialProfile = await waitForProfile(pageA);
    assert.equal(initialProfile.deviceId, initialPair.deviceId);
    assert.equal(initialProfile.authorizationGeneration, initialPair.authorizationGeneration);
    await openMockReviewTask(pageA, initialProfile.id);
    const taskPath = new URL(pageA.url()).pathname;
    let documentRequestsAfterTaskOpen = 0;
    pageA.on("request", request => {
      if (request.isNavigationRequest() && request.resourceType() === "document") documentRequestsAfterTaskOpen += 1;
    });
    await pageA.getByTestId("message-input").fill(baselineDraft);
    const baselineState = await waitForStoredWorkspaceDraft(pageA, initialProfile.id, initialProfile.authorizationGeneration, baselineDraft);
    assert.equal(baselineState?.composerDraft, baselineDraft);

    currentStage = "acquire-real-web-workspace-scope-index-lock";
    const lockName = workspaceScopeIndexLockName(initialProfile.id, "local", "mock-active-session");
    await lockPage.goto(site.origin, { waitUntil: "domcontentloaded" });
    assert.equal(await lockPage.evaluate(() => typeof navigator.locks?.request === "function"), true, "the fixture origin supports the product's Web Lock coordination");
    await lockPage.waitForFunction(name => navigator.locks.query().then(query => !query.pending.some(lock => lock.name === name)), lockName, { timeout: 10_000 });
    await lockPage.evaluate(name => {
      window.__taskScopeReviewLockAcquired = false;
      window.__taskScopeReviewLockFailure = null;
      const held = new Promise(resolve => { window.__releaseTaskScopeReviewLock = resolve; });
      void navigator.locks.request(name, { mode: "exclusive" }, async () => {
        window.__taskScopeReviewLockAcquired = true;
        await held;
      }).catch(error => { window.__taskScopeReviewLockFailure = String(error); });
    }, lockName);
    await lockPage.waitForFunction(() => window.__taskScopeReviewLockAcquired === true, null, { timeout: 10_000 });
    lockHeld = true;

    currentStage = "queue-a-draft-save-on-product-web-lock";
    await pageA.getByTestId("message-input").fill(delayedDraft);
    await lockPage.waitForFunction(name => navigator.locks.query().then(query => query.held.some(lock => lock.name === name) && query.pending.some(lock => lock.name === name)), lockName, { timeout: 10_000 });
    const beforeReleaseState = await pageA.evaluate(({ profileId, generation }) => {
      const prefix = "kcoder-studio:mobile-workspace-state:v3:" + encodeURIComponent(profileId) + ":local:mock-active-session:scope:";
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(prefix) || !key.includes(generation)) continue;
        try {
          const state = JSON.parse(localStorage.getItem(key) || "null");
          if (state) return { key, composerDraft: state.composerDraft };
        } catch { /* Keep scanning only scoped workspace keys. */ }
      }
      return null;
    }, { profileId: initialProfile.id, generation: initialProfile.authorizationGeneration });
    assert.equal(beforeReleaseState?.composerDraft, baselineDraft, "the old-scope save is pending at the real Web Lock and has not written its new value");

    currentStage = "b-repairs-same-profile-while-a-save-is-pending";
    const replacementPairPromise = captureDevicePair(pageB);
    await pageB.goto(site.origin + "/welcome?gateway=" + encodeURIComponent(gateway.origin) + "&reauth=" + encodeURIComponent(initialProfile.id), { waitUntil: "domcontentloaded" });
    await pageB.getByTestId("gateway-endpoint").waitFor({ state: "visible", timeout: 15_000 });
    await pageB.getByTestId("gateway-endpoint").fill(gateway.origin);
    await pageB.getByTestId("gateway-token").fill(authToken);
    await pageB.getByTestId("gateway-connect").click();
    await pageB.waitForURL(url => url.pathname === "/h/" + initialProfile.id, { timeout: 20_000 });
    const replacementPair = await reviewWithTimeout(replacementPairPromise, 10_000, "B's replacement pair response was not observed");
    const replacementProfile = await waitForProfile(pageB);
    assert.equal(replacementProfile.id, initialProfile.id);
    assert.notEqual(replacementProfile.deviceId, initialProfile.deviceId);
    assert.notEqual(replacementProfile.authorizationGeneration, initialProfile.authorizationGeneration);
    assert.equal(replacementProfile.authorizationGeneration, replacementPair.authorizationGeneration);
    await pageA.waitForFunction(expected => {
      const index = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") || "{\"profiles\":[]}");
      return index.profiles?.some(profile => profile.id === expected.id && profile.authorizationGeneration === expected.generation);
    }, { id: initialProfile.id, generation: replacementPair.authorizationGeneration }, { timeout: 10_000 });
    await pageA.waitForFunction(key => window.__taskScopeReviewStorageEvents.some(event => event.key === key), "kcoder-studio-mobile.gateway-profiles.v2", { timeout: 10_000 });
    await pageA.getByText(/其他授权范围的本机草稿已保留/).waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(new URL(pageA.url()).pathname, taskPath);
    assert.equal(documentRequestsAfterTaskOpen, 0, "A stayed on the same TaskScreen document during the generation change");

    currentStage = "release-old-scope-save-and-check-current-ui";
    await lockPage.evaluate(() => window.__releaseTaskScopeReviewLock?.());
    lockHeld = false;
    const completedOldState = await waitForStoredWorkspaceDraft(pageA, initialProfile.id, initialProfile.authorizationGeneration, delayedDraft);
    assert.equal(completedOldState?.composerDraft, delayedDraft, "the delayed transaction completes under its captured old authorization key");
    await pageA.waitForTimeout(400);
    const currentProfile = await waitForProfile(pageA);
    assert.equal(currentProfile.authorizationGeneration, replacementPair.authorizationGeneration);
    assert.equal(new URL(pageA.url()).pathname, taskPath);
    assert.equal(await pageA.getByTestId("message-input").inputValue(), "", "the new-generation composer does not adopt the late old-scope value");
    const body = await pageA.locator("body").innerText();
    assert.equal(body.includes(delayedDraft), false, "late A save does not publish A's draft into the new-scope TaskScreen UI");
    assert.equal(await pageA.getByTestId("queued-messages").count(), 0);
    const newScopeStates = await pageA.evaluate(({ profileId, generation }) => {
      const prefix = "kcoder-studio:mobile-workspace-state:v3:" + encodeURIComponent(profileId) + ":local:mock-active-session:scope:";
      const values = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(prefix) || !key.includes(generation)) continue;
        try { values.push(JSON.parse(localStorage.getItem(key) || "null")); } catch { /* No new scope data is visible. */ }
      }
      return values;
    }, { profileId: initialProfile.id, generation: replacementPair.authorizationGeneration });
    assert.equal(newScopeStates.some(state => state?.composerDraft === delayedDraft), false);
    assert.equal(documentRequestsAfterTaskOpen, 0);
    scenario.result = {
      profileIdStable: replacementProfile.id === initialProfile.id,
      authorizationGenerationChanged: replacementProfile.authorizationGeneration !== initialProfile.authorizationGeneration,
      oldSaveWasPendingOnProductWebLock: true,
      oldScopeWriteCompleted: completedOldState?.composerDraft === delayedDraft,
      currentGenerationMatchesReplacement: currentProfile.authorizationGeneration === replacementPair.authorizationGeneration,
      lateOldDraftAbsentFromCurrentUi: !body.includes(delayedDraft) && await pageA.getByTestId("message-input").inputValue() === "",
      lateOldDraftAbsentFromNewScopeStorage: !newScopeStates.some(state => state?.composerDraft === delayedDraft),
      oldDraftOnlyCase: true,
      aTaskRouteUnchanged: new URL(pageA.url()).pathname === taskPath,
      documentReloadsAfterTaskOpen: documentRequestsAfterTaskOpen,
      pageErrors: pageErrors.slice(pageErrorStart),
      apiRecords: apiRecords.slice(apiStart),
    };
    assert.equal(scenario.result.lateOldDraftAbsentFromCurrentUi, true);
    assert.equal(scenario.result.lateOldDraftAbsentFromNewScopeStorage, true);
    assert.deepEqual(scenario.result.pageErrors, [], "the held save completes without uncaught page errors");
    t.diagnostic("TaskScreen delayed-save scope result: " + JSON.stringify(scenario.result));
  } catch (error) {
    failure = error;
    scenario.failure = { stage: currentStage, ...taskScopeCleanupError(error) };
  } finally {
    const cleanup = { steps: {}, ownedPidDisappearance: {} };
    cleanup.steps.webLockRelease = lockHeld
      ? await taskScopeCleanupStep(() => lockPage.evaluate(() => window.__releaseTaskScopeReviewLock?.()))
      : { status: "not-needed" };
    if (cleanup.steps.webLockRelease.status === "completed") lockHeld = false;
    cleanup.steps.browserContextClose = await taskScopeCleanupStep(browserContext ? () => browserContext.close() : null);
    cleanup.steps.browserClose = await taskScopeCleanupStep(browser ? () => browser.close() : null);
    cleanup.steps.browserServerClose = browserServer
      ? await taskScopeCleanupStep(() => browserServer.close())
      : scenario.resourceStartAttempts.chromium
        ? { status: "failed", error: { name: "MissingOwnedHandle", message: "Chromium startup was attempted but did not return a BrowserServer handle" } }
        : { status: "not-started" };
    cleanup.steps.gatewayClose = gateway
      ? await taskScopeCleanupStep(() => gateway.close())
      : scenario.resourceStartAttempts.gateway
        ? { status: "failed", error: { name: "MissingOwnedHandle", message: "Gateway startup was attempted but did not return its ChildProcess handle" } }
        : { status: "not-started" };
    cleanup.steps.staticWebClose = site
      ? await taskScopeCleanupStep(async () => {
          await new Promise((resolveClose, rejectClose) => site.server.close(error => error ? rejectClose(error) : resolveClose()));
          if (site.server.listening) throw new Error("static web server still listening after close");
        })
      : { status: "not-started" };
    cleanup.ownedPidDisappearance.gateway = Number.isInteger(scenario.ownedRuntimePids.gateway)
      ? await waitForTaskScopePidExit(scenario.ownedRuntimePids.gateway, gateway?.child)
      : scenario.resourceStartAttempts.gateway
        ? { status: "unavailable", pid: null, reason: "Gateway startup returned no owned PID" }
        : { status: "not-started", pid: null };
    cleanup.ownedPidDisappearance.chromium = Number.isInteger(scenario.ownedRuntimePids.chromium)
      ? await waitForTaskScopePidExit(scenario.ownedRuntimePids.chromium, browserServer?.process?.())
      : scenario.resourceStartAttempts.chromium
        ? { status: "unavailable", pid: null, reason: "Chromium startup returned no owned PID" }
        : { status: "not-started", pid: null };
    const ownedPidsGone = Object.values(cleanup.ownedPidDisappearance).every(result => ["gone", "not-started"].includes(result.status));
    cleanup.steps.fixtureRootRemove = !tempRoot
      ? { status: "not-started" }
      : !ownedPidsGone
        ? { status: "failed", retained: true, reason: "owned PID disappearance was not confirmed; fixture root retained" }
        : await taskScopeCleanupStep(async () => {
            await rm(tempRoot, { recursive: true, force: true });
            const exists = await stat(tempRoot).then(() => true, error => {
              if (error?.code === "ENOENT") return false;
              throw error;
          });
          if (exists) throw new Error("temporary fixture root remains after removal");
        });
    if (tempRoot) {
      cleanup.steps.fixtureRootRemove.path = tempRoot;
      if (cleanup.steps.fixtureRootRemove.status === "completed") cleanup.steps.fixtureRootRemove.retained = false;
      else if (cleanup.steps.fixtureRootRemove.retained !== true) cleanup.steps.fixtureRootRemove.retained = "unconfirmed";
    }
    scenario.ownedPidCleanup = cleanup.ownedPidDisappearance;
    const failedSteps = Object.entries(cleanup.steps).filter(([, result]) => result.status === "failed");
    const failedPids = Object.entries(cleanup.ownedPidDisappearance).filter(([, result]) => !["gone", "not-started"].includes(result.status));
    cleanup.status = failedSteps.length === 0 && failedPids.length === 0 ? "complete" : "failed";
    scenario.cleanup = cleanup;
    scenario.fixtureCleanup = cleanup.status;
    if (cleanup.status === "failed") {
      const cleanupSummary = { failedSteps, failedPids };
      if (!failure) failure = new Error("owned fixture cleanup failed");
      scenario.failure = { ...(scenario.failure || { stage: currentStage, ...taskScopeCleanupError(failure) }), cleanup: cleanupSummary };
    }
    scenario.status = failure ? "failed" : "passed";
    scenario.apiRecords = apiRecords.slice(apiStart);
    scenario.pageErrors = pageErrors.slice(pageErrorStart);
    if (caseEvidencePath) {
      try {
        await persistTaskScopeEvidence(caseEvidencePath, scenario);
        t.diagnostic(`sanitized TaskScreen delayed-save evidence written to ${caseEvidencePath}`);
      } catch (error) {
        const evidencePersistence = {
          status: "failed",
          persisted: error?.artifactsRemoved === true ? false : "unconfirmed",
          path: caseEvidencePath,
          error: taskScopeCleanupError(error),
          artifactCleanupErrors: error?.artifactCleanupErrors || [],
        };
        scenario.status = "failed";
        scenario.evidencePersistence = evidencePersistence;
        scenario.failure = { ...(scenario.failure || { stage: currentStage, ...taskScopeCleanupError(error) }), evidencePersistence };
        if (!failure) failure = new Error("failed to persist TaskScreen delayed-save evidence");
        t.diagnostic("TaskScreen delayed-save evidence write failed: " + JSON.stringify({ ...evidencePersistence, note: evidencePersistence.persisted === false ? "no artifact persisted" : "artifact state unconfirmed" }));
      }
    } else {
      const evidencePersistence = { status: "failed", persisted: false, path: null, reason: "private evidence directory was not created" };
      scenario.status = "failed";
      scenario.evidencePersistence = evidencePersistence;
      scenario.failure = { ...(scenario.failure || { stage: currentStage, message: "private evidence directory was not created" }), evidencePersistence };
      if (!failure) failure = new Error("TaskScreen delayed-save evidence directory was not created");
      t.diagnostic("TaskScreen delayed-save evidence unavailable: no artifact persisted; private evidence directory was not created");
    }
    sensitiveValues = [];
    t.diagnostic("TaskScreen delayed-save PID and cleanup result: " + JSON.stringify({ runnerPid: scenario.testRunnerPid, ownedRuntimePids: scenario.ownedRuntimePids, cleanup: scenario.cleanup, fixtureCleanup: scenario.fixtureCleanup, status: scenario.status }));
  }
  if (failure) throw failure;
});
