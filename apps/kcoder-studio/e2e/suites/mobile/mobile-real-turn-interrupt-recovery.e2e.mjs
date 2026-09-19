import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-turn-interrupt-recovery",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic delayed provider interruption",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { textOnly: true, compactionSummary: true, delayedRequestNumber: 1, streamDelayMs: 30_000 });
  const settingsFile = await context.writeStateJson("turn-interrupt-settings.json", {
    active_provider: "interrupt-mobile", permission_mode: "yolo",
    providers: { "interrupt-mobile": provider(model.baseUrl) },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", { "interrupt-mobile": { type: "api", key: "deterministic-local" } });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Local", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true, label: "mobile-turn-interrupt-gateway", workspace, serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-turn-interrupt-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcRequests = [];
  const rpcMethodById = new Map();
  const rpcResponses = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("websocket", socket => {
    socket.on("framesent", event => {
    try {
      const value = JSON.parse(String(event.payload));
      if (value?.method) { rpcRequests.push({ id: value.id, method: value.method, params: value.params ?? null }); if (value.id !== undefined) rpcMethodById.set(value.id, value.method); }
    } catch {}
    });
    socket.on("framereceived", event => { try { const value = JSON.parse(String(event.payload)); if (value?.id !== undefined && rpcMethodById.has(value.id)) rpcResponses.push({ id: value.id, method: rpcMethodById.get(value.id), result: value.result ?? null, error: value.error ?? null }); } catch {} });
  });

  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("TURN_INTERRUPT_LONG_RUNNING");
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('[aria-label="更多"]:visible').click();
  const taskMenu = page.getByLabel("任务操作");
  await taskMenu.waitFor({ state: "visible", timeout: 10_000 });
  const compactWhileRunning = taskMenu.getByTestId("compact-task");
  assert.equal(await compactWhileRunning.getAttribute("aria-disabled"), "true", "任务运行中必须向用户暴露禁用状态");
  assert.equal(rpcRequests.some(request => request.method === "thread/compact"), false);
  await taskMenu.getByLabel("关闭").click();
  await page.getByTestId("stop-turn").click();
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
  const interrupt = rpcRequests.find(request => request.method === "turn/interrupt");
  assert.ok(interrupt?.params?.threadId);
  assert.ok(interrupt?.params?.turnId);
  const cancellationFeedbackImmediately = await page.getByText(/本轮已取消|已停止/, { exact: true }).isVisible().catch(() => false);
  await context.writeArtifactJson("mobile-real-turn-interrupt-immediate.json", {
    interrupt, cancellationFeedbackImmediately,
    bodyAfterInterrupt: (await page.locator("body").innerText()).slice(0, 8000),
    rpcRequests, diagnostics,
  });

  await page.getByTestId("message-input").fill("TURN_INTERRUPT_RECOVERY_MESSAGE");
  await page.getByTestId("send-message").click();
  await page.getByTestId("message-user").filter({ hasText: "TURN_INTERRUPT_RECOVERY_MESSAGE" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  assert.ok(model.requests.some(request => JSON.stringify(request).includes("TURN_INTERRUPT_RECOVERY_MESSAGE")));

  await page.locator('[aria-label="更多"]:visible').click();
  await taskMenu.waitFor({ state: "visible", timeout: 10_000 });
  const compactIdle = taskMenu.getByTestId("compact-task");
  assert.notEqual(await compactIdle.getAttribute("aria-disabled"), "true", "空闲任务必须允许压缩上下文");
  await compactIdle.click();
  const noCompactNotice = taskMenu.getByText("当前上下文无需压缩", { exact: true });
  await noCompactNotice.waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(await noCompactNotice.count(), 1, "无需压缩提示只能出现一次");
  assert.equal(rpcRequests.filter(request => request.method === "thread/compact").length, 1, "只能发送一次真实 thread/compact");
  const noCompactResponse = rpcResponses.find(response => response.method === "thread/compact");
  assert.equal(noCompactResponse?.result?.compacted, false);
  await taskMenu.getByLabel("关闭").click();

  for (const marker of ["COMPACT_HISTORY_SECOND_ROUND", "COMPACT_HISTORY_THIRD_ROUND", "COMPACT_HISTORY_FOURTH_ROUND"]) {
    await page.getByTestId("message-input").fill(`${marker} ${"history ".repeat(500)}`);
    await page.getByTestId("send-message").click();
    await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  }
  await page.locator('[aria-label="更多"]:visible').click();
  await taskMenu.waitFor({ state: "visible", timeout: 10_000 });
  await taskMenu.getByTestId("compact-task").click();
  const compactNotice = taskMenu.getByText(/上下文已压缩（\d+ → \d+ tokens）/);
  await compactNotice.waitFor({ state: "visible", timeout: 60_000 }).catch(async error => {
    await context.writeArtifactJson("failure-state.json", { body: await page.locator("body").innerText() });
    await page.screenshot({ path: context.pathInArtifacts("failure.png") });
    throw error;
  });
  assert.equal(await compactNotice.count(), 1, "真实压缩完成提示只能出现一次");
  const compactResponse = rpcResponses.filter(response => response.method === "thread/compact").at(-1);
  assert.equal(compactResponse?.result?.compacted, true, `足够历史必须真实压缩：${JSON.stringify(compactResponse)}`);
  assert.ok(compactResponse.result.postTokens < compactResponse.result.preTokens);
  await taskMenu.getByLabel("关闭").click();

  await page.getByTestId("message-input").fill("TURN_AFTER_REAL_COMPACT");
  await page.getByTestId("send-message").click();
  await page.getByTestId("message-user").filter({ hasText: "TURN_AFTER_REAL_COMPACT" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  const postCompactProviderRequest = [...model.requests].reverse().find(request => JSON.stringify(request).includes("TURN_AFTER_REAL_COMPACT"));
  assert.ok(postCompactProviderRequest, "压缩后下一轮必须真实到达 provider");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("已停止", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-user").filter({ hasText: "TURN_INTERRUPT_LONG_RUNNING" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-user").filter({ hasText: "TURN_INTERRUPT_RECOVERY_MESSAGE" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-user").filter({ hasText: "TURN_AFTER_REAL_COMPACT" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByTestId("stop-turn").count(), 0);
  assert.deepEqual(diagnostics, []);

  await context.writeArtifactJson("mobile-real-turn-interrupt-recovery.json", {
    interrupt,
    providerPromptCount: model.requests.length,
    compactRequests: rpcRequests.filter(request => request.method === "thread/compact"),
    noCompactResponse,
    compactResponse,
    compactReduction: { before: compactResponse?.result?.preTokens, after: compactResponse?.result?.postTokens },
    postCompactProviderRequest,
    compactCompletionNoticeCount: 1,
    recoveredWithSecondTurn: true,
    cancelledHistorySurvivedReload: true,
    rpcRequests,
    diagnostics,
  });
  assert.equal(cancellationFeedbackImmediately, true, "停止成功后必须立即显示明确的取消状态，而不是等刷新历史后才出现");
  return {
    realDelayedTurn: true, realInterrupt: true, composerRecovered: true,
    subsequentTurnSucceeded: true, realCompact: true,
    postCompactTurnSucceeded: true, cancelledHistorySurvivedReload: true,
  };
});

function provider(endpoint) {
  return {
    api_format: "openai_chat_completions", endpoint, default_model: "interrupt-e2e-model",
    context_window_tokens: 128000, output_headroom_tokens: 8192,
    max_output_tokens: 8192, request_timeout_secs: 60, no_proxy: true, extra_body: {},
  };
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}
