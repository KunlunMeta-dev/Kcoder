import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { closeChromiumProfileAndWaitForExit } from "../../harness/chromium-profile-exit.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import {
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import { restorePinnedGatewayMobileDeployment } from "../../harness/mobile-pinned-gateway-deployment.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const coldAckLossSmoke = process.argv.includes("--cold-receipt-ack-loss-smoke");
const rpcSetupSmoke = process.argv.includes("--rpc-setup-smoke");
const suppliedArguments = process.argv.slice(2);
assert.equal(new Set(suppliedArguments).size, suppliedArguments.length, "suite arguments must not be repeated");
assert.deepEqual(
  suppliedArguments.filter(argument =>
    !["--cold-receipt-ack-loss-smoke", "--rpc-setup-smoke"].includes(argument),
  ),
  [],
  "suite received an unsupported argument",
);
assert.ok(!(coldAckLossSmoke && rpcSetupSmoke), "suite modes must not be combined");

// Deterministic model frames exercise acceptance and recovery; setup-only mode stops before any send.
await runE2E(
  import.meta.url,
  {
    testId: rpcSetupSmoke
      ? "mobile-send-receipt-rpc-setup-smoke"
      : coldAckLossSmoke
        ? "mobile-send-receipt-cold-ack-loss-smoke"
        : "mobile-ordinary-send-readonly-receipt",
    tier: "full-integration",
    modelPolicy: rpcSetupSmoke
      ? "setup-only integration preflight: caller-pinned Mobile archive and real local Gateway/Rust app-server; auth-disabled Node session bootstrap (not Gateway authentication acceptance) obtains Gateway-issued rpcToken, then WebSocket open and RPC initialize; no Browser, turn submission, or model-provider request; does not claim Mobile recovery acceptance"
      : coldAckLossSmoke
        ? "model-independent caller-pinned production Mobile Web mount and real local Gateway/Rust app-server; auth-disabled Node seed, not Gateway authentication acceptance; one corrupted send acceptance, same-profile new Chromium PID, durable unknown state, then trusted-click receipt/history reconciliation; Node route-observed request phase is temporal, not RPC-causal, and may include an in-flight background read; successful pre-click-observed target receipts masked to null while errors remain unknown; no external Provider"
        : "model-independent caller-pinned production Mobile Web mount and real local Gateway/Rust app-server; auth-disabled Node seed, not Gateway authentication acceptance; corrupted acceptance response, with target receipt phase sampled at Node route observation (temporal, not RPC-causal; an in-flight background read may be included); successful pre-click-observed target receipt results masked to null while errors remain unknown",
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal");
    let finishQueueBlocker = false;
    let mobileSendProviderExecutions = 0;
    const model = await startApprovalModelFixture(context, {
      textOnly: true,
      responseSteps: ({ body }) => {
        const last = body.messages
          .filter((message) => message.role === "user")
          .at(-1)?.content;
        const text =
          typeof last === "string"
            ? last
            : (last ?? []).map((part) => part.text ?? "").join("");
        if (text === "MOBILE_SEND_ONCE") mobileSendProviderExecutions += 1;
        if (text === "QUEUE_BLOCKER")
          return [
            { delta: { role: "assistant", content: "QUEUE_BLOCKER_RUNNING" } },
            {
              ready: () => finishQueueBlocker,
              delta: {},
              finishReason: "stop",
            },
          ];
        return [
          {
            delta: {
              role: "assistant",
              content: `deterministic renderer response: ${text}`,
            },
            finishReason: "stop",
          },
        ];
      },
    });
    await context.writeStateJson("profile/settings.json", {
      active_provider: "fixture",
      permission_mode: "yolo",
      max_retries: 0,
      providers: {
        fixture: {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          authentication: { mode: "none" },
          default_model: "fixture",
          no_proxy: true,
          context_window_tokens: 1000000,
          max_output_tokens: 1024,
          output_headroom_tokens: 1024,
        },
      },
    });
    const { deployment: mobileDeployment } = await restorePinnedGatewayMobileDeployment(context);
    const rustBinary = resolve(
      repoRoot,
      process.env.KCODER_E2E_KCODER_BIN || "target/debug/kcoder",
    );
    const expectedRustSha256 = process.env.KCODER_E2E_KCODER_BIN_SHA256;
    assert.match(
      expectedRustSha256 || "",
      /^[a-f0-9]{64}$/i,
      "KCODER_E2E_KCODER_BIN_SHA256 must pin the caller-selected Rust app-server binary",
    );
    const configuredRustBefore = await hashExecutableFile(rustBinary);
    assert.equal(
      configuredRustBefore.sha256,
      expectedRustSha256.toLowerCase(),
      "configured Rust app-server binary must match the caller-provided SHA-256 before Gateway launch",
    );
    const gatewayLabel = "mobile-receipt-gateway";
    context.addCleanup("verify no pinned Rust app-server survives Gateway cleanup", async () => {
      try {
        const processRecord = context.processes.get(gatewayLabel);
        assert.ok(processRecord, "the receipt Gateway must have an exact RunContext process owner record");
        const survivingRustProcesses = await findOwnedExecutableProcesses({
          pgid: processRecord.pgid,
          executablePath: configuredRustBefore.path,
        });
        assert.equal(
          survivingRustProcesses.length,
          0,
          "the owned Rust app-server process group must have no matching executable after Gateway cleanup",
        );
        const configuredRustAfterCleanup = await hashExecutableFile(rustBinary);
        assert.equal(
          configuredRustAfterCleanup.sha256,
          expectedRustSha256.toLowerCase(),
          "configured Rust app-server binary must retain its caller pin after owned cleanup",
        );
        await context.writeArtifactJsonInternal("mobile-receipt-kcoder-post-cleanup.json", {
          verified: true,
          path: configuredRustAfterCleanup.path,
          expectedSha256: expectedRustSha256.toLowerCase(),
          sha256AfterCleanup: configuredRustAfterCleanup.sha256,
          survivingRustProcesses,
        });
      } catch (error) {
        await context.writeArtifactJsonInternal("mobile-receipt-kcoder-post-cleanup.json", {
          verified: false,
          expectedSha256: expectedRustSha256.toLowerCase(),
          error: context.redactText(error?.message || String(error)),
        }).catch(() => {});
        throw error;
      }
    });
    const gateway = await startGateway(context, {
      label: gatewayLabel,
      workspace,
      kcoderBin: rustBinary,
      authToken: "",
      env: {
        KCODER_CONFIG_DIR: context.pathInState("profile"),
        KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDeployment.path,
      },
    });
    const mobileMountStatus = await waitFor(async () => {
      const response = await fetch(new URL("/mobile/", gateway.baseUrl), {
        redirect: "manual",
        headers: { accept: "text/html" },
      }).catch(() => null);
      return response?.status === 200 ? response.status : null;
    }, 15000, "caller-pinned production Mobile mount readiness", 50, context.abortSignal);
    assert.equal(mobileMountStatus, 200);
    assert.equal(gateway.authToken, "",
      "the production Mobile receipt case uses the explicit auth-disabled Gateway contract");
    const mobileSessionResponse = await fetch(new URL("/api/mobile/session", gateway.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: gateway.authToken }),
      signal: context.abortSignal,
    });
    assert.equal(mobileSessionResponse.status, 200,
      "auth-disabled Gateway must accept the empty Node seed credential for a real Mobile session bootstrap");
    const mobileSession = await mobileSessionResponse.json();
    if (typeof mobileSession.accessToken === "string") {
      context.registerSecret(mobileSession.accessToken);
    }
    assert.equal(typeof mobileSession.rpcToken, "string");
    assert.ok(mobileSession.rpcToken.length > 0,
      "the Gateway Mobile session response must provide its issued RPC token");
    assert.notEqual(mobileSession.rpcToken, gateway.authToken,
      "the Gateway-issued RPC token must not be confused with the empty auth-disabled seed credential");
    context.registerSecret(mobileSession.rpcToken);
    const rpc = await openRpc(gatewayRpcUrl(gateway, "local", mobileSession.rpcToken));
    context.addCleanup("close receipt seed", () => rpc.close());
    await initializeRpc(rpc, "mobile-receipt-seed");
    if (rpcSetupSmoke) {
      assert.equal(model.requests.length, 0,
        "the RPC setup smoke must not issue a model-provider request");
      const rustRuntimeProvenance = await verifyOwnedRustAppServer(
        gateway,
        rustBinary,
        configuredRustBefore,
        expectedRustSha256.toLowerCase(),
        workspace,
      );
      await context.writeArtifactJson(
        "mobile-receipt-kcoder-runtime-provenance.json",
        rustRuntimeProvenance,
      );
      rpc.close();
      return {
        setupOnly: true,
        mobileMountStatus,
        gatewayAuthDisabled: gateway.authToken === "",
        rpcTokenSource: "POST /api/mobile/session response.rpcToken",
        gatewayIssuedRpcTokenUsed: true,
        rpcInitialized: true,
        rustRuntimeProvenanceVerified: true,
        browserStarted: false,
        modelProviderRequests: model.requests.length,
      };
    }
    const { thread } = await rpc.request("thread/start");
    const { turn } = await rpc.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "SEED" }],
    });
    await rpc.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === turn.id,
      30000,
      "seed completion",
    );
    await rpc.request("thread/metadata/update", {
      threadId: thread.id,
      title: "Mobile receipt fixture",
    });
    rpc.close();
    const profileName = "mobile-receipt-ack-loss-profile";
    const warmChromiumLabel = "mobile-receipt-ack-loss-warm-chromium";
    const coldChromiumLabel = "mobile-receipt-ack-loss-cold-chromium";
    const warmChromium = await startChromium(context, {
      label: warmChromiumLabel,
      profileName,
    });
    let browser = warmChromium;
    let page = await browser.newPersistentPage();
    await page.setViewportSize({ width: 390, height: 844 });
    let starts = 0,
      receiptReads = 0,
      historyReads = 0,
      deletes = 0,
      retains = 0;
    let corruptStartResponses = 0;
    let trustedCheckClickObservedByNode = false;
    let userCheckClickTrusted = false;
    let postClickReceiptResponseIdentityObservedByNode = null;
    const targetTurnStartRequests = [];
    const targetTurnStartAcknowledgements = [];
    const targetTurnCompletionEvents = [];
    const targetReceiptReadRequests = [];
    const targetReceiptReadResponses = [];
    const targetHistoryReadResponses = [];
    const targetHistoryReadDiagnostics = [];
    const routeDiagnostics = [];
    let sendMode = "corrupt",
      heldSend = null,
      heldRetain = null;
    const deletedAttachmentPaths = [];
    let warmProfileSnapshot = null;
    const observeMobileRpc = (targetPage, browserPhase) => targetPage.routeWebSocket("**/rpc*", (socket) => {
      const upstream = socket.connectToServer();
      const routeDiagnostic = { clientClosedAtMs: null, upstreamClosedAtMs: null };
      routeDiagnostics.push(routeDiagnostic);
      socket.onClose(() => { routeDiagnostic.clientClosedAtMs = performance.now(); });
      upstream.onClose(() => { routeDiagnostic.upstreamClosedAtMs = performance.now(); });
      const requests = new Map();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        const params = message.params && typeof message.params === "object" ? message.params : {};
        let isTargetTurnStart = false;
        if (message.method === "turn/start") {
          starts++;
          assert.ok(params.clientMessageId);
          if (
            params.threadId === thread.id &&
            inputText(params.input) === "MOBILE_SEND_ONCE"
          ) {
            isTargetTurnStart = true;
            targetTurnStartRequests.push({
              requestId: message.id,
              threadId: params.threadId,
              clientMessageId: params.clientMessageId,
              inputText: inputText(params.input),
            });
          }
        }
        if (message.id !== undefined && message.method) {
          const request = {
            requestId: message.id,
            method: message.method,
            params,
            browserPhase,
            nodeObservedPhaseAtRequest: trustedCheckClickObservedByNode
              ? "after-trusted-click-observed-by-node"
              : "before-trusted-click-observed-by-node",
            postClickReceiptIdentityObservedBeforeRequest:
              postClickReceiptResponseIdentityObservedByNode
              ? { ...postClickReceiptResponseIdentityObservedByNode }
              : null,
            isTargetTurnStart,
          };
          requests.set(message.id, request);
          if (
            message.method === "turn/receipt/read" &&
            isTargetReceiptRead(params, targetTurnStartRequests[0])
          ) {
            targetReceiptReadRequests.push({
              requestId: message.id,
              threadId: params.threadId,
              clientMessageId: params.clientMessageId,
              phase: request.nodeObservedPhaseAtRequest,
            });
          }
        }
        if (message.method === "turn/receipt/read") receiptReads++;
        if (message.method === "thread/read" || message.method === "thread/read/indexed") historyReads++;
        if (message.method === "thread/delete") deletes++;
        if (message.method === "gateway/attachments/retain") retains++;
        if (message.method === "attachment/delete")
          deletedAttachmentPaths.push(params.path);
        upstream.send(raw);
      });
      upstream.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        const request = message.id !== undefined ? requests.get(message.id) : null;
        if (message.method === "turn/completed") {
          const params = message.params ?? {};
          const turn = params.turn ?? {};
          const eventThreadId = params.threadId ?? turn.threadId;
          const turnId = params.turnId ?? turn.id;
          if (eventThreadId === thread.id && typeof turnId === "string") {
            targetTurnCompletionEvents.push({
              threadId: eventThreadId,
              turnId,
              attemptId: params.attemptId ?? turn.attemptId ?? null,
              status: turn.status ?? null,
            });
          }
        }
        if (request?.isTargetTurnStart && message.result?.turn) {
          const turn = message.result.turn;
          targetTurnStartAcknowledgements.push({
            requestId: request.requestId,
            threadId: request.params.threadId,
            clientMessageId: request.params.clientMessageId,
            turnId: turn.id,
            attemptId: turn.attemptId ?? null,
            status: turn.status ?? null,
          });
        }
        if (request?.method === "turn/start" && message.result) {
          if (sendMode === "hold-send") {
            heldSend = () => socket.send(raw);
            return;
          }
          if (sendMode === "corrupt") {
            corruptStartResponses++;
            socket.send(JSON.stringify({ ...message, result: {} }));
            return;
          }
        }
        if (
          request?.method === "gateway/attachments/retain" &&
          message.result &&
          sendMode === "hold-retain"
        ) {
          heldRetain = () => socket.send(raw);
          return;
        }
        if (request?.method === "turn/receipt/read" && isTargetReceiptRead(
          request.params,
          targetTurnStartRequests[0],
        )) {
          const hasResult = !message.error && message.result !== undefined;
          const hasReceiptField = hasResult &&
            message.result !== null &&
            typeof message.result === "object" &&
            Object.hasOwn(message.result, "receipt");
          const originalReceipt = hasReceiptField
            ? receiptIdentity(message.result.receipt)
            : null;
          const serverReceiptOutcome = message.error
            ? "error"
            : !hasResult
              ? "no-result"
              : !hasReceiptField
                ? "missing"
                : message.result.receipt === null
                  ? "null"
                  : originalReceipt
                    ? "receipt"
                    : "invalid";
          const responseObservation = {
            requestId: request.requestId,
            phase: request.nodeObservedPhaseAtRequest,
            request: {
              threadId: request.params.threadId,
              clientMessageId: request.params.clientMessageId,
            },
            serverReceiptOutcome,
            clientReceiptOutcome: serverReceiptOutcome,
            originalReceipt,
            responseMaskedToNull: false,
            error: message.error ? { code: message.error.code ?? null } : null,
          };
          targetReceiptReadResponses.push(responseObservation);
          const targetAck = targetTurnStartAcknowledgements[0];
          if (
            request.nodeObservedPhaseAtRequest === "after-trusted-click-observed-by-node" &&
            serverReceiptOutcome === "receipt" &&
            receiptMatchesAcknowledgement(originalReceipt, targetAck)
          ) {
            postClickReceiptResponseIdentityObservedByNode =
              receiptExecutionIdentity(originalReceipt);
          }
          if (
            request.nodeObservedPhaseAtRequest === "before-trusted-click-observed-by-node" &&
            hasReceiptField
          ) {
            responseObservation.clientReceiptOutcome = "null";
            responseObservation.responseMaskedToNull = serverReceiptOutcome !== "null";
            if (serverReceiptOutcome !== "null") {
              socket.send(JSON.stringify({
                ...message,
                result: { ...message.result, receipt: null },
              }));
              return;
            }
          }
        }
        if (
          request &&
          ["thread/read", "thread/read/indexed", "thread/resume"].includes(request.method) &&
          request.params.threadId === thread.id
        ) {
          const result = message.result && typeof message.result === "object" && !Array.isArray(message.result)
            ? message.result
            : null;
          const inlineHistory = request.method === "thread/resume" &&
            result?.history && typeof result.history === "object" && !Array.isArray(result.history)
            ? result.history
            : null;
          const inlinePage = inlineHistory?.status === "ready" &&
            inlineHistory.page && typeof inlineHistory.page === "object" && !Array.isArray(inlineHistory.page)
            ? inlineHistory.page
            : null;
          const page = inlinePage ?? result;
          const pageMessages = Array.isArray(page?.messages) ? page.messages : [];
          const pageSource = inlinePage
            ? "thread-resume-inline-history-page"
            : Array.isArray(result?.messages)
              ? "thread-read-result-messages"
              : Array.isArray(result?.history?.messages)
                ? "result-history-messages"
                : "none";
          const targetStart = targetTurnStartRequests[0] ?? null;
          const targetAck = targetTurnStartAcknowledgements[0] ?? null;
          const isTargetClientMessageId = row => Boolean(
            targetStart && row?.clientMessageId === targetStart.clientMessageId,
          );
          const isTargetTurnId = row => Boolean(targetAck && row?.turnId === targetAck.turnId);
          const isTargetUserContent = row => row?.role === "user" && row?.content === "MOBILE_SEND_ONCE";
          const targetSignalRows = pageMessages.filter(row =>
            isTargetClientMessageId(row) || isTargetTurnId(row) || isTargetUserContent(row),
          );
          const requestReceiptIdentity = request.postClickReceiptIdentityObservedBeforeRequest;
          const priorReceiptIdentityMatchesAck = Boolean(
            requestReceiptIdentity && targetAck &&
            requestReceiptIdentity.threadId === targetAck.threadId &&
            requestReceiptIdentity.turnId === targetAck.turnId &&
            (!targetAck.attemptId || requestReceiptIdentity.attemptId === targetAck.attemptId),
          );
          const rangeStart = Number.isSafeInteger(page?.rangeStart) ? page.rangeStart : null;
          const rangeEnd = Number.isSafeInteger(page?.rangeEnd) ? page.rangeEnd : null;
          const snapshotPresent = Boolean(page?.transcriptSnapshotV1 && typeof page.transcriptSnapshotV1 === "object");
          const observationPresent = Boolean(page?.transcriptObservationV1 && typeof page.transcriptObservationV1 === "object");
          targetHistoryReadDiagnostics.push({
            browserPhase,
            method: request.method,
            phase: request.nodeObservedPhaseAtRequest,
            requestThreadMatchesTarget: request.params.threadId === thread.id,
            requestClientMessageIdPresent: typeof request.params.clientMessageId === "string",
            requestClientMessageIdMatchesTarget: typeof request.params.clientMessageId === "string" && targetStart
              ? request.params.clientMessageId === targetStart.clientMessageId
              : null,
            requestLimit: Number.isSafeInteger(request.params.limit) ? request.params.limit : null,
            requestBeforeCursorPresent: typeof request.params.beforeCursor === "string" && request.params.beforeCursor.length > 0,
            requestPriorReceiptIdentityPresent: Boolean(requestReceiptIdentity),
            requestPriorReceiptIdentityMatchesAcknowledgement: priorReceiptIdentityMatchesAck,
            responseHasError: Boolean(message.error),
            resultPresent: result !== null,
            resultThreadMatchesTarget: typeof result?.thread?.id === "string"
              ? result.thread.id === thread.id
              : null,
            inlineHistoryStatus: ["ready", "unavailable"].includes(inlineHistory?.status)
              ? inlineHistory.status
              : null,
            pageSource,
            pageMessageCount: pageMessages.length,
            rangeStart,
            rangeEnd,
            rangeConsistent: rangeStart !== null && rangeEnd !== null && rangeEnd >= rangeStart &&
              pageMessages.length === rangeEnd - rangeStart,
            hasMoreBefore: typeof page?.hasMoreBefore === "boolean" ? page.hasMoreBefore : null,
            beforeCursorPresent: typeof page?.beforeCursor === "string" && page.beforeCursor.length > 0,
            transcriptProof: {
              snapshotPresent,
              observationPresent,
              anyPresent: snapshotPresent || observationPresent,
            },
            targetRows: {
              acknowledgedTurnRowCount: pageMessages.filter(isTargetTurnId).length,
              targetClientMessageIdRowCount: pageMessages.filter(isTargetClientMessageId).length,
              targetUserContentRowCount: pageMessages.filter(isTargetUserContent).length,
              exactTargetUserRowCount: pageMessages.filter(row =>
                row?.role === "user" && isTargetClientMessageId(row) &&
                isTargetUserContent(row) && isTargetTurnId(row),
              ).length,
              signalRows: targetSignalRows.slice(0, 12).map(row => ({
                userRole: row?.role === "user",
                clientMessageIdPresent: typeof row?.clientMessageId === "string",
                clientMessageIdMatchesTarget: isTargetClientMessageId(row),
                contentMatchesTarget: isTargetUserContent(row),
                turnIdMatchesAcknowledgement: isTargetTurnId(row),
              })),
            },
          });
        }
        if (
          request &&
          (request.method === "thread/read" || request.method === "thread/read/indexed") &&
          request.nodeObservedPhaseAtRequest === "after-trusted-click-observed-by-node" &&
          request.params.threadId === thread.id &&
          message.result
        ) {
          const messages = Array.isArray(message.result.messages)
            ? message.result.messages
            : Array.isArray(message.result.history?.messages)
              ? message.result.history.messages
              : [];
          const targetStart = targetTurnStartRequests[0];
          const targetAck = targetTurnStartAcknowledgements[0];
          const targetTurnRows = messages.filter(
            row => row.turnId === targetAck?.turnId,
          );
          const targetUserRows = messages.filter(row =>
            row.role === "user" &&
            row.clientMessageId === targetStart?.clientMessageId &&
            row.content === "MOBILE_SEND_ONCE",
          );
          targetHistoryReadResponses.push({
            method: request.method,
            requestThreadId: request.params.threadId,
            resultThreadId: message.result.thread?.id ?? null,
            postClickReceiptIdentityObservedBeforeHistory:
              request.postClickReceiptIdentityObservedBeforeRequest,
            targetTurnId: targetAck?.turnId ?? null,
            targetTurnRows: targetTurnRows.map(historyMessageIdentity),
            targetUserRows: targetUserRows.map(historyMessageIdentity),
          });
        }
        socket.send(raw);
      });
    });
    await observeMobileRpc(page, "warm");
    try {
      const gatewayMobileUrl = new URL("/mobile/", gateway.baseUrl).toString();
      await page.goto(gatewayMobileUrl);
      await page.getByTestId("welcome-direct-connection").click();
      await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
      await page.getByTestId("gateway-connect").click();
      await page.getByTestId("new-workspace").waitFor({ timeout: 30000 });
      await page.getByTestId("sessions").click();
      await page.getByTestId("session-search").fill("Mobile receipt fixture");
      await page.getByTestId(`session-${thread.id}`).click();
      await waitFor(
        () => mobileTaskThreadId(page.url()) === thread.id ? true : null,
        30000,
        "warm entry reaches the exact seeded Mobile thread",
      );
      await page.getByTestId("message-input").fill("MOBILE_SEND_ONCE");
      await page.getByTestId("send-message").click();
      await page
        .getByTestId("runtime-reconcile-send")
        .waitFor({ timeout: 30000 });
      await assertUniqueVisible(receiptCheckButton(page), "warm send acceptance check");
      await page
        .getByText("deterministic renderer response: MOBILE_SEND_ONCE", {
          exact: true,
        })
        .waitFor({ timeout: 30000 });
      assert.equal(starts, 1);
      assert.equal(corruptStartResponses, 1);
      assert.equal(mobileSendProviderExecutions, 1);
      await page.screenshot({
        path: context.pathInArtifacts("mobile-send-unknown.png"),
      });

      let lastWarmProfileSnapshot = null;
      try {
        warmProfileSnapshot = await waitFor(async () => {
          lastWarmProfileSnapshot = await captureMobileProfileStorageEvidence(
            page,
            new URL(gatewayMobileUrl).origin,
          );
          return hasPersistedActiveProfile(lastWarmProfileSnapshot.evidence)
            ? lastWarmProfileSnapshot
            : null;
        }, 5000, "warm Mobile profile index, active profile, and current UI route to agree before process close");
      } catch (error) {
        lastWarmProfileSnapshot ??= await captureMobileProfileStorageEvidence(
          page,
          new URL(gatewayMobileUrl).origin,
        );
        await context.writeArtifactJson("mobile-receipt-warm-profile-storage.json", {
          status: "not_ready_before_close",
          phase: "warm-profile-before-chromium-close",
          evidence: lastWarmProfileSnapshot.evidence,
          failure: { name: error?.name ?? "Error", stage: "warm-profile-readonly-poll" },
        });
        throw error;
      }
      await context.writeArtifactJson("mobile-receipt-warm-profile-storage.json", {
        status: "ready_before_close",
        phase: "warm-profile-before-chromium-close",
        evidence: warmProfileSnapshot.evidence,
      });

      const warmProcess = context.processes.get(warmChromiumLabel);
      assert.ok(warmProcess, "the warm Chromium process must retain its exact RunContext owner record");
      const warmPid = warmProcess.pid ?? warmProcess.child?.pid;
      const warmProfileDir = browser.profileDir;
      const warmBrowserContexts = browser.browser.contexts();
      const warmContextPageCount = warmBrowserContexts.length === 1
        ? warmBrowserContexts[0].pages().length
        : null;
      const warmRoutes = [...routeDiagnostics];
      await closeOwnedMobilePage(page, warmRoutes, "warm receipt page");
      page = null;
      const warmCloseObservation = await closeChromiumProfileAndWaitForExit(context, browser, {
        exitTimeoutMs: 10_000,
        treeClearTimeoutMs: 10_000,
        cleanupTimeoutMs: 15_000,
      });
      browser = null;
      const localStorageLevelDbAfterWarmExit = await inspectLocalStorageLevelDbMetadata(warmProfileDir);
      await context.writeArtifactJson("mobile-receipt-warm-chromium-exit.json", {
        label: warmChromiumLabel,
        pid: warmPid,
        exitCode: warmProcess.child?.exitCode ?? null,
        signalCode: warmProcess.child?.signalCode ?? null,
        stopped: warmProcess.stopped === true,
        contextCountBeforeClose: warmBrowserContexts.length,
        pageCountBeforeClose: warmContextPageCount,
        profileDirectoryDigest: digestPrivateIdentifier(warmProfileDir),
        localStorageLevelDbAfterExit: localStorageLevelDbAfterWarmExit,
        closeLifecycle: warmCloseObservation,
      });
      assert.equal(warmCloseObservation.outcome, "graceful-exit-observed",
        "warm profile release requires a clean Browser.close lifecycle");
      assert.equal(warmCloseObservation.requestState, "invoked",
        "the browser-target close request must be invoked before the owned child exits");
      assert.equal(warmCloseObservation.exitObserved, true);
      assert.equal(warmCloseObservation.childExitCode, 0);
      assert.equal(warmCloseObservation.childSignalCode, null);
      assert.equal(warmCloseObservation.processTreeClearBeforeRelease, true,
        "the exact owned Chromium process group must clear before profile reuse");
      assert.equal(warmCloseObservation.browserDisconnectEvidenceBeforeOwnerClose, true,
        "Playwright must observe the Browser disconnected before profile release");
      assert.ok(
        warmCloseObservation.browserDisconnectedEventObservedBeforeOwnerClose === true ||
          warmCloseObservation.browserIsConnectedBeforeOwnerClose === false,
        "public Browser disconnect evidence must be an observed event or isConnected() === false",
      );
      assert.equal(warmCloseObservation.browserDisconnectListenerCleanup, "removed",
        "the public Browser disconnect listener must be removed");
      assert.equal(warmCloseObservation.fallbackUsed, false,
        "warm profile release must not rely on handle-close fallback to terminate Chromium");
      assert.equal(warmCloseObservation.handleCloseOutcome, "completed",
        "the existing Chromium handle must release its owned profile authority");
      assert.ok(
        ["detached", "session-already-closed", "session-transport-closed"].includes(
          warmCloseObservation.sessionCleanup,
        ),
        "the browser CDP session must detach or have an observed closed transport",
      );
      if (warmCloseObservation.sessionCleanup === "session-already-closed") {
        assert.equal(warmCloseObservation.sessionCloseObserved, true);
      }
      assertOwnedChromiumExited(context, warmChromiumLabel, warmProcess);

      browser = await startChromium(context, {
        label: coldChromiumLabel,
        profileName,
      });
      assert.equal(browser.profileDir, warmProfileDir,
        "the cold Chromium process must reopen the exact RunContext-owned persistent profile");
      assert.notEqual(browser.child.pid, warmPid,
        "the cold open must use a new owned Chromium process ID");
      const coldProcess = context.processes.get(coldChromiumLabel);
      const coldUserDataDirEvidence = await inspectOwnedChromiumUserDataDir(
        coldProcess,
        browser.child,
        browser.profileDir,
      );
      page = await browser.newPersistentPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await observeMobileRpc(page, "cold");
      await page.addInitScript(({ expectedOrigin, profileIndexKey, observationProperty }) => {
        const originMatchesGateway = location.origin === expectedOrigin;
        const observation = {
          status: originMatchesGateway ? "storage-unreadable" : "origin-mismatch",
          originMatchesGateway,
          storageReadable: false,
          profileIndexPresent: null,
          localStorageKeyCount: null,
        };
        if (originMatchesGateway) {
          try {
            const storage = window.localStorage;
            const profileIndexPresent = storage.getItem(profileIndexKey) !== null;
            const localStorageKeyCount = storage.length;
            observation.status = "observed";
            observation.storageReadable = true;
            observation.profileIndexPresent = profileIndexPresent;
            observation.localStorageKeyCount = localStorageKeyCount;
          } catch {
            // Keep only the bounded status fields; storage values and exception text are never retained.
          }
        }
        Object.freeze(observation);
        Object.defineProperty(window, observationProperty, {
          configurable: false,
          enumerable: false,
          value: observation,
          writable: false,
        });
      }, {
        expectedOrigin: new URL(gatewayMobileUrl).origin,
        profileIndexKey: "kcoder-studio-mobile.gateway-profiles.v2",
        observationProperty: "__kcoderReceiptColdPreAppStorageProbe__",
      });
      await page.goto(gatewayMobileUrl);
      const coldDocumentStartStorageProbe = await page.evaluate((observationProperty) => {
        const observation = window[observationProperty];
        return observation && typeof observation === "object"
          ? {
            status: typeof observation.status === "string" ? observation.status : "invalid-observation",
            originMatchesGateway: observation.originMatchesGateway === true,
            storageReadable: observation.storageReadable === true,
            profileIndexPresent: typeof observation.profileIndexPresent === "boolean"
              ? observation.profileIndexPresent
              : null,
            localStorageKeyCount: Number.isSafeInteger(observation.localStorageKeyCount)
              ? observation.localStorageKeyCount
              : null,
          }
          : {
            status: "not-observed",
            originMatchesGateway: false,
            storageReadable: false,
            profileIndexPresent: null,
            localStorageKeyCount: null,
          };
      }, "__kcoderReceiptColdPreAppStorageProbe__");
      const coldBrowserContexts = browser.browser.contexts();
      const coldProfileSnapshot = await captureMobileProfileStorageEvidence(
        page,
        new URL(gatewayMobileUrl).origin,
      );
      const coldProfileEvidence = {
        ...coldProfileSnapshot.evidence,
        activeProfileMatchesWarmProfile: Boolean(
          coldProfileSnapshot.privateActiveProfileId &&
          coldProfileSnapshot.privateActiveProfileId === warmProfileSnapshot?.privateActiveProfileId,
        ),
        profileDirectoryMatchesWarm: browser.profileDir === warmProfileDir,
        newChromiumPid: browser.child.pid !== warmPid,
        contextCount: coldBrowserContexts.length,
        pageCount: coldBrowserContexts.length === 1 ? coldBrowserContexts[0].pages().length : null,
        documentStartStorageProbe: coldDocumentStartStorageProbe,
        ownedChromiumUserDataDir: coldUserDataDirEvidence,
      };
      await context.writeArtifactJson("mobile-receipt-cold-profile-storage.json", {
        status: "observed_after_mobile_mount",
        phase: "cold-profile-after-mobile-mount-before-route-reconciliation",
        evidence: coldProfileEvidence,
      });
      assert.equal(coldProfileEvidence.originMatchesGateway, true,
        "cold Mobile storage must be read from the exact Gateway origin used by warm pairing");
      assert.equal(coldProfileEvidence.profileIndexStatus, "parsed",
        "cold same-profile Mobile storage must retain a readable profile index");
      assert.equal(coldProfileEvidence.activeProfilePresent, true,
        "cold same-profile Mobile storage must retain the warm active profile");
      assert.equal(coldProfileEvidence.activeProfileExpiresInFuture, true,
        "cold same-profile Mobile storage must retain an unexpired active profile");
      assert.equal(coldProfileEvidence.activeProfileSecretRecordValid, true,
        "cold same-profile Mobile storage must retain the active profile's secret record without exposing it");
      assert.equal(coldProfileEvidence.activeProfileMatchesWarmProfile, true,
        "cold same-profile Mobile storage must retain the exact warm active profile");
      let coldLanding;
      try {
        coldLanding = await resolveColdLanding(page, thread.id);
      } catch (error) {
        const failedRouteSnapshot = await captureMobileProfileStorageEvidence(
          page,
          new URL(gatewayMobileUrl).origin,
        );
        await context.writeArtifactJson("mobile-receipt-cold-route-failure.json", {
          status: "unrecognized_cold_route",
          phase: "cold-route-resolution-after-profile-storage-readback",
          landing: failedRouteSnapshot.evidence,
          activeProfileMatchesWarmProfile: Boolean(
            failedRouteSnapshot.privateActiveProfileId &&
            failedRouteSnapshot.privateActiveProfileId === warmProfileSnapshot?.privateActiveProfileId,
          ),
          failure: { name: error?.name ?? "Error", stage: "cold-route-resolution" },
        });
        throw error;
      }
      const coldEntry = await enterExactReceiptThread(page, thread.id, coldLanding);
      const targetFailedSubmissionContent = page
        .getByTestId("failed-submission-content")
        .filter({ hasText: /^MOBILE_SEND_ONCE$/ });
      const coldUnknownSubmission = page
        .getByTestId("failed-submission")
        .filter({ has: targetFailedSubmissionContent });
      await coldUnknownSubmission.waitFor({ timeout: 30000 });
      assert.equal(
        await page.getByTestId("failed-submission").count(),
        1,
        "cold recovery must expose one durable failed-submission card for the accepted send",
      );
      await assertUniqueVisible(coldUnknownSubmission, "cold exact MOBILE_SEND_ONCE unknown-submission card");
      // The card-local TaskComposer handler passes submission.id to checkFailedSubmission.
      // useTaskSending uses that same id as the send's clientMessageId.
      const coldUnknownCheckButton = coldUnknownSubmission.getByRole("button", {
        name: /^(?:Check send status 1|核对发送状态 1)$/,
      });
      await assertUniqueVisible(coldUnknownCheckButton, "cold exact-card send-status action");
      assert.equal(
        await coldUnknownCheckButton.getAttribute("data-testid"),
        "verify-failed-submission",
        "the selected card action must be the check path, not its retry or dismiss control",
      );
      assert.equal(await coldUnknownCheckButton.isEnabled(), true,
        "the durable unknown-submission check action must be enabled");
      const coldRecoveryActionEvidence = {
        targetCardCount: 1,
        targetContent: "MOBILE_SEND_ONCE",
        actionTestId: "verify-failed-submission",
        accessibleName: await coldUnknownCheckButton.getAttribute("aria-label"),
        enabledBeforeClick: true,
      };
      await page
        .getByText("deterministic renderer response: MOBILE_SEND_ONCE", {
          exact: true,
        })
        .waitFor({ timeout: 30000 });
      assert.equal(starts, 1, "cold profile recovery must not automatically submit another turn/start");
      assert.equal(
        await page
          .getByTestId("message-user")
          .filter({ hasText: "MOBILE_SEND_ONCE" })
          .count(),
        1,
        "cold profile recovery must retain exactly one visible submitted user row",
      );
      await page.screenshot({ path: context.pathInArtifacts("mobile-send-cold-unknown.png") });

      const explicitCheckButton = coldUnknownCheckButton;
      await page.exposeBinding("__codexReceiptCheckDispatched", (_source, trusted) => {
        trustedCheckClickObservedByNode = true;
        userCheckClickTrusted = trusted === true;
      });
      await explicitCheckButton.evaluate(button => {
        button.addEventListener(
          "click",
          event => window.__codexReceiptCheckDispatched(event.isTrusted),
          { capture: true, once: true },
        );
      });
      await explicitCheckButton.click();
      await waitFor(
        () => trustedCheckClickObservedByNode && userCheckClickTrusted ? true : null,
        5000,
        "the existing receipt-check button's trusted click event observed by Node",
      );
      try {
        await coldUnknownSubmission.waitFor({ state: "detached", timeout: 30000 });
      } catch (error) {
        const targetStartAtCardTimeout = targetTurnStartRequests[0] ?? null;
        const targetAckAtCardTimeout = targetTurnStartAcknowledgements[0] ?? null;
        registerDiagnosticSecret(context, targetStartAtCardTimeout?.clientMessageId);
        registerDiagnosticSecret(context, targetAckAtCardTimeout?.turnId);
        registerDiagnosticSecret(context, thread.id);
        const postClickReceiptResponsesAtCardTimeout = targetReceiptReadResponses.filter(
          response => response.phase === "after-trusted-click-observed-by-node" && response.originalReceipt,
        );
        const matchingReceiptCountAtCardTimeout = targetAckAtCardTimeout
          ? postClickReceiptResponsesAtCardTimeout.filter(response =>
            receiptMatchesAcknowledgement(response.originalReceipt, targetAckAtCardTimeout),
          ).length
          : 0;
        const exactCardCountAtTimeout = await coldUnknownSubmission.count().catch(() => null);
        await context.writeArtifactJson("mobile-send-receipt-history-read-diagnostic.json", {
          status: "target-card-did-not-detach-after-trusted-click",
          targetIdentity: {
            threadIdDigest: digestPrivateIdentifier(thread.id),
            clientMessageIdDigest: digestPrivateIdentifier(targetStartAtCardTimeout?.clientMessageId),
            acknowledgedTurnIdDigest: digestPrivateIdentifier(targetAckAtCardTimeout?.turnId),
            targetStartRequestCount: targetTurnStartRequests.length,
            targetAcknowledgementCount: targetTurnStartAcknowledgements.length,
            matchingReceiptCount: matchingReceiptCountAtCardTimeout,
            postClickObservedReceiptResponseCount: postClickReceiptResponsesAtCardTimeout.length,
          },
          historyReadObservationScope: "target thread/read, thread/read/indexed, or thread/resume responses on warm and cold owned Mobile RPC routes; metadata only",
          targetHistoryReadResponses: targetHistoryReadDiagnostics,
          existingStrictCandidateCount: targetHistoryReadResponses.length,
          afterClick: {
            trustedClickObservedByNode: trustedCheckClickObservedByNode,
            trustedClickWasTrusted: userCheckClickTrusted,
            exactTargetCardCount: exactCardCountAtTimeout,
            exactTargetCardVisible: await coldUnknownSubmission.isVisible().catch(() => false),
            checkButtonCount: await coldUnknownSubmission.getByTestId("verify-failed-submission").count().catch(() => null),
            starts,
            targetTurnStartRequestCount: targetTurnStartRequests.length,
            fixtureExecutionCount: mobileSendProviderExecutions,
          },
        });
        throw error;
      }
      assert.equal(await coldUnknownSubmission.count(), 0,
        "the exact durable unknown-submission card must be removed after accepted history reconciliation");
      assert.equal(starts, 1);
      assert.equal(targetTurnStartRequests.length, 1,
        "the submitted prompt must have exactly one observed turn/start request");
      assert.equal(targetTurnStartAcknowledgements.length, 1,
        "the original upstream turn/start acknowledgement must identify exactly one accepted turn");
      const targetStart = targetTurnStartRequests[0];
      const targetAck = targetTurnStartAcknowledgements[0];
      assert.equal(targetAck.threadId, thread.id);
      assert.equal(targetStart.threadId, targetAck.threadId,
        "the upstream acknowledgement must belong to the submitted target thread");
      assert.equal(targetAck.requestId, targetStart.requestId,
        "the real acknowledgement must answer the original target turn/start request");
      assert.equal(targetAck.clientMessageId, targetStart.clientMessageId);
      assert.ok(targetAck.turnId, "the original turn/start acknowledgement must contain the accepted turn ID");
      const targetCompletions = targetTurnCompletionEvents.filter(
        event => event.threadId === targetAck.threadId && event.turnId === targetAck.turnId,
      );
      assert.ok(targetCompletions.length > 0,
        "the owned Mobile route must observe completion for the target thread and acknowledged turn");
      assert.ok(targetCompletions.some(event => event.status === "completed"),
        "the target thread-scoped turn completion must be completed");

      const preClickObservedReceiptRequests = targetReceiptReadRequests.filter(
        request => request.phase === "before-trusted-click-observed-by-node",
      );
      const preClickObservedReceiptResponses = targetReceiptReadResponses.filter(
        response => response.phase === "before-trusted-click-observed-by-node",
      );
      const preClickObservedSuccessfulNullResponses = preClickObservedReceiptResponses.filter(
        response => response.clientReceiptOutcome === "null",
      );
      assert.ok(preClickObservedReceiptResponses.every(response =>
        response.clientReceiptOutcome !== "receipt"),
      "no non-null target receipt may reach Mobile before Node observes the trusted click event");
      const postClickReceiptRequests = targetReceiptReadRequests.filter(
        request => request.phase === "after-trusted-click-observed-by-node",
      );
      const postClickReceiptResponses = targetReceiptReadResponses.filter(
        response => response.phase === "after-trusted-click-observed-by-node" && response.originalReceipt,
      );
      assert.ok(postClickReceiptRequests.length > 0,
        "the Node route must observe an exact target receipt read after receiving the trusted click event; this is temporal evidence and does not establish RPC causality");
      const matchingReceipts = postClickReceiptResponses.filter(response =>
        response.originalReceipt.threadId === targetAck.threadId &&
        response.originalReceipt.turnId === targetAck.turnId &&
        (!targetAck.attemptId || response.originalReceipt.attemptId === targetAck.attemptId),
      );
      assert.ok(matchingReceipts.length > 0,
        "the post-click-observed receipt response must match the original accepted turn identity");
      assert.equal(new Set(matchingReceipts.map(response =>
        `${response.originalReceipt.threadId}:${response.originalReceipt.turnId}:${response.originalReceipt.attemptId ?? ""}`,
      )).size, 1,
      "receipt reads must identify one accepted execution for this submission");
      const reconciledHistoryPages = targetHistoryReadResponses.filter(response =>
        response.requestThreadId === thread.id &&
        response.resultThreadId === thread.id &&
        matchingReceipts.some(receipt =>
          sameReceiptExecution(
            response.postClickReceiptIdentityObservedBeforeHistory,
            receipt.originalReceipt,
          ),
        ) &&
        response.targetTurnRows.length > 0 &&
        response.targetUserRows.length === 1,
      );
      registerDiagnosticSecret(context, thread.id);
      registerDiagnosticSecret(context, targetStart.clientMessageId);
      registerDiagnosticSecret(context, targetAck.turnId);
      const afterClickTargetCardCount = await coldUnknownSubmission.count();
      const afterClickCheckButtonCount = await coldUnknownCheckButton.count();
      const afterClickFailureCards = await page.getByTestId("failed-submission").count();
      const afterClickRuntimeReconcileCard = page.getByTestId("runtime-reconcile-send");
      await context.writeArtifactJson("mobile-send-receipt-history-read-diagnostic.json", {
        status: "observed_before_reconciliation_assertion",
        targetIdentity: {
          threadIdDigest: digestPrivateIdentifier(thread.id),
          clientMessageIdDigest: digestPrivateIdentifier(targetStart.clientMessageId),
          acknowledgedTurnIdDigest: digestPrivateIdentifier(targetAck.turnId),
          targetStartRequestCount: targetTurnStartRequests.length,
          targetAcknowledgementCount: targetTurnStartAcknowledgements.length,
          matchingReceiptCount: matchingReceipts.length,
          postClickObservedReceiptResponseCount: postClickReceiptResponses.length,
        },
        historyReadObservationScope: "target thread/read, thread/read/indexed, or thread/resume responses on warm and cold owned Mobile RPC routes; metadata only",
        targetHistoryReadResponses: targetHistoryReadDiagnostics,
        existingStrictCandidateCount: targetHistoryReadResponses.length,
        existingReconciledCandidateCount: reconciledHistoryPages.length,
        afterClick: {
          trustedClickObservedByNode: trustedCheckClickObservedByNode,
          trustedClickWasTrusted: userCheckClickTrusted,
          failedSubmissionCardCount: afterClickFailureCards,
          exactTargetCardCount: afterClickTargetCardCount,
          exactTargetCardVisible: await coldUnknownSubmission.isVisible().catch(() => false),
          exactCheckButtonCount: afterClickCheckButtonCount,
          exactCheckButtonVisible: await coldUnknownCheckButton.isVisible().catch(() => false),
          runtimeReconcileCardVisible: await afterClickRuntimeReconcileCard.isVisible().catch(() => false),
          starts,
          targetTurnStartRequestCount: targetTurnStartRequests.length,
          fixtureExecutionCount: mobileSendProviderExecutions,
        },
      });
      assert.ok(reconciledHistoryPages.length > 0,
        "a post-click-observed thread-scoped history result must contain the acknowledged turn and exactly one target user row");
      const reconciledUser = reconciledHistoryPages[0].targetUserRows[0];
      assert.equal(reconciledUser.clientMessageId, targetStart.clientMessageId);
      assert.equal(reconciledUser.content, "MOBILE_SEND_ONCE");
      assert.equal(reconciledUser.turnId, targetAck.turnId,
        "the authoritative history user row must belong to the originally acknowledged turn");
      const summarizeReceiptRead = response => ({
        phase: response.phase,
        requestThreadMatchesTarget: response.request.threadId === thread.id,
        requestClientMessageIdMatchesTarget: response.request.clientMessageId === targetStart.clientMessageId,
        serverReceiptOutcome: response.serverReceiptOutcome,
        clientReceiptOutcome: response.clientReceiptOutcome,
        responseMaskedToNull: response.responseMaskedToNull,
        receiptIdentity: response.originalReceipt ? {
          threadMatchesTarget: response.originalReceipt.threadId === thread.id,
          turnMatchesAcknowledgement: response.originalReceipt.turnId === targetAck.turnId,
          attemptMatchesAcknowledgement: !targetAck.attemptId ||
            response.originalReceipt.attemptId === targetAck.attemptId,
          status: response.originalReceipt.status,
        } : null,
        errorCode: response.error?.code ?? null,
      });
      const summarizeHistoryPage = response => ({
        method: response.method,
        requestThreadMatchesTarget: response.requestThreadId === thread.id,
        resultThreadMatchesTarget: response.resultThreadId === thread.id,
        priorReceiptExecutionMatchesAcknowledgement: sameReceiptExecution(
          response.postClickReceiptIdentityObservedBeforeHistory,
          targetAck,
        ),
        targetTurnRowCount: response.targetTurnRows.length,
        targetUserRows: response.targetUserRows.map(row => ({
          roleIsUser: row.role === "user",
          clientMessageIdMatchesTarget: row.clientMessageId === targetStart.clientMessageId,
          contentMatchesTarget: row.content === "MOBILE_SEND_ONCE",
          turnMatchesAcknowledgement: row.turnId === targetAck.turnId,
        })),
      });
      const receiptObservation = {
        targetSubmission: {
          threadIdDigest: digestPrivateIdentifier(targetStart.threadId),
          clientMessageIdDigest: digestPrivateIdentifier(targetStart.clientMessageId),
          contentMatchesTarget: targetStart.inputText === "MOBILE_SEND_ONCE",
          acknowledgedTurn: {
            threadIdDigest: digestPrivateIdentifier(targetAck.threadId),
            turnIdDigest: digestPrivateIdentifier(targetAck.turnId),
            attemptIdDigest: digestPrivateIdentifier(targetAck.attemptId),
            threadMatchesSubmission: targetAck.threadId === targetStart.threadId,
            clientMessageIdMatchesSubmission: targetAck.clientMessageId === targetStart.clientMessageId,
            status: targetAck.status,
          },
        },
        coldRecoveryAction: coldRecoveryActionEvidence,
        threadScopedCompletions: targetCompletions.map(event => ({
          threadMatchesTarget: event.threadId === thread.id,
          turnMatchesAcknowledgement: event.turnId === targetAck.turnId,
          attemptMatchesAcknowledgement: !targetAck.attemptId || event.attemptId === targetAck.attemptId,
          status: event.status,
        })),
        receiptBeforeTrustedClickObservedByNode: {
          phaseBasis: "Node route observation relative to trusted-click binding delivery; this is temporal ordering, not RPC causality",
          inFlightBackgroundReceiptReadMayBeClassifiedAfterClick: true,
          status: preClickObservedSuccessfulNullResponses.length > 0
            ? "observed_null"
            : "not_observed",
          successfulNullResponseCount: preClickObservedSuccessfulNullResponses.length,
          requestObservedWithoutSuccessfulNull: preClickObservedReceiptRequests.length > 0 &&
            preClickObservedSuccessfulNullResponses.length === 0,
          requests: preClickObservedReceiptRequests.map(request => ({
            phase: request.phase,
            threadMatchesTarget: request.threadId === thread.id,
            clientMessageIdMatchesTarget: request.clientMessageId === targetStart.clientMessageId,
          })),
          responses: preClickObservedReceiptResponses.map(summarizeReceiptRead),
        },
        receiptAfterTrustedClickObservedByNode: {
          phaseBasis: "Node route observation relative to trusted-click binding delivery; this is temporal ordering, not RPC causality",
          requests: postClickReceiptRequests.map(request => ({
            phase: request.phase,
            threadMatchesTarget: request.threadId === thread.id,
            clientMessageIdMatchesTarget: request.clientMessageId === targetStart.clientMessageId,
          })),
          responses: targetReceiptReadResponses.filter(
            response => response.phase === "after-trusted-click-observed-by-node",
          ).map(summarizeReceiptRead),
        },
        reconciledHistoryPages: reconciledHistoryPages.map(summarizeHistoryPage),
        acceptedExecutionCount: 1,
        targetUserRows: 1,
      };
      await context.writeArtifactJson("mobile-send-receipt-reconciliation-observation.json", receiptObservation);
      assert.equal(deletes, 0);
      assert.equal(model.requests.length, 2);
      assert.equal(mobileSendProviderExecutions, 1,
        "receipt reconciliation must not execute the submitted prompt a second time");
      assert.equal(
        await page
          .getByTestId("message-user")
          .filter({ hasText: "MOBILE_SEND_ONCE" })
          .count(),
        1,
      );
      const rustRuntimeProvenance = await verifyOwnedRustAppServer(
        gateway,
        rustBinary,
        configuredRustBefore,
        expectedRustSha256.toLowerCase(),
        workspace,
      );
      await context.writeArtifactJson(
        "mobile-receipt-kcoder-runtime-provenance.json",
        rustRuntimeProvenance,
      );
      if (coldAckLossSmoke) {
        return {
          coldLanding,
          coldEntry,
          starts,
          corruptStartResponses,
          receiptReads,
          historyReads,
          targetTurnId: targetAck.turnId,
          preClickObservedReceiptObservation:
            receiptObservation.receiptBeforeTrustedClickObservedByNode.status,
          postClickAckMatchingReceiptCount: matchingReceipts.length,
          reconciledHistoryPageCount: reconciledHistoryPages.length,
          acceptedTurnCount: 1,
          completedTurnCount: targetCompletions.length,
          userRows: 1,
          mobileSendProviderExecutions,
          sameProfileColdRestart: browser.profileDir === warmProfileDir,
          newChromiumPid: browser.child.pid !== warmPid,
          coldBootDidNotResubmit: true,
          postClickObservedReceiptHistoryReconciliation: true,
          paidProviderRequests: 0,
        };
      }
      await page.reload();
      await page
        .getByText("deterministic renderer response: MOBILE_SEND_ONCE", {
          exact: true,
        })
        .waitFor({ timeout: 30000 });
      assert.equal(
        await page
          .getByTestId("message-user")
          .filter({ hasText: "MOBILE_SEND_ONCE" })
          .count(),
        1,
      );
      // Hold genuine acceptance while a new draft and attachment are prepared.
      sendMode = "hold-send";
      await stageFile(page, "ordinary-first.txt");
      await page.getByTestId("message-input").fill("ORDINARY_FIRST");
      await page.getByTestId("send-message").click();
      await waitFor(() => heldSend, 5000, "ordinary real acceptance held");
      await page.getByTestId("message-input").fill("LATER_ORDINARY_DRAFT");
      await stageFile(page, "ordinary-later.txt");
      await waitFor(
        () => draftStored(page, "LATER_ORDINARY_DRAFT"),
        5000,
        "later ordinary draft persisted",
      );
      heldSend();
      sendMode = "normal";
      await page.getByTestId("staged-attachment-ordinary-later.txt").waitFor();
      assert.equal(
        await page.getByTestId("message-input").inputValue(),
        "LATER_ORDINARY_DRAFT",
      );
      assert.equal(await draftStored(page, "LATER_ORDINARY_DRAFT"), true);
      await page.screenshot({
        path: context.pathInArtifacts(
          "ordinary-later-draft-and-attachment.png",
        ),
      });
      await page.reload();
      await page.getByTestId("message-input").waitFor({ timeout: 30000 });
      assert.equal(
        await page.getByTestId("message-input").inputValue(),
        "LATER_ORDINARY_DRAFT",
      );
      // The local Provider keeps a real turn active until queue assertions finish.
      await page.getByTestId("message-input").fill("QUEUE_BLOCKER");
      await page.getByTestId("send-message").click();
      await page
        .getByText("QUEUE_BLOCKER_RUNNING", { exact: true })
        .waitFor({ timeout: 30000 });
      await stageFile(page, "queue-first.txt");
      await page.getByTestId("message-input").fill("QUEUED_FIRST");
      sendMode = "hold-retain";
      const retainedBefore = retains;
      await page.getByTestId("queue-message").evaluate((button) => {
        button.click();
        button.click();
      });
      await waitFor(() => heldRetain, 5000, "real retain receipt held");
      assert.equal(retains, retainedBefore + 1);
      assert.equal(await page.getByTestId("queue-message").isDisabled(), true);
      await page.getByTestId("message-input").fill("LATER_QUEUE_DRAFT");
      await stageFile(page, "queue-later.txt");
      // The submitted owner is detached; new attachments remain independently removable.
      assert.equal(
        await page.getByTestId("staged-attachment-queue-first.txt").count(),
        0,
      );
      await stageFile(page, "queue-removed-later.txt");
      const deleteCount = deletedAttachmentPaths.length;
      await page
        .getByLabel("Remove queue-removed-later.txt", { exact: true })
        .click();
      await waitFor(
        () => deletedAttachmentPaths.length === deleteCount + 1,
        5000,
        "only the newly removed attachment is deleted",
      );
      heldRetain();
      sendMode = "normal";
      await page.getByTestId("queued-message-0").waitFor();
      assert.equal(await page.getByTestId("queued-message-1").count(), 0);
      assert.equal(
        await page.getByTestId("message-input").inputValue(),
        "LATER_QUEUE_DRAFT",
      );
      await page.getByTestId("staged-attachment-queue-later.txt").waitFor();
      await waitFor(
        () => draftStored(page, "LATER_QUEUE_DRAFT"),
        5000,
        "later queued draft persisted",
      );
      assert.equal(retains, retainedBefore + 1);
      await page.screenshot({
        path: context.pathInArtifacts("queue-later-draft-and-attachment.png"),
      });
      await page.getByLabel("Remove queued message 1", { exact: true }).click();
      await page.getByTestId("queued-message-0").waitFor({ state: "hidden" });
      finishQueueBlocker = true;
      await page.getByTestId("send-message").waitFor({ timeout: 30000 });
      assert.equal(starts, 3);
      assert.equal(model.requests.length, 4);
      await page.reload();
      await page.getByTestId("message-input").waitFor({ timeout: 30000 });
      assert.equal(
        await page.getByTestId("message-input").inputValue(),
        "LATER_QUEUE_DRAFT",
      );
      await page.getByLabel("Open task list", { exact: true }).click();
      await page.getByTestId("mobile-drawer").waitFor();
      await page.getByText("New task", { exact: true }).waitFor();
      await page.getByTestId(`drawer-thread-actions-${thread.id}`).click();
      await page.getByLabel("Save task title", { exact: true }).waitFor();
      await page.getByLabel("Close task actions", { exact: true }).click();
      await page.getByTestId("mobile-drawer").waitFor();
      await page.getByLabel("Close navigation", { exact: true }).last().click();
      return {
        starts,
        receiptReads,
        historyReads,
        deletes,
        retains,
        providerRequests: model.requests.length,
        mobileSendProviderExecutions,
        coldProfileRestart: true,
        authoritativeReload: true,
        ordinaryNewDraftAndAttachment: true,
        queuedNewDraftAndAttachment: true,
        duplicateQueueBlocked: true,
        submittedAttachmentDetach: true,
        paidProviderRequests: 0,
      };
    } catch (error) {
      if (page && !page.isClosed())
        await page.screenshot({ path: context.pathInArtifacts("failure.png") }).catch(() => {});
      throw error;
    } finally {
      try {
        if (page && !page.isClosed())
          await closeOwnedMobilePage(page, [...routeDiagnostics], "receipt page");
      } finally {
        if (browser) {
          const label = browser === warmChromium ? warmChromiumLabel : coldChromiumLabel;
          const processRecord = context.processes.get(label);
          await browser.close();
          if (processRecord) assertOwnedChromiumExited(context, label, processRecord);
        }
      }
    }
  },
);

