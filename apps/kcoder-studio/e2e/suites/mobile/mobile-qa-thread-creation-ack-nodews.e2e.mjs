import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import {
  closeRpcAndWait,
  gatewayRpcUrl,
  initializeRpc,
  openRpc,
} from "../../harness/rpc.mjs";
import {
  collectThreadStatePaths,
  makeThreadStartAckGateWrapper,
  readThreadStartGateEvents,
  releaseThreadStartGate,
  waitForThreadStartGateEvent,
} from "../../harness/thread-start-ack-gate.mjs";
import { startProviderRequestObserver } from "../../harness/provider-request-observer.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const BACKEND_BINARY = resolve(
  repoRoot,
  "target/test/coordination/mobile-eight-hour-audit/20260930-162836.000Z/final-app-server-idgate-20260930-221900Z/kcoder",
);
const EXPECTED_BACKEND_SHA256 = "2a792be7e0033140dc93bf78d07567371c1f077653f1361985419791f917667c";
const EXPECTED_BACKEND_SOURCE_SHA256 = "e08918a271306e6621231f14c5f55b8ef834da0f37594287ab3ce2076ccb0b8b";
const BACKEND_PROVENANCE_PATH = resolve(
  repoRoot,
  "target/test/coordination/mobile-eight-hour-audit/20260930-162836.000Z/final-app-server-idgate-20260930-221900Z/binary-provenance.json",
);
const BROKER_SOURCE = resolve(repoRoot, "apps/kcoder-studio/src/workspace-app-server-broker.js");
const EXPECTED_BROKER_SHA256 = "de82c6d1b8d3811a82b182a1c852560e27dd88c2a80cae71095872687ba9b3ca";
const DEV_SERVER_SOURCE = resolve(repoRoot, "apps/kcoder-studio/dev-server.mjs");

