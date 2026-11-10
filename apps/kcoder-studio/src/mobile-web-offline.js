import { createHash } from "node:crypto";

export const MOBILE_OFFLINE_BUILD_DIGEST_HEADER = "x-kcoder-mobile-build-sha256";
export const MOBILE_OFFLINE_GENERATION_HEADER = "x-kcoder-mobile-shell-generation";
export const MOBILE_OFFLINE_WORKER_PATH = "__kcoder_offline_sw.js";
export const MOBILE_OFFLINE_LIMITS = Object.freeze({
  assets: 128,
  htmlPages: 64,
  assetBytes: 8 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  workerBytes: 256 * 1024,
  concurrency: 4,
  assetTimeoutMs: 30_000,
});

const BASE_TOKEN = "/__kcoder_mobile_mount_v1__";
const CACHE_FAMILY = "kcoder-mobile-offline-shell";
const HTML_INJECTION_VERSION = "before-first-head-close-else-body-close-else-eof;exact-markup-no-newline-v1";
const RESERVED_MOBILE_PATH_ROOTS = Object.freeze(["api", "session", "refresh", "rpc", "mobile-entry"]);
const SUPPORTED_EXTENSIONS = new Set([
  ".css", ".html", ".ico", ".jpeg", ".jpg", ".js", ".json", ".mjs",
  ".otf", ".png", ".svg", ".ttf", ".wasm", ".webmanifest", ".webp",
  ".woff", ".woff2", ".xml",
]);
const REGISTRATION_CODE_TEMPLATE = `try { if (typeof window !== "undefined" && window.isSecureContext && typeof navigator !== "undefined" && "serviceWorker" in navigator) { navigator.serviceWorker.register(@@WORKER_PATH@@, { scope: @@SCOPE_PATH@@, updateViaCache: "none" }).catch(() => {}); } } catch {}`;

