import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { findOwnedExecutableProcesses, hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

const execFile = promisify(execFileCallback);
const kcoderBinary = resolve(repoRoot, "target/test/coordination/latest-main-apk/20260930-132452.184360Z/backend-build/kcoder");
const mobileDependencyRoot = resolve(repoRoot, "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules");

await runE2E(import.meta.url, {
  testId: "mobile-web-real-attachments-and-git-changes",
  tier: "full-integration",
  modelPolicy: "deterministic full-turn scenario fixture through real Gateway/app-server; not a full engine/provider behavior test",
  retainSuccessLogs: true,
}, async context => {
  const configuredBackendBefore = await hashExecutableFile(kcoderBinary);
  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-attachments-changes-web-export",
    outputName: "mobile-web-export",
    dependencyRoot: mobileDependencyRoot,
  });
  const mobileDist = mobileWeb.path;
  const workspace = context.pathInState("mobile-real-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "mobile-change.txt"), "baseline\n");
  await execFile("git", ["init", "-b", "main"], { cwd: workspace });
  await execFile("git", ["config", "user.email", "mobile-e2e@kcoder.local"], { cwd: workspace });
  await execFile("git", ["config", "user.name", "Mobile E2E"], { cwd: workspace });
  await execFile("git", ["add", "."], { cwd: workspace });
  await execFile("git", ["commit", "-m", "baseline"], { cwd: workspace });
  for (const branch of ["feature/alpha", "feature/beta", "release/candidate", "bugfix/mobile-filter"]) {
    await execFile("git", ["branch", branch], { cwd: workspace });
  }
  await writeFile(resolve(workspace, "mobile-change.txt"), "baseline\nmobile real change\n");

  const gateway = await startGateway(context, {
    auth: true, label: "mobile-real-gateway", workspace,
    kcoderBin: kcoderBinary,
    env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-real-chromium" });
  const browserContext = chromium.browser.contexts()[0];
  const page = await browserContext.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = { console: [], pageErrors: [], failedResponses: [], requestFailures: [] };
  const rpcMethods = [];
  const rpcResponses = [];
  const rpcRequests = [];
  const rpcTimeline = [];
  const faultedTurnStarts = [];
  page.on("pageerror", error => diagnostics.pageErrors.push(error.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.console.push(`${message.type()}: ${message.text()}`); });
  page.on("response", response => { if (response.status() >= 400) diagnostics.failedResponses.push(`${response.status()} ${response.url()}`); });
  page.on("requestfailed", request => diagnostics.requestFailures.push(`${request.failure()?.errorText} ${request.url()}`));
  await page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    const methodById = new Map();
    socket.onMessage(raw => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      const method = value?.method;
      if (typeof method === "string") {
        const params = summarizeRpcParams(method, value.params);
        rpcMethods.push(method);
        rpcRequests.push({ id: value.id ?? null, method, params });
        if (value.id !== undefined) methodById.set(value.id, method);
        rpcTimeline.push({ order: rpcTimeline.length, direction: "request", id: value.id ?? null, method, params });
      }
      if (method === "turn/start" && rpcText(value.params).includes("MOBILE_REAL_FAILED_ATTACHMENT_CLEANUP")) {
        const forwardedThreadId = "workspace-qa-no-such-thread";
        faultedTurnStarts.push({
          id: value.id,
          method,
          requestedThreadId: value.params?.threadId ?? null,
          forwardedThreadId,
          promptMarker: "MOBILE_REAL_FAILED_ATTACHMENT_CLEANUP",
        });
        upstream.send(JSON.stringify({
          ...value,
          params: { ...value.params, threadId: forwardedThreadId },
        }));
        return;
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
      if (value?.id !== undefined) {
        const method = methodById.get(value.id) ?? null;
        const response = {
          id: value.id,
          method,
          error: value.error ? { code: value.error.code ?? null } : null,
          success: !value.error,
          ...(method === "attachment/save" ? { result: { path: value.result?.path ?? null } } : {}),
        };
        rpcResponses.push(response);
        rpcTimeline.push({ order: rpcTimeline.length, direction: "response", ...response });
      }
      socket.send(raw);
    });
  });

  await connect(page, gateway);
  await createTask(page, "MOBILE_REAL_ATTACHMENT_CHANGES");
  const backendProvenance = await recordBackendProvenance(context, gateway, configuredBackendBefore, mobileWeb, "attachments-changes");

  await page.getByTestId("composer-attachment").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByText("选择文件", { exact: true }).click();
  const chooser = await chooserPromise;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await chooser.setFiles({ name: "mobile-real.png", mimeType: "image/png", buffer: png });
  await page.getByText("mobile-real.png", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const stagedReadCount = rpcMethods.filter(method => method === "attachment/read").length;
  await page.getByTestId(`staged-attachment-${encodeURIComponent("mobile-real.png")}`).click();
  try {
    await page.getByTestId("attachment-lightbox-image").waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    await context.writeArtifactJson("staged-preview-failure.json", { rpcMethods, rpcResponses: rpcResponses.slice(-30), diagnostics, body: (await page.locator("body").innerText()).slice(0, 8000) });
    await capture(page, context, "failure-staged-preview.png");
    throw error;
  }
  await page.getByTestId("attachment-lightbox-backdrop").click({ position: { x: 5, y: 5 } });
  assert.equal(rpcMethods.filter(method => method === "attachment/read").length, stagedReadCount, "发送前本地预览不应读取服务端 thread 附件");
  await page.getByLabel("移除 mobile-real.png").click();
  await page.getByText("mobile-real.png", { exact: true }).waitFor({ state: "detached", timeout: 30_000 });
  await page.getByTestId("composer-attachment").click();
  const replacementChooserPromise = page.waitForEvent("filechooser");
  await page.getByText("选择文件", { exact: true }).click();
  await (await replacementChooserPromise).setFiles({ name: "mobile-real.png", mimeType: "image/png", buffer: png });
  await page.getByText("mobile-real.png", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-input").fill("请确认真实附件");
  await page.getByTestId("send-message").click();
  const attachment = page.getByTestId(`message-attachment-${encodeURIComponent("mobile-real.png")}`);
  await attachment.waitFor({ state: "visible", timeout: 30_000 });
  await attachment.click();
  await page.getByTestId("attachment-lightbox-image").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(rpcMethods.filter(method => method === "attachment/read").length, stagedReadCount + 1, "历史消息预览应读取服务端附件");
  await capture(page, context, "01-real-attachment-preview.png");
  await page.getByTestId("attachment-lightbox-backdrop").click({ position: { x: 5, y: 5 } });

  const failedAttachmentFilename = "mobile-failed-cleanup.png";
  const failedAttachmentPrompt = "MOBILE_REAL_FAILED_ATTACHMENT_CLEANUP";
  await page.getByTestId("composer-attachment").click();
  const failedChooserPromise = page.waitForEvent("filechooser");
  await page.getByText("选择文件", { exact: true }).click();
  await (await failedChooserPromise).setFiles({ name: failedAttachmentFilename, mimeType: "image/png", buffer: png });
  await page.getByTestId(`staged-attachment-${encodeURIComponent(failedAttachmentFilename)}`).waitFor({ state: "visible", timeout: 30_000 });
  const failedAttachmentSave = rpcRequests.find(request => request.method === "attachment/save" && request.params?.filename === failedAttachmentFilename);
  assert.ok(failedAttachmentSave, "failed-submission fixture must use the real app-server attachment/save request");
  const failedAttachmentSaveResponse = rpcResponses.find(response => response.id === failedAttachmentSave.id && response.method === "attachment/save");
  const failedAttachmentPath = failedAttachmentSaveResponse?.result?.path;
  assert.equal(failedAttachmentSaveResponse?.success, true, "app-server must return the retained failed attachment path");
  assert.ok(failedAttachmentPath, "app-server attachment/save must return a path for the failed submission fixture");
  await page.getByTestId("message-input").fill(failedAttachmentPrompt);
  await page.getByTestId("send-message").click();
  const failedSubmission = page.getByTestId("failed-submission").filter({ hasText: failedAttachmentPrompt }).first();
  await failedSubmission.waitFor({ state: "visible", timeout: 30_000 });
  await failedSubmission.getByTestId("failed-submission-attachments").getByTestId(`staged-attachment-${encodeURIComponent(failedAttachmentFilename)}`).waitFor({ state: "visible", timeout: 30_000 });
  const retainedFailedAttachment = rpcRequests.find(request => request.method === "gateway/attachments/retain" && request.params?.paths?.includes(failedAttachmentPath));
  const rejectedAttachmentTurn = faultedTurnStarts.find(request => request.promptMarker === failedAttachmentPrompt);
  assert.ok(rejectedAttachmentTurn, "the unique failed attachment turn must be forwarded to the real app-server with an isolated missing-thread target");
  assert.ok(retainedFailedAttachment, "the actual attachment path must be retained before recording it as a failed submission");
  const rejectedAttachmentTurnResponse = rpcResponses.find(response => response.id === rejectedAttachmentTurn.id && response.method === "turn/start");
  assert.equal(rejectedAttachmentTurnResponse?.success, false, "the real app-server must reject the isolated failed-submission turn");
  assert.ok(rejectedAttachmentTurnResponse?.error, "the app-server rejection must be captured as a JSON-RPC error");

  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId("workspace-tab-changes").click();
  await page.getByTestId("changes-panel").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("mobile-change.txt", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("git-stage-all").click();
  await page.getByTestId("changes-mode-staged").click();
  await page.getByText("mobile-change.txt", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("git-open-commit").click();
  await page.getByTestId("git-commit-message").fill("mobile real changes e2e");
  await page.getByTestId("git-commit").click();
  await page.getByTestId("changes-mode-committed").click();
  await page.getByText("mobile-change.txt", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, context, "02-real-git-committed.png");
  await page.getByTestId("changes-mode-working").click();
  await page.getByText("工作树是干净的", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("刷新 Git 变更").click();
  await page.getByText("工作树是干净的", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("当前分支 main，打开分支菜单").click();
  await page.getByTestId("git-branch-filter").fill("no-such-mobile-branch");
  await page.getByText("没有匹配的分支", { exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("当前分支 main，打开分支菜单").click();
  await page.getByLabel("当前分支 main，打开分支菜单").click();
  assert.equal(await page.getByTestId("git-branch-filter").inputValue(), "", "重新打开分支菜单应清空过滤词");
  await page.getByTestId("git-branch-filter").fill("BETA");
  await page.getByTestId(`git-branch-option-${encodeURIComponent("feature/beta")}`).waitFor({ state: "visible" });
  assert.equal(await page.getByTestId(`git-branch-option-${encodeURIComponent("feature/alpha")}`).count(), 0);
  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId(`git-branch-option-${encodeURIComponent("feature/beta")}`).click();
  await page.getByLabel("当前分支 feature/beta，打开分支菜单").waitFor({ state: "visible", timeout: 30_000 });

  const { stdout: log } = await execFile("git", ["log", "main", "-1", "--pretty=%s"], { cwd: workspace });
  assert.equal(log.trim(), "mobile real changes e2e");
  assert.equal((await execFile("git", ["branch", "--show-current"], { cwd: workspace })).stdout.trim(), "feature/beta");
  assert.equal((await execFile("git", ["show", "main:mobile-change.txt"], { cwd: workspace })).stdout, "baseline\nmobile real change\n");
  const deleteRequest = rpcRequests.find(request => request.method === "attachment/delete");
  assert.ok(deleteRequest, `缺少移除 attachment/delete: ${rpcMethods.join(",")}`);
  assert.ok(rpcResponses.some(response => response.id === deleteRequest.id && response.error === null), "attachment/delete 应成功响应");
  const attachmentDeletesBeforeTaskDelete = rpcMethods.filter(method => method === "attachment/delete").length;
  await page.locator('[data-testid="workspace-tab-switcher"]:visible').click();
  await page.locator('[data-testid="workspace-tab-agent"]:visible').click();
  await page.locator('[aria-label="更多"]:visible').click();
  const taskMenu = page.getByRole("dialog", { name: "任务操作" });
  page.once("dialog", dialog => dialog.accept());
  await taskMenu.getByText("删除任务", { exact: true }).click();
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  const threadDeleteRequest = rpcRequests.find(request => request.method === "thread/delete");
  const threadDeleteAck = threadDeleteRequest
    ? rpcResponses.find(response => response.id === threadDeleteRequest.id && response.method === "thread/delete") ?? null
    : null;
  const failedPathDeletes = rpcRequests.filter(request => request.method === "attachment/delete" && request.params?.path === failedAttachmentPath);
  const threadDeleteAckOrder = threadDeleteRequest
    ? rpcTimeline.findIndex(event => event.direction === "response" && event.id === threadDeleteRequest.id && event.method === "thread/delete" && event.success)
    : -1;
  const failedPathDeleteOrder = rpcTimeline.findIndex(event => event.direction === "request" && event.method === "attachment/delete" && event.params?.path === failedAttachmentPath);
  const prematureFailedPathDeletes = rpcTimeline.filter(event => event.direction === "request" && event.method === "attachment/delete" && event.params?.path === failedAttachmentPath && event.order < threadDeleteAckOrder);
  await context.writeArtifactJson("attachment-task-delete-cleanup-trace.json", {
    attachmentDeletesBeforeTaskDelete,
    attachmentDeletesAfterTaskDelete: rpcMethods.filter(method => method === "attachment/delete").length,
    threadDeletes: rpcMethods.filter(method => method === "thread/delete").length,
    failedAttachmentFilename,
    failedAttachmentPath,
    failedAttachmentSaveResponse,
    retainedFailedAttachment: Boolean(retainedFailedAttachment),
    rejectedAttachmentTurn,
    rejectedAttachmentTurnResponse,
    threadDeleteRequest,
    threadDeleteAck,
    failedPathDeletes,
    threadDeleteAckOrder,
    failedPathDeleteOrder,
    prematureFailedPathDeletes,
    faultedTurnStarts,
    rpcTimeline,
    rpcMethods,
    rpcRequests,
    diagnostics,
  });
  assert.ok(threadDeleteRequest, "permanent deletion must send the real thread/delete RPC");
  assert.equal(threadDeleteAck?.success, true, "failed attachment cleanup must be sequenced after a successful thread/delete ACK");
  const taskDeleteAttachmentPaths = rpcRequests
    .filter(request => request.method === "attachment/delete")
    .slice(attachmentDeletesBeforeTaskDelete)
    .map(request => request.params?.path);
  assert.equal(taskDeleteAttachmentPaths.length, 3,
    "永久删除含附件任务必须清理 staging 上传文件、thread 历史副本和 failed-submission 附件");
  assert.equal(new Set(taskDeleteAttachmentPaths).size, taskDeleteAttachmentPaths.length,
    "staging、历史和 failed-submission 附件的 path 必须去重，每个 path 只能清理一次");
  assert.equal(failedPathDeletes.length, 1, "failed-submission 附件 path 在永久删除时必须恰好清理一次");
  assert.ok(threadDeleteAckOrder >= 0 && failedPathDeleteOrder > threadDeleteAckOrder,
    "failed-submission attachment/delete 必须在 app-server 成功返回 thread/delete ACK 后发送");
  assert.deepEqual(prematureFailedPathDeletes, [], "failed-submission path 在 thread/delete ACK 前不得提前清理");
  assert.equal(rpcMethods.filter(method => method === "thread/delete").length, 1);
  assert.deepEqual(diagnostics, { console: [], pageErrors: [], failedResponses: [], requestFailures: [] });
  await context.writeArtifactJson("mobile-real-attachments-changes.json", { workspace, diagnostics, rpcMethods, attachment: "mobile-real.png", failedAttachmentFilename, failedAttachmentPath, commit: log.trim(), attachmentCleanedOnTaskDelete: true, failedAttachmentCleanedAfterDeleteAck: true, backendSourceCommit: "UNVERIFIED", backendProvenance, mobileSourceTreeSha256: mobileWeb.sourceTreeSha256, mobileBundleSha256: mobileWeb.bundleSha256, mobileBundleManifestPath: mobileWeb.bundleManifestPath });
  return { scenarioFixtureOnly: true, fullEngineProviderBehavior: false, attachmentRemoveAndReupload: true, attachmentUploadPreview: true, failedSubmissionAttachmentReclaimedAfterDeleteAck: true, gitStageCommitRefreshAndEmpty: true, attachmentCleanedOnTaskDelete: true, backendProvenance: backendProvenance.status, backendSourceCommit: "UNVERIFIED", mobileBundleSha256: mobileWeb.bundleSha256 };
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

async function connect(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
}

async function capture(page, context, filename) {
  const path = context.pathInCase("system-chromium", "mobile-real", filename);
  await mkdir(resolve(path, ".."), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

function rpcText(params) {
  return (params?.input ?? [])
    .filter(item => item?.type === "text")
    .map(item => String(item.text ?? ""))
    .join("\n");
}

function summarizeRpcParams(method, params = {}) {
  if (method === "attachment/save") {
    return {
      filename: params.filename ?? null,
      contentBytes: typeof params.content_base64 === "string" ? Buffer.from(params.content_base64, "base64").length : 0,
    };
  }
  if (method === "attachment/delete") return { path: params.path ?? null };
  if (method === "gateway/attachments/retain") return { paths: Array.isArray(params.paths) ? params.paths : [] };
  if (method === "thread/delete") return { threadId: params.threadId ?? null };
  if (method === "turn/start") return {
    threadId: params.threadId ?? null,
    clientMessageId: params.clientMessageId ?? null,
    hasFailedAttachmentMarker: rpcText(params).includes("MOBILE_REAL_FAILED_ATTACHMENT_CLEANUP"),
  };
  return null;
}
