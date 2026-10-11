import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const PROMPT = "RETRY_SELECTION_ACTIONS_E2E";
const REPLY = "SELECT_ACTION_E2E_TEXT";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "runtime-target-real-retry-and-selection-actions",
    tier: "full-integration",
    modelPolicy:
      "model-independent deterministic provider with a real Gateway, app-server, and browser",
    retainSuccessLogs: true,
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "runtime-retry-selection-actions",
    });
    const configDir = context.pathInState("kcoder-config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("kcoder-config/settings.json", {});
    await context.writeStateJson("kcoder-config/credentials.json", {
      "retry-selection-e2e": {
        type: "api",
        key: "deterministic-local-fixture",
      },
    });
    const model = await startApprovalModelFixture(context, {
      httpErrorPrompt: PROMPT,
      // The engine performs the initial request and three transport retries within one user turn, producing an actionable failed turn only after all attempts fail.
      httpErrorMatchLimit: 4,
      httpErrorStatus: 503,
      httpErrorMessage: "temporary deterministic retry outage",
      textOnly: true,
      textOnlyResponse: REPLY,
    });
    const settingsFile = await context.writeStateJson("kcoder-settings.json", {
      active_provider: "retry-selection-e2e",
      max_retries: 3,
      retry_base_delay_ms: 1,
      providers: {
        "retry-selection-e2e": {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          default_model: "retry-selection-e2e-model",
          context_window_tokens: 128_000,
          output_headroom_tokens: 8_192,
          max_output_tokens: 8_192,
          request_timeout_secs: 30,
          no_proxy: true,
          extra_body: {},
        },
      },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Retry Selection E2E",
        runtime: "kcoder",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      workspace,
      serversFile,
      auth: true,
      env: { KCODER_CONFIG_DIR: configDir },
    });
    const chromium = await startChromium(context, {
      label: "retry-selection-chromium",
    });
    const page = await chromium.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const diagnostics = [];
    page.on("pageerror", (error) =>
      diagnostics.push(`pageerror: ${error.stack || error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        diagnostics.push(`console: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      diagnostics.push(
        `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
      );
    });

    await login(page, gateway.baseUrl, gateway.authToken);
    const project = page
      .getByTestId("project-item")
      .filter({ hasText: "Retry Selection E2E" })
      .first();
    await project.waitFor({ state: "visible", timeout: 60_000 });
    await project.hover();
    await project.getByTestId("project-new-conversation-button").click();
    await sendPrompt(page, PROMPT);

    const errorCard = page.getByTestId("assistant-error-card").last();
    await errorCard.waitFor({ state: "visible", timeout: 60_000 });
    assert.match(await errorCard.innerText(), /重试|retry/i);
    assert.equal(matchingProviderRequests(model.requests).length, 4);
    await capture(page, context, "provider-failure-retry-card.png");

    const taskId = new URL(page.url()).searchParams.get("taskId") ?? "";
    assert.ok(
      taskId.startsWith("kcoder:local:"),
      `unexpected task id ${taskId}`,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const restoredErrorCard = page.getByTestId("assistant-error-card").last();
    await restoredErrorCard.waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(
      matchingProviderRequests(model.requests).length,
      4,
      "restoring the failed transcript unexpectedly contacted the provider",
    );

    await restoredErrorCard.getByTestId("assistant-error-retry").click();
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: REPLY })
      .last()
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="assistant-error-card"]')
          .length === 0,
      undefined,
      { timeout: 30_000 },
    );
    assert.equal(
      matchingProviderRequests(model.requests).length,
      5,
      "retry did not issue exactly one additional provider request for the failed prompt",
    );
    assert.equal(model.requests.at(-1).messages.filter(message => message.role === 'user'
      && JSON.stringify(message.content).includes(PROMPT)).length, 1,
    'continuation must not append the original user request a second time');

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByTestId("message-assistant")
      .filter({ hasText: REPLY })
      .last()
      .waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(
      await page.getByTestId("assistant-error-card").count(),
      0,
      "the failed assistant card returned after the successful retry was restored",
    );
    assert.equal(
      matchingProviderRequests(model.requests).length,
      5,
      "restoring the recovered transcript unexpectedly contacted the provider",
    );

    await selectAssistantText(page, REPLY);
    await page
      .getByTestId("message-selection-actions")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("add-selection-to-conversation-button").click();
    const mainComposer = page.locator(
      '[data-testid="desktop-floating-composer-card"] [data-testid="chat-message-input"]',
    );
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector(
            '[data-testid="desktop-floating-composer-card"] [data-testid="chat-message-input"]',
          )
          ?.textContent?.includes(expected),
      REPLY,
      { timeout: 10_000 },
    );
    assert.match((await mainComposer.textContent()) ?? "", new RegExp(REPLY));

    await mainComposer.fill("");
    await selectAssistantText(page, REPLY);
    await page
      .getByTestId("message-selection-actions")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("ask-selection-in-sidebar-button").click();
    const sidePanel = page.getByTestId("right-workspace-chat-panel");
    await sidePanel.waitFor({ state: "visible", timeout: 10_000 });
    const sideComposer = sidePanel.getByTestId("chat-message-input");
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector(
            '[data-testid="right-workspace-chat-panel"] [data-testid="chat-message-input"]',
          )
          ?.textContent?.includes(expected),
      REPLY,
      { timeout: 10_000 },
    );
    assert.equal(((await sideComposer.textContent()) ?? "").trim(), REPLY);
    await capture(page, context, "selection-main-and-sidebar-actions.png");

    assert.deepEqual(diagnostics, []);
    await context.writeArtifactJson("retry-selection-actions.json", {
      providerFailureRendered: true,
      failedTranscriptRestored: true,
      retryProviderRequestCount: matchingProviderRequests(model.requests)
        .length,
      recoveredTranscriptRestored: true,
      mainComposerInsertion: true,
      sideChatOpenedWithSelection: true,
      diagnostics,
    });
    return {
      providerFailureRendered: true,
      failedTranscriptRestored: true,
      retryRecovered: true,
      recoveredTranscriptRestored: true,
      mainComposerInsertion: true,
      sideChatOpenedWithSelection: true,
    };
  },
);

function matchingProviderRequests(requests) {
  return requests.filter((request) =>
    JSON.stringify(request.messages ?? []).includes(PROMPT),
  );
}

async function login(page, baseUrl, token) {
  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 20_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page
    .getByTestId("desktop-sidebar")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function sendPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input").first();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.keyboard.insertText(prompt);
  await page.waitForFunction(
    () => {
      const button = document.querySelector(
        '[data-testid="send-message-button"]',
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.getByTestId("send-message-button").first().click();
}

async function selectAssistantText(page, text) {
  await page.evaluate((expectedText) => {
    const assistant = [
      ...document.querySelectorAll('[data-testid="message-assistant"]'),
    ].findLast((node) => node.textContent?.includes(expectedText));
    if (!assistant)
      throw new Error(`assistant message not found: ${expectedText}`);
    const walker = document.createTreeWalker(assistant, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent?.indexOf(expectedText) ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + expectedText.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      assistant.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    throw new Error(`assistant text node not found: ${expectedText}`);
  }, text);
}

async function capture(page, context, filename) {
  const path = context.pathInCase(
    "system-chromium",
    "retry-selection-actions",
    filename,
  );
  await mkdir(resolve(path, ".."), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
