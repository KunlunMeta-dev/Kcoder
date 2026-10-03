import assert from "node:assert/strict";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "temporary-chat-real-fork-full-provider-history-owner-lifecycle",
  tier: "full-integration",
  modelPolicy: "model-independent provider request contents and UI lifecycle; deterministic local provider, not answer quality",
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "temporary-fork" });
  const model = await startApprovalModelFixture(context, {
    textOnly: true, textOnlyResponse: "FIXTURE_REPLY_COMPLETE",
    delayedRequestNumbers: [3], streamDelayMs: 10000,
  });
  const syntheticKey = "temporary-fixture-key";
  context.registerSecret(syntheticKey);
  await context.writeStateJson("config/settings.json", {
    active_provider: "temporary-fixture",
    providers: { "temporary-fixture": {
      api_format: "openai_chat_completions", endpoint: model.baseUrl,
      default_model: "temporary-fixture-model", context_window_tokens: 128000,
      max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true,
    } },
  });
  await context.writeStateJson("config/credentials.json", {
    "temporary-fixture": { type: "api", key: syntheticKey },
  });
  const gateway = await startGateway(context, {
    label: "temporary-fork-gateway", workspace, auth: true,
    env: { KCODER_CONFIG_DIR: context.pathInState("config") },
  });
  const browser = await startChromium(context, { label: "temporary-fork-chromium" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const forks = [];
  const disposals = [];
  page.on("websocket", socket => {
    socket.on("framereceived", ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message.result?.ephemeral === true && message.result?.thread?.id) forks.push(message.result.thread.id);
        if (message.result?.disposed === true) disposals.push(message.result.threadId);
      } catch { /* Ignore non-JSON frames. */ }
    });
  });
  const sourcePrompt = `SOURCE_HISTORY_HEAD ${"long-source-context ".repeat(4000)} SOURCE_HISTORY_TAIL`;
  const sidePrompt = "TEMPORARY_PRIVATE_QUESTION";
  try {
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith("/login")),
      page.locator('button[type="submit"]').click(),
    ]);
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30000 });
    await page.getByTestId("model-selector-button").click();
    await waitFor(() => page.getByTestId("model-reset-default-button").isEnabled(),
      10000, "configured runtime default reset is available without GPT models");
    await page.getByTestId("model-reset-default-button").click();
    await page.getByTestId("model-selector-button").click();
    await send(page, sourcePrompt);
    await page.getByTestId("message-assistant").filter({ hasText: "FIXTURE_REPLY_COMPLETE" })
      .waitFor({ state: "visible", timeout: 30000 });
    const sourceTaskId = await waitFor(() => {
      const id = new URL(page.url()).searchParams.get("taskId");
      return id?.startsWith("kcoder:") ? id : null;
    }, 30000, "canonical source task address");
    const sourceAddress = { deviceId: "local", taskId: sourceTaskId, workspacePath: workspace };
    await waitFor(async () => (await invoke(page, "runtime.tasks.transcript", sourceAddress)).running === false,
      30000, "completed source turn");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("message-assistant").filter({ hasText: "FIXTURE_REPLY_COMPLETE" })
      .waitFor({ state: "visible", timeout: 30000 });
    const visibleTranscript = await invoke(page, "runtime.tasks.transcript", sourceAddress);
    assert.ok(model.requests.some(request => request.messages.some(message =>
      message.role === "user" && containsPrompt(message, sourcePrompt))),
      "the source provider request must contain the complete test history");

    await page.getByTestId("toggle-right-workspace-panel-button").click();
    await page.getByTestId("right-workspace-chat-option").click();
    const panel = page.getByTestId("right-workspace-chat-panel");
    await panel.getByTestId("model-selector-button").click();
    await waitFor(() => page.getByTestId("model-reset-default-button").isEnabled(),
      10000, "temporary chat uses the same configured reset default");
    await page.getByTestId("model-reset-default-button").click();
    await panel.getByTestId("model-selector-button").click();
    await send(panel, sidePrompt);
    await waitFor(() => forks.length === 1, 30000, "real ephemeral thread/fork response");
    await waitFor(() => model.requests.some(request => JSON.stringify(request.messages).includes(sidePrompt)),
      30000, "temporary provider request");
    const request = model.requests.find(request => JSON.stringify(request.messages).includes(sidePrompt));
    assert.ok(request.messages.some(message => message.role === "user" && containsPrompt(message, sourcePrompt)),
      "the provider must receive original full source history, not the clipped visible transcript");
    await panel.getByTestId("message-assistant").filter({ hasText: "FIXTURE_REPLY_COMPLETE" }).last()
      .waitFor({ state: "visible", timeout: 30000 });
    const child = forks[0];
    const listed = await invoke(page, "runtime.tasks.list", {});
    assert.equal(JSON.stringify(listed).includes(child), false);
    const sourceAfter = await invoke(page, "runtime.tasks.transcript", sourceAddress);
    assert.equal(JSON.stringify(sourceAfter.messages).includes(sidePrompt), false);
    await send(panel, "TEMPORARY_RUNNING_CLOSE");
    await panel.getByTestId("message-assistant").filter({ hasText: "ACTIVE_STREAM_PARTIAL" })
      .waitFor({ state: "visible", timeout: 30000 });
    const tab = page.locator('[data-testid^="right-workspace-chat-tab-"][role="tab"]');
    const testId = await tab.getAttribute("data-testid");
    await tab.hover();
    await page.getByTestId(`${testId}-close-button`).click();
    await waitFor(() => disposals.includes(child), 30000, "closing the panel disposes its ephemeral thread");
    const afterClose = await invoke(page, "runtime.tasks.list", {});
    assert.equal(JSON.stringify(afterClose).includes(child), false);
    assert.ok(JSON.stringify(afterClose).includes(sourceTaskId));
    await page.screenshot({ path: context.pathInArtifacts("temporary-chat-closed-source-preserved.png") });
    return {
      fullProviderHistoryInheritedBeyondUiLimit: true,
      sourceContextUnchanged: true,
      temporaryAbsentFromTaskList: true,
      closeDisposedBackendThread: true,
      closedDuringActiveStream: true,
      sourceCharacters: sourcePrompt.length,
      sourceVisibleHistoryWasClipped: visibleTranscript.messages.some(message => message.contentTruncated === true),
      screenshotsReason: "critical source conversation survives temporary thread disposal",
    };
  } catch (error) {
    await context.writeArtifactJson("failure.json", { error: String(error), forks, disposals,
      requestSummary: model.requests.map(request => request.messages.map(message => ({ role: message.role, length: messageText(message).length, head: messageText(message).slice(0, 160), tail: messageText(message).slice(-160) }))),
      body: (await page.locator("body").innerText().catch(() => "")).slice(-12000) });
    await page.screenshot({ path: context.pathInArtifacts("failure.png"), mask: [page.locator('input[name="token"]')] }).catch(() => undefined);
    throw error;
  }
});

async function send(scope, message) {
  const input = scope.getByTestId("chat-message-input");
  await input.waitFor({ state: "visible", timeout: 30000 });
  await input.fill(message);
  await scope.getByTestId("send-message-button").click();
}

function messageText(message) {
  return typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.map(part => part.text ?? "").join("\n") : "";
}

function containsPrompt(message, prompt) {
  const text = messageText(message);
  return text.includes(prompt) || text.includes(JSON.stringify(prompt).slice(1, -1));
}

async function invoke(page, method, params) {
  return page.evaluate(({ method, params }) => window.__TAURI_INTERNALS__.invoke("local_executor_request", { method, params }), { method, params });
}