async function stageFile(page, name) {
  await page.getByTestId("composer-attachment").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByText("Choose file", { exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("owned attachment fixture"),
  });
  await page
    .getByTestId(`staged-attachment-${name}`)
    .waitFor({ timeout: 30000 });
}
async function draftStored(page, draft) {
  return page.evaluate(
    (value) =>
      Object.keys(localStorage).some((key) => {
        if (!key.includes("mobile-workspace")) return false;
        try {
          return JSON.parse(localStorage.getItem(key))?.composerDraft === value;
        } catch {
          return false;
        }
      }),
    draft,
  );
}

function assertOwnedChromiumExited(context, label, expectedRecord) {
  assert.strictEqual(context.processes.get(label), expectedRecord,
    `the exact RunContext process record for ${label} must remain authoritative`);
  assert.equal(expectedRecord.stopped, true,
    `the owned Chromium process group for ${label} must be stopped before profile reuse`);
  assert.ok(expectedRecord.child?.exitCode !== null || expectedRecord.child?.signalCode != null,
    `the owned Chromium child for ${label} must have exited before profile reuse`);
}

function inputText(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input
    .filter(part => part && typeof part === "object" && part.type === "text")
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("");
}

function isTargetReceiptRead(params, targetStart) {
  return Boolean(
    targetStart &&
    params?.threadId === targetStart.threadId &&
    params?.clientMessageId === targetStart.clientMessageId &&
    params?.retryOperationId === undefined,
  );
}