const WORKER_TEMPLATE = String.raw`"use strict";
const CONFIG = @@MOBILE_OFFLINE_CONFIG@@;
const CACHE_PREFIX = "kcoder-mobile-offline-shell:" + encodeURIComponent(CONFIG.scopePath) + ":";
const CACHE_NAME = CACHE_PREFIX + CONFIG.manifestSha256 + ":" + CONFIG.mechanismCodeSha256 + ":" + CONFIG.configurationSha256;
const SCOPE_URL = new URL(CONFIG.scopePath, self.location.origin).href;
const COMPLETE_URL = new URL("__kcoder_offline_complete__/" + CONFIG.manifestSha256 + "/" + CONFIG.mechanismCodeSha256 + "/" + CONFIG.configurationSha256, SCOPE_URL).href;
const ASSETS = CONFIG.assets;
const HTML_PATHS = new Set(ASSETS.filter(asset => asset.path.endsWith(".html")).map(asset => asset.path));
const ASSET_BY_PATH = new Map(ASSETS.map(asset => [asset.path, asset]));

function isReservedPath(path) {
  return CONFIG.reservedPathRoots.includes(path.split("/")[0]);
}

function publicUrl(path) {
  return new URL(path.split("/").map(encodeURIComponent).join("/"), SCOPE_URL);
}

function safeRelativePath(rawPath) {
  if (/%(?:2e|2f|5c|00)/i.test(rawPath)) return null;
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (!decoded || decoded.startsWith("/") || /[\\\x00-\x1f\x7f%?#]/.test(decoded)) return null;
  const segments = decoded.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return null;
  return decoded;
}

function matchesDynamicPage(path, page) {
  const segments = path.split("/");
  return segments.length === page.segments.length && page.segments.every((segment, index) =>
    segment === segments[index] || /^\[[A-Za-z][A-Za-z0-9_]*\]$/.test(segment));
}

function navigationAssetPath(rawPath) {
  const trimmed = rawPath.replace(/\/$/, "");
  if (trimmed === "") return "index.html";
  const relative = safeRelativePath(trimmed);
  if (!relative || isReservedPath(relative)) return null;
  if (HTML_PATHS.has(relative)) return relative;
  if (HTML_PATHS.has(relative + ".html")) return relative + ".html";
  const page = CONFIG.dynamicPages.find(candidate => matchesDynamicPage(relative, candidate));
  if (page) return page.name;
  if (!relative.includes(".") && !relative.startsWith("_expo/") && !relative.startsWith("assets/")) return "index.html";
  return null;
}

async function readBounded(response, limit) {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Mobile offline asset exceeds its byte limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cacheableHeaders(response) {
  const headers = new Headers();
  for (const name of ["cache-control", "content-security-policy", "content-type", "etag",
    "referrer-policy", "vary", "x-content-type-options", CONFIG.buildDigestHeader, CONFIG.generationHeader]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

async function completedCache() {
  const cache = await caches.open(CACHE_NAME);
  return await cache.match(COMPLETE_URL) ? cache : null;
}

async function installCache() {
  const ready = await completedCache();
  if (ready) return;
  await caches.delete(CACHE_NAME);
  const cache = await caches.open(CACHE_NAME);
  let totalBytes = 0;
  let nextIndex = 0;
  let firstFailure = null;
  const fetchOne = async asset => {
    const url = publicUrl(asset.path);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.assetTimeoutMs);
    try {
      const response = await fetch(url.href, {
        method: "GET",
        mode: "same-origin",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200 || response.redirected || response.type === "opaque") {
        throw new Error("Mobile offline asset response is not a direct 200");
      }
      const finalUrl = new URL(response.url);
      if (finalUrl.origin !== self.location.origin || finalUrl.href !== url.href ||
          finalUrl.search !== "" || !finalUrl.pathname.startsWith(CONFIG.scopePath)) {
        throw new Error("Mobile offline asset response escaped its mount");
      }
      if (response.headers.get(CONFIG.buildDigestHeader) !== CONFIG.manifestSha256) {
        throw new Error("Mobile offline asset build identity changed");
      }
      if (response.headers.get(CONFIG.generationHeader) !== CONFIG.generation) {
        throw new Error("Mobile offline asset shell generation changed");
      }
      const bytes = await readBounded(response, Math.min(CONFIG.maxAssetBytes, asset.bytes));
      if (bytes.byteLength !== asset.bytes || totalBytes + bytes.byteLength > CONFIG.maxTotalBytes) {
        throw new Error("Mobile offline asset inventory size changed");
      }
      totalBytes += bytes.byteLength;
      await cache.put(url.href, new Response(bytes, { status: 200, headers: cacheableHeaders(response) }));
    } finally {
      clearTimeout(timeout);
    }
  };
  const worker = async () => {
    while (!firstFailure) {
      const index = nextIndex++;
      if (index >= ASSETS.length) return;
      try { await fetchOne(ASSETS[index]); }
      catch (error) { firstFailure ||= error; return; }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONFIG.concurrency, ASSETS.length) }, worker));
    if (firstFailure) throw firstFailure;
    if (totalBytes !== CONFIG.totalBytes) throw new Error("Mobile offline inventory total changed");
    await cache.put(COMPLETE_URL, new Response(JSON.stringify({
      manifestSha256: CONFIG.manifestSha256,
      mechanismCodeSha256: CONFIG.mechanismCodeSha256,
      totalBytes,
      assetCount: ASSETS.length,
    }), { status: 200, headers: { "content-type": "application/json" } }));
  } catch {
    await caches.delete(CACHE_NAME).catch(() => false);
    throw new Error("Mobile offline shell cache installation failed");
  }
}

async function activateCache() {
  if (!await completedCache()) throw new Error("Mobile offline shell cache is incomplete");
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map(name => caches.delete(name)));
}

async function responseFromCache(url) {
  const cache = await completedCache();
  return cache ? cache.match(url) : null;
}

self.addEventListener("install", event => { event.waitUntil(installCache()); });
self.addEventListener("activate", event => { event.waitUntil(activateCache()); });
self.addEventListener("fetch", event => {
  const request = event.request;
  if (!request || request.method !== "GET" || request.headers?.get("authorization")) return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin || url.search || url.hash || !url.pathname.startsWith(CONFIG.scopePath)) return;
  const rawPath = url.pathname.slice(CONFIG.scopePath.length);
  if (request.mode === "navigate") {
    const assetPath = navigationAssetPath(rawPath);
    if (!assetPath) return;
    const asset = ASSET_BY_PATH.get(assetPath);
    if (!asset) return;
    const cachedUrl = publicUrl(asset.path).href;
    event.respondWith((async () => (await responseFromCache(cachedUrl)) || fetch(request))());
    return;
  }
  const relative = safeRelativePath(rawPath);
  if (!relative || isReservedPath(relative) || !ASSET_BY_PATH.has(relative)) return;
  const cachedUrl = publicUrl(relative).href;
  event.respondWith((async () => (await responseFromCache(cachedUrl)) || fetch(request))());
});
`;

