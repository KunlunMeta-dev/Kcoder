import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { setExpoWebDocumentPickerFiles } from "../../harness/mobile-document-picker.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import {
  buildGatewayMobileWebManifest,
  MOBILE_WEB_BASE_TOKEN,
  writeGatewayMobileWebManifest,
} from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";

const viewportWidth = Number(process.env.KCODER_E2E_VIEWPORT_WIDTH || 390);
assert.ok([360, 390].includes(viewportWidth), "KCODER_E2E_VIEWPORT_WIDTH must be 360 or 390");

await runE2E(import.meta.url, {
  testId: "task-flow-send-pending-draft-rejection",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic provider; real Mobile task/runtime and Gateway broker attachment-ownership rejection for a fault-injected thread mismatch",
  retainSuccessLogs: true,
}, async context => {
  const mobileWeb = await exportMobileWeb(context, {
    label: "task-flow-send-pending-mobile-export",
    outputName: "mobile-web-export",
    dependencyRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
    deployMount: true,
  });
  const mobileDist = mobileWeb.path;
  const gatewayManifest = await buildGatewayMobileWebManifest(mobileDist, {
    expectedFiles: mobileWeb.bundleFiles,
  });
  await writeGatewayMobileWebManifest(mobileDist, gatewayManifest);
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const seedPrompt = "TASK_FLOW_COMPOSER_SEED";
  const otherOwnerPrompt = "TASK_FLOW_OTHER_OWNER_SEED";
  const promptA = "TASK_FLOW_SEND_A_PENDING_REJECT";
  const draftB = "TASK_FLOW_DRAFT_B_MUST_SURVIVE";
  const unknownPromptC = "TASK_FLOW_UNKNOWN_RECEIPT_VERIFY";
  const attachmentA = "task-flow-failed-A-attachment.txt";
  const attachmentContentA = Buffer.from("attachment belongs to failed submission A\n", "utf8");

  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    delayedRequestNumber: 4,
    streamDelayMs: 30_000,
    textOnlyResponse: ({ userText }) => `TASK_FLOW_REPLY:${userText}`,
  });
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "task-flow-composer",
    permission_mode: "yolo",
    providers: {
      "task-flow-composer": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "task-flow-composer-model",
        context_window_tokens: 128000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", {
    "task-flow-composer": { type: "api", key: "task-flow-composer-key" },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Local",
    transport: "local",
    command: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true,
    label: "task-flow-send-pending-rejection-gateway",
    workspace,
    serversFile,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDist,
    },
  });
  await verifyMobileStaticEntry(context, gateway, mobileDist, mobileWeb, gatewayManifest);
  const chromium = await startChromium(context, { label: "task-flow-send-pending-rejection-chromium" });
  const page = await chromium.newPage({ locale: "zh-CN" });
  assert.equal(await page.evaluate(() => navigator.language), "zh-CN", "task flow uses a pinned Chinese browser locale for its localized controls");
  await page.setViewportSize({ width: viewportWidth, height: 844 });

  const diagnostics = [];
  const rpcSockets = [];
  const rpcRequests = [];
  const rpcResponses = [];
  const rpcTimeline = [];
  const startedNotifications = [];
  const visibleControlDiagnostics = [];
  const pickerEvidence = [];
  let heldSocket = null;
  let heldRemoteError = null;
  let heldRawResponse = null;
  let heldUnknownStartResponse = null;
  let rejectFirstAOnly = true;
  page.on("pageerror", error => diagnostics.push({ kind: "pageerror", message: error.message }));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push({ kind: message.type(), message: message.text() });
  });
  await page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    let workspaceQuery = null;
    try { workspaceQuery = new URL(socket.url()).searchParams.get("workspace"); } catch {}
    const socketRecord = { socketIndex: rpcSockets.length, workspace: workspaceQuery, closed: false };
    rpcSockets.push(socketRecord);
    socket.onClose(() => { socketRecord.closed = true; });
    const methodById = new Map();
    socket.onMessage(raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      if (message.id !== undefined && message.method) methodById.set(message.id, message.method);
      if (message.method === "turn/start") {
        const text = (message.params?.input ?? []).filter(item => item?.type === "text").map(item => String(item.text ?? "")).join("\n");
        rpcRequests.push({ id: message.id, method: message.method, threadId: message.params?.threadId ?? null, clientMessageId: message.params?.clientMessageId ?? null, text, attachments: attachmentManifest(text), socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex });
        if (text.includes(promptA) && rejectFirstAOnly) {
          rejectFirstAOnly = false;
          heldSocket = socket;
          const altered = { ...message, params: { ...message.params, threadId: "task-flow-no-such-thread" } };
          upstream.send(JSON.stringify(altered));
          return;
        }
      } else if (message.method === "turn/receipt/read") {
        rpcRequests.push({ id: message.id, method: message.method, threadId: message.params?.threadId ?? null, clientMessageId: message.params?.clientMessageId ?? null, socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex });
      } else if (message.method === "attachment/save") {
        rpcRequests.push({ id: message.id, method: message.method, filename: message.params?.filename ?? null, contentBase64Length: message.params?.content_base64?.length ?? 0, socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex });
      } else if (message.method === "gateway/attachments/retain") {
        rpcRequests.push({ id: message.id, method: message.method, paths: message.params?.paths ?? [], socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex });
      } else if (message.method === "initialize") {
        rpcRequests.push({ id: message.id, method: message.method, socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex });
      } else if (message.method?.startsWith("attachment/retention/")) {
        rpcRequests.push({
          id: message.id, method: message.method,
          filename: message.params?.filename ?? null, size: message.params?.size ?? null,
          ownerRequestId: message.params?.ownerRequest?.clientOwnerRequestId ?? null,
          clientUploadId: message.params?.clientUploadId ?? null,
          offset: message.params?.offset ?? null, length: message.params?.length ?? null,
          hasContent: typeof message.params?.contentBase64 === "string" || typeof message.params?.content_base64 === "string",
          socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex,
        });
      }
      if (typeof message.method === "string") {
        const lastRequest = rpcRequests.at(-1);
        const request = lastRequest?.id === message.id && lastRequest?.socketIndex === socketRecord.socketIndex ? lastRequest : null;
        rpcTimeline.push({ order: rpcTimeline.length, direction: "request", id: message.id ?? null, method: message.method, socketIndex: socketRecord.socketIndex, request });
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
      if (message.method === "turn/started") {
        const notification = { threadId: message.params?.threadId ?? null, turnId: message.params?.turnId ?? null, socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex };
        startedNotifications.push(notification);
        rpcTimeline.push({ order: rpcTimeline.length, direction: "notification", method: "turn/started", socketIndex: socketRecord.socketIndex, params: notification });
      }
      const method = methodById.get(message.id);
      if (method === "turn/start" && heldSocket === socket && message.error) {
        heldRemoteError = {
          id: message.id,
          method,
          socketIndex: socketRecord.socketIndex,
          code: message.error.code ?? null,
          message: String(message.error.message ?? ""),
        };
        heldRawResponse = raw;
        rpcTimeline.push({ order: rpcTimeline.length, direction: "intercepted-response", method, socketIndex: socketRecord.socketIndex, id: message.id, ok: false, errorCode: heldRemoteError.code, deliveredToBrowser: false });
        return;
      }
      if (method === "turn/start" && !message.error && !heldUnknownStartResponse) {
        const request = rpcRequests.find(value => value.id === message.id && value.method === "turn/start" && value.socketIndex === socketRecord.socketIndex);
        if (request?.text.includes(unknownPromptC) && message.result?.turn?.id) {
          heldUnknownStartResponse = {
            id: message.id,
            threadId: request.threadId,
            clientMessageId: request.clientMessageId,
            turnId: message.result.turn.id,
            status: message.result.turn.status ?? null,
            socketWorkspace: workspaceQuery,
            socketIndex: socketRecord.socketIndex,
            deliveredToBrowser: false,
          };
          rpcTimeline.push({ order: rpcTimeline.length, direction: "intercepted-response", method, socketIndex: socketRecord.socketIndex, id: message.id, ok: true, turnId: message.result.turn.id, status: message.result.turn.status ?? null, deliveredToBrowser: false });
          return;
        }
      }
      if (message.id !== undefined) {
        const response = {
          id: message.id,
          method,
          socketIndex: socketRecord.socketIndex,
          ok: !message.error,
          errorCode: message.error?.code ?? null,
          errorMessage: message.error?.message ?? null,
          result: method === "attachment/save"
            ? { path: message.result?.path ?? null }
            : method === "initialize"
              ? {
                retentionCapability: message.result?.capabilities?.experimental?.stagedAttachmentRetentionReceiptsV1 === true,
                uploadAdmissionAvailable: Boolean(message.result?.attachmentUploadAdmission),
              }
              : method?.startsWith("attachment/retention/upload/")
                ? {
                  lookupState: message.result?.lookup?.state ?? null,
                  hasStageRef: Boolean(message.result?.stageRef ?? message.result?.lookup?.stageRef),
                }
                : method === "turn/receipt/read"
                  ? { receipt: message.result?.receipt ? {
                    threadId: message.result.receipt.threadId ?? null,
                    turnId: message.result.receipt.turnId ?? null,
                    status: message.result.receipt.status ?? null,
                  } : null }
                  : undefined,
          socketWorkspace: workspaceQuery,
        };
        rpcResponses.push(response);
        rpcTimeline.push({ order: rpcTimeline.length, direction: "response", ...response });
      }
      socket.send(raw);
    });
  });

  try {
    await connect(page, gateway);
    const initialNewTask = await uniqueVisibleTestId(page, "new-workspace", "initial Home new-task action");
    visibleControlDiagnostics.push({ stage: "initial-home", testId: "new-workspace", nodes: initialNewTask.nodes });
    await initialNewTask.locator.click();
    await page.getByTestId("new-task-advanced").click();
    await page.getByTestId("server-option-local").click();
    await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("new-workspace-prompt").fill(seedPrompt);
    await page.getByTestId("create-workspace").click();
    await page.getByText(`TASK_FLOW_REPLY:${seedPrompt}`, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    const threadId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1));
    await page.getByLabel("打开任务列表").click();
    await page.getByTestId("mobile-drawer").getByLabel("主页").click();
    const homeAfterSeed = await uniqueVisibleTestId(page, "new-workspace", "Home after seed task");
    visibleControlDiagnostics.push({ stage: "home-after-seed", testId: "new-workspace", nodes: homeAfterSeed.nodes });
    await homeAfterSeed.locator.click();
    await page.getByTestId("new-task-advanced").click();
    await page.getByTestId("server-option-local").click();
    await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("new-workspace-prompt").fill(otherOwnerPrompt);
    await page.getByTestId("create-workspace").click();
    await page.getByText("TASK_FLOW_REPLY:" + otherOwnerPrompt, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    const otherThreadId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1));
    assert.notEqual(otherThreadId, threadId, "Owner isolation probe must use a distinct TaskRuntime");
    await page.getByLabel("打开任务列表").click();
    await page.getByTestId("mobile-drawer").getByLabel("主页").click();
    const homeBeforeA = await uniqueVisibleTestId(page, "new-workspace", "Home before returning to A");
    visibleControlDiagnostics.push({ stage: "home-before-A", testId: "new-workspace", nodes: homeBeforeA.nodes });
    const alphaRow = await uniqueVisibleTestId(page, `thread-${threadId}`, "Home Alpha row");
    visibleControlDiagnostics.push({ stage: "home-before-A", testId: `thread-${threadId}`, nodes: alphaRow.nodes });
    await alphaRow.locator.click();
    await waitFor(() => decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)) === threadId, 30_000, "return to original task before rejection probe");
    const composer = (await uniqueVisibleTestId(page, "message-input", "Alpha composer before rejection")).locator;
    await composer.waitFor({ state: "visible", timeout: 30_000 });

    await page.getByTestId("composer-attachment").click();
    await stageTaskFlowAttachment(page, context, attachmentA, attachmentContentA, pickerEvidence, rpcTimeline, rpcResponses);
    await composer.fill(promptA);
    await (await uniqueVisibleTestId(page, "send-message", "Alpha initial send action")).locator.click();
    await waitFor(() => Boolean(heldRemoteError), 30_000, "Gateway broker ownership rejection for altered turn/start attachment binding");

    await composer.fill(draftB);
    assert.equal(await composer.inputValue(), draftB, "Draft B must be present while turn A's RPC rejection is held");
    assert.equal(heldRemoteError.code, -32048, "The Gateway broker must reject a retained attachment bound to another thread or authorization");
    assert.match(heldRemoteError.message, /Retained attachment is bound to another thread or authorization/,
      "The held turn/start error must identify the attachment ownership conflict");
    await page.waitForTimeout(600);
    heldSocket.send(heldRawResponse);
    rpcTimeline.push({
      order: rpcTimeline.length,
      direction: "harness-delivery",
      method: heldRemoteError.method,
      id: heldRemoteError.id,
      socketIndex: heldRemoteError.socketIndex,
      response: "held rejection response released to browser",
    });
    heldSocket = null;
    await waitFor(async () => await composer.inputValue() === draftB, 30_000, "draft B remains in the composer after remote rejection");
    await page.waitForTimeout(600);

    const composerValueAfterReject = await composer.inputValue();
    const visibleUserTexts = await page.getByTestId("message-user").allInnerTexts();
    const aVisibleUserCount = await page.getByTestId("message-user").filter({ hasText: promptA }).count();
    const failedCards = page.getByTestId("failed-submission");
    const failedCard = failedCards.filter({ hasText: promptA }).first();
    await failedCard.waitFor({ state: "visible", timeout: 30_000 });
    const failedSubmissionContent = await failedCard.getByTestId("failed-submission-content").innerText();
    const failedSubmissionError = await failedCard.getByTestId("failed-submission-error").innerText();
    const retryButton = failedCard.getByTestId("retry-failed-submission");
    const retryButtonEnabledAfterReject = !(await retryButton.isDisabled());
    const failedAttachmentList = failedCard.getByTestId("failed-submission-attachments");
    const failedAttachmentChip = failedAttachmentList.getByTestId(`staged-attachment-${encodeURIComponent(attachmentA)}`);
    await failedAttachmentChip.waitFor({ state: "visible", timeout: 30_000 });
    const postRejectionTaskState = await inspectTaskComposerState(page, threadId, promptA);
    const sendEnabledAfterReject = postRejectionTaskState.controls.sendMessage.playwrightEnabled;
    assert.equal(failedSubmissionContent.trim(), promptA, "The visible failed-submission-content must contain exact rejected A");
    assert.ok(failedSubmissionError.length > 0, "The failed-submission card must disclose the definite app-server rejection");
    assert.equal(await failedCards.filter({ hasText: promptA }).count(), 1, "A must have exactly one independent failed-submission card");
    assert.equal(retryButtonEnabledAfterReject, true, "Failed A must expose an enabled manual retry while the task is idle");
    const rejectedTurnStart = rpcRequests.find(value => value.method === "turn/start" && value.text.includes(promptA));
    assert.ok(rejectedTurnStart?.clientMessageId, "Rejected A must carry a stable clientMessageId");
    assert.equal(rejectedTurnStart.attachments?.length, 1, "A's turn/start must carry its attachment metadata");
    assert.equal(rejectedTurnStart.attachments[0]?.filename, attachmentA, "The retained attachment must belong to A");
    const attachmentSave = rpcRequests.find(value => value.method === "attachment/save" && value.filename === attachmentA && value.socketIndex === rejectedTurnStart.socketIndex);
    const attachmentSaveResponse = attachmentSave ? rpcResponses.find(value => value.id === attachmentSave.id && value.method === "attachment/save" && value.socketIndex === attachmentSave.socketIndex) : null;
    const attachmentRetain = attachmentSaveResponse?.result?.path
      ? rpcRequests.find(value => value.method === "gateway/attachments/retain" && value.paths.includes(attachmentSaveResponse.result.path) && value.socketIndex === attachmentSave.socketIndex)
      : null;
    assert.ok(attachmentSaveResponse?.ok && attachmentSaveResponse.result.path, "The browser must upload A's file through app-server attachment/save");
    assert.ok(attachmentRetain, "The browser must retain A's uploaded path before the turn starts");
    assert.equal(rejectedTurnStart.attachments[0]?.path, attachmentSaveResponse.result.path, "The rejected turn must carry the uploaded A attachment path");
    assert.ok(rpcRequests.indexOf(attachmentRetain) < rpcRequests.indexOf(rejectedTurnStart), "A's attachment must be retained before its turn/start is sent");
    await context.writeArtifactJson("after-rejection-state.json", {
      route: new URL(page.url()).pathname,
      threadId,
      promptA,
      draftB,
      composerValueAfterReject,
      sendEnabledAfterReject,
      postRejectionTaskState,
      failedSubmissionContent,
      failedSubmissionError,
      retryEnabled: retryButtonEnabledAfterReject,
      failedAttachment: await failedAttachmentChip.innerText(),
      rejectedClientMessageId: rejectedTurnStart.clientMessageId,
      rejectedAttachmentMetadata: rejectedTurnStart.attachments,
      visibleUserTexts,
      providerRequestCount: model.requests.length,
      rpcRequests,
      diagnostics,
    });
    await page.screenshot({ path: context.pathInArtifacts("after-rejection.png") });
    assert.equal(composerValueAfterReject, draftB, "Draft B must remain in the composer after A is rejected");
    assert.equal(postRejectionTaskState.controls.sendMessage.visibleCount, 1, "Idle task must render exactly one visible send control for draft B");
    assert.equal(sendEnabledAfterReject, true, "The visible send action must be enabled for retained draft B after A's definite rejection");
    const visibleText = (await page.locator("body").innerText()).slice(0, 10_000);
    const aInComposer = composerValueAfterReject.includes(promptA);
    const aInTranscript = aVisibleUserCount > 0 || visibleUserTexts.some(text => text.includes(promptA));
    const aInFailureRecovery = failedSubmissionContent.trim() === promptA && retryButtonEnabledAfterReject;
    const recoverableA = aInFailureRecovery;
    const aTurnStartRequestsAfterReject = rpcRequests.filter(value => value.method === "turn/start" && value.text.includes(promptA));
    const providerPrompts = model.requests.map(request => [...(request.messages ?? [])].reverse().find(message => message?.role === "user")?.content).filter(Boolean);
    const noAutomaticProviderSend = model.requests.every(request => !(request.messages ?? []).some(message => message?.role === "user" && String(message.content).includes(promptA)));
    const noAutomaticRetry = aTurnStartRequestsAfterReject.length === 1 && noAutomaticProviderSend;

    await page.waitForTimeout(600);
    await page.getByLabel("打开任务列表").click();
    await page.getByTestId("mobile-drawer").getByLabel("主页").click();
    const homeBeforeOther = await uniqueVisibleTestId(page, "new-workspace", "Home before opening other owner");
    visibleControlDiagnostics.push({ stage: "home-before-other-owner", testId: "new-workspace", nodes: homeBeforeOther.nodes });
    const otherRow = await uniqueVisibleTestId(page, `thread-${otherThreadId}`, "Home other-owner row");
    visibleControlDiagnostics.push({ stage: "home-before-other-owner", testId: `thread-${otherThreadId}`, nodes: otherRow.nodes });
    await otherRow.locator.click();
    await waitFor(() => decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)) === otherThreadId, 30_000, "route to other TaskRuntime owner");
    await (await uniqueVisibleTestId(page, "message-input", "other-owner composer")).locator.waitFor({ state: "visible", timeout: 30_000 });
    const otherOwnerFailedCardCount = await page.getByTestId("failed-submission").count();
    await page.getByLabel("打开任务列表").click();
    await page.getByTestId("mobile-drawer").getByLabel("主页").click();
    const homeBeforeARemount = await uniqueVisibleTestId(page, "new-workspace", "Home before remounting A");
    visibleControlDiagnostics.push({ stage: "home-before-A-again", testId: "new-workspace", nodes: homeBeforeARemount.nodes });
    const alphaRowAgain = await uniqueVisibleTestId(page, `thread-${threadId}`, "Home Alpha row after rejection");
    visibleControlDiagnostics.push({ stage: "home-before-A-again", testId: `thread-${threadId}`, nodes: alphaRowAgain.nodes });
    await alphaRowAgain.locator.click();
    await waitFor(() => decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)) === threadId, 30_000, "remount original TaskRuntime owner");
    await (await uniqueVisibleTestId(page, "message-input", "remounted Alpha composer")).locator.waitFor({ state: "visible", timeout: 30_000 });
    const remountedComposerValue = await (await uniqueVisibleTestId(page, "message-input", "remounted Alpha composer")).locator.inputValue();
    const remountedCard = page.getByTestId("failed-submission").filter({ hasText: promptA }).first();
    await remountedCard.waitFor({ state: "visible", timeout: 30_000 });
    const remountedFailedContent = await remountedCard.getByTestId("failed-submission-content").innerText();
    await remountedCard.getByTestId("failed-submission-attachments").getByTestId(`staged-attachment-${encodeURIComponent(attachmentA)}`).waitFor({ state: "visible", timeout: 30_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await (await uniqueVisibleTestId(page, "message-input-root", "Alpha composer root after hard reload")).locator.waitFor({ state: "visible", timeout: 30_000 });
    const reloadComposer = (await uniqueVisibleTestId(page, "message-input", "Alpha composer after hard reload")).locator;
    await waitFor(async () => await reloadComposer.inputValue() === draftB, 30_000, "B composer draft restored after hard reload");
    const reloadedCard = page.getByTestId("failed-submission").filter({ hasText: promptA }).first();
    await reloadedCard.waitFor({ state: "visible", timeout: 30_000 });
    const reloadedFailedContent = await reloadedCard.getByTestId("failed-submission-content").innerText();
    const reloadedAttachmentChip = reloadedCard.getByTestId("failed-submission-attachments").getByTestId(`staged-attachment-${encodeURIComponent(attachmentA)}`);
    await reloadedAttachmentChip.waitFor({ state: "visible", timeout: 30_000 });
    const reloadedAttachment = await reloadedAttachmentChip.innerText();
    const reloadedRetry = reloadedCard.getByTestId("retry-failed-submission");
    assert.equal(reloadedFailedContent.trim(), promptA, "Hard reload must restore A in its independent failed-submission card");
    assert.equal(await reloadComposer.inputValue(), draftB, "Hard reload must restore B as the independent composer draft");
    const aStartsBeforeRetry = rpcRequests.filter(value => value.method === "turn/start" && value.text.includes(promptA));
    const aProviderCallsBeforeRetry = model.requests.filter(request => (request.messages ?? []).some(message => message?.role === "user" && String(message.content).includes(promptA)));
    assert.equal(aStartsBeforeRetry.length, 1, "Hard reload must not automatically replay rejected A");
    assert.equal(aProviderCallsBeforeRetry.length, 0, "Rejected A must not reach the provider before explicit retry");
    await context.writeArtifactJson("after-hard-reload-before-retry.json", {
      route: new URL(page.url()).pathname,
      threadId,
      promptA,
      draftB,
      failedSubmissionContent: reloadedFailedContent,
      composerValue: await reloadComposer.inputValue(),
      attachment: reloadedAttachment,
      attachmentMetadata: rejectedTurnStart.attachments,
      clientMessageId: rejectedTurnStart.clientMessageId,
      turnStartsForA: aStartsBeforeRetry,
      providerACount: aProviderCallsBeforeRetry.length,
      rpcRequests,
      diagnostics,
    });
    await page.screenshot({ path: context.pathInArtifacts("after-hard-reload-before-retry.png") });
    await reloadedRetry.click();
    await page.getByText("TASK_FLOW_REPLY:" + promptA, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await waitFor(() => rpcRequests.filter(value => value.method === "turn/start" && value.text.includes(promptA)).length === aStartsBeforeRetry.length + 1, 30_000, "manual retry request reaches the Gateway");
    await waitFor(() => model.requests.some(request => (request.messages ?? []).some(message => message?.role === "user" && String(message.content).includes(promptA))), 30_000, "manual retry reaches the deterministic provider");
    await waitFor(async () => await page.getByTestId("failed-submission").count() === 0, 30_000, "successful retry removes A's failure card");
    const composerValueAfterRetry = await (await uniqueVisibleTestId(page, "message-input", "Alpha composer after retry")).locator.inputValue();
    const providerPromptsAfterRetry = model.requests.map(request => [...(request.messages ?? [])].reverse().find(message => message?.role === "user")?.content).filter(Boolean);
    const aTurnStartRequestsAfterRetry = rpcRequests.filter(value => value.method === "turn/start" && value.text.includes(promptA));
    const retriedAProviderCount = model.requests.filter(request => (request.messages ?? []).some(message => message?.role === "user" && String(message.content).includes(promptA))).length;
    const providerARequest = model.requests.find(request => (request.messages ?? []).some(message => message?.role === "user" && String(message.content).includes(promptA)));
    const retriedClientMessageIds = aTurnStartRequestsAfterRetry.map(value => value.clientMessageId);
    const retriedAttachmentMetadata = aTurnStartRequestsAfterRetry.at(-1)?.attachments ?? [];
    const bAutoSent = rpcRequests.some(value => value.method === "turn/start" && value.text.includes(draftB)) || providerPromptsAfterRetry.some(value => String(value).includes(draftB));
    await page.screenshot({ path: context.pathInArtifacts("after-manual-retry.png") });
    await context.writeArtifactJson("after-manual-retry-state.json", {
      route: new URL(page.url()).pathname,
      threadId,
      viewportWidth,
      composerValue: composerValueAfterRetry,
      retriedClientMessageIds,
      retriedAttachmentMetadata,
      providerReceivedAttachmentA: Boolean(providerARequest && JSON.stringify(providerARequest).includes(attachmentA)),
      retriedAProviderCount,
      bAutoSent,
      rpcRequests: rpcRequests.filter(value => value.method === "turn/start" && (value.text.includes(promptA) || value.text.includes(draftB))),
      diagnostics,
    });

    await page.getByLabel("打开任务列表").click();
    await page.getByTestId("mobile-drawer").getByLabel("主页").click();
    const homeBeforeUnknown = await uniqueVisibleTestId(page, "new-workspace", "Home before unknown receipt task");
    visibleControlDiagnostics.push({ stage: "home-before-unknown", testId: "new-workspace", nodes: homeBeforeUnknown.nodes });
    const otherRowForUnknown = await uniqueVisibleTestId(page, `thread-${otherThreadId}`, "Home other-owner row before C");
    visibleControlDiagnostics.push({ stage: "home-before-unknown", testId: `thread-${otherThreadId}`, nodes: otherRowForUnknown.nodes });
    await otherRowForUnknown.locator.click();
    await waitFor(() => decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)) === otherThreadId, 30_000, "open the independent task for receipt verification");
    const unknownComposer = (await uniqueVisibleTestId(page, "message-input", "other-owner composer before C")).locator;
    await unknownComposer.waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(async () => await unknownComposer.inputValue() === "", 30_000, "independent task composer is empty");
    await unknownComposer.fill(unknownPromptC);
    await (await uniqueVisibleTestId(page, "send-message", "C send action")).locator.click();
    await waitFor(() => Boolean(heldUnknownStartResponse), 30_000, "app-server accepts C while its start ACK is withheld");
    await waitFor(() => startedNotifications.some(value => value.threadId === otherThreadId && value.turnId === heldUnknownStartResponse.turnId && value.socketIndex === heldUnknownStartResponse.socketIndex), 30_000, "turn/started for C before losing its ACK");
    await waitFor(() => model.requests.length >= 4, 30_000, "delayed provider accepts C exactly once");
    assert.equal(heldUnknownStartResponse.threadId, otherThreadId);
    assert.equal(heldUnknownStartResponse.status, "running");
    await page.reload({ waitUntil: "domcontentloaded" });
    await (await uniqueVisibleTestId(page, "message-input-root", "C owner composer root after reload")).locator.waitFor({ state: "visible", timeout: 30_000 });
    const unknownCard = page.getByTestId("failed-submission").filter({ hasText: unknownPromptC }).first();
    await unknownCard.waitFor({ state: "visible", timeout: 30_000 });
    const unknownCardContent = await unknownCard.getByTestId("failed-submission-content").innerText();
    const verifyButton = unknownCard.getByTestId("verify-failed-submission");
    await verifyButton.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await verifyButton.isDisabled(), false, "An unknown accepted send must offer an enabled verify action after hard reload");
    assert.equal(await unknownCard.getByTestId("retry-failed-submission").count(), 0, "Unknown acceptance must not expose a blind resend action");
    const cTurnStartsBeforeVerify = rpcRequests.filter(value => value.method === "turn/start" && value.text.includes(unknownPromptC));
    const cProviderCallsBeforeVerify = model.requests.filter(request => (request.messages ?? []).some(message => message?.role === "user" && String(message.content).includes(unknownPromptC)));
    assert.equal(cTurnStartsBeforeVerify.length, 1, "Reload must not automatically replay accepted C");
    assert.equal(cProviderCallsBeforeVerify.length, 1, "The delayed provider must have received C exactly once before verify");
    await context.writeArtifactJson("unknown-receipt-before-verify.json", {
      route: new URL(page.url()).pathname,
      threadId: otherThreadId,
      content: unknownCardContent,
      acceptedStart: heldUnknownStartResponse,
      turnStarts: cTurnStartsBeforeVerify,
      providerCalls: cProviderCallsBeforeVerify.length,
      verifyEnabled: !(await verifyButton.isDisabled()),
      retryCount: await unknownCard.getByTestId("retry-failed-submission").count(),
      rpcRequests,
      diagnostics,
    });
    await page.screenshot({ path: context.pathInArtifacts("unknown-receipt-before-verify.png") });
    await verifyButton.click();
    const cReceiptRequest = rpcRequests.find(value => value.method === "turn/receipt/read" && value.threadId === otherThreadId && value.clientMessageId === heldUnknownStartResponse.clientMessageId);
    assert.ok(cReceiptRequest, "Verify must send turn/receipt/read for the original thread and clientMessageId");
    assert.equal(cReceiptRequest.threadId, otherThreadId);
    assert.equal(cReceiptRequest.clientMessageId, heldUnknownStartResponse.clientMessageId);
    assert.equal(cReceiptRequest.socketWorkspace, heldUnknownStartResponse.socketWorkspace, "Receipt verification must stay inside C's original isolated workspace");
    assert.ok(cReceiptRequest.socketIndex > heldUnknownStartResponse.socketIndex, "Receipt verification after hard reload must use the reconnected owned socket");
    await waitFor(() => rpcResponses.some(value => value.method === "turn/receipt/read"
      && value.socketIndex === cReceiptRequest.socketIndex
      && value.id === cReceiptRequest.id
      && value.ok
      && value.result?.receipt?.threadId === otherThreadId
      && value.result?.receipt?.turnId === heldUnknownStartResponse.turnId
      && ["running", "completed", "failed", "interrupted", "unknown"].includes(value.result?.receipt?.status)),
    30_000, "matching receipt response for accepted C returns the same thread and turn with a valid receipt status");
    const cReceiptResponse = rpcResponses.find(value => value.method === "turn/receipt/read"
      && value.socketIndex === cReceiptRequest.socketIndex
      && value.id === cReceiptRequest.id);
    await waitFor(async () => await page.getByTestId("failed-submission").filter({ hasText: unknownPromptC }).count() === 0, 30_000, "verified receipt clears C's unknown-submission card");
    const cTurnStartsAfterVerify = rpcRequests.filter(value => value.method === "turn/start" && value.text.includes(unknownPromptC));
    const cProviderCallsAfterVerify = model.requests.filter(request => (request.messages ?? []).some(message => message?.role === "user" && String(message.content).includes(unknownPromptC)));
    const cVisibleUserCount = await page.getByTestId("message-user").filter({ hasText: unknownPromptC }).count();
    assert.ok(cReceiptRequest, "Verify must read the receipt for C on its original thread");
    assert.ok(cReceiptResponse?.ok, "Verify must observe the accepted receipt response without resubmitting C");
    assert.ok(["running", "completed", "failed", "interrupted", "unknown"].includes(cReceiptResponse.result?.receipt?.status), "The receipt status must be a valid current status, which may have advanced since the original running ACK");
    assert.deepEqual(cReceiptResponse.result?.receipt, {
      threadId: otherThreadId,
      turnId: heldUnknownStartResponse.turnId,
      status: cReceiptResponse.result.receipt.status,
    }, "The receipt must preserve the accepted thread and turn identity while reporting its current status");
    assert.equal(cTurnStartsAfterVerify.length, 1, "Receipt verification must not issue another turn/start for C");
    assert.equal(cProviderCallsAfterVerify.length, 1, "Receipt verification must not duplicate C at the provider");
    assert.equal(cVisibleUserCount, 1, "Receipt reconciliation must leave exactly one visible user item for C");
    await page.getByLabel("打开任务列表").click();
    await page.getByTestId("mobile-drawer").getByLabel("主页").click();
    const homeAfterReceipt = await uniqueVisibleTestId(page, "new-workspace", "Home after C receipt verification");
    visibleControlDiagnostics.push({ stage: "home-after-C-verify", testId: "new-workspace", nodes: homeAfterReceipt.nodes });
    const alphaRowAfterReceipt = await uniqueVisibleTestId(page, `thread-${threadId}`, "Home Alpha row after C verify");
    visibleControlDiagnostics.push({ stage: "home-after-C-verify", testId: `thread-${threadId}`, nodes: alphaRowAfterReceipt.nodes });
    await alphaRowAfterReceipt.locator.click();
    await waitFor(() => decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)) === threadId, 30_000, "return to A after verifying C's receipt");
    const composerValueAfterOtherReceipt = await (await uniqueVisibleTestId(page, "message-input", "Alpha composer after C verify")).locator.inputValue();
    assert.equal(composerValueAfterOtherReceipt, draftB, "Verifying another task's receipt must not erase A's saved draft B");

    const evidence = {
      mobileWebExport: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        indexHtmlSha256: mobileWeb.indexHtmlSha256,
      },
      threadId,
      otherThreadId,
      viewportWidth,
      promptA,
      draftB,
      attachmentA,
      attachmentContentBytes: attachmentContentA.length,
      pickerEvidence,
      injectedWireMutation: { originalThreadId: threadId, sentThreadId: "task-flow-no-such-thread" },
      remoteRejection: heldRemoteError,
      composerValueAfterReject,
      sendEnabledAfterReject,
      visibleUserTexts,
      aVisibleUserCount,
      failedSubmissionContent,
      failedSubmissionError,
      retryButtonEnabledAfterReject,
      aInComposer,
      aInTranscript,
      aInFailureRecovery,
      recoverableA,
      aTurnStartRequestsAfterReject,
      rejectedClientMessageId: rejectedTurnStart.clientMessageId,
      rejectedAttachmentMetadata: rejectedTurnStart.attachments,
      noAutomaticProviderSend,
      noAutomaticRetry,
      otherOwnerFailedCardCount,
      remountedComposerValue,
      remountedFailedContent,
      reloadedComposerValue: await reloadComposer.inputValue(),
      reloadedFailedContent,
      reloadedAttachment,
      reloadedAttachmentMetadata: retriedAttachmentMetadata,
      retriedClientMessageIds,
      retriedAttachmentMetadata,
      retriedAProviderCount,
      providerReceivedAttachmentA: Boolean(providerARequest && JSON.stringify(providerARequest).includes(attachmentA)),
      composerValueAfterRetry,
      bAutoSent,
      unknownPromptC,
      heldUnknownStartResponse,
      startedNotifications,
      receiptStatusTransition: { acceptanceStatus: heldUnknownStartResponse.status, observedAfterReload: cReceiptResponse.result.receipt.status },
      unknownCardContent,
      cTurnStartsBeforeVerify,
      cProviderCallsBeforeVerify: cProviderCallsBeforeVerify.length,
      cReceiptRequest,
      cReceiptResponse,
      receiptStatusTransition: { acceptanceStatus: heldUnknownStartResponse.status, observedAfterReload: cReceiptResponse.result.receipt.status },
      cTurnStartsAfterVerify,
      cProviderCallsAfterVerify: cProviderCallsAfterVerify.length,
      cVisibleUserCount,
      composerValueAfterOtherReceipt,
      rpcSockets,
      rpcRequests,
      rpcResponses,
      rpcTimeline,
      delivery: taskFlowDeliveryEvidence(rpcRequests, rpcResponses, startedNotifications, heldRemoteError, heldUnknownStartResponse),
      providerPromptsBeforeRetry: providerPrompts,
      providerPromptsAfterRetry,
      pageVisibleTextAfterRejection: visibleText,
      diagnostics,
      visibleControlDiagnostics,
    };
    await context.writeArtifactJson("task-flow-send-pending-draft-rejection.json", evidence);
    await context.writeArtifactJson("visible-result.json", { finalRoute: new URL(page.url()).pathname, viewportWidth, composerValueAfterReject, sendEnabledAfterReject, failedSubmissionContent, failedAttachment: reloadedAttachment, pickerEvidence, retryButtonEnabledAfterReject, otherOwnerFailedCardCount, remountedComposerValue, remountedFailedContent, reloadedComposerValue: await reloadComposer.inputValue(), reloadedFailedContent, retriedClientMessageIds, retriedAttachmentMetadata, providerReceivedAttachmentA: Boolean(providerARequest && JSON.stringify(providerARequest).includes(attachmentA)), retriedAProviderCount, composerValueAfterRetry, bAutoSent, unknownPromptC, unknownCardContent, cReceiptRequest, cReceiptResponse, cTurnStartsAfterVerify, cProviderCallsAfterVerify: cProviderCallsAfterVerify.length, cVisibleUserCount, composerValueAfterOtherReceipt, visibleControlDiagnostics, diagnostics });
    await page.screenshot({ path: context.pathInArtifacts("after-unknown-receipt-verify.png") });
    await page.screenshot({ path: context.pathInArtifacts("A-draft-after-other-receipt.png") });

    assert.equal(composerValueAfterReject, draftB, "Draft B must remain in the composer after A is rejected");
    assert.equal(aInTranscript, false, "Rejected A must not appear as a successful transcript user item before retry");
    assert.equal(recoverableA, true, "A must remain visible in its failed-submission card with an enabled explicit retry action");
    assert.equal(noAutomaticRetry, true, "A must not reach the provider or be automatically retried after rejection");
    assert.equal(otherOwnerFailedCardCount, 0, "A's failed-submission card must not leak to another TaskRuntime owner");
    assert.equal(remountedComposerValue, draftB, "B must remain in the composer after remounting A's route");
    assert.equal(remountedFailedContent.trim(), promptA, "A's failed-submission card must survive a same-owner route remount");
    assert.equal(await reloadComposer.inputValue(), draftB, "B must survive a hard reload");
    assert.equal(reloadedFailedContent.trim(), promptA, "A's failed-submission card must survive a hard reload");
    assert.equal(retriedAttachmentMetadata.length, 1, "A's attachment must still be attached to the manual retry after hard reload");
    assert.equal(retriedAttachmentMetadata[0]?.filename, attachmentA, "A's original attachment metadata must be preserved on retry");
    assert.deepEqual(retriedAttachmentMetadata, rejectedTurnStart.attachments, "Manual retry must use A's exact persisted attachment metadata");
    assert.equal(rpcRequests.filter(value => value.method === "attachment/save" && value.filename === attachmentA).length, 1, "Manual retry must reuse A's uploaded file instead of uploading a duplicate");
    assert.equal(retriedAProviderCount, 1, "Manual retry must send A to the provider exactly once");
    assert.ok(providerARequest && JSON.stringify(providerARequest).includes(attachmentA), "The provider must receive A with its original attachment metadata");
    assert.equal(aTurnStartRequestsAfterRetry.length, 2, "Only the original rejected send and one manual retry may start A");
    assert.ok(retriedClientMessageIds[0], "Rejected A must have a stable clientMessageId");
    assert.ok(retriedClientMessageIds.every(value => value === retriedClientMessageIds[0]), "Manual retry must reuse A's original clientMessageId");
    assert.equal(composerValueAfterRetry, draftB, "A's successful retry must not overwrite B in the composer");
    assert.equal(bAutoSent, false, "B must remain an unsent draft after manually retrying A");
    assert.equal(unknownCardContent.trim(), unknownPromptC, "The unknown receipt card must identify its own pending submission");
    assert.ok(cReceiptRequest?.clientMessageId === heldUnknownStartResponse.clientMessageId, "Verify must use C's original stable clientMessageId");
    assert.ok(cReceiptResponse?.result?.receipt?.status, "The receipt verification result must include the accepted turn status");
    assert.equal(cTurnStartsAfterVerify.length, 1, "Unknown receipt verification must not replay C");
    assert.equal(cProviderCallsAfterVerify.length, 1, "Unknown receipt verification must not rerun C at the provider");
    assert.equal(cVisibleUserCount, 1, "Unknown receipt verification must reconcile to one transcript user item");
    assert.equal(composerValueAfterOtherReceipt, draftB, "B must stay saved in A after verifying C on another task");
    assert.deepEqual(diagnostics, [], "Mobile browser console/page diagnostics must remain empty");
    return { remoteRejection: heldRemoteError, composerValueAfterReject, recoverableA, pickerInputObserved: pickerEvidence.length === 1 && pickerEvidence[0].filechooserObserved && pickerEvidence[0].chooserSetFilesCompleted && pickerEvidence[0].inputType === "file" && pickerEvidence[0].inputHidden, attachmentUploadBranch: pickerEvidence[0]?.uploadProtocol?.branch ?? "unknown", unknownReceiptVerified: true, providerRequests: model.requests.length };
  } catch (error) {
    await context.writeArtifactJson("failure-state.json", {
      message: error instanceof Error ? error.message : String(error),
      route: new URL(page.url()).pathname,
      body: await page.locator("body").innerText().catch(() => ""),
      heldRemoteError,
      rpcSockets,
      rpcRequests,
      rpcResponses,
      rpcTimeline,
      delivery: taskFlowDeliveryEvidence(rpcRequests, rpcResponses, startedNotifications, heldRemoteError, heldUnknownStartResponse),
      startedNotifications,
      providerUserPrompts: model.requests.map(request => [...(request.messages ?? [])].reverse().find(message => message?.role === "user")?.content).filter(Boolean),
      providerRequestCount: model.requests.length,
      diagnostics,
      visibleControlDiagnostics,
      domNodeDiagnostics: {
        newWorkspace: await inspectDomTestId(page, "new-workspace").catch(() => []),
        messageInputRoots: await inspectDomTestId(page, "message-input-root").catch(() => []),
        sendMessage: await inspectDomTestId(page, "send-message").catch(() => []),
        queueMessage: await inspectDomTestId(page, "queue-message").catch(() => []),
        stopTurn: await inspectDomTestId(page, "stop-turn").catch(() => []),
      },
      taskComposerState: await inspectTaskComposerState(page, null, null).catch(error => ({ captureError: error instanceof Error ? error.message : String(error) })),
    });
    await page.screenshot({ path: context.pathInArtifacts("failure.png") }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }
});

