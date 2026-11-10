// One-shot real Chromium acceptance for Mobile LAN -> P2P -> Relay routing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createMobileWebStatic } from "../../src/mobile-web-static.js";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { startBrowserDualRouteFixture } from "./mobile-dual-route-browser-fixture.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { hashSourceTree } from "../../../../scripts/release/package_mobile_android.mjs";
import { appRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const RUN_FLAG = "KCODER_E2E_PRIVATE_MOBILE_PEER_ROUTE_ACCEPTANCE";
const PREFLIGHT_ONLY = process.argv.includes("--preflight-only");
const TRANSPORT_SMOKE = process.argv.includes("--transport-smoke");
const RUN_ACCEPTANCE = process.argv.includes("--run");
const CSP = [
  "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
  "form-action 'self'", "script-src 'self' 'wasm-unsafe-eval' 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: http: https:", "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:", "worker-src 'self' blob:", "frame-src 'self' http: https:",
  "media-src 'self' blob: http: https:",
].join("; ");
const DEFAULT_STUN_URLS = "stun:47.80.92.250:8452";
const RELAY_GATEWAY_PATH_PREFIX = "/g/mobile-dual-route-browser";
const ROUTE_CACHE_WAIT_MS = 16_000;
const ACCESS_TTL_MS = 30_000;
const EXPECTED_MOBILE_SOURCE_SHA256 = "ecbf07ad9c034f472c1be4b82f04c6f9f2115df3d9ec8c3eff855d99b9a89079";
const EXPECTED_SHARED_SOURCE_SHA256 = "df3bad8517424c2c7cdab76a4d7a31759c526ef880eea3d2b133fe2d96087579";
const browserSocketAudits = new WeakMap();

async function hashCurrentMobileSourceTrees() {
  const mobile = await hashSourceTree(resolve(appRoot, "mobile"), "mobile");
  const shared = await hashSourceTree(resolve(appRoot, "shared"), "shared");
  assert.equal(mobile, EXPECTED_MOBILE_SOURCE_SHA256, "Current Mobile source differs from the frozen export input");
  assert.equal(shared, EXPECTED_SHARED_SOURCE_SHA256, "Current shared source differs from the frozen export input");
  return { mobile, shared };
}

if (process.env[RUN_FLAG] !== "1") {
  throw new Error(`${RUN_FLAG}=1 is required for this private one-shot browser acceptance`);
}
if ([PREFLIGHT_ONLY, TRANSPORT_SMOKE, RUN_ACCEPTANCE].filter(Boolean).length !== 1) {
  throw new Error("choose exactly one of --preflight-only, --transport-smoke, or --run");
}
const noSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
const requireSandbox = process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX === "1";
if (noSandbox === requireSandbox) {
  throw new Error("set exactly one of KCODER_E2E_CHROMIUM_NO_SANDBOX=1 or KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX=1 before starting the owned browser");
}

await runE2E(import.meta.url, {
  testId: "mobile-lan-p2p-relay-real-browser-acceptance",
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "RunContext-owned Chromium and actual browser RTCPeerConnection DataChannel to the isolated NodeGateway native WebRTC bridge; transport-smoke bundles current peer-transport source directly, full acceptance uses the pinned Mobile Web export; owned local Relay only; real pairing/session HTTP, servers HTTP and RPC initialize/thread/list/read; no Provider/model calls; no public Gateway/Relay or phone claim",
}, async context => {
  const evidence = {
    status: "incomplete",
    mode: PREFLIGHT_ONLY ? "preflight-only" : TRANSPORT_SMOKE ? "direct-source-transport-smoke" : "real-browser-acceptance",
    boundary: "isolated RFC1918 Gateway and local owned Relay fixture; deterministic mock workspace RPC; full acceptance uses current-source Mobile export and official createMobileWebStatic mount; no public service, phone/native Mobile, Provider/model, or deployment claim",
    security: {
      chromiumSandboxMode: noSandbox ? "explicit-no-sandbox-for-this-VM" : "required-sandbox",
      browserSecurityOverrides: "none; no web-security, CORS, mixed-content, Local Network Access, or ICE-policy override",
      stunUrls: DEFAULT_STUN_URLS,
      iceTransportPolicyOverride: "none",
      screenshotPolicy: "only after pairing URL fragment is scrubbed; no credentials included",
    },
    scenarios: {},
  };
  let fixture;
  let mobileServer;
  let mobileWeb;
  try {
    evidence.preflight = await runCheapPreflight(context);
    evidence.mobileSharedSourceBeforeRun = await hashCurrentMobileSourceTrees();
    if (PREFLIGHT_ONLY) {
      evidence.status = "preflight-pass-no-export";
      return { status: evidence.status };
    }

    if (TRANSPORT_SMOKE) {
      const shell = await startTransportSmokePage(context);
      mobileServer = shell.server;
      evidence.nodeGatewayRuntimeSourceBeforeStart = await hashNodeGatewayRuntimeSources();
      fixture = await startBrowserDualRouteFixture(context, {
        mobileWebOrigin: shell.origin,
        gatewayEnv: {
          KCODER_STUDIO_P2P: "1",
          KCODER_STUDIO_P2P_STUN_URLS: DEFAULT_STUN_URLS,
          KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: String(ACCESS_TTL_MS),
        },
      });
      evidence.nodeGatewayRuntimeSourceAtGatewayReady = await hashNodeGatewayRuntimeSources();
      evidence.nodeGatewayRuntimeSourceChangedBeforeGatewayReady =
        evidence.nodeGatewayRuntimeSourceBeforeStart.treeSha256 !== evidence.nodeGatewayRuntimeSourceAtGatewayReady.treeSha256;
      fixture.setLanDown(true);
      evidence.mount = {
        url: shell.origin,
        handler: "owned transport-smoke shell, not a Mobile Web bundle",
        gatewayFixture: "isolated source Gateway, not a deployed/public Gateway",
        relayFixture: "owned in-process KCoder Relay client/proxy, not a public Relay deployment",
        lanAddressClass: "RFC1918 owned route proxy; LAN disabled for direct P2P smoke",
      };
      evidence.sourceBundle = shell.bundle;
      evidence.transportSmoke = await runDirectTransportSmoke(context, fixture, shell.origin);
      evidence.status = "real-browser-direct-transport-smoke-pass-not-mobile-ui-acceptance";
      return { status: evidence.status };
    }

    mobileWeb = await exportMobileWeb(context, {
      label: "mobile-peer-route-current-mobile-export",
      outputName: "current-mobile-web-export",
      timeoutMs: 180_000,
      overallTimeoutMs: 240_000,
      sourceMaps: false,
      deployMount: true,
    });
    const manifest = await buildGatewayMobileWebManifest(mobileWeb.path);
    await writeGatewayMobileWebManifest(mobileWeb.path, manifest);
    await cp(mobileWeb.path, context.pathInArtifacts("mobile-web-export"), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const manifestSha256 = createHash("sha256")
      .update(await readFile(resolve(mobileWeb.path, "kcoder-mobile-web.json")))
      .digest("hex");
    evidence.mobileWebExport = {
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      buildInputTreeSha256: mobileWeb.buildInputTreeSha256,
      dependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
      bundleSha256: mobileWeb.bundleSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
      indexHtmlSha256: mobileWeb.indexHtmlSha256,
      manifestSha256,
      manifestFileCount: manifest.files.length,
    };
    const mount = await startOfficialMobileMount(context, mobileWeb.path);
    mobileServer = mount.server;
    evidence.nodeGatewayRuntimeSourceBeforeStart = await hashNodeGatewayRuntimeSources();
    fixture = await startBrowserDualRouteFixture(context, {
      mobileWebOrigin: mount.origin,
      gatewayEnv: {
        KCODER_STUDIO_P2P: "1",
        KCODER_STUDIO_P2P_STUN_URLS: DEFAULT_STUN_URLS,
        KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: String(ACCESS_TTL_MS),
      },
    });
    evidence.nodeGatewayRuntimeSourceAtGatewayReady = await hashNodeGatewayRuntimeSources();
    evidence.nodeGatewayRuntimeSourceChangedBeforeGatewayReady =
      evidence.nodeGatewayRuntimeSourceBeforeStart.treeSha256 !== evidence.nodeGatewayRuntimeSourceAtGatewayReady.treeSha256;
    evidence.mount = {
      url: `${mount.origin}/mobile/`,
      handler: "official createMobileWebStatic with generated Gateway hash manifest",
      gatewayFixture: "isolated source Gateway, not a deployed/public Gateway",
      relayFixture: "owned in-process KCoder Relay client/proxy, not a public Relay deployment",
      lanAddressClass: "RFC1918 owned route proxy",
    };

    const deviceBaseline = await fixture.adminDeviceCount();
    evidence.scenarios.lan = await runLanAcceptance(context, fixture, mount.origin, deviceBaseline);
    await writeScenarioProgress(context, evidence, "lan");

    fixture.setLanDown(true);
    fixture.setP2PSignalingDown(true);
    const beforeFallbackDevices = await fixture.adminDeviceCount();
    evidence.scenarios.p2pUnavailableRelayFallback = await runRelayFallbackAcceptance(
      context,
      fixture,
      mount.origin,
      beforeFallbackDevices,
    );
    await writeScenarioProgress(context, evidence, "p2pUnavailableRelayFallback");
    fixture.setP2PSignalingDown(false);
    fixture.setLanDown(false);

    const beforeSignatureDevices = await fixture.adminDeviceCount();
    evidence.scenarios.invalidAnswerSignature = await runInvalidAnswerSignatureAcceptance(
      context,
      fixture,
      mount.origin,
      beforeSignatureDevices,
    );
    await writeScenarioProgress(context, evidence, "invalidAnswerSignature");
    fixture.setPublicBusinessDown(false);
    fixture.setP2PAnswerSignatureInvalid(false);
    fixture.setLanDown(true);

    const beforePeerDevices = await fixture.adminDeviceCount();
    evidence.scenarios.peerSurvivesPublicRelayLoss = await runPeerSurvivesPublicLossAcceptance(
      context,
      fixture,
      mount.origin,
      beforePeerDevices,
    );
    await writeScenarioProgress(context, evidence, "peerSurvivesPublicRelayLoss");

    evidence.mobileSharedSourceAfterRun = await hashCurrentMobileSourceTrees();
    assert.deepEqual(evidence.mobileSharedSourceAfterRun, evidence.mobileSharedSourceBeforeRun,
      "frozen Mobile/shared sources changed during the browser runtime acceptance");

    evidence.status = "real-browser-lan-p2p-relay-acceptance-pass";
  } catch (error) {
    evidence.failure = safeFailure(context, error?.stack ?? error?.message ?? error);
    throw error;
  } finally {
    try { await fixture?.health(); } catch { /* Fixture diagnostics are best-effort after a primary failure. */ }
    if (!evidence.mobileSharedSourceAfterRun && evidence.mobileSharedSourceBeforeRun) {
      try { evidence.mobileSharedSourceAfterRun = await hashCurrentMobileSourceTrees(); }
      catch (error) { evidence.mobileSharedSourceHashError = safeFailure(context, error?.message ?? error); }
    }
    if (evidence.nodeGatewayRuntimeSourceBeforeStart) {
      evidence.nodeGatewayRuntimeSourceAfterRun = await hashNodeGatewayRuntimeSources();
      evidence.nodeGatewayRuntimeSourceChangedDuringRun =
        evidence.nodeGatewayRuntimeSourceBeforeStart.treeSha256 !== evidence.nodeGatewayRuntimeSourceAfterRun.treeSha256;
    }
    if (mobileServer?.listening) await closeServer(mobileServer);
    evidence.fixtureRecords = fixture ? summarizeFixtureRecords(fixture.records) : [];
    await context.writeArtifactJson("mobile-peer-route-acceptance.json", evidence);
  }
  return { status: evidence.status, scenarios: Object.keys(evidence.scenarios) };
});

async function writeScenarioProgress(context, evidence, completedScenario) {
  const progress = {
    status: "in-progress",
    completedScenario,
    completedScenarioResult: evidence.scenarios[completedScenario]?.result ?? null,
    completedScenarios: Object.keys(evidence.scenarios),
    runtimeSourceSha256: evidence.nodeGatewayRuntimeSourceBeforeStart?.treeSha256 ?? null,
    mobileWebExport: evidence.mobileWebExport ? {
      sourceTreeSha256: evidence.mobileWebExport.sourceTreeSha256,
      bundleSha256: evidence.mobileWebExport.bundleSha256,
    } : null,
  };
  await context.writeArtifactJson(`mobile-peer-route-progress-${completedScenario}.json`, progress);
  console.log(`MOBILE_PEER_ROUTE_SCENARIO ${JSON.stringify(progress)}`);
}

async function runCheapPreflight(context) {
  const result = {
    nodeVersion: process.version,
    nativeAddon: null,
    chromium: null,
    umask: null,
    exportSkipped: PREFLIGHT_ONLY || TRANSPORT_SMOKE,
  };
  const previousUmask = process.umask(0o077);
  const activeUmask = process.umask();
  process.umask(previousUmask);
  result.umask = activeUmask.toString(8).padStart(3, "0");
  assert.equal(activeUmask, 0o077, "preflight must demonstrate umask 077");

  const module = await import("node-datachannel");
  const rtc = module?.default && module.PeerConnection === undefined ? module.default : module;
  assert.equal(typeof rtc?.PeerConnection, "function", "node-datachannel must export PeerConnection");
  const peer = new rtc.PeerConnection("mobile-peer-route-preflight", { iceServers: [], maxMessageSize: 16_384 });
  assert.ok(peer, "native WebRTC must construct a peer connection");
  peer.close();
  result.nativeAddon = { dynamicImport: "pass", peerConnectionConstruction: "pass", closed: true };

  const oldUmask = process.umask(0o077);
  let chromium;
  try {
    chromium = await startChromium(context, {
      label: "mobile-peer-route-preflight",
      profileName: "mobile-peer-route-preflight",
      windowSize: { width: 390, height: 844 },
    });
  } finally {
    process.umask(oldUmask);
  }
  try {
    const profile = await lstat(chromium.profileDir);
    assert.equal(profile.isDirectory(), true);
    assert.equal(profile.uid, process.getuid?.() ?? profile.uid);
    assert.equal(profile.mode & 0o077, 0, "owned Chromium profile must be private");
    const page = await chromium.newPersistentPage();
    const capabilities = await page.evaluate(() => ({
      rtcpPeerConnection: typeof globalThis.RTCPeerConnection === "function",
      dataChannel: typeof globalThis.RTCPeerConnection === "function" &&
        "createDataChannel" in globalThis.RTCPeerConnection.prototype,
    }));
    assert.equal(capabilities.rtcpPeerConnection, true, "actual Chromium must expose native RTCPeerConnection");
    assert.equal(capabilities.dataChannel, true, "actual Chromium must expose native RTCDataChannel support");
    assert.equal(chromium.sandboxedIframeIsolation, "browser-default");
    result.chromium = {
      version: chromium.browser.version(),
      noSandbox: chromium.noSandbox,
      profileMode: (profile.mode & 0o777).toString(8).padStart(4, "0"),
      profileOwned: true,
      rtc: capabilities,
      forbiddenWebSecurityFlagsAddedByTest: false,
    };
  } finally {
    await chromium.close();
  }
  return result;
}

async function hashNodeGatewayRuntimeSources() {
  const files = [
    "dev-server.mjs",
    "src/mobile-device-auth.js",
    "src/mobile-peer-gateway.js",
    "src/mobile-peer-json.js",
    "src/mobile-peer-ownership.js",
    "src/mobile-peer-transport.js",
    "src/mobile-peer-tunnel.js",
    "src/mobile-web-cors.js",
    "../kcoder-relay/src/client.mjs",
    "../kcoder-relay/src/server.mjs",
    "../kcoder-studio/shared/gatewayConnectionRoutes.js",
    "../kcoder-studio/shared/gatewayPeerTransport.js",
  ];
  const hashes = {};
  for (const relativePath of files) {
    const absolutePath = resolve(appRoot, relativePath);
    hashes[relativePath] = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
  }
  return {
    files: hashes,
    treeSha256: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
  };
}

async function startOfficialMobileMount(context, root) {
  let port = 0;
  const origin = () => `http://localhost:${port}`;
  const publicOrigins = new Set();
  const serveMobile = createMobileWebStatic({
    root,
    publicOrigins,
    directPort: () => port,
    contentSecurityPolicy: CSP,
  });
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      if (await serveMobile(request, response, pathname)) return;
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(500, { "cache-control": "no-store" });
      response.end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  port = server.address().port;
  publicOrigins.add(origin());
  context.registerPort("mobile-peer-route-web-origin", port);
  context.addCleanup("close owned Mobile peer-route web mount", () => closeServer(server));
  return { server, origin: origin() };
}

async function startTransportSmokePage(context) {
  const mobileRequire = createRequire(resolve(appRoot, "mobile/package.json"));
  const esbuild = mobileRequire("esbuild");
  const entryPoint = resolve(appRoot, "e2e/private/mobile-peer-transport-smoke.browser.ts");
  const cryptoAdapter = resolve(appRoot, "e2e/private/mobile-peer-transport-crypto-adapter.browser.ts");
  const previousUmask = process.umask(0o077);
  let bundle;
  let metafile;
  try {
    const output = await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      write: false,
      outfile: "mobile-peer-transport-smoke.bundle.mjs",
      platform: "browser",
      format: "esm",
      target: "es2022",
      minify: true,
      mainFields: ["browser", "module", "main"],
      resolveExtensions: [".web.ts", ".web.tsx", ".web.js", ".ts", ".tsx", ".js", ".mjs", ".json"],
      metafile: true,
      plugins: [{
        name: "owned-smoke-webcrypto-adapter",
        setup(build) {
          build.onResolve({ filter: /^\.\/connection-route-crypto$/ }, args =>
            args.importer.endsWith("/mobile/src/gateway/peer-transport.ts")
              ? { path: cryptoAdapter }
              : null);
        },
      }],
    });
    bundle = output.outputFiles[0]?.contents;
    metafile = output.metafile;
    assert.ok(bundle instanceof Uint8Array && bundle.byteLength > 0, "esbuild must produce a browser transport bundle");
    await writeFile(context.pathInArtifacts("mobile-peer-transport-smoke.bundle.mjs"), bundle, { mode: 0o600 });
  } finally {
    process.umask(previousUmask);
  }
  const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
  const sourceSha256 = createHash("sha256").update(await readFile(entryPoint)).digest("hex");
  const adapterSha256 = createHash("sha256").update(await readFile(cryptoAdapter)).digest("hex");
  const bundleInputs = Object.keys(metafile.inputs).map(path => path.replaceAll("\\", "/"));
  assert.ok(bundleInputs.some(path => path.endsWith("/mobile/src/gateway/peer-transport.ts")),
    "smoke bundle must include the current Mobile peer-transport.ts source");
  assert.ok(bundleInputs.some(path => path.endsWith("/peer-transport-platform.web.ts")),
    "smoke bundle must resolve Mobile's actual web RTCPeerConnection adapter");

  const shellHtml = `<!doctype html><meta charset="utf-8"><title>Owned Mobile P2P transport smoke</title><script type="module" src="/mobile-peer-transport-smoke.bundle.mjs"></script>`;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (pathname === "/" || pathname === "/index.html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self'; connect-src 'self' http: https:",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      response.end(shellHtml);
      return;
    }
    if (pathname === "/mobile-peer-transport-smoke.bundle.mjs") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self' http: https:",
        "x-content-type-options": "nosniff",
      });
      response.end(bundle);
      return;
    }
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const origin = `http://localhost:${server.address().port}`;
  context.registerPort("mobile-peer-transport-smoke-shell", server.address().port);
  context.addCleanup("close owned Mobile transport-smoke shell", () => closeServer(server));
  return {
    server,
    origin,
    bundle: {
      source: "apps/kcoder-studio/mobile/src/gateway/peer-transport.ts",
      entryPoint: "apps/kcoder-studio/e2e/private/mobile-peer-transport-smoke.browser.ts",
      entrySourceSha256: sourceSha256,
      webCryptoAdapterSha256: adapterSha256,
      bundleSha256,
      bundleBytes: bundle.byteLength,
      includedMobileWebAdapter: "peer-transport-platform.web.ts",
      includedInputCount: bundleInputs.length,
      expoCryptoAdapter: "secure WebCrypto-only adapter for this esbuild smoke; production Mobile export remains separately tested",
    },
  };
}

