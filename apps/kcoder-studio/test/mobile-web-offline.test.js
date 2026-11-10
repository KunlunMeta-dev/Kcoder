import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  createMobileWebOfflineArtifacts,
  MOBILE_OFFLINE_BUILD_DIGEST_HEADER,
  MOBILE_OFFLINE_GENERATION_HEADER,
  MOBILE_OFFLINE_LIMITS,
  injectMobileWebOfflineRegistration,
} from "../src/mobile-web-offline.js";

const ORIGIN = "https://mobile-gateway.example";
const BASE_TOKEN = "/__kcoder_mobile_mount_v1__";

// Node VM with fake CacheStorage/fetch verifies the worker protocol; this is not Browser evidence.
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makeFixture({ mountBasePath = "/mobile", variant = "v1" } = {}) {
  const source = new Map([
    ["index.html", `<!doctype html><html><head></head><body data-shell="${variant}"><script src="${BASE_TOKEN}/_expo/app.js"></script></body></html>`],
    ["_expo/app.js", `globalThis.mobileBase="${BASE_TOKEN}";`],
    ["assets/main.css", `:root{--build:"${variant}"}`],
    ["assets/fonts/ui.woff2", "fixture-font-bytes"],
    ["foo/index.html", `<html data-route="nested-index-${variant}"></html>`],
    ["h/[profileId]/index.html", `<html data-route="profile-${variant}"><script src="${BASE_TOKEN}/_expo/app.js"></script></html>`],
    ["h/[profileId]/task/[serverId]/[threadId].html", `<html data-route="task-${variant}"><script src="${BASE_TOKEN}/_expo/app.js"></script></html>`],
  ]);
  const files = new Map();
  for (const [path, content] of source) {
    const bytes = Buffer.from(content, "utf8");
    const text = !path.endsWith(".woff2");
    files.set(path, {
      size: bytes.length,
      sha256: sha256(bytes),
      text,
      replacements: text ? content.split(BASE_TOKEN).length - 1 : 0,
    });
  }
  const dynamicPages = [
    { name: "h/[profileId]/index.html", segments: ["h", "[profileId]"] },
    { name: "h/[profileId]/task/[serverId]/[threadId].html", segments: ["h", "[profileId]", "task", "[serverId]", "[threadId]"] },
  ];
  const manifestSha256 = sha256(JSON.stringify({
    files: [...files.entries()],
    dynamicPages,
    variant,
  }));
  return {
    artifact: createMobileWebOfflineArtifacts({ files, dynamicPages, manifestSha256, mountBasePath }),
    files,
    source,
    dynamicPages,
    manifestSha256,
    mountBasePath,
  };
}

function responseFor(url, body, { status = 200, headers = {}, redirected = false, type = "basic" } = {}) {
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, "url", { value: url, configurable: true });
  Object.defineProperty(response, "redirected", { value: redirected, configurable: true });
  Object.defineProperty(response, "type", { value: type, configurable: true });
  return response;
}

function makeStaticFetch(fixture, overrides = {}) {
  const { artifact, source, files, mountBasePath, manifestSha256 } = fixture;
  const scopePath = artifact.metadata.scopePath;
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname.slice(scopePath.length));
    calls.push({ url: url.href, path, options });
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    const override = overrides[path];
    if (override?.status) {
      return responseFor(override.responseUrl ?? url.href, override.body ?? "", {
        status: override.status,
        headers: override.headers ?? {},
        redirected: override.redirected ?? false,
        type: override.type ?? "basic",
      });
    }
    const original = source.get(path);
    if (original === undefined) return responseFor(url.href, "missing", { status: 404 });
    let body = files.get(path).text ? original.replaceAll(BASE_TOKEN, mountBasePath) : original;
    if (path.endsWith(".html")) body = injectMobileWebOfflineRegistration(body, artifact.registrationMarkup);
    return responseFor(override?.responseUrl ?? url.href, override?.body ?? body, {
      headers: {
        "content-type": path.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream",
        [MOBILE_OFFLINE_BUILD_DIGEST_HEADER]: override?.buildSha ?? manifestSha256,
        [MOBILE_OFFLINE_GENERATION_HEADER]: override?.generation ?? artifact.metadata.generation,
      },
      redirected: override?.redirected ?? false,
      type: override?.type ?? "basic",
    });
  };
  return { fetch, calls, get maximumActive() { return maximumActive; } };
}