async function connect(page, gateway) {
  await page.goto(`${gateway.baseUrl}/login?returnTo=%2Fmobile%2F`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  assert.ok(new URL(page.url()).pathname.startsWith("/mobile/"), "authentication must return to the mounted Mobile Web route");
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
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

async function stageTaskFlowAttachment(page, context, filename, buffer, pickerEvidence, rpcTimeline, rpcResponses) {
  const firstRequestOrder = rpcTimeline.length;
  const record = { stage: "failed-send attachment A", firstRequestOrder };
  try {
    Object.assign(record, await setExpoWebDocumentPickerFiles(page, { name: filename, mimeType: "text/plain", buffer }));
    pickerEvidence.push(record);
    await context.writeArtifactJson("mobile-document-picker-failed-send-attachment-a-selection.json", pickerEvidence);

    const composerFile = page.getByTestId(`composer-file-attachment-${encodeURIComponent(filename)}`);
    const chip = page.getByTestId(`staged-attachment-${encodeURIComponent(filename)}`);
    const row = page.getByTestId("retained-attachment-row").filter({ hasText: filename }).first();
    const retainedReady = row.getByText("上传已确认；尚未加入消息", { exact: true });
    const retainedError = page.getByTestId("retained-attachment-error");
    const alert = page.locator('[role="alert"]').first();
    const uiBranch = await Promise.any([
      composerFile.waitFor({ state: "visible", timeout: 30_000 }).then(() => "legacy-composer"),
      chip.waitFor({ state: "visible", timeout: 30_000 }).then(() => "legacy-composer"),
      retainedReady.waitFor({ state: "visible", timeout: 30_000 }).then(() => "retained-outbox"),
      retainedError.waitFor({ state: "visible", timeout: 30_000 }).then(() => "retained-error"),
      alert.waitFor({ state: "visible", timeout: 30_000 }).then(() => "attachment-error"),
    ]);
    const stageUi = await captureTaskFlowAttachmentUi(page, filename);
    await waitFor(() => {
      const protocol = taskFlowAttachmentProtocol(filename, rpcTimeline, rpcResponses, firstRequestOrder);
      return protocol.branch !== "none" && protocol.responses.length > 0 ? protocol : null;
    }, 30_000, "selected attachment upload RPC response");
    const protocol = taskFlowAttachmentProtocol(filename, rpcTimeline, rpcResponses, firstRequestOrder);
    Object.assign(record, { uiBranch, stageUi, uploadProtocol: protocol });
    await context.writeArtifactJson("mobile-document-picker-failed-send-attachment-a-evidence.json", pickerEvidence);
    assert.notEqual(protocol.negotiatedBranch, "unknown", "The same RPC socket must expose initialize negotiation before attachment upload");
    assert.equal(protocol.branch, protocol.negotiatedBranch,
      `Observed upload branch must match initialize negotiation (${protocol.negotiatedBranch}); visible stage was ${uiBranch}`);
    assert.ok(protocol.responses.some(response => response.ok), `${protocol.branch} upload must have an observed successful RPC response`);
    if (protocol.branch === "legacy") {
      assert.equal(uiBranch, "legacy-composer", "Legacy attachment/save must produce a sendable composer chip");
      assert.ok(protocol.responses.some(response => response.result?.path), "Legacy attachment/save must return the path used by send and retry");
    } else {
      assert.equal(protocol.initialization?.uploadAdmissionAvailable, true, "Negotiated retained upload must have an actual upload admission");
      assert.ok(protocol.responses.some(response => response.result?.hasStageRef), "Retained upload must return an observed stage reference");
      assert.equal(uiBranch, "legacy-composer", "Retained attachment staging must produce a sendable composer attachment before the rejected turn");
    }
    return record;
  } catch (error) {
    if (!pickerEvidence.includes(record)) {
      Object.assign(record, error?.pickerEvidence ?? {});
      pickerEvidence.push(record);
    }
    record.error = error instanceof Error ? error.message : String(error);
    Object.assign(record, {
      stageUi: await captureTaskFlowAttachmentUi(page, filename),
      uploadProtocol: taskFlowAttachmentProtocol(filename, rpcTimeline, rpcResponses, firstRequestOrder),
    });
    await context.writeArtifactJson("task-flow-attachment-stage-failure.json", {
      stage: record.stage,
      message: record.error,
      pickerEvidence,
      rpcTimeline,
      uploadProtocol: record.uploadProtocol,
      stageUi: record.stageUi,
      body: await page.locator("body").innerText().catch(() => ""),
    });
    await page.screenshot({ path: context.pathInArtifacts("task-flow-attachment-stage-failure.png") }).catch(() => {});
    throw error;
  }
}

async function captureTaskFlowAttachmentUi(page, filename) {
  const composerFile = page.getByTestId(`composer-file-attachment-${encodeURIComponent(filename)}`);
  const chip = page.getByTestId(`staged-attachment-${encodeURIComponent(filename)}`);
  const row = page.getByTestId("retained-attachment-row").filter({ hasText: filename }).first();
  return {
    filename,
    composerFileVisible: await composerFile.isVisible().catch(() => false),
    composerChipVisible: await chip.isVisible().catch(() => false) || await composerFile.isVisible().catch(() => false),
    retainedOutboxRowVisible: await row.isVisible().catch(() => false),
    retainedOutboxRowText: await row.innerText().catch(() => null),
    retainedOutboxError: await page.getByTestId("retained-attachment-error").innerText().catch(() => null),
    alertText: await page.locator('[role="alert"]').evaluateAll(elements => elements.map(element => (element.innerText || "").slice(0, 1_000))).catch(() => []),
  };
}

function taskFlowAttachmentProtocol(filename, rpcTimeline, rpcResponses, firstRequestOrder) {
  const requestEvents = rpcTimeline.filter(event => event.direction === "request" && event.order >= firstRequestOrder);
  const stageRequests = requestEvents.filter(event => event.method === "attachment/save" || event.method?.startsWith("attachment/retention/upload/"));
  const requestRecords = stageRequests.map(event => event.request).filter(Boolean);
  const legacyRequests = requestRecords.filter(request => request.method === "attachment/save" && request.filename === filename);
  const retainedRequests = requestRecords.filter(request => request.method?.startsWith("attachment/retention/upload/") && request.filename === filename);
  const matching = [...legacyRequests, ...retainedRequests];
  const socketIndex = matching.at(-1)?.socketIndex ?? null;
  const initializationRequest = rpcTimeline.find(event =>
    event.direction === "request" && event.method === "initialize" && event.socketIndex === socketIndex) ?? null;
  const initialization = initializationRequest
    ? rpcResponses.find(response => response.socketIndex === initializationRequest.socketIndex &&
      response.id === initializationRequest.id && response.method === initializationRequest.method) ?? null
    : null;
  const uploadResponses = rpcResponses.filter(response => matching.some(request =>
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
    requests: matching,
    responses: uploadResponses,
    initialization: initialization?.result ?? null,
  };
}

function taskFlowDeliveryEvidence(rpcRequests, rpcResponses, startedNotifications, heldRemoteError = null, heldUnknownStartResponse = null) {
  return {
    retentionUploadRequests: rpcRequests.filter(request => request.method?.startsWith("attachment/retention/upload/")),
    retentionConsumerRequests: rpcRequests.filter(request => request.method?.startsWith("attachment/retention/") && !request.method.startsWith("attachment/retention/upload/")),
    legacyRetentionRequests: rpcRequests.filter(request => request.method === "gateway/attachments/retain"),
    turnStartRequests: rpcRequests.filter(request => request.method === "turn/start"),
    turnStartResponses: rpcResponses.filter(response => response.method === "turn/start"),
    startedNotifications,
    heldRemoteError,
    heldUnknownStartResponse,
  };
}

async function uniqueVisibleTestId(page, testId, label) {
  const locator = page.locator(`[data-testid="${testId}"]:visible`);
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  const nodes = await inspectDomTestId(page, testId);
  const visibleCount = nodes.filter(node => node.playwrightVisible).length;
  assert.equal(visibleCount, 1, `${label} must resolve to one visible ${testId}; DOM: ${JSON.stringify(nodes)}`);
  assert.equal(await locator.count(), 1, `${label} locator must be unique in the visible DOM`);
  return { locator, nodes };
}

async function inspectDomTestId(page, testId) {
  return page.locator(`[data-testid="${testId}"]`).evaluateAll(nodes => nodes.map((node, index) => {
    const ancestors = [];
    let current = node;
    while (current && ancestors.length < 10) {
      const style = window.getComputedStyle(current);
      const rect = current.getBoundingClientRect();
      ancestors.push({
        tag: current.tagName,
        testId: current.getAttribute("data-testid"),
        ariaHidden: current.getAttribute("aria-hidden"),
        inert: current.hasAttribute("inert"),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        transform: style.transform,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
      current = current.parentElement;
    }
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      index,
      route: `${window.location.pathname}${window.location.search}`,
      playwrightVisible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.visibility !== "collapse",
      ariaHiddenAncestor: ancestors.some(ancestor => ancestor.ariaHidden === "true"),
      inertAncestor: ancestors.some(ancestor => ancestor.inert),
      element: {
        role: node.getAttribute("role"),
        ariaLabel: node.getAttribute("aria-label"),
        ariaDisabled: node.getAttribute("aria-disabled"),
        disabled: "disabled" in node ? Boolean(node.disabled) : null,
        className: typeof node.className === "string" ? node.className : null,
        text: (node.innerText ?? node.textContent ?? "").trim().slice(0, 240),
        value: "value" in node ? String(node.value ?? "").slice(0, 500) : null,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        cursor: style.cursor,
      },
      ancestors,
    };
  }));
}

async function inspectTaskComposerState(page, threadId, failedContent) {
  const routeParts = new URL(page.url()).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const taskSegment = routeParts.indexOf("task");
  const profileId = taskSegment >= 0 ? routeParts[taskSegment - 1] : null;
  const serverId = taskSegment >= 0 ? routeParts[taskSegment + 1] : null;
  const ownerThreadId = threadId ?? (taskSegment >= 0 ? routeParts[taskSegment + 2] : null);
  const controls = {};
  for (const [name, testId] of [
    ["sendMessage", "send-message"],
    ["queueMessage", "queue-message"],
    ["stopTurn", "stop-turn"],
  ]) {
    const nodes = await inspectDomTestId(page, testId);
    const visible = nodes.filter(node => node.playwrightVisible);
    controls[name] = {
      testId,
      visibleCount: visible.length,
      nodes,
      playwrightEnabled: visible.length === 1
        ? await page.locator(`[data-testid="${testId}"]:visible`).isEnabled().catch(() => null)
        : null,
    };
  }
  const composerInput = await inspectDomTestId(page, "message-input");
  const failedSubmissionCards = await page.locator('[data-testid="failed-submission"]:visible').evaluateAll(nodes => nodes.map(node => ({
    text: (node.innerText ?? node.textContent ?? "").trim().slice(0, 600),
    role: node.getAttribute("role"),
    ariaHidden: node.closest('[aria-hidden="true"]') !== null,
    rect: (() => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })(),
  }))).catch(() => []);
  let persistedWorkspaceViewState = null;
  let storageKey = null;
  if (profileId && serverId && ownerThreadId) {
    storageKey = `kcoder-studio:mobile-workspace-state:v3:${encodeURIComponent(profileId)}:${encodeURIComponent(serverId)}:${encodeURIComponent(ownerThreadId)}`;
    persistedWorkspaceViewState = await page.evaluate(({ key, failedText }) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) return { keyPresent: false, composerDraft: null, failedSubmissions: null, queuedMessages: null };
      try {
        const state = JSON.parse(raw);
        const matchingFailure = Array.isArray(state.failedSubmissions)
          ? state.failedSubmissions.filter(value => value?.content === failedText).map(value => ({
            content: value.content,
            outcome: value.outcome,
            error: value.error ?? null,
            attachmentCount: Array.isArray(value.attachments) ? value.attachments.length : null,
            attachmentFilenames: Array.isArray(value.attachments) ? value.attachments.map(item => item?.filename ?? null) : [],
          }))
          : [];
        return {
          keyPresent: true,
          composerDraft: typeof state.composerDraft === "string" ? state.composerDraft : null,
          queuedMessages: Array.isArray(state.queuedMessages) ? state.queuedMessages.map(value => ({ content: value?.content ?? null, attachmentCount: Array.isArray(value?.attachments) ? value.attachments.length : null })) : [],
          failedSubmissions: matchingFailure,
        };
      } catch {
        return { keyPresent: true, parseError: true };
      }
    }, { key: storageKey, failedText: failedContent }).catch(error => ({ readError: error instanceof Error ? error.message : String(error) }));
  }
  return {
    route: new URL(page.url()).pathname,
    owner: { profileId, serverId, threadId: ownerThreadId },
    composerInput,
    controls,
    uiSignals: {
      running: controls.stopTurn.visibleCount === 1 && controls.queueMessage.visibleCount === 1,
      idle: controls.stopTurn.visibleCount === 0 && controls.sendMessage.visibleCount === 1,
    },
    failedSubmissionCards,
    storageKey,
    persistedWorkspaceViewState,
  };
}

function attachmentManifest(text) {
  const block = /<kcoder_attachments version="1">\s*([\s\S]*?)\s*<\/kcoder_attachments>/.exec(text)?.[1];
  if (!block) return [];
  return block.split(/\r?\n/).filter(Boolean).map(line => {
    const value = JSON.parse(line);
    return {
      filename: value.filename ?? null,
      mimeType: value.mimeType ?? null,
      fileSize: value.fileSize ?? null,
      path: value.path ?? null,
    };
  });
}