// This model-independent integration exercises actual Gateway JSON-RPC routing,
// the fixed Rust app-server stdio process, and real Node WebSocket close events.
// The stdio gate delays only thread/start replies; no Mobile UI, turn, or Provider
// response is synthesized or under test.
await runE2E(import.meta.url, {
  testId: "mobile-qa-thread-creation-ack-nodews",
  tier: "model-independent",
  modelPolicy: "real Studio Gateway, actual Node WebSocket clients, fixed typed-ID Rust app-server; delayed thread/start ACK, no Mobile UI or Provider turn/model-quality claim",
  retainSuccessLogs: true,
}, async context => {
  const configuredBinary = resolve(process.env.KCODER_E2E_KCODER_BIN || "");
  assert.ok(process.env.KCODER_E2E_KCODER_BIN, "UNMET_PREREQUISITE: KCODER_E2E_KCODER_BIN must point to the root-owned immutable typed-ID candidate");
  assert.equal(configuredBinary, BACKEND_BINARY, "suite must use the root-owned immutable typed-ID candidate path");
  await access(BACKEND_BINARY);
  const backendFileStat = await stat(BACKEND_BINARY);
  assert.equal(backendFileStat.mode & 0o777, 0o555, "the pinned backend candidate must remain read-only during the run");
  const configuredBackendBefore = await hashExecutableFile(BACKEND_BINARY);
  assert.equal(configuredBackendBefore.sha256, EXPECTED_BACKEND_SHA256, "suite must use the pinned typed-ID candidate bytes");
  const provenance = JSON.parse(await readFile(BACKEND_PROVENANCE_PATH, "utf8"));
  assert.equal(provenance.binarySha256, EXPECTED_BACKEND_SHA256);
  assert.equal(provenance.ownedSourceSha256, EXPECTED_BACKEND_SOURCE_SHA256);
  assert.equal(provenance.sourceCommit, "UNVERIFIED dirty-source-build");
  const brokerBefore = await hashFile(BROKER_SOURCE);
  assert.equal(brokerBefore.sha256, EXPECTED_BROKER_SHA256, "the Gateway broker source must match its reviewed de82 frozen source before the owned process launches");
  const devServerBefore = await hashFile(DEV_SERVER_SOURCE);
  const sourceDigestsBefore = await hashFiles([
    fileURLToPath(import.meta.url),
    resolve(repoRoot, "apps/kcoder-studio/e2e/harness/thread-start-ack-gate.mjs"),
    resolve(repoRoot, "apps/kcoder-studio/e2e/harness/rpc.mjs"),
    resolve(repoRoot, "apps/kcoder-studio/e2e/harness/provider-request-observer.mjs"),
  ]);

  const workspace = context.pathInState("private-workspace");
  const configDir = context.pathInState("private-config");
  const gateDir = context.pathInState("stdio-ack-gate");
  const webRoot = context.pathInState("minimal-gateway-web-root");
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(gateDir, { recursive: true, mode: 0o700 }),
    mkdir(webRoot, { recursive: true, mode: 0o700 }),
  ]);
  assert.deepEqual(await readdir(workspace), [], "all threads must be created inside a fresh isolated workspace");
  await context.writeStateJson("private-config/settings.json", { hooks: {} });
  await writeFile(
    resolve(webRoot, "index.html"),
    "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>\n",
    { mode: 0o600, flag: "wx" },
  );
  await assert.rejects(access(resolve(workspace, ".kcoder")));

  const providerObserver = await startProviderRequestObserver(context, "thread-creation-ack-provider-observer");
  const observerKey = `thread-creation-ack-${randomUUID()}`;
  context.registerSecret(observerKey);
  const settingsFile = await context.writeStateJson("provider-observer-settings.json", {
    active_provider: "thread-creation-ack-observer",
    permission_mode: "yolo",
    max_retries: 0,
    hooks: {},
    providers: {
      "thread-creation-ack-observer": {
        api_format: "openai_chat_completions",
        endpoint: `${providerObserver.baseUrl}/v1`,
        default_model: "thread-creation-ack-observer-model",
        context_window_tokens: 128000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        request_timeout_secs: 10,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("private-config/credentials.json", {
    "thread-creation-ack-observer": { type: "api", key: observerKey },
  });

  const gateEventsPath = resolve(gateDir, "events.jsonl");
  const gateWrapperPath = resolve(gateDir, "kcoder-stdio-ack-gate");
  const gateWrapperSource = makeThreadStartAckGateWrapper({
    backendBinary: BACKEND_BINARY,
    gateDir,
    gateEventsPath,
  });
  await writeFile(gateWrapperPath, gateWrapperSource, { mode: 0o700, flag: "wx" });
  await chmod(gateWrapperPath, 0o700);
  const wrapperSyntax = spawnSync(process.execPath, ["--check", gateWrapperPath], { encoding: "utf8" });
  assert.equal(wrapperSyntax.status, 0, `run-owned stdio gate must parse before Gateway launch: ${context.redactText(wrapperSyntax.stderr || "")}`);
  const gateWrapperSha256 = createHash("sha256").update(gateWrapperSource).digest("hex");

  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Isolated typed-ID thread creation ACK fixture",
    runtime: "kcoder",
    transport: "local",
    command: gateWrapperPath,
    workspace,
    settingsFile,
  }]);
  const gatewayLabel = "thread-creation-ack-nodews-gateway";
  const gateway = await startGateway(context, {
    label: gatewayLabel,
    workspace,
    serversFile,
    kcoderBin: BACKEND_BINARY,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_TRAINING_MODE: "true",
      KCODER_STUDIO_WEB_ROOT: webRoot,
    },
  });
  const gatewayRpcToken = await waitForGatewayRpcToken(context, gateway);
  const rpcUrl = gatewayRpcUrl(gateway, "local", gatewayRpcToken);
  const rpcClients = new Set();
  const flowEvidence = {};
  let gatewayStopped = false;
  let activeStage = "setup";
  const connectRpc = async label => {
    const rpc = await openRpc(rpcUrl);
    rpcClients.add(rpc);
    context.addCleanup(`close actual Node WebSocket ${label}`, async () => {
      await closeRpcAndWait(rpc, label);
      rpcClients.delete(rpc);
    });
    const initialized = await initializeRpc(rpc, `thread-creation-ack-${label}`);
    assert.equal(initialized.capabilities?.experimental?.residentThreads, true, "the fixed backend must expose resident thread routing");
    assert.equal(initialized.capabilities?.experimental?.threadCreationReceiptsV1, true, "the fixed backend must expose typed creation receipt semantics");
    return rpc;
  };
  const sendThreadStartWithoutWaiting = (rpc, clientRequestId = null) => {
    assert.equal(rpc.socket.readyState, 1, "raw Node WebSocket is open before sending a delayed ACK request");
    const params = { cwd: workspace, ...(clientRequestId ? { clientRequestId } : {}) };
    // This deliberately has no pending promise: disconnecting the real socket
    // before the held backend ACK is the state under test.
    rpc.socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params }));
    return params;
  };

  try {
    activeStage = "candidate process startup";
    const gatewayPgid = context.processes.get(gatewayLabel)?.pgid ?? gateway.child.pid;

    activeStage = "empty resident owner release by Node WebSocket close";
    const emptyOwner = await connectRpc("empty-owner");
    const emptyObserver = await connectRpc("empty-observer");
    const emptyStart = emptyOwner.request("thread/start", { cwd: workspace }, 10_000);
    const emptyHeld = await waitForThreadStartGateEvent(context, gateEventsPath, 1, "held", 15_000);
    assert.equal(emptyHeld.hasClientRequestId, false);
    await releaseThreadStartGate(gateDir, 1);
    await waitForThreadStartGateEvent(context, gateEventsPath, 1, "released", 5_000);
    const emptyResult = await emptyStart;
    const emptyThreadId = emptyResult.thread?.id;
    assert.equal(typeof emptyThreadId, "string");
    const backendProcessesAfterStart = await waitFor(
      async () => {
        const matches = await findOwnedExecutableProcesses({ pgid: gatewayPgid, executablePath: BACKEND_BINARY });
        return matches.length ? matches : null;
      },
      10_000,
      "fixed typed-ID Rust app-server executable inside owned Gateway process group",
      50,
      context.abortSignal,
    );
    assert.ok(backendProcessesAfterStart.some(process => process.sha256 === EXPECTED_BACKEND_SHA256), "the live stdio peer must be the pinned candidate image");
    const beforeReleaseList = await emptyObserver.request("thread/list", { allowPartial: true, limit: 100 });
    assert.equal(beforeReleaseList.threads?.filter(thread => thread.id === emptyThreadId).length, 1, "the backend-created empty resident is listed exactly once");
    const emptyRead = await emptyObserver.request("thread/read", { threadId: emptyThreadId, limit: 20 });
    assert.deepEqual(emptyRead.messages, [], "thread/start created an empty transcript with no turn");
    const ownerConflict = await captureRpcError(emptyObserver, "thread/resume", { threadId: emptyThreadId });
    assert.equal(ownerConflict.code, -32023, "a live Node WebSocket owner blocks a second Gateway client from resuming the resident");
    await closeRpcAndWait(emptyOwner, "empty resident owner Node WebSocket");
    rpcClients.delete(emptyOwner);
    const resumedAfterClose = await waitFor(
      async () => {
        try {
          return await emptyObserver.request("thread/resume", { threadId: emptyThreadId }, 1_000);
        } catch (error) {
          if (/thread is already active in another Gateway client/.test(error.message)) return null;
          throw error;
        }
      },
      10_000,
      "independent observer can resume the resident after actual Node WebSocket close",
      50,
      context.abortSignal,
    );
    assert.equal(resumedAfterClose.thread?.id, emptyThreadId);
    const emptyDelete = await emptyObserver.request("thread/delete", { threadId: emptyThreadId });
    assert.equal(emptyDelete.deleted, true);
    flowEvidence.emptyResidentOwnerRelease = {
      threadId: emptyThreadId,
      backendAckWasHeld: true,
      ownerConflictBeforeClose: ownerConflict.code,
      clientCloseHandshakeObserved: true,
      observerResumeAfterClose: resumedAfterClose.thread?.id === emptyThreadId,
      deleted: emptyDelete.deleted,
    };

    activeStage = "receipt-preserving disconnect and reconnect lookup";
    const receiptOwner = await connectRpc("receipt-owner");
    const receiptObserver = await connectRpc("receipt-observer");
    const clientRequestId = `nodews-thread-create-${randomUUID()}`;
    const receiptParams = sendThreadStartWithoutWaiting(receiptOwner, clientRequestId);
    const receiptHeld = await waitForThreadStartGateEvent(context, gateEventsPath, 2, "held", 15_000);
    assert.equal(receiptHeld.hasClientRequestId, true, "the durable creation receipt identity crossed the real Gateway/stdIO path");
    await closeRpcAndWait(receiptOwner, "receipted creation owner Node WebSocket");
    rpcClients.delete(receiptOwner);
    await releaseThreadStartGate(gateDir, 2);
    await waitForThreadStartGateEvent(context, gateEventsPath, 2, "released", 5_000);
    const creationRead = await receiptObserver.request("thread/creation/read", { clientRequestId }, 5_000);
    assert.equal(creationRead.receipt?.status, "ready", "reconnected Node client must resolve the exact completed creation receipt");
    assert.equal(creationRead.receipt?.threadId, receiptHeld.threadId);
    assert.equal(creationRead.receipt?.thread?.id, receiptHeld.threadId);
    const receiptList = await receiptObserver.request("thread/list", { allowPartial: true, limit: 100 });
    assert.equal(receiptList.threads?.filter(thread => thread.id === receiptHeld.threadId).length, 1, "receipt lookup must name one resident thread, not duplicate startup");
    const receiptRead = await receiptObserver.request("thread/read", { threadId: receiptHeld.threadId, limit: 20 });
    assert.deepEqual(receiptRead.messages, [], "receipt-preserved creation contains no turn or transcript message");
    const receiptEventsBeforeDelete = await readThreadStartGateEvents(gateEventsPath);
    assert.equal(receiptEventsBeforeDelete.some(event => event.kind === "delete-forwarded" && event.threadId === receiptHeld.threadId), false,
      "the receipt-preserved late ACK must not trigger no-receipt compensation before explicit cleanup");
    const receiptResume = await receiptObserver.request("thread/resume", { threadId: receiptHeld.threadId });
    assert.equal(receiptResume.thread?.id, receiptHeld.threadId);
    const receiptDelete = await receiptObserver.request("thread/delete", { threadId: receiptHeld.threadId });
    assert.equal(receiptDelete.deleted, true);
    flowEvidence.receiptedDisconnect = {
      clientRequestId,
      threadId: receiptHeld.threadId,
      creatorClosedBeforeAckRelease: true,
      backendAckWasHeld: true,
      receiptStatus: creationRead.receipt.status,
      receiptThreadId: creationRead.receipt.threadId,
      matchingThreadListCount: 1,
      transcriptMessageCount: receiptRead.messages.length,
      observerResumedSameThread: receiptResume.thread?.id === receiptHeld.threadId,
      deleted: receiptDelete.deleted,
      startupParamsCwdMatchesWorkspace: receiptParams.cwd === workspace,
    };

    activeStage = "unreceipted disconnect and ID-bearing late compensation";
    const noReceiptOwner = await connectRpc("unreceipted-owner");
    const noReceiptObserver = await connectRpc("unreceipted-observer");
    sendThreadStartWithoutWaiting(noReceiptOwner);
    const noReceiptHeld = await waitForThreadStartGateEvent(context, gateEventsPath, 3, "held", 15_000);
    assert.equal(noReceiptHeld.hasClientRequestId, false, "the late compensation branch must omit clientRequestId");
    await closeRpcAndWait(noReceiptOwner, "unreceipted creation owner Node WebSocket");
    rpcClients.delete(noReceiptOwner);
    await releaseThreadStartGate(gateDir, 3);
    await waitForThreadStartGateEvent(context, gateEventsPath, 3, "released", 5_000);
    const forwardedDelete = await waitFor(
      async () => (await readThreadStartGateEvents(gateEventsPath)).find(event =>
        event.kind === "delete-forwarded" && event.threadId === noReceiptHeld.threadId,
      ) ?? null,
      10_000,
      "Gateway ID-bearing compensating delete delivered to the real Rust stdio peer",
      25,
      context.abortSignal,
    );
    assert.equal(forwardedDelete.idPresent, true);
    assert.ok(Number.isSafeInteger(forwardedDelete.requestId));
    assert.equal((await readThreadStartGateEvents(gateEventsPath)).filter(event =>
      event.kind === "delete-forwarded" && event.threadId === noReceiptHeld.threadId,
    ).length, 1, "the no-receipt close must produce one compensating delete request");
    const deleteResponse = await waitFor(
      async () => (await readThreadStartGateEvents(gateEventsPath)).find(event =>
        event.kind === "delete-response" && event.threadId === noReceiptHeld.threadId && event.requestId === forwardedDelete.requestId,
      ) ?? null,
      10_000,
      "matching typed-ID thread/delete response from the fixed Rust app-server",
      25,
      context.abortSignal,
    );
    assert.equal(deleteResponse.ok, true);
    assert.equal(deleteResponse.errorCode, null);
    const noReceiptList = await waitFor(
      async () => {
        const result = await noReceiptObserver.request("thread/list", { allowPartial: true, limit: 100 }, 5_000);
        return result.threads?.some(thread => thread.id === noReceiptHeld.threadId) ? null : result;
      },
      10_000,
      "compensated resident absent from thread/list",
      50,
      context.abortSignal,
    );
    const noReceiptReadError = await captureRpcError(noReceiptObserver, "thread/read", { threadId: noReceiptHeld.threadId, limit: 20 });
    assert.equal(noReceiptReadError.code, -32021);
    const pathsAfterCompensation = await collectThreadStatePaths(resolve(configDir, "projects"), context.stateDir, noReceiptHeld.threadId);
    const tombstones = pathsAfterCompensation.filter(path => path.endsWith(`${noReceiptHeld.threadId}.hctl/source.json`));
    const historyControlDirectories = pathsAfterCompensation.filter(path => path.endsWith(`${noReceiptHeld.threadId}.hctl`));
    const leases = pathsAfterCompensation.filter(path => path.endsWith(`${noReceiptHeld.threadId}.lease`));
    const lifecycleLocks = pathsAfterCompensation.filter(path => path.endsWith(`.thread-lifecycle-locks/${noReceiptHeld.threadId}.lock`));
    const sessionSidecars = pathsAfterCompensation.filter(path => path.endsWith("/state.json"));
    const unexpectedPaths = pathsAfterCompensation.filter(path =>
      !path.endsWith(`${noReceiptHeld.threadId}.hctl/source.json`)
      && !path.endsWith(`${noReceiptHeld.threadId}.hctl`)
      && !path.endsWith(`${noReceiptHeld.threadId}.lease`)
      && !path.endsWith(`.thread-lifecycle-locks/${noReceiptHeld.threadId}.lock`),
    );
    assert.equal(tombstones.length, 1, "delete tombstone prevents history resurrection");
    assert.equal(historyControlDirectories.length, 1);
    assert.equal(leases.length, 1, "stable session lease remains for peer handles");
    assert.equal(lifecycleLocks.length, 1, "stable lifecycle lock remains after delete");
    assert.deepEqual(sessionSidecars, [], "late compensation removes the session state sidecar");
    assert.deepEqual(unexpectedPaths, [], "no thread-scoped artifacts remain beyond tombstone and stable lock/lease files");
    flowEvidence.unreceiptedDisconnect = {
      threadId: noReceiptHeld.threadId,
      creatorClosedBeforeAckRelease: true,
      backendAckWasHeld: true,
      compensationRequestHadId: forwardedDelete.idPresent,
      compensationRequestId: forwardedDelete.requestId,
      matchingRustResponse: { requestId: deleteResponse.requestId, ok: deleteResponse.ok, errorCode: deleteResponse.errorCode },
      absentFromList: !noReceiptList.threads?.some(thread => thread.id === noReceiptHeld.threadId),
      readErrorCode: noReceiptReadError.code,
      tombstones,
      historyControlDirectories,
      leases,
      lifecycleLocks,
      sessionSidecars,
      unexpectedPaths,
    };

    const observedMethods = (await readThreadStartGateEvents(gateEventsPath))
      .filter(event => event.kind === "client-method")
      .map(event => event.method);
    assert.equal(observedMethods.includes("turn/start"), false, "no turn/start may reach the fixed Rust app-server");
    assert.equal(providerObserver.requests.length, 0, "the run-owned 503 Provider observer must receive zero model requests");
    const processBeforeStop = await findOwnedExecutableProcesses({ pgid: gatewayPgid, executablePath: BACKEND_BINARY });
    assert.ok(processBeforeStop.some(process => process.sha256 === EXPECTED_BACKEND_SHA256));
    const configuredBackendAfterFlows = await hashExecutableFile(BACKEND_BINARY);
    assert.equal(configuredBackendAfterFlows.sha256, EXPECTED_BACKEND_SHA256);
    const brokerAfter = await hashFile(BROKER_SOURCE);
    const devServerAfter = await hashFile(DEV_SERVER_SOURCE);
    const sourceDigestsAfter = await hashFiles([
      fileURLToPath(import.meta.url),
      resolve(repoRoot, "apps/kcoder-studio/e2e/harness/thread-start-ack-gate.mjs"),
      resolve(repoRoot, "apps/kcoder-studio/e2e/harness/rpc.mjs"),
      resolve(repoRoot, "apps/kcoder-studio/e2e/harness/provider-request-observer.mjs"),
    ]);

    for (const rpc of [...rpcClients]) {
      await closeRpcAndWait(rpc, "final actual Node WebSocket cleanup");
      rpcClients.delete(rpc);
    }
    await context.stopOwned(gatewayLabel);
    gatewayStopped = true;
    const backendProcessesAfterStop = await waitFor(
      async () => {
        const matches = await findOwnedExecutableProcesses({ pgid: gatewayPgid, executablePath: BACKEND_BINARY });
        return matches.length === 0 ? matches : null;
      },
      10_000,
      "fixed typed-ID Rust app-server cleanup with owned Gateway process group",
      50,
      context.abortSignal,
    );
    assert.deepEqual(backendProcessesAfterStop, [], "the actual candidate app-server must exit with its owned Gateway process group");
    assert.equal((await hashExecutableFile(BACKEND_BINARY)).sha256, EXPECTED_BACKEND_SHA256);

    await context.writeArtifactJson("thread-creation-ack-nodews.json", {
      claimBoundary: "real Gateway + actual Rust app-server stdio + Node WebSocket protocol/lifecycle; no Mobile UI, Expo, turn, or model behavior claim",
      sourceCommit: "UNVERIFIED dirty-source-build",
      backend: {
        path: relative(repoRoot, BACKEND_BINARY).split(sep).join("/"),
        configuredBefore: configuredBackendBefore,
        configuredAfter: configuredBackendAfterFlows,
        sourceSha256: provenance.ownedSourceSha256,
        sourceCommitStatus: provenance.sourceCommit,
        focusedStdioVerification: provenance.verification,
      },
      gatewaySources: {
        brokerPath: relative(repoRoot, BROKER_SOURCE).split(sep).join("/"),
        brokerBefore,
        brokerAfter,
        devServerPath: relative(repoRoot, DEV_SERVER_SOURCE).split(sep).join("/"),
        devServerBefore,
        devServerAfter,
      },
      testSources: { before: sourceDigestsBefore, after: sourceDigestsAfter },
      gateWrapperSha256,
      emptyHooksAndWorkspaceProjectDirectoryAbsent: true,
      providerObserver: { statusForUnexpectedRequests: 503, requests: providerObserver.requests, requestCount: providerObserver.requests.length },
      flowEvidence,
      gateEvents: await readThreadStartGateEvents(gateEventsPath),
      processEvidence: {
        gatewayProcessGroupId: gatewayPgid,
        backendProcessesAfterStart,
        backendProcessesBeforeStop: processBeforeStop,
        backendProcessesAfterStop,
      },
      cleanup: { gatewayStopped, browserProcessesCreated: 0, ExpoExportPerformed: false },
    });
    return {
      emptyResidentOwnerReleasedAfterNodeWebSocketClose: true,
      receiptLookupReturnedSameUniqueThread: true,
      noReceiptLateAckCompensatedWithMatchingRequestId: true,
      providerRequestCount: providerObserver.requests.length,
      backendSha256: EXPECTED_BACKEND_SHA256,
      backendProcessesAfterStop: backendProcessesAfterStop.length,
    };
  } catch (error) {
    await context.writeArtifactJson("failure-state.json", {
      activeStage,
      message: context.redactText(error instanceof Error ? error.message : String(error)),
      flowEvidence,
      providerRequestCount: providerObserver.requests.length,
      providerRequests: providerObserver.requests,
      gateEvents: await readThreadStartGateEvents(gateEventsPath),
      backendConfiguredSha256: configuredBackendBefore.sha256,
      brokerSha256AtLaunch: brokerBefore.sha256,
      devServerSha256AtLaunch: devServerBefore.sha256,
      gatewayStopped,
    }).catch(() => {});
    throw error;
  } finally {
    for (const rpc of [...rpcClients]) {
      await closeRpcAndWait(rpc, "final actual Node WebSocket cleanup").catch(() => {});
      rpcClients.delete(rpc);
    }
    if (!gatewayStopped) await context.stopOwned(gatewayLabel).catch(() => {});
    await providerObserver.close().catch(() => {});
  }
});

async function captureRpcError(rpc, method, params) {
  const offset = rpc.messages().length;
  await assert.rejects(rpc.request(method, params, 5_000));
  const frame = rpc.messages().slice(offset).find(message => message.error && message.id !== undefined);
  assert.ok(frame?.error, `${method} must return a JSON-RPC error response`);
  return { code: frame.error.code, message: frame.error.message };
}

async function hashFile(path) {
  const bytes = await readFile(path);
  return { path: relative(repoRoot, path).split(sep).join("/"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function hashFiles(paths) {
  const result = {};
  for (const path of paths) result[relative(repoRoot, path).split(sep).join("/")] = (await hashFile(path)).sha256;
  return result;
}