function receiptIdentity(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const threadId = typeof receipt.threadId === "string" ? receipt.threadId : null;
  const turnId = typeof receipt.turnId === "string" ? receipt.turnId : null;
  if (!threadId || !turnId) return null;
  return {
    threadId,
    turnId,
    attemptId: typeof receipt.attemptId === "string" ? receipt.attemptId : null,
    status: typeof receipt.status === "string" ? receipt.status : null,
  };
}

function receiptExecutionIdentity(receipt) {
  if (!receipt?.threadId || !receipt?.turnId) return null;
  return {
    threadId: receipt.threadId,
    turnId: receipt.turnId,
    attemptId: receipt.attemptId ?? null,
  };
}

function receiptMatchesAcknowledgement(receipt, acknowledgement) {
  return Boolean(
    receipt?.threadId === acknowledgement?.threadId &&
    receipt?.turnId === acknowledgement?.turnId &&
    (!acknowledgement?.attemptId || receipt?.attemptId === acknowledgement.attemptId),
  );
}

function sameReceiptExecution(left, right) {
  return Boolean(
    left?.threadId === right?.threadId &&
    left?.turnId === right?.turnId &&
    (right?.attemptId ?? null) === (left?.attemptId ?? null),
  );
}

function historyMessageIdentity(message) {
  return {
    id: typeof message?.id === "string" ? message.id : null,
    role: typeof message?.role === "string" ? message.role : null,
    content: typeof message?.content === "string" ? message.content : null,
    clientMessageId: typeof message?.clientMessageId === "string" ? message.clientMessageId : null,
    turnId: typeof message?.turnId === "string" ? message.turnId : null,
    attemptId: typeof message?.attemptId === "string" ? message.attemptId : null,
  };
}

