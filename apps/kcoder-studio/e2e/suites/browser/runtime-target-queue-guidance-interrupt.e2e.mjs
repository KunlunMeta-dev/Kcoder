import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "runtime-target-queue-guidance-interrupt-send",
  tier: "full-integration",
  modelPolicy: "deterministic delayed local provider through one real KCoder app-server",
  retainSuccessLogs: true,
}, async context => {
  const initial = "QUEUE_INITIAL_STREAM";
  const guidance = "QUEUE_GUIDANCE_A";
  const replacement = "QUEUE_INTERRUPT_B";
  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "runtime-target-queue-guidance",
  });
  const configDir = context.pathInState("kcoder-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("kcoder-config/settings.json", {});
  await context.writeStateJson("kcoder-config/credentials.json", {
    "kcoder-queue-e2e": { type: "api", key: "deterministic-local" },
  });
  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    delayedRequestNumbers: [1, 2],
    streamDelayMs: 30_000,
  });
  const settingsFile = await context.writeStateJson("kcoder-settings.json", {
    active_provider: "kcoder-queue-e2e",
    providers: {
      "kcoder-queue-e2e": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "kcoder-queue-e2e-model",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 8_192,
        request_timeout_secs: 35,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "KCoder Queue E2E",
    runtime: "kcoder",
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    workspace,
    serversFile,
    auth: true,
    env: { KCODER_CONFIG_DIR: configDir },
  });
  const chromium = await startChromium(context, { label: "kcoder-queue-web-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1280, height: 800 } });
  const diagnostics = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });

  await login(page, gateway.baseUrl, gateway.authToken);
  await instrumentRuntimeRequests(page);
  const project = page.getByTestId("project-item").filter({ hasText: "KCoder Queue E2E" }).first();
  await project.waitFor({ state: "visible", timeout: 60_000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
  await sendComposer(page, initial);
  await waitForModelRequests(page, model, 1);
  await page.getByTestId("message-assistant").filter({ hasText: "ACTIVE_STREAM_PARTIAL" }).waitFor({ state: "visible", timeout: 60_000 });

  const runtimeSendCountBeforeQueue = await countRuntimeRequests(page, "runtime.tasks.send");
  await sendComposer(page, guidance);
  const guidanceRow = page.locator('[data-testid^="conversation-queue-row-"]').filter({ hasText: guidance });
  await guidanceRow.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await countRuntimeRequests(page, "runtime.tasks.send"), runtimeSendCountBeforeQueue, "busy send must enqueue locally");
  await guidanceRow.locator('[data-testid^="queue-guidance-button-"]').click();
  await waitForRuntimeRequest(page, "runtime.tasks.guidance", request =>
    request.params?.message === guidance && typeof request.params?.clientGuidanceId === "string"
  );
  await waitForModelRequests(page, model, 2);
  await guidanceRow.waitFor({ state: "detached", timeout: 30_000 });
  await page.getByTestId("message-user").filter({ hasText: guidance }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-assistant").filter({ hasText: `ACTIVE_STREAM_PARTIAL: ${guidance}` }).waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(await page.getByTestId("assistant-stopped-notice").count(), 0, "guidance handoff must not look like a user stop");

  await sendComposer(page, replacement);
  const replacementRow = page.locator('[data-testid^="conversation-queue-row-"]').filter({ hasText: replacement });
  await replacementRow.waitFor({ state: "visible", timeout: 10_000 });
  await replacementRow.locator('[data-testid^="queue-interrupt-button-"]').click();
  await waitForRuntimeRequest(page, "runtime.tasks.interrupt_and_send", request =>
    request.params?.executionRequest?.prompt === replacement
  );
  await waitForModelRequests(page, model, 3);
  await replacementRow.waitFor({ state: "detached", timeout: 30_000 });
  await page.getByTestId("message-user").filter({ hasText: replacement }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-assistant").filter({ hasText: `deterministic renderer response: ${replacement}` }).waitFor({ state: "visible", timeout: 60_000 });

  const guidanceRequests = await runtimeRequests(page, "runtime.tasks.guidance");
  const interruptRequests = await runtimeRequests(page, "runtime.tasks.interrupt_and_send");
  assert.equal(guidanceRequests.length, 1);
  assert.equal(interruptRequests.length, 1);
  const providerPrompts = model.requests.map(latestUserText);
  assert.equal(providerPrompts.length, 3);
  assert.ok(providerPrompts[0].includes(initial));
  assert.ok(providerPrompts[1].includes(guidance));
  assert.ok(providerPrompts[2].includes(replacement));
  await waitForCondition(page, () => model.requestOutcomes.slice(0, 2).every(outcome => outcome.aborted));
  assert.deepEqual(diagnostics, []);

  await page.screenshot({ path: context.pathInArtifacts("queue-guidance-interrupt.png"), fullPage: true });
  await context.writeArtifactJson("runtime-target-queue-guidance-interrupt.json", {
    providerPrompts,
    requestOutcomes: model.requestOutcomes,
    guidanceRequests,
    interruptRequests,
    diagnostics,
  });
  return {
    localQueueDidNotSend: true,
    guidanceAppliedAndDequeued: true,
    interruptAndSendCompleted: true,
    providerRequestOrderVerified: true,
  };
});

async function login(page, baseUrl, token) {
  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([
    page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 20_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 60_000 });
}

async function instrumentRuntimeRequests(page) {
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") throw new Error("KCoder gateway invoke shim is unavailable");
    const originalInvoke = internals.invoke;
    window.__queueRpcResults = [];
    internals.invoke = async function(command, args) {
      try {
        const result = await originalInvoke.call(this, command, args);
        if (command === "local_executor_request") window.__queueRpcResults.push({ request: args, result });
        return result;
      } catch (error) {
        if (command === "local_executor_request") window.__queueRpcResults.push({ request: args, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
  });
}

async function sendComposer(page, text) {
  const composer = page.getByTestId("chat-message-input");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.keyboard.insertText(text);
  await page.getByTestId("send-message-button").click();
}

function latestUserText(request) {
  const user = [...(request.messages ?? [])].reverse().find(message => message?.role === "user");
  return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
}

async function waitForModelRequests(page, model, count) {
  await waitForCondition(page, () => model.requests.length >= count);
}

async function waitForRuntimeRequest(page, method, predicate) {
  await page.waitForFunction(({ requestMethod }) => window.__queueRpcResults?.some(entry =>
    entry?.request?.method === requestMethod
  ), { requestMethod: method }, { timeout: 30_000 });
  await waitForCondition(page, async () => (await runtimeRequests(page, method)).some(entry => predicate(entry.request)));
}

async function runtimeRequests(page, method) {
  return page.evaluate(requestMethod =>
    window.__queueRpcResults?.filter(entry => entry?.request?.method === requestMethod) ?? [],
  method);
}

async function countRuntimeRequests(page, method) {
  return (await runtimeRequests(page, method)).length;
}

async function waitForCondition(page, condition) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > 60_000) throw new Error("等待 queue/guidance/interrupt 闭环超时");
    await page.waitForTimeout(100);
  }
}
