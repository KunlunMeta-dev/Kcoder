import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { login } from "../../harness/http.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { openRpc } from "../../harness/rpc.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";
import { startSshFixture } from "../../harness/ssh-fixture.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "ssh-terminal-model-independent-loopback-pty-ui",
  tier: "browser-loopback-ssh",
  modelPolicy: "No model turns: real sshd PTY, Gateway transport, settings persistence and Chromium UI; model output adds no coverage value",
}, async context => {
  const ssh = await startSshFixture(context);
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "ssh-terminal" });
  const serversStore = context.pathInState("servers-store.json");
  const privateKeyPath = resolve(ssh.root, "client-key");
  const baseProfile = { host: "127.0.0.1", port: ssh.port, username: ssh.user, authMethod: "key", privateKeyPath };
  const evidence = { stage: "rpc-without-app-server", checks: [], sshRequests: [], modelTurns: 0, outputLeaks: 0 };
  // An absent executable makes any accidental app-server dependency fail, without mocking SSH.
  const rpcGateway = await startGateway(context, {
    label: "ssh-only-gateway", workspace, serversStore, auth: true,
    kcoderBin: context.pathInState("intentionally-absent-kcoder"),
  });
  const cookie = await login(rpcGateway.baseUrl, rpcGateway.authToken);
  context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, rpcGateway, { headers: { cookie } });
  const api = async (method, id, profile) => {
    const response = await fetch(`${rpcGateway.baseUrl}/api/ssh-connections${id ? `/${id}` : ""}`, {
      method, headers: { cookie, origin: rpcGateway.baseUrl, "content-type": "application/json" },
      ...(profile ? { body: JSON.stringify(profile) } : {}),
    });
    assert.equal(response.status, 200, `${method} SSH profile must succeed`);
    return response.json();
  };
  const rpcProfile = { ...baseProfile, id: "ssh-rpc", label: "Loopback RPC" };
  await api("PUT", rpcProfile.id, rpcProfile);
  const open = async label => {
    const rpc = await openRpc(`${rpcGateway.wsUrl}/rpc?${new URLSearchParams({ token, channel: "ssh-terminal" })}`, {
      headers: { cookie, origin: rpcGateway.baseUrl },
    });
    context.addCleanup(`close ${label} SSH socket`, () => rpc.close());
    return rpc;
  };
  const first = await open("first");
  const challenge = await first.request("ssh/connect", { profileId: rpcProfile.id });
  assert.equal(challenge.status, "host-key-required");
  assert.match(challenge.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(challenge.host, baseProfile.host);
  assert.equal(challenge.port, ssh.port);
  assert.equal(output(first), "", "Untrusted host must not produce a shell");
  await assert.rejects(first.request("ssh/connect", { profileId: rpcProfile.id, acceptFingerprint: `SHA256:${"A".repeat(43)}` }));
  assert.equal(output(first), "", "Rejected fingerprint must not authenticate or open a shell");
  assert.equal((await first.request("ssh/connect", { profileId: rpcProfile.id, acceptFingerprint: challenge.fingerprint })).status, "connected");
  await first.request("ssh/write", { data: "stty -echo; printf '\\nREADY_%s\\n' RPC\r" });
  await waitForOutput(first, "READY_RPC");
  await first.request("ssh/resize", { rows: 37, cols: 113 });
  await first.request("ssh/write", { data: "printf 'SIZE_%s_END\\n' \"$(stty size)\"\r" });
  await waitForOutput(first, "SIZE_37 113_END");
  const second = await open("second");
  assert.equal((await second.request("ssh/connect", { profileId: rpcProfile.id })).status, "connected");
  await second.request("ssh/write", { data: "stty -echo; printf '\\nSECOND_%s\\n' SESSION\r" });
  await waitForOutput(second, "SECOND_SESSION");
  await first.request("ssh/write", { data: "printf 'FIRST_%s\\n' SESSION\r" });
  await waitForOutput(first, "FIRST_SESSION");
  assert.equal(output(first).includes("SECOND_SESSION"), false);
  assert.equal(output(second).includes("FIRST_SESSION"), false);
  await first.request("ssh/close");
  await first.waitFor(message => message.method === "ssh/exit", 10_000, "SSH exit notification");
  await assert.rejects(first.request("ssh/write", { data: "echo closed\r" }));
  assert.equal((await first.request("ssh/connect", { profileId: rpcProfile.id })).status, "connected");
  await first.request("ssh/write", { data: "printf '\\nRECONNECTED_%s\\n' RPC\r" });
  await waitForOutput(first, "RECONNECTED_RPC");
  await first.request("ssh/close");
  await second.request("ssh/close");
  first.close();
  second.close();
  evidence.checks.push("no-app-server-dependency", "fingerprint-confirmation-and-rejection", "real-pty-echo-resize", "rpc-session-isolation", "rpc-disconnect-reconnect");

  const passwordProfile = { ...baseProfile, privateKeyPath: undefined, authMethod: "password", id: "ssh-bad-password", label: "Password rejection" };
  await api("PUT", passwordProfile.id, passwordProfile);
  const denied = await open("password rejection");
  const passwordChallenge = await denied.request("ssh/connect", { profileId: passwordProfile.id });
  const wrongPassword = "e2e-never-valid-password";
  context.registerSecret(wrongPassword);
  // This sshd intentionally disables password authentication; it must not fall back to a key.
  await assert.rejects(denied.request("ssh/connect", { profileId: passwordProfile.id, acceptFingerprint: passwordChallenge.fingerprint, password: wrongPassword }));
  assert.equal(output(denied), "");
  denied.close();
  await api("DELETE", passwordProfile.id);
  await api("DELETE", rpcProfile.id);
  assert.deepEqual((await api("GET")).connections, []);
  await context.stopOwned("ssh-only-gateway");
  evidence.checks.push("password-rejection-no-key-fallback", "profile-delete");

  evidence.stage = "settings-and-ui";
  const gateway = await startGateway(context, { label: "ssh-ui-gateway", workspace, serversStore, auth: true });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1440, height: 1000 } });
  const uiMarkers = ["SSH_UI_FIRST", "SSH_UI_SECOND", "SSH_UI_RECONNECTED"];
  let connectRequests = 0;
  page.on("websocket", socket => {
    const sshChannel = new URL(socket.url()).searchParams.get("channel") === "ssh-terminal";
    socket.on("framesent", ({ payload }) => {
      let message;
      try { message = JSON.parse(String(payload)); } catch { return; }
      if (sshChannel) {
        if (message.method) evidence.sshRequests.push(message.method);
        if (message.method === "ssh/connect") connectRequests += 1;
      } else {
        if (/^(turn\/start|task\.send|thread\/startTurn)$/.test(message.method || "")) evidence.modelTurns += 1;
        if (uiMarkers.some(marker => String(payload).includes(marker))) evidence.outputLeaks += 1;
      }
    });
  });
  try {
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith("/login")),
      page.locator('button[type="submit"]').click(),
    ]);
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await page.goto(`${gateway.baseUrl}/settings/ssh-connections`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("ssh-connection-add").click();
    await page.getByTestId("ssh-connection-label").fill("Loopback SSH UI");
    await page.getByTestId("ssh-connection-host").fill(baseProfile.host);
    await page.getByTestId("ssh-connection-port").fill(String(ssh.port));
    await page.getByTestId("ssh-connection-username").fill(ssh.user);
    await page.getByTestId("ssh-connection-password").fill(wrongPassword);
    await page.getByTestId("ssh-connection-save").click();
    await page.getByTestId("ssh-connection-form").waitFor({ state: "detached" });
    const savedPasswordProfile = (await browserProfiles(page))[0];
    assert.equal(savedPasswordProfile.passwordSaved, true);
    assert.equal(savedPasswordProfile.password, undefined);
    assert.equal(savedPasswordProfile.credentials, undefined);
    assert.equal((await readFile(context.pathInState("ssh_connections.jsonc"), "utf8")).includes(wrongPassword), false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId(`ssh-connection-edit-${savedPasswordProfile.id}`).click();
    assert.equal(await page.getByTestId("ssh-connection-password").inputValue(), "");
    await page.getByTestId("ssh-connection-clear-password").click();
    await page.getByTestId("ssh-connection-save").click();
    await page.getByTestId("ssh-connection-form").waitFor({ state: "detached" });
    assert.equal((await browserProfiles(page))[0].passwordSaved, undefined);
    await page.getByTestId(`ssh-connection-edit-${savedPasswordProfile.id}`).click();
    await page.getByTestId("ssh-connection-auth").selectOption("key");
    await page.getByTestId("ssh-connection-privateKeyPath").fill(privateKeyPath);
    await page.getByTestId("ssh-connection-save").click();
    await page.getByTestId("ssh-connection-form").waitFor({ state: "detached" });
    const profiles = await browserProfiles(page);
    assert.equal(profiles.length, 1);
    const profile = profiles[0];
    assert.equal(profile.label, "Loopback SSH UI");
    assert.equal(profile.authMethod, "key");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId(`ssh-connection-row-${profile.id}`).waitFor({ state: "visible" });
    assert.equal(connectRequests, 0, "Saving or refreshing settings must not start SSH");
    const configPath = context.pathInState("ssh_connections.jsonc");
    const config = await readFile(configPath, "utf8");
    assert.ok(config.includes(profile.id));
    assert.equal(config.includes(wrongPassword), false);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    evidence.checks.push("ui-profile-save-jsonc-persistence");

    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible" });
    await page.getByTestId("project-item").first().waitFor({ state: "visible", timeout: 30_000 });
    const panel = page.getByTestId("bottom-workspace-panel");
    if (await panel.getAttribute("aria-hidden") !== "false") await page.getByTestId("toggle-bottom-workspace-panel-button").click();
    const addSshTab = async () => {
      await page.waitForFunction(() => document.querySelector('[data-testid="bottom-workspace-panel"]')?.getAttribute("aria-hidden") === "false");
      await page.getByTestId("workspace-terminal-new-tab-button").click();
      await page.getByTestId(`workspace-add-ssh-${profile.id}`).click();
      await activePane(page).getByTestId("ssh-connect").waitFor({ state: "visible" });
    };
    await addSshTab();
    assert.equal(connectRequests, 0, "Adding a tab must not connect without user action");
    await activePane(page).getByTestId("ssh-connect").click();
    await activePane(page).getByTestId("ssh-host-fingerprint").waitFor({ state: "visible" });
    assert.equal(await activePane(page).getByTestId("ssh-host-fingerprint").innerText(), challenge.fingerprint);
    await activePane(page).getByTestId("ssh-confirm-host").click();
    await uiProbe(page, "FIRST");
    const tabs = page.getByTestId("bottom-workspace-terminal-tab");
    const firstTabIndex = await selectedTabIndex(tabs);
    await addSshTab();
    await activePane(page).getByTestId("ssh-connect").click();
    await uiProbe(page, "SECOND");
    const secondTabIndex = await selectedTabIndex(tabs);
    assert.notEqual(firstTabIndex, secondTabIndex);
    assert.equal((await activeOutput(page)).includes(uiMarkers[0]), false);
    await tabs.nth(firstTabIndex).click();
    await waitFor(async () => (await activeOutput(page)).includes(uiMarkers[0]), 10_000, "first SSH tab retained output");
    assert.equal((await activeOutput(page)).includes(uiMarkers[1]), false);
    await activePane(page).getByTestId("ssh-disconnect").click();
    await activePane(page).getByTestId("ssh-connect").waitFor({ state: "visible" });
    await activePane(page).getByTestId("ssh-connect").click();
    await uiProbe(page, "RECONNECTED");
    await tabs.nth(secondTabIndex).click();
    assert.equal((await activeOutput(page)).includes(uiMarkers[2]), false);
    await uiProbe(page, "SECOND_ALIVE");
    evidence.checks.push("ui-first-host-confirmation", "ui-two-tab-isolation", "ui-disconnect-reconnect");

    evidence.stage = "refresh-no-auto-connect";
    const beforeReload = connectRequests;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible" });
    assert.equal((await browserProfiles(page))[0].id, profile.id);
    await page.getByTestId("project-item").first().waitFor({ state: "visible", timeout: 30_000 });
    if (await panel.getAttribute("aria-hidden") !== "false") await page.getByTestId("toggle-bottom-workspace-panel-button").click();
    await addSshTab();
    await page.waitForTimeout(750);
    assert.equal(connectRequests, beforeReload, "Refreshing and reopening a saved profile must not reconnect");
    assert.equal(await activePane(page).getByTestId("ssh-password").count(), 0);
    assert.equal(await activePane(page).getByTestId("ssh-passphrase").inputValue(), "");
    assert.equal(evidence.modelTurns, 0);
    assert.equal(evidence.outputLeaks, 0, "SSH output must never be forwarded to runtime/model requests");
    evidence.checks.push("refresh-retains-profile-not-session", "no-model-turns-or-output-forwarding");
    evidence.stage = "passed";
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts("failure.png"), fullPage: true }).catch(() => undefined);
    await context.writeArtifactJson("ssh-terminal-failure.json", evidence);
    throw error;
  } finally {
    await page.close();
  }
  return evidence;
});

