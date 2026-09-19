import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { realModelPreflight } from "../../harness/real-model.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "real-model-image-attachment-web",
    tier: "pr-smoke-credentialed",
    modelPolicy: "real-model-required",
    retainSuccessLogs: true,
  },
  async (context) => {
    const model = await realModelPreflight(
      process.env.KCODER_E2E_MODEL_PROFILE || "kunlunmeta",
    );
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "real-model-image-attachment",
    });
    const settingsFile = await context.writeStateJson(
      "real-model-image-settings.json",
      {
        active_provider: model.provider,
        providers: { [model.provider]: model.providerConfig },
      },
    );
    const serversFile = await context.writeStateJson(
      "real-model-image-servers.json",
      [
        {
          id: "real-image",
          label: "真实图片模型 E2E",
          runtime: "kcoder",
          transport: "local",
          command: model.kcoderBin,
          workspace,
          settingsFile,
          profile: model.profile,
        },
      ],
    );
    const credentialEnv = Object.fromEntries(
      model.credentialEnv
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]]),
    );
    const gateway = await startGateway(context, {
      workspace,
      serversFile,
      auth: true,
      env: {
        // Pass provider configuration to app-server through a read-only overlay while loading credentials from the user-approved configuration directory.
        KCODER_CONFIG_DIR: model.configDir,
        KCODER_MAX_TOKENS: process.env.KCODER_E2E_MODEL_MAX_TOKENS || "512",
        KCODER_MAX_RETRIES: "0",
        KCODER_MAX_DURATION_SECS:
          process.env.KCODER_E2E_MODEL_TIMEOUT_SECS || "120",
        ...credentialEnv,
      },
    });
    const chromium = await startChromium(context, {
      label: "real-model-image-chromium",
    });
    const page = await chromium.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const browserErrors = [];
    const failedRequests = [];
    const deviceExecuteAttachmentEvidence = [];
    const turnStartAttachmentEvidence = [];
    const websocketFrames = [];
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
    page.on("websocket", (socket) => {
      socket.on("framesent", (event) => {
        try {
          const raw = String(event.payload);
          const message = JSON.parse(raw);
          websocketFrames.push({
            direction: "sent",
            method: message?.method || null,
            bytes: raw.length,
          });
          if (message?.method === "device/execute") {
            const attachmentCount = countAttachmentEntries(message.params);
            deviceExecuteAttachmentEvidence.push({
              commandKey: message.params?.command_key || null,
              hasAttachments: attachmentCount > 0,
              attachmentCount,
              containsAttachmentName: raw.includes("kcoder-real-image.png"),
            });
          }
          if (message?.method === "turn/start") {
            const inputText = Array.isArray(message.params?.input)
              ? message.params.input
                  .filter((value) => value && typeof value === "object")
                  .map((value) =>
                    typeof value.text === "string" ? value.text : "",
                  )
                  .join("\n")
              : "";
            turnStartAttachmentEvidence.push({
              inputCount: Array.isArray(message.params?.input)
                ? message.params.input.length
                : 0,
              inputLength: inputText.length,
              containsAttachmentEnvelope: inputText.includes(
                '<kcoder_attachments version="1">',
              ),
              containsAttachmentName: inputText.includes(
                "kcoder-real-image.png",
              ),
            });
          }
        } catch {
          websocketFrames.push({
            direction: "sent",
            method: null,
            bytes: String(event.payload).length,
          });
        }
      });
    });

    await login(page, gateway.baseUrl, gateway.authToken);
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    const project = page
      .getByTestId("project-item")
      .filter({ hasText: "真实图片模型 E2E" })
      .first();
    await project.waitFor({ state: "visible", timeout: 60_000 });
    await project.getByTestId("project-new-conversation-button").click();

    const imagePath = resolve(
      repoRoot,
      "apps/kcoder-studio/renderer/src/assets/hero.png",
    );
    const imageBytes = await readFile(imagePath);
    const attachmentName = "kcoder-real-image.png";
    await page.getByTestId("add-context-button").click();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("attach-files-button").click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: attachmentName,
      mimeType: "image/png",
      buffer: imageBytes,
    });
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
    await page
      .getByTestId("attachment-badge")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page
      .getByTestId("attachment-image-preview")
      .waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(
      await page.getByTestId("attachment-image-preview-error").count(),
      0,
      "真实 Gateway 无法预览上传的图片",
    );

    const marker = `KCODER_REAL_IMAGE_ACK_${randomBytes(6).toString("hex").toUpperCase()}`;
    const missingMarker = `${marker}_MISSING`;
    const prompt = [
      "请检查本轮附加的图片，不要调用工具。",
      `如果你确实收到了图片，请先单独输出唯一标记 ${marker}，再用一句话描述图片中最明显的颜色和图形。`,
      `如果没有收到图片，只输出 ${missingMarker}。不要猜测或编造图片内容。`,
    ].join(" ");
    await sendPrompt(page, prompt);
    await waitForTurnAttachmentEvidence(turnStartAttachmentEvidence, 5_000);
    if (
      !turnStartAttachmentEvidence.some(
        (evidence) =>
          evidence.containsAttachmentEnvelope &&
          evidence.containsAttachmentName,
      )
    ) {
      await context.writeArtifactJson("turn-start-attachment-assertion.json", {
        deviceExecuteAttachmentEvidence,
        turnStartAttachmentEvidence,
        websocketFrames,
      });
      throw new Error("真实 Gateway 的 turn/start 请求没有携带图片附件");
    }
    const userMessage = page
      .getByTestId("message-user")
      .filter({ hasText: prompt })
      .last();
    await userMessage.waitFor({ state: "visible", timeout: 30_000 });
    await userMessage
      .getByTestId("message-image-preview")
      .waitFor({ state: "visible", timeout: 30_000 });
    const assistant = await waitForAssistantMarker(
      page,
      context,
      marker,
      45_000,
    );
    assert.match(assistant, new RegExp(marker));
    assert.doesNotMatch(assistant, new RegExp(missingMarker));
    assert.ok(
      assistant.replace(marker, "").trim().length > 8,
      "真实模型只返回 marker，没有描述已收到的图片",
    );

    const screenshot = context.pathInCase(
      "system-chromium",
      "real-model-image-attachment",
      "real-model-image-attachment.png",
    );
    await mkdir(resolve(screenshot, ".."), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(
      browserErrors,
      [],
      `browser errors: ${JSON.stringify(failedRequests)}`,
    );
    return {
      providerProfile: model.profile,
      provider: model.provider,
      model: model.model,
      attachmentName,
      attachmentBytes: imageBytes.length,
      imageAttachmentSent: true,
      assistantAcknowledgedImage: true,
      turnStartContainedAttachment: true,
      browserErrors,
      failedRequests,
    };
  },
);

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