async function runDirectTransportSmoke(context, fixture, origin) {
  const recordStart = fixture.records.length;
  const beforeDevices = await fixture.adminDeviceCount();
  const previousUmask = process.umask(0o077);
  let chromium;
  try {
    chromium = await startChromium(context, {
      label: "mobile-peer-route-transport-smoke",
      profileName: "mobile-peer-route-transport-smoke",
      windowSize: { width: 390, height: 844 },
    });
  } finally {
    process.umask(previousUmask);
  }
  try {
    const page = await chromium.newPersistentPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const outcomePromise = page.evaluate(config => {
      const runSmoke = Reflect.get(window, "runMobilePeerTransportSmoke");
      if (typeof runSmoke !== "function") throw new Error("Current source peer-transport smoke bundle did not load");
      return runSmoke(config);
    }, {
      pairingToken: fixture.pairing.token,
      publicBaseUrl: fixture.pairing.publicBaseUrl,
      descriptor: fixture.pairing.connectionRoutes,
      accessTtlMs: ACCESS_TTL_MS,
    }).then(value => ({ value }), error => ({ error }));
    const stage = await waitFor(async () => {
      const current = await page.evaluate(() => Reflect.get(window, "__mobilePeerTransportSmokeStage") ?? null);
      if (current === "failed") return "failed";
      return current === "peer-connected-awaiting-public-loss" ? current : null;
    }, 25_000, "source-pinned browser peer-transport connection before public loss", 100, context.abortSignal);
    if (stage === "failed") {
      const outcome = await outcomePromise;
      throw outcome.error || new Error("Browser transport smoke failed before public-loss checkpoint");
    }
    const signalingRows = fixture.records.slice(recordStart);
    assert.ok(signalingRows.some(row => row.route === "public" && row.method === "GET" && fixtureGatewayPath(row) === "/api/mobile/p2p" && row.responseStatus === 200),
      "real browser source bundle must fetch P2P configuration from the owned Gateway");
    assert.ok(signalingRows.some(row => row.route === "public" && row.method === "POST" && fixtureGatewayPath(row) === "/api/mobile/p2p/offer" && row.responseStatus === 200),
      "real browser source bundle must post a signed P2P offer to the owned Gateway");
    fixture.setPublicDown(true);
    await page.evaluate(() => { Reflect.set(window, "__continueMobilePeerTransportSmoke", true); });
    const outcome = await outcomePromise;
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.value?.refresh?.status, 200, "P2P access refresh must succeed after public Relay loss");
    assert.equal(outcome.value?.refresh?.deviceIdentityStable, true, "P2P access refresh must retain the device identity");
    assert.equal(outcome.value?.refresh?.authorizationGenerationStable, true, "P2P access refresh must retain the authorization generation");
    assert.equal(outcome.value?.refresh?.accessValueChanged, true, "P2P access refresh must rotate the access credential");
    const rowsAfterPublicLoss = fixture.records.slice(recordStart).filter(row => row.route === "public" && row.transportFailure);
    assert.equal(rowsAfterPublicLoss.length, 0, "P2P HTTP/RPC/refresh must continue without using the unavailable public Relay path");
    const afterDevices = await fixture.adminDeviceCount();
    assert.equal(afterDevices, beforeDevices + 1, "P2P session creation and refresh must preserve a single Gateway device");
    return {
      result: "pass",
      scope: "direct source bundle smoke; not the exported Mobile Web UI acceptance",
      publicRelayDisabledAfterPeerEstablished: true,
      gatewayDeviceCount: afterDevices,
      browserVersion: chromium.browser.version(),
      evidence: outcome.value,
      signaling: summarizeFixtureRecords(signalingRows),
      publicRouteAttemptsAfterLoss: summarizeFixtureRecords(rowsAfterPublicLoss),
    };
  } finally {
    await chromium.close();
  }
}