function mobileTaskThreadId(urlValue) {
  const segments = new URL(urlValue).pathname
    .split("/")
    .filter(Boolean)
    .map(segment => decodeURIComponent(segment));
  const taskIndex = segments.lastIndexOf("task");
  if (taskIndex < 0 || segments.length !== taskIndex + 3) return null;
  return segments[taskIndex + 2];
}

function digestPrivateIdentifier(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function registerDiagnosticSecret(context, value) {
  // RunContext requires registered secrets to be at least eight characters; artifacts keep only digests.
  if (typeof value === "string" && value.length >= 8) context.registerSecret(value);
}

function hasPersistedActiveProfile(evidence) {
  return Boolean(
    evidence.storageReadable &&
    evidence.profileIndexStatus === "parsed" &&
    evidence.profileCount > 0 &&
    evidence.activeProfilePresent &&
    evidence.activeProfileMatchesRoute &&
    evidence.activeProfileBaseUrlMatchesPage &&
    evidence.activeProfileExpiresInFuture &&
    evidence.activeProfileSecretRecordValid,
  );
}

async function captureMobileProfileStorageEvidence(page, expectedOrigin) {
  const raw = await page.evaluate(({ expectedOrigin, profileIndexKey, legacyProfileIndexKey, secretPrefix }) => {
    const url = new URL(location.href);
    const segments = url.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
    const hIndex = segments.lastIndexOf("h");
    const taskIndex = segments.lastIndexOf("task");
    const routeProfileId = hIndex >= 0 ? segments[hIndex + 1] ?? null : null;
    const routeThreadId = taskIndex >= 0 ? segments[taskIndex + 2] ?? null : null;
    const routeKind = segments.includes("welcome")
      ? "welcome"
      : taskIndex >= 0
        ? "task"
        : segments.includes("sessions")
          ? "sessions"
          : routeProfileId
            ? "profile-home"
            : "mobile-entry-or-other";
    const isVisible = selector => {
      const element = document.querySelector(selector);
      return Boolean(element && element.getClientRects().length > 0);
    };
    const evidence = {
      originMatchesGateway: url.origin === expectedOrigin,
      pathIsMobileMount: url.pathname === "/mobile/" || url.pathname.startsWith("/mobile/"),
      routeKind,
      storageReadable: false,
      localStorageKeyCount: null,
      profileSecretStorageEntryCount: null,
      profileIndexPresent: false,
      legacyProfileIndexPresent: false,
      profileIndexStatus: "unreadable",
      profileIndexCharacterCount: null,
      profileCount: 0,
      activeIdPresent: false,
      activeProfilePresent: false,
      activeProfileMatchesRoute: false,
      activeProfileBaseUrlMatchesPage: false,
      activeProfileExpiresInFuture: false,
      activeProfileSecretKeyReferenced: false,
      activeProfileSecretRecordPresent: false,
      activeProfileSecretRecordValid: false,
      hydrationErrorVisible: isVisible('[data-testid="stored-profile-hydration-error"]'),
      welcomeDirectConnectionVisible: isVisible('[data-testid="welcome-direct-connection"]'),
      gatewayEndpointVisible: isVisible('[data-testid="gateway-endpoint"]'),
      newWorkspaceVisible: isVisible('[data-testid="new-workspace"]'),
      sessionsListVisible: isVisible('[data-testid="sessions-list"]'),
      taskHeaderVisible: isVisible('[data-testid="task-header"]'),
      activeProfileId: null,
      routeProfileId,
      routeThreadId,
    };
    try {
      const keys = Object.keys(localStorage);
      evidence.storageReadable = true;
      evidence.localStorageKeyCount = keys.length;
      evidence.profileSecretStorageEntryCount = keys.filter(key => key.startsWith(secretPrefix)).length;
      evidence.profileIndexPresent = localStorage.getItem(profileIndexKey) !== null;
      evidence.legacyProfileIndexPresent = localStorage.getItem(legacyProfileIndexKey) !== null;
      const rawIndex = localStorage.getItem(profileIndexKey);
      if (rawIndex === null) {
        evidence.profileIndexStatus = "missing";
        return evidence;
      }
      evidence.profileIndexCharacterCount = rawIndex.length;
      const index = JSON.parse(rawIndex);
      if (!index || typeof index !== "object" || Array.isArray(index)) {
        evidence.profileIndexStatus = "invalid-shape";
        return evidence;
      }
      evidence.profileIndexStatus = "parsed";
      const profiles = Array.isArray(index.profiles) ? index.profiles : [];
      evidence.profileCount = profiles.length;
      const activeProfileId = typeof index.activeId === "string" ? index.activeId : null;
      evidence.activeIdPresent = activeProfileId !== null;
      evidence.activeProfileId = activeProfileId;
      evidence.activeProfileMatchesRoute = Boolean(activeProfileId && routeProfileId && activeProfileId === routeProfileId);
      const activeProfile = profiles.find(profile => profile && profile.id === activeProfileId) ?? null;
      evidence.activeProfilePresent = activeProfile !== null;
      if (!activeProfile) return evidence;
      try {
        evidence.activeProfileBaseUrlMatchesPage = new URL(activeProfile.baseUrl).origin === url.origin;
      } catch {}
      evidence.activeProfileExpiresInFuture = typeof activeProfile.expiresAt === "number" && activeProfile.expiresAt > Date.now();
      const secretKey = typeof activeProfile.secretKey === "string" ? activeProfile.secretKey : null;
      evidence.activeProfileSecretKeyReferenced = secretKey !== null;
      const secretRaw = secretKey ? localStorage.getItem(secretKey) : null;
      evidence.activeProfileSecretRecordPresent = typeof secretRaw === "string" && secretRaw.length > 0;
      if (secretRaw) {
        try {
          const secret = JSON.parse(secretRaw);
          evidence.activeProfileSecretRecordValid = Boolean(
            secret &&
            typeof secret.accessToken === "string" && secret.accessToken.length > 0 &&
            typeof secret.rpcToken === "string" && secret.rpcToken.length > 0 &&
            (secret.profileId === undefined || secret.profileId === activeProfileId) &&
            (secret.baseUrl === undefined || secret.baseUrl === activeProfile.baseUrl),
          );
        } catch {}
      }
      return evidence;
    } catch (error) {
      evidence.storageErrorName = error?.name ?? "Error";
      return evidence;
    }
  }, {
    expectedOrigin,
    profileIndexKey: "kcoder-studio-mobile.gateway-profiles.v2",
    legacyProfileIndexKey: "kcoder-studio-mobile:gateway-profiles:v1",
    secretPrefix: "kcoder-studio-mobile.gateway-secret.",
  });
  const {
    activeProfileId,
    routeProfileId,
    routeThreadId,
    ...publicEvidence
  } = raw;
  return {
    evidence: {
      ...publicEvidence,
      activeProfileIdDigest: digestPrivateIdentifier(activeProfileId),
      routeProfileIdDigest: digestPrivateIdentifier(routeProfileId),
      routeThreadIdDigest: digestPrivateIdentifier(routeThreadId),
    },
    privateActiveProfileId: activeProfileId,
  };
}

async function inspectLocalStorageLevelDbMetadata(profileDir) {
  const profileRoot = resolve(profileDir);
  let profileMetadata;
  try {
    profileMetadata = await lstat(profileRoot);
  } catch (error) {
    return {
      status: error?.code === "ENOENT" ? "missing" : "unavailable",
      directoryExists: false,
      regularFileCount: error?.code === "ENOENT" ? 0 : null,
      totalBytes: error?.code === "ENOENT" ? 0 : null,
    };
  }
  if (profileMetadata.isSymbolicLink() || !profileMetadata.isDirectory()) {
    return {
      status: "unsafe_or_not_directory",
      directoryExists: false,
      regularFileCount: null,
      totalBytes: null,
    };
  }

  const levelDbSegments = ["Default", "Local Storage", "leveldb"];
  let directory = profileRoot;
  for (const segment of levelDbSegments) {
    directory = resolve(directory, segment);
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          status: "missing",
          directoryExists: false,
          regularFileCount: 0,
          totalBytes: 0,
        };
      }
      return {
        status: "unavailable",
        directoryExists: null,
        regularFileCount: null,
        totalBytes: null,
      };
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return {
        status: "unsafe_or_not_directory",
        directoryExists: false,
        regularFileCount: null,
        totalBytes: null,
      };
    }
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return {
      status: "unavailable",
      directoryExists: true,
      regularFileCount: null,
      totalBytes: null,
    };
  }

  let regularFileCount = 0;
  let totalBytes = 0;
  let metadataReadFailureCount = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const fileMetadata = await lstat(resolve(directory, entry.name));
      if (fileMetadata.isFile() && !fileMetadata.isSymbolicLink()) {
        regularFileCount += 1;
        totalBytes += fileMetadata.size;
      }
    } catch {
      metadataReadFailureCount += 1;
    }
  }
  return {
    status: metadataReadFailureCount === 0 ? "observed" : "partial",
    directoryExists: true,
    regularFileCount,
    totalBytes,
    metadataReadFailureCount,
  };
}

