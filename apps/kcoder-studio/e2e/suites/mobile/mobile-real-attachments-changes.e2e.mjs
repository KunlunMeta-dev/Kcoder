import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { setExpoWebDocumentPickerFiles } from "../../harness/mobile-document-picker.mjs";
import { findOwnedExecutableProcesses, hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import {
  buildGatewayMobileWebManifest,
  MOBILE_WEB_BASE_TOKEN,
  writeGatewayMobileWebManifest,
} from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";

const execFile = promisify(execFileCallback);
const kcoderBinary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
const mobileDependencyRoot = resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules");

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
    deployMount: true,
  });
  const mobileDist = mobileWeb.path;
  const gatewayManifest = await buildGatewayMobileWebManifest(mobileDist, {
    expectedFiles: mobileWeb.bundleFiles,
  });
  await writeGatewayMobileWebManifest(mobileDist, gatewayManifest);
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
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDist,
    },
  });
  await verifyMobileStaticEntry(context, gateway, mobileDist, mobileWeb, gatewayManifest);
  const chromium = await startChromium(context, { label: "mobile-real-chromium" });
  const page = await chromium.newPage({ locale: "zh-CN" });
  assert.equal(await page.evaluate(() => navigator.language), "zh-CN", "attachment flow uses a pinned Chinese browser locale for its localized controls");
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = { console: [], pageErrors: [], failedResponses: [], requestFailures: [] };
  const rpcMethods = [];
  const rpcResponses = [];
  const rpcRequests = [];
  const rpcTimeline = [];
  const rpcSockets = [];
  const faultedTurnStarts = [];
  const pickerEvidence = [];
  page.on("pageerror", error => diagnostics.pageErrors.push(error.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.console.push(`${message.type()}: ${message.text()}`); });
  page.on("response", response => { if (response.status() >= 400) diagnostics.failedResponses.push(`${response.status()} ${response.url()}`); });
  page.on("requestfailed", request => diagnostics.requestFailures.push(`${request.failure()?.errorText} ${request.url()}`));
  await page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    const socketIndex = rpcSockets.length;
    rpcSockets.push({ socketIndex, closed: false });
    socket.onClose(() => { rpcSockets[socketIndex].closed = true; });
    const methodById = new Map();
    socket.onMessage(raw => {
      let value;
      try { value = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      const method = value?.method;
      if (typeof method === "string") {
        const params = summarizeRpcParams(method, value.params);
        rpcMethods.push(method);
        rpcRequests.push({ id: value.id ?? null, socketIndex, method, params });
        if (value.id !== undefined) methodById.set(value.id, method);
        rpcTimeline.push({ order: rpcTimeline.length, direction: "request", id: value.id ?? null, socketIndex, method, params });
      }
      if (method === "turn/start" && rpcText(value.params).includes("MOBILE_REAL_FAILED_ATTACHMENT_CLEANUP")) {
        const forwardedThreadId = "workspace-qa-no-such-thread";
        faultedTurnStarts.push({
          id: value.id,
          socketIndex,
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
          socketIndex,
          method,
          error: value.error ? { code: value.error.code ?? null } : null,
          success: !value.error,
          ...(method === "attachment/save" ? { result: { path: value.result?.path ?? null } } : {}),
          ...(method === "initialize" ? { result: {
            retentionCapability: value.result?.capabilities?.experimental?.stagedAttachmentRetentionReceiptsV1 === true,
            uploadAdmissionAvailable: Boolean(value.result?.attachmentUploadAdmission),
          } } : {}),
          ...(method?.startsWith("attachment/retention/upload/") ? { result: {
            lookupState: value.result?.lookup?.state ?? null,
            hasStageRef: Boolean(value.result?.stageRef ?? value.result?.lookup?.stageRef),
          } } : {}),
        };
        rpcResponses.push(response);
        rpcTimeline.push({ order: rpcTimeline.length, direction: "response", ...response });
      }
      socket.send(raw);
    });
  });

  const stageAttachment = async (stage, filename, file) => {
    const firstRequestOrder = rpcTimeline.length;
    const artifactKey = stage.toLowerCase().replaceAll(" ", "-");
    const record = { stage, firstRequestOrder };
    try {
      Object.assign(record, await setExpoWebDocumentPickerFiles(page, file));
      pickerEvidence.push(record);
      await context.writeArtifactJson(`mobile-document-picker-${artifactKey}-selection.json`, pickerEvidence);

      const composerImage = page.getByTestId(`composer-image-attachment-${encodeURIComponent(filename)}`);
      const chip = page.getByTestId(`staged-attachment-${encodeURIComponent(filename)}`);
      const outboxRow = page.getByTestId("retained-attachment-row").filter({ hasText: filename }).first();
      const retainedReady = outboxRow.getByText("上传已确认；尚未加入消息", { exact: true });
      const retainedError = page.getByTestId("retained-attachment-error");
      const attachmentError = page.locator('[role="alert"]').first();
      const branch = await Promise.any([
        composerImage.waitFor({ state: "visible", timeout: 30_000 }).then(() => "legacy-composer"),
        chip.waitFor({ state: "visible", timeout: 30_000 }).then(() => "legacy-composer"),
        retainedReady.waitFor({ state: "visible", timeout: 30_000 }).then(() => "retained-outbox"),
        retainedError.waitFor({ state: "visible", timeout: 30_000 }).then(() => "retained-error"),
        attachmentError.waitFor({ state: "visible", timeout: 30_000 }).then(() => "attachment-error"),
      ]);
      const stageUi = await captureAttachmentStageUi(page, filename);
      if (branch !== "retained-error" && branch !== "attachment-error") {
        await waitFor(() => {
          const protocol = attachmentUploadProtocol(filename, rpcTimeline, rpcResponses, firstRequestOrder);
          return protocol.branch !== "none" && protocol.responses.length > 0 ? protocol : null;
        }, 30_000, `${stage} upload RPC response`);
      }
      const protocol = attachmentUploadProtocol(filename, rpcTimeline, rpcResponses, firstRequestOrder);
      Object.assign(record, { uiBranch: branch, stageUi, uploadProtocol: protocol });
      await context.writeArtifactJson(`mobile-document-picker-${artifactKey}-evidence.json`, pickerEvidence);
      assert.notEqual(protocol.negotiatedBranch, "unknown", "The actual RPC connection must return initialize negotiation before an attachment can be classified");
      assert.equal(protocol.branch, protocol.negotiatedBranch,
        `The observed upload RPC branch must match the actual initialize negotiation (${protocol.negotiatedBranch}); UI branch was ${branch}`);
      assert.ok(protocol.responses.some(response => response.success), `${protocol.branch} upload must have an observed successful RPC response`);
      if (protocol.branch === "legacy") {
        assert.equal(branch, "legacy-composer", "Legacy attachment/save must produce a sendable composer chip");
        assert.ok(protocol.responses.some(response => response.result?.path), "Legacy attachment/save must return the path used by send and history");
      } else {
        assert.equal(protocol.initialization?.uploadAdmissionAvailable, true,
          "A negotiated retained upload must have an actual attachment upload admission");
        assert.ok(protocol.responses.some(response => response.result?.hasStageRef),
          "A retained upload must return an observed stage reference");
        assert.equal(branch, "legacy-composer", "A retained upload must become a sendable composer attachment before message send");
      }
      return record;
    } catch (error) {
      if (!pickerEvidence.includes(record)) {
        Object.assign(record, error?.pickerEvidence ?? {});
        pickerEvidence.push(record);
      }
      record.error = error instanceof Error ? error.message : String(error);
      const stageUi = await captureAttachmentStageUi(page, filename);
      Object.assign(record, { stageUi, uploadProtocol: attachmentUploadProtocol(filename, rpcTimeline, rpcResponses, firstRequestOrder) });
      const artifactName = stage === "staged preview" ? "attachment-staging-failure.json" : `attachment-${stage.replaceAll(" ", "-")}-failure.json`;
      await context.writeArtifactJson(artifactName, {
        stage,
        pickerEvidence,
        stageUi,
        visibleText: (await page.locator("body").innerText().catch(() => "")).slice(0, 12_000),
        attachmentUi: await page.locator('[data-testid*="attachment"], [role="alert"]').evaluateAll(elements =>
          elements.map(element => ({ testId: element.getAttribute("data-testid"), role: element.getAttribute("role"), text: (element.innerText || "").slice(0, 1_000) }))).catch(() => []),
        rpcMethods,
        rpcSockets,
        rpcRequests,
        rpcResponses,
        rpcTimeline,
        delivery: attachmentDeliveryEvidence(rpcRequests, rpcResponses, faultedTurnStarts),
        diagnostics,
      });
      await capture(page, context, `failure-attachment-${stage.replaceAll(" ", "-")}.png`).catch(() => {});
      throw error;
    }
  };

  let currentAttachmentStage = "connect";
  try {
  await connect(page, gateway);
  currentAttachmentStage = "create task";
  await createTask(page, "MOBILE_REAL_ATTACHMENT_CHANGES");
  const backendProvenance = await recordBackendProvenance(context, gateway, configuredBackendBefore, mobileWeb, "attachments-changes");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  currentAttachmentStage = "staged preview";
  await page.getByTestId("composer-attachment").click();
  await stageAttachment("staged preview", "mobile-real.png", { name: "mobile-real.png", mimeType: "image/png", buffer: png });
  const stagedReadCount = rpcMethods.filter(method => method === "attachment/read").length;
  await page.getByTestId(`composer-image-attachment-${encodeURIComponent("mobile-real.png")}`)
    .getByRole("button", { name: "预览待发送附件 mobile-real.png" }).click();
  try {
    await page.getByTestId("attachment-lightbox-image").waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    await context.writeArtifactJson("staged-preview-failure.json", { rpcMethods, rpcResponses: rpcResponses.slice(-30), diagnostics, body: (await page.locator("body").innerText()).slice(0, 8000) });
    await capture(page, context, "failure-staged-preview.png");
    throw error;
  }
  currentAttachmentStage = "local staged preview";
  await page.getByTestId("attachment-lightbox-backdrop").click({ position: { x: 5, y: 5 } });
  assert.equal(rpcMethods.filter(method => method === "attachment/read").length, stagedReadCount, "发送前本地预览不应读取服务端 thread 附件");
  await page.getByLabel("移除 mobile-real.png").click();
  await page.getByTestId(`composer-image-attachment-${encodeURIComponent("mobile-real.png")}`).waitFor({ state: "detached", timeout: 30_000 });
  currentAttachmentStage = "send attachment";
  await page.getByTestId("composer-attachment").click();
  await stageAttachment("send attachment", "mobile-real.png", { name: "mobile-real.png", mimeType: "image/png", buffer: png });
  await page.getByTestId("message-input").fill("请确认真实附件");
  await page.getByTestId("send-message").click();
  const attachment = page.getByTestId(`message-image-attachment-${encodeURIComponent("mobile-real.png")}`);
  await attachment.waitFor({ state: "visible", timeout: 30_000 });
  await attachment.click();
  await page.getByTestId("attachment-lightbox-image").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(rpcMethods.filter(method => method === "attachment/read").length, stagedReadCount + 1, "历史消息预览应读取服务端附件");
  await capture(page, context, "01-real-attachment-preview.png");
  await page.getByTestId("attachment-lightbox-backdrop").click({ position: { x: 5, y: 5 } });

  const failedAttachmentFilename = "mobile-failed-cleanup.png";
  const failedAttachmentPrompt = "MOBILE_REAL_FAILED_ATTACHMENT_CLEANUP";
  currentAttachmentStage = "failed submission attachment";
  await page.getByTestId("composer-attachment").click();
  await stageAttachment("failed submission attachment", failedAttachmentFilename, { name: failedAttachmentFilename, mimeType: "image/png", buffer: png });
  const failedAttachmentSave = rpcRequests.find(request => request.method === "attachment/save" && request.params?.filename === failedAttachmentFilename);
  assert.ok(failedAttachmentSave, "failed-submission fixture must use the real app-server attachment/save request");
  const failedAttachmentSaveResponse = rpcResponses.find(response =>
    response.socketIndex === failedAttachmentSave.socketIndex &&
    response.id === failedAttachmentSave.id &&
    response.method === failedAttachmentSave.method);
  const failedAttachmentPath = failedAttachmentSaveResponse?.result?.path;
  assert.equal(failedAttachmentSaveResponse?.success, true, "app-server must return the retained failed attachment path");
  assert.ok(failedAttachmentPath, "app-server attachment/save must return a path for the failed submission fixture");
  await page.getByTestId("message-input").fill(failedAttachmentPrompt);
  currentAttachmentStage = "failed submission send";
  await page.getByTestId("send-message").click();
  const failedSubmission = page.getByTestId("failed-submission").filter({ hasText: failedAttachmentPrompt }).first();
  await failedSubmission.waitFor({ state: "visible", timeout: 30_000 });
  await failedSubmission.getByTestId("failed-submission-attachments").getByTestId(`staged-attachment-${encodeURIComponent(failedAttachmentFilename)}`).waitFor({ state: "visible", timeout: 30_000 });
  const retainedFailedAttachment = rpcRequests.find(request => request.method === "gateway/attachments/retain" && request.params?.paths?.includes(failedAttachmentPath));
  const rejectedAttachmentTurn = faultedTurnStarts.find(request => request.promptMarker === failedAttachmentPrompt);
  assert.ok(rejectedAttachmentTurn, "the unique failed attachment turn must be forwarded to the real app-server with an isolated missing-thread target");
  assert.ok(retainedFailedAttachment, "the actual attachment path must be retained before recording it as a failed submission");
  const rejectedAttachmentTurnResponse = rpcResponses.find(response =>
    response.socketIndex === rejectedAttachmentTurn.socketIndex &&
    response.id === rejectedAttachmentTurn.id &&
    response.method === rejectedAttachmentTurn.method);
  assert.equal(rejectedAttachmentTurnResponse?.success, false, "the real app-server must reject the isolated failed-submission turn");
  assert.ok(rejectedAttachmentTurnResponse?.error, "the app-server rejection must be captured as a JSON-RPC error");

  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
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
  assert.ok(rpcResponses.some(response =>
    response.socketIndex === deleteRequest.socketIndex &&
    response.id === deleteRequest.id &&
    response.method === deleteRequest.method &&
    response.error === null), "attachment/delete 应成功响应");
  const attachmentDeletesBeforeTaskDelete = rpcMethods.filter(method => method === "attachment/delete").length;
  currentAttachmentStage = "git changes";
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  await page.locator('[data-testid="workspace-tab-agent"]:visible').click();
  await page.locator('[aria-label="更多"]:visible').click();
  const taskMenu = page.getByRole("dialog", { name: "任务操作" });
  page.once("dialog", dialog => dialog.accept());
  currentAttachmentStage = "task deletion cleanup";
  const taskDeleteRequestStartIndex = rpcRequests.length;
  const taskDeleteTimelineStartOrder = rpcTimeline.length;
  await taskMenu.getByText("删除任务", { exact: true }).click();
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  const threadDeleteRequest = await waitFor(
    () => rpcRequests.slice(taskDeleteRequestStartIndex).find(request => request.method === "thread/delete") ?? null,
    30_000,
    "task-delete thread/delete request",
  );
  const threadDeleteAck = await waitFor(
    () => responseForRpcRequest(threadDeleteRequest, rpcResponses),
    30_000,
    "matching thread/delete response",
  );
  const taskDeleteAttachmentEvidence = await waitFor(() => {
    const requests = rpcRequests.slice(taskDeleteRequestStartIndex).filter(request => request.method === "attachment/delete");
    if (requests.length < 3) return null;
    const responses = requests.map(request => responseForRpcRequest(request, rpcResponses));
    return responses.every(Boolean) ? { requests, responses } : null;
  }, 30_000, "matching responses for task-delete attachment/delete requests");
  const taskDeleteAttachmentRequests = taskDeleteAttachmentEvidence.requests;
  const taskDeleteAttachmentResponses = taskDeleteAttachmentEvidence.responses;
  const failedPathDeletes = taskDeleteAttachmentRequests.filter(request => request.params?.path === failedAttachmentPath);
  const threadDeleteAckOrder = threadDeleteRequest
    ? rpcTimeline.findIndex(event =>
      event.direction === "response" &&
      event.socketIndex === threadDeleteRequest.socketIndex &&
      event.id === threadDeleteRequest.id &&
      event.method === threadDeleteRequest.method &&
      event.success)
    : -1;
  const failedPathDeleteOrder = rpcTimeline.findIndex(event =>
    event.direction === "request" &&
    event.order >= taskDeleteTimelineStartOrder &&
    event.method === "attachment/delete" &&
    event.params?.path === failedAttachmentPath);
  const prematureFailedPathDeletes = rpcTimeline.filter(event =>
    event.direction === "request" &&
    event.order >= taskDeleteTimelineStartOrder &&
    event.method === "attachment/delete" &&
    event.params?.path === failedAttachmentPath &&
    event.order < threadDeleteAckOrder);
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
    taskDeleteAttachmentRequests,
    taskDeleteAttachmentResponses,
    failedPathDeletes,
    threadDeleteAckOrder,
    failedPathDeleteOrder,
    prematureFailedPathDeletes,
    pickerEvidence,
    faultedTurnStarts,
    rpcTimeline,
        rpcMethods,
        rpcSockets,
    rpcRequests,
    diagnostics,
  });
  assert.ok(threadDeleteRequest, "permanent deletion must send the real thread/delete RPC");
  assert.equal(threadDeleteAck?.success, true, "failed attachment cleanup must be sequenced after a successful thread/delete ACK");
  const taskDeleteAttachmentPaths = taskDeleteAttachmentRequests.map(request => request.params?.path);
  assert.equal(taskDeleteAttachmentPaths.length, 3,
    "永久删除含附件任务必须清理 staging 上传文件、thread 历史副本和 failed-submission 附件");
  assert.ok(taskDeleteAttachmentResponses.every(response => response.success === true && response.error === null),
    "每个 task-delete attachment/delete must receive its own successful JSON-RPC response");
  assert.equal(new Set(taskDeleteAttachmentPaths).size, taskDeleteAttachmentPaths.length,
    "staging、历史和 failed-submission 附件的 path 必须去重，每个 path 只能清理一次");
  assert.equal(failedPathDeletes.length, 1, "failed-submission 附件 path 在永久删除时必须恰好清理一次");
  assert.ok(threadDeleteAckOrder >= 0 && failedPathDeleteOrder > threadDeleteAckOrder,
    "failed-submission attachment/delete 必须在 app-server 成功返回 thread/delete ACK 后发送");
  assert.deepEqual(prematureFailedPathDeletes, [], "failed-submission path 在 thread/delete ACK 前不得提前清理");
  assert.equal(rpcMethods.filter(method => method === "thread/delete").length, 1);
  assert.deepEqual(diagnostics, { console: [], pageErrors: [], failedResponses: [], requestFailures: [] });
  await context.writeArtifactJson("mobile-real-attachments-changes.json", { workspace, diagnostics, rpcMethods, rpcSockets, rpcRequests, rpcResponses, rpcTimeline, pickerEvidence, attachment: "mobile-real.png", failedAttachmentFilename, failedAttachmentPath, taskDeleteAttachmentRequests, taskDeleteAttachmentResponses, commit: log.trim(), attachmentCleanedOnTaskDelete: true, failedAttachmentCleanedAfterDeleteAck: true, backendSourceCommit: "UNVERIFIED", backendProvenance, mobileSourceTreeSha256: mobileWeb.sourceTreeSha256, mobileBundleSha256: mobileWeb.bundleSha256, mobileBundleManifestPath: mobileWeb.bundleManifestPath });
  return { scenarioFixtureOnly: true, fullEngineProviderBehavior: false, attachmentRemoveAndReupload: true, attachmentUploadPreview: true, failedSubmissionAttachmentReclaimedAfterDeleteAck: true, gitStageCommitRefreshAndEmpty: true, attachmentCleanedOnTaskDelete: true, pickerInputObserved: pickerEvidence.length === 3 && pickerEvidence.every(item => item.filechooserObserved && item.chooserSetFilesCompleted && item.inputType === "file" && item.inputHidden), backendProvenance: backendProvenance.status, backendSourceCommit: "UNVERIFIED", mobileBundleSha256: mobileWeb.bundleSha256 };
  } catch (error) {
    await context.writeArtifactJson("attachment-run-failure.json", {
      stage: currentAttachmentStage,
      message: error instanceof Error ? error.message : String(error),
      pickerEvidence,
      rpcMethods,
      rpcSockets,
      rpcRequests,
      rpcResponses,
      rpcTimeline,
      delivery: attachmentDeliveryEvidence(rpcRequests, rpcResponses, faultedTurnStarts),
      diagnostics,
      body: await page.locator("body").innerText().catch(() => ""),
      attachmentUi: await page.locator('[data-testid*="attachment"], [role="alert"]').evaluateAll(elements =>
        elements.map(element => ({ testId: element.getAttribute("data-testid"), role: element.getAttribute("role"), text: (element.innerText || "").slice(0, 1_000) }))).catch(() => []),
    });
    await capture(page, context, `failure-attachment-run-${currentAttachmentStage.replaceAll(" ", "-")}.png`).catch(() => {});
    throw error;
  }
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

