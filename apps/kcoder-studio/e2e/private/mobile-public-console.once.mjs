import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runE2E } from "../harness/run-context.mjs";
import { startChromium } from "../harness/chromium.mjs";

const origin = "https://49.234.36.54:8451", mount = "/g/hmr-preview-20261014";
process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-public-console", tier: "manual-live", retainSuccessLogs: true,
  modelPolicy: "User-authorized public development UI inspection with an owned browser/device login; no model send, deletion or shared process cleanup",
}, async run => {
  const environment = Object.fromEntries((await readFile("/proc/3786921/environ")).toString().split("\0").filter(Boolean).map(row => { const index = row.indexOf("="); return [row.slice(0, index), row.slice(index + 1)]; }));
  const loginToken = environment.KCODER_STUDIO_AUTH_TOKEN, pairingToken = environment.KCODER_STUDIO_MOBILE_PAIRING_TOKEN;
  assert.ok(loginToken && pairingToken); run.registerSecret(loginToken); run.registerSecret(pairingToken);
  const browser = await startChromium(run, { label: "public-console-browser", noSandbox: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Log.enable"); await cdp.send("Network.enable"); await cdp.send("Accessibility.enable");
  const diagnostics = [], errors = [], requests = [], sockets = [], steps = [];
  let stage = "login", accessToken, profileId;
  const clean = value => run.redactText(String(value)).replace(/([?#](?:[^\s]*))/g, "");
  const capture = (source, level, message) => diagnostics.push({ stage, source, level, message: clean(message) });
  page.on("console", message => { if (["warning", "error"].includes(message.type())) capture("console", message.type(), message.text()); });
  page.on("pageerror", error => errors.push({ stage, message: clean(error.message) }));
  page.on("response", response => { if (response.status() >= 400) requests.push({ stage, path: new URL(response.url()).pathname, status: response.status() }); });
  page.on("requestfailed", request => requests.push({ stage, path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  cdp.on("Log.entryAdded", ({ entry }) => { if (["warning", "error"].includes(entry.level)) capture("browser", entry.level, entry.text); });
  cdp.on("Network.webSocketCreated", event => sockets.push({ id: event.requestId, path: new URL(event.url).pathname }));
  cdp.on("Network.webSocketHandshakeResponseReceived", event => { const row = sockets.find(row => row.id === event.requestId); if (row) row.status = event.response.status; });
  cdp.on("Network.webSocketFrameError", event => { const row = sockets.find(row => row.id === event.requestId); if (row) row.error = clean(event.errorMessage); });
  cdp.on("Network.responseReceived", ({ response }) => { if (response.status >= 400) requests.push({ stage, path: new URL(response.url).pathname, status: response.status, source: "browser" }); });
  page.on("response", async response => {
    if (new URL(response.url()).pathname === `${mount}/api/mobile/session` && response.request().method() === "POST" && response.ok()) {
      try { const body = await response.json(); accessToken = body.accessToken; for (const key of ["accessToken", "rpcToken", "refreshToken"]) if (body[key]) run.registerSecret(body[key]); } catch {}
    }
  });
  await page.addInitScript(() => localStorage.setItem("kcoder-studio:mobile-app-preferences:v1", JSON.stringify({ interfaceVersion: "v3", language: "zh-CN", theme: "light" })));
  const ui = id => page.locator(`[data-testid="${id}"]:visible`);
  const step = async (name, action) => {
    stage = name;
    await action(); await cdp.send("Accessibility.getFullAXTree"); await page.waitForTimeout(350);
    steps.push({ name, path: new URL(page.url()).pathname, focus: await page.evaluate(() => ({ tag: document.activeElement?.tagName, testId: document.activeElement?.getAttribute("data-testid"), hidden: Boolean(document.activeElement?.closest('[aria-hidden="true"]')), boundaries: [...document.querySelectorAll('[data-testid="screen-focus-boundary"]')].map(node => ({ inert: node.inert, hiddenAncestor: Boolean(node.closest('[aria-hidden="true"]')) })) })) });
  };
  try {
    const returnTo = `${mount}/mobile/connect?gateway=${encodeURIComponent(origin + mount)}`;
    const login = await page.request.post(`${origin}${mount}/login`, { form: { token: loginToken, returnTo }, maxRedirects: 0 });
    assert.equal(login.status(), 303);
    if (process.argv.includes("--cleanup-first-owned-device")) {
      const orphan = "f1e5b650-29bd-4665-805e-1828604a7601";
      const devices = JSON.parse(await readFile("/tmp/kcoder-mobile-hmr-preview-20261014/gateway/mobile-device-auth/devices.json", "utf8")).devices;
      assert.ok(devices.some(row => row.id === orphan && row.createdAt === 1792726903560));
      const revoked = await page.request.delete(`${origin}${mount}/api/mobile/pairing/devices/${orphan}`, { headers: { origin, "content-type": "application/json" }, data: {} });
      assert.equal(revoked.status(), 204); await run.writeArtifactJson("previous-owned-device-cleanup.json", { status: revoked.status() });
    }
    await page.goto(`${origin}${returnTo}#token=${encodeURIComponent(pairingToken)}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await ui("home-interface-v3").waitFor({ timeout: 60_000 });
    profileId = new URL(page.url()).pathname.split("/h/")[1]?.split("/")[0];
    await step("home-settings", async () => { await ui("home-settings").click(); await ui("settings-appearance").waitFor(); });
    await step("home-return", async () => { await ui("settings-detail-back").click(); await ui("home-interface-v3").waitFor(); });
    await step("history", async () => { await ui("sessions").click(); await ui("session-search").waitFor(); });
    await step("history-return", async () => { await page.goBack(); await ui("home-interface-v3").waitFor(); });
    await step("draft", async () => { await ui("new-workspace").click(); await ui("message-input").waitFor({ timeout: 45_000 }); });
    await step("task-more", async () => { await ui("task-more").click(); });
    await step("task-menu-close", async () => { await page.keyboard.press("Escape"); });
    await step("project-picker", async () => { await ui("draft-context-project").click(); });
    await step("project-select", async () => {
      const options = page.locator('[data-testid^="draft-context-project-option-"]:visible');
      if (await options.count()) await options.first().click(); else await ui("draft-context-close").click();
    });
    await step("task-navigation", async () => { await ui("v3-conversation-menu").click(); });
    await step("task-navigation-history", async () => { await ui("v3-menu-history").click(); await ui("session-search").waitFor(); });
    await step("task-history-return", async () => { await page.goBack(); await ui("message-input").waitFor(); });
    await step("reload", async () => { await page.reload({ waitUntil: "domcontentloaded" }); await ui("message-input").waitFor({ timeout: 45_000 }); });
  } finally {
    await run.writeArtifactJson("console.json", diagnostics); await run.writeArtifactJson("page-errors.json", errors);
    await run.writeArtifactJson("network.json", { requests, sockets }); await run.writeArtifactJson("steps.json", steps);
    await run.writeArtifactJson("page-state.json", { stage, text: await page.locator("body").innerText() });
    if (accessToken) {
      const response = await page.request.delete(`${origin}${mount}/api/mobile/session`, { headers: { authorization: `Bearer ${accessToken}` } });
      await run.writeArtifactJson("device-cleanup.json", { status: response.status() });
      assert.equal(response.status(), 204);
    }
    await page.request.post(`${origin}${mount}/logout`, { maxRedirects: 0 });
    await page.close();
  }
  assert.deepEqual(diagnostics, [], "No console/browser warning or error is allowed in the inspected flows");
  assert.deepEqual(errors, [], "No uncaught exception is allowed");
  assert.equal(sockets.some(row => row.path === `${mount}/message` && row.status === 101), true);
  return { diagnostics, errors, requests, sockets, steps };
});