async function runLanAcceptance(context, fixture, mobileOrigin, expectedDeviceCount) {
  const start = fixture.records.length;
  return withMobileBrowser(context, "mobile-peer-route-lan", async ({ page, browser }) => {
    await installAndObserve(page);
    const sessionBootstrap = await pairAndRead(context, page, mobileOrigin, fixture.pairing, fixture.routes);
    const profile = await readStoredProfile(page, fixture.pairing.token, fixture.pairing.publicBaseUrl);
    const browserAudit = await readAudit(page);
    const devices = await fixture.adminDeviceCount();
    const rows = fixture.records.slice(start);
    assert.ok(rows.some(row => row.route === "lan" && fixtureGatewayPath(row) === "/api/mobile/session" && row.method === "POST" && row.responseStatus === 200),
      "pairing session POST must use the signed LAN route");
    assert.ok(rows.some(row => row.route === "lan" && fixtureGatewayPath(row) === "/api/servers/status" && row.method === "GET" && row.responseStatus === 200),
      "real server status HTTP request must use LAN; the inventory itself comes from the versioned session bootstrap");
    assert.ok(rows.some(row => row.route === "lan" && row.upgrade && fixtureGatewayPath(row) === "/rpc" && row.responseStatus === 101),
      "RPC WebSocket must upgrade through LAN");
    assert.equal(rows.filter(row => isP2PSignalRow(row)).length, 0, "LAN preference must not request P2P signaling or create a peer connection");
    assert.equal(devices, expectedDeviceCount + 1, "LAN pairing must create exactly one owned device");
    assertProfile(profile, fixture, browserAudit, expectedDeviceCount + 1);
    assertRpcMethods(browserAudit, ["initialize", "thread/list", "thread/read"]);
    assert.equal(browserAudit.rtc.connections.length, 0, "LAN winner must not construct RTCPeerConnection");
    await page.screenshot({ path: context.pathInArtifacts("mobile-peer-route-lan.png"), fullPage: true });
    return {
      result: "pass",
      initialServerInventory: sessionBootstrap,
      evidence: summarizeBrowserAudit(browserAudit),
      fixture: summarizeFixtureRecords(rows),
      profile: summarizeProfile(profile),
      gatewayDeviceCount: devices,
      chromiumVersion: browser.browser.version(),
      rtcConnections: browserAudit.rtc.connections.length,
      screenshot: "mobile-peer-route-lan.png",
    };
  });
}

async function runRelayFallbackAcceptance(context, fixture, mobileOrigin, expectedDeviceCount) {
  const start = fixture.records.length;
  return withMobileBrowser(context, "mobile-peer-route-relay-fallback", async ({ page }) => {
    await installAndObserve(page);
    const sessionBootstrap = await pairAndRead(context, page, mobileOrigin, fixture.pairing, fixture.routes);
    const profile = await readStoredProfile(page, fixture.pairing.token, fixture.pairing.publicBaseUrl);
    const audit = await readAudit(page);
    const devices = await fixture.adminDeviceCount();
    const rows = fixture.records.slice(start);
    const offers = audit.fetches.filter(row => row.path.endsWith("/api/mobile/p2p/offer"));
    assert.ok(offers.length === 0 || offers.every(row => row.failed || row.status === 503),
      "P2P signaling fault must fail before accepting a peer answer");
    assert.ok(rows.some(row => row.route === "public" && fixtureGatewayPath(row) === "/api/mobile/session" && row.method === "POST" && row.responseStatus === 200),
      "pairing must fall back to exactly one successful Relay-path session POST");
    assert.equal(rows.filter(row => row.method === "POST" && fixtureGatewayPath(row) === "/api/mobile/session").length, 1,
      "failed P2P setup must not replay the pairing POST");
    assert.ok(rows.some(row => row.route === "public" && row.method === "GET" && fixtureGatewayPath(row) === "/api/servers/status" && row.responseStatus === 200),
      "real server status HTTP must succeed over the owned Relay path after inventory bootstrap");
    assert.ok(rows.some(row => row.route === "public" && row.upgrade && fixtureGatewayPath(row) === "/rpc" && row.responseStatus === 101),
      "RPC WebSocket must upgrade over the owned Relay path after P2P failure");
    assert.equal(devices, expectedDeviceCount + 1, "fallback pairing must create one owned device");
    assertProfile(profile, fixture, audit, expectedDeviceCount + 1);
    assertRpcMethods(audit, ["initialize", "thread/list", "thread/read"]);
    assert.equal(audit.rtc.channels.reduce((sum, channel) => sum + channel.sentFrames + channel.receivedFrames, 0), 0,
      "failed signaling must not open an application DataChannel");
    return {
      result: "pass",
      fallback: "owned public Relay path after P2P signaling returned unavailable",
      initialServerInventory: sessionBootstrap,
      evidence: summarizeBrowserAudit(audit),
      fixture: summarizeFixtureRecords(rows),
      profile: summarizeProfile(profile),
      gatewayDeviceCount: devices,
    };
  });
}