function failClosed(reason, { manifestSha256, mountBasePath, assetCount = null, totalBytes = null } = {}) {
  const scopePath = typeof mountBasePath === "string" ? `${mountBasePath}/` : null;
  return {
    enabled: false,
    registrationMarkup: "",
    workerCode: "",
    metadata: {
      enabled: false,
      reason,
      expectedBuildId: manifestSha256,
      buildDigestHeader: MOBILE_OFFLINE_BUILD_DIGEST_HEADER,
      generationHeader: MOBILE_OFFLINE_GENERATION_HEADER,
      mechanismCodeSha256: MECHANISM_CODE_SHA256,
      scopePath,
      assetCount,
      totalBytes,
    },
  };
}

function assertSafePath(path) {
  if (typeof path !== "string" || path.length < 1 || path.length > 1024 || path.startsWith("/") ||
      /[\\\x00-\x1f\x7f%?#]/.test(path) || path.split("/").some(segment =>
        !segment || segment === "." || segment === ".." || (segment.startsWith(".") && path !== "_expo/.routes.json"))) {
    throw new TypeError("Mobile offline inventory contains an unsafe path");
  }
}

function deriveRouteSegments(name) {
  return name.replace(/\.html$/, "").replace(/\/index$/, "").split("/");
}

/** Insert registration markup before the first head close, else body close, else EOF. */
export function injectMobileWebOfflineRegistration(html, registrationMarkup) {
  if (typeof html !== "string" || typeof registrationMarkup !== "string") {
    throw new TypeError("Mobile offline HTML and registration markup must be strings");
  }
  for (const closingTag of [/<\/head\s*>/i, /<\/body\s*>/i]) {
    const match = closingTag.exec(html);
    if (match) {
      return `${html.slice(0, match.index)}${registrationMarkup}${html.slice(match.index)}`;
    }
  }
  return `${html}${registrationMarkup}`;
}

function createRegistrationCode(workerPath, scopePath) {
  return REGISTRATION_CODE_TEMPLATE
    .replace("@@WORKER_PATH@@", JSON.stringify(workerPath))
    .replace("@@SCOPE_PATH@@", JSON.stringify(scopePath));
}

function normalizeDynamicPages(dynamicPages, files) {
  if (!Array.isArray(dynamicPages)) throw new TypeError("Mobile offline dynamic pages must be an array");
  if (dynamicPages.length > MOBILE_OFFLINE_LIMITS.htmlPages) return null;
  const normalized = [];
  for (const page of dynamicPages) {
    if (!page || typeof page !== "object") throw new TypeError("Mobile offline dynamic page is invalid");
    assertSafePath(page.name);
    if (!page.name.endsWith(".html") || !files.has(page.name) || !Array.isArray(page.segments)) {
      throw new TypeError("Mobile offline dynamic page is not in the verified inventory");
    }
    const expected = deriveRouteSegments(page.name);
    if (JSON.stringify(page.segments) !== JSON.stringify(expected) ||
        !expected.some(segment => /^\[[A-Za-z][A-Za-z0-9_]*\]$/.test(segment))) {
      throw new TypeError("Mobile offline dynamic page segments do not match the inventory path");
    }
    normalized.push({ name: page.name, segments: expected });
  }
  return normalized;
}

