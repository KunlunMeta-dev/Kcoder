import assert from "node:assert/strict";
import { startChromium } from "../harness/chromium.mjs";
import { runE2E } from "../harness/run-context.mjs";

// Run only after review: timeout --signal=INT --kill-after=30s 90s env \
//   KCODER_E2E_PUBLIC_CHROMIUM_GET_DIAGNOSTIC_ONCE=1 KCODER_E2E_CHROMIUM_NO_SANDBOX=1 \
//   /home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node \
//   apps/kcoder-studio/e2e/private/mobile-gateway-public-chromium-get-diagnostic.once.e2e.mjs
const RUN_FLAG = "KCODER_E2E_PUBLIC_CHROMIUM_GET_DIAGNOSTIC_ONCE";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const PUBLIC_ORIGIN = "https://hyf2333.top:8451";
const TARGETS = Object.freeze([
  { name: "origin-root", url: `${PUBLIC_ORIGIN}/`, pathname: "/" },
  { name: "relay-control", url: `${PUBLIC_ORIGIN}/_relay/control`, pathname: "/_relay/control" },
]);
const CHROMIUM_FAILURES = new Set([
  "net::ERR_ABORTED", "net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_CERT_COMMON_NAME_INVALID",
  "net::ERR_CONNECTION_CLOSED", "net::ERR_CONNECTION_REFUSED", "net::ERR_CONNECTION_RESET",
  "net::ERR_NAME_NOT_RESOLVED", "net::ERR_NETWORK_CHANGED", "net::ERR_NO_SUPPORTED_PROXIES",
  "net::ERR_PROXY_CONNECTION_FAILED", "net::ERR_TIMED_OUT", "net::ERR_TUNNEL_CONNECTION_FAILED",
]);
const NODE_FAILURES = new Set([
  "ABORT_ERR", "CERT_HAS_EXPIRED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "TimeoutError",
]);

assert.equal(process.env[RUN_FLAG], "1", `${RUN_FLAG}=1 is required for this private diagnostic`);
assert.equal(process.execPath, EXPECTED_NODE, "use the reviewed Node 22.17.0 executable");
assert.equal(process.version, "v22.17.0", "use the reviewed Node 22.17.0 runtime");
assert.equal(process.argv.length, 2, "the once runner accepts no extra arguments");

await runE2E(import.meta.url, {
  testId: "mobile-gateway-public-chromium-get-diagnostic-once",
  tier: "manual-live",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: "two credential-free public GETs from Node fetch and one owned Chromium context; no registration, pairing, Relay client, Gateway, or model activity",
}, async context => {
  const evidence = {
    state: "running",
    origin: { scheme: "https", host: new URL(PUBLIC_ORIGIN).host },
    targets: TARGETS.map(({ name }) => ({
      name,
      method: "GET",
      nodeFetch: { attempts: 0, status: null, failureClass: null },
      chromium: { attempts: 0, status: null, failureClass: null },
    })),
    chromium: { executable: "/usr/bin/chromium", isolatedProfile: true, explicitProxyConfiguration: false, customHeaders: false, outsideOriginRequestsBlocked: 0 },
    nodeFetch: { customHeaders: false, explicitProxyConfiguration: false },
    registrationPosts: 0,
    pairingPosts: 0,
    setupFailureClass: null,
  };
  context.addCleanup("write safe public Chromium GET diagnostic", () => context.writeArtifactJsonInternal("public-chromium-get-diagnostic.json", evidence));

  try {
    const browser = await startChromium(context, {
      label: "public-chromium-get-diagnostic",
      executablePath: "/usr/bin/chromium",
      noSandbox: true,
    });
    const browserContext = await browser.browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await browserContext.newPage();
    const targetByPath = new Map(TARGETS.map(target => [target.pathname, target]));

    await page.route("**/*", async route => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch { await route.abort(); return; }
      const target = targetByPath.get(url.pathname);
      if (request.method() === "GET" && url.origin === PUBLIC_ORIGIN && target && !url.search && !url.hash) {
        await route.continue();
        return;
      }
      evidence.chromium.outsideOriginRequestsBlocked += 1;
      await route.abort();
    });

    page.on("request", request => {
      try {
        const url = new URL(request.url());
        const target = targetByPath.get(url.pathname);
        if (url.origin !== PUBLIC_ORIGIN || !target || request.method() !== "GET" || url.search || url.hash) return;
        const record = evidence.targets.find(row => row.name === target.name);
        record.chromium.attempts += 1;
      } catch { /* The artifact stores no raw request URL. */ }
    });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        const target = targetByPath.get(url.pathname);
        if (url.origin === PUBLIC_ORIGIN && target && response.request().method() === "GET" && !url.search && !url.hash) {
          const record = evidence.targets.find(row => row.name === target.name);
          record.chromium.status = response.status();
        }
      } catch { /* The artifact stores no raw response URL or headers. */ }
    });
    page.on("requestfailed", request => {
      try {
        const url = new URL(request.url());
        const target = targetByPath.get(url.pathname);
        if (url.origin !== PUBLIC_ORIGIN || !target || request.method() !== "GET" || url.search || url.hash) return;
        const failure = request.failure()?.errorText;
        const record = evidence.targets.find(row => row.name === target.name);
        record.chromium.failureClass = CHROMIUM_FAILURES.has(failure) ? failure.slice("net::".length) : "other";
      } catch { /* The artifact stores only an allowlisted failure class. */ }
    });

    for (const target of TARGETS) {
      const record = evidence.targets.find(row => row.name === target.name);
      record.nodeFetch.attempts = 1;
      try {
        const response = await fetch(target.url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        record.nodeFetch.status = response.status;
        await response.body?.cancel?.().catch(() => {});
      } catch (error) {
        const code = error?.cause?.code ?? error?.code ?? error?.name;
        record.nodeFetch.failureClass = NODE_FAILURES.has(code) ? code : "other";
      }

      try {
        const response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 10_000 });
        if (response && record.chromium.status === null) record.chromium.status = response.status();
      } catch (error) {
        if (record.chromium.failureClass === null) {
          record.chromium.failureClass = error?.name === "TimeoutError" ? "TimeoutError" : "navigation-error";
        }
      }
    }

    assert.equal(evidence.targets.length, 2);
    evidence.state = "complete";
  } catch (error) {
    evidence.state = "setup-error";
    evidence.setupFailureClass = ["AssertionError", "TimeoutError", "TypeError", "RangeError"].includes(error?.name) ? error.name : "Error";
    throw new Error(`public Chromium GET diagnostic setup failed (${evidence.setupFailureClass})`);
  }
});