function countAttachmentEntries(value, seen = new Set()) {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value))
    return value.reduce(
      (sum, item) => sum + countAttachmentEntries(item, seen),
      0,
    );
  return Object.entries(value).reduce((sum, [key, nested]) => {
    const direct =
      /attachment/i.test(key) && Array.isArray(nested) ? nested.length : 0;
    return sum + direct + countAttachmentEntries(nested, seen);
  }, 0);
}

async function waitForTurnAttachmentEvidence(evidence, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      evidence.some(
        (item) =>
          item.containsAttachmentEnvelope && item.containsAttachmentName,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function sendPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input");
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
  await page.getByTestId("send-message-button").click();
}

async function waitForAssistantMarker(page, context, marker, timeoutMs) {
  try {
    await page.waitForFunction(
      (expected) =>
        [
          ...document.querySelectorAll('[data-testid="message-assistant"]'),
        ].some((message) => message.textContent?.includes(expected)),
      marker,
      { timeout: timeoutMs },
    );
  } catch (error) {
    await context.writeArtifactJson(
      "assistant-timeout.json",
      await page.evaluate(() => ({
        url: location.href,
        body: document.body.innerText.slice(0, 20_000),
        assistantMessages: [
          ...document.querySelectorAll('[data-testid="message-assistant"]'),
        ].map((message) => message.textContent?.slice(0, 8_000)),
        userMessages: [
          ...document.querySelectorAll('[data-testid="message-user"]'),
        ].map((message) => message.textContent?.slice(0, 8_000)),
        attachmentErrors: [
          ...document.querySelectorAll(
            '[data-testid="attachment-error-badge"]',
          ),
        ].map((errorNode) => errorNode.textContent),
      })),
    );
    const screenshot = context.pathInCase(
      "system-chromium",
      "real-model-image-attachment",
      "assistant-timeout.png",
    );
    await mkdir(resolve(screenshot, ".."), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    throw error;
  }
  return page
    .getByTestId("message-assistant")
    .filter({ hasText: marker })
    .last()
    .innerText();
}