async function verifyMobileStaticEntry(context, gateway, mobileDist, mobileWeb, gatewayManifest) {
  const entry = mobileWeb.bundleFiles.find(file => file.path.startsWith("_expo/static/js/web/entry-") && file.path.endsWith(".js"));
  assert.ok(entry, "current Mobile Web export must include its Expo web entry chunk");
  const exportedBytes = await readFile(resolve(mobileDist, entry.path));
  assert.equal(createHash("sha256").update(exportedBytes).digest("hex"), entry.sha256,
    "entry bytes must match the exporter inventory");
  const expectedMountedBytes = Buffer.from(exportedBytes.toString("utf8").replaceAll(MOBILE_WEB_BASE_TOKEN, "/mobile"));
  const expectedMountedSha256 = createHash("sha256").update(expectedMountedBytes).digest("hex");
  const response = await fetch(new URL(`/mobile/${entry.path}`, gateway.baseUrl));
  const servedBytes = Buffer.from(await response.arrayBuffer());
  const servedSha256 = createHash("sha256").update(servedBytes).digest("hex");
  assert.equal(response.status, 200, "Gateway Mobile mount must serve the current export entry");
  assert.equal(servedSha256, expectedMountedSha256,
    "Gateway Mobile entry must match the deploy-base transformed current export");
  const manifestBytes = await readFile(resolve(mobileDist, "kcoder-mobile-web.json"));
  await context.writeArtifactJson("mobile-web-mounted-entry.json", {
    path: entry.path,
    status: response.status,
    exportSha256: entry.sha256,
    expectedMountedSha256,
    servedSha256,
    matchesDeployTransform: true,
    gatewayManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    gatewayManifestResourceCount: gatewayManifest.files.length,
  });
}

