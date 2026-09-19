import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const KCODER_PROMPT = "[KCoder Web E2E] 请只回复标记 KCODER_WEB_UI_REPLY_E2E";
const KCODER_REPLY = "KCODER_WEB_UI_REPLY_E2E";
const KCODER_EDITED_PROMPT =
  "[KCoder Web E2E Edited] 请只回复标记 KCODER_WEB_UI_EDITED_REPLY_E2E";
const KCODER_EDITED_REPLY = "KCODER_WEB_UI_EDITED_REPLY_E2E";
const KCODER_RENAMED_TITLE = "KCoder Web 高级操作闭环";
const KCODER_WORKSPACE_IMAGE_PROMPT = "KCODER_WORKSPACE_MARKDOWN_IMAGE_E2E";
const KCODER_WORKSPACE_IMAGE_FILENAME = "workspace-markdown-image.png";
const KCODER_CHAT_PASTE_PROMPT = "KCODER_CHAT_PASTE_IMAGE_E2E";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "kcoder-real-app-server-web-conversation-history",
    tier: "pr-smoke",
    modelPolicy:
      "model-independent deterministic provider with a real KCoder app-server process",
    retainSuccessLogs: true,
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "kcoder-runtime-web-conversation",
    });
    const kcoderConfigDir = context.pathInState("kcoder-config");
    await mkdir(kcoderConfigDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("kcoder-config/settings.json", {});
    await context.writeStateJson("kcoder-config/credentials.json", {
      "kcoder-runtime-web-e2e": {
        type: "api",
        key: "deterministic-local-fixture",
      },
    });

    const kcoderModel = await startApprovalModelFixture(context, {
      textOnly: true,
      textOnlyResponse: ({ userText }) =>
        userText.includes(KCODER_WORKSPACE_IMAGE_PROMPT)
          ? `![workspace markdown image](${KCODER_WORKSPACE_IMAGE_FILENAME})`
          : `deterministic renderer response: ${userText}`,
    });
    const workspaceImageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const workspaceImagePath = resolve(
      workspace,
      "workspace-markdown-image.png",
    );
    await writeFile(workspaceImagePath, workspaceImageBytes);
    const kcoderSettings = await context.writeStateJson(
      "kcoder-settings.json",
      {
        active_provider: "kcoder-runtime-web-e2e",
        providers: {
          "kcoder-runtime-web-e2e": {
            api_format: "openai_chat_completions",
            endpoint: kcoderModel.baseUrl,
            default_model: "kcoder-runtime-web-e2e-model",
            context_window_tokens: 128_000,
            output_headroom_tokens: 8_192,
            max_output_tokens: 8_192,
            request_timeout_secs: 30,
            no_proxy: true,
            extra_body: {},
          },
        },
      },
    );
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "KCoder Web E2E",
        runtime: "kcoder",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace,
        settingsFile: kcoderSettings,
      },
    ]);
    const gateway = await startGateway(context, {
      workspace,
      serversFile,
      auth: true,
      env: { KCODER_CONFIG_DIR: kcoderConfigDir },
    });
    const chromium = await startChromium(context, {
      label: "kcoder-runtime-web-chromium",
    });
    const page = await chromium.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const browserErrors = [];
    const failedRequests = [];
    page.on("pageerror", (error) =>
      browserErrors.push(`pageerror: ${error.stack || error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        browserErrors.push(`console: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      failedRequests.push({
        url: request.url(),
        resourceType: request.resourceType(),
        errorText: request.failure()?.errorText ?? "unknown",
      });
    });

    try {
      await login(page, gateway.baseUrl, gateway.authToken);
    } catch (error) {
      await context.writeArtifactJson("login-readiness-failure.json", {
        url: page.url(),
        body: (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 12_000),
        html: (
          await page
            .locator("html")
            .innerHTML()
            .catch(() => "")
        ).slice(0, 20_000),
        browserErrors,
        failedRequests,
      });
      await capture(page, context, "login-readiness-failure.png");
      throw error;
    }
    await verifyRuntimeTargetSettings(page, context);
    const kcoder = await runConversation(page, context, {
      projectLabel: "KCoder Web E2E",
      taskPrefix: "kcoder:local:",
      prompt: KCODER_PROMPT,
      reply: KCODER_REPLY,
      screenshot: "kcoder-conversation.png",
    });
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    const row = page.getByTestId(`runtime-local-task-row-${kcoder.taskId}`);
    try {
      await row.waitFor({ state: "visible", timeout: 60_000 });
    } catch (error) {
      await context.writeArtifactJson(
        "restored-history-failure.json",
        await page.evaluate(
          (taskId) => ({
            url: location.href,
            body: document.body.innerText.slice(0, 12_000),
            taskRows: [
              ...document.querySelectorAll(
                '[data-testid^="runtime-local-task-row-"]',
              ),
            ].map((item) => ({
              testId: item.getAttribute("data-testid"),
              text: item.textContent,
            })),
            expectedTaskId: taskId,
          }),
          kcoder.taskId,
        ),
      );
      await context.writeArtifactJson("restored-history-network-failure.json", {
        browserErrors,
        failedRequests,
      });
      await capture(page, context, "restored-history-failure.png");
      throw error;
    }
    await row.evaluate((node) => node.click());
    await assertConversationVisible(page, kcoder.prompt, kcoder.reply, 30_000);
    await capture(page, context, "restored-history.png");

    const advancedActions = await verifyAdvancedConversationActions(
      page,
      context,
      {
        sourceTaskId: kcoder.taskId,
        originalPrompt: kcoder.prompt,
      },
    ).catch(async (error) => {
      await context.writeArtifactJson(
        "advanced-actions-state-failure.json",
        await page.evaluate(async () => ({
          body: document.body.innerText.slice(0, 12000),
          workspaces: await window.__TAURI_INTERNALS__
            ?.invoke("local_executor_request", {
              method: "runtime.tasks.list",
              params: {},
            })
            .catch((error) => ({ error: String(error) })),
        })),
      );
      await capture(page, context, "advanced-actions-state-failure.png");
      throw error;
    });
    await verifyWorkspaceMarkdownImage(
      page,
      context,
      workspaceImagePath,
      workspaceImageBytes,
    );
    const pluginManagement = await verifyPluginManagement(page, workspace);
    const chatPaste = await verifyChatPasteImage(page, context, kcoderModel, {
      browserErrors,
      failedRequests,
    });

    assert.ok(
      kcoderModel.requests.length >= 2,
      "KCoder provider did not receive the edited browser turn",
    );
    assert.deepEqual(
      browserErrors,
      [],
      `failed requests: ${JSON.stringify(failedRequests)}`,
    );
    return {
      targets: [
        {
          runtime: "kcoder",
          taskId: kcoder.taskId,
          restoredAfterReload: true,
          renamedAndPinnedAfterReload: true,
          editedLastTurn: true,
          forkedTaskId: advancedActions.forkedTaskId,
        },
      ],
      providerRequests: { kcoder: kcoderModel.requests.length },
      pluginManagement,
      chatPaste,
      browserErrors,
      failedRequests,
    };
  },
);

