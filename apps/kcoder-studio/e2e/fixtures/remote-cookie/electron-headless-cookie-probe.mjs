import assert from "node:assert/strict";
import { app, session, net } from "electron";
import { readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { createServer as httpServer, globalAgent as httpGlobalAgent } from "node:http";
import { createServer as httpsServer, globalAgent } from "node:https";
import { join } from "node:path";
import { loginRemoteGatewaySession } from "./remote-config.mjs";
import { remoteSessionCookieDetails } from "./remote-cookie-contract.mjs";

const config = JSON.parse(readFileSync(process.env.KCODER_COOKIE_CONFIGURATION, "utf8"));
const certificate = readFileSync(config.certificate, "utf8").trim();
const token = `owned-login-${config.owner}`;
const hostname = "owned-cookie.invalid";
app.setName("KCoder owned Cookie acceptance");
app.setPath("userData", config.profile);
app.setPath("sessionData", join(config.profile, "session"));
app.setPath("crashDumps", join(config.profile, "crash"));
globalAgent.options.ca = certificate;
globalAgent.options.lookup = (host, options, callback) => {
  if (host !== hostname) return callback(new Error("Non-owned DNS denied"));
  if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};
httpGlobalAgent.options.lookup = globalAgent.options.lookup;
const report = { version: 1, owner: config.owner, electron: process.versions.electron, chromium: process.versions.chrome,
  platform: process.platform, sessionId: config.sessionId, browserWindowsCreated: 0, cases: [], failure: null, phase: "module-loaded" };
let finished = false;
const servers = [];
async function checkpoint() {
  const temporary = config.report + ".tmp";
  await writeFile(temporary, JSON.stringify(report, null, 2) + "\n");
  await rename(temporary, config.report);
}
async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (error) report.failure = String(error.message || error).slice(0, 500);
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await checkpoint();
  app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => { void finish(new Error("Session 0 Cookie fixture deadline")); }, 20_000);
app.on("browser-window-created", () => { report.browserWindowsCreated++; });
app.on("certificate-error", (event, _contents, url, _error, observed, callback) => {
  event.preventDefault();
  callback(new URL(url).hostname === hostname && observed.data.trim() === certificate);
});
const values = {
  "https-host": `host/${config.owner}`, "https-legacy": `legacy/${config.owner}`, "http-legacy": `http/${config.owner}`,
};
const handler = (secure) => (request, response) => {
  const url = new URL(request.url, "http://" + hostname);
  if (request.method === "POST" && url.pathname.endsWith("/login")) {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      if (new URLSearchParams(body).get("token") !== token) { response.writeHead(403).end(); return; }
      const kind = secure && url.pathname === "/g/host/login" ? "https-host" : secure ? "https-legacy" : "http-legacy";
      const name = kind === "https-host" ? "__Host-kcoder_studio_session" : "kcoder_studio_session";
      response.writeHead(303, { location: "/", "set-cookie": `${name}=${encodeURIComponent(values[kind])}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/` });
      response.end();
    });
    return;
  }
  const kind = url.searchParams.get("case");
  const name = kind === "https-host" ? "__Host-kcoder_studio_session" : "kcoder_studio_session";
  const cookies = (request.headers.cookie ?? "").split(/;\s*/).filter(Boolean);
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ expectedCookie: cookies.includes(`${name}=${values[kind]}`),
    sessionCookieCount: cookies.filter((value) => /^(?:__Host-)?kcoder_studio_session=/.test(value)).length }));
};
async function probe(ownedSession, url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session: ownedSession, credentials: "include", origin: new URL(url).origin, redirect: "error" });
    const timeout = setTimeout(() => { request.abort(); reject(new Error("Owned Cookie transport deadline")); }, 5_000);
    request.on("error", (error) => { clearTimeout(timeout); reject(error); });
    request.on("response", (response) => {
      let body = "";
      response.on("data", (part) => { body += part; });
      response.on("end", () => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.end();
  });
}
await checkpoint();
app.whenReady().then(async () => {
  assert.equal(config.sessionId, 0);
  report.phase = "electron-ready";
  await checkpoint();
  const tls = httpsServer({ key: readFileSync(config.key), cert: certificate }, handler(true));
  servers.push(tls);
  await new Promise((resolve) => tls.listen(0, "127.0.0.1", resolve));
  const http = httpServer(handler(false));
  servers.push(http);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const secureOrigin = `https://${hostname}:${tls.address().port}`;
  const httpOrigin = `http://${hostname}:${http.address().port}`;
  report.ports = [{ protocol: "https", address: "127.0.0.1", port: tls.address().port }, { protocol: "http", address: "127.0.0.1", port: http.address().port }];
  for (const kind of ["https-host", "https-legacy", "http-legacy"]) {
    report.phase = kind;
    await checkpoint();
    const secure = kind.startsWith("https:") || kind.startsWith("https-");
    const origin = secure ? secureOrigin : httpOrigin;
    const cookie = await loginRemoteGatewaySession({ origin, initialUrl: `${origin}/g/${kind === "https-host" ? "host" : "legacy"}/`, token, timeoutMs: 5_000 });
    const expectedName = kind === "https-host" ? "__Host-kcoder_studio_session" : "kcoder_studio_session";
    assert.equal(cookie.name, expectedName);
    assert.ok(cookie.value === values[kind], "decoded login Cookie value preserved");
    const ownedSession = session.fromPartition("owned-cookie-" + kind);
    await ownedSession.setProxy({ mode: "direct" });
    ownedSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === hostname && request.certificate.data.trim() === certificate ? 0 : -2));
    ownedSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const observed = new URL(details.url);
      callback({ cancel: ![secureOrigin, httpOrigin].includes(observed.origin) });
    });
    await ownedSession.cookies.set(remoteSessionCookieDetails(origin, cookie));
    const cookies = await ownedSession.cookies.get({ url: origin, name: expectedName });
    assert.equal(cookies.length, 1);
    const stored = cookies[0];
    assert.ok(stored.value === values[kind], "native Cookie value preserved");
    assert.equal(stored.secure, secure);
    assert.equal(stored.httpOnly, true);
    assert.equal(stored.sameSite, "strict");
    assert.equal(stored.path, "/");
    assert.equal(stored.hostOnly, true);
    const httpsResult = secure ? await probe(ownedSession, `${secureOrigin}/probe?case=${kind}`) : null;
    if (httpsResult) assert.equal(httpsResult.expectedCookie, true);
    const httpResult = await probe(ownedSession, `${httpOrigin}/probe?case=${kind}`);
    assert.equal(httpResult.expectedCookie, !secure);
    if (secure) assert.equal(httpResult.sessionCookieCount, 0);
    report.cases.push({ kind, name: stored.name, secure: stored.secure, httpOnly: stored.httpOnly, sameSite: stored.sameSite,
      path: stored.path, hostOnly: stored.hostOnly, httpsSendsExpected: httpsResult?.expectedCookie ?? null,
      httpSendsExpected: httpResult.expectedCookie, httpSessionCookieCount: httpResult.sessionCookieCount });
    await ownedSession.closeAllConnections();
  }
  assert.equal(report.browserWindowsCreated, 0);
  report.phase = "completed";
  await finish();
}).catch(finish);
