import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const enabled = process.env.KCODER_E2E_PUBLIC_MOBILE_UI === "1";
assert.ok(enabled, "This child suite is launched only by the authorized full-public Relay owner");

const origin = requiredOrigin("KCODER_E2E_PUBLIC_UI_ORIGIN");
const parentRunRoot = resolve(requiredInput("KCODER_E2E_PUBLIC_UI_PARENT_RUN_ROOT"));
const parentStateRoot = resolve(parentRunRoot, "state");
const fixturePath = resolve(requiredInput("KCODER_E2E_PUBLIC_UI_PAIRING_FIXTURES"));
const expectedSourceDigest = requiredSha256("KCODER_E2E_PUBLIC_UI_EXPECTED_SOURCE_DIGEST");
const expectedBundleSha256 = requiredSha256("KCODER_E2E_PUBLIC_UI_EXPECTED_BUNDLE_SHA256");
const webManifestPath = resolve(requiredInput("KCODER_E2E_PUBLIC_UI_WEB_MANIFEST"));
const privateWebBoundary = resolve(repoRoot, "target/private-phone-ux-implementation");

await assertPrivateRegularFile(fixturePath, parentStateRoot, { requirePrivatePermissions: true });
await assertPrivateRegularFile(webManifestPath, privateWebBoundary);
const webManifest = JSON.parse(await readFile(webManifestPath, "utf8"));
assert.equal(webManifest.status, "complete");
assert.equal(webManifest.bundleSha256, expectedBundleSha256);
assert.ok(Array.isArray(webManifest.bundleFiles));
const expectedFiles = new Map(webManifest.bundleFiles.map(file => [file.path, file.sha256]));
const indexSha256 = expectedFiles.get("index.html");
assert.match(indexSha256 ?? "", /^[a-f0-9]{64}$/);
const entryJs = webManifest.bundleFiles.find(file => /(?:^|\/)entry-[^/]+\.js$/.test(file.path));
assert.ok(entryJs, "the frozen Mobile Web export must declare its entry JavaScript file");
assert.match(entryJs.sha256, /^[a-f0-9]{64}$/);
assertSafeBundlePath(entryJs.path);

const fixtureBytes = await readFile(fixturePath);
const fixtures = JSON.parse(fixtureBytes.toString("utf8"));
const gateways = {
  alpha: await validateFixture(fixtures.alpha, "alpha"),
  beta: await validateFixture(fixtures.beta, "beta"),
};
assert.notEqual(gateways.alpha.id, gateways.beta.id);
assert.notEqual(gateways.alpha.pairingToken, gateways.beta.pairingToken);
assert.equal(gateways.alpha.serverId, "public-fixture-alpha");
assert.equal(gateways.beta.serverId, "public-fixture-beta");

