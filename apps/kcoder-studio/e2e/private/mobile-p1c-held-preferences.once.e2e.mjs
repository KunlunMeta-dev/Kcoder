import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { reuseMobileWebExport } from "../harness/mobile-web-export-reuse.mjs";
import { createMobileRenderProfileHelpers } from "../harness/mobile-render-profile-helpers.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { makeHistoryPage } from "./p1c-render-history.fixture.mjs";

const SOURCE_COMMIT = "9925461ca047031f3f7f37d1f039d986c305fec3";
const THREAD = "mock-active-session";
const SERVER = "local";
const PREFIX = "kcoder-studio:mobile-workspace-state:v3";
const DRAFT = "P1C_ORIGINAL_DRAFT";
const QUEUE = { id: "queued-p1c-original-id", content: "P1C_ORIGINAL_QUEUE", attachments: [], createdAt: 1 };
// An unknown item prevents automatic queue dispatch after hydration. No model call is needed.
const FAILED = { id: "p1c-original-failed-id", content: "P1C_ORIGINAL_FAILURE", attachments: [], createdAt: 1, outcome: "unknown", error: "P1C controlled unknown acceptance" };
const sha256 = value => createHash("sha256").update(value).digest("hex");
const { captureSeedFailureDom } = createMobileRenderProfileHelpers({ sha256, threadId: THREAD, serverId: SERVER });

