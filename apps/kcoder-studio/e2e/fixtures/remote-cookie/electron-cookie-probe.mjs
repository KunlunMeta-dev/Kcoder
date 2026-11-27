import assert from "node:assert/strict";
import { app, BrowserWindow, session } from "electron";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { globalAgent } from "node:https";
import { isAbsolute, join } from "node:path";
import { loginRemoteGatewaySession } from "../../../desktop/remote-config.mjs";
import { remoteSessionCookieDetails } from "../../../desktop/remote-main.mjs";

const configPath = process.argv.find((value) => value.startsWith("--owned-config="))?.slice("--owned-config=".length);
if (!configPath || !isAbsolute(configPath)) throw new Error("Absolute owned config required");
const config = JSON.parse(readFileSync(configPath, "utf8"));
for (const path of [config.profile, config.reportPath, config.certificatePath]) assert.ok(isAbsolute(path));
app.setPath("sessionData", join(config.profile, "session-data"));
app.setPath("crashDumps", join(config.profile, "crash-dumps"));
const certificate = readFileSync(config.certificatePath, "utf8").trim();
globalAgent.options.ca = certificate;
globalAgent.options.lookup = (hostname, options, callback) => {
  if (hostname !== config.hostname) return callback(new Error("Fixture refuses non-owned DNS"));
  if (options?.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  else callback(null, "127.0.0.1", 4);
};
const origins = new Set([config.httpsOrigin, config.httpOrigin]);
app.on("certificate-error", (event, _contents, url, _error, observed, callback) => {
  const trusted = new URL(url).origin === config.httpsOrigin && observed.data.trim() === certificate;
  event.preventDefault();
  callback(trusted);
});
app.on("session-created", (ownedSession) => {
  ownedSession.setCertificateVerifyProc((request, callback) => callback(
    request.hostname === config.hostname && request.certificate.data.trim() === certificate ? 0 : -2,
  ));
  ownedSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: !origins.has(new URL(details.url).origin) });
  });
});

let finishing = false;
const windows = new Set();
const report = {
  electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform,
  noSandbox: app.commandLine.hasSwitch("no-sandbox"), cases: [], failure: null,
};
const watchdog = setTimeout(() => { void finish(new Error("Owned Electron Cookie probe deadline exceeded")); }, 25_000);
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  if (error) report.failure = String(error.message || error).slice(0, 500);
  await writeFile(config.reportPath, JSON.stringify(report, null, 2) + "\n");
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  app.exit(error ? 1 : 0);
}

async function navigateProbe(partition, url) {
  const window = new BrowserWindow({ show: false, webPreferences: {
    partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
  } });
  windows.add(window);
  await window.loadURL(url);
  const result = await window.webContents.executeJavaScript("globalThis.cookieProbe");
  const scriptCookies = await window.webContents.executeJavaScript("document.cookie");
  assert.equal(scriptCookies, "", "HttpOnly cookie must remain hidden from renderer JavaScript");
  windows.delete(window);
  window.destroy();
  return result;
}

async function checkCase({ kind, partition, origin, name, expectedValue, primaryWindow }) {
  const ownedSession = session.fromPartition(partition);
  const stored = await ownedSession.cookies.get({ url: origin, name });
  assert.equal(stored.length, 1);
  const cookie = stored[0];
  assert.equal(cookie.name, name);
  assert.equal(cookie.value, expectedValue);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, origin.startsWith("https:"));
  assert.equal(cookie.sameSite, "strict");
  assert.equal(cookie.path, "/");
  assert.equal(cookie.hostOnly, true);
  const scriptCookies = primaryWindow
    ? await primaryWindow.webContents.executeJavaScript("document.cookie") : "";
  assert.equal(scriptCookies, "");
  const secureProbe = origin.startsWith("https:")
    ? await navigateProbe(partition, `${config.httpsOrigin}/cookie-probe?case=${kind}`) : null;
  if (secureProbe) assert.equal(secureProbe.expectedCookie, true);
  const insecureProbe = await navigateProbe(partition, `${config.httpOrigin}/cookie-probe?case=${kind}`);
  assert.equal(insecureProbe.expectedCookie, !origin.startsWith("https:"));
  if (origin.startsWith("https:")) assert.equal(insecureProbe.sessionCookieCount, 0);
  report.cases.push({
    kind, usedRemoteEntry: Boolean(primaryWindow), name: cookie.name, secure: cookie.secure,
    httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path, hostOnly: cookie.hostOnly,
    httpsSendsExpected: secureProbe?.expectedCookie ?? null, httpSendsExpected: insecureProbe.expectedCookie,
    httpSessionCookieCount: insecureProbe.sessionCookieCount, rendererCookieHidden: scriptCookies === "",
  });
}

let started = false;
app.on("browser-window-created", (_event, window) => {
  if (started) return;
  started = true;
  window.webContents.once("did-finish-load", () => {
    void (async () => {
      assert.equal(new URL(window.webContents.getURL()).origin, config.httpsOrigin);
      await checkCase({ kind: "https-host", partition: "persist:kcoder-studio-remote", origin: config.httpsOrigin,
        name: "__Host-kcoder_studio_session", expectedValue: config.hostValue, primaryWindow: window });
      for (const [kind, origin, value] of [
        ["https-legacy", config.httpsOrigin, config.legacyValue], ["http-legacy", config.httpOrigin, config.httpValue],
      ]) {
        const partition = `remote-cookie-${kind}`;
        const cookie = await loginRemoteGatewaySession({ origin, initialUrl: `${origin}/g/legacy/`, token: config.token, timeoutMs: 5_000 });
        assert.equal(cookie.name, "kcoder_studio_session");
        assert.equal(cookie.value, value);
        const ownedSession = session.fromPartition(partition);
        await ownedSession.setProxy({ mode: "direct" });
        await ownedSession.cookies.set(remoteSessionCookieDetails(origin, cookie));
        await checkCase({ kind, partition, origin, name: cookie.name, expectedValue: value });
      }
      await finish();
    })().catch(finish);
  });
});