function gatewayPublishedBody(fixture, path) {
  const { source, files, mountBasePath, artifact } = fixture;
  const row = files.get(path);
  let body = row.text ? source.get(path).replaceAll(BASE_TOKEN, mountBasePath) : source.get(path);
  if (path.endsWith(".html")) body = injectMobileWebOfflineRegistration(body, artifact.registrationMarkup);
  return body;
}

class MemoryCache {
  constructor() { this.rows = new Map(); }
  async put(request, response) {
    const key = typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
    this.rows.set(key, response.clone());
  }
  async match(request) {
    const key = typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
    return this.rows.get(key)?.clone() ?? undefined;
  }
}

class MemoryCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MemoryCache());
    return this.caches.get(name);
  }
  async keys() { return [...this.caches.keys()]; }
  async delete(name) { return this.caches.delete(name); }
}

function createWorkerRuntime(artifact, staticFetch, caches = new MemoryCacheStorage(), runtimeOptions = {}) {
  const handlers = new Map();
  let skipWaitingCalls = 0;
  let claimCalls = 0;
  const self = {
    location: { origin: ORIGIN },
    registration: { scope: new URL(artifact.metadata.scopePath, ORIGIN).href },
    clients: { claim: async () => { claimCalls += 1; } },
    skipWaiting: async () => { skipWaitingCalls += 1; },
    addEventListener(type, listener) { handlers.set(type, listener); },
  };
  runInNewContext(artifact.workerCode, {
    self,
    caches,
    fetch: staticFetch,
    URL,
    Response,
    Headers,
    Uint8Array,
    Promise,
    Map,
    Set,
    Array,
    JSON,
    Error,
    AbortController,
    ReadableStream,
    setTimeout: runtimeOptions.setTimeout ?? setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
  });
  const dispatchLifecycle = async type => {
    const pending = [];
    handlers.get(type)({ waitUntil(value) { pending.push(Promise.resolve(value)); } });
    await Promise.all(pending);
  };
  const dispatchFetch = async ({ url, method = "GET", mode = "no-cors", headers = {} }) => {
    let responsePromise;
    handlers.get("fetch")({
      request: { url, method, mode, headers: { get: name => headers[name.toLowerCase()] ?? null } },
      respondWith(value) { assert.equal(responsePromise, undefined, "fetch event must be intercepted once"); responsePromise = Promise.resolve(value); },
    });
    return responsePromise === undefined
      ? { intercepted: false, response: null }
      : { intercepted: true, response: await responsePromise };
  };
  return {
    caches,
    dispatchLifecycle,
    dispatchFetch,
    get skipWaitingCalls() { return skipWaitingCalls; },
    get claimCalls() { return claimCalls; },
  };
}

async function cachedBody(runtime, url) {
  for (const name of await runtime.caches.keys()) {
    const hit = await (await runtime.caches.open(name)).match(url);
    if (hit) return hit.text();
  }
  return null;
}