await runE2E(import.meta.url, {
  testId: "mobile-p1c-held-preferences-mounted-web-once",
  tier: "manual-live",
  modelPolicy: "real Chromium, official Git992 Gateway-served HTML/assets and mounted Mobile UI; controlled Gateway mock and thread/read history; no Rust pagination, Provider, native, or performance-distribution claim",
}, async context => {
  const input = readInputs();
  const gatewayBefore = await hashGatewaySources();
  assert.equal(gatewayBefore.sha256, input.gatewaySourceSha256, "Gateway source must match its supplied pin");
  const exportBytes = await readFile(input.manifestPath);
  assert.equal(sha256(exportBytes), input.manifestSha256);
  assert.equal(JSON.parse(exportBytes).sourceCommit, SOURCE_COMMIT, "old Git174 export is not a P1C test input");
  const mobile = await reuseMobileWebExport(context, {
    bundleRoot: input.bundleRoot, manifestPath: input.manifestPath,
    expectedSourceTreeSha256: input.sourceTreeSha256, expectedManifestSha256: input.manifestSha256,
    expectedBundleSha256: input.bundleSha256, expectedBundleFileCount: input.fileCount,
    label: "p1c-git992-official-web", outputName: "p1c-git992-official-web",
  });
  const officialBytes = await readFile(input.staticManifestPath);
  assert.equal(sha256(officialBytes), input.staticManifestSha256);
  const official = JSON.parse(officialBytes);
  assert.deepEqual(official.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })), mobile.bundleFiles,
    "Gateway official manifest must bind the exact reuse manifest resources");
  await writeFile(resolve(mobile.path, "kcoder-mobile-web.json"), officialBytes, { flag: "wx", mode: 0o600 });
  const workspace = context.pathInState("p1c-workspace");
  await mkdir(workspace, { mode: 0o700 });
  const serversFile = await context.writeStateJson("p1c-servers.json", [{
    id: SERVER, label: "P1C fixture", runtime: "kcoder", transport: "local",
    workspacePath: workspace, command: process.execPath,
  }]);
  const gateway = await startGateway(context, { auth: true, label: "p1c-gateway", workspace, serversFile,
    env: { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_WEB_ROOT: "", KCODER_STUDIO_MOBILE_WEB_ROOT: mobile.path },
  });
  const chromium = await startChromium(context, { label: "p1c-chromium" });
  const browserContext = await chromium.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "zh-CN" });
  context.addCleanup("close P1C Browser context", () => browserContext.close());
  const page = await browserContext.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(context.redactText(error.message).slice(0, 500)));
  const responses = [];
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin === gateway.baseUrl && (url.pathname.startsWith("/mobile/") || url.pathname === "/mobile-entry"))
      responses.push({ path: url.pathname, status: response.status() });
  });
  const history = installHistoryFixture(page, workspace);
  const gate = await installPreferenceGate(page);
  const cases = [];
  try {
    await pairThroughUi(page, gateway);
    await page.getByTestId(`thread-${THREAD}`).click();
    await page.getByTestId("message-input").waitFor({ state: "visible" });
    const taskUrl = page.url();
    await page.getByTestId("message-input").fill(DRAFT);
    const key = await waitFor(() => findExactStoredScope(page), 10_000, "observed exact task scope key with original draft", 25, context.abortSignal);
    assert.ok(key);

    // Hydrate the durable recovery seed into a fresh runtime before testing hot
    // reuse. A live runtime intentionally hydrates its failed store only once.
    await seedState(page, key);
    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    await assertRestored(page, key);
    assert.equal(history.mutations.length, 0, "unknown recovery must block automatic queue dispatch");

    // A hot registry runtime: navigate away through the real header, seed only the
    // previously observed owner key, and re-enter through the actual thread row.
    await backToHome(page);
    await seedState(page, key);
    await gate.arm(key, "hold");
    const hotResumeCount = history.count("thread/resume");
    await page.getByTestId(`thread-${THREAD}`).click();
    await gate.waitReached();
    await assertReadOnly(page, history);
    assert.equal(history.count("thread/resume"), hotResumeCount, "hot task must retain its same runtime");
    cases.push(await releaseAndVerify(page, gate, history, workspace, key, "hot"));

    // A full navigation destroys the JavaScript runtime registry. The one exact
    // scoped preference read remains held while authorized cold resume/history runs.
    await backToHome(page);
    await seedState(page, key);
    await gate.arm(key, "hold");
    const coldResumes = history.count("thread/resume");
    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    await gate.waitReached();
    await assertReadOnly(page, history);
    assert.equal(history.count("thread/resume"), coldResumes + 1, "cold resume must occur once while preferences are pending");
    cases.push(await releaseAndVerify(page, gate, history, workspace, key, "cold"));
    assert.equal(history.count("thread/resume"), coldResumes + 1, "preferences must not restart cold resume");

    await backToHome(page);
    await seedState(page, key);
    await gate.arm(key, "reject");
    await page.getByTestId(`thread-${THREAD}`).click();
    await gate.waitReached();
    await assertReadOnly(page, history);
    assert.match(await page.getByTestId("task-workspace-recovery").innerText(), /P1C controlled preference read failure/);
    await page.getByTestId("load-older-messages").scrollIntoViewIfNeeded();
    const before = history.pages.length;
    await page.getByTestId("load-older-messages").click();
    await waitFor(() => history.pages.length === before + 1, 5_000, "pagination while local prefs have failed", 25, context.abortSignal);
    await page.getByRole("button", { name: "重试恢复", exact: true }).click();
    await assertRestored(page, key);
    cases.push({ name: "reject-retry", historyStayedVisible: true, olderPageRequests: 1, originalLocalIdsRestored: true });
    assert.equal(history.mutations.length, 0, "read-only transitions and local recovery must not dispatch mutations");
    assert.deepEqual(errors, [], "no unhandled Browser errors");
    assert.ok(responses.some(row => row.path.endsWith(".js") && row.status === 200), "actual Expo JS must load from the Gateway");
    assert.ok(responses.every(row => row.status >= 200 && row.status < 400), "all observed Mobile mount responses must succeed");
    const gatewayAfter = await hashGatewaySources();
    assert.equal(gatewayAfter.sha256, gatewayBefore.sha256, "Gateway source changed during run");
    const result = { status: "PASS", sourceCommit: SOURCE_COMMIT, evidenceKind: "MOUNTED_CHROMIUM_CONTROLLED_HISTORY_NOT_RUST_PAGINATION",
      bundleSha256: mobile.bundleSha256, sourceTreeSha256: mobile.sourceTreeSha256, bundleFileCount: mobile.bundleFileCount,
      officialManifestSha256: input.staticManifestSha256, scopeKeySha256: sha256(key), gatewaySourceSha256: gatewayBefore.sha256,
      cases, historyPages: history.pages, mutationCount: history.mutations.length, responseCount: responses.length, browserErrors: errors };
    await context.writeArtifactJson("p1c-held-preferences-result.json", result);
    return result;
  } catch (error) {
    await context.writeArtifactJson("p1c-held-preferences-failure.json", { cases, historyPages: history.pages, mutationMethods: history.mutations,
      browserErrors: errors, viewport: await captureSeedFailureDom(page, { workspacePath: workspace }, "HISTORY-").catch(() => null) });
    throw error;
  } finally { await gate.release(); }
});