async function connect(page, gateway) {
  const response = await page.goto(`${gateway.baseUrl}/login?returnTo=%2Fmobile%2F`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
  assert.ok(new URL(page.url()).pathname.startsWith("/mobile/"), "authentication must return to the mounted Mobile Web route");
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("new-task-advanced").click();
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
  if (method?.startsWith("attachment/retention/")) return {
    filename: params.filename ?? null,
    size: params.size ?? null,
    ownerRequestId: params.ownerRequest?.clientOwnerRequestId ?? null,
    clientUploadId: params.clientUploadId ?? null,
    offset: params.offset ?? null,
    length: params.length ?? null,
    hasContent: typeof params.contentBase64 === "string" || typeof params.content_base64 === "string",
    hasStageRef: Boolean(params.stageRef),
  };
  if (method === "attachment/delete") return { path: params.path ?? null };
  if (method === "gateway/attachments/retain") return { paths: Array.isArray(params.paths) ? params.paths : [] };
  if (method === "thread/delete") return { threadId: params.threadId ?? null };
  if (method === "turn/start") return {
    threadId: params.threadId ?? null,
    clientMessageId: params.clientMessageId ?? null,
    hasFailedAttachmentMarker: rpcText(params).includes("MOBILE_REAL_FAILED_ATTACHMENT_CLEANUP"),
    attachmentManifestCount: rpcText(params).match(/<kcoder_attachments version="1">[\s\S]*?<\/kcoder_attachments>/)?.[0].split(/\r?\n/).filter(Boolean).length ?? 0,
  };
  return null;
}

async function captureAttachmentStageUi(page, filename) {
  const composerImage = page.getByTestId(`composer-image-attachment-${encodeURIComponent(filename)}`);
  const chip = page.getByTestId(`staged-attachment-${encodeURIComponent(filename)}`);
  const row = page.getByTestId("retained-attachment-row").filter({ hasText: filename }).first();
  const error = page.getByTestId("retained-attachment-error");
  return {
    filename,
    composerImageVisible: await composerImage.isVisible().catch(() => false),
    composerChipVisible: await chip.isVisible().catch(() => false) || await composerImage.isVisible().catch(() => false),
    retainedOutboxRowVisible: await row.isVisible().catch(() => false),
    retainedOutboxRowText: await row.innerText().catch(() => null),
    retainedOutboxError: await error.innerText().catch(() => null),
    alertText: await page.locator('[role="alert"]').evaluateAll(elements => elements.map(element => (element.innerText || "").slice(0, 1_000))).catch(() => []),
  };
}

function responseForRpcRequest(request, rpcResponses) {
  if (!request || request.id === null || request.id === undefined) return null;
  return rpcResponses.find(response =>
    response.socketIndex === request.socketIndex &&
    response.id === request.id &&
    response.method === request.method) ?? null;
}

function attachmentUploadProtocol(filename, rpcTimeline, rpcResponses, firstRequestOrder) {
  const requestEvents = rpcTimeline.filter(event => event.direction === "request" && event.order >= firstRequestOrder);
  const matchesFilename = request => request.params?.filename === filename;
  const legacyRequests = requestEvents.filter(request => request.method === "attachment/save" && matchesFilename(request));
  const retainedRequests = requestEvents.filter(request => request.method?.startsWith("attachment/retention/upload/") && matchesFilename(request));
  const matchingRequests = [...legacyRequests, ...retainedRequests];
  const socketIndex = matchingRequests.at(-1)?.socketIndex ?? null;
  const initializationRequest = rpcTimeline.find(event =>
    event.direction === "request" && event.method === "initialize" && event.socketIndex === socketIndex) ?? null;
  const initialization = initializationRequest
    ? rpcResponses.find(response => response.socketIndex === initializationRequest.socketIndex &&
      response.id === initializationRequest.id && response.method === initializationRequest.method) ?? null
    : null;
  const uploadResponses = rpcResponses.filter(response => matchingRequests.some(request =>
    request.socketIndex === response.socketIndex && request.id === response.id && request.method === response.method));
  const branch = retainedRequests.length > 0 && legacyRequests.length > 0
    ? "mixed"
    : retainedRequests.length > 0 ? "retained" : legacyRequests.length > 0 ? "legacy" : "none";
  return {
    branch,
    negotiatedBranch: initialization
      ? initialization.result?.retentionCapability === true ? "retained" : "legacy"
      : "unknown",
    socketIndex,
    requests: matchingRequests,
    responses: uploadResponses,
    initialization: initialization?.result ?? null,
  };
}

function attachmentDeliveryEvidence(rpcRequests, rpcResponses, faultedTurnStarts) {
  return {
    retentionConsumerRequests: rpcRequests.filter(request => request.method?.startsWith("attachment/retention/") && !request.method.startsWith("attachment/retention/upload/")),
    legacyRetentionRequests: rpcRequests.filter(request => request.method === "gateway/attachments/retain"),
    turnStartRequests: rpcRequests.filter(request => request.method === "turn/start"),
    turnStartResponses: rpcResponses.filter(response => response.method === "turn/start"),
    faultedTurnStarts,
  };
}
