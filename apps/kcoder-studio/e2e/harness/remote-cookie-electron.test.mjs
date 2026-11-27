import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { constants } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RunContext, waitFor } from "./run-context.mjs";
import { startOwnedDisplay } from "./ai-verify-gateway.mjs";

test("Linux actual Electron: remote entry and login contracts preserve secure HttpOnly session cookies", {
  skip: process.env.KCODER_E2E_REMOTE_COOKIE !== "1", timeout: 55_000,
}, async (t) => {
  assert.equal(process.platform, "linux", "owned Xvfb acceptance requires Linux");
  const binary = process.env.KCODER_E2E_ELECTRON_BIN;
  assert.ok(binary?.startsWith("/"), "explicit existing Electron binary required; package stubs are never imported");
  await access(binary, constants.X_OK);
  await access("/usr/bin/Xvfb", constants.X_OK);
  await access("/usr/bin/openssl", constants.X_OK);
  assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, "1", "explicit isolated root-host sandbox opt-in required");
  const context = await RunContext.create(import.meta.url, { tier: "platform", modelPolicy: "model-independent", retainSuccessLogs: true });
  let failure;
  let report;
  const requests = [];
  const binaryBefore = await stat(binary);
  try {
    const hostname = "owned-cookie.invalid";
    const token = randomBytes(20).toString("base64url");
    const hostValue = `host/${randomBytes(16).toString("hex")}`;
    const legacyValue = `legacy/${randomBytes(16).toString("hex")}`;
    const httpValue = `http/${randomBytes(16).toString("hex")}`;
    for (const value of [token, hostValue, legacyValue, httpValue]) context.registerSecret(value);
    const certificatePath = context.pathInState("certificate.pem");
    const keyPath = context.pathInState("certificate-key.pem");
    const cert = context.spawnOwned("remote-cookie-certificate", "/usr/bin/openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
      "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`,
      "-keyout", keyPath, "-out", certificatePath,
    ]);
    await waitFor(() => cert.exitCode !== null, 10_000, "owned fixture certificate", 25);
    assert.equal(cert.exitCode, 0);
    const handler = (secure) => (request, response) => {
      const url = new URL(request.url, `http://${hostname}`);
      if (request.method === "POST" && url.pathname.endsWith("/login")) {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const authorized = new URLSearchParams(body).get("token") === token;
          requests.push({ secure, path: url.pathname, authorized, type: "login" });
          if (!authorized) { response.writeHead(403).end(); return; }
          const host = secure && url.pathname === "/g/secure/login";
          const name = host ? "__Host-kcoder_studio_session" : "kcoder_studio_session";
          const value = host ? hostValue : secure ? legacyValue : httpValue;
          response.writeHead(303, { location: "/", "set-cookie": `${name}=${encodeURIComponent(value)}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/` });
          response.end();
        });
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      if (url.pathname === "/cookie-probe") {
        const kind = url.searchParams.get("case");
        const name = kind === "https-host" ? "__Host-kcoder_studio_session" : "kcoder_studio_session";
        const value = kind === "https-host" ? hostValue : kind === "https-legacy" ? legacyValue : httpValue;
        const cookies = (request.headers.cookie ?? "").split(/;\s*/).filter(Boolean);
        const observation = { expectedCookie: cookies.includes(`${name}=${value}`), sessionCookieCount: cookies.filter((cookie) => /^(?:__Host-)?kcoder_studio_session=/.test(cookie)).length };
        requests.push({ secure, path: url.pathname, kind, ...observation, type: "probe" });
        response.end(`<!doctype html><body><script>globalThis.cookieProbe=${JSON.stringify(observation)}</script></body>`);
      } else response.end("<!doctype html><title>Owned remote Cookie fixture</title><body>Cookie fixture</body>");
    };
    const tlsServer = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, handler(true));
    context.addCleanup("close owned TLS Cookie fixture", async () => { tlsServer.closeAllConnections(); await new Promise((resolveClose) => tlsServer.close(resolveClose)); });
    await new Promise((resolveListen) => tlsServer.listen(0, "127.0.0.1", resolveListen));
    context.registerPort("remote-cookie-tls", tlsServer.address().port);
    const httpServer = createHttpServer(handler(false));
    context.addCleanup("close owned HTTP Cookie fixture", async () => { httpServer.closeAllConnections(); await new Promise((resolveClose) => httpServer.close(resolveClose)); });
    await new Promise((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
    context.registerPort("remote-cookie-http", httpServer.address().port);
    const httpsOrigin = `https://${hostname}:${tlsServer.address().port}`;
    const httpOrigin = `http://${hostname}:${httpServer.address().port}`;
    const profile = context.pathInState("electron-profile");
    const reportPath = context.pathInArtifacts("electron-cookie-report.json");
    const configPath = await context.writeStateJson("electron-cookie-config.json", { hostname, token, hostValue, legacyValue, httpValue, httpsOrigin, httpOrigin, certificatePath, profile, reportPath });
    const display = await startOwnedDisplay(context);
    const directories = Object.fromEntries(["home", "tmp", "cache", "config", "data", "runtime"].map((name) => [name, context.pathInState(name)]));
    for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true, mode: 0o700 });
    const child = context.spawnOwned("remote-cookie-electron", binary, [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--ozone-platform=x11", "--disable-background-networking", "--disable-component-update",
      "--no-proxy-server", `--host-resolver-rules=MAP ${hostname} 127.0.0.1, MAP * ~NOTFOUND`,
      `--crash-dumps-dir=${context.pathInState("crash-dumps")}`,
      fileURLToPath(new URL("../fixtures/remote-cookie/electron-cookie-probe.mjs", import.meta.url)), `--owned-config=${configPath}`,
    ], { env: context.isolatedEnvironment({
      DISPLAY: display.display, XAUTHORITY: display.authority, WAYLAND_DISPLAY: "owned-disabled", HOME: directories.home, USERPROFILE: directories.home,
      TMPDIR: directories.tmp, TMP: directories.tmp, TEMP: directories.tmp, XDG_CACHE_HOME: directories.cache,
      XDG_CONFIG_HOME: directories.config, XDG_DATA_HOME: directories.data, XDG_RUNTIME_DIR: directories.runtime,
      NODE_EXTRA_CA_CERTS: certificatePath, KCODER_STUDIO_REMOTE_URL: `${httpsOrigin}/g/secure/fixture-entry`,
      KCODER_STUDIO_REMOTE_TOKEN: token, KCODER_STUDIO_DESKTOP_USER_DATA_DIR: profile,
      KCODER_STUDIO_DESKTOP_SMOKE_MS: "40000",
    }) });
    await waitFor(() => child.exitCode !== null, 35_000, "single owned Electron Cookie acceptance", 50);
    if (child.exitCode !== 0) {
      await context.writeArtifactJson("fixture-requests.json", requests);
      assert.equal(child.exitCode, 0, "actual Electron failure retained; do not retry this run");
    }
    report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.failure, null);
    assert.equal(report.cases.length, 3);
    assert.equal(report.cases[0].usedRemoteEntry, true);
    assert.ok(report.cases.every((entry) => entry.httpOnly && entry.sameSite === "strict" && entry.path === "/" && entry.hostOnly));
    assert.equal(requests.filter((entry) => entry.type === "login").length, 3);
    assert.equal(requests.filter((entry) => entry.type === "probe").length, 5);
    const binaryAfter = await stat(binary);
    for (const key of ["ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(binaryAfter[key], binaryBefore[key], `read-only Electron binary ${key} unchanged`);
    await context.writeArtifactJson("fixture-requests.json", requests);
    await context.writeArtifactJson("binary-identity.json", { path: binary, size: binaryBefore.size, inode: binaryBefore.ino, mtimeMs: binaryBefore.mtimeMs, sha256: createHash("sha256").update(await readFile(binary)).digest("hex"), version: report.electron });
  } catch (error) { failure = error; throw error; }
  finally {
    try { await context.finish(failure ? "failed" : "passed", report, failure); }
    finally { t.diagnostic(`RunContext: ${context.runRoot}`); }
  }
});