async function runInvalidAnswerSignatureAcceptance(context, fixture, mobileOrigin, expectedDeviceCount) {
  const start = fixture.records.length;
  return withMobileBrowser(context, "mobile-peer-route-invalid-answer-signature", async ({ page }) => {
    await installAndObserve(page);
    const sessionBootstrap = await pairAndRead(context, page, mobileOrigin, fixture.pairing, fixture.routes);
    const profileBefore = await readStoredProfile(page, fixture.pairing.token, fixture.pairing.publicBaseUrl);
    const auditBefore = await readAudit(page);
    const pairedDevices = await fixture.adminDeviceCount();
    assert.equal(pairedDevices, expectedDeviceCount + 1, "signature negative case pairing must create one device before injecting the answer fault");
    assertProfile(profileBefore, fixture, auditBefore, expectedDeviceCount + 1);

    const phaseStart = fixture.records.length;
    fixture.setLanDown(true);
    fixture.setP2PAnswerSignatureInvalid(true);
    const beforeData = readDataChannelTotals(auditBefore.rtc.channels);
    await openDiagnosticsFromTask(context, page);
    await rerunDiagnosticsAndWaitForHttp(context, page);
    await returnToActiveTask(page);
    await waitFor(async () => {
      const audit = await readAudit(page);
      return audit.webSockets.some(socket => socket.route === "public" && socket.sentMethods.includes("thread/read") &&
        socket.terminalResults.some(result => result.method === "thread/read" && result.terminal === "result"))
        ? true : null;
    }, 20_000, "successful RPC thread read after invalid answer fell back to public Relay", 100, context.abortSignal);
    const audit = await readAudit(page);
    const phaseRows = fixture.records.slice(phaseStart);
    const offer = audit.fetches.filter(row => row.path.endsWith("/api/mobile/p2p/offer")).at(-1);
    const transformedRows = phaseRows.filter(row => row.injectedFailure === "p2p-answer-signature-invalid");
    const profileAfter = await readStoredProfile(page, fixture.pairing.token, fixture.pairing.publicBaseUrl);
    const deviceCount = await fixture.adminDeviceCount();
    const channelTotals = readDataChannelTotals(audit.rtc.channels);
    assert.ok(transformedRows.length >= 1, "owned route proxy must transform an actual Gateway signed answer");
    assert.ok(offer, "browser must POST a real P2P offer before answer rejection");
    assert.equal(offer.offerShapeValid, true, "P2P offer must have the versioned HMAC-authenticated schema");
    assert.equal(offer.containsPairingToken, false, "P2P offer body/SDP must not contain the raw pairing token");
    assert.equal(offer.containsSessionToken, false, "P2P offer body/SDP must not contain a raw access, refresh, or RPC token");
    assert.equal(offer.authKind, "access", "profile-scope offer must authenticate with an access-token HMAC scope");
    const configRows = audit.fetches.filter(row => row.path.endsWith("/api/mobile/p2p"));
    assert.ok(configRows.some(row => row.status === 200), "P2P configuration must come from the real Gateway");
    assert.ok(configRows.every(row => row.configCredentialLeak === false), "P2P configuration must not expose raw pairing or session credentials");
    assert.equal(channelTotals.sentFrames, beforeData.sentFrames, "invalid signed answer must be rejected before sending any DataChannel application frame");
    assert.equal(channelTotals.receivedFrames, beforeData.receivedFrames, "invalid signed answer must be rejected before receiving any DataChannel application frame");
    assert.equal(channelTotals.sentBytes, beforeData.sentBytes, "invalid signed answer must not send any DataChannel application bytes or credentials");
    assert.equal(channelTotals.receivedBytes, beforeData.receivedBytes, "invalid signed answer must not receive any DataChannel application bytes");
    assert.equal(profileAfter.id, profileBefore.id, "answer signature rejection must not replace the profile");
    assert.equal(profileAfter.deviceId, profileBefore.deviceId, "answer signature rejection must not replace the device identity");
    assert.equal(deviceCount, pairedDevices, "answer signature rejection must not create or pair another device");
    assert.ok(phaseRows.some(row => row.route === "public" && row.method === "GET" && fixtureGatewayPath(row) === "/api/servers" && row.responseStatus === 200),
      "after answer-signature rejection, a real server-list HTTP request must succeed over the owned public Relay fallback");
    assert.ok(phaseRows.some(row => row.route === "public" && row.method === "GET" && fixtureGatewayPath(row) === "/api/servers/status" && row.responseStatus === 200),
      "server status HTTP must also succeed over the owned public Relay fallback");
    assert.ok(phaseRows.some(row => row.route === "public" && row.upgrade && fixtureGatewayPath(row) === "/rpc" && row.responseStatus === 101),
      "RPC WebSocket must succeed over the public Relay after the invalid answer is rejected");
    assert.ok(audit.webSockets.some(socket => socket.route === "public" && socket.sentMethods.includes("thread/read") &&
      socket.terminalResults.some(result => result.method === "thread/read" && result.terminal === "result")),
      "real thread/read RPC must complete through public fallback after the signature rejection");
    assert.equal(phaseRows.some(row => row.method === "POST" && fixtureGatewayPath(row) === "/api/mobile/session"), false,
      "the already-paired profile must not replay its pairing session POST during signature fallback");
    return {
      result: "pass",
      answerSignature: "actual HTTP 200 answer was transformed to an invalid Ed25519 signature by the owned route proxy; client rejected it",
      fallback: "owned public Relay HTTP and RPC succeeded after the client rejected the invalid P2P answer signature",
      initialServerInventory: sessionBootstrap,
      offer: summarizeSensitiveOffer(offer),
      profileBefore: summarizeProfile(profileBefore),
      profileAfter: summarizeProfile(profileAfter),
      dataChannel: channelTotals,
      fixture: summarizeFixtureRecords(phaseRows),
      gatewayDeviceCount: deviceCount,
    };
  });
}