await runE2E(import.meta.url, {
  testId: "mobile-high-latency-public-ui",
  tier: "manual-live",
  modelPolicy: "frozen Mobile Web UI over public HTTPS/WSS with two isolated mock Gateways; no Provider call, model task, or task mutation",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
}, async context => {
  for (const fixture of Object.values(gateways)) {
    context.registerSecret(fixture.id);
    context.registerSecret(fixture.pairingToken);
  }

  const browser = await startChromium(context, { label: "public-mobile-ui-chromium" });
  const pageStates = new Map();
  const capturedSessions = new Map();
  const cleanupState = { finished: false, revokeStatuses: {} };
  const cleanupPagesAndSessions = async () => {
    if (cleanupState.finished) return cleanupState.revokeStatuses;
    await Promise.all([...pageStates.values()].map(state => state.page.context().close().catch(() => undefined)));
    const failures = [];
    for (const name of ["alpha", "beta"]) {
      const session = capturedSessions.get(name);
      if (!session) continue;
      if (cleanupState.revokeStatuses[name] === 204) continue;
      try {
        const response = await fetchWithTimeout(`${routeFor(gateways[name])}/api/mobile/session`, {
          method: "DELETE",
          headers: {
            Origin: origin,
            Authorization: `Bearer ${session.accessToken}`,
          },
        });
        cleanupState.revokeStatuses[name] = response.status;
        if (response.status !== 204) failures.push(`${name} session revoke returned HTTP ${response.status}`);
      } catch (error) {
        failures.push(`${name} session revoke failed (${safeErrorCategory(error)})`);
      }
    }
    if (failures.length) throw new Error(failures.join("; "));
    cleanupState.finished = true;
    return cleanupState.revokeStatuses;
  };
  // RunContext cleanup is LIFO: close pages and revoke their sessions before stopping Chromium.
  context.addCleanup("close public Mobile pages and revoke their temporary sessions", cleanupPagesAndSessions);

  const checks = [];
  const rootResponseStatuses = {};
  const staticResponses = {};
  const perGatewayProof = {};

  for (const name of ["alpha", "beta"]) {
    const fixture = gateways[name];
    const otherName = name === "alpha" ? "beta" : "alpha";
    const otherFixture = gateways[otherName];
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
    });
    const state = createPageState(name, page, fixture, otherFixture);
    pageStates.set(name, state);
    attachNetworkObservers(state, {
      expectedIndexSha256: indexSha256,
      expectedEntryPath: entryJs.path,
      expectedEntrySha256: entryJs.sha256,
    });

    const pageResponse = await state.page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    assert.equal(pageResponse?.status(), 200, `${name} root navigation should use the isolated public HTTPS front`);
    rootResponseStatuses[name] = pageResponse.status();
    await state.page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
    await state.page.getByTestId("welcome-direct-connection").click();
    const endpoint = state.page.getByTestId("gateway-endpoint");
    const pairingToken = state.page.getByTestId("gateway-token");
    const connect = state.page.getByTestId("gateway-connect");
    await endpoint.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await endpoint.inputValue(), origin, "the form should default to the current HTTPS origin");
    await endpoint.fill(routeFor(fixture));
    await pairingToken.fill(fixture.pairingToken);
    const sessionExchange = watchSessionExchange(state.page, fixture.id);
    await connect.click();

    const exchange = await withTimeout(sessionExchange, 30_000, `${name} public session exchange`);
    assert.equal(exchange.status, 200, `${name} pairing should exchange only on its registered /g route`);
    assert.equal(typeof exchange.payload?.accessToken, "string");
    assert.equal(typeof exchange.payload?.rpcToken, "string");
    for (const secret of [exchange.payload.accessToken, exchange.payload.rpcToken, exchange.payload.refreshToken]) {
      if (typeof secret === "string" && secret.length >= 8) context.registerSecret(secret);
    }
    capturedSessions.set(name, {
      accessToken: exchange.payload.accessToken,
      rpcToken: exchange.payload.rpcToken,
    });
    const ownServer = state.page.getByTestId(`new-workspace-${fixture.serverId}`);
    await ownServer.waitFor({ state: "visible", timeout: 30_000 });
    await endpoint.waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(
      await state.page.getByTestId(`new-workspace-${otherFixture.serverId}`).count(),
      0,
      `${name} profile must not project the other Gateway's server into its home screen`,
    );
    assert.equal(
      await ownServer.getAttribute("aria-label"),
      `在 ${fixture.workspaceLabel} 新建任务`,
      `${name} registered workspace action should identify its own server accessibly`,
    );

    const sessionButton = state.page.getByTestId("sessions");
    await sessionButton.waitFor({ state: "visible", timeout: 10_000 });
    await sessionButton.click();
    const sessionRow = state.page.getByTestId("session-mock-active-session");
    await sessionRow.waitFor({ state: "visible", timeout: 30_000 });
    const rowText = await sessionRow.innerText();
    assert.ok(rowText.includes(fixture.workspaceLabel), `${name} session row should retain its own server identity`);
    assert.ok(rowText.includes("移动任务操作测试"), `${name} session row should identify the seeded mock history`);
    await sessionRow.click();

    await state.page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    const history = state.page.getByTestId("message-user").filter({ hasText: "历史附件" });
    await history.waitFor({ state: "visible", timeout: 30_000 });
    const composer = state.page.getByTestId("message-input");
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await composer.isEnabled(), true, `${name} history screen should leave the composer editable`);
    await composer.fill("PUBLIC_UI_EDIT_ONLY");
    assert.equal(await composer.inputValue(), "PUBLIC_UI_EDIT_ONLY");
    await composer.fill("");

    await waitFor(() => state.network.wss.some(socket => socket.routeMatch === "expected"), 10_000,
      `${name} Mobile RPC WebSocket on its exact public Gateway route`, 50, context.abortSignal);
    const methods = [...new Set(state.network.rpcMethods)].sort();
    assert.ok(methods.includes("initialize"), `${name} UI should initialize the public WSS RPC connection`);
    assert.ok(methods.some(method => method === "thread/list" || method === "thread/read" || method === "thread/read/indexed"),
      `${name} UI should load the seeded session through public WSS RPC`);
    assert.equal(state.network.wss.some(socket => socket.routeMatch !== "expected"), false,
      `${name} page must not open an RPC WebSocket on the other or an unknown Gateway route`);
    assert.equal(state.network.foreignGatewayRequestCount, 0,
      `${name} page must not send an HTTP request to the other Gateway route`);
    assert.equal(methods.some(method => method === "turn/start" || method === "thread/start"), false,
      "the UI check must not start a model task or create a thread");

    const staticProof = await withTimeout(state.staticProof, 10_000, `${name} frozen Web entry asset responses`);
    assert.equal(staticProof.indexStatus, 200, `${name} should load the frozen Mobile Web root document`);
    assert.equal(staticProof.indexSha256, indexSha256, `${name} root document should match the frozen export`);
    assert.equal(staticProof.entryStatus, 200, `${name} should load the frozen Mobile Web entry bundle`);
    assert.equal(staticProof.entrySha256, entryJs.sha256, `${name} JavaScript response should match the frozen export`);
    staticResponses[name] = staticProof;
    perGatewayProof[name] = {
      publicSessionExchange: exchange.status,
      ownServerVisible: true,
      otherServerVisible: false,
      sessionRowOwnsServerLabel: true,
      seededHistoryVisible: true,
      composerEditable: true,
      publicRpcWebSocket: "opened-on-matching-route",
      rpcMethods: methods,
      oppositeRouteRequests: 0,
      taskOrTurnStarted: false,
      static: staticProof,
    };
    checks.push(
      { name: `${name}_static_index_sha256`, status: "HTTP 200, frozen SHA-256 matched" },
      { name: `${name}_static_entry_js_sha256`, status: "HTTP 200, frozen SHA-256 matched" },
      { name: `${name}_public_session_exchange`, status: "HTTP 200" },
      { name: `${name}_own_server_only`, status: "passed" },
      { name: `${name}_seeded_session_history_via_public_wss`, status: "passed" },
      { name: `${name}_editable_composer_without_send`, status: "passed" },
    );
  }

  assert.equal(rootResponseStatuses.alpha, 200);
  assert.equal(rootResponseStatuses.beta, 200);
  assert.equal(perGatewayProof.alpha.otherServerVisible, false);
  assert.equal(perGatewayProof.beta.otherServerVisible, false);
  assert.equal(staticResponses.alpha.indexSha256, indexSha256);
  assert.equal(staticResponses.beta.indexSha256, indexSha256);
  assert.equal(staticResponses.alpha.entrySha256, entryJs.sha256);
  assert.equal(staticResponses.beta.entrySha256, entryJs.sha256);

  const revocationStatuses = await cleanupPagesAndSessions();
  assert.deepEqual(revocationStatuses, { alpha: 204, beta: 204 }, "both temporary browser sessions must be revoked after their WSS pages close");
  await browser.close();

  checks.push(
    { name: "two_route_ui_identity_isolation", status: "alpha and beta pages saw only their own server and RPC route" },
    { name: "temporary_mobile_session_cleanup", status: "HTTP 204 for both sessions" },
    { name: "production_services", status: "untouched by the isolated test front" },
  );
  const proof = {
    sourceDigest: expectedSourceDigest,
    mobileWebBundleSha256: expectedBundleSha256,
    transport: "real Chromium over public HTTPS and WSS through the temporary isolated standard-port TLS front",
    gatewayRouteCount: 2,
    viewport: { width: 390, height: 844 },
    modelCallPerformed: false,
    taskMutationPerformed: false,
    submitActionPerformed: false,
    checks,
    pages: perGatewayProof,
    staticResponseStatuses: rootResponseStatuses,
    temporarySessionRevocationStatuses: revocationStatuses,
  };
  await context.writeArtifactJson("public-mobile-ui-proof.json", proof);
  console.log(JSON.stringify({ stage: "public-mobile-ui-passed", checks: checks.length, routes: 2, modelCallPerformed: false }));
  return proof;
});

