import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { openRpc, initializeRpc, gatewayRpcUrl, closeRpcAndWait } from "../harness/rpc.mjs";

const mobileRoot = process.env.KCODER_DELETE_CHECK_MOBILE_ROOT;
assert.ok(mobileRoot, "provide the freshly built Mobile Web root");
await runE2E(import.meta.url, {
  testId: "mobile-resident-thread-delete-diagnostic", tier: "manual-live",
  modelPolicy: "model-independent connection ownership with a real app-server and deterministic full-turn scenario; no external Provider",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const config = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(config, { recursive: true });
  const gateway = await startGateway(context, {
    auth: true, workspace, label: "resident-delete-gateway",
    kcoderBin: resolve(repoRoot, "target/debug/kcoder"),
    env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_MOBILE_WEB_ROOT: resolve(mobileRoot),
      KCODER_STUDIO_WEB_ROOT: resolve(appRoot, "renderer/dist") },
  });
  const bootstrapResponse = await fetch(`${gateway.baseUrl}/api/mobile/session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: gateway.authToken }),
  });
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  context.registerSecret(bootstrap.accessToken);
  context.registerSecret(bootstrap.rpcToken);
  const seed = await openRpc(gatewayRpcUrl(gateway, "local", bootstrap.rpcToken), {
    headers: { Authorization: `Bearer ${bootstrap.accessToken}` },
  });
  context.addCleanup("seed RPC", () => closeRpcAndWait(seed));
  await initializeRpc(seed, "resident-delete-seed");
  const cases = [];
  for (const entry of ["home-drawer", "sessions"]) {
    const started = await seed.request("thread/start", { cwd: workspace });
    const threadId = started.thread.id;
    const title = `RESIDENT_DELETE_${entry}`;
    await seed.request("thread/metadata/update", { threadId, title });
    const turn = await seed.request("turn/start", { threadId, input: [{ type: "text", text: title }], clientMessageId: `seed-${entry}` });
    await seed.waitFor(message => message.method === "turn/completed" && message.params?.threadId === threadId &&
      message.params?.turnId === turn.turn.id, 30_000, "seed turn completion");
    cases.push({ entry, threadId });
  }
  await closeRpcAndWait(seed);
  const chromium = await startChromium(context, { label: "resident-delete-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [], responses = [], errors = [];
  let socketId = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => {
    const owner = ++socketId;
    socket.on("framesent", event => { try {
      const message = JSON.parse(String(event.payload));
      if (["thread/resume", "thread/delete", "turn/start"].includes(message.method))
        requests.push({ socketId: owner, id: message.id, method: message.method, threadId: message.params?.threadId });
    } catch {} });
    socket.on("framereceived", event => { try {
      const message = JSON.parse(String(event.payload));
      if (message.id !== undefined && !message.method)
        responses.push({ socketId: owner, id: message.id, errorCode: message.error?.code, deleted: message.result?.deleted });
    } catch {} });
  });
  try {
    await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("welcome-direct-connection").click();
    await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
    await page.getByTestId("gateway-token").fill(gateway.authToken);
    await page.getByTestId("gateway-connect").click();
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    const home = page.url();
    for (const item of cases) {
      const row = page.getByTestId(`thread-${item.threadId}`);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(await row.count(), 1);
      await row.click();
      await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 30_000 });
      await waitFor(() => requests.some(request => request.method === "thread/resume" && request.threadId === item.threadId),
        30_000, "Mobile resident resume");
      const owner = requests.findLast(request => request.method === "thread/resume" && request.threadId === item.threadId);
      await page.goBack();
      await page.waitForURL(home);
      if (item.entry === "home-drawer") {
        await page.getByLabel(/^(Task navigation|任务导航)$/).click();
        await page.getByTestId(`drawer-thread-actions-${item.threadId}`).click();
      } else {
        await page.getByTestId("sessions").click();
        await page.getByTestId(`session-actions-${item.threadId}`).click();
      }
      const actions = page.getByRole("dialog", { name: /^(Task actions|任务操作)$/ });
      await actions.waitFor({ state: "visible" });
      assert.equal(await actions.getByTestId("thread-delete-action").count(), 1);
      page.once("dialog", dialog => dialog.accept());
      await actions.getByTestId("thread-delete-action").click();
      await actions.waitFor({ state: "hidden", timeout: 30_000 });
      const deletions = requests.filter(request => request.method === "thread/delete" && request.threadId === item.threadId);
      assert.equal(deletions.length, 1, "exactly one delete request");
      assert.equal(deletions[0].socketId, owner.socketId, "delete must reuse the resident owner socket");
      const acknowledgement = responses.find(response => response.socketId === owner.socketId && response.id === deletions[0].id);
      assert.equal(acknowledgement?.errorCode, undefined);
      assert.equal(acknowledgement?.deleted, true);
      await page.getByTestId(`${item.entry === "home-drawer" ? "drawer-thread" : "session"}-${item.threadId}`).waitFor({ state: "hidden" });
      if (item.entry === "home-drawer") {
        const close = page.getByTestId("mobile-drawer").getByLabel(/^(Close navigation|关闭导航)$/);
        assert.equal(await close.count(), 1);
        await close.click();
      }
      else await page.goBack();
      await page.waitForURL(home);
    }
    assert.equal(requests.filter(request => request.method === "turn/start").length, 0, "UI must not send or replay a turn");
    assert.deepEqual(errors, []);
    await context.writeArtifactJson("ownership.json", { cases, requests, responses, errors });
    return { cases: cases.map(item => item.entry), ownerSocketReused: true, deleteCount: 2, externalProviderCalls: 0 };
  } catch (error) {
    await context.writeArtifactJson("failure.json", { requests, responses, errors, message: error.message });
    await page.screenshot({ path: context.pathInArtifacts("failure.png") });
    throw error;
  }
});