async function runPeerSurvivesPublicLossAcceptance(context, fixture, mobileOrigin, expectedDeviceCount) {
  const start = fixture.records.length;
  return withMobileBrowser(context, "mobile-peer-route-public-loss", async ({ page, browser }) => {
    await installAndObserve(page);
    const sessionBootstrap = await pairAndRead(context, page, mobileOrigin, fixture.pairing, fixture.routes);
    const profileBefore = await readStoredProfile(page, fixture.pairing.token, fixture.pairing.publicBaseUrl);
    const peer = await waitFor(async () => {
      const current = await readAudit(page);
      const candidate = findOpenPeerChannel(current.rtc);
      return candidate?.selectedPair?.localCandidateType && candidate?.selectedPair?.remoteCandidateType
        ? candidate
        : null;
    }, 20_000, "open browser P2P DataChannel", 100, context.abortSignal);
    const before = await waitFor(async () => {
      const audit = await readAudit(page);
      const peerChannels = audit.rtc.channels.filter(channel =>
        channel.label === "kcoder-gateway-v1" && channel.state === "open");
      const methods = peerChannels.flatMap(channel => channel.rpcMethods);
      const results = peerChannels.flatMap(channel => channel.rpcResults);
      const required = ["initialize", "thread/list", "thread/read"];
      return required.every(method => methods.includes(method) &&
        results.some(result => result.method === method && result.terminal === "result"))
        ? audit : null;
    }, 15_000, "initial P2P initialize, thread/list, and thread/read results", 100, context.abortSignal);
    assert.ok(peer, "signed P2P answer must establish an open browser DataChannel");
    const initialPeerChannels = before.rtc.channels.filter(channel =>
      channel.label === "kcoder-gateway-v1" && channel.state === "open");
    const initialPeerRpcMethods = initialPeerChannels.flatMap(channel => channel.rpcMethods);
    const initialPeerRpcResults = initialPeerChannels.flatMap(channel => channel.rpcResults);
    assertRpcMethodsFromList(initialPeerRpcMethods, ["initialize", "thread/list", "thread/read"]);
    for (const method of ["initialize", "thread/list", "thread/read"]) {
      assert.ok(initialPeerRpcResults.some(row => row.method === method && row.terminal === "result"),
        `initial P2P WebSocket must return a real ${method} result`);
    }
    const initialPeerTraffic = readDataChannelTotals(before.rtc.channels.filter(row => row.opened));
    assert.ok(initialPeerTraffic.sentBytes > 0 && initialPeerTraffic.receivedBytes > 0,
      "actual pairing and Mobile HTTP/RPC messages must carry bytes in both DataChannel directions");
    const pairingOverPeer = before.rtc.channels.flatMap(channel => channel.httpOperations)
      .find(row => row.method === "POST" && row.path === "/api/mobile/session" && row.status === 200);
    assert.ok(pairingOverPeer, "the LAN-down pairing session POST must complete through the P2P DataChannel");
    assert.ok(peer.selectedPair?.localCandidateType && peer.selectedPair?.remoteCandidateType,
      "browser RTC stats must expose the selected ICE candidate pair types");
    const p2pOffers = before.fetches.filter(row => row.path.endsWith("/api/mobile/p2p/offer"));
    assert.ok(p2pOffers.some(row => row.authKind === "pairing"), "ephemeral pairing scope must authenticate its P2P offer with the pairing HMAC");
    assert.ok(p2pOffers.some(row => row.authKind === "access"), "profile scope must establish a separate access-HMAC-authenticated P2P transport");
    assert.ok(p2pOffers.every(row => row.offerShapeValid && !row.containsPairingToken && !row.containsSessionToken),
      "P2P offer bodies and SDP must contain only scoped HMAC proofs, never raw credentials");
    const p2pConfig = before.fetches.filter(row => row.path.endsWith("/api/mobile/p2p"));
    assert.ok(p2pConfig.length > 0 && p2pConfig.every(row => row.status === 200 && row.configCredentialLeak === false),
      "real P2P configuration must succeed without exposing pairing or session credentials");

    const lossStart = fixture.records.length;
    const beforePublicLoss = await readAudit(page);
    fixture.setPublicDown(true);
    const postLossWaitMs = Math.max(ROUTE_CACHE_WAIT_MS, ACCESS_TTL_MS + 1_000);
    await waitFor(() => Date.now() >= peer.waitUntil, postLossWaitMs + 3_000,
      "route-cache and access-token expiry intervals while the browser DataChannel stays open", 100, context.abortSignal);
    const beforeDiagnostics = await readAudit(page);
    const beforeDiagnosticsTraffic = readDataChannelTotals(beforeDiagnostics.rtc.channels.filter(row => row.state === "open"));
    await openDiagnosticsFromTask(context, page);
    await rerunDiagnosticsAndWaitForHttp(context, page, { requireSessionRefresh: true });
    await returnToActiveTask(page);
    await waitFor(async () => {
      const audit = await readAudit(page);
      const totals = readDataChannelTotals(audit.rtc.channels.filter(row => row.state === "open"));
      return totals.sentBytes > beforeDiagnosticsTraffic.sentBytes && totals.receivedBytes > beforeDiagnosticsTraffic.receivedBytes ? true : null;
    }, 10_000, "new bidirectional business DataChannel traffic after diagnostics and RPC following public Relay loss", 100, context.abortSignal);

    const after = await readAudit(page);
    const afterTraffic = readDataChannelTotals(after.rtc.channels.filter(row => row.state === "open"));
    const profileAfter = await readStoredProfile(page, fixture.pairing.token, fixture.pairing.publicBaseUrl);
    const devices = await fixture.adminDeviceCount();
    const rowsAfterLoss = fixture.records.slice(lossStart);
    const recentMethods = collectRecentRpcMethods(after.rtc.channels, beforeDiagnostics.rtc.channels);
    const recentResults = collectRecentRpcResults(after.rtc.channels, beforeDiagnostics.rtc.channels);
    const p2pHttp = collectRecentHttpOperations(after.rtc.channels, beforeDiagnostics.rtc.channels);
    const postLossHttp = collectRecentHttpOperations(after.rtc.channels, beforePublicLoss.rtc.channels);
    const selectedPairs = after.rtc.connections.flatMap(connection => connection.selectedPairs || []);
    await context.writeArtifactJson("mobile-peer-route-public-loss-runtime-audit.json", {
      routeCacheWaitMs: ROUTE_CACHE_WAIT_MS,
      accessTtlMs: ACCESS_TTL_MS,
      postLossWaitMs,
      profile: {
        exists: profileAfter.count > 0,
        count: profileAfter.count,
        canonicalPublicUrlMatches: profileAfter.baseUrl === fixture.pairing.publicBaseUrl,
        deviceIdentityPresent: Boolean(profileAfter.deviceId),
        pairingCredentialStored: profileAfter.pairingCredentialStored,
      },
      visibleUiErrors: await page.locator('[role="alert"]').allTextContents()
        .then(values => values.slice(0, 8).map(value => safeFailure(context, value)))
        .catch(() => []),
      pairingSessionRequest: pairingOverPeer ? {
        status: pairingOverPeer.status,
        bodyLength: pairingOverPeer.bodyLength,
        hasBody: pairingOverPeer.hasBody,
        durableDeviceAuthorization: pairingOverPeer.durableDeviceAuthorization,
      } : null,
      rtc: {
        connections: after.rtc.connections.map(connection => ({
          connectionState: connection.connectionState,
          iceConnectionState: connection.iceConnectionState,
          selectedPairs: connection.selectedPairs.slice(-8),
        })),
        channels: after.rtc.channels.map(channel => ({
          state: channel.state,
          opened: channel.opened,
          sentBytes: channel.sentBytes,
          receivedBytes: channel.receivedBytes,
          sentFrames: channel.sentFrames,
          receivedFrames: channel.receivedFrames,
          sentFrameTypes: channel.sentFrameTypes.slice(-40),
          receivedFrameTypes: channel.receivedFrameTypes.slice(-40),
          httpOperations: channel.httpOperations.slice(-40).map(({ id: _id, ...row }) => row),
          responseStarts: channel.responseStarts.slice(-40),
          rpcMethods: channel.rpcMethods.slice(-40),
          rpcResults: channel.rpcResults.slice(-40),
        })),
      },
      recentRpcMethods: recentMethods.slice(-40),
      recentRpcResults: recentResults.slice(-40),
      initialPeerRpcMethods: initialPeerRpcMethods.slice(-40),
      initialPeerRpcResults: initialPeerRpcResults.slice(-40),
      peerHttpAfterDiagnostics: p2pHttp.slice(-40),
      peerHttpAfterPublicLoss: postLossHttp.slice(-40),
      fixtureAfterPublicLoss: summarizeFixtureRecords(rowsAfterLoss).slice(-40),
    });
    assertRpcMethodsFromList(recentMethods, ["thread/list"]);
    assert.ok(recentResults.some(row => row.method === "thread/list" && row.terminal === "result"),
      "peer WebSocket must return a real thread/list result after public Relay loss");
    assert.ok(p2pHttp.some(row => row.method === "GET" && row.path === "/api/servers" && row.status === 200),
      "diagnostics must fetch the server list over the already-established peer route after cache expiry");
    assert.ok(p2pHttp.some(row => row.method === "GET" && row.path === "/api/servers/status" && row.status === 200),
      "diagnostics must fetch server status over the already-established peer route after cache expiry");
    assert.ok(postLossHttp.some(row => row.method === "POST" && row.path === "/api/mobile/session/refresh" && row.status === 200),
      "expired Mobile access credentials must refresh successfully over the existing peer route after public Relay loss");
    assert.ok(afterTraffic.sentBytes > beforeDiagnosticsTraffic.sentBytes && afterTraffic.receivedBytes > beforeDiagnosticsTraffic.receivedBytes,
      "diagnostics and real Mobile RPC after the 15s cache interval must increase DataChannel bytes in both directions");
    assert.ok(selectedPairs.some(pair => pair.localCandidateType && pair.remoteCandidateType),
      "actual selected candidate pair types must be retained after route-cache expiry");
    assert.equal(rowsAfterLoss.some(row => row.route === "public" && ["/api/mobile/connection-proof", "/api/mobile/p2p", "/api/mobile/p2p/offer"].includes(fixtureGatewayPath(row))), false,
      "a live peer must not be blocked by a new public proof or public P2P signaling request after cache expiry");
    assert.equal(rowsAfterLoss.some(row => row.route === "public" && (fixtureGatewayPath(row) === "/api/servers" || fixtureGatewayPath(row) === "/rpc")), false,
      "Mobile business HTTP/RPC must not depend on the now-unavailable public Relay");
    assert.equal(devices, expectedDeviceCount + 1, "public Relay loss must not create another Gateway device");
    assert.equal(profileAfter.id, profileBefore.id, "public Relay loss must preserve the profile id");
    assert.equal(profileAfter.deviceId, profileBefore.deviceId, "public Relay loss must preserve the device id");
    assert.equal(profileAfter.baseUrl, fixture.pairing.publicBaseUrl, "profile must retain canonical public Gateway URL while its selected route is P2P");
    return {
      result: "pass",
      initialServerInventory: sessionBootstrap,
      routeCacheWaitMs: ROUTE_CACHE_WAIT_MS,
      accessTtlMs: ACCESS_TTL_MS,
      postLossWaitMs,
      publicRelay: "owned public route proxy disabled after peer establishment",
      initialPeerRpc: {
        methods: initialPeerRpcMethods,
        results: initialPeerRpcResults,
      },
      rpcAfterPublicLoss: {
        methods: recentMethods,
        results: recentResults,
      },
      selectedCandidatePairs: selectedPairs.map(pair => ({
        localCandidateType: pair.localCandidateType,
        remoteCandidateType: pair.remoteCandidateType,
        bytesSent: pair.bytesSent,
        bytesReceived: pair.bytesReceived,
      })),
      dataChannelTrafficBeforeLoss: initialPeerTraffic,
      dataChannelTrafficAfterCacheExpiry: {
        beforeDiagnostics: beforeDiagnosticsTraffic,
        afterDiagnosticsAndRpc: afterTraffic,
      },
      httpOperationsAfterPublicLoss: postLossHttp,
      pairingSessionRequest: pairingOverPeer ? {
        status: pairingOverPeer.status,
        bodyLength: pairingOverPeer.bodyLength,
        hasBody: pairingOverPeer.hasBody,
        durableDeviceAuthorization: pairingOverPeer.durableDeviceAuthorization,
      } : null,
      newHttpOperations: p2pHttp,
      newRpcMethods: recentMethods,
      profileBefore: summarizeProfile(profileBefore),
      profileAfter: summarizeProfile(profileAfter),
      gatewayDeviceCount: devices,
      browserVersion: browser.browser.version(),
      fixture: summarizeFixtureRecords(rowsAfterLoss),
    };
  });
}

async function withMobileBrowser(context, label, body) {
  const oldUmask = process.umask(0o077);
  let chromium;
  try {
    chromium = await startChromium(context, {
      label,
      profileName: label,
      windowSize: { width: 390, height: 844 },
    });
  } finally {
    process.umask(oldUmask);
  }
  try {
    const page = await chromium.newPersistentPage();
    await page.setViewportSize({ width: 390, height: 844 });
    return await body({ page, browser: chromium });
  } finally {
    await chromium.close();
  }
}