async function verifyPluginManagement(page, workspace) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/plugins/manage`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("kcoder-plugin-management").waitFor({ timeout: 30000 });
  await page.waitForFunction(expected =>
    document.querySelector('[data-testid="plugins-install-target"]')?.textContent?.includes(expected),
  workspace, { timeout: 30000 });
  assert.ok((await page.getByTestId("plugins-install-target").innerText()).includes(workspace),
    "Plugin management must retain the conversation workspace target");
  for (const tab of ["skills", "mcp", "hooks", "plugins"]) {
    const button = page.getByTestId(`kcoder-plugin-tab-${tab}`);
    await button.click();
    assert.equal(await button.getAttribute("aria-selected"), "true");
    if (tab === "skills") await page.getByTestId("kcoder-skill-import").waitFor();
    if (tab === "mcp") {
      await page.getByTestId("kcoder-mcp-management").getByRole("button", { name: /添加 MCP|Add MCP/ }).click();
      await page.getByTestId("kcoder-mcp-install-form").waitFor();
    }
  }
  return { retainedWorkspace: true, tabs: ["plugins", "skills", "mcp", "hooks"] };
}

async function waitForProviderRequestCount(model, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (model.requests.length >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`provider request count did not reach ${expectedCount}`);
}

async function verifyChatPasteImage(page, context, model, diagnostics) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-message-input");
  try {
    await composer.waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    // Collect only after the original timeout, without changing reload timing.
    const snapshot = await page
      .evaluate(() => {
        const inspect = (selector) =>
          [...document.querySelectorAll(selector)].map((node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              testId: node.getAttribute("data-testid"),
              hidden: node.hidden,
              display: style.display,
              visibility: style.visibility,
              width: rect.width,
              height: rect.height,
            };
          });
        const clone = document.body.cloneNode(true);
        clone
          .querySelectorAll("script, style, img, iframe")
          .forEach((node) => node.remove());
        clone
          .querySelectorAll("input, textarea, [contenteditable]")
          .forEach((node) => {
            node.removeAttribute("value");
            node.textContent = "[REDACTED INPUT]";
          });
        clone.querySelectorAll("*").forEach((node) => {
          for (const attribute of [...node.attributes]) {
            if (
              ![
                "data-testid",
                "role",
                "aria-hidden",
                "aria-busy",
                "class",
              ].includes(attribute.name)
            ) {
              node.removeAttribute(attribute.name);
            }
          }
        });
        return {
          url: `${location.origin}${location.pathname}`,
          readyState: document.readyState,
          body: clone.textContent.slice(0, 12000),
          html: clone.innerHTML.slice(0, 20000),
          composers: inspect('[data-testid="chat-message-input"]'),
          loading: inspect('[data-testid="desktop-workbench-loading"]'),
          taskRows: inspect('[data-testid^="runtime-local-task-row-"]'),
        };
      })
      .catch((failure) => ({ diagnosticError: String(failure) }));
    await context
      .writeArtifactJson("chat-paste-readiness-failure.json", {
        error: String(error),
        snapshot,
        browserErrors: diagnostics.browserErrors.slice(-100),
        failedRequests: diagnostics.failedRequests
          .slice(-100)
          .map((request) => {
            let url;
            try {
              const parsed = new URL(request.url);
              url = `${parsed.origin}${parsed.pathname}`;
            } catch {
              url = "[invalid URL]";
            }
            return { ...request, url };
          }),
      })
      .catch((failure) =>
        console.warn(
          context.redactText(`Readiness diagnostic failed: ${failure}`),
        ),
      );
    await capture(page, context, "chat-paste-readiness-failure.png", {
      mask: [page.locator("input, textarea, [contenteditable]")],
    }).catch((failure) =>
      console.warn(
        context.redactText(`Readiness screenshot failed: ${failure}`),
      ),
    );
    throw error;
  }
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.evaluate(
    async (bytes) => {
      const blob = new Blob([Uint8Array.from(bytes)], { type: "image/png" });
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
    },
    [...imageBytes],
  );
  await composer.click();
  await page.keyboard.press("Control+V");
  await page
    .getByTestId("attachment-badge")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("attachment-image-preview")
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(
    await page.getByTestId("attachment-error-badge").count(),
    0,
    "普通聊天框直接粘贴图片上传失败",
  );

  const beforeRequests = model.requests.length;
  await page.keyboard.insertText(KCODER_CHAT_PASTE_PROMPT);
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
  await page.getByTestId("send-message-button").click();
  const userMessage = page
    .getByTestId("message-user")
    .filter({ hasText: KCODER_CHAT_PASTE_PROMPT })
    .last();
  await userMessage.waitFor({ state: "visible", timeout: 60_000 });
  await userMessage
    .getByTestId("message-image-preview")
    .waitFor({ state: "visible", timeout: 30_000 });
  await waitForProviderRequestCount(model, beforeRequests + 1, 60_000);
  const providerRequest = model.requests.slice(beforeRequests).at(-1);
  const serialized = JSON.stringify(providerRequest ?? {});
  const containsAttachmentEnvelope = serialized.includes(
    "kcoder_attachments version",
  );
  const containsImageMime = serialized.includes("image/png");
  await context.writeArtifactJson("chat-paste-image-transport.json", {
    entryPoint: "normal-chat-composer -> clipboard image paste",
    browserAction: "navigator.clipboard.write + Chromium Control+V",
    uploadPreviewVisible: true,
    sentMessagePreviewVisible: true,
    providerRequestCount: model.requests.length,
    containsAttachmentEnvelope,
    containsImageMime,
  });
  assert.equal(
    containsAttachmentEnvelope,
    true,
    "普通聊天框粘贴图片未进入 Provider attachment envelope",
  );
  assert.equal(
    containsImageMime,
    true,
    "普通聊天框粘贴图片 Provider 请求缺少 image/png",
  );
  return {
    entryPoint: "chat-clipboard-paste",
    uploadPreviewVisible: true,
    sentMessagePreviewVisible: true,
    providerRequestContainsAttachment: true,
  };
}

async function verifyAdvancedConversationActions(page, context, options) {
  const sourceRow = page.getByTestId(
    `runtime-local-task-row-${options.sourceTaskId}`,
  );

  await sourceRow.dblclick();
  const renameInput = page.getByTestId(
    `rename-runtime-local-task-input-${options.sourceTaskId}`,
  );
  await renameInput.waitFor({ state: "visible", timeout: 10_000 });
  await renameInput.fill(KCODER_RENAMED_TITLE);
  await page
    .getByTestId(`confirm-rename-runtime-local-task-${options.sourceTaskId}`)
    .click();
  await sourceRow
    .filter({ hasText: KCODER_RENAMED_TITLE })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("workbench-pane-task-title")
    .filter({ hasText: KCODER_RENAMED_TITLE })
    .waitFor({ state: "visible", timeout: 30_000 });

  await sourceRow.hover();
  await page
    .getByTestId(`runtime-local-task-mark-${options.sourceTaskId}`)
    .click();
  await page.waitForFunction(
    (taskId) =>
      document
        .querySelector(
          `[data-testid="runtime-local-task-row-${CSS.escape(taskId)}"]`,
        )
        ?.getAttribute("data-marked") === "true",
    options.sourceTaskId,
    { timeout: 30_000 },
  );
  await capture(page, context, "advanced-actions-renamed-pinned.png");

  // The marker is optimistic; wait for the acknowledged mutation before reload.
  await page.waitForFunction(
    (taskId) => {
      const button = document.querySelector(
        `[data-testid="runtime-local-task-mark-${CSS.escape(taskId)}"]`,
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    options.sourceTaskId,
    { timeout: 30_000 },
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  const persistedSourceRow = page.getByTestId(
    `runtime-local-task-row-${options.sourceTaskId}`,
  );
  try {
    await persistedSourceRow
      .filter({ hasText: KCODER_RENAMED_TITLE })
      .waitFor({ state: "visible", timeout: 60_000 });
  } catch (error) {
    await context.writeArtifactJson(
      "advanced-actions-reload-failure.json",
      await page.evaluate(
        (taskId) => ({
          url: location.href,
          body: document.body.innerText.slice(0, 12_000),
          taskRows: [
            ...document.querySelectorAll(
              '[data-testid^="runtime-local-task-row-"]',
            ),
          ]
            .map((row) => ({
              testId: row.getAttribute("data-testid"),
              text: row.textContent,
            }))
            .filter((row) => row.testId?.includes(taskId)),
        }),
        options.sourceTaskId,
      ),
    );
    await capture(page, context, "advanced-actions-reload-failure.png");
    throw error;
  }
  // Restored task rows can precede their asynchronously loaded preferences.
  await page.waitForFunction(
    (taskId) =>
      document
        .querySelector(
          `[data-testid="runtime-local-task-row-${CSS.escape(taskId)}"]`,
        )
        ?.getAttribute("data-marked") === "true",
    options.sourceTaskId,
    { timeout: 30_000 },
  );
  assert.equal(await persistedSourceRow.getAttribute("data-marked"), "true");
  await persistedSourceRow.click();
  await assertConversationVisible(
    page,
    options.originalPrompt,
    KCODER_REPLY,
    30_000,
  );

  const editButton = page.getByTestId("edit-message-button");
  await page
    .getByTestId("message-user")
    .filter({ hasText: options.originalPrompt })
    .last()
    .hover();
  await editButton.waitFor({ state: "visible", timeout: 10_000 });
  await editButton.click();
  const editTextarea = page.getByTestId("edit-user-message-textarea");
  await editTextarea.fill(KCODER_EDITED_PROMPT);
  await page.getByTestId("submit-edit-user-message-button").click();
  await assertConversationVisible(
    page,
    KCODER_EDITED_PROMPT,
    KCODER_EDITED_REPLY,
    60_000,
  );
  await assertUserAttachmentsVisible(page, KCODER_EDITED_PROMPT, 30_000);
  assert.equal(
    await page
      .getByTestId("message-user")
      .filter({ hasText: options.originalPrompt })
      .count(),
    0,
    "editing the last user turn left the original prompt in the transcript",
  );
  await capture(page, context, "advanced-actions-edited-turn.png");

  const knownTaskIds = await runtimeTaskIds(page);
  const lastAssistant = page.getByTestId("message-assistant").last();
  await lastAssistant.hover();
  const forkButton = page.getByTestId("fork-message-button").last();
  await forkButton.waitFor({ state: "visible", timeout: 10_000 });
  await traceForkRequest(page);
  await forkButton.click();
  await page.waitForFunction(
    (sourceTaskId) => {
      const taskId = new URL(location.href).searchParams.get("taskId");
      return (
        Boolean(taskId && taskId !== sourceTaskId) ||
        Boolean(window.__kcoderForkTrace?.response)
      );
    },
    options.sourceTaskId,
    { timeout: 30_000 },
  );
  const forkTrace = await page.evaluate(() => window.__kcoderForkTrace ?? null);
  assert.equal(
    forkTrace?.response?.accepted,
    true,
    `fork request was rejected: ${JSON.stringify(forkTrace)}`,
  );
  const forkedTaskId = forkTrace?.response?.target?.taskId || "";
  assert.ok(
    forkedTaskId.startsWith("kcoder:local:"),
    `unexpected forked task id ${forkedTaskId}`,
  );
  assert.equal(
    knownTaskIds.has(forkedTaskId),
    false,
    `fork reused an existing task: ${JSON.stringify({ forkedTaskId, knownTaskIds: [...knownTaskIds], forkTrace })}`,
  );
  await page.waitForFunction(
    (expectedTaskId) =>
      new URL(location.href).searchParams.get("taskId") === expectedTaskId,
    forkedTaskId,
    { timeout: 60_000 },
  );
  await page
    .getByTestId(`runtime-local-task-row-${forkedTaskId}`)
    .waitFor({ state: "visible", timeout: 60_000 });
  await assertConversationVisible(
    page,
    KCODER_EDITED_PROMPT,
    KCODER_EDITED_REPLY,
    30_000,
  );
  await capture(page, context, "advanced-actions-forked-task.png");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByTestId(`runtime-local-task-row-${forkedTaskId}`)
    .waitFor({ state: "visible", timeout: 60_000 });
  await assertConversationVisible(
    page,
    KCODER_EDITED_PROMPT,
    KCODER_EDITED_REPLY,
    30_000,
  );
  const sourceAfterFork = page.getByTestId(
    `runtime-local-task-row-${options.sourceTaskId}`,
  );
  await sourceAfterFork
    .filter({ hasText: KCODER_RENAMED_TITLE })
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await sourceAfterFork.getAttribute("data-marked"), "true");
  await sourceAfterFork.click();
  await page.waitForFunction(
    (expectedTaskId) =>
      new URL(location.href).searchParams.get("taskId") === expectedTaskId,
    options.sourceTaskId,
    { timeout: 30_000 },
  );
  await assertConversationVisible(
    page,
    KCODER_EDITED_PROMPT,
    KCODER_EDITED_REPLY,
    30_000,
  );
  const forkAfterSourceRestore = page.getByTestId(
    `runtime-local-task-row-${forkedTaskId}`,
  );
  await forkAfterSourceRestore.waitFor({ state: "visible", timeout: 30_000 });
  await forkAfterSourceRestore.click();
  await page.waitForFunction(
    (expectedTaskId) =>
      new URL(location.href).searchParams.get("taskId") === expectedTaskId,
    forkedTaskId,
    { timeout: 30_000 },
  );
  await assertConversationVisible(
    page,
    KCODER_EDITED_PROMPT,
    KCODER_EDITED_REPLY,
    30_000,
  );
  await capture(
    page,
    context,
    "advanced-actions-source-and-fork-independent.png",
  );

  return { forkedTaskId };
}

async function runtimeTaskIds(page) {
  return new Set(
    await page
      .locator('[data-testid^="runtime-local-task-row-"]')
      .evaluateAll((rows) =>
        rows
          .map((row) =>
            row
              .getAttribute("data-testid")
              ?.slice("runtime-local-task-row-".length),
          )
          .filter(Boolean),
      ),
  );
}

async function traceForkRequest(page) {
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      throw new Error("KCoder Gateway invoke bridge is unavailable");
    }
    const originalInvoke = internals.invoke.bind(internals);
    window.__kcoderForkTrace = null;
    internals.invoke = async (command, args) => {
      const isFork =
        command === "local_executor_request" &&
        args?.method === "runtime.tasks.fork_at_turn";
      try {
        const response = await originalInvoke(command, args);
        if (isFork)
          window.__kcoderForkTrace = { request: args?.params, response };
        return response;
      } catch (error) {
        if (isFork) {
          window.__kcoderForkTrace = {
            request: args?.params,
            response: { accepted: false, error: String(error) },
          };
        }
        throw error;
      }
    };
  });
}

async function verifyRuntimeTargetSettings(page, context) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/settings/general`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByTestId("general-settings-page")
    .waitFor({ state: "visible", timeout: 30_000 });
  for (const testId of [
    "general-show-main-window-on-launch-toggle",
    "general-system-drag-toggle",
    "general-tray-unread-toggle",
    "general-tray-running-toggle",
    "general-tray-usage-toggle",
  ]) {
    assert.equal(
      await page.getByTestId(testId).count(),
      0,
      `HTTP Gateway General 设置不应显示原生 Tauri 控件 ${testId}`,
    );
  }
  await page.goto(`${origin}/settings/kcoder-servers`, {
    waitUntil: "domcontentloaded",
  });
  try {
    await page
      .getByTestId("runtime-target-list")
      .waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    await context.writeArtifactJson(
      "runtime-target-settings-navigation-failure.json",
      {
        url: page.url(),
        gatewayMeta: await page
          .locator('meta[name="kcoder-rpc-token"]')
          .count(),
        body: (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 12_000),
      },
    );
    await capture(
      page,
      context,
      "runtime-target-settings-navigation-failure.png",
    );
    throw error;
  }
  await page.getByTestId("runtime-target-add").click();
  assert.equal(
    await page
      .getByTestId("runtime-target-label")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.getByTestId("runtime-target-label").fill("Browser E2E draft");
  await page.getByTestId("runtime-target-id").fill("browser-e2e-draft");
  await page.getByTestId("runtime-target-host").fill("100.64.0.99");
  assert.equal(await page.getByTestId("runtime-target-advanced").count(), 0);
  await page.getByTestId("runtime-target-advanced-toggle").press("Enter");
  await page
    .getByTestId("runtime-target-command")
    .fill("/usr/local/bin/kcoder");
  await page.getByTestId("runtime-target-advanced-toggle").click();
  assert.equal(await page.getByTestId("runtime-target-command").count(), 0);
  await scrollSettingsToTop(page);
  await capture(page, context, "runtime-target-settings-desktop.png");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  });
  await capture(page, context, "runtime-target-settings-dark.png");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";
  });
  await page.getByTestId("runtime-target-host").fill("");
  await page.getByTestId("runtime-target-save").click();
  await page
    .getByText("请输入 SSH 主机")
    .waitFor({ state: "visible", timeout: 10_000 });
  await capture(page, context, "runtime-target-settings-error.png");
  await page.getByTestId("runtime-target-host").fill("100.64.0.99");

  await page.setViewportSize({ width: 768, height: 900 });
  await scrollSettingsToTop(page);
  await capture(page, context, "runtime-target-settings-768.png");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const scaledSave = await page
    .getByTestId("runtime-target-save")
    .boundingBox();
  assert.ok(
    scaledSave && scaledSave.width > 0 && scaledSave.height > 0,
    "save action is not available at 200% text size",
  );
  await capture(page, context, "runtime-target-settings-200-percent-text.png");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByTestId("runtime-target-close").click();
  const discardDialog = page.getByTestId("runtime-target-discard-dialog");
  await discardDialog.waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("runtime-target-discard-dialog-confirm").click();
  await page
    .getByTestId("runtime-target-editor")
    .waitFor({ state: "detached", timeout: 10_000 });

  // 767 px is the Gateway Web mobile-layout boundary. Switch to MobileWorkbenchLayout instead of retaining the desktop connection editor.
  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto(new URL("/settings", page.url()).href, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByTestId("mobile-settings-page")
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByTestId("runtime-target-editor").count(), 0);
  await capture(page, context, "runtime-target-settings-767-mobile-layout.png");
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function scrollSettingsToTop(page) {
  await page
    .locator('[data-testid="studio-settings-page"] > main')
    .evaluate((node) => node.scrollTo({ top: 0, behavior: "instant" }));
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

async function runConversation(page, context, options) {
  await page.goto(contextUrl(page), { waitUntil: "domcontentloaded" });
  const project = page
    .getByTestId("project-item")
    .filter({ hasText: options.projectLabel })
    .first();
  try {
    await project.waitFor({ state: "visible", timeout: 60_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(async () => ({
      url: location.href,
      body: document.body.innerText.slice(0, 10_000),
      projects: [
        ...document.querySelectorAll('[data-testid="project-item"]'),
      ].map((node) => node.textContent?.trim()),
      servers: await fetch("/api/servers")
        .then((response) => response.json())
        .catch((fetchError) => ({
          error: String(fetchError),
        })),
    }));
    await context.writeArtifactJson(
      "kcoder-project-diagnostic.json",
      diagnostic,
    );
    await capture(page, context, "kcoder-project-failure.png");
    throw error;
  }
  await project.hover();
  const newConversation = project.getByTestId(
    "project-new-conversation-button",
  );
  await newConversation.waitFor({ state: "visible", timeout: 20_000 });
  await newConversation.click();
  await uploadConversationAttachments(page);
  await sendPrompt(page, options.prompt);
  await assertConversationVisible(page, options.prompt, options.reply, 60_000);
  await assertUserAttachmentsVisible(page, options.prompt, 30_000);
  const taskId = new URL(page.url()).searchParams.get("taskId") || "";
  assert.ok(
    taskId.startsWith(options.taskPrefix),
    `unexpected task id ${taskId}`,
  );
  await capture(page, context, options.screenshot);

  await page.reload({ waitUntil: "domcontentloaded" });
  await assertConversationVisible(page, options.prompt, options.reply, 60_000);
  await assertUserAttachmentsVisible(page, options.prompt, 30_000);
  return { taskId, prompt: options.prompt, reply: options.reply };
}

async function uploadConversationAttachments(page) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await page.getByTestId("attachment-file-input").setInputFiles([
    { name: "kcoder-e2e-image.png", mimeType: "image/png", buffer: png },
    {
      name: "kcoder-e2e-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("KCODER_ATTACHMENT_TEXT_E2E\n"),
    },
    {
      name: "kcoder-e2e-discard.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
    },
  ]);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="uploading-attachment-badge"]')
        .length === 0,
    undefined,
    { timeout: 30_000 },
  );
  assert.equal(
    await page.getByTestId("attachment-error-badge").count(),
    0,
    "真实 Gateway 附件上传出现错误",
  );
  assert.equal(await page.getByTestId("attachment-badge").count(), 3);
  const discarded = page
    .getByTestId("attachment-badge")
    .filter({ hasText: "kcoder-e2e-discard.pdf" });
  await discarded.getByTestId("remove-attachment-button").click();
  await discarded.waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(
    await page.getByTestId("attachment-badge").count(),
    2,
    "移除草稿附件后 composer 数量不正确",
  );
  await page
    .getByTestId("attachment-image-preview")
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(
    await page.getByTestId("attachment-image-preview-error").count(),
    0,
    "HTTP Gateway 无法预览刚上传的图片附件",
  );
}

