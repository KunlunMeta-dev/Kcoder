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

const kcoderBinary = process.env.KCODER_E2E_KCODER_BIN
  ? resolve(process.env.KCODER_E2E_KCODER_BIN)
  : resolve(repoRoot, "target/debug/kcoder");

await runE2E(import.meta.url, {
  testId: "mobile-qa-active-task-route-isolation",
  tier: "full-integration",
  modelPolicy:
    "model-independent deterministic local provider; verifies active-task route, queue, stop, thread IDs, and receipt ownership only; no model-quality or cross-turn continuity claim",
  retainSuccessLogs: true,
}, async context => {
  const configuredBackendBefore = await hashExecutableFile(kcoderBinary);
  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-active-task-route-mobile-export",
    outputName: "mobile-web-export",
    dependencyRoot: resolve(
      repoRoot,
      "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules",
    ),
  });
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const promptASeed = "MOBILE_ACTIVE_ROUTE_A_SEED";
  const promptBSeed = "MOBILE_ACTIVE_ROUTE_B_SEED";
  const promptAActive = "MOBILE_ACTIVE_ROUTE_A_DELAYED";
  const promptBSend = "MOBILE_ACTIVE_ROUTE_B_SEND";
  const promptAQueued = "MOBILE_ACTIVE_ROUTE_A_QUEUED_AFTER_STOP";
  let releaseQueuedProvider = false;
  const model = await startApprovalModelFixture(context, {
    responseSteps: ({ requestNumber, body }) => {
      const user = [...(body.messages ?? [])].reverse().find(message => message?.role === "user");
      const text = extractUserText(user?.content);
      if (requestNumber === 3) {
        return [
          { delta: { role: "assistant", content: `ACTIVE_STREAM_PARTIAL:${text}` } },
          { ready: () => false, delta: { role: "assistant", content: `ROUTE_REPLY:${text}` } },
          { delta: {}, finishReason: "stop" },
        ];
      }
      if (requestNumber === 5) {
        return [
          { delta: { role: "assistant", content: `ACTIVE_STREAM_PARTIAL:${text}` } },
          { ready: () => releaseQueuedProvider, delta: { role: "assistant", content: `ROUTE_REPLY:${text}` } },
          { delta: {}, finishReason: "stop" },
        ];
      }
      return [
        { delta: { role: "assistant", content: `ROUTE_REPLY:${text}` } },
        { delta: {}, finishReason: "stop" },
      ];
    },
  });
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "mobile-active-route-fixture",
    permission_mode: "yolo",
    providers: {
      "mobile-active-route-fixture": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "mobile-active-route-model",
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
    "mobile-active-route-fixture": { type: "api", key: "mobile-active-route-local-key" },
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
    label: "mobile-active-route-gateway",
    workspace,
    serversFile,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
    },
  });
  const chromium = await startChromium(context, { label: "mobile-active-route-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });

  const diagnostics = [];
  const rpcSockets = [];
  const rpcRequests = [];
  const rpcResponses = [];
  const startedTurns = [];
  let rpcSequence = 0;
  let heldQueueAck = null;
  let withholdNextQueueAck = true;
  page.on("pageerror", error => diagnostics.push({ kind: "pageerror", message: error.message }));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type()))
      diagnostics.push({ kind: message.type(), message: message.text() });
  });

  await page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    const socketIndex = rpcSockets.length;
    const methodsById = new Map();
    let workspaceQuery = null;
    try { workspaceQuery = new URL(socket.url()).searchParams.get("workspace"); } catch {}
    rpcSockets.push({ socketIndex, workspace: workspaceQuery });
    socket.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      if (frame.id !== undefined && frame.method) methodsById.set(frame.id, frame.method);
      if (frame.method === "turn/start") {
        const text = extractUserText(frame.params?.input);
        rpcRequests.push({
          sequence: rpcSequence++,
          id: frame.id,
          method: frame.method,
          threadId: frame.params?.threadId ?? null,
          clientMessageId: frame.params?.clientMessageId ?? null,
          text,
          socketIndex,
          workspace: workspaceQuery,
        });
      } else if (frame.method === "turn/interrupt") {
        rpcRequests.push({
          sequence: rpcSequence++,
          id: frame.id,
          method: frame.method,
          threadId: frame.params?.threadId ?? null,
          turnId: frame.params?.turnId ?? null,
          socketIndex,
          workspace: workspaceQuery,
        });
      } else if (frame.method === "turn/receipt/read") {
        rpcRequests.push({
          sequence: rpcSequence++,
          id: frame.id,
          method: frame.method,
          threadId: frame.params?.threadId ?? null,
          clientMessageId: frame.params?.clientMessageId ?? null,
          socketIndex,
          workspace: workspaceQuery,
        });
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
      if (frame.method === "turn/started") {
        startedTurns.push({
          sequence: rpcSequence++,
          threadId: frame.params?.threadId ?? null,
          turnId: frame.params?.turnId ?? frame.params?.turn?.id ?? null,
          socketIndex,
        });
        socket.send(raw);
        return;
      }
      if (frame.id !== undefined && methodsById.has(frame.id)) {
        const method = methodsById.get(frame.id);
        const record = {
          sequence: rpcSequence++,
          id: frame.id,
          method,
          ok: frame.error === undefined,
          errorCode: frame.error?.code ?? null,
          resultThreadId: frame.result?.thread?.id ?? frame.result?.threadId ?? null,
          resultTurnId: frame.result?.turn?.id ?? frame.result?.turnId ?? null,
          receipt: frame.result?.receipt ?? null,
          socketIndex,
        };
        rpcResponses.push(record);
        if (
          method === "turn/start" &&
          withholdNextQueueAck &&
          !frame.error &&
          rpcRequests.some(request =>
            request.id === frame.id &&
            request.method === "turn/start" &&
            request.text.includes(promptAQueued),
          )
        ) {
          withholdNextQueueAck = false;
          heldQueueAck = record;
          return;
        }
      }
      socket.send(raw);
    });
  });

  try {
    await connect(page, gateway);
    await createTask(page, promptASeed);
    const threadA = routeThreadId(page.url());
    await returnHome(page);
    await createTask(page, promptBSeed);
    const threadB = routeThreadId(page.url());
    assert.notEqual(threadA, threadB, "A and B must be separate server threads");

    await selectThread(page, threadA);
    const startedCountBeforeA = startedTurns.length;
    await page.getByTestId("message-input").fill(promptAActive);
    await page.getByTestId("send-message").click();
    await waitFor(() => model.requests.length === 3, 30_000, "A delayed provider stream starts");
    await page.getByTestId("queue-message").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 30_000 });
    const aActiveStart = rpcRequests.find(request =>
      request.method === "turn/start" && request.text.includes(promptAActive),
    );
    assert.equal(aActiveStart?.threadId, threadA, "A's pending turn/start must target thread A");
    await waitFor(() => startedTurns.slice(startedCountBeforeA).some(turn => turn.threadId === threadA), 30_000, "A's accepted turn/started notification");
    const aActiveTurn = startedTurns.slice(startedCountBeforeA).find(turn => turn.threadId === threadA);

    await selectThread(page, threadB);
    await page.getByTestId("message-input").fill(promptBSend);
    await page.getByTestId("send-message").click();
    await page.getByTestId("message-user").filter({ hasText: promptBSend }).waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(() => model.requests.length === 4, 30_000, "B provider request while A remains active");
    await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
    const bSendStart = rpcRequests.find(request =>
      request.method === "turn/start" && request.text.includes(promptBSend),
    );
    assert.equal(bSendStart?.threadId, threadB, "B's send must target thread B while A remains active");
    await waitFor(() => rpcResponses.some(response => response.id === bSendStart?.id && response.method === "turn/start" && response.ok), 30_000, "B's send acceptance response");

    await selectThread(page, threadA);
    await page.getByTestId("queue-message").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-input").fill(promptAQueued);
    await page.getByTestId("queue-message").click();
    const queuedRow = page.getByTestId("queued-message-0").filter({ hasText: promptAQueued });
    await queuedRow.waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("stop-turn").click();
    await waitFor(() => rpcRequests.some(request =>
      request.method === "turn/interrupt" && request.threadId === threadA && request.turnId === aActiveTurn?.turnId,
    ), 30_000, "A-only turn/interrupt request");
    await waitFor(() => model.requestOutcomes[2]?.aborted === true, 30_000, "stopping A aborts its delayed provider response");
    await waitFor(() => model.requests.length === 5, 60_000, "A's queued message starts after the active turn is stopped");
    await waitFor(() => Boolean(heldQueueAck), 30_000, "A queued turn is accepted while its ACK is held");
    const aQueuedStart = rpcRequests.find(request =>
      request.method === "turn/start" && request.text.includes(promptAQueued),
    );
    assert.ok(aQueuedStart?.clientMessageId, "Queued A must have a stable clientMessageId");
    assert.equal(aQueuedStart.threadId, threadA, "A's queued turn must remain owned by thread A");
    assert.ok(
      startedTurns.some(turn => turn.threadId === threadA && turn.turnId === heldQueueAck.resultTurnId),
      "The held queue ACK must match A's accepted turn/started notification",
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(() => rpcRequests.some(request =>
      request.method === "turn/receipt/read" &&
      request.threadId === threadA &&
      request.clientMessageId === aQueuedStart.clientMessageId,
    ), 60_000, "A's reloaded queue recovers by querying its exact thread and stable identity");
    const receiptRead = rpcRequests.find(request =>
      request.method === "turn/receipt/read" && request.clientMessageId === aQueuedStart.clientMessageId,
    );
    assert.equal(receiptRead?.threadId, threadA);
    assert.equal(receiptRead?.socketIndex > aQueuedStart.socketIndex, true, "Receipt lookup must use the reconnected socket");
    await waitFor(() => rpcResponses.some(response =>
      response.id === receiptRead?.id &&
      response.method === "turn/receipt/read" &&
      response.ok &&
      response.receipt?.threadId === threadA &&
      response.receipt?.turnId === heldQueueAck.resultTurnId &&
      ["running", "completed", "failed", "interrupted"].includes(response.receipt?.status),
    ), 30_000, "A's accepted queue item is reconciled from its matching receipt");
    await waitFor(async () => await page.getByTestId("queued-messages").isHidden().catch(() => true), 30_000, "accepted A queue item drains after receipt recovery");
    await waitFor(() => page.getByTestId("message-user").filter({ hasText: promptAQueued }).count().then(count => count === 1), 30_000, "one visible A queue message after reload");
    const receiptResponse = rpcResponses.find(response => response.id === receiptRead.id && response.method === "turn/receipt/read");
    const queueStarts = rpcRequests.filter(request => request.method === "turn/start" && request.text.includes(promptAQueued));
    const replayQueueStart = queueStarts.find(request => request.socketIndex > aQueuedStart.socketIndex);
    const replayQueueResponse = replayQueueStart
      ? rpcResponses.find(response => response.id === replayQueueStart.id && response.socketIndex === replayQueueStart.socketIndex && response.method === "turn/start")
      : null;
    const bReceiptReads = rpcRequests.filter(request => request.method === "turn/receipt/read" && request.threadId === threadB);
    const aInterrupts = rpcRequests.filter(request => request.method === "turn/interrupt" && request.threadId === threadA);
    const visibleThreadA = routeThreadId(page.url());
    const providerRequestMarkers = model.requests.map(request => {
      const message = [...(request.messages ?? [])].reverse().find(item => item?.role === "user");
      return extractUserText(message?.content);
    });
    assert.equal(receiptResponse?.receipt?.status, "interrupted", "Reload disconnect must interrupt the accepted queued turn owned by this Gateway connection");
    await waitFor(() => model.requestOutcomes[4]?.aborted === true, 30_000, "reload disconnect interrupts the accepted A queue provider request");
    releaseQueuedProvider = true;
    await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
    await context.writeArtifactJson("mobile-active-task-route-isolation.json", {
      mobileWebExport: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        indexHtmlSha256: mobileWeb.indexHtmlSha256,
      },
      threadA,
      threadB,
      visibleThreadA,
      aActiveStart,
      aActiveTurn,
      bSendStart,
      aQueuedStart,
      queueStarts,
      replayQueueStart,
      replayQueueResponse,
      heldQueueAck,
      receiptRead,
      receiptResponse,
      aInterrupts,
      bReceiptReads,
      providerRequestMarkers,
      providerRequestOutcomes: model.requestOutcomes,
      rpcSockets,
      startedTurns,
      rpcRequests,
      rpcResponses,
      diagnostics,
    });
    await page.screenshot({ path: context.pathInArtifacts("mobile-active-task-route-isolation.png") });

    assert.equal(visibleThreadA, threadA, "Reload must stay on the queue owner's thread A");
    assert.equal(aInterrupts.length, 1, "Stopping A must interrupt only A's active turn");
    assert.equal(aInterrupts[0]?.turnId, aActiveTurn?.turnId, "Stop must target the active A turn");
    assert.equal(bReceiptReads.length, 0, "B must not inherit A's queue receipt lookup");
    assert.equal(rpcRequests.filter(request => request.method === "turn/receipt/read").length, 1, "Only the accepted A queue identity should trigger a receipt lookup");
    assert.equal(queueStarts.length, 2, "A's accepted queue is retried once after the dropped ACK");
    assert.deepEqual(queueStarts.map(request => request.clientMessageId), [
      aQueuedStart.clientMessageId,
      aQueuedStart.clientMessageId,
    ], "Queue replay must preserve A's stable clientMessageId");
    assert.deepEqual(queueStarts.map(request => request.threadId), [threadA, threadA]);
    assert.equal(replayQueueStart?.threadId, threadA);
    assert.equal(replayQueueStart?.clientMessageId, aQueuedStart.clientMessageId);
    assert.equal(replayQueueResponse?.errorCode, -32047, "The replay must be rejected as the same already-accepted queue identity");
    assert.equal(receiptRead.sequence > replayQueueResponse.sequence, true, "A's exact receipt lookup must follow the duplicate-identity response");
    assert.equal(receiptRead.socketIndex, replayQueueStart.socketIndex, "A's receipt lookup must use the socket that received the duplicate response");
    assert.equal(bSendStart.threadId, threadB);
    assert.equal(await page.getByTestId("message-user").filter({ hasText: promptBSend }).count(), 0, "B's transcript must not project into A after reload");
    assert.equal(await page.getByTestId("message-user").filter({ hasText: promptAQueued }).count(), 1, "A's queued item must render exactly once");
    assert.equal(receiptResponse?.receipt?.threadId, threadA);
    assert.equal(receiptResponse?.receipt?.turnId, heldQueueAck.resultTurnId);
    assert.equal(providerRequestMarkers.filter(value => value.includes(promptBSend)).length, 1, "B's prompt reaches the fixture once");
    assert.equal(providerRequestMarkers.filter(value => value.includes(promptAQueued)).length, 1, "A's queued prompt reaches the fixture once");
    assert.deepEqual(diagnostics, [], "The route, stop, and receipt lifecycle must not produce browser errors");
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
    return {
      activeTaskSwitch: true,
      queueAndStopStayedWithThreadA: true,
      otherThreadSendStayedWithThreadB: true,
      receiptRecoveredForThreadA: true,
      acceptedQueueInterruptedOnReload: true,
      queueProviderRequests: model.requests.length,
      providerRequests: model.requests.length,
      backendProcessProvenance,
    };
  } catch (error) {
    await context.writeArtifactJson("mobile-active-task-route-isolation-failure.json", {
      message: error instanceof Error ? error.message : String(error),
      route: new URL(page.url()).pathname,
      visibleMessages: await page.getByTestId("message-user").allInnerTexts().catch(() => []),
      body: (await page.locator("body").innerText().catch(() => "")).slice(0, 10000),
      rpcSockets,
      rpcRequests,
      rpcResponses,
      startedTurns,
      heldQueueAck,
      providerRequestCount: model.requests.length,
      providerOutcomes: model.requestOutcomes,
      diagnostics,
    });
    await page.screenshot({ path: context.pathInArtifacts("mobile-active-task-route-isolation-failure.png") }).catch(() => {});
    throw error;
  } finally {
    releaseQueuedProvider = true;
    await page.close().catch(() => {});
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

async function createTask(page, prompt) {
  await page.locator('[data-testid="new-workspace"]:visible').first().click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
}

async function returnHome(page) {
  await page.getByLabel("打开任务列表").click();
  await page.getByTestId("mobile-drawer").getByLabel("主页").click();
  await page.locator('[data-testid="new-workspace"]:visible').first().waitFor({ state: "visible", timeout: 30_000 });
}

async function selectThread(page, threadId) {
  await page.getByLabel("打开任务列表").click();
  const drawer = page.getByTestId("mobile-drawer");
  await drawer.waitFor({ state: "visible", timeout: 30_000 });
  await drawer.getByTestId(`drawer-thread-${threadId}`).waitFor({ state: "visible", timeout: 30_000 });
  await drawer.getByTestId(`drawer-thread-${threadId}`).click();
  await waitFor(() => routeThreadId(page.url()) === threadId, 30_000, `route for ${threadId}`);
  await drawer.waitFor({ state: "hidden", timeout: 30_000 });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
}

function routeThreadId(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
}

function extractUserText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractUserText).join(" ");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  return Object.values(value).map(extractUserText).join(" ");
}