async function pairAndRead(context, page, mobileOrigin, pairing, routes) {
  const responsePromise = page.waitForResponse(response => {
    let url;
    try { url = new URL(response.url()); } catch { return false; }
    return response.request().method() === "POST" && url.pathname.endsWith("/api/mobile/session");
  }, { timeout: 3_000 }).catch(() => null);
  await page.goto(makeFragmentPairingLink(mobileOrigin, pairing, routes), {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForFunction(() => !location.hash && !new URLSearchParams(location.search).has("token"), null, { timeout: 10_000 });
  const sessionResponse = await responsePromise;
  let sessionBootstrap;
  if (sessionResponse) {
    const session = await sessionResponse.json().catch(() => null);
    await registerSessionSecrets(page, session);
    sessionBootstrap = summarizeSessionBootstrap(session, sessionResponse.status());
  } else {
    sessionBootstrap = await waitFor(async () => {
      const audit = await readAudit(page);
      return audit?.sessionBootstrap?.httpStatus === 200 ? audit.sessionBootstrap : null;
    }, 20_000, "pairing session bootstrap response over the selected route", 100).catch(async error => {
      const audit = await readAudit(page);
      let profile = null;
      try { profile = await readStoredProfile(page, pairing.token, pairing.publicBaseUrl); }
      catch { /* Keep the timeout diagnostic useful when profile storage is unreadable. */ }
      const rtc = audit?.rtc ?? { connections: [], channels: [] };
      await context.writeArtifactJson("mobile-peer-route-pair-bootstrap-diagnostic.json", {
        failure: error.message,
        sessionBootstrap: audit?.sessionBootstrap ?? null,
        profile: profile ? {
          exists: profile.count > 0,
          count: profile.count,
          matchesCanonicalUrl: profile.canonicalPublicUrlMatches,
          deviceIdentityPresent: Boolean(profile.deviceId),
          pairingCredentialStored: profile.pairingCredentialStored,
        } : null,
        visibleUiErrors: await page.locator('[role="alert"]').allTextContents()
          .then(values => values.slice(0, 8).map(value => safeFailure(context, value)))
          .catch(() => []),
        fetches: (audit?.fetches ?? []).map(row => ({
          method: row.method,
          path: row.path,
          route: row.route,
          status: row.status,
          failed: row.failed,
          offerShapeValid: row.offerShapeValid,
          authKind: row.authKind,
        })),
        rtc: {
          connections: rtc.connections.map(connection => ({
            connectionState: connection.connectionState,
            iceConnectionState: connection.iceConnectionState,
            selectedPairs: connection.selectedPairs,
          })),
          channels: rtc.channels.map(channel => ({
            label: channel.label,
            state: channel.state,
            opened: channel.opened,
            sentBytes: channel.sentBytes,
            receivedBytes: channel.receivedBytes,
            bufferedAmount: channel.bufferedAmount,
            bufferedAmountHighWaterMark: channel.bufferedAmountHighWaterMark,
            sentFrameTypes: channel.sentFrameTypes,
            receivedFrameTypes: channel.receivedFrameTypes,
            httpOperations: channel.httpOperations,
            responseStarts: channel.responseStarts,
            rpcMethods: channel.rpcMethods,
            rpcResults: channel.rpcResults,
          })),
        },
      });
      throw error;
    });
  }
  assertPairingBootstrap(sessionBootstrap);
  await page.getByTestId("sessions").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("sessions").click();
  await page.getByTestId("session-mock-active-session").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("session-mock-active-session").click();
  await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("message-user").filter({ hasText: "历史附件" }).waitFor({ state: "visible", timeout: 20_000 });
  return sessionBootstrap;
}

function assertPairingBootstrap(bootstrap) {
  assert.equal(bootstrap?.httpStatus, 200, "real pairing session HTTP POST must return 200");
  assert.equal(bootstrap?.mobileInitialServersV1, true, "pairing response must advertise the versioned initial server inventory");
  assert.equal(bootstrap?.initialServersVersion, 1, "pairing response must carry initialServers version 1");
  assert.ok(bootstrap?.serverCount > 0 && bootstrap.serverIds.length > 0,
    "pairing response must carry real server inventory rather than relying on a duplicate list GET");
}

async function openDiagnosticsFromTask(context, page) {
  await page.getByTestId("task-header").getByRole("button").first().click();
  await page.getByTestId("sessions-list").waitFor({ state: "visible", timeout: 15_000 });
  await clickVisibleButtonByNames(page, ["Back", "返回"]);
  await page.getByTestId("sessions").waitFor({ state: "visible", timeout: 15_000 });
  await clickVisibleButtonByNames(page, ["Settings", "设置"]);
  await page.getByTestId("settings-home").waitFor({ state: "visible", timeout: 15_000 });
  await clickVisibleTestId(page, "diagnostics-settings");
  await page.getByTestId("settings-diagnostics-screen").waitFor({ state: "visible", timeout: 15_000 });
  if (context.abortSignal.aborted) throw context.abortSignal.reason;
}

async function rerunDiagnosticsAndWaitForHttp(context, page, { requireSessionRefresh = false } = {}) {
  const button = page.getByTestId("settings-rerun-diagnostics");
  await button.waitFor({ state: "visible", timeout: 10_000 });
  await waitFor(async () => await button.isEnabled() ? true : null,
    10_000, "Mobile diagnostics refresh button enabled", 50, context.abortSignal);
  await button.click();
  return await waitFor(async () => {
    const audit = await readAudit(page);
    const operations = [
      ...(audit?.rtc?.channels ?? []).flatMap(channel => channel.httpOperations),
      ...(audit?.fetches ?? []).map(row => {
        const path = row.path.startsWith(`${RELAY_GATEWAY_PATH_PREFIX}/`)
          ? row.path.slice(RELAY_GATEWAY_PATH_PREFIX.length)
          : row.path;
        return { method: row.method, path: safeApiPath(path), status: row.status };
      }),
    ];
    const successful = (method, path) => operations.some(row => row.method === method && row.path === path && row.status === 200);
    return successful("GET", "/api/servers") &&
      successful("GET", "/api/servers/status") &&
      (!requireSessionRefresh || successful("POST", "/api/mobile/session/refresh"))
      ? audit : null;
  }, 30_000, requireSessionRefresh
    ? "diagnostics-triggered server-list/status HTTP and expired-session refresh"
    : "diagnostics-triggered server-list/status HTTP", 100, context.abortSignal);
}

async function returnToActiveTask(page) {
  await clickVisibleTestId(page, "settings-detail-back");
  await page.getByTestId("settings-home").waitFor({ state: "visible", timeout: 10_000 });
  await clickVisibleTestId(page, "settings-detail-back");
  await page.getByTestId("sessions").waitFor({ state: "visible", timeout: 10_000 });
  await clickVisibleTestId(page, "sessions");
  await page.getByTestId("sessions-list").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("session-mock-active-session").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("session-mock-active-session").click();
  await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("message-user").filter({ hasText: "历史附件" }).waitFor({ state: "visible", timeout: 15_000 });
}

async function clickVisibleButtonByNames(page, names) {
  for (const name of names) {
    const buttons = page.getByRole("button", { name, exact: true });
    for (let index = 0; index < await buttons.count(); index += 1) {
      const button = buttons.nth(index);
      if (await button.isVisible()) {
        await button.click();
        return;
      }
    }
    const labeledControls = page.getByLabel(name, { exact: true });
    for (let index = 0; index < await labeledControls.count(); index += 1) {
      const control = labeledControls.nth(index);
      if (await control.isVisible()) {
        await control.click();
        return;
      }
    }
  }
  throw new Error(`No visible Mobile button matched: ${names.join("/")}`);
}

async function clickVisibleTestId(page, testId) {
  const elements = page.getByTestId(testId);
  for (let index = 0; index < await elements.count(); index += 1) {
    const element = elements.nth(index);
    if (await element.isVisible()) {
      await element.click();
      return;
    }
  }
  throw new Error(`No visible Mobile control matched testID ${testId}`);
}

async function installAndObserve(page) {
  browserSocketAudits.set(page, []);
  await page.addInitScript({ content: makeBrowserAuditInitScript() });
  page.on("websocket", socket => observeBrowserWebSocket(socket, browserSocketAudits.get(page)));
}

function makeBrowserAuditInitScript() {
  return [
    "(() => {",
    `const safeApiPath = ${safeApiPath.toString()};`,
    `const normalizeDataMessage = ${normalizeDataMessage.toString()};`,
    `const decodePeerChunkBytes = ${decodePeerChunkBytes.toString()};`,
    `const concatenatePeerChunks = ${concatenatePeerChunks.toString()};`,
    `const captureSessionSecrets = ${captureSessionSecrets.toString()};`,
    `const summarizeSessionBootstrap = ${summarizeSessionBootstrap.toString()};`,
    `const observePeerFrame = ${observePeerFrame.toString()};`,
    `const observePeerConnection = ${observePeerConnection.toString()};`,
    `(${observeMobilePeerTraffic.toString()})();`,
    "})();",
  ].join("\n");
}

function observeMobilePeerTraffic() {
  const initialToken = new URLSearchParams(location.hash.slice(1)).get("token");
  const audit = {
    initial: {
      secureContext: window.isSecureContext,
      webCrypto: Boolean(window.crypto?.subtle),
      rtc: typeof globalThis.RTCPeerConnection === "function",
    },
    fetches: [],
    rtc: { connections: [], channels: [] },
    secrets: initialToken ? [initialToken] : [],
  };
  Object.defineProperty(window, "__mobilePeerRouteAudit", { value: audit, configurable: false });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    let url;
    try { url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, location.href); }
    catch { return nativeFetch(input, init); }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const record = {
      method,
      path: url.pathname,
      route: url.pathname.startsWith("/g/") ? "public" : "lan",
      queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
      headerA: headers.has("authorization"),
      headerB: headers.has("cookie"),
      status: null,
      failed: false,
      offerShapeValid: null,
      authKind: null,
      containsPairingToken: false,
      containsSessionToken: false,
      configCredentialLeak: false,
    };
    const rawBody = typeof init?.body === "string" ? init.body : "";
    if (url.pathname.endsWith("/api/mobile/p2p/offer")) {
      try {
        const payload = JSON.parse(rawBody);
        const auth = payload?.auth;
        record.offerShapeValid = payload?.version === 1 && typeof payload?.nonce === "string" &&
          typeof payload?.offer === "string" && auth && typeof auth === "object" &&
          Object.keys(payload).sort().join(",") === "auth,nonce,offer,version" &&
          Object.keys(auth).sort().join(",") === "keyId,kind,proof" &&
          /^[a-f0-9]{64}$/.test(auth.keyId) && /^[a-f0-9]{64}$/.test(auth.proof);
        record.authKind = auth?.kind === "pairing" || auth?.kind === "access" ? auth.kind : "invalid";
      } catch { record.offerShapeValid = false; }
      record.containsPairingToken = audit.secrets.some(secret => rawBody.includes(secret));
      record.containsSessionToken = audit.sessionSecrets?.some(secret => rawBody.includes(secret)) ?? false;
    }
    audit.fetches.push(record);
    return nativeFetch(input, init).then(async response => {
      record.status = response.status;
      if (url.pathname.endsWith("/api/mobile/p2p")) {
        try {
          const text = await response.clone().text();
          record.configCredentialLeak = audit.secrets.some(secret => text.includes(secret)) ||
            (audit.sessionSecrets || []).some(secret => text.includes(secret));
          const config = JSON.parse(text);
          record.configVersion = Number.isInteger(config.version) ? config.version : null;
          record.configStunCount = Array.isArray(config.stunUrls) ? config.stunUrls.length : null;
        } catch { record.configVersion = null; }
      }
      return response;
    }, error => {
      record.failed = true;
      record.failureKind = error?.name === "AbortError" ? "aborted" : "fetch-error";
      throw error;
    });
  };

  const NativePeerConnection = globalThis.RTCPeerConnection;
  if (typeof NativePeerConnection === "function") {
    globalThis.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args, newTarget) {
        const connection = Reflect.construct(target, args, newTarget);
        observePeerConnection(connection, args[0], audit);
        return connection;
      },
    });
  }
}