function createPageState(name, page, fixture, otherFixture) {
  return {
    name,
    fixture,
    otherFixture,
    page,
    network: {
      wss: [],
      rpcMethods: [],
      foreignGatewayRequestCount: 0,
    },
    staticProof: Promise.resolve(null),
  };
}

function attachNetworkObservers(state, expectedStatic) {
  const routePrefix = `/g/${state.fixture.id}`;
  const otherRoutePrefix = `/g/${state.otherFixture.id}`;
  const observedStatic = new Map();
  let resolveStatic;
  state.staticProof = new Promise(resolvePromise => { resolveStatic = resolvePromise; });

  state.page.on("request", request => {
    let pathname;
    try { pathname = new URL(request.url()).pathname; } catch { return; }
    if (pathname.startsWith("/g/") && !pathname.startsWith(`${routePrefix}/`)) {
      state.network.foreignGatewayRequestCount += 1;
    }
  });
  state.page.on("response", response => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== origin) return;

    if (url.pathname === "/" && response.request().resourceType() === "document") {
      void response.body().then(body => {
        observedStatic.set("index", {
          status: response.status(),
          sha256: sha256(body),
          matches: sha256(body) === expectedStatic.expectedIndexSha256,
        });
        resolveStaticProof();
      }).catch(() => {
        observedStatic.set("index", { status: response.status(), sha256: null, matches: false });
        resolveStaticProof();
      });
    }
    if (url.pathname === `/${expectedStatic.expectedEntryPath}`) {
      void response.body().then(body => {
        observedStatic.set("entry", {
          status: response.status(),
          path: "frozen-entry-javascript",
          sha256: sha256(body),
          matches: sha256(body) === expectedStatic.expectedEntrySha256,
        });
        resolveStaticProof();
      }).catch(() => {
        observedStatic.set("entry", { status: response.status(), path: "frozen-entry-javascript", sha256: null, matches: false });
        resolveStaticProof();
      });
    }
  });
  state.page.on("websocket", socket => {
    let pathname;
    try { pathname = new URL(socket.url()).pathname; } catch { return; }
    if (!pathname.endsWith("/rpc")) return;
    const routeMatch = pathname.startsWith(`${routePrefix}/`)
      ? "expected"
      : pathname.startsWith(`${otherRoutePrefix}/`)
        ? "opposite"
        : "unknown";
    state.network.wss.push({ routeMatch });
    socket.on("framesent", frame => {
      if (typeof frame.payload !== "string") return;
      try {
        const message = JSON.parse(frame.payload);
        if (typeof message.method === "string") state.network.rpcMethods.push(message.method);
      } catch {
        // Non-JSON WebSocket frames do not contribute RPC method evidence.
      }
    });
  });

  function resolveStaticProof() {
    if (!observedStatic.has("index") || !observedStatic.has("entry")) return;
    resolveStatic({
      indexStatus: observedStatic.get("index").status,
      indexSha256: observedStatic.get("index").sha256,
      entryStatus: observedStatic.get("entry").status,
      entrySha256: observedStatic.get("entry").sha256,
    });
  }
}