async function inspectOwnedChromiumUserDataDir(processRecord, child, profileDir) {
  const ownedChildMatchesRecord = Boolean(
    processRecord &&
    processRecord.child === child &&
    Number.isSafeInteger(child?.pid) &&
    processRecord.pid === child.pid,
  );
  if (!ownedChildMatchesRecord) {
    return {
      status: "owned_process_mismatch",
      ownedChildMatchesRecord: false,
      userDataDirArgumentCount: null,
      userDataDirMatchesProfile: null,
    };
  }
  if (process.platform !== "linux") {
    return {
      status: "proc_cmdline_unavailable",
      ownedChildMatchesRecord: true,
      userDataDirArgumentCount: null,
      userDataDirMatchesProfile: null,
    };
  }

  let argumentsList;
  try {
    const commandLine = await readFile(`/proc/${child.pid}/cmdline`);
    argumentsList = commandLine.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return {
      status: "proc_cmdline_unavailable",
      ownedChildMatchesRecord: true,
      userDataDirArgumentCount: null,
      userDataDirMatchesProfile: null,
    };
  }

  const prefix = "--user-data-dir=";
  const userDataDirArguments = argumentsList.filter(argument => argument.startsWith(prefix));
  return {
    status: "observed",
    ownedChildMatchesRecord: true,
    userDataDirArgumentCount: userDataDirArguments.length,
    userDataDirMatchesProfile: userDataDirArguments.length === 1 &&
      resolve(userDataDirArguments[0].slice(prefix.length)) === resolve(profileDir),
  };
}