function observePeerConnection(connection, configuration, audit) {
  const record = {
    connectionState: connection.connectionState,
    iceConnectionState: connection.iceConnectionState,
    configuration: {
      iceTransportPolicy: configuration?.iceTransportPolicy ?? "browser-default",
      iceServerCount: Array.isArray(configuration?.iceServers) ? configuration.iceServers.length : 0,
    },
    selectedPairs: [],
    channels: [],
  };
  audit.rtc.connections.push(record);
  const observeChannel = channel => {
    if (record.channels.some(item => item.label === channel.label)) return;
    const channelRecord = {
      label: String(channel.label).slice(0, 64),
      state: channel.readyState,
      opened: channel.readyState === "open",
      sentBytes: 0,
      receivedBytes: 0,
      bufferedAmount: channel.bufferedAmount ?? 0,
      bufferedAmountHighWaterMark: channel.bufferedAmount ?? 0,
      sentFrames: 0,
      receivedFrames: 0,
      sentFrameTypes: [],
      receivedFrameTypes: [],
      httpOperations: [],
      responseStarts: [],
      rpcMethods: [],
      rpcResults: [],
    };
    record.channels.push(channelRecord);
    audit.rtc.channels.push(channelRecord);
    const frameState = {
      pendingRpc: new Map(),
      pendingWebSocketMessages: new Map(),
      pendingHttpMessages: new Map(),
      audit,
    };
    channel.addEventListener("open", () => { channelRecord.state = "open"; channelRecord.opened = true; });
    channel.addEventListener("close", () => { channelRecord.state = "closed"; });
    channel.addEventListener("message", event => {
      const raw = normalizeDataMessage(event.data);
      channelRecord.receivedBytes += raw.byteLength;
      channelRecord.bufferedAmount = channel.bufferedAmount ?? 0;
      observePeerFrame(raw.text, "received", channelRecord, frameState);
    });
    try {
      const send = channel.send.bind(channel);
      channel.send = data => {
        const raw = normalizeDataMessage(data);
        channelRecord.sentBytes += raw.byteLength;
        observePeerFrame(raw.text, "sent", channelRecord, frameState);
        const outcome = send(data);
        channelRecord.bufferedAmount = channel.bufferedAmount ?? 0;
        channelRecord.bufferedAmountHighWaterMark = Math.max(
          channelRecord.bufferedAmountHighWaterMark,
          channelRecord.bufferedAmount,
        );
        return outcome;
      };
    } catch { channelRecord.sendObserverUnavailable = true; }
  };
  const createDataChannel = connection.createDataChannel.bind(connection);
  connection.createDataChannel = (...args) => {
    const channel = createDataChannel(...args);
    observeChannel(channel);
    return channel;
  };
  connection.addEventListener("datachannel", event => observeChannel(event.channel));
  const sampleStats = async () => {
    record.connectionState = connection.connectionState;
    record.iceConnectionState = connection.iceConnectionState;
    try {
      const stats = await connection.getStats();
      const reports = [...stats.values()];
      const selectedIds = new Set(reports.filter(row => row.type === "transport" && row.selectedCandidatePairId)
        .map(row => row.selectedCandidatePairId));
      const pairs = reports.filter(row => row.type === "candidate-pair" &&
        (row.selected === true || selectedIds.has(row.id) || (row.state === "succeeded" && row.nominated === true)));
      for (const pair of pairs) {
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        const snapshot = {
          localCandidateType: typeof local?.candidateType === "string" ? local.candidateType : null,
          remoteCandidateType: typeof remote?.candidateType === "string" ? remote.candidateType : null,
          bytesSent: Number.isFinite(pair.bytesSent) ? pair.bytesSent : 0,
          bytesReceived: Number.isFinite(pair.bytesReceived) ? pair.bytesReceived : 0,
          state: typeof pair.state === "string" ? pair.state : null,
        };
        const last = record.selectedPairs.at(-1);
        if (!last || JSON.stringify(last) !== JSON.stringify(snapshot)) record.selectedPairs.push(snapshot);
      }
    } catch { record.statsUnavailable = true; }
  };
  let sampling = false;
  const sample = () => {
    if (sampling) return;
    sampling = true;
    void sampleStats().finally(() => { sampling = false; });
  };
  connection.addEventListener("connectionstatechange", sample);
  sample();
  const timer = setInterval(sample, 500);
  const close = connection.close.bind(connection);
  connection.close = (...args) => {
    clearInterval(timer);
    sample();
    return close(...args);
  };
}

function normalizeDataMessage(data) {
  if (typeof data === "string") return { text: data, byteLength: new TextEncoder().encode(data).byteLength };
  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    return { text: new TextDecoder().decode(bytes), byteLength: bytes.byteLength };
  }
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return { text: new TextDecoder().decode(bytes), byteLength: bytes.byteLength };
  }
  return { text: "", byteLength: 0 };
}

function observePeerFrame(raw, direction, audit, state) {
  let frame;
  try { frame = JSON.parse(raw); } catch { return; }
  if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return;
  const typeKey = direction === "sent" ? "sentFrameTypes" : "receivedFrameTypes";
  const countKey = direction === "sent" ? "sentFrames" : "receivedFrames";
  if (!frame.type.startsWith("http.") && !frame.type.startsWith("ws.")) return;
  audit[countKey] += 1;
  if (audit[typeKey].length < 80) audit[typeKey].push(frame.type);
  if (frame.type === "http.request.start" && direction === "sent") {
    audit.httpOperations.push({
      id: frame.id,
      method: typeof frame.method === "string" ? frame.method : null,
      path: safeApiPath(frame.path),
      status: null,
      bodyLength: Number.isSafeInteger(frame.bodyLength) ? frame.bodyLength : null,
      durableDeviceAuthorization: null,
      hasAuthorization: Boolean(frame.headers?.authorization),
      hasBody: Number.isFinite(frame.bodyLength) && frame.bodyLength > 0,
    });
    if (frame.bodyLength > 0) state.pendingHttpMessages.set(`${direction}:${frame.id}`, {
      chunks: new Map(), kind: "request", operation: audit.httpOperations.at(-1),
    });
  } else if (frame.type === "http.response.start" && direction === "received") {
    const operation = audit.httpOperations.find(row => row.id === frame.id);
    if (operation) operation.status = Number.isInteger(frame.status) ? frame.status : null;
    if (audit.responseStarts.length < 80) audit.responseStarts.push({
      method: operation?.method ?? null,
      path: operation?.path ?? "/unknown",
      status: Number.isInteger(frame.status) ? frame.status : null,
      bodyLength: Number.isSafeInteger(frame.bodyLength) ? frame.bodyLength : null,
    });
    if (frame.bodyLength > 0) state.pendingHttpMessages.set(`${direction}:${frame.id}`, {
      chunks: new Map(), kind: "response", operation,
    });
  } else if ((frame.type === "http.request.chunk" || frame.type === "http.response.chunk") &&
      state.pendingHttpMessages.has(`${direction}:${frame.id}`)) {
    state.pendingHttpMessages.get(`${direction}:${frame.id}`).chunks.set(frame.seq, decodePeerChunkBytes(frame.data));
  } else if ((frame.type === "http.request.end" || frame.type === "http.response.end") &&
      state.pendingHttpMessages.has(`${direction}:${frame.id}`)) {
    const pending = state.pendingHttpMessages.get(`${direction}:${frame.id}`);
    state.pendingHttpMessages.delete(`${direction}:${frame.id}`);
    if (pending.kind === "response") captureSessionSecrets(state.audit, concatenatePeerChunks(pending.chunks), pending.operation);
    else if (pending.operation?.method === "POST" && pending.operation?.path === "/api/mobile/session") {
      try {
        const payload = JSON.parse(concatenatePeerChunks(pending.chunks));
        pending.operation.durableDeviceAuthorization = payload?.durableDeviceAuthorization === true;
      } catch { pending.operation.durableDeviceAuthorization = false; }
    }
  } else if (frame.type === "ws.message.start") {
    state.pendingWebSocketMessages.set(`${direction}:${frame.id}:${frame.messageId}`, {
      binary: frame.binary,
      chunks: new Map(),
    });
  } else if (frame.type === "ws.message.chunk") {
    const pending = state.pendingWebSocketMessages.get(`${direction}:${frame.id}:${frame.messageId}`);
    if (pending) pending.chunks.set(frame.seq, decodePeerChunkBytes(frame.data));
  } else if (frame.type === "ws.message.end") {
    const key = `${direction}:${frame.id}:${frame.messageId}`;
    const pending = state.pendingWebSocketMessages.get(key);
    if (!pending) return;
    state.pendingWebSocketMessages.delete(key);
    if (pending.binary) return;
    const decoded = concatenatePeerChunks(pending.chunks);
    try {
      const messages = JSON.parse(decoded);
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (direction === "sent" && typeof message?.method === "string") {
          audit.rpcMethods.push(message.method);
          if (message.id !== undefined) state.pendingRpc.set(String(message.id), message.method);
        } else if (direction === "received" && message?.id !== undefined &&
            (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
          const method = state.pendingRpc.get(String(message.id));
          if (method) {
            audit.rpcResults.push({ method, terminal: Object.hasOwn(message, "result") ? "result" : "error" });
            state.pendingRpc.delete(String(message.id));
          }
        }
      }
    } catch { /* only decoded RPC method names and terminal states are retained */ }
  }
}

function decodePeerChunkBytes(value) {
  if (typeof value !== "string" || value.length > 16_384) return new Uint8Array();
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch { return new Uint8Array(); }
}

function concatenatePeerChunks(chunks) {
  const ordered = [...chunks.entries()].sort(([left], [right]) => left - right).map(([, chunk]) => chunk);
  const length = ordered.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of ordered) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function captureSessionSecrets(audit, text, operation) {
  let payload;
  try { payload = JSON.parse(text); } catch { return; }
  for (const key of ["accessToken", "rpcToken", "refreshToken"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.length >= 8) (audit.sessionSecrets ??= []).push(value);
  }
  if (operation?.method === "POST" && operation.path === "/api/mobile/session") {
    audit.sessionBootstrap = summarizeSessionBootstrap(payload, operation.status);
  }
}

function summarizeSessionBootstrap(payload, status) {
  const servers = Array.isArray(payload?.initialServers?.servers) ? payload.initialServers.servers : [];
  return {
    httpStatus: Number.isInteger(status) ? status : null,
    mobileInitialServersV1: payload?.capabilities?.mobileInitialServersV1 === true,
    initialServersVersion: Number.isInteger(payload?.initialServers?.version) ? payload.initialServers.version : null,
    serverCount: servers.length,
    serverIds: servers.map(server => typeof server?.id === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(server.id)
      ? server.id : null).filter(Boolean),
  };
}

function observeBrowserWebSocket(socket, rows) {
    if (!rows) return;
    const row = { route: "unknown", path: "/", sentMethods: [], receivedMethods: [], terminalResults: [] };
    try {
      const url = new URL(socket.url());
      row.route = url.pathname.startsWith("/g/") ? "public" : "lan";
      row.path = url.pathname;
      row.queryKeys = [...new Set([...url.searchParams.keys()])].sort();
    } catch { return; }
    rows.push(row);
    const pending = new Map();
    const inspect = (payload, sent) => {
      let messages;
      try { messages = JSON.parse(typeof payload === "string" ? payload : payload.toString()); }
      catch { return; }
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (sent && typeof message?.method === "string") {
          row.sentMethods.push(message.method);
          if (message.id !== undefined) pending.set(String(message.id), message.method);
        } else if (!sent && message?.id !== undefined &&
            (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
          const method = pending.get(String(message.id));
          if (method) row.terminalResults.push({ method, terminal: Object.hasOwn(message, "result") ? "result" : "error" });
        }
      }
    };
    socket.on("framesent", event => inspect(event.payload, true));
    socket.on("framereceived", event => inspect(event.payload, false));
}

