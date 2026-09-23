import assert from "node:assert/strict";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-queue-running-reload-drain",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic delayed provider queue lifecycle",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { textOnly: true, delayedRequestNumber: 1, streamDelayMs: 30_000 });
  const settingsFile = await context.writeStateJson("queue-settings.json", {
    active_provider: "queue-mobile",
    permission_mode: "yolo",
    providers: { "queue-mobile": { api_format: "openai_chat_completions", endpoint: model.baseUrl, default_model: "approval-e2e-model", context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192, request_timeout_secs: 60, no_proxy: true, extra_body: {} } },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", { "queue-mobile": { type: "api", key: "deterministic-local-fixture" } });
  const serversFile = await context.writeStateJson("servers.json", [{ id: "local", label: "Local", transport: "local", command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile }]);
  const gateway = await startGateway(context, { auth: true, label: "mobile-queue-gateway", workspace, serversFile, env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist } });
  const chromium = await startChromium(context, { label: "mobile-queue-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcMethods = [];
  const rpcRequests = [];
  const rpcResponses = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`); });
  page.on("websocket", socket => {
    socket.on("framesent", event => { try { const value = JSON.parse(String(event.payload)); if (value?.method) { rpcMethods.push(value.method); rpcRequests.push({ id: value.id, method: value.method, params: summarizeParams(value.method, value.params) }); } } catch {} });
    socket.on("framereceived", event => { try { const value = JSON.parse(String(event.payload)); if (value?.id !== undefined) rpcResponses.push({ id: value.id, result: value.result ?? null, error: value.error ?? null }); } catch {} });
  });
  await connect(page, gateway);

  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("QUEUE_FIRST_RUNNING");
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("queue-message").waitFor({ state: "visible", timeout: 60_000 });

  await page.getByTestId("composer-attachment").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByText("选择文件", { exact: true }).click();
  const filename = "large-queued-attachment.txt";
  const content = Buffer.alloc(300 * 1024, "Q");
  await (await chooserPromise).setFiles({ name: filename, mimeType: "text/plain", buffer: content });
  await page.getByText(filename, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-input").fill("QUEUE_SECOND_AFTER_RELOAD");
  await page.getByTestId("queue-message").click();
  await page.getByTestId("queued-message-0").filter({ hasText: "QUEUE_SECOND_AFTER_RELOAD" }).waitFor({ state: "visible", timeout: 10_000 });
  assert.match(await page.getByTestId("queued-message-0").innerText(), /1 个附件/);
  await page.getByTestId("message-input").fill("QUEUE_THIRD_AFTER_RELOAD");
  await page.getByTestId("queue-message").click();
  await page.getByTestId("queued-message-1").filter({ hasText: "QUEUE_THIRD_AFTER_RELOAD" }).waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(600);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-user").filter({ hasText: "QUEUE_SECOND_AFTER_RELOAD" }).waitFor({ state: "visible", timeout: 60_000 });
  const attachment = page.getByTestId("message-user").filter({ hasText: "QUEUE_SECOND_AFTER_RELOAD" }).getByTestId(`message-attachment-${encodeURIComponent(filename)}`);
  await attachment.waitFor({ state: "visible", timeout: 60_000 });
  let download;
  try {
    [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      attachment.click(),
    ]);
  } catch (error) {
    await context.writeArtifactJson("queue-attachment-reload-failure.json", { body: (await page.locator("body").innerText()).slice(0, 8000), rpcRequests, rpcResponses, diagnostics });
    throw error;
  }
  assert.equal(download.suggestedFilename(), filename);
  const downloadPath = await download.path();
  assert.ok(downloadPath);
  assert.equal((await stat(downloadPath)).size, content.length);
  assert.deepEqual(await readFile(downloadPath), content);
  await page.getByTestId("message-user").filter({ hasText: "QUEUE_THIRD_AFTER_RELOAD" }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("queued-messages").waitFor({ state: "hidden", timeout: 60_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });

  const providerUserPrompts = model.requests.map(request => [...(request.messages ?? [])].reverse().find(message => message?.role === "user")?.content).filter(Boolean).map(content => typeof content === "string" ? content : JSON.stringify(content));
  const secondIndex = providerUserPrompts.findIndex(value => String(value).includes("QUEUE_SECOND_AFTER_RELOAD"));
  const thirdIndex = providerUserPrompts.findIndex(value => String(value).includes("QUEUE_THIRD_AFTER_RELOAD"));
  assert.ok(secondIndex >= 0 && thirdIndex > secondIndex, `排队消息必须按 FIFO 到达 provider：${JSON.stringify(providerUserPrompts)}`);
  assert.ok(model.requests.some(request => JSON.stringify(request).includes(filename)), "恢复后的排队 turn 必须把附件传给 provider");
  assert.ok(rpcMethods.includes("attachment/upload/chunk"), "大附件必须通过 chunk RPC 上传");
  assert.ok(rpcMethods.includes("gateway/attachments/retain"), "刷新前必须持久化保留排队附件");
  assert.ok(rpcMethods.includes("attachment/read/chunk"), "恢复后的大附件必须通过 chunk RPC 下载");
  assert.equal(rpcMethods.includes("attachment/read"), false, "大附件不能回退到受 256KiB 限制的单帧读取");
  const visibleUserMessages = await page.getByTestId("message-user").allInnerTexts();
  assert.ok(visibleUserMessages.findIndex(text => text.includes("QUEUE_SECOND_AFTER_RELOAD")) < visibleUserMessages.findIndex(text => text.includes("QUEUE_THIRD_AFTER_RELOAD")));
  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-queue-reload.json", { providerUserPrompts, visibleUserMessages, rpcMethods, queueAttachment: filename, queueAttachmentBytes: content.length, queueRestoredAndDrained: true, fifo: true, byteExactDownload: true, diagnostics });
  return { realDelayedProvider: true, queuedDuringRunningTurn: true, largeQueuedAttachmentSurvivedReload: true, reloadRestoredQueue: true, fifoDrain: true, byteExactDownload: true };
});

function summarizeParams(method, params) {
  if (method !== "attachment/upload/chunk" || typeof params?.content_base64 !== "string") return params ?? null;
  return {
    ...params,
    content_base64: `<${params.content_base64.length} base64 chars>`,
  };
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}
