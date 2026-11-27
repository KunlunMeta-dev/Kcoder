import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startChromium } from "../harness/chromium.mjs";
import { runE2E } from "../harness/run-context.mjs";

const CHROMIUM_PATH = "/opt/cft/chrome-linux64/chrome";
const html = Buffer.from(`<!doctype html>
<html><head><meta charset="utf-8"><title>Owned browser navigation probe</title></head>
<body><main id="probe">Owned loopback page</main>
<button type="button">Run probe</button><output id="probe-result"></output>
<script>document.querySelector("button").addEventListener("click", () => {
  document.querySelector("#probe-result").textContent = "clicked";
});</script></body></html>`);

function timestamp() {
  return new Date().toISOString();
}

function safeError(error) {
  const codes = new Set([
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
    "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  ]);
  return {
    name: typeof error?.name === "string" ? error.name : "unknown",
    code: codes.has(error?.code) ? error.code : null,
  };
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

await runE2E(import.meta.url, {
  testId: "browser-basic-navigation",
  modelPolicy: "model-independent owned Chromium loopback HTTP navigation and click probe",
  processSignalTimeoutMs: 5_000,
  cleanupTimeoutMs: 7_500,
  survivorCheckTimeoutMs: 5_000,
  retainSuccessLogs: true,
}, async context => {
  const evidence = {
    sourceSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
    nodeVersion: process.version,
    chromiumConfiguredPath: CHROMIUM_PATH,
    startedAt: timestamp(),
    server: { bindAddress: "127.0.0.1", requests: [] },
    browser: null,
    navigation: { urlHost: "localhost", path: "/", startedAt: null, firstRequestAt: null, responseFinishedAt: null, loadedAt: null },
    requestFailures: [],
    button: null,
    failure: null,
  };
  let phase = "server-listen";
  let browser = null;
  const server = createServer((request, response) => {
    const receivedAt = timestamp();
    const method = request.method || "UNKNOWN";
    let path = "<invalid>";
    try {
      path = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      // Preserve only the path category; request text is intentionally not recorded.
    }
    const row = {
      method,
      path,
      receivedAt,
      remoteAddress: request.socket.remoteAddress || null,
      status: null,
      responseFinishedAt: null,
    };
    evidence.server.requests.push(row);

    let status = 404;
    let body = Buffer.from("Not found");
    let contentType = "text/plain; charset=utf-8";
    if (path === "/" && (method === "GET" || method === "HEAD")) {
      status = 200;
      body = html;
      contentType = "text/html; charset=utf-8";
      if (method === "GET" && evidence.navigation.firstRequestAt === null) {
        evidence.navigation.firstRequestAt = receivedAt;
      }
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
    response.once("finish", () => {
      row.status = response.statusCode;
      row.responseFinishedAt = timestamp();
      if (path === "/" && method === "GET" && evidence.navigation.responseFinishedAt === null) {
        evidence.navigation.responseFinishedAt = row.responseFinishedAt;
      }
    });
    response.end(method === "HEAD" || status === 204 ? undefined : body);
  });
  server.on("error", error => {
    evidence.server.error = safeError(error);
  });

  context.addCleanup("close owned browser-basic-navigation HTTP fixture", () => closeServer(server));
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
    context.registerPort("browser-basic-navigation-http", port);
    evidence.server.port = port;

    phase = "chromium-startup";
    browser = await startChromium(context, {
      label: "browser-basic-navigation-chromium",
      executablePath: CHROMIUM_PATH,
      startTimeoutMs: 10_000,
      pageTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
    });
    const ownedProcess = context.processes.get("browser-basic-navigation-chromium");
    assert.ok(ownedProcess, "Chromium must be registered to this RunContext");
    assert.equal(ownedProcess.child, browser.child, "the recorded Chrome PID must belong to this RunContext");
    evidence.browser = {
      pid: ownedProcess.pid,
      pgid: ownedProcess.pgid,
      executablePath: browser.executablePath,
      version: browser.browser.version(),
      cdpPort: browser.cdpPort,
      profileDir: browser.profileDir,
      noSandbox: browser.noSandbox,
      headless: browser.headless,
    };

    phase = "new-page";
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    page.on("requestfailed", request => {
      let path = "<invalid>";
      try {
        path = new URL(request.url()).pathname;
      } catch {
        // Do not retain an unparsed URL, which could contain query data.
      }
      evidence.requestFailures.push({
        method: request.method(),
        path,
        errorText: request.failure()?.errorText || "unknown",
      });
    });

    phase = "navigation";
    const url = `http://localhost:${port}/`;
    evidence.navigation.startedAt = timestamp();
    const navigationResponse = await page.goto(url, { waitUntil: "load", timeout: 5_000 });
    evidence.navigation.loadedAt = timestamp();
    evidence.navigation.status = navigationResponse?.status() ?? null;
    assert.equal(evidence.navigation.status, 200, "the owned localhost document must return HTTP 200");
    assert.equal(await page.title(), "Owned browser navigation probe");
    assert.equal(await page.locator("#probe").textContent(), "Owned loopback page");

    phase = "button-interaction";
    const button = page.getByRole("button", { name: "Run probe", exact: true });
    assert.equal(await button.count(), 1, "the static page must expose exactly one named probe button");
    await button.click({ timeout: 5_000 });
    assert.equal(await page.locator("#probe-result").textContent(), "clicked");
    evidence.button = { exactRoleAndNameCount: 1, clicked: true, verifiedAt: timestamp() };

    const navigationGets = evidence.server.requests.filter(request => request.path === "/" && request.method === "GET");
    assert.equal(navigationGets.length, 1, "the probe must produce one exact root navigation GET");
    assert.equal(navigationGets[0].status, 200, "the root navigation GET must finish with HTTP 200");
    assert.ok(evidence.navigation.firstRequestAt, "the fixture must record when the root GET arrived");
    assert.ok(evidence.navigation.responseFinishedAt, "the fixture must record when the root response finished");
    return { verified: true, rootNavigationGets: navigationGets.length, buttonClicked: true };
  } catch (error) {
    evidence.failure = { phase, ...safeError(error) };
    throw error;
  } finally {
    evidence.endedAt = timestamp();
    await context.writeArtifactJson("browser-basic-navigation.json", evidence);
  }
});