function installHistoryFixture(page, workspace) {
  const state = { pages: [], methods: [], mutations: [], count: method => state.methods.filter(row => row === method).length };
  page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    const requests = new Map();
    const url = new URL(socket.url());
    const scoped = url.searchParams.get("server") === SERVER && url.searchParams.get("workspace") === workspace;
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.method) {
        state.methods.push(request.method);
        if (/^(turn\/(?:start|steer|interrupt)|thread\/(?:start|delete|metadata\/update)|attachment\/(?:save|delete|upload\/)|(?:approval|question)\/.*(?:respond|answer)|workspace\/.*(?:write|delete))/.test(request.method)) state.mutations.push(request.method);
        if (request.id !== undefined) requests.set(String(request.id), request);
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      const response = JSON.parse(String(raw));
      const request = requests.get(String(response.id));
      if (scoped && request?.method === "thread/read" && request.params?.threadId === THREAD && request.params?.limit !== 1) {
        const data = makeHistoryPage(200, request.params.beforeCursor, request.params.limit, workspace);
        response.result = { thread: { id: THREAD, title: "P1C controlled history", status: "idle", cwd: workspace, model: "mock-mobile" }, ...data };
        state.pages.push({ cursor: request.params.beforeCursor ?? null, start: data.rangeStart, end: data.rangeEnd });
        raw = JSON.stringify(response);
      }
      requests.delete(String(response.id));
      socket.send(raw);
    });
  });
  return state;
}

async function installPreferenceGate(page) {
  let release = () => {};
  let reached = false;
  let mode = "hold";
  await page.exposeFunction("__p1cHoldExactPreferenceRead", async key => {
    assert.equal(typeof key, "string");
    reached = true;
    if (mode === "reject") throw new Error("P1C controlled preference read failure");
    await new Promise(resolve => { release = resolve; });
  });
  await page.addInitScript(() => {
    const nativeGet = Storage.prototype.getItem;
    const configKey = "p1c-test-exact-preference-read";
    let used = false;
    Storage.prototype.getItem = function (key) {
      if (this !== window.localStorage || used) return nativeGet.call(this, key);
      const target = nativeGet.call(window.sessionStorage, configKey);
      if (!target || key !== target) return nativeGet.call(this, key);
      used = true;
      // AsyncStorage Web 2.2 createPromise resolves getValue(), so this Promise
      // delays only this read while the real package/store/hooks remain mounted.
      return window.__p1cHoldExactPreferenceRead(key).then(() => nativeGet.call(this, key));
    };
    window.__p1cArmRead = key => { used = false; window.sessionStorage.setItem(configKey, key); };
  });
  return {
    arm: async (key, nextMode) => { reached = false; mode = nextMode; await page.evaluate(key => window.__p1cArmRead(key), key); },
    waitReached: () => waitFor(() => reached, 10_000, "one exact scoped AsyncStorage preference read", 25),
    release: async () => { release(); await page.evaluate(() => window.sessionStorage.removeItem("p1c-test-exact-preference-read")).catch(() => {}); },
  };
}