function watchSessionExchange(page, routeId) {
  let resolveExchange;
  let settled = false;
  const exchange = new Promise(resolvePromise => { resolveExchange = resolvePromise; });
  const expectedPath = `/g/${routeId}/api/mobile/session`;
  page.on("response", response => {
    if (settled || response.request().method() !== "POST") return;
    let url;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== origin || url.pathname !== expectedPath) return;
    settled = true;
    void response.json().then(payload => resolveExchange({ status: response.status(), payload })).catch(() => resolveExchange({ status: response.status(), payload: null }));
  });
  return exchange;
}

function routeFor(fixture) {
  return `${origin}/g/${fixture.id}`;
}

async function validateFixture(value, name) {
  assert.ok(value && typeof value === "object", `${name} pairing fixture is missing`);
  assert.match(value.id ?? "", /^[a-f0-9]{32}$/, `${name} route identity must be a private generated ID`);
  assert.ok(typeof value.pairingToken === "string" && value.pairingToken.length >= 32);
  assert.equal(value.serverId, `public-fixture-${name}`);
  assert.equal(value.workspaceLabel, `Public UX fixture ${name}`);
  assert.equal(typeof value.workspacePath, "string");
  const workspacePath = resolve(value.workspacePath);
  const workspaceRelative = relative(resolve(parentStateRoot, "workspaces"), workspacePath);
  assert.ok(
    workspaceRelative && !workspaceRelative.startsWith(`..${sep}`) && !isAbsolute(workspaceRelative),
    "fixture workspace must remain inside the parent RunContext's state/workspaces tree",
  );
  let current = resolve(parentStateRoot, "workspaces");
  const parts = workspaceRelative.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "fixture workspace path must contain only owned directories");
  }
  assert.equal(await realpath(workspacePath), workspacePath);
  return {
    id: value.id,
    pairingToken: value.pairingToken,
    serverId: value.serverId,
    workspaceLabel: value.workspaceLabel,
  };
}