function createConfigurationSha256(configuration) {
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

const MECHANISM_CODE_SHA256 = createHash("sha256").update(JSON.stringify([
  WORKER_TEMPLATE,
  REGISTRATION_CODE_TEMPLATE,
  HTML_INJECTION_VERSION,
  injectMobileWebOfflineRegistration.toString(),
  createRegistrationCode.toString(),
  createConfigurationSha256.toString(),
  deriveRouteSegments.toString(),
  normalizeDynamicPages.toString(),
  JSON.stringify(MOBILE_OFFLINE_LIMITS),
  JSON.stringify(RESERVED_MOBILE_PATH_ROOTS),
  BASE_TOKEN,
  MOBILE_OFFLINE_BUILD_DIGEST_HEADER,
  MOBILE_OFFLINE_GENERATION_HEADER,
])).digest("hex");

function generateWorkerCode(config) {
  return WORKER_TEMPLATE.replace("@@MOBILE_OFFLINE_CONFIG@@", JSON.stringify(config));
}

/**
 * Build bounded, mount-scoped offline artifacts from a verified Mobile Web inventory.
 * The caller remains responsible for serving the worker endpoint and inserting the markup into HTML.
 */
export function createMobileWebOfflineArtifacts({ files, dynamicPages, manifestSha256, mountBasePath }) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256 ?? "")) {
    throw new TypeError("Mobile offline manifest SHA-256 is invalid");
  }
  if (typeof mountBasePath !== "string" ||
      !(/^\/mobile$/.test(mountBasePath) || /^\/g\/[A-Za-z0-9_-]{1,64}\/mobile$/.test(mountBasePath))) {
    throw new TypeError("Mobile offline mount base path is invalid");
  }
  if (!(files instanceof Map)) throw new TypeError("Mobile offline files must be the verified inventory Map");
  if (files.size > MOBILE_OFFLINE_LIMITS.assets) {
    return failClosed("asset-count-limit", { manifestSha256, mountBasePath, assetCount: files.size });
  }
  const normalizedPages = normalizeDynamicPages(dynamicPages, files);
  if (!normalizedPages) {
    return failClosed("html-page-limit", { manifestSha256, mountBasePath, assetCount: files.size });
  }
  if (!files.has("index.html")) {
    return failClosed("missing-index", { manifestSha256, mountBasePath, assetCount: files.size });
  }

  const scopePath = `${mountBasePath}/`;
  const workerPath = `${mountBasePath}/${MOBILE_OFFLINE_WORKER_PATH}`;
  const registrationCode = createRegistrationCode(workerPath, scopePath);
  const registrationMarkup = `<script>${registrationCode}</script>`;
  const htmlInjectionBytes = Buffer.byteLength(registrationMarkup, "utf8");

  const resources = [];
  let totalBytes = 0;
  for (const [path, row] of files) {
    assertSafePath(path);
    if (!row || typeof row !== "object" || !Number.isSafeInteger(row.size) || row.size < 0 ||
        !/^[a-f0-9]{64}$/.test(row.sha256 ?? "") || typeof row.text !== "boolean" ||
        !Number.isSafeInteger(row.replacements) || row.replacements < 0 || (!row.text && row.replacements !== 0)) {
      throw new TypeError("Mobile offline resource metadata is invalid");
    }
    const extension = /\.[^.\/]+$/.exec(path)?.[0].toLowerCase() ?? "";
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return failClosed("unsupported-resource-type", { manifestSha256, mountBasePath, assetCount: files.size, totalBytes });
    }
    if (RESERVED_MOBILE_PATH_ROOTS.includes(path.split("/")[0])) {
      return failClosed("reserved-resource-path", { manifestSha256, mountBasePath, assetCount: files.size, totalBytes });
    }
    const mountReplacementBytes = row.text ? (mountBasePath.length - BASE_TOKEN.length) * row.replacements : 0;
    const bytes = row.size + mountReplacementBytes + (path.endsWith(".html") ? htmlInjectionBytes : 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MOBILE_OFFLINE_LIMITS.assetBytes) {
      return failClosed("asset-byte-limit", { manifestSha256, mountBasePath, assetCount: files.size, totalBytes });
    }
    totalBytes += bytes;
    if (totalBytes > MOBILE_OFFLINE_LIMITS.totalBytes) {
      return failClosed("total-byte-limit", { manifestSha256, mountBasePath, assetCount: files.size, totalBytes });
    }
    resources.push({ path, bytes });
  }

  const cachePrefix = `${CACHE_FAMILY}:${encodeURIComponent(scopePath)}:`;
  const configurationSha256 = createConfigurationSha256({
    scopePath,
    manifestSha256,
    mechanismCodeSha256: MECHANISM_CODE_SHA256,
    buildDigestHeader: MOBILE_OFFLINE_BUILD_DIGEST_HEADER,
    generationHeader: MOBILE_OFFLINE_GENERATION_HEADER,
    registrationMarkup,
    maxAssetBytes: MOBILE_OFFLINE_LIMITS.assetBytes,
    maxTotalBytes: MOBILE_OFFLINE_LIMITS.totalBytes,
    concurrency: MOBILE_OFFLINE_LIMITS.concurrency,
    assetTimeoutMs: MOBILE_OFFLINE_LIMITS.assetTimeoutMs,
    reservedPathRoots: RESERVED_MOBILE_PATH_ROOTS,
    totalBytes,
    assets: resources,
    dynamicPages: normalizedPages,
  });
  const generation = `${manifestSha256}:${MECHANISM_CODE_SHA256}:${configurationSha256}`;
  const config = {
    scopePath,
    manifestSha256,
    mechanismCodeSha256: MECHANISM_CODE_SHA256,
    configurationSha256,
    buildDigestHeader: MOBILE_OFFLINE_BUILD_DIGEST_HEADER,
    generationHeader: MOBILE_OFFLINE_GENERATION_HEADER,
    generation,
    maxAssetBytes: MOBILE_OFFLINE_LIMITS.assetBytes,
    maxTotalBytes: MOBILE_OFFLINE_LIMITS.totalBytes,
    concurrency: MOBILE_OFFLINE_LIMITS.concurrency,
    assetTimeoutMs: MOBILE_OFFLINE_LIMITS.assetTimeoutMs,
    reservedPathRoots: RESERVED_MOBILE_PATH_ROOTS,
    totalBytes,
    assets: resources,
    dynamicPages: normalizedPages,
  };
  const workerCode = generateWorkerCode(config);
  const workerCodeBytes = Buffer.byteLength(workerCode, "utf8");
  if (workerCodeBytes > MOBILE_OFFLINE_LIMITS.workerBytes) {
    return failClosed("worker-byte-limit", { manifestSha256, mountBasePath, assetCount: files.size, totalBytes });
  }

  const workerCodeSha256 = createHash("sha256").update(workerCode).digest("hex");
  return {
    enabled: true,
    registrationMarkup,
    workerCode,
    metadata: {
      enabled: true,
      expectedBuildId: manifestSha256,
      buildDigestHeader: MOBILE_OFFLINE_BUILD_DIGEST_HEADER,
      generationHeader: MOBILE_OFFLINE_GENERATION_HEADER,
      mechanismCodeSha256: MECHANISM_CODE_SHA256,
      configurationSha256,
      workerCodeSha256,
      generation,
      scopePath,
      workerPath,
      cachePrefix,
      cacheName: `${cachePrefix}${generation}`,
      assetCount: resources.length,
      totalBytes,
      htmlInjectionBytes,
      maxAssetBytes: MOBILE_OFFLINE_LIMITS.assetBytes,
      maxTotalBytes: MOBILE_OFFLINE_LIMITS.totalBytes,
      concurrency: MOBILE_OFFLINE_LIMITS.concurrency,
      assetTimeoutMs: MOBILE_OFFLINE_LIMITS.assetTimeoutMs,
      workerCodeBytes,
    },
  };
}