async function assertReadOnly(page, history) {
  await page.getByTestId("task-workspace-recovery").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("task-header").waitFor({ state: "visible" });
  await page.getByTestId("message-list").waitFor({ state: "visible" });
  assert.ok(await page.getByTestId("message-list").getByText(/HISTORY-\d{4}/).count() > 0, "history is rendered before local prefs settle");
  assert.equal(await page.getByTestId("task-header").getByRole("button", { name: "返回", exact: true }).count(), 1);
  assert.equal(await page.getByTestId("task-header").getByRole("button", { name: "返回", exact: true }).isEnabled(), true);
  for (const id of ["message-input-root", "queued-messages", "failed-submissions", "workspace-tab-switcher", "subagents-panel"])
    assert.equal(await page.getByTestId(id).count(), 0, `${id} must not mount before preferences are ready`);
  for (const name of ["打开任务列表", "更多", "从设备文件系统添加附件"])
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, `${name} must not be writable before preferences are ready`);
  assert.equal(history.mutations.length, 0);
}

async function releaseAndVerify(page, gate, history, workspace, key, name) {
  await page.getByTestId("load-older-messages").scrollIntoViewIfNeeded();
  const pageCount = history.pages.length;
  await page.getByTestId("load-older-messages").click();
  await waitFor(() => history.pages.length === pageCount + 1, 5_000, "one real older-page click", 25);
  // Read a point away from both edges before writable UI changes viewport height.
  await page.getByTestId("message-list").hover();
  await page.mouse.wheel(0, 280);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = await waitFor(() => saveAnchor(page), 5_000, "visible history anchor", 25);
  const snapshot = await captureSeedFailureDom(page, { workspacePath: workspace }, before.marker);
  const cursorsBefore = history.pages.length;
  await gate.release();
  await assertRestored(page, key);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await waitFor(() => checkAnchor(page), 5_000, "same transcript DOM and anchor after preferences", 25);
  assert.equal(after.sameList, true); assert.equal(after.sameHost, true);
  assert.equal(after.sameAnchor, true); assert.ok(Math.abs(after.offset - before.offset) <= 3, "read-only transition must retain history reading position");
  assert.equal(history.pages.length, cursorsBefore, "preference readiness must not refetch/reset pagination");
  assert.equal(history.mutations.length, 0);
  return { name, olderPageRequests: 1, before, after, viewportBeforeRelease: snapshot, originalLocalIdsRestored: true };
}

async function saveAnchor(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    if (!(list instanceof HTMLElement)) return null;
    const scrollables = [list, ...list.querySelectorAll("*")].filter(node => node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 16)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const host = list.querySelector("[data-phone-ux-scroll-host]") ?? scrollables[0] ?? list;
    const box = host.getBoundingClientRect();
    const row = [...list.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]')]
      .find(node => { const r = node.getBoundingClientRect(); return r.bottom > box.top + 40 && r.top < box.bottom - 40; });
    const marker = row?.textContent?.match(/HISTORY-\d{4}/)?.[0];
    if (!row || !marker) return null;
    window.__p1cSavedAnchor = { list, host, row, marker };
    return { marker, offset: row.getBoundingClientRect().top - box.top };
  });
}

async function checkAnchor(page) {
  return page.evaluate(() => {
    const saved = window.__p1cSavedAnchor;
    if (!saved) return null;
    const list = document.querySelector('[data-testid="message-list"]');
    const row = [...(list?.querySelectorAll('[data-testid="message-user"], [data-testid="message-assistant"]') ?? [])].find(node => node.textContent?.includes(saved.marker));
    if (!row) return null;
    const scrollables = [list, ...list.querySelectorAll("*")].filter(node => node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 16)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const host = list.querySelector("[data-phone-ux-scroll-host]") ?? scrollables[0] ?? list;
    return { sameList: list === saved.list, sameHost: host === saved.host, sameAnchor: row === saved.row,
      offset: row.getBoundingClientRect().top - saved.host.getBoundingClientRect().top };
  });
}