async function readAudit(page) {
  const audit = await page.evaluate(() => {
    const audit = window.__mobilePeerRouteAudit;
    if (!audit) return null;
    const { secrets: _secrets, sessionSecrets: _sessionSecrets, ...safe } = audit;
    return JSON.parse(JSON.stringify(safe));
  });
  if (audit) audit.webSockets = structuredClone(browserSocketAudits.get(page) || []);
  return audit;
}

async function registerSessionSecrets(page, value) {
  const secrets = ["accessToken", "rpcToken", "refreshToken"]
    .map(key => value?.[key])
    .filter(token => typeof token === "string" && token.length >= 8);
  if (!secrets.length) return;
  await page.evaluate(values => {
    const audit = window.__mobilePeerRouteAudit;
    if (!audit) return;
    audit.sessionSecrets ??= [];
    audit.sessionSecrets.push(...values);
  }, secrets);
}

function makeFragmentPairingLink(mobileOrigin, pairing, routes) {
  const link = new URL(`${mobileOrigin}/mobile/connect`);
  link.searchParams.set("gateway", pairing.publicBaseUrl);
  link.searchParams.set("routes", JSON.stringify(routes));
  link.hash = new URLSearchParams({ token: pairing.token }).toString();
  return link.toString();
}

async function readStoredProfile(page, pairingToken, canonicalPublicUrl) {
  return page.evaluate(({ pairingToken, canonicalPublicUrl }) => {
    const raw = localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2");
    const index = raw ? JSON.parse(raw) : { profiles: [], activeId: null };
    const profiles = Array.isArray(index.profiles) ? index.profiles : [];
    const active = profiles.find(profile => profile.id === index.activeId) ?? profiles[0] ?? null;
    let pairingCredentialStored = false;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const value = key ? localStorage.getItem(key) : null;
      if (value?.includes(pairingToken)) pairingCredentialStored = true;
    }
    return {
      count: profiles.length,
      id: active?.id ?? null,
      baseUrl: active?.baseUrl ?? null,
      deviceId: active?.deviceId ?? null,
      pairingCredentialStored,
      canonicalPublicUrlMatches: active?.baseUrl === canonicalPublicUrl,
    };
  }, { pairingToken, canonicalPublicUrl });
}

function assertProfile(profile, fixture, audit, expectedCount) {
  assert.equal(profile.count, 1, "browser must persist one current Gateway profile");
  assert.equal(profile.baseUrl, fixture.pairing.publicBaseUrl, "profile must retain the canonical public Gateway URL");
  assert.equal(profile.pairingCredentialStored, false, "pairing token must not be persisted in browser local storage");
  assert.ok(profile.deviceId, "paired profile must retain a Gateway device identity");
  assert.equal(audit.initial.secureContext, true, "Mobile must run in Chromium's native secure context");
  assert.equal(audit.initial.webCrypto, true, "Mobile route signatures must use browser WebCrypto");
  assert.equal(audit.initial.rtc, true, "Mobile page must expose the browser's actual RTCPeerConnection");
  assert.ok(audit.fetches.some(row => row.path.endsWith("/api/mobile/connection-proof")), "page must fetch signed Gateway route proofs");
  assert.ok(expectedCount > 0);
}

function summarizeProfile(profile) {
  return {
    count: profile.count,
    id: profile.id,
    baseUrl: profile.baseUrl,
    deviceId: profile.deviceId,
    pairingCredentialStored: profile.pairingCredentialStored,
  };
}

function assertRpcMethods(audit, methods) {
  const observed = new Set([
    ...(audit.rpc || []),
    ...(audit.rtc?.channels || []).flatMap(channel => channel.rpcMethods),
    ...(audit.webSockets || []).flatMap(socket => socket.sentMethods),
  ]);
  for (const method of methods) assert.ok(observed.has(method), `actual Mobile RPC request ${method} must be observed`);
  const terminals = [
    ...(audit.rtc?.channels || []).flatMap(channel => channel.rpcResults),
    ...(audit.webSockets || []).flatMap(socket => socket.terminalResults),
  ];
  for (const method of methods) {
    assert.ok(terminals.some(result => result.method === method && result.terminal === "result"),
      `real Gateway RPC must return a successful ${method} terminal result`);
  }
}

function summarizeBrowserAudit(audit) {
  return {
    initial: audit.initial,
    fetches: audit.fetches.map(row => ({
      method: row.method,
      path: row.path,
      route: row.route,
      queryKeys: row.queryKeys,
      headerA: row.headerA,
      headerB: row.headerB,
      status: row.status,
      failed: row.failed,
      offerShapeValid: row.offerShapeValid,
      authKind: row.authKind,
      containsPairingToken: row.containsPairingToken,
      containsSessionToken: row.containsSessionToken,
      configCredentialLeak: row.configCredentialLeak,
      configVersion: row.configVersion,
      configStunCount: row.configStunCount,
    })),
    rtc: {
      connections: audit.rtc.connections.map(connection => ({
        connectionState: connection.connectionState,
        iceConnectionState: connection.iceConnectionState,
        configuration: connection.configuration,
        selectedPairs: connection.selectedPairs,
      })),
      channels: audit.rtc.channels.map(channel => ({
        label: channel.label,
        state: channel.state,
        opened: channel.opened,
        sentBytes: channel.sentBytes,
        receivedBytes: channel.receivedBytes,
        bufferedAmount: channel.bufferedAmount,
        bufferedAmountHighWaterMark: channel.bufferedAmountHighWaterMark,
        sentFrames: channel.sentFrames,
        receivedFrames: channel.receivedFrames,
        sentFrameTypes: channel.sentFrameTypes,
        receivedFrameTypes: channel.receivedFrameTypes,
        httpOperations: channel.httpOperations.map(({ id: _id, ...row }) => row),
        responseStarts: channel.responseStarts,
        rpcMethods: channel.rpcMethods,
        rpcResults: channel.rpcResults,
      })),
    },
    webSockets: audit.webSockets || [],
  };
}

function summarizeSensitiveOffer(offer) {
  return {
    method: offer.method,
    path: offer.path,
    route: offer.route,
    status: offer.status,
    failed: offer.failed,
    offerShapeValid: offer.offerShapeValid,
    authKind: offer.authKind,
    containsPairingToken: offer.containsPairingToken,
    containsSessionToken: offer.containsSessionToken,
    configCredentialLeak: offer.configCredentialLeak,
  };
}

function isP2PSignalRow(row) {
  const path = fixtureGatewayPath(row);
  return path === "/api/mobile/p2p" || path.startsWith("/api/mobile/p2p/");
}

function fixtureGatewayPath(row) {
  const path = typeof row?.path === "string" ? row.path : "";
  if (path === RELAY_GATEWAY_PATH_PREFIX) return "/";
  if (path.startsWith(`${RELAY_GATEWAY_PATH_PREFIX}/`)) return path.slice(RELAY_GATEWAY_PATH_PREFIX.length);
  return path;
}

function safeApiPath(value) {
  if (typeof value !== "string") return "/unknown";
  try {
    const url = new URL(value, "http://owned.invalid");
    if (url.pathname.startsWith("/api/")) return url.pathname;
    if (url.pathname === "/rpc") return "/rpc";
  } catch { /* Return a fixed value rather than retain an untrusted path. */ }
  return "/other";
}

function readDataChannelTotals(channels) {
  return channels.reduce((total, channel) => ({
    sentBytes: total.sentBytes + channel.sentBytes,
    receivedBytes: total.receivedBytes + channel.receivedBytes,
    sentFrames: total.sentFrames + channel.sentFrames,
    receivedFrames: total.receivedFrames + channel.receivedFrames,
  }), { sentBytes: 0, receivedBytes: 0, sentFrames: 0, receivedFrames: 0 });
}

function findOpenPeerChannel(rtc) {
  const open = rtc.channels.find(channel => channel.state === "open" && channel.label === "kcoder-gateway-v1");
  if (!open) return null;
  const connection = rtc.connections.find(row => row.channels.some(channel => channel.state === "open" && channel.label === open.label));
  return connection ? {
    channel: open,
    selectedPair: connection.selectedPairs.at(-1),
    waitUntil: Date.now() + Math.max(ROUTE_CACHE_WAIT_MS, ACCESS_TTL_MS + 1_000),
  } : null;
}

function collectRecentRpcMethods(currentChannels, previousChannels) {
  const methods = [];
  for (let index = 0; index < currentChannels.length; index += 1) {
    const current = currentChannels[index];
    const before = previousChannels[index];
    const previousLength = before?.rpcMethods.length ?? 0;
    methods.push(...current.rpcMethods.slice(previousLength));
  }
  return methods;
}

function collectRecentHttpOperations(currentChannels, previousChannels) {
  const operations = [];
  for (let index = 0; index < currentChannels.length; index += 1) {
    const current = currentChannels[index];
    const previousLength = previousChannels[index]?.httpOperations.length ?? 0;
    operations.push(...current.httpOperations.slice(previousLength).map(({ id: _id, ...row }) => row));
  }
  return operations;
}

function collectRecentRpcResults(currentChannels, previousChannels) {
  const results = [];
  for (let index = 0; index < currentChannels.length; index += 1) {
    const previousLength = previousChannels[index]?.rpcResults.length ?? 0;
    results.push(...currentChannels[index].rpcResults.slice(previousLength));
  }
  return results;
}

function assertRpcMethodsFromList(methods, expected) {
  const observed = new Set(methods);
  for (const method of expected) assert.ok(observed.has(method), `peer DataChannel must carry RPC method ${method}`);
}

function summarizeFixtureRecords(records) {
  return records.map(row => ({
    method: row.method,
    path: row.path,
    queryKeys: row.queryKeys,
    route: row.route,
    upgrade: row.upgrade,
    responseStatus: row.responseStatus,
    transportFailure: row.transportFailure,
    injectedFailure: row.injectedFailure,
    headerA: row.hasAuthorization,
    headerB: row.hasCookie,
    hasOrigin: row.hasOrigin,
  }));
}

function safeFailure(context, value) {
  return context.redactText(String(value))
    .replace(/https?:\/\/[^\s"'<>]+/g, raw => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
      catch { return "[url]"; }
    })
    .slice(0, 600);
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolveClosed => server.close(() => resolveClosed()));
}