test("artifacts bind the browser-visible mount and fail closed on cache budget overflow", () => {
  const direct = makeFixture({ mountBasePath: "/mobile" }).artifact;
  const relayA = makeFixture({ mountBasePath: "/g/tenant_A/mobile" }).artifact;
  const relayB = makeFixture({ mountBasePath: "/g/tenant_B/mobile" }).artifact;
  assert.equal(direct.enabled, true);
  assert.equal(direct.metadata.scopePath, "/mobile/");
  assert.equal(relayA.metadata.scopePath, "/g/tenant_A/mobile/");
  assert.notEqual(relayA.metadata.cachePrefix, relayB.metadata.cachePrefix);
  assert.equal(relayA.metadata.expectedBuildId, makeFixture({ mountBasePath: "/g/tenant_A/mobile" }).manifestSha256);
  assert.equal(relayA.metadata.buildDigestHeader, "x-kcoder-mobile-build-sha256");
  assert.equal(relayA.metadata.generationHeader, "x-kcoder-mobile-shell-generation");
  assert.match(relayA.registrationMarkup, /window\.isSecureContext/);
  assert.match(relayA.registrationMarkup, /serviceWorker\.register/);
  assert.match(relayA.registrationMarkup, /\/g\/tenant_A\/mobile\//);
  assert.ok(relayA.metadata.workerCodeBytes <= MOBILE_OFFLINE_LIMITS.workerBytes);
  assert.ok(relayA.metadata.totalBytes < MOBILE_OFFLINE_LIMITS.totalBytes);
  assert.equal(relayA.metadata.htmlInjectionBytes, Buffer.byteLength(relayA.registrationMarkup));
  const workerConfig = JSON.parse(/^const CONFIG = (.*);$/m.exec(relayA.workerCode)[1]);
  const relayFixture = makeFixture({ mountBasePath: "/g/tenant_A/mobile" });
  for (const asset of workerConfig.assets) {
    assert.equal(Buffer.byteLength(gatewayPublishedBody(relayFixture, asset.path)), asset.bytes, asset.path);
  }

  const fullFixture = relayFixture;
  const homeOnly = createMobileWebOfflineArtifacts({
    files: fullFixture.files,
    dynamicPages: [fullFixture.dynamicPages[0]],
    manifestSha256: fullFixture.manifestSha256,
    mountBasePath: fullFixture.mountBasePath,
  });
  assert.notEqual(homeOnly.metadata.configurationSha256, fullFixture.artifact.metadata.configurationSha256);
  assert.notEqual(homeOnly.metadata.cacheName, fullFixture.artifact.metadata.cacheName);

  assert.equal(injectMobileWebOfflineRegistration("<html><head></head><body></body></html>", "<script>x</script>"),
    "<html><head><script>x</script></head><body></body></html>");
  assert.equal(injectMobileWebOfflineRegistration("<html><body></body></html>", "<script>x</script>"),
    "<html><body><script>x</script></body></html>");
  assert.equal(injectMobileWebOfflineRegistration("<html>", "<script>x</script>"), "<html><script>x</script>");

  const tooMany = new Map(makeFixture().files);
  for (let index = 0; index <= MOBILE_OFFLINE_LIMITS.assets; index += 1) {
    const path = `assets/extra-${index}.js`;
    tooMany.set(path, { size: 1, sha256: "a".repeat(64), text: false, replacements: 0 });
  }
  const overCount = createMobileWebOfflineArtifacts({
    files: tooMany,
    dynamicPages: [],
    manifestSha256: "b".repeat(64),
    mountBasePath: "/mobile",
  });
  assert.equal(overCount.enabled, false);
  assert.equal(overCount.metadata.reason, "asset-count-limit");
  assert.equal(overCount.registrationMarkup, "");
  assert.equal(overCount.workerCode, "");

  const tooLarge = new Map([[
    "index.html", { size: 1, sha256: "c".repeat(64), text: false, replacements: 0 },
  ]]);
  for (let index = 0; index < 3; index += 1) {
    tooLarge.set(`assets/large-${index}.js`, {
      size: 6 * 1024 * 1024,
      sha256: "d".repeat(64),
      text: false,
      replacements: 0,
    });
  }
  const overBytes = createMobileWebOfflineArtifacts({
    files: tooLarge,
    dynamicPages: [],
    manifestSha256: "e".repeat(64),
    mountBasePath: "/mobile",
  });
  assert.equal(overBytes.enabled, false);
  assert.equal(overBytes.metadata.reason, "total-byte-limit");

  const reservedFixture = makeFixture();
  const reservedFiles = new Map(reservedFixture.files);
  reservedFiles.set("api/mobile/session.json", { size: 0, sha256: "a".repeat(64), text: false, replacements: 0 });
  const reserved = createMobileWebOfflineArtifacts({
    files: reservedFiles,
    dynamicPages: reservedFixture.dynamicPages,
    manifestSha256: reservedFixture.manifestSha256,
    mountBasePath: "/mobile",
  });
  assert.equal(reserved.enabled, false);
  assert.equal(reserved.metadata.reason, "reserved-resource-path");
});

test("worker installs a complete bounded cache and serves only exact static assets or safe navigations", async () => {
  const fixture = makeFixture({ mountBasePath: "/g/tenant_A/mobile" });
  const network = makeStaticFetch(fixture);
  const runtime = createWorkerRuntime(fixture.artifact, network.fetch);
  await runtime.dispatchLifecycle("install");
  assert.equal(network.calls.length, fixture.artifact.metadata.assetCount);
  assert.ok(network.maximumActive > 1 && network.maximumActive <= MOBILE_OFFLINE_LIMITS.concurrency);
  assert.ok(network.calls.every(call => call.options.method === "GET" &&
    call.options.mode === "same-origin" && call.options.credentials === "omit" &&
    call.options.cache === "no-store" && call.options.redirect === "error" &&
    call.options.signal instanceof AbortSignal));
  assert.equal(fixture.artifact.metadata.assetTimeoutMs, MOBILE_OFFLINE_LIMITS.assetTimeoutMs);

  const root = await runtime.dispatchFetch({ url: `${ORIGIN}/g/tenant_A/mobile/`, mode: "navigate" });
  assert.equal(root.intercepted, true);
  assert.match(await root.response.text(), /data-shell="v1"/);
  const home = await runtime.dispatchFetch({
    url: `${ORIGIN}/g/tenant_A/mobile/h/profile.1`,
    mode: "navigate",
  });
  assert.equal(home.intercepted, true);
  assert.match(await home.response.text(), /data-route="profile-v1"/);

  const appUrl = `${ORIGIN}/g/tenant_A/mobile/_expo/app.js`;
  const app = await runtime.dispatchFetch({ url: appUrl });
  assert.equal(app.intercepted, true);
  assert.match(await app.response.text(), /\/g\/tenant_A\/mobile/);

  const task = await runtime.dispatchFetch({
    url: `${ORIGIN}/g/tenant_A/mobile/h/profile.1/task/server.2/thread.3`,
    mode: "navigate",
  });
  assert.equal(task.intercepted, true);
  assert.match(await task.response.text(), /data-route="task-v1"/);
  const fallback = await runtime.dispatchFetch({
    url: `${ORIGIN}/g/tenant_A/mobile/an-unknown-route`,
    mode: "navigate",
  });
  assert.equal(fallback.intercepted, true);
  assert.match(await fallback.response.text(), /data-shell="v1"/);
  const nestedIndexFallback = await runtime.dispatchFetch({
    url: `${ORIGIN}/g/tenant_A/mobile/foo`,
    mode: "navigate",
  });
  assert.equal(nestedIndexFallback.intercepted, true);
  const nestedIndexBody = await nestedIndexFallback.response.text();
  assert.match(nestedIndexBody, /data-shell="v1"/);
  assert.doesNotMatch(nestedIndexBody, /nested-index-v1/);

  for (const request of [
    { url: `${appUrl}?token=must-not-be-cached` },
    { url: `${appUrl}#fragment-must-not-be-cached` },
    { url: appUrl, headers: { authorization: "Bearer must-not-be-cached" } },
    { url: `${ORIGIN}/g/tenant_A/mobile/h/profile.1?returnTo=%2Fmobile`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/mobile/h/profile%5cadmin`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/mobile/h/profile%01`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/mobile/h/profile%2e1`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/mobile/h/profile%2fadmin`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/mobile/h/%2e%2e/api`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/mobile/h/profile.1//`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/mobile/_expo/unknown.js` },
    { url: `${ORIGIN}/g/tenant_A/mobile/api/mobile/session`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/mobile/session`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/mobile/refresh`, mode: "navigate" },
    { url: `${ORIGIN}/g/tenant_A/api/mobile/session` },
    { url: `${ORIGIN}/g/tenant_A/api/mobile/session/refresh` },
    { url: `${ORIGIN}/g/tenant_A/rpc` },
    { url: `${ORIGIN}/g/tenant_A/mobile-entry` },
    { url: `https://other.example/g/tenant_A/mobile/_expo/app.js` },
    { url: appUrl, method: "POST" },
  ]) {
    assert.equal((await runtime.dispatchFetch(request)).intercepted, false, JSON.stringify(request));
  }
  const cached = await cachedBody(runtime, appUrl);
  assert.match(cached, /tenant_A/);
});

test("failed or mixed-build precache deletes only its candidate and preserves old/peer mounts", async () => {
  const oldA = makeFixture({ mountBasePath: "/g/tenant_A/mobile", variant: "old" });
  const oldB = makeFixture({ mountBasePath: "/g/tenant_B/mobile", variant: "peer" });
  const caches = new MemoryCacheStorage();
  const runtimeOldA = createWorkerRuntime(oldA.artifact, makeStaticFetch(oldA).fetch, caches);
  const runtimeOldB = createWorkerRuntime(oldB.artifact, makeStaticFetch(oldB).fetch, caches);
  await runtimeOldA.dispatchLifecycle("install");
  await runtimeOldB.dispatchLifecycle("install");

  for (const [name, override] of [
    ["status", { status: 503 }],
    ["redirect", { redirected: true, responseUrl: `${ORIGIN}/elsewhere.js` }],
    ["origin", { responseUrl: "https://other.example/g/tenant_A/mobile/_expo/app.js" }],
    ["digest", { buildSha: "f".repeat(64) }],
    ["generation", { generation: "f".repeat(64) }],
    ["bytes", { body: "different published byte length" }],
  ]) {
    const nextA = makeFixture({ mountBasePath: "/g/tenant_A/mobile", variant: `new-${name}` });
    const failPath = "_expo/app.js";
    const network = makeStaticFetch(nextA, { [failPath]: override });
    const runtimeNextA = createWorkerRuntime(nextA.artifact, network.fetch, caches);
    await assert.rejects(runtimeNextA.dispatchLifecycle("install"), /installation failed/);
    const names = await caches.keys();
    assert.ok(names.includes(oldA.artifact.metadata.cacheName), `${name}: previous A cache remains`);
    assert.ok(names.includes(oldB.artifact.metadata.cacheName), `${name}: peer B cache remains`);
    assert.ok(!names.includes(nextA.artifact.metadata.cacheName), `${name}: failed candidate cache is removed`);
  }
});

test("oversize body cancellation completes and removes only its incomplete candidate", async () => {
  const oldA = makeFixture({ mountBasePath: "/g/tenant_A/mobile", variant: "old" });
  const peerB = makeFixture({ mountBasePath: "/g/tenant_B/mobile", variant: "peer" });
  const nextA = makeFixture({ mountBasePath: "/g/tenant_A/mobile", variant: "oversize" });
  const caches = new MemoryCacheStorage();
  await createWorkerRuntime(oldA.artifact, makeStaticFetch(oldA).fetch, caches).dispatchLifecycle("install");
  await createWorkerRuntime(peerB.artifact, makeStaticFetch(peerB).fetch, caches).dispatchLifecycle("install");

  const workerConfig = JSON.parse(/^const CONFIG = (.*);$/m.exec(nextA.artifact.workerCode)[1]);
  const path = "_expo/app.js";
  const asset = workerConfig.assets.find(row => row.path === path);
  let cancelled = false;
  const oversizedBody = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(asset.bytes + 1)); },
    cancel() { cancelled = true; },
  });
  const network = makeStaticFetch(nextA, { [path]: { body: oversizedBody } });
  const runtime = createWorkerRuntime(nextA.artifact, network.fetch, caches);
  await assert.rejects(runtime.dispatchLifecycle("install"), /installation failed/);
  assert.equal(cancelled, true, "oversize stream is cancelled without a tee branch left open");
  const names = await caches.keys();
  assert.ok(names.includes(oldA.artifact.metadata.cacheName));
  assert.ok(names.includes(peerB.artifact.metadata.cacheName));
  assert.ok(!names.includes(nextA.artifact.metadata.cacheName));
});

