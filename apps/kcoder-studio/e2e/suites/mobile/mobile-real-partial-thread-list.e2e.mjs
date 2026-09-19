import assert from "node:assert/strict";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { appRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

// QA: real Mobile Web -> Gateway -> Rust list protocol, not provider/model behavior.
// Seed A/B, corrupt only the owned B metadata, repeat partial refreshes via rename ACK,
// then repair/delete B and require a complete refresh to remove it and clear the warning.
await runE2E(import.meta.url, {
  testId: "mobile-web-real-partial-thread-list-retention",
  tier: "full-integration",
  modelPolicy: "model-independent real Mobile Web list and mutation protocol; two bounded loopback text-fixture turns",
  retainSuccessLogs: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, "explicit KCoder binary");
  const mobileRoot = resolve(appRoot, "mobile");
  const mobileDist = context.pathInState("mobile-dist");
  const exportStartedAt = Date.now();
  const exporter = context.spawnOwned("mobile-web-export", process.execPath, [
    resolve(mobileRoot, "node_modules/expo/bin/cli"), "export", "--platform", "web", "--output-dir", mobileDist,
  ], {
    cwd: mobileRoot,
    env: context.isolatedEnvironment({ CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_NO_DOTENV: "1" }),
  });
  await waitFor(() => exporter.exitCode !== null || exporter.signalCode !== null, 180_000, "fresh isolated Mobile Web export", 100, context.abortSignal);
  assert.equal(exporter.exitCode, 0, "fresh Mobile Web export must succeed without changing dependencies");
  await access(join(mobileDist, "index.html"));
  assert.ok((await stat(join(mobileDist, "index.html"))).mtimeMs >= exportStartedAt);
  await context.stopOwned("mobile-web-export");

  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "mobile-partial-list" });
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: "FIXTURE_COMPLETE" });
  const settings = await context.writeStateJson("config/settings.json", {
    active_provider: "fixture",
    providers: { fixture: {
      api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: model.baseUrl,
      default_model: "fixture", context_window_tokens: 128000, output_headroom_tokens: 8192,
      max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true,
    } },
  });
  const serversFile = await context.writeStateJson("servers.json", [
    { id: "local", label: "Mobile Partial Fixture", transport: "local", command: binary, workspace, settingsFile: settings },
  ]);
  const gateway = await startGateway(context, {
    label: "mobile-partial-gateway", workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: dirname(settings), KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const rpcUrl = gatewayRpcUrl(gateway, "local", await waitForGatewayRpcToken(context, gateway));
  let rpc = await openRpc(rpcUrl);
  context.addCleanup("close mobile partial observer RPC", async () => {
    rpc.close();
    await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 5000, "observer RPC close");
  });
  const initialized = await initializeRpc(rpc, "mobile-partial-seed");
  assert.equal(initialized.capabilities.experimental.threadListCompleteness, true);
  const ids = [];
  for (const label of ["A", "B"]) {
    const id = (await rpc.request("thread/start", {})).thread.id;
    const turn = await rpc.request("turn/start", { threadId: id, input: [{ type: "text", text: label }] });
    await rpc.waitFor(message => message.method === "turn/completed" && message.params?.threadId === id
      && message.params?.turnId === turn.turn.id, 15000, `seed ${label} turn`);
    await rpc.request("thread/metadata/update", { threadId: id, title: `Mobile List ${label}` });
    ids.push(id);
  }
  const metadataPath = await findOwnedMetadata(dirname(settings), ids[1]);
  assert.ok(metadataPath, "B metadata must be inside this run's owned config tree");
  const originalMetadata = await readFile(metadataPath);
  rpc.close();
  await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 5000, "seed RPC close");
  rpc = await openRpc(rpcUrl);
  await initializeRpc(rpc, "mobile-partial-observer");

  const chromium = await startChromium(context, { label: "mobile-partial-chromium" });
  const page = await chromium.newPage({ viewport: { width: 390, height: 844 } });
  const listExchanges = [];
  const pageErrors = [];
  const stages = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("websocket", socket => {
    const requests = new Map();
    socket.on("framesent", ({ payload }) => {
      try {
        const value = JSON.parse(String(payload));
        if (value.method === "thread/list") requests.set(value.id, value.params);
      } catch { /* Ignore unrelated non-JSON frames. */ }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const value = JSON.parse(String(payload));
        if (!requests.has(value.id) || value.method) return;
        listExchanges.push({
          request: requests.get(value.id), completeness: value.result?.completeness,
          issueCount: value.result?.issueCount, threadIds: value.result?.threads?.map(thread => thread.id),
          error: value.error?.message,
        });
        requests.delete(value.id);
      } catch { /* The fixture records only list contract fields, never initialize secrets. */ }
    });
  });
  const row = id => page.getByTestId(`session-${id}`);
  let stage = "mobile-connect";
  const renameA = async title => {
    await page.getByTestId(`session-actions-${ids[0]}`).click();
    await page.getByTestId("thread-rename-input").fill(title);
    await page.getByTestId("thread-rename-save").click();
    await waitFor(async () => (await row(ids[0]).innerText()).includes(title), 10000, "Mobile rename ACK");
    await page.getByLabel("关闭", { exact: true }).last().click();
    await page.getByTestId("thread-rename-input").waitFor({ state: "hidden" });
  };
  try {
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30000 });
    await page.getByTestId("welcome-direct-connection").click();
    await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
    await page.getByTestId("gateway-connect").click();
    await page.getByTestId("sessions").waitFor({ state: "visible", timeout: 30000 });
    await page.getByTestId(`thread-${ids[0]}`).waitFor({ state: "visible" });
    await page.getByTestId(`thread-${ids[1]}`).waitFor({ state: "visible" });
    await page.getByTestId("sessions").click();
    await row(ids[0]).waitFor({ state: "visible" });
    await row(ids[1]).waitFor({ state: "visible" });
    stages.push({ stage: "complete-baseline", visible: ["A", "B"] });

    stage = "partial-retention";
    await writeFile(metadataPath, "{broken");
    await assert.rejects(rpc.request("thread/list", {}), /allowPartial|incomplete/);
    for (let attempt = 0; attempt < 3; attempt++) {
      const offset = listExchanges.length;
      await renameA(`Mobile Partial A ${attempt}`);
      await waitFor(() => listExchanges.slice(offset).some(reply => reply.completeness === "partial"), 10000, "Mobile opted-in partial list");
      await page.getByText(/会话列表不完整/).first().waitFor({ state: "visible" });
      await row(ids[1]).waitFor({ state: "visible" });
      const partial = listExchanges.slice(offset).find(reply => reply.completeness === "partial");
      assert.equal(partial.request.allowPartial, true);
      assert.equal(partial.issueCount, 1);
      assert.ok(!partial.threadIds.includes(ids[1]), "real partial reply omits damaged B");
      stages.push({ stage: `partial-${attempt}`, knownBRetained: true, issueCount: partial.issueCount });
    }
    await page.screenshot({ path: context.pathInArtifacts("mobile-partial-retains-b.png") });

    stage = "complete-convergence";
    await writeFile(metadataPath, originalMetadata);
    assert.equal((await rpc.request("thread/delete", { threadId: ids[1] })).deleted, true);
    const offset = listExchanges.length;
    await renameA("Mobile Complete A");
    await waitFor(() => listExchanges.slice(offset).some(reply => reply.completeness === "complete" && !reply.threadIds.includes(ids[1])), 10000, "Mobile complete deletion confirmation");
    await row(ids[1]).waitFor({ state: "hidden", timeout: 10000 });
    await page.getByText(/会话列表不完整/).waitFor({ state: "hidden" });
    await row(ids[0]).waitFor({ state: "visible" });
    assert.deepEqual(pageErrors, []);
    assert.equal(model.requests.length, 2);
    stages.push({ stage: "complete-convergence", missingBRemoved: true, noticeCleared: true });
    await context.writeArtifactJson("mobile-partial-evidence.json", { stages, listExchanges, pageErrors, binary, freshExport: true });
    return { completeBaseline: true, repeatedPartialRetainsB: true, realPartialOmitsB: true,
      explicitRenameAck: true, completeRemovesB: true, incompleteNoticeCleared: true,
      loopbackModelRequests: model.requests.length, freshIsolatedMobileExport: true,
      successScreenshotReason: "critical Mobile partial warning alongside the retained known B row" };
  } catch (error) {
    await context.writeArtifactJson("mobile-partial-failure.json", { stage, error: String(error), stages, listExchanges, pageErrors, body: await page.locator("body").innerText() });
    await page.screenshot({ path: context.pathInArtifacts("mobile-partial-failure.png") }).catch(() => undefined);
    throw error;
  } finally { await page.close(); }
});

async function findOwnedMetadata(root, id) {
  const directories = [root];
  for (let index = 0; index < directories.length; index++) {
    assert.ok(directories.length < 200, "owned metadata traversal must remain bounded");
    for (const entry of await readdir(directories[index], { withFileTypes: true })) {
      const path = join(directories[index], entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && entry.name === "thread-metadata.json" && basename(directories[index]) === id) return path;
    }
  }
  return null;
}