function output(rpc) {
  return rpc.messages().filter(message => message.method === "ssh/output").map(message => message.params.data).join("");
}

async function waitForOutput(rpc, marker) {
  await waitFor(() => output(rpc).includes(marker), 15_000, `real SSH output ${marker}`);
}

function activePane(page) { return page.locator('[data-testid="ssh-terminal-pane"]:visible'); }

async function activeOutput(page) { return activePane(page).locator(".xterm-rows").innerText(); }

async function uiProbe(page, suffix) {
  const input = activePane(page).locator("textarea.xterm-helper-textarea");
  await input.waitFor({ state: "visible", timeout: 20_000 });
  await input.focus();
  // Split the marker so terminal echo alone cannot satisfy the assertion.
  await page.keyboard.insertText(`printf '\\nSSH_UI_%s\\n' ${suffix}`);
  await page.keyboard.press("Enter");
  await waitFor(async () => (await activeOutput(page)).split("\n").some(line => line.trim() === `SSH_UI_${suffix}`), 15_000, `UI SSH shell ${suffix}`);
}

async function selectedTabIndex(tabs) {
  for (let index = 0; index < await tabs.count(); index += 1) {
    if (await tabs.nth(index).getAttribute("aria-selected") === "true") return index;
  }
  throw new Error("No selected SSH tab");
}

async function browserProfiles(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/ssh-connections");
    if (!response.ok) throw new Error(`SSH profiles HTTP ${response.status}`);
    return (await response.json()).connections;
  });
}