async function resolveColdLanding(page, targetThreadId) {
  return waitFor(async () => {
    if (mobileTaskThreadId(page.url()) === targetThreadId) return "target-task";
    if (await page.getByTestId("sessions-list").count() === 1) return "sessions";
    if (await page.getByTestId("new-workspace").count() === 1) return "home";
    if (await page.getByTestId("task-header").count() === 1) return "other-task";
    return null;
  }, 30000, "cold Mobile route resolves to exact target task, home, sessions, or another task");
}

async function enterExactReceiptThread(page, targetThreadId, landing) {
  if (landing === "target-task") {
    assert.equal(mobileTaskThreadId(page.url()), targetThreadId,
      "cold Mobile cache startup must land on the exact receipt fixture thread");
    return "restored-target-task";
  }

  let route = landing;
  if (route === "other-task") {
    const openTaskList = page.getByRole("button", {
      name: /^(Open task list|打开任务列表)$/,
    });
    await assertUniqueVisible(openTaskList, "cold other-task navigation opener");
    await openTaskList.click();
    await page.getByTestId("mobile-drawer").waitFor({ timeout: 10000 });
    const home = page.getByRole("button", { name: /^(Home|主页)$/ });
    await assertUniqueVisible(home, "cold navigation home action");
    await home.click();
    await page.getByTestId("new-workspace").waitFor({ timeout: 30000 });
    route = "home";
  }
  if (route === "home") {
    const sessions = page.getByTestId("sessions");
    await assertUniqueVisible(sessions, "cold home sessions navigation");
    await sessions.click();
    await page.getByTestId("sessions-list").waitFor({ timeout: 30000 });
    route = "sessions";
  }
  assert.equal(route, "sessions", "cold landing must be a recognized Mobile task route");
  const search = page.getByTestId("session-search");
  await search.waitFor({ timeout: 30000 });
  await search.fill("Mobile receipt fixture");
  const targetRow = page.getByTestId(`session-${targetThreadId}`);
  await targetRow.waitFor({ timeout: 30000 });
  await assertUniqueVisible(targetRow, "cold exact receipt fixture session row");
  await targetRow.click();
  await waitFor(
    () => mobileTaskThreadId(page.url()) === targetThreadId ? true : null,
    30000,
    "cold history selection reaches the exact seeded Mobile thread",
  );
  assert.equal(mobileTaskThreadId(page.url()), targetThreadId,
    "cold navigation must not fall back to an arbitrary composer or thread");
  return "selected-exact-thread-from-history";
}