function assertSafeBundlePath(value) {
  assert.equal(typeof value, "string");
  assert.ok(!isAbsolute(value) && !value.split(/[\\/]/).includes(".."), "frozen Web asset path must stay relative to the static root");
}

async function assertPrivateRegularFile(path, boundary, { requirePrivatePermissions = false } = {}) {
  const root = resolve(boundary);
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "private input root must be a real directory");
  assert.equal(await realpath(root), root, "private input root cannot resolve through a symlink");
  if (requirePrivatePermissions) {
    assert.equal(rootInfo.mode & 0o077, 0, "parent RunContext state directory must be private");
    assertOwnedByCurrentUser(rootInfo, "parent RunContext state directory");
  }
  const child = resolve(path);
  const rel = relative(root, child);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "private input escaped its authorized run/export root");
  let current = root;
  let targetInfo;
  const parts = rel.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    const currentInfo = await lstat(current);
    targetInfo = currentInfo;
    assert.ok(!currentInfo.isSymbolicLink(), "private input paths cannot traverse symlinks");
    if (index < parts.length - 1) assert.ok(currentInfo.isDirectory());
    else assert.ok(currentInfo.isFile());
  }
  assert.equal(await realpath(child), child);
  if (requirePrivatePermissions) {
    assert.equal(targetInfo.mode & 0o077, 0, "pairing fixture file must be private");
    assertOwnedByCurrentUser(targetInfo, "pairing fixture file");
  }
}

function assertOwnedByCurrentUser(info, label) {
  if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid(), `${label} must be owned by the current test user`);
}

function requiredOrigin(name) {
  const value = requiredInput(name);
  const parsed = new URL(value);
  assert.equal(parsed.origin, "https://hyf2333.top", "public UI child is limited to the authorized isolated HTTPS origin");
  assert.equal(parsed.pathname, "/");
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "");
  return parsed.origin;
}

function requiredInput(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for this explicitly launched public UI child suite`);
  return value;
}

function requiredSha256(name) {
  const value = requiredInput(name).toLowerCase();
  assert.match(value, /^[a-f0-9]{64}$/);
  return value;
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeErrorCategory(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  if (error?.code) return `code-${String(error.code).slice(0, 32)}`;
  return "request-error";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