test("a stalled resource fetch aborts within its deadline and preserves older mounts", async () => {
  const oldA = makeFixture({ mountBasePath: "/g/tenant_A/mobile", variant: "old" });
  const peerB = makeFixture({ mountBasePath: "/g/tenant_B/mobile", variant: "peer" });
  const nextA = makeFixture({ mountBasePath: "/g/tenant_A/mobile", variant: "stalled" });
  const caches = new MemoryCacheStorage();
  await createWorkerRuntime(oldA.artifact, makeStaticFetch(oldA).fetch, caches).dispatchLifecycle("install");
  await createWorkerRuntime(peerB.artifact, makeStaticFetch(peerB).fetch, caches).dispatchLifecycle("install");

  const normal = makeStaticFetch(nextA);
  let aborted = false;
  const stalledFetch = (input, options) => {
    const path = new URL(input).pathname.slice(nextA.artifact.metadata.scopePath.length);
    if (path !== "_expo/app.js") return normal.fetch(input, options);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("fetch aborted by asset deadline"));
      }, { once: true });
    });
  };
  const runtime = createWorkerRuntime(nextA.artifact, stalledFetch, caches, {
    setTimeout: (callback, _delay) => setTimeout(callback, 0),
  });
  await assert.rejects(runtime.dispatchLifecycle("install"), /installation failed/);
  assert.equal(aborted, true, "per-asset AbortController deadline terminates stalled fetch");
  const names = await caches.keys();
  assert.ok(names.includes(oldA.artifact.metadata.cacheName));
  assert.ok(names.includes(peerB.artifact.metadata.cacheName));
  assert.ok(!names.includes(nextA.artifact.metadata.cacheName));
});