async function assertUniqueVisible(locator, label) {
  assert.equal(await locator.count(), 1, `${label} must have one unique semantic target`);
  assert.equal(await locator.isVisible(), true, `${label} must be visible before interaction`);
}

function receiptCheckButton(page) {
  return page.getByRole("button", {
    name: /^(Check execution status|核对执行状态|检查执行结果)$/,
  });
}

async function verifyOwnedRustAppServer(
  gateway,
  rustBinary,
  configuredRustBefore,
  expectedRustSha256,
  workspace,
) {
  const ownedRustChildren = await findOwnedExecutableProcesses({
    pgid: gateway.child.pid,
    executablePath: configuredRustBefore.path,
  });
  const matchingChildren = ownedRustChildren.filter(
    (child) => child.sha256 === expectedRustSha256,
  );
  assert.ok(
    matchingChildren.length > 0,
    "owned Gateway process group must include the caller-pinned Rust app-server binary",
  );
  const expectedWorkspace = await realpath(workspace);
  const processLaunchEvidence = await Promise.all(matchingChildren.map(async (child) => {
    const procPath = `/proc/${child.pid}`;
    const [cwdLink, commandLineBytes, executableLink] = await Promise.all([
      readlink(`${procPath}/cwd`),
      readFile(`${procPath}/cmdline`),
      readlink(`${procPath}/exe`),
    ]);
    const cwd = await realpath(cwdLink);
    const actualProcExePath = resolve(executableLink.replace(/ \(deleted\)$/, ""));
    const argv = commandLineBytes.toString("utf8").split("\0").filter(Boolean);
    assert.ok(argv[0], "the owned app-server process must expose argv[0]");
    assert.equal(actualProcExePath, configuredRustBefore.path,
      "actual /proc/<pid>/exe path must match the caller-pinned executable");
    assert.equal(child.executablePath, actualProcExePath,
      "owned-process evidence path must match the live /proc/<pid>/exe path");
    assert.equal(child.sha256, expectedRustSha256,
      "actual /proc/<pid>/exe bytes must match the caller-provided SHA-256");
    const procSelfFd = argv[0].match(/^\/proc\/self\/fd\/(\d+)$/);
    const argv0Path = procSelfFd
      ? `${procPath}/fd/${procSelfFd[1]}`
      : resolve(cwd, argv[0]);
    const argv0ResolvedPath = await realpath(argv0Path);
    assert.equal(argv0ResolvedPath, actualProcExePath,
      "owned app-server argv[0] must resolve to its actual /proc executable, including proc-self-fd launches");
    assert.equal(argv.filter(argument => argument === "app-server").length, 1,
      "the owned pinned executable must run exactly one app-server command");
    const cwdFlagIndex = argv.indexOf("--cwd");
    if (cwdFlagIndex >= 0) {
      assert.ok(argv[cwdFlagIndex + 1], "--cwd must have a workspace argument");
      assert.equal(await realpath(argv[cwdFlagIndex + 1]), expectedWorkspace,
        "the owned app-server argv must target the RunContext workspace");
    }
    assert.equal(cwd, expectedWorkspace,
      "the owned app-server process cwd must match the RunContext workspace");
    return {
      pid: child.pid,
      argv0: argv[0],
      argv0ResolvedPath,
      executablePath: actualProcExePath,
      sha256: child.sha256,
      argv,
      cwd,
    };
  }));
  const configuredRustAfter = await hashExecutableFile(rustBinary);
  assert.equal(
    configuredRustAfter.sha256,
    expectedRustSha256,
    "configured Rust app-server binary must retain the caller-provided SHA-256 after runtime provenance verification",
  );
  return {
    verified: true,
    path: configuredRustBefore.path,
    expectedSha256: expectedRustSha256,
    sha256Before: configuredRustBefore.sha256,
    sha256After: configuredRustAfter.sha256,
    unchangedAfter: configuredRustAfter.sha256 === configuredRustBefore.sha256,
    ownedRustProcesses: processLaunchEvidence,
  };
}

async function closeOwnedMobilePage(page, routes, label) {
  await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
  await page.close();
  if (routes.length === 0) return;
  await waitFor(
    () => routes.every(route =>
      Number.isFinite(route.clientClosedAtMs) && Number.isFinite(route.upstreamClosedAtMs))
      ? true
      : null,
    15000,
    `${label} owned RPC route endpoints to close`,
  );
}
