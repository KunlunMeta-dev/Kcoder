import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const viewportWidth = Number(process.env.KCODER_E2E_VIEWPORT_WIDTH || 390);
assert.ok([360, 390].includes(viewportWidth), "KCODER_E2E_VIEWPORT_WIDTH must be 360 or 390");
const kcoderBinary = process.env.KCODER_E2E_KCODER_BIN
  ? resolve(process.env.KCODER_E2E_KCODER_BIN)
  : resolve(repoRoot, "target/debug/kcoder");

await runE2E(import.meta.url, {
  testId: "task-flow-queued-start-ack-reload",
  tier: "full-integration",
  modelPolicy: "model-independent delayed deterministic provider; real Mobile queue, Gateway/app-server acceptance and reload recovery",
  retainSuccessLogs: true,
}, async context => {
  const configuredBackendBefore = await hashExecutableFile(kcoderBinary);
  const mobileWeb = await exportMobileWeb(context, {
    label: "task-flow-queued-start-ack-mobile-export",
    outputName: "mobile-web-export",
    dependencyRoot: resolve(
      repoRoot,
      "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules",
    ),
  });
  const mobileDist = mobileWeb.path;
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const firstPrompt = "TASK_FLOW_QUEUE_FIRST_RUNNING";
  const queuedPrompt = "TASK_FLOW_QUEUE_ACCEPTED_ACK_DROPPED";
  let releaseFirstProvider = false;
  let releaseQueuedProvider = false;
  const model = await startApprovalModelFixture(context, {
    responseSteps: ({ requestNumber, body }) => {
      const latestUser = [...(body.messages ?? [])].reverse().find(message => message?.role === "user");
      const latestText = typeof latestUser?.content === "string"
        ? latestUser.content
        : (latestUser?.content ?? []).map(part => typeof part?.text === "string" ? part.text : "").join("\n");
      const ready = requestNumber === 1
        ? () => releaseFirstProvider
        : requestNumber === 2
          ? () => releaseQueuedProvider
          : () => true;
      return [
        { ready, delta: { role: "assistant", content: `ACTIVE_STREAM_PARTIAL: ${latestText}` } },
        { delta: { role: "assistant", content: `TASK_FLOW_REPLY:${latestText}` } },
        { delta: {}, finishReason: "stop" },
      ];
    },
  });
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "task-flow-queue",
    permission_mode: "yolo",
    providers: {
      "task-flow-queue": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "task-flow-queue-model",
        context_window_tokens: 128000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        request_timeout_secs: 60,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", {
    "task-flow-queue": { type: "api", key: "task-flow-queue-key" },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Local",
    transport: "local",
    command: kcoderBinary,
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true,
    label: "task-flow-queued-start-ack-gateway",
    workspace,
    serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "task-flow-queued-start-ack-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: viewportWidth, height: 844 });

  const diagnostics = [];
  const rpcSockets = [];
  const rpcRequests = [];
  const rpcResponses = [];
  let rpcSequence = 0;
  const heldStartIds = new Set();
  const heldStartResponses = [];
  const startedNotifications = [];
  const turnCompletions = [];
  const resumedThreads = [];
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
    const methodsById = new Map();
    socket.onClose(() => { socketRecord.closed = true; });
    socket.onMessage(raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      if (message.id !== undefined && message.method) methodsById.set(message.id, message.method);
      if (message.method === "turn/start") {
        const text = (message.params?.input ?? []).filter(item => item?.type === "text").map(item => String(item.text ?? "")).join("\n");
        rpcRequests.push({ sequence: rpcSequence++, id: message.id, method: message.method, threadId: message.params?.threadId ?? null, clientMessageId: message.params?.clientMessageId ?? null, prompt: text.slice(0, 160), socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex });
      } else if (["thread/resume", "thread/read", "turn/receipt/read"].includes(message.method)) {
        rpcRequests.push({ sequence: rpcSequence++, id: message.id ?? null, method: message.method, threadId: message.params?.threadId ?? null, clientMessageId: message.params?.clientMessageId ?? null, socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex });
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
      if (message.method === "turn/started") {
        startedNotifications.push({ sequence: rpcSequence++, threadId: message.params?.threadId ?? null, turnId: message.params?.turnId ?? null, socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex });
      }
      if (message.method === "turn/completed") {
        const completion = { sequence: rpcSequence++, notification: message.method, threadId: message.params?.threadId ?? null, turnId: message.params?.turnId ?? null, status: message.params?.turn?.status ?? null, socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex };
        turnCompletions.push(completion);
        rpcResponses.push(completion);
      }
      const method = methodsById.get(message.id);
      if (method === "thread/resume" && message.result?.thread) resumedThreads.push({ threadId: message.result.thread.id, status: message.result.thread.status, socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex });
      if (method === "turn/start") {
        const request = rpcRequests.find(candidate => candidate.id === message.id && candidate.method === "turn/start" && candidate.socketIndex === socketRecord.socketIndex);
        if (request?.prompt.includes(queuedPrompt) && message.result && heldStartResponses.length === 0) {
          heldStartIds.add(`${socketRecord.socketIndex}:${message.id}`);
          heldStartResponses.push({ sequence: rpcSequence++, id: message.id, threadId: request.threadId, clientMessageId: request.clientMessageId, turnId: message.result.turn?.id ?? null, resultStatus: message.result.turn?.status ?? null, socketWorkspace: workspaceQuery, socketIndex: socketRecord.socketIndex, deliveredToBrowser: false });
          return;
        }
      }
      if (message.id !== undefined) rpcResponses.push({
        sequence: rpcSequence++,
        id: message.id,
        method,
        ok: !message.error,
        errorCode: message.error?.code ?? null,
        errorMessage: message.error?.message ?? null,
        result: method === "turn/receipt/read" ? {
          receipt: message.result?.receipt ? {
            threadId: message.result.receipt.threadId ?? null,
            turnId: message.result.receipt.turnId ?? null,
            status: message.result.receipt.status ?? null,
          } : null,
        } : undefined,
        socketWorkspace: workspaceQuery,
        socketIndex: socketRecord.socketIndex,
      });
      socket.send(raw);
    });
  });

  try {
    await connect(page, gateway);
    await page.getByTestId("new-workspace").click();
    await page.getByTestId("server-option-local").click();
    await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("new-workspace-prompt").fill(firstPrompt);
    await page.getByTestId("create-workspace").click();
    const threadRoute = page.waitForURL(/\/h\/[^/]+\/task\/local\/[^/?]+/, { timeout: 30_000 });
    await page.getByTestId("message-user").filter({ hasText: firstPrompt }).waitFor({ state: "visible", timeout: 30_000 });
    await threadRoute;
    const threadId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1));

    await page.getByTestId("queue-message").waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(() => model.requests.length >= 1, 30_000, "first provider request");
    await page.getByTestId("message-input").fill(queuedPrompt);
    await page.getByTestId("queue-message").click();
    await page.getByTestId("queued-message-0").filter({ hasText: queuedPrompt }).waitFor({ state: "visible", timeout: 10_000 });
    releaseFirstProvider = true;

    await waitFor(() => model.requests.length >= 2, 60_000, "queued provider request accepted");
    const queuedStart = rpcRequests.find(value => value.method === "turn/start" && value.prompt.includes(queuedPrompt));
    assert.ok(queuedStart?.clientMessageId, "The original queued turn/start must carry its stable clientMessageId");
    await waitFor(() => heldStartResponses.length === 1, 30_000, "accepted queued turn/start response to withhold");
    const heldAcceptedResponse = heldStartResponses[0];
    await waitFor(() => startedNotifications.some(value => value.threadId === threadId && value.turnId === heldAcceptedResponse.turnId), 30_000, "turn/started matching the withheld turn/start result");
    const acceptedQueuedTurn = startedNotifications.find(value => value.threadId === threadId && value.turnId === heldAcceptedResponse.turnId);
    assert.equal(queuedStart.threadId, threadId, "The queued send must belong to the active task thread");
    assert.equal(heldAcceptedResponse.threadId, threadId, "The withheld accepted response must belong to the same task thread");
    assert.equal(heldAcceptedResponse.clientMessageId, queuedStart.clientMessageId, "The server acceptance must correspond to the exact queued clientMessageId");
    assert.ok(acceptedQueuedTurn?.turnId, "The server must notify turn/started for the exact accepted turn whose response is withheld");
    assert.equal(acceptedQueuedTurn.socketIndex, heldAcceptedResponse.socketIndex, "The accepted notification and withheld response must use the same owned socket");
    assert.equal(heldAcceptedResponse.resultStatus, "running", "The withheld start response must show server acceptance while the provider is still gated");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    const queuedStartRequests = () => rpcRequests.filter(value => value.method === "turn/start" && value.prompt?.includes(queuedPrompt));
    const getReplayRequestAfterReload = () => queuedStartRequests().find(value => value.socketIndex > queuedStart.socketIndex) ?? null;
    await waitFor(() => Boolean(getReplayRequestAfterReload()) || model.requests.length >= 3, 30_000, "persisted queued item replay request after reload");
    const queueRowVisibleAfterReload = await page.getByTestId("queued-message-0").count() === 1;
    const replayRequestAfterReload = getReplayRequestAfterReload();
    const queuePresentAfterReload = queueRowVisibleAfterReload || Boolean(replayRequestAfterReload);
    if (replayRequestAfterReload) {
      await waitFor(() => rpcResponses.some(value => value.method === "turn/start"
        && value.id === replayRequestAfterReload.id
        && value.socketIndex === replayRequestAfterReload.socketIndex), 30_000, "duplicate queued turn/start response on its replay socket");
    }
    const replayDuplicateResponse = replayRequestAfterReload
      ? rpcResponses.find(value => value.id === replayRequestAfterReload.id
        && value.socketIndex === replayRequestAfterReload.socketIndex
        && value.method === "turn/start") ?? null
      : null;
    let receiptReadRequest = null;
    let matchingReceiptResponse = null;
    if (replayDuplicateResponse?.errorCode === -32047) {
      await waitFor(() => rpcRequests.some(value => value.method === "turn/receipt/read"
        && value.threadId === threadId
        && value.clientMessageId === queuedStart.clientMessageId
        && value.socketIndex === replayRequestAfterReload.socketIndex
        && value.sequence > replayDuplicateResponse.sequence), 30_000, "receipt/read for the duplicate acceptance on the replay socket");
      receiptReadRequest = rpcRequests.find(value => value.method === "turn/receipt/read"
        && value.threadId === threadId
        && value.clientMessageId === queuedStart.clientMessageId
        && value.socketIndex === replayRequestAfterReload.socketIndex
        && value.sequence > replayDuplicateResponse.sequence) ?? null;
      await waitFor(() => rpcResponses.some(value => value.method === "turn/receipt/read"
        && value.id === receiptReadRequest.id
        && value.socketIndex === receiptReadRequest.socketIndex
        && value.ok
        && value.result?.receipt?.threadId === threadId
        && value.result?.receipt?.turnId === heldAcceptedResponse.turnId
        && ["running", "completed", "failed", "interrupted", "unknown"].includes(value.result?.receipt?.status)),
      30_000, "receipt response for the exact queued replay identity and current accepted-turn status");
      matchingReceiptResponse = rpcResponses.find(value => value.method === "turn/receipt/read"
        && value.id === receiptReadRequest.id
        && value.socketIndex === receiptReadRequest.socketIndex) ?? null;
    }
    releaseQueuedProvider = true;
    await waitFor(() => model.requestOutcomes[1]?.closed === true, 60_000, "terminal provider transport outcome for the originally accepted queued turn");
    await waitFor(async () => await page.getByTestId("queued-messages").isHidden().catch(() => true), 30_000, "queue item removal after accepted turn completion");
    await page.waitForTimeout(500);
    const providerUserPrompts = model.requests
      .map(request => [...(request.messages ?? [])].reverse().find(message => message?.role === "user")?.content)
      .filter(Boolean)
      .map(value => typeof value === "string" ? value : JSON.stringify(value));
    const duplicateExecutions = providerUserPrompts.filter(value => String(value).includes(queuedPrompt)).length;
    const visibleQueueItems = await page.getByTestId("message-user").filter({ hasText: queuedPrompt }).count();
    const visibleQueueRowsAfterReconciliation = await page.getByTestId("queued-message-0").count();
    const visibleUserMessages = await page.getByTestId("message-user").allInnerTexts();
    const replayedStarts = queuedStartRequests();
    const queueClientMessageIds = replayedStarts.map(value => value.clientMessageId);
    const stableQueueClientMessageId = queueClientMessageIds.length < 2
      ? null
      : queueClientMessageIds.every(value => value && value === queueClientMessageIds[0]);
    const receiptResponses = rpcResponses.filter(value => value.method === "turn/receipt/read");
    const matchingAcceptedCompletion = turnCompletions.find(value => value.threadId === threadId && value.turnId === heldAcceptedResponse.turnId) ?? null;
    const receiptStatusTransition = {
      acceptanceStatus: heldAcceptedResponse.resultStatus,
      observedAfterReload: matchingReceiptResponse?.result?.receipt?.status ?? null,
    };
    const evidence = {
      mobileWebExport: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        indexHtmlSha256: mobileWeb.indexHtmlSha256,
      },
      threadId,
      firstPrompt,
      queuedPrompt,
      viewportWidth,
      queuePresentAfterReload,
      queuedStart,
      acceptedQueuedTurn,
      replayRequestAfterReload,
      acceptedTurnStarts: startedNotifications,
      heldStartIds: [...heldStartIds],
      heldStartResponses,
      rpcSockets,
      rpcRequests,
      rpcResponses,
      resumedThreads,
      queueClientMessageIds,
      stableQueueClientMessageId,
      replayDuplicateResponse,
      receiptReadRequest,
      receiptResponses,
      matchingReceiptResponse,
      receiptStatusTransition,
      matchingAcceptedCompletion,
      providerUserPrompts,
      providerRequestCount: model.requests.length,
      providerRequestOutcomes: model.requestOutcomes,
      duplicateExecutions,
      visibleQueueItems,
      visibleQueueRowsAfterReconciliation,
      visibleUserMessages,
      diagnostics,
    };
    await context.writeArtifactJson("task-flow-queued-start-ack-reload.json", evidence);
    await context.writeArtifactJson("visible-result.json", {
      route: new URL(page.url()).pathname,
      visibleMessages: (await page.getByTestId("message-user").allInnerTexts()).map(text => text.slice(0, 300)),
      visibleQueue: await page.getByTestId("queued-messages").innerText().catch(() => ""),
      visibleUserMessages: await page.getByTestId("message-user").allInnerTexts(),
      diagnostics,
    });
    await page.screenshot({ path: context.pathInArtifacts("queue-after-reload.png") });

    assert.equal(queuePresentAfterReload, true, "The accepted-but-unacknowledged queue item must survive reload until receipt reconciliation");
    assert.equal(duplicateExecutions, 1, `The queued prompt must execute exactly once, observed ${duplicateExecutions} times`);
    assert.ok(replayRequestAfterReload, "Reload recovery must retry or reconcile the persisted queue item");
    assert.equal(stableQueueClientMessageId, true, "The replay must reuse the queued item's stable clientMessageId");
    assert.equal(replayRequestAfterReload.clientMessageId, queuedStart.clientMessageId, "The replay's turn/start must use the original queue identity");
    assert.equal(replayDuplicateResponse?.errorCode, -32047, "The app-server should reject the already committed queue identity before accepting another provider run");
    assert.equal(replayDuplicateResponse?.sequence > replayRequestAfterReload.sequence, true, "The -32047 response must match the replayed turn/start on that socket");
    assert.equal(receiptReadRequest?.clientMessageId, queuedStart.clientMessageId, "turn/receipt/read must query the same queue identity");
    assert.equal(receiptReadRequest?.threadId, threadId, "turn/receipt/read must query the same thread as the original accepted send");
    assert.equal(receiptReadRequest?.socketIndex, replayRequestAfterReload.socketIndex, "The receipt query must use the socket that received the duplicate-identity rejection");
    assert.equal(receiptReadRequest?.sequence > replayDuplicateResponse?.sequence, true, "The receipt query must follow the -32047 rejection");
    assert.ok(matchingReceiptResponse?.ok
      && ["running", "completed", "failed", "interrupted", "unknown"].includes(matchingReceiptResponse.result?.receipt?.status),
    "Reload recovery must receive a valid current receipt status, which may have advanced since initial acceptance");
    assert.equal(matchingReceiptResponse.result.receipt.threadId, threadId, "The receipt must identify the original thread");
    assert.equal(matchingReceiptResponse.result.receipt.turnId, heldAcceptedResponse.turnId, "The receipt must identify the exact turn previously accepted before its ACK was dropped");
    assert.ok(["running", "completed", "failed", "interrupted", "unknown"].includes(receiptStatusTransition.observedAfterReload), "The acceptance-to-receipt status transition must remain in the typed receipt enum");
    assert.equal(model.requestOutcomes[1]?.closed, true, "The original accepted provider request must eventually finish or abort after recovery");
    assert.equal(model.requests.length, 2, "The initial task and accepted queued prompt must be the only provider requests");
    assert.equal(visibleQueueItems, 1, "The transcript must contain the accepted queued user item exactly once");
    assert.equal(visibleQueueRowsAfterReconciliation, 0, "The accepted queue item must drain after receipt reconciliation");
    assert.ok(heldStartResponses.length >= 1 && heldStartResponses.every(value => !value.deliveredToBrowser), "At least one accepted queued turn/start response must be deliberately withheld");
    assert.deepEqual(diagnostics, []);
    const backendProcesses = await findOwnedExecutableProcesses({
      pgid: gateway.child.pid,
      executablePath: configuredBackendBefore.path,
    });
    const configuredBackendAfter = await hashExecutableFile(kcoderBinary);
    const backendBinaryUnchanged = JSON.stringify(configuredBackendAfter) === JSON.stringify(configuredBackendBefore);
    const actualExecutableVerified = backendProcesses.some(item => item.sha256 === configuredBackendBefore.sha256);
    const backendProcessProvenance = {
      configuredBefore: configuredBackendBefore,
      configuredAfter: configuredBackendAfter,
      unchanged: backendBinaryUnchanged,
      gatewayProcessGroupId: gateway.child.pid,
      status: actualExecutableVerified ? "verified" : "unverified",
      ownedProcesses: backendProcesses,
      unverifiedReason: actualExecutableVerified ? null : "no readable matching configured executable found in this run's Gateway process group",
    };
    await context.writeArtifactJson("backend-executable-provenance.json", backendProcessProvenance);
    assert.equal(backendBinaryUnchanged, true, "The configured backend binary must remain unchanged during the run");
    return { queuePresentAfterReload, queuedStartAcceptedBeforeAckDrop: true, duplicateExecutions, visibleQueueItems, providerRequestCount: model.requests.length, backendProcessProvenance };
  } catch (error) {
    await context.writeArtifactJson("failure-state.json", {
      message: error instanceof Error ? error.message : String(error),
      route: new URL(page.url()).pathname,
      body: await page.locator("body").innerText().catch(() => ""),
      heldStartIds: [...heldStartIds],
      heldStartResponses,
      acceptedQueuedTurn: startedNotifications.at(-1) ?? null,
      startedNotifications,
      turnCompletions,
      rpcSockets,
      rpcRequests,
      rpcResponses,
      queuedStartRequests: rpcRequests.filter(value => value.method === "turn/start" && value.prompt?.includes(queuedPrompt)),
      queueClientMessageIds: rpcRequests.filter(value => value.method === "turn/start" && value.prompt?.includes(queuedPrompt)).map(value => value.clientMessageId),
      resumedThreads,
      providerRequestCount: model.requests.length,
      providerRequestOutcomes: model.requestOutcomes,
      providerUserPrompts: model.requests.map(request => [...(request.messages ?? [])].reverse().find(message => message?.role === "user")?.content).filter(Boolean),
      diagnostics,
    });
    await page.screenshot({ path: context.pathInArtifacts("failure.png") }).catch(() => {});
    throw error;
  } finally {
    releaseQueuedProvider = true;
    await page.close();
  }
});

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