test("successful upgrade waits for activation before deleting only its own older generation", async () => {
  const oldA = makeFixture({ mountBasePath: "/g/tenant_A/mobile", variant: "old" });
  const peerB = makeFixture({ mountBasePath: "/g/tenant_B/mobile", variant: "peer" });
  const nextA = makeFixture({ mountBasePath: "/g/tenant_A/mobile", variant: "new" });
  const caches = new MemoryCacheStorage();
  const oldRuntime = createWorkerRuntime(oldA.artifact, makeStaticFetch(oldA).fetch, caches);
  const peerRuntime = createWorkerRuntime(peerB.artifact, makeStaticFetch(peerB).fetch, caches);
  await oldRuntime.dispatchLifecycle("install");
  await peerRuntime.dispatchLifecycle("install");

  const nextRuntime = createWorkerRuntime(nextA.artifact, makeStaticFetch(nextA).fetch, caches);
  await nextRuntime.dispatchLifecycle("install");
  let names = await caches.keys();
  assert.ok(names.includes(oldA.artifact.metadata.cacheName), "old generation remains while replacement is waiting");
  assert.ok(names.includes(nextA.artifact.metadata.cacheName), "new generation is complete before activation");
  assert.ok(names.includes(peerB.artifact.metadata.cacheName), "peer mount remains intact before activation");
  await nextRuntime.dispatchLifecycle("activate");
  names = await caches.keys();
  assert.ok(!names.includes(oldA.artifact.metadata.cacheName), "activation prunes the old generation for A");
  assert.ok(names.includes(nextA.artifact.metadata.cacheName));
  assert.ok(names.includes(peerB.artifact.metadata.cacheName), "activation does not prune sibling Relay mount B");
  assert.equal(nextRuntime.skipWaitingCalls, 0);
  assert.equal(nextRuntime.claimCalls, 0);
});
