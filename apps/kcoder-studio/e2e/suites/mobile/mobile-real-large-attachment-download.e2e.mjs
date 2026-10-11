import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { findOwnedExecutableProcesses, hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

const kcoderBinary = resolve(repoRoot, "target/test/coordination/latest-main-apk/20260930-132452.184360Z/backend-build/kcoder");
const mobileDependencyRoot = resolve(repoRoot, "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules");

await runE2E(import.meta.url, {
  testId: "mobile-web-real-large-attachment-download",
  tier: "full-integration",
  modelPolicy: "real Gateway/app-server/engine with deterministic local Provider fixture; not an upstream model test",
  retainSuccessLogs: true,
}, async context => {
  const configuredBackendBefore = await hashExecutableFile(kcoderBinary);
  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-large-attachment-web-export",
    outputName: "mobile-web-export",
    dependencyRoot: mobileDependencyRoot,
  });
  const mobileDist = mobileWeb.path;
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("large-attachment-settings.json", {
    active_provider: "large-mobile", permission_mode: "yolo",
    providers: { "large-mobile": provider(model.baseUrl) },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", { "large-mobile": { type: "api", key: "deterministic-local" } });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Local", transport: "local",
    command: kcoderBinary, workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true, label: "mobile-large-attachment-gateway", workspace, serversFile,
    kcoderBin: kcoderBinary,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-large-attachment-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcRequests = [];
  const unauthorizedResponses = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("response", response => {
    if (response.status() !== 401) return;
    unauthorizedResponses.push({
      method: response.request().method(),
      pathname: new URL(response.url()).pathname,
    });
  });
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("websocket", socket => socket.on("framesent", event => {
    try {
      const value = JSON.parse(String(event.payload));
      if (value?.method) rpcRequests.push({ method: value.method, params: summarizeParams(value.method, value.params) });
    } catch {}
  }));

  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("LARGE_ATTACHMENT_BOOTSTRAP");
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });

  const filename = "large-history-attachment.txt";
  const content = Buffer.allocUnsafe(512 * 1024 + 17);
  for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
  const uploadSha256 = createHash("sha256").update(content).digest("hex");
  await page.getByTestId("composer-attachment").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByText("选择文件", { exact: true }).click();
  await (await chooserPromise).setFiles({ name: filename, mimeType: "text/plain", buffer: content });
  await page.getByTestId(`staged-attachment-${encodeURIComponent(filename)}`).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(rpcRequests.filter(request => request.method === "attachment/upload/start").length, 1);
  const uploadChunks = rpcRequests.filter(request => request.method === "attachment/upload/chunk");
  assert.deepEqual(uploadChunks.map(request => request.params.index), [0, 1], "512 KiB + 17 byte 上传必须用连续 chunk index 覆盖小尾块");
  assert.deepEqual(uploadChunks.map(request => request.params.content_bytes), [512 * 1024, 17]);
  assert.equal(rpcRequests.filter(request => request.method === "attachment/upload/finish").length, 1);
  assert.equal(rpcRequests.filter(request => request.method === "attachment/save").length, 0);

  await page.getByTestId("message-input").fill("LARGE_ATTACHMENT_REAL_TURN");
  await page.getByTestId("send-message").click();
  const attachmentCard = page.getByTestId(`message-attachment-${encodeURIComponent(filename)}`);
  await attachmentCard.waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  assert.ok(model.requests.some(request => JSON.stringify(request).includes(filename)));
  const taskUrl = page.url();
  const taskPath = new URL(taskUrl).pathname;
  const profileId = decodeURIComponent(taskPath.match(/\/h\/([^/]+)\/task\//)?.[1] ?? "");
  const threadId = decodeURIComponent(taskPath.split("/").at(-1) ?? "");
  assert.ok(profileId && threadId, `unexpected task URL: ${taskUrl}`);
  const firstGatewayProvenance = await recordBackendProvenance(context, gateway, configuredBackendBefore, mobileWeb, "large-attachment-before-restart");

  await context.stopOwned("mobile-large-attachment-gateway");
  const restartedGateway = await startGateway(context, {
    auth: true,
    label: "mobile-large-attachment-gateway-after-restart",
    workspace,
    serversFile,
    kcoderBin: kcoderBinary,
    authToken: gateway.authToken,
    port: gateway.port,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  await page.getByText("Gateway 会话已失效，请前往设置重新连接", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByLabel("打开任务列表").click();
  await page.getByTestId("mobile-drawer").getByLabel("设置").click();
  await page.getByTestId(`reauthorize-profile-${profileId}`).click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  const restoredThread = page.locator(`[data-testid="thread-${threadId}"]:visible`).first();
  await restoredThread.waitFor({ state: "visible", timeout: 30_000 });
  await restoredThread.click();
  await page.locator('[data-testid="message-input-root"]:visible').first().waitFor({ state: "visible", timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  const restartedGatewayProvenance = await recordBackendProvenance(context, restartedGateway, configuredBackendBefore, mobileWeb, "large-attachment-after-restart");
  const restoredUserMessage = page.getByTestId("message-user").filter({ hasText: "LARGE_ATTACHMENT_REAL_TURN" });
  const restoredCards = restoredUserMessage.getByTestId(`message-attachment-${encodeURIComponent(filename)}`);
  await restoredCards.first().waitFor({ state: "visible", timeout: 30_000 });
  const visibleRestoredCards = await restoredCards.count();
  const restoredCard = restoredCards.first();

  let download;
  try {
    [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }),
      restoredCard.click(),
    ]);
  } catch (error) {
    await context.writeArtifactJson("mobile-real-large-attachment-download-failure.json", {
      filename, expectedBytes: content.length,
      visibleRestoredCards,
      body: (await page.locator("body").innerText()).slice(0, 8000),
      rpcRequests, unauthorizedResponses, diagnostics,
    });
    throw error;
  }
  assert.equal(download.suggestedFilename(), filename);
  const downloadPath = await download.path();
  assert.ok(downloadPath);
  assert.equal((await stat(downloadPath)).size, content.length);
  const downloadedContent = await readFile(downloadPath);
  const downloadSha256 = createHash("sha256").update(downloadedContent).digest("hex");
  assert.equal(downloadSha256, uploadSha256, "跨 Gateway/app-server 重启后的附件字节必须与上传内容完全一致");
  assert.deepEqual(downloadedContent, content);
  assert.equal(visibleRestoredCards, 1, "刷新后的可见历史只能渲染一张附件卡");
  const readChunks = rpcRequests.filter(request => request.method === "attachment/read/chunk");
  assert.deepEqual(readChunks.map(request => request.params.offset), [0, 512 * 1024], "下载 chunk 必须按绝对字节 offset 顺序读取小尾块");
  assert.deepEqual(readChunks.map(request => request.params.length), [512 * 1024, 512 * 1024]);
  assert.ok(readChunks.at(-1).params.thread_id || readChunks.at(-1).params.threadId, "分块下载必须绑定恢复后的目标 thread");
  assert.equal(rpcRequests.some(request => request.method === "attachment/read"), false, "大附件下载不能放宽为单帧 attachment/read");
  const unexpectedUnauthorizedResponses = unauthorizedResponses.filter(response =>
    !(response.method === "GET" && response.pathname === "/api/servers"));
  assert.deepEqual(unexpectedUnauthorizedResponses, [], "主动重启 Gateway 后只允许旧会话读取服务器列表时收到一次 401");
  assert.equal(unauthorizedResponses.length, 1, "旧认证会话只应在服务器列表读取时收到一次 401");
  assert.ok(unauthorizedResponses.some(response => response.method === "GET" && response.pathname === "/api/servers"), "Gateway 重启必须真实触发旧认证会话失效，并走 UI 重新授权恢复");
  const expectedExpiredSessionConsole = "error: Failed to load resource: the server responded with a status of 401 (Unauthorized)";
  const expectedExpiredSessionConsoleCount = diagnostics.filter(message => message === expectedExpiredSessionConsole).length;
  assert.equal(expectedExpiredSessionConsoleCount, unauthorizedResponses.length, "过期会话 401 console 必须与观测到的 /api/servers 响应一一对应");
  const unexpectedDiagnostics = diagnostics.filter(message =>
    message !== expectedExpiredSessionConsole
      && !/^error: WebSocket connection to '.+' failed: (Error in connection establishment: net::ERR_CONNECTION_REFUSED|Connection closed before receiving a handshake response)$/.test(message));
  await context.writeArtifactJson("mobile-real-large-attachment-download.json", {
    filename, bytes: content.length, uploadSha256, downloadSha256,
    uploadChunkIndices: uploadChunks.map(request => request.params.index),
    uploadChunkBytes: uploadChunks.map(request => request.params.content_bytes),
    downloadReadOffsets: readChunks.map(request => request.params.offset),
    chunkedUpload: true, providerReceivedAttachment: true,
    historySurvivedGatewayAndAppServerRestart: true,
    historySurvivedReload: true, downloadMatchedUpload: true,
    rpcRequests, unauthorizedResponses, diagnostics,
    expectedExpiredSessionConsoleCount, unexpectedDiagnostics,
    backendSourceCommit: "UNVERIFIED", firstGatewayProvenance, restartedGatewayProvenance,
    mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
    mobileBundleSha256: mobileWeb.bundleSha256,
    mobileBundleManifestPath: mobileWeb.bundleManifestPath,
  });
  assert.deepEqual(unexpectedDiagnostics, [], "除已与旧会话 GET /api/servers 401 对应的一条 console 和主动重启的 WebSocket 失败外不能有 console 错误或 warning");
  return {
    realChunkedUpload: true, realTurnAttachment: true,
    attachmentSurvivedGatewayAndAppServerRestart: true,
    attachmentSurvivedReload: true, realDownload: true, byteExactDownload: true,
    backendProvenance: [firstGatewayProvenance.status, restartedGatewayProvenance.status],
    backendSourceCommit: "UNVERIFIED", mobileBundleSha256: mobileWeb.bundleSha256,
  };
});

async function recordBackendProvenance(context, gateway, configuredBefore, mobileWeb, stage) {
  const actualOwnedExecutables = await findOwnedExecutableProcesses({
    pgid: gateway.child.pid,
    executablePath: configuredBefore.path,
  });
  const configuredAfter = await hashExecutableFile(configuredBefore.path);
  const matchingExecutables = actualOwnedExecutables.filter(executable => executable.sha256 === configuredBefore.sha256);
  const provenance = {
    status: matchingExecutables.length > 0 ? "VERIFIED" : "UNVERIFIED",
    backendSourceCommit: "UNVERIFIED",
    gatewayPid: gateway.child.pid,
    gatewayProcessGroupId: gateway.child.pid,
    gatewayPort: gateway.port,
    configuredBackendBefore: configuredBefore,
    configuredBackendAfter: configuredAfter,
    actualOwnedExecutables,
    mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
    mobileDependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
    mobileBundleSha256: mobileWeb.bundleSha256,
    mobileBundleManifestPath: mobileWeb.bundleManifestPath,
  };
  await context.writeArtifactJson(`backend-provenance-${stage}.json`, provenance);
  assert.equal(configuredAfter.sha256, configuredBefore.sha256, "configured backend binary must remain byte-identical during the run");
  assert.ok(matchingExecutables.length > 0, "owned Gateway process group must contain the configured backend executable with matching bytes");
  return provenance;
}

function provider(endpoint) {
  return {
    api_format: "openai_chat_completions", endpoint, default_model: "large-attachment-e2e-model",
    context_window_tokens: 128000, output_headroom_tokens: 8192,
    max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true, extra_body: {},
  };
}

function summarizeParams(method, params) {
  if (method !== "attachment/upload/chunk" || typeof params?.content_base64 !== "string") return params ?? null;
  return {
    ...params,
    content_bytes: Buffer.from(params.content_base64, "base64").length,
    content_base64: `<${params.content_base64.length} base64 chars>`,
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
