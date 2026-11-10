import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  createMobileWebOfflineArtifacts,
  injectMobileWebOfflineRegistration,
  MOBILE_OFFLINE_BUILD_DIGEST_HEADER,
  MOBILE_OFFLINE_GENERATION_HEADER,
  MOBILE_OFFLINE_LIMITS,
  MOBILE_OFFLINE_WORKER_PATH,
} from "../src/mobile-web-offline.js";
import { createMobileWebStatic } from "../src/mobile-web-static.js";

const TOKEN = "/__kcoder_mobile_mount_v1__";
const PAIRING_SECRET = "offline-static-test-pairing-secret-at-least-32-characters";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function createBuild(t, { extraAssets = 0, variant = "base" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kcoder-mobile-offline-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new Map([
    ["index.html", `<!doctype html><html data-build="${variant}"><head><script>window.fixtureBase="${TOKEN}"</script></head><body><script src="${TOKEN}/_expo/app.js"></script></body></html>`],
    ["_expo/app.js", `globalThis.mobileBase="${TOKEN}";globalThis.fixtureBuild="${variant}";`],
    ["assets/main.css", `:root{--fixture-base:"${TOKEN}"}`],
    ["h/[profileId]/index.html", `<html><head></head><body data-route="profile"><script src="${TOKEN}/_expo/app.js"></script></body></html>`],
  ]);
  for (let index = 0; index < extraAssets; index += 1) {
    source.set(`assets/extra-${index}.js`, `globalThis.fixtureExtra${index}=true;`);
  }
  const rows = [];
  const files = new Map();
  for (const [path, text] of source) {
    const bytes = Buffer.from(text, "utf8");
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    const row = {
      path,
      size: bytes.length,
      sha256: sha256(bytes),
      text: true,
      replacements: text.split(TOKEN).length - 1,
    };
    rows.push(row);
    files.set(path, row);
  }
  const manifestBytes = Buffer.from(JSON.stringify({ version: 1, baseToken: TOKEN, files: rows }));
  await writeFile(join(root, "kcoder-mobile-web.json"), manifestBytes);
  const dynamicPages = [{ name: "h/[profileId]/index.html", segments: ["h", "[profileId]"] }];
  const manifestSha256 = sha256(manifestBytes);
  return { root, files, dynamicPages, manifestSha256, source };
}

async function withActualStaticHttp(t, build) {
  let port;
  const makeServe = candidate => createMobileWebStatic({
    root: candidate.root,
    publicOrigins: new Set(["https://relay.example"]),
    pairingToken: PAIRING_SECRET,
    directPort: () => port,
    contentSecurityPolicy: "default-src 'self'; script-src 'self'; object-src 'none'; worker-src 'self'",
  });
  let serve = makeServe(build);
  const server = createServer((request, response) => {
    serve(request, response, new URL(request.url, "http://localhost").pathname).then(handled => {
      if (!handled) { response.writeHead(404); response.end("Not found"); }
    }).catch(error => {
      response.writeHead(500);
      response.end(error.message);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const get = (path, { mount = null } = {}) => new Promise((resolve, reject) => {
    const host = mount ? "relay.example" : `127.0.0.1:${port}`;
    const headers = mount ? {
      host,
      "x-kcoder-mobile-mount": mount,
      "x-kcoder-mobile-mount-proof": createHmac("sha256", PAIRING_SECRET)
        .update(JSON.stringify(["kcoder-mobile-mount-v1", host, mount])).digest("hex"),
    } : { host };
    const request = httpRequest(`http://127.0.0.1:${port}${path}`, {
      headers,
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    request.end();
  });
  const origin = `http://127.0.0.1:${port}`;
  const fetchThrough = async (input, mount = null) => {
    const external = new URL(input);
    const internalPath = mount ? `${external.pathname.slice(mount.length)}${external.search}` : `${external.pathname}${external.search}`;
    const actual = await get(internalPath, mount ? { mount } : {});
    const response = new Response(actual.body, { status: actual.status, headers: actual.headers });
    Object.defineProperty(response, "url", { value: external.href, configurable: true });
    Object.defineProperty(response, "redirected", { value: false, configurable: true });
    Object.defineProperty(response, "type", { value: "basic", configurable: true });
    return response;
  };
  return { get, origin, fetchThrough, replaceBuild(candidate) { serve = makeServe(candidate); } };
}

class MemoryCache {
  constructor() { this.rows = new Map(); }
  async put(request, response) {
    const key = typeof request === "string" ? new URL(request).href : request.url;
    this.rows.set(key, response.clone());
  }
  async match(request) {
    const key = typeof request === "string" ? new URL(request).href : request.url;
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

function runWorker(workerCode, { origin, scopePath, caches = new MemoryCacheStorage(), fetchImpl = fetch }) {
  const listeners = new Map();
  const self = {
    location: { origin },
    registration: { scope: new URL(scopePath, origin).href },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  runInNewContext(workerCode, {
    self, caches, fetch: fetchImpl, URL, Response, Headers, Uint8Array, Promise, Map, Set, Array, JSON, Error,
    AbortController, ReadableStream, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
  });
  return {
    caches,
    async lifecycle(type) {
      const pending = [];
      listeners.get(type)({ waitUntil(value) { pending.push(Promise.resolve(value)); } });
      await Promise.all(pending);
    },
  };
}

function artifactFor(build, mountBasePath) {
  return createMobileWebOfflineArtifacts({
    files: build.files,
    dynamicPages: build.dynamicPages,
    manifestSha256: build.manifestSha256,
    mountBasePath,
  });
}

test("actual static handler injects offline registration into direct Mobile HTML", async t => {
  const build = await createBuild(t);
  const artifact = createMobileWebOfflineArtifacts({
    files: build.files,
    dynamicPages: build.dynamicPages,
    manifestSha256: build.manifestSha256,
    mountBasePath: "/mobile",
  });
  const { get } = await withActualStaticHttp(t, build);
  const response = await get("/mobile/");

  assert.equal(response.status, 200);
  const expected = injectMobileWebOfflineRegistration(
    build.source.get("index.html").replaceAll(TOKEN, "/mobile"),
    artifact.registrationMarkup,
  );
  const html = response.body.toString("utf8");
  assert.equal(html, expected, "actual static HTML must contain the exact mount-rewritten helper registration");
  assert.equal(response.headers["content-length"], String(Buffer.byteLength(expected)));
  assert.equal(response.headers[MOBILE_OFFLINE_BUILD_DIGEST_HEADER], build.manifestSha256);
  assert.equal(response.headers[MOBILE_OFFLINE_GENERATION_HEADER], artifact.metadata.generation);
  const inlineBodies = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => !/\bsrc\s*=/i.test(match[1])).map(match => match[2]);
  const scriptPolicy = /(?:^|;\s*)script-src ([^;]*)/.exec(response.headers["content-security-policy"])[1];
  for (const inlineBody of inlineBodies) {
    const inlineHash = createHash("sha256").update(inlineBody).digest("base64");
    assert.ok(scriptPolicy.includes(`'sha256-${inlineHash}'`), `CSP must allow exact inline script hash ${inlineHash}`);
  }
  const worker = await get(`/mobile/${MOBILE_OFFLINE_WORKER_PATH}`);
  assert.equal(worker.status, 200);
  assert.equal(worker.headers["cache-control"], "no-store");
  assert.match(worker.headers["content-type"], /^application\/javascript/);
  assert.equal(worker.headers[MOBILE_OFFLINE_BUILD_DIGEST_HEADER], build.manifestSha256);
  assert.equal(worker.headers[MOBILE_OFFLINE_GENERATION_HEADER], artifact.metadata.generation);
  assert.equal(worker.body.toString("utf8"), artifact.workerCode);
});

test("actual signed Relay mounts return distinct scope-bound worker artifacts", async t => {
  const build = await createBuild(t);
  const artifactA = artifactFor(build, "/g/A/mobile");
  const artifactB = artifactFor(build, "/g/B/mobile");
  const { get } = await withActualStaticHttp(t, build);

  for (const [mount, artifact] of [["/g/A", artifactA], ["/g/B", artifactB]]) {
    const html = await get("/mobile/", { mount });
    assert.equal(html.status, 200);
    assert.ok(html.body.toString("utf8").includes(`${mount}/mobile/${MOBILE_OFFLINE_WORKER_PATH}`));
    assert.ok(html.body.toString("utf8").includes(`scope: ${JSON.stringify(`${mount}/mobile/`)}`));
    assert.equal(html.headers[MOBILE_OFFLINE_BUILD_DIGEST_HEADER], build.manifestSha256);
    assert.equal(html.headers[MOBILE_OFFLINE_GENERATION_HEADER], artifact.metadata.generation);

    const worker = await get(`/mobile/${MOBILE_OFFLINE_WORKER_PATH}`, { mount });
    assert.equal(worker.status, 200);
    assert.equal(worker.body.toString("utf8"), artifact.workerCode);
    assert.equal(worker.headers[MOBILE_OFFLINE_GENERATION_HEADER], artifact.metadata.generation);
  }
  assert.notEqual(artifactA.metadata.scopePath, artifactB.metadata.scopePath);
  assert.notEqual(artifactA.metadata.cachePrefix, artifactB.metadata.cachePrefix);
  assert.notEqual(artifactA.metadata.generation, artifactB.metadata.generation);
});

test("actual worker precaches exactly the rewritten and injected bytes served by the HTTP handler", async t => {
  const build = await createBuild(t);
  const artifact = artifactFor(build, "/mobile");
  const { get, origin } = await withActualStaticHttp(t, build);
  const workerResponse = await get(`/mobile/${MOBILE_OFFLINE_WORKER_PATH}`);
  assert.equal(workerResponse.status, 200);
  const runtime = runWorker(workerResponse.body.toString("utf8"), {
    origin,
    scopePath: artifact.metadata.scopePath,
    fetchImpl: input => fetch(input),
  });

  await runtime.lifecycle("install");
  const cache = await runtime.caches.open(artifact.metadata.cacheName);
  const config = JSON.parse(/^const CONFIG = (.*);$/m.exec(workerResponse.body.toString("utf8"))[1]);
  assert.equal(config.assets.length, artifact.metadata.assetCount);
  for (const asset of config.assets) {
    const url = new URL(asset.path.split("/").map(encodeURIComponent).join("/"), `${origin}${artifact.metadata.scopePath}`).href;
    const [cached, served] = await Promise.all([cache.match(url), fetch(url)]);
    assert.ok(cached, `${asset.path} must be in completed cache`);
    assert.equal(served.status, 200, `${asset.path} must be served by actual handler`);
    assert.deepEqual(Buffer.from(await cached.arrayBuffer()), Buffer.from(await served.arrayBuffer()), asset.path);
  }
  assert.ok(await cache.match(`${origin}${artifact.metadata.scopePath}__kcoder_offline_complete__/${artifact.metadata.expectedBuildId}/${artifact.metadata.mechanismCodeSha256}/${artifact.metadata.configurationSha256}`));
});

test("unrelated corrupt HTML leaves online index available but failed install preserves old and peer caches", async t => {
  const oldBuild = await createBuild(t);
  const oldArtifactA = artifactFor(oldBuild, "/mobile");
  const oldArtifactB = artifactFor(oldBuild, "/g/B/mobile");
  const cacheStorage = new MemoryCacheStorage();
  const oldServer = await withActualStaticHttp(t, oldBuild);
  const installFromServer = async (artifact, { origin, mount = null } = {}) => {
    const workerResponse = await oldServer.get(`/mobile/${MOBILE_OFFLINE_WORKER_PATH}`, { mount });
    assert.equal(workerResponse.status, 200);
    return runWorker(workerResponse.body.toString("utf8"), {
      origin: origin ?? oldServer.origin,
      scopePath: artifact.metadata.scopePath,
      caches: cacheStorage,
      fetchImpl: input => oldServer.fetchThrough(input, mount),
    });
  };
  const oldRuntimeA = await installFromServer(oldArtifactA);
  const oldRuntimeB = await installFromServer(oldArtifactB, { mount: "/g/B" });
  await oldRuntimeA.lifecycle("install");
  await oldRuntimeB.lifecycle("install");
  const oldNames = await cacheStorage.keys();
  assert.deepEqual(new Set(oldNames), new Set([oldArtifactA.metadata.cacheName, oldArtifactB.metadata.cacheName]));

  const nextBuild = await createBuild(t, { variant: "corrupt-next" });
  const nextArtifactA = artifactFor(nextBuild, "/mobile");
  assert.notEqual(nextBuild.manifestSha256, oldBuild.manifestSha256);
  assert.notEqual(nextArtifactA.metadata.generation, oldArtifactA.metadata.generation);
  assert.notEqual(nextArtifactA.metadata.cacheName, oldArtifactA.metadata.cacheName);
  await writeFile(join(nextBuild.root, "h/[profileId]/index.html"), "corrupt-but-unrelated-profile-page");
  oldServer.replaceBuild(nextBuild);
  const nextServer = oldServer;
  const index = await nextServer.get("/mobile/");
  assert.equal(index.status, 200, "online index remains available when a different HTML resource is corrupt");
  assert.ok(index.body.toString("utf8").includes(nextArtifactA.registrationMarkup));

  const workerResponse = await nextServer.get(`/mobile/${MOBILE_OFFLINE_WORKER_PATH}`);
  assert.equal(workerResponse.status, 200);
  const nextRuntime = runWorker(workerResponse.body.toString("utf8"), {
    origin: nextServer.origin,
    scopePath: nextArtifactA.metadata.scopePath,
    caches: cacheStorage,
    fetchImpl: input => fetch(input),
  });
  await assert.rejects(nextRuntime.lifecycle("install"), /installation failed/);
  assert.deepEqual(new Set(await cacheStorage.keys()), new Set(oldNames), "failed candidate must not remove the previous mount generations");
});

test("over-budget inventory disables offline registration while actual online assets remain available", async t => {
  const build = await createBuild(t, { extraAssets: MOBILE_OFFLINE_LIMITS.assets });
  const { get } = await withActualStaticHttp(t, build);
  const html = await get("/mobile/");
  assert.equal(html.status, 200);
  assert.ok(!html.body.toString("utf8").includes("serviceWorker.register"));
  assert.equal(html.headers[MOBILE_OFFLINE_BUILD_DIGEST_HEADER], undefined);
  assert.equal((await get(`/mobile/${MOBILE_OFFLINE_WORKER_PATH}`)).status, 404);
  const asset = await get("/mobile/_expo/app.js");
  assert.equal(asset.status, 200);
  assert.ok(asset.body.toString("utf8").includes("/mobile"));
});
