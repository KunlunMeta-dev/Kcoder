import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { observeAuthReads } from "../../harness/auth-read-cost.mjs";
import { gatewayRequestCounts, observeGatewayRequests } from "../../harness/gateway-request-counts.mjs";
import { hashHistoryFile } from "../../harness/migration-large-history.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, requireExecutable, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const renderer = await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "runtime-target-queue-guidance-interrupt-send",
  tier: "full-integration",
  modelPolicy: "deterministic delayed local provider through one real KCoder app-server",
  retainSuccessLogs: true,
  budgets: { modelRequests: 3, wallClockMs: 120_000 },
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "Native queue app-server");
  const binarySha = await hashHistoryFile(binary);
  if (process.env.KCODER_E2E_KCODER_BIN_SHA256) assert.equal(binarySha, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const initial = "QUEUE_INITIAL_STREAM";
  const guidance = "QUEUE_GUIDANCE_A";
  const replacement = "QUEUE_INTERRUPT_B";
  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "runtime-target-queue-guidance",
  });
  const configDir = context.pathInState("kcoder-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("kcoder-config/settings.json", {});
  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    delayedRequestNumbers: [1, 2],
    streamDelayMs: 30_000,
  });
  const settingsFile = await context.writeStateJson("kcoder-settings.json", {
    active_provider: "kcoder-queue-e2e",
    max_retries: 0,
    credential_store: "file",
    session_memory: { enabled: false },
    integrations: { office: { enabled: false }, connectivity: { enabled: false }, services: { enabled: false } },
    providers: {
      "kcoder-queue-e2e": {
        api_format: "openai_chat_completions",
        authentication: { mode: "none" },
        discover_models: false,
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
    command: binary,
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    workspace,
    serversFile,
    auth: true,
    kcoderBin: binary,
    passEnv: ["KCODER_TARGET_DIR"],
    env: { KCODER_CONFIG_DIR: configDir, KCODER_HOME: configDir, KCODER_E2E_AUTH_OBSERVE: "1" },
  });
  const authCounts = observeAuthReads(context, gateway.child.stdout);
  const chromium = await startChromium(context, { label: "kcoder-queue-web-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1280, height: 800 } });
  const phases = [], operations = [];
  let observationError;
  let current, authStart, verified = false;
  const { validate: validateRequests } = await observeGatewayRequests(context, page, gateway.baseUrl, () => current);
  page.on("websocket", socket => {
    const pending = new Map();
    socket.on("framesent", ({ payload }) => {
      let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
      if (current && typeof frame.method === "string" && /^[A-Za-z0-9_./-]{1,128}$/.test(frame.method))
        current.rpc[frame.method] = (current.rpc[frame.method] || 0) + 1;
      if (!["turn/start", "turn/steer", "turn/interrupt"].includes(frame.method)) return;
      if (operations.length >= 16) { observationError ??= new Error("Queue operation observation exceeded its bound"); return; }
      const params = frame.params ?? {};
      const texts = [params.text, ...(Array.isArray(params.input) ? params.input.map(item => item.text) : [])];
      const operation = { method: frame.method, clientMessageIdPresent: typeof params.clientMessageId === "string",
        marker: [initial, guidance, replacement].find(marker => texts.some(text => typeof text === "string" && text.includes(marker))) ?? null };
      operations.push(operation); pending.set(frame.id, operation);
    });
    socket.on("framereceived", ({ payload }) => {
      let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
      const operation = pending.get(frame.id); if (!operation) return;
      pending.delete(frame.id);
      operation.reply = { ok: !Object.hasOwn(frame, "error") && Object.hasOwn(frame, "result"),
        queued: frame.result?.status === "queued", interrupted: frame.result?.interrupted === true };
    });
  });
  const phase = name => {
    if (current) {
      const end = authCounts();
      current.auth = Object.fromEntries(Object.keys(end).map(key => [key, end[key] - authStart[key]]));
    }
    current = name ? { name, ...gatewayRequestCounts(), rpc: {} } : undefined;
    if (current) { phases.push(current); authStart = authCounts(); }
  };
  const diagnostics = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });

  try {
    await login(page, gateway.baseUrl, gateway.authToken);
    phase("create-and-stream");
    const project = page.getByTestId("project-item").filter({ hasText: "KCoder Queue E2E" }).first();
    await project.waitFor({ state: "visible", timeout: 60_000 });
    await project.hover();
    await project.getByTestId("project-new-conversation-button").click();
    await sendComposer(page, initial);
    await waitForModelRequests(page, model, 1);
    await page.getByTestId("message-assistant").filter({ hasText: "ACTIVE_STREAM_PARTIAL" }).waitFor({ state: "visible", timeout: 60_000 });

    const runtimeSendCountBeforeQueue = operations.filter(operation => operation.method === "turn/start").length;
    phase("guidance");
    await sendComposer(page, guidance);
    const guidanceRow = page.locator('[data-testid^="conversation-queue-row-"]').filter({ hasText: guidance });
    await guidanceRow.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(operations.filter(operation => operation.method === "turn/start").length, runtimeSendCountBeforeQueue, "busy send must enqueue locally");
    await guidanceRow.locator('[data-testid^="queue-guidance-button-"]').click();
    await waitForCondition(page, () => operations.some(operation => operation.method === "turn/steer" && operation.marker === guidance && operation.reply?.queued));
    await waitForModelRequests(page, model, 2);
    await guidanceRow.waitFor({ state: "detached", timeout: 30_000 });
    await page.getByTestId("message-user").filter({ hasText: guidance }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-assistant").filter({ hasText: `ACTIVE_STREAM_PARTIAL: ${guidance}` }).waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await page.getByTestId("assistant-stopped-notice").count(), 0, "guidance handoff must not look like a user stop");
    assert.equal(operations.filter(operation => operation.method === "turn/start").length, runtimeSendCountBeforeQueue, "steering must continue the original turn");

    phase("interrupt-and-send");
    await sendComposer(page, replacement);
    const replacementRow = page.locator('[data-testid^="conversation-queue-row-"]').filter({ hasText: replacement });
    await replacementRow.waitFor({ state: "visible", timeout: 10_000 });
    await replacementRow.locator('[data-testid^="queue-interrupt-button-"]').click();
    await waitForCondition(page, () => operations.some(operation => operation.method === "turn/start" && operation.marker === replacement && operation.reply?.ok));
    await waitForModelRequests(page, model, 3);
    await replacementRow.waitFor({ state: "detached", timeout: 30_000 });
    await page.getByTestId("message-user").filter({ hasText: replacement }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-assistant").filter({ hasText: `deterministic renderer response: ${replacement}` }).waitFor({ state: "visible", timeout: 60_000 });

    const guidanceRequests = operations.filter(operation => operation.method === "turn/steer");
    const interruptRequests = operations.filter(operation => operation.method === "turn/interrupt");
    assert.equal(guidanceRequests.length, 1);
    assert.equal(guidanceRequests[0].reply.queued, true);
    assert.equal(guidanceRequests[0].clientMessageIdPresent, true);
    assert.equal(interruptRequests.length, 1);
    assert.equal(interruptRequests[0].reply.interrupted, true);
    assert.equal(operations.filter(operation => operation.method === "turn/start").length, 2);
    assert.ok(operations.every(operation => operation.reply?.ok), "every observed mutation must have its own successful reply");
    assert.equal(observationError, undefined);
    for (const sample of phases) assert.equal(sample.rpc["tools/catalog"] || 0, 0,
      `${sample.name}: a locally generated guidance marker must not request Native tool metadata`);
    const providerPrompts = model.requests.map(latestUserText);
    assert.equal(providerPrompts.length, 3);
    assert.ok(providerPrompts[0].includes(initial));
    assert.ok(providerPrompts[1].includes(guidance));
    assert.ok(providerPrompts[2].includes(replacement));
    await waitForCondition(page, () => model.requestOutcomes.slice(0, 2).every(outcome => outcome.closed));
    assert.equal(model.requestOutcomes[0].aborted, false, "steering preserves the original model request until its normal boundary");
    assert.equal(model.requestOutcomes[1].aborted, true, "immediate replacement interrupts its original request");
    assert.deepEqual(diagnostics, []);

    await page.screenshot({ path: context.pathInArtifacts("queue-guidance-interrupt.png"), fullPage: true });
    await context.writeArtifactJson("runtime-target-queue-guidance-interrupt.json", {
      providerPrompts,
      requestOutcomes: model.requestOutcomes,
      guidanceRequests,
      interruptRequests,
      diagnostics,
    });
    validateRequests();
    verified = true;
    return {
      localQueueDidNotSend: true,
      guidanceAppliedAndDequeued: true,
      interruptAndSendCompleted: true,
      providerRequestOrderVerified: true,
    };
  } finally {
    phase();
    await context.writeArtifactJson("queue-request-cost.json", { phases, operations, binarySha, renderer, verified,
      scope: "Owned authenticated browser/Gateway/Rust plus bounded loopback SSE; no paid model, installed-platform or public latency claim" });
  }
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

async function waitForCondition(page, condition) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > 60_000) throw new Error("等待 queue/guidance/interrupt 闭环超时");
    await page.waitForTimeout(100);
  }
}
