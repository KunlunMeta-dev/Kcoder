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
  testId: "mobile-web-real-slash-commands",
  tier: "full-integration",
  modelPolicy: "model-independent composer actions through one real app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("slash-settings.json", {
    active_provider: "mobile-slash",
    permission_mode: "yolo",
    providers: { "mobile-slash": provider(model.baseUrl) },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", {
    "mobile-slash": { type: "api", key: "deterministic-local" },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Local", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true, label: "mobile-slash-gateway", workspace, serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-slash-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcRequests = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("websocket", socket => socket.on("framesent", event => {
    try {
      const value = JSON.parse(String(event.payload));
      if (value?.method) rpcRequests.push({ method: value.method, params: value.params ?? null });
    } catch {}
  }));

  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("SLASH_COMMAND_BOOTSTRAP");
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });

  const composer = page.getByTestId("message-input");
  await composer.fill("/");
  const menu = page.getByTestId("slash-command-menu");
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  const visibleCommands = await menu.getByRole("menuitem").allTextContents();
  for (const command of ["/compact", "/model", "/rename", "/goal", "/goal-pro", "/moa", "/moa-plan"]) {
    assert.ok(visibleCommands.some(text => text.includes(command)), `slash menu missing ${command}`);
  }

  const turnStartsBeforeInvalidSlash = rpcRequests.filter(request => request.method === "turn/start").length;
  await page.getByTestId("send-message").click();
  await page.getByText("请输入 slash 指令名称", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await composer.fill("/unknown");
  await page.getByTestId("send-message").click();
  await page.getByText("未知 slash 指令：/unknown", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    rpcRequests.filter(request => request.method === "turn/start").length,
    turnStartsBeforeInvalidSlash,
    "empty and unknown slash input must not start a provider turn",
  );
  await composer.fill("/");

  const moaPlan = page.getByTestId("slash-command-moa-plan");
  await moaPlan.scrollIntoViewIfNeeded();
  await moaPlan.click();
  assert.equal(await composer.inputValue(), "/moa-plan ", "last slash command must remain reachable");

  await composer.fill("/");
  await page.getByTestId("slash-command-rename").click();
  assert.equal(await composer.inputValue(), "/rename ");
  const renamed = `Slash 任务 ${Date.now()}`;
  await composer.fill(`/rename ${renamed}`);
  await page.getByTestId("send-message").click();
  await page.getByText("任务标题已更新", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(renamed, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

  const turnStartsBeforeCompact = rpcRequests.filter(request => request.method === "turn/start").length;
  await composer.fill("/comp");
  await page.getByTestId("slash-command-compact").click();
  await page.getByText(/当前上下文无需压缩|上下文已压缩/).waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(
    rpcRequests.filter(request => request.method === "turn/start").length,
    turnStartsBeforeCompact,
    "compact slash command must not start a user turn",
  );

  await composer.fill("/mod");
  await page.getByTestId("slash-command-model").click();
  await page.getByRole("dialog", { name: "切换模型" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("dialog", { name: "切换模型" }).getByLabel("关闭").click();
  assert.equal(await composer.inputValue(), "");

  const strictObjective = `SLASH_MOBILE_STRICT_${Date.now()}`;
  await composer.fill(`/goal-pro ${strictObjective}`);
  await page.getByTestId("send-message").click();
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.mode === "strict"
    && request.params?.objective === strictObjective);
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });

  const controlTurnCount = rpcRequests.filter(request => request.method === "turn/start").length;
  await runSlash(page, composer, "/goal-pro status", /Goal Pro · active/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/get");
  await runSlash(page, composer, "/goal-pro pause", /Goal Pro · paused/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.status === "paused" && request.params?.objective === undefined);

  const editedObjective = `SLASH_MOBILE_EDITED_${Date.now()}`;
  await runSlash(page, composer, `/goal-pro edit --budget 3072 ${editedObjective}`, /Goal Pro 已更新并暂停/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.edit === true
    && request.params?.objective === editedObjective
    && request.params?.tokenBudget === 3072);
  await composer.fill("/goal-pro edit");
  await page.getByTestId("send-message").click();
  await page.getByText("目标已载入输入框，修改后发送即可保存", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await composer.inputValue(), `/goal-pro edit ${editedObjective}`);
  await runSlash(page, composer, "/goal-pro history", /没有已完成、阻塞或达到限额的目标历史/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/history");
  await runSlash(page, composer, "/goal-pro resume", /Goal Pro · active/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.status === "active" && request.params?.objective === undefined);
  await runSlash(page, composer, "/goal-pro clear", /\/goal-pro 已清除/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/clear");
  assert.equal(
    rpcRequests.filter(request => request.method === "turn/start").length,
    controlTurnCount,
    "goal lifecycle commands must never start provider turns",
  );

  const requestsBeforeInvalidBudget = rpcRequests.length;
  await runSlash(page, composer, "/goal-pro --budget 0 INVALID", /token budget must be a positive integer/);
  assert.equal(rpcRequests.length, requestsBeforeInvalidBudget, "invalid budget must stay entirely client-side");

  const answerObjective = `SLASH_MOBILE_ANSWER_${Date.now()}`;
  await composer.fill(`/goal-pro --budget 4096 --answer -- ${answerObjective}`);
  await page.getByTestId("send-message").click();
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.mode === "strict"
    && request.params?.verificationKind === "answer"
    && request.params?.tokenBudget === 4096
    && request.params?.objective === answerObjective);
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  const answerTurnRequest = rpcRequests.find(request => request.method === "turn/start"
    && request.params?.input?.some?.(item => item?.type === "text" && item?.text === answerObjective));
  assert.ok(answerTurnRequest, "Goal Pro flags must not leak into the provider turn text");

  const replacementObjective = `SLASH_MOBILE_REPLACEMENT_${Date.now()}`;
  await composer.fill(`/goal ${replacementObjective}`);
  const goalSetsBeforeReplacement = rpcRequests.filter(request => request.method === "thread/goal/set").length;
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByTestId("send-message").click();
  await page.waitForTimeout(150);
  assert.equal(
    rpcRequests.filter(request => request.method === "thread/goal/set").length,
    goalSetsBeforeReplacement,
    "cancelling replacement must not mutate the current goal",
  );
  assert.equal(await composer.inputValue(), `/goal ${replacementObjective}`);
  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId("send-message").click();
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.mode === "standard"
    && typeof request.params?.expectedGoalId === "string"
    && typeof request.params?.expectedRevision === "number"
    && request.params?.objective === replacementObjective);
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });

  await runSlash(page, composer, "/goal clear", /\/goal 已清除/);
  const turnsBeforeRetiredCommand = rpcRequests.filter(request => request.method === "turn/start").length;
  await composer.fill("/ultgoal retired mode");
  await page.getByTestId("send-message").click();
  await page.getByText("未知 slash 指令：/ultgoal", { exact: true }).waitFor({ state: "visible" });
  assert.equal(rpcRequests.filter(request => request.method === "turn/start").length, turnsBeforeRetiredCommand);

  const renameRequest = rpcRequests.find(request => request.method === "thread/metadata/update" && request.params?.title === renamed);
  const compactRequest = rpcRequests.find(request => request.method === "thread/compact");
  const strictGoalRequest = rpcRequests.find(request => request.method === "thread/goal/set"
    && request.params?.mode === "strict"
    && request.params?.objective === strictObjective);
  const answerGoalRequest = rpcRequests.find(request => request.method === "thread/goal/set"
    && request.params?.verificationKind === "answer"
    && request.params?.objective === answerObjective);
  await page.screenshot({ path: context.pathInArtifacts("mobile-slash-commands.png"), fullPage: true });
  await context.writeArtifactJson("mobile-real-slash-commands.json", {
    visibleCommands,
    renamed,
    renameReachedAppServer: Boolean(renameRequest),
    compactReachedAppServer: Boolean(compactRequest),
    strictGoalReachedAppServer: Boolean(strictGoalRequest),
    lifecycleCommandsDidNotStartTurns: true,
    answerGoalReachedAppServer: Boolean(answerGoalRequest),
    answerFlagsExcludedFromTurn: Boolean(answerTurnRequest),
    replacementRequiresConfirmation: true,
    retiredCommandDoesNotStartTurn: true,
    slashSafety: { bareSlashBlocked: true, unknownBlocked: true },
    diagnostics,
  });
  assert.ok(renameRequest, "rename slash command must reach thread/metadata/update");
  assert.ok(compactRequest, "compact slash command must reach thread/compact");
  assert.ok(strictGoalRequest, "goal-pro slash command must set a strict goal through app-server");
  assert.ok(answerGoalRequest, "goal-pro --answer must preserve verificationKind and tokenBudget");
  assert.deepEqual(diagnostics, []);
  return {
    supportedTuiSubsetMenu: true,
    argumentPrefill: true,
    realRename: true,
    realCompact: true,
    realStrictGoal: true,
    realGoalLifecycle: true,
    realAnswerGoal: true,
    replacementConfirmation: true,
    realUltgoalLifecycle: true,
    modelPickerOpened: true,
  };
});

async function runSlash(page, composer, command, visibleNotice) {
  await composer.fill(command);
  await page.getByTestId("send-message").click();
  await page.getByText(visibleNotice).waitFor({ state: "visible", timeout: 30_000 });
}

function provider(endpoint) {
  return {
    api_format: "openai_chat_completions", endpoint, default_model: "mobile-slash-e2e-model",
    context_window_tokens: 128000, output_headroom_tokens: 8192,
    max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true, extra_body: {},
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

async function waitForRpcRequest(page, requests, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (requests.some(predicate)) return;
    await page.waitForTimeout(100);
  }
  assert.fail("timed out waiting for expected app-server request");
}