async function assertRestored(page, key) {
  await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.getByTestId("task-workspace-recovery").count(), 0);
  assert.equal(await page.getByTestId("message-input").inputValue(), DRAFT);
  assert.ok(await page.getByTestId("queued-message-0").innerText().then(text => text.includes(QUEUE.content)));
  assert.equal(await page.getByTestId("failed-submission-content").innerText(), FAILED.content);
  const ids = await page.evaluate(key => { const state = JSON.parse(localStorage.getItem(key)); return { queued: state.queuedMessages.map(row => row.id), failed: state.failedSubmissions.map(row => row.id) }; }, key);
  assert.deepEqual(ids, { queued: [QUEUE.id], failed: [FAILED.id] });
  assert.equal(await page.getByTestId("message-input").isEditable(), true);
}

async function backToHome(page) {
  await page.getByTestId("task-header").getByRole("button", { name: "返回", exact: true }).click();
  await page.getByTestId(`thread-${THREAD}`).waitFor({ state: "visible", timeout: 15_000 });
}

async function seedState(page, key) {
  await page.evaluate(({ key, draft, queued, failed }) => {
    const original = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ ...original, activeTab: "agent", activePanelId: "agent", composerDraft: draft, queuedMessages: [queued], failedSubmissions: [failed] }));
  }, { key, draft: DRAFT, queued: QUEUE, failed: FAILED });
}

async function findExactStoredScope(page) {
  return page.evaluate(({ prefix, draft, thread, server }) => {
    const matches = Object.keys(localStorage).filter(key => {
      if (!key.startsWith(`${prefix}:`)) return false;
      const parts = key.slice(prefix.length + 1).split(":");
      if (parts.length !== 5 || parts[3] !== "scope" || decodeURIComponent(parts[1]) !== server || decodeURIComponent(parts[2]) !== thread) return false;
      try { return JSON.parse(localStorage.getItem(key))?.composerDraft === draft; } catch { return false; }
    });
    if (matches.length > 1) throw new Error("ambiguous task scope key");
    return matches[0] ?? null;
  }, { prefix: PREFIX, draft: DRAFT, thread: THREAD, server: SERVER });
}

async function pairThroughUi(page, gateway) {
  const entry = await fetch(`${gateway.baseUrl}/mobile-entry`).then(response => response.json());
  assert.equal(entry.available, true); assert.equal(entry.gatewayUrl, gateway.baseUrl);
  const response = await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId(`thread-${THREAD}`).waitFor({ state: "visible", timeout: 30_000 });
}

function readInputs() {
  const required = key => { const value = process.env[`KCODER_E2E_P1C_${key}`]; assert.ok(value, `UNMET_PREREQUISITE: ${key}`); return value; };
  const digest = key => { const value = required(key); assert.match(value, /^[a-f0-9]{64}$/); return value; };
  const path = key => { const value = required(key); assert.equal(resolve(value), value); return value; };
  const fileCount = Number(required("FILE_COUNT")); assert.ok(Number.isSafeInteger(fileCount) && fileCount > 0 && fileCount < 100);
  return { bundleRoot: path("BUNDLE_ROOT"), manifestPath: path("MANIFEST"), manifestSha256: digest("MANIFEST_SHA256"),
    staticManifestPath: path("STATIC_MANIFEST"), staticManifestSha256: digest("STATIC_MANIFEST_SHA256"),
    sourceTreeSha256: digest("SOURCE_TREE_SHA256"), bundleSha256: digest("BUNDLE_SHA256"), gatewaySourceSha256: digest("GATEWAY_SOURCE_SHA256"), fileCount };
}

async function hashGatewaySources() {
  const names = ["dev-server.mjs", "package.json", "pnpm-lock.yaml"];
  const visit = async prefix => {
    for (const entry of await readdir(resolve(repoRoot, "apps/kcoder-studio", prefix), { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, "Gateway source symlink is not accepted");
      if (entry.isDirectory()) await visit(`${prefix}/${entry.name}`);
      else if (/\.(?:js|mjs)$/.test(entry.name)) names.push(`${prefix}/${entry.name}`);
    }
  };
  await visit("src"); names.sort();
  const files = await Promise.all(names.map(async path => ({ path, sha256: sha256(await readFile(resolve(repoRoot, "apps/kcoder-studio", path))) })));
  return { files, sha256: sha256(files.map(row => `${row.path}\0${row.sha256}\n`).join("")) };
}