async function assertUserAttachmentsVisible(page, prompt, timeoutMs) {
  const message = page
    .getByTestId("message-user")
    .filter({ hasText: prompt })
    .last();
  try {
    await message
      .getByTestId("message-image-preview")
      .waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    const diagnostic = await page.evaluate(
      (expectedPrompt) => ({
        messages: [...document.querySelectorAll('[data-testid="message-user"]')]
          .filter((node) => node.textContent?.includes(expectedPrompt))
          .map((node) => ({
            text: node.textContent,
            testIds: [...node.querySelectorAll("[data-testid]")].map((child) =>
              child.getAttribute("data-testid"),
            ),
            images: [...node.querySelectorAll("img")].map((image) => ({
              src: image.getAttribute("src"),
              complete: image.complete,
              naturalWidth: image.naturalWidth,
            })),
          })),
      }),
      prompt,
    );
    throw new Error(
      `用户附件图片未显示：${JSON.stringify(diagnostic)}；${String(error)}`,
    );
  }
  await message
    .getByTestId("message-text-attachment")
    .waitFor({ state: "visible", timeout: timeoutMs });
  assert.match(
    await message.innerText(),
    /KCODER_ATTACHMENT_TEXT_E2E|kcoder-e2e-notes\.txt/,
  );
  assert.equal(
    await message.getByText("kcoder-e2e-discard.pdf", { exact: true }).count(),
    0,
    "已移除的草稿附件仍进入了已发送消息",
  );
}

function contextUrl(page) {
  const url = new URL(page.url());
  return `${url.origin}/`;
}

async function sendPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="chat-message-input"]')
        ?.getAttribute("contenteditable") === "true",
    undefined,
    { timeout: 30_000 },
  );
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
  await page.getByTestId("send-message-button").click();
}

async function assertConversationVisible(page, prompt, reply, timeoutMs) {
  await page
    .getByTestId("message-user")
    .filter({ hasText: prompt })
    .last()
    .waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForFunction(
    (expected) => {
      const messages = [
        ...document.querySelectorAll('[data-testid="message-assistant"]'),
      ];
      return messages.some((message) =>
        message.textContent?.includes(expected),
      );
    },
    reply,
    { timeout: timeoutMs },
  );
}

async function verifyWorkspaceMarkdownImage(
  page,
  context,
  imagePath,
  expectedBytes,
) {
  const filename = imagePath.split(/[\\/]/).pop();
  assert.equal(filename, KCODER_WORKSPACE_IMAGE_FILENAME);
  const prompt = KCODER_WORKSPACE_IMAGE_PROMPT;
  await traceWorkspaceImageRequests(page);
  await sendPrompt(page, prompt);
  await page
    .getByTestId("message-user")
    .filter({ hasText: KCODER_WORKSPACE_IMAGE_PROMPT })
    .last()
    .waitFor({ state: "visible", timeout: 30_000 });
  const imageButton = page
    .getByTestId("assistant-markdown-image-button")
    .last();
  try {
    await imageButton.waitFor({ state: "visible", timeout: 60_000 });
  } catch (error) {
    await context.writeArtifactJson(
      "workspace-markdown-image-failure.json",
      await page.evaluate(() => ({
        url: location.href,
        trace: window.__kcoderWorkspaceImageTrace ?? [],
        assistantMessages: [
          ...document.querySelectorAll('[data-testid="message-assistant"]'),
        ]
          .slice(-3)
          .map((message) => ({
            text: message.textContent,
            testIds: [...message.querySelectorAll("[data-testid]")].map(
              (node) => node.getAttribute("data-testid"),
            ),
            images: [...message.querySelectorAll("img")].map((image) => ({
              src: image.getAttribute("src"),
              alt: image.getAttribute("alt"),
              complete: image.complete,
              naturalWidth: image.naturalWidth,
            })),
          })),
      })),
    );
    await capture(page, context, "workspace-markdown-image-failure.png");
    throw error;
  }
  const inlineImage = imageButton.locator("img");
  assert.match(await inlineImage.getAttribute("src"), /^blob:/);
  await inlineImage.evaluate((image) => {
    if (!(image instanceof HTMLImageElement))
      throw new Error("workspace Markdown preview is not an image");
    if (image.complete && image.naturalWidth > 0) return;
    return new Promise((resolveImage, rejectImage) => {
      image.addEventListener("load", resolveImage, { once: true });
      image.addEventListener(
        "error",
        () =>
          rejectImage(new Error("workspace Markdown preview failed to decode")),
        { once: true },
      );
    });
  });
  await imageButton.click();
  const lightbox = page.getByTestId("attachment-image-lightbox");
  await lightbox.waitFor({ state: "visible", timeout: 30_000 });
  await lightbox
    .getByTestId("attachment-image-lightbox-image")
    .evaluate((image) => {
      if (!(image instanceof HTMLImageElement))
        throw new Error("workspace Markdown lightbox is not an image");
      if (image.complete && image.naturalWidth > 0) return;
      return new Promise((resolveImage, rejectImage) => {
        image.addEventListener("load", resolveImage, { once: true });
        image.addEventListener(
          "error",
          () =>
            rejectImage(
              new Error("workspace Markdown lightbox failed to decode"),
            ),
          { once: true },
        );
      });
    });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    page.getByTestId("attachment-image-download").click(),
  ]);
  assert.equal(download.suggestedFilename(), filename);
  const downloadedPath = await download.path();
  assert.ok(
    downloadedPath,
    "workspace Markdown image download did not produce a file",
  );
  assert.deepEqual(await readFile(downloadedPath), expectedBytes);
  await page.getByTestId("attachment-image-lightbox-close").click();
}

async function traceWorkspaceImageRequests(page) {
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      throw new Error("KCoder Gateway invoke bridge is unavailable");
    }
    const originalInvoke = internals.invoke.bind(internals);
    window.__kcoderWorkspaceImageTrace = [];
    internals.invoke = async (command, args) => {
      const isWorkspaceRead =
        command === "device_execute" &&
        args?.request?.command_key === "workspace_read_file_chunk";
      try {
        const response = await originalInvoke(command, args);
        if (isWorkspaceRead) {
          window.__kcoderWorkspaceImageTrace.push({
            request: args?.request,
            response,
          });
        }
        return response;
      } catch (error) {
        if (isWorkspaceRead) {
          window.__kcoderWorkspaceImageTrace.push({
            request: args?.request,
            error: String(error),
          });
        }
        throw error;
      }
    };
  });
}

async function capture(page, context, filename, screenshotOptions = {}) {
  const path = context.pathInCase(
    "system-chromium",
    "kcoder-runtime-conversation",
    filename,
  );
  await mkdir(resolve(path, ".."), { recursive: true });
  await page.screenshot({ ...screenshotOptions, path, fullPage: true });
}
