import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const EXPECTED_BACKEND_SHA256 = "4a2521addc98dfb11ab021a3bd680f5fdbf01d20a38ec8bfa4837e29e430f03b";
const EXPECTED_FROZEN_MOBILE_FILES = 239;
const EXPECTED_FROZEN_SOURCE_TREE_SHA256 = "2f673d69fc972b84851b52b50dead516f97fa8ca1fffcebf03024ed9aa2b3082";
const EXPECTED_FROZEN_SNAPSHOT_MANIFEST_SHA256 = "8414ed64f0f77618fe949f99cb37854e10cb357ad770895ada16d69082bb4e24";
const EXPECTED_RETAINED_EXPORT_MANIFEST_SHA256 = "8fbe07168e0d4645048c7dcf042f1338c70afb01c36213a8f05d75412f1e2b9c";
const EXPECTED_RETAINED_EXPORT_BUNDLE_SHA256 = "dec40f5e07ad73417e72cd6446bad947874649166d75d46778bd0bf320b77558";
const FROZEN_SOURCE_SNAPSHOT_ROOT = resolve(
  repoRoot,
  "target/test/coordination/mobile-source-freezes/20260930-205339Z-2f673d",
);
const FROZEN_SOURCE_SNAPSHOT_MANIFEST = resolve(FROZEN_SOURCE_SNAPSHOT_ROOT, "source-snapshot-manifest.json");
const MOBILE_DEPENDENCY_ROOT = resolve(
  repoRoot,
  "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules",
);

// This suite holds real app-server stdout before the Gateway broker can observe
// thread/start completion. It covers Mobile's 30s timeout with a live socket,
// receipt-preserve after disconnect, and no-receipt late cleanup. No turn/start
// reaches the backend. A local HTTP observer proves that no Provider request was
// entered; it does not synthesize any model response.
await runE2E(import.meta.url, {
  testId: "mobile-qa-thread-start-ack-loss",
  tier: "model-independent",
  modelPolicy: "real Mobile Web, Gateway, and fixed 4a Rust app-server; gated thread/start protocol only; no Provider request or model-quality claim",
  retainSuccessLogs: true,
}, async context => {
  const configuredBinary = process.env.KCODER_E2E_KCODER_BIN;
  assert.ok(configuredBinary, "UNMET_PREREQUISITE: set KCODER_E2E_KCODER_BIN to the root-designated fixed 4a backend copy");
  const backendBinary = resolve(configuredBinary);
  await access(backendBinary);
  const configuredBefore = await hashExecutableFile(backendBinary);
  assert.equal(configuredBefore.sha256, EXPECTED_BACKEND_SHA256, "suite must use the root-designated fixed 4a backend binary");
  const sourceBefore = await verifyFrozenMobileSnapshot();

  const mobileWeb = await resolveMobileWebExport(context);
  assert.equal(mobileWeb.sourceTreeSha256, sourceBefore.sourceTreeSha256, "Mobile Web bundle must derive from the immutable root-owned 2f source snapshot");
  assert.equal(mobileWeb.bundleFileCount, 37, "Mobile Web bundle must match the reviewed 37-file retained export contract");
  const sourceAfterBundleResolution = await verifyFrozenMobileSnapshot();
  assert.deepEqual(sourceAfterBundleResolution.fileDigests, sourceBefore.fileDigests, "the immutable root-owned 239-file Mobile/shared snapshot must remain unchanged");
  const retainedPublicBundle = await retainPublicMobileBundle(context, mobileWeb);

  const workspace = context.pathInState("private-workspace");
  const configDir = context.pathInState("private-config");
  const gateDir = context.pathInState("stdio-gate");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(gateDir, { recursive: true, mode: 0o700 }),
  ]);
  assert.deepEqual(await readdir(workspace), [], "the owned workspace must start empty");
  await context.writeStateJson("private-config/settings.json", { hooks: {} });
  const providerObserver = await startProviderObserver(context);
  const observerKey = "thread-start-ack-loss-observer-only-key";
  context.registerSecret(observerKey);
  const settingsFile = await context.writeStateJson("provider-observer-settings.json", {
    active_provider: "thread-start-ack-loss-observer",
    permission_mode: "yolo",
    hooks: {},
    providers: {
      "thread-start-ack-loss-observer": {
        api_format: "openai_chat_completions",
        endpoint: `${providerObserver.baseUrl}/v1`,
        default_model: "thread-start-ack-loss-observer-model",
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
    "thread-start-ack-loss-observer": { type: "api", key: observerKey },
  });

  const gateEventsPath = resolve(gateDir, "events.jsonl");
  const gateWrapperPath = resolve(gateDir, "kcoder-stdio-gate");
  const gateWrapperSource = makeStdioGateWrapper({ backendBinary, gateDir, gateEventsPath });
  await writeFile(gateWrapperPath, gateWrapperSource, { mode: 0o700, flag: "wx" });
  await chmod(gateWrapperPath, 0o700);
  const wrapperSyntax = spawnSync(process.execPath, ["--check", gateWrapperPath], { encoding: "utf8" });
  assert.equal(wrapperSyntax.status, 0, `owned stdio gate wrapper must parse before Gateway launch: ${context.redactText(wrapperSyntax.stderr || "")}`);
  const gateWrapperSha256 = createHash("sha256").update(gateWrapperSource).digest("hex");

  const webRoot = mobileWeb.path;
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Isolated thread creation ACK fixture",
    runtime: "kcoder",
    transport: "local",
    command: gateWrapperPath,
    workspace,
    settingsFile,
  }]);
  const gatewayLabel = "thread-start-ack-loss-gateway";
  const gateway = await startGateway(context, {
    label: gatewayLabel,
    workspace,
    serversFile,
    kcoderBin: backendBinary,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_TRAINING_MODE: "true",
      KCODER_STUDIO_WEB_ROOT: webRoot,
    },
  });
  const gatewayRpcToken = await waitForGatewayRpcToken(context, gateway);
  const rpcUrl = gatewayRpcUrl(gateway, "local", gatewayRpcToken);
  const chromium = await startChromium(context, { label: "thread-start-ack-loss-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });

  const mobileSockets = [];
  const mobileSocketDisconnectors = new Map();
  const mobileRequests = [];
  const mobileResponses = [];
  const diagnostics = [];
  let liveRpc = null;
  let receiptRpc = null;
  let noReceiptRpc = null;
  let activeStage = "setup";
  const flowEvidence = {};
  page.on("pageerror", error => diagnostics.push({ kind: "pageerror", message: context.redactText(error.message).slice(0, 240) }));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push({ kind: message.type(), message: context.redactText(message.text()).slice(0, 240) });
  });
  await page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    const record = { index: mobileSockets.length, closed: false };
    mobileSockets.push(record);
    mobileSocketDisconnectors.set(record.index, async () => {
      await upstream.close().catch(() => {});
    });
    let closeForwarded = false;
    const methodsById = new Map();
    socket.onClose(() => {
      record.closed = true;
      if (closeForwarded) return;
      closeForwarded = true;
      void upstream.close().catch(() => {});
    });
    upstream.onClose(() => {
      record.upstreamClosed = true;
      if (closeForwarded) return;
      closeForwarded = true;
      void socket.close().catch(() => {});
    });
    socket.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      if (frame.id !== undefined && frame.method) methodsById.set(frame.id, frame.method);
      if (frame.method === "thread/start" || frame.method === "turn/start") {
        mobileRequests.push({
          socketIndex: record.index,
          id: frame.id ?? null,
          method: frame.method,
          hasClientRequestId: typeof frame.params?.clientRequestId === "string" && frame.params.clientRequestId.trim().length > 0,
        });
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
      const method = frame.id === undefined ? null : methodsById.get(frame.id) ?? null;
      if (method === "thread/start") {
        mobileResponses.push({
          socketIndex: record.index,
          id: frame.id,
          ok: !frame.error,
          threadId: frame.result?.thread?.id ?? null,
          errorCode: frame.error?.code ?? null,
        });
      }
      socket.send(raw);
    });
  });

  const gatewayPgid = context.processes.get(gatewayLabel)?.pgid ?? gateway.child.pid;
  let gatewayStopped = false;
  try {
    activeStage = "mobile-thread-start-timeout";
    await connectMobile(page, gateway);
    await page.getByTestId("new-workspace").click();
    await page.getByTestId("server-option-local").click();
    await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("new-workspace-prompt").fill("E2E_THREAD_START_ACK_TIMEOUT_NO_PROVIDER");
    await page.getByTestId("create-workspace").click();

    const firstHeld = await waitForGateEvent(context, gateEventsPath, 1, "held", 30_000);
    assert.equal(firstHeld.hasClientRequestId, false, "Mobile factory thread/start must not send a durable creation receipt in this flow");
    const mobileStart = mobileRequests.find(request => request.method === "thread/start");
    assert.ok(mobileStart, "real Mobile Web must issue thread/start");
    assert.ok(Number.isSafeInteger(firstHeld.requestId), "the stdio gate must identify the app-server-side request whose response it holds");
    assert.equal(mobileStart.hasClientRequestId, false);

    await page.getByText(/RPC thread\/start 等待 30000ms 后超时/).waitFor({ state: "visible", timeout: 36_000 });
    flowEvidence.mobileTimeout = {
      timeoutMessageObserved: true,
      threadStartRequestId: mobileStart.id,
      threadId: firstHeld.threadId,
      clientRequestIdPresent: firstHeld.hasClientRequestId,
      turnStartCountBeforeLateAck: mobileRequests.filter(request => request.method === "turn/start").length,
      responseHeldBeforeGateway: true,
    };
    assert.equal(flowEvidence.mobileTimeout.turnStartCountBeforeLateAck, 0, "factory must not enter turn/start while thread/start is unanswered");
    assert.equal((await readGateEvents(gateEventsPath)).some(event => event.index === 1 && event.kind === "released"), false, "the observed Mobile timeout must occur while the app-server response remains gated");

    await releaseGate(gateDir, 1);
    await waitForGateEvent(context, gateEventsPath, 1, "released", 10_000);
    await waitFor(
      () => mobileResponses.some(response => response.id === mobileStart.id && response.threadId === firstHeld.threadId),
      10_000,
      "late thread/start response delivered to the timed-out Mobile socket",
      25,
      context.abortSignal,
    );
    assert.equal(mobileRequests.filter(request => request.method === "turn/start").length, 0, "late ACK must not revive the abandoned factory into turn/start");
    assert.equal(new URL(page.url()).pathname.includes("/task/"), false, "the timed-out factory must not register or navigate to a task runtime");

    liveRpc = await openRpc(rpcUrl);
    const liveInitialize = await initializeRpc(liveRpc, "thread-start-ack-loss-audit");
    assert.equal(liveInitialize.capabilities?.experimental?.residentThreads, true, "the real app-server must support resident thread routing");
    assert.equal(liveInitialize.capabilities?.experimental?.threadCreationReceiptsV1, true, "the receipt control requires the advertised typed capability");
    const afterLateAckList = await liveRpc.request("thread/list", { allowPartial: true, limit: 100 });
    assert.ok(afterLateAckList.threads?.some(thread => thread.id === firstHeld.threadId), "a thread whose ACK arrived late must remain visible as a resident");
    const afterLateAckRead = await liveRpc.request("thread/read", { threadId: firstHeld.threadId, limit: 20 });
    assert.deepEqual(afterLateAckRead.messages, [], "the late-ACK thread must remain empty because turn/start was never sent");
    const ownerError = await captureRpcError(liveRpc, "thread/metadata/update", {
      threadId: firstHeld.threadId,
      title: "external-write-before-owner-disconnect",
    });
    assert.equal(ownerError.code, -32023, "Gateway must bind the late-created thread to the still-connected original Mobile socket");
    flowEvidence.mobileTimeout.listedAfterLateAck = true;
    flowEvidence.mobileTimeout.readMessageCount = afterLateAckRead.messages.length;
    flowEvidence.mobileTimeout.externalWriteBlockedCode = ownerError.code;
    flowEvidence.mobileTimeout.lateAckDeliveredToOriginalSocket = true;

    await page.close();
    flowEvidence.mobileTimeout.browserPageClosed = true;
    await chromium.close();
    flowEvidence.mobileTimeout.browserProcessClosed = true;
    const ownerSocketRecord = mobileSockets.find(record => record.index === mobileStart.socketIndex);
    assert.ok(ownerSocketRecord, "the late-ACK owner socket must be tracked by its exact Mobile thread/start request");
    flowEvidence.mobileTimeout.routeStillOpenAfterBrowserClose = !ownerSocketRecord.closed && !ownerSocketRecord.upstreamClosed;
    const disconnectOwnerRoute = mobileSocketDisconnectors.get(mobileStart.socketIndex);
    assert.ok(disconnectOwnerRoute, "the exact Gateway-facing route for the late-ACK owner socket must be closable");
    await disconnectOwnerRoute();
    flowEvidence.mobileTimeout.explicitGatewayUpstreamCloseRequested = true;
    await waitFor(
      () => mobileSockets.length > 0 && mobileSockets.every(record => record.closed || record.upstreamClosed),
      5_000,
      "timed-out Mobile socket disconnect",
      25,
      context.abortSignal,
    );
    flowEvidence.mobileTimeout.gatewayUpstreamCloseObserved = ownerSocketRecord.upstreamClosed;
    const ownerReleasedUpdate = await liveRpc.request("thread/metadata/update", {
      threadId: firstHeld.threadId,
      title: "external-write-after-owner-disconnect",
    }, 5_000);
    assert.equal(ownerReleasedUpdate.thread?.id, firstHeld.threadId, "the external client must be able to update the thread after the Mobile owner disconnects");
    flowEvidence.mobileTimeout.externalWriteAfterDisconnectAccepted = true;

    activeStage = "receipt-preserved-after-disconnect";
    receiptRpc = await openRpc(rpcUrl);
    const receiptInitialize = await initializeRpc(receiptRpc, "thread-start-ack-receipt-owner");
    assert.equal(receiptInitialize.capabilities?.experimental?.threadCreationReceiptsV1, true);
    const clientRequestId = `thread-start-ack-receipt-${randomUUID()}`;
    const receiptStartPromise = receiptRpc.request("thread/start", { cwd: workspace, clientRequestId }, 10_000);
    const receiptHeld = await waitForGateEvent(context, gateEventsPath, 2, "held", 15_000);
    assert.equal(receiptHeld.hasClientRequestId, true, "receipt control must send the stable creation identity before the response is held");
    const receiptTimeout = await receiptStartPromise.then(
      () => ({ resolved: true, message: null }),
      error => ({ resolved: false, message: error instanceof Error ? error.message : String(error) }),
    );
    assert.equal(receiptTimeout.resolved, false, "the held response must leave the creation request unanswered");
    assert.match(receiptTimeout.message ?? "", /thread\/start timed out/);
    await closeRpcAndWait(receiptRpc, context, "receipt creator disconnect");
    receiptRpc = null;
    await releaseGate(gateDir, 2);
    await waitForGateEvent(context, gateEventsPath, 2, "released", 10_000);
    const receiptResult = await liveRpc.request("thread/creation/read", { clientRequestId }, 5_000);
    assert.equal(receiptResult.receipt?.status, "ready", "a disconnected receipted creation must remain discoverable as ready");
    assert.equal(receiptResult.receipt?.threadId, receiptHeld.threadId, "receipt lookup must return the exact same thread created before ACK loss");
    assert.equal(receiptResult.receipt?.thread?.id, receiptHeld.threadId);
    const receiptList = await liveRpc.request("thread/list", { allowPartial: true, limit: 100 });
    assert.ok(receiptList.threads?.some(thread => thread.id === receiptHeld.threadId), "receipt-preserved creation must remain listed after its creator disconnects");
    const receiptRead = await liveRpc.request("thread/read", { threadId: receiptHeld.threadId, limit: 20 });
    assert.deepEqual(receiptRead.messages, [], "receipt-preserved creation must still have no transcript messages");
    const receiptWrite = await liveRpc.request("thread/metadata/update", {
      threadId: receiptHeld.threadId,
      title: "receipt-recovered-by-new-client",
    }, 5_000);
    assert.equal(receiptWrite.thread?.id, receiptHeld.threadId, "a new client may recover and use the preserved receipt thread");
    flowEvidence.receiptDisconnect = {
      clientRequestId,
      threadId: receiptHeld.threadId,
      creatorDisconnectedBeforeResponse: true,
      status: receiptResult.receipt?.status,
      sameThreadIdRecovered: receiptResult.receipt?.threadId === receiptHeld.threadId,
      listedAfterDisconnect: true,
      readMessageCount: receiptRead.messages.length,
      newClientWriteAccepted: true,
      compensationDeleteObserved: false,
    };

    activeStage = "unreceipted-late-compensation-delete";
    noReceiptRpc = await openRpc(rpcUrl);
    const noReceiptInitialize = await initializeRpc(noReceiptRpc, "thread-start-ack-no-receipt-owner");
    assert.equal(noReceiptInitialize.capabilities?.experimental?.threadCreationReceiptsV1, true);
    const noReceiptStartPromise = noReceiptRpc.request("thread/start", { cwd: workspace }, 10_000);
    const noReceiptHeld = await waitForGateEvent(context, gateEventsPath, 3, "held", 15_000);
    assert.equal(noReceiptHeld.hasClientRequestId, false, "late cleanup control must have no clientRequestId");
    const noReceiptTimeout = await noReceiptStartPromise.then(
      () => ({ resolved: true, message: null }),
      error => ({ resolved: false, message: error instanceof Error ? error.message : String(error) }),
    );
    assert.equal(noReceiptTimeout.resolved, false);
    assert.match(noReceiptTimeout.message ?? "", /thread\/start timed out/);
    await closeRpcAndWait(noReceiptRpc, context, "unreceipted creator disconnect");
    noReceiptRpc = null;
    await releaseGate(gateDir, 3);
    await waitForGateEvent(context, gateEventsPath, 3, "released", 10_000);
    const forwardedCompensation = await waitFor(
      async () => {
        const events = await readGateEvents(gateEventsPath);
        return events.find(event => event.kind === "delete-forwarded" && event.threadId === noReceiptHeld.threadId) ?? null;
      },
      10_000,
      "Gateway's no-receipt thread/delete compensation reaching the Rust app-server",
      25,
      context.abortSignal,
    );
    assert.equal(forwardedCompensation.idPresent, true, "the Gateway must issue compensating thread/delete as an executable JSON-RPC request");
    assert.ok(Number.isSafeInteger(forwardedCompensation.requestId), "the compensating delete must carry its actual app-server request ID");
    const compensationResponse = await waitFor(
      async () => (await readGateEvents(gateEventsPath)).find(event =>
        event.kind === "delete-response" && event.requestId === forwardedCompensation.requestId,
      ) ?? null,
      10_000,
      "the Rust app-server response to the ID-bearing compensating thread/delete request",
      25,
      context.abortSignal,
    );
    assert.equal(compensationResponse.ok, true, "the Rust app-server must acknowledge the compensating delete request");
    assert.equal(compensationResponse.errorCode, null);
    const noReceiptList = await waitFor(
      async () => {
        const result = await liveRpc.request("thread/list", { allowPartial: true, limit: 100 }, 5_000);
        return result.threads?.some(thread => thread.id === noReceiptHeld.threadId) ? null : result;
      },
      10_000,
      "unreceipted late thread removed from resident thread/list",
      50,
      context.abortSignal,
    );
    const noReceiptReadError = await captureRpcError(liveRpc, "thread/read", { threadId: noReceiptHeld.threadId, limit: 20 });
    assert.equal(noReceiptReadError.code, -32021, "a no-receipt thread deleted after its late response must not remain readable");
    const pathsAfterCompensation = await collectThreadPaths(resolve(configDir, "projects"), context.stateDir, noReceiptHeld.threadId);
    const retainedTombstones = pathsAfterCompensation.filter(path => path.endsWith(`${noReceiptHeld.threadId}.hctl/source.json`));
    const retainedHistoryControlDirectories = pathsAfterCompensation.filter(path => path.endsWith(`${noReceiptHeld.threadId}.hctl`));
    const retainedLeases = pathsAfterCompensation.filter(path => path.endsWith(`${noReceiptHeld.threadId}.lease`));
    const retainedLifecycleLocks = pathsAfterCompensation.filter(path => path.endsWith(`.thread-lifecycle-locks/${noReceiptHeld.threadId}.lock`));
    const sessionSidecars = pathsAfterCompensation.filter(path => path.endsWith("/state.json"));
    const unexpectedPostDeletePaths = pathsAfterCompensation.filter(path =>
      !path.endsWith(`${noReceiptHeld.threadId}.hctl/source.json`)
      && !path.endsWith(`${noReceiptHeld.threadId}.hctl`)
      && !path.endsWith(`${noReceiptHeld.threadId}.lease`)
      && !path.endsWith(`.thread-lifecycle-locks/${noReceiptHeld.threadId}.lock`),
    );
    assert.equal(retainedTombstones.length, 1, "delete must retain the source tombstone that prevents history resurrection");
    assert.equal(retainedHistoryControlDirectories.length, 1, "delete must retain the history control directory containing its tombstone");
    assert.equal(retainedLeases.length, 1, "delete must retain the stable session lease file for existing peer handles");
    assert.equal(retainedLifecycleLocks.length, 1, "delete must retain its lifecycle lock file");
    assert.deepEqual(sessionSidecars, [], "late compensation must remove the session state sidecar");
    assert.deepEqual(unexpectedPostDeletePaths, [], "only the known tombstone and stable lock/lease files may remain after delete");
    flowEvidence.unreceiptedDisconnect = {
      threadId: noReceiptHeld.threadId,
      creatorDisconnectedBeforeResponse: true,
      compensationDeleteObserved: true,
      compensationRequestHadId: forwardedCompensation.idPresent,
      compensationRequestId: forwardedCompensation.requestId,
      compensationResponse,
      absentFromList: !noReceiptList.threads?.some(thread => thread.id === noReceiptHeld.threadId),
      readErrorCode: noReceiptReadError.code,
      retainedTombstones,
      retainedHistoryControlDirectories,
      retainedLeases,
      retainedLifecycleLocks,
      sessionSidecars,
      unexpectedPostDeletePaths,
    };

    const finalList = await liveRpc.request("thread/list", { allowPartial: true, limit: 100 });
    assert.ok(finalList.threads?.some(thread => thread.id === firstHeld.threadId), "the timeout-only thread remains resident until explicit cleanup");
    assert.ok(finalList.threads?.some(thread => thread.id === receiptHeld.threadId), "the receipted creation remains resident until explicit cleanup");
    assert.equal(finalList.threads?.some(thread => thread.id === noReceiptHeld.threadId), false, "the unreceipted late creation was compensated");

    await liveRpc.request("thread/delete", { threadId: firstHeld.threadId }, 5_000);
    await liveRpc.request("thread/delete", { threadId: receiptHeld.threadId }, 5_000);
    const finalProviderRequestCount = providerObserver.requests.length;
    assert.equal(finalProviderRequestCount, 0, "the isolated local Provider observer must receive zero HTTP requests across all three flows");
    assert.deepEqual(diagnostics, [], "the Mobile Web page must not emit JavaScript errors or console warnings during the timeout flow");

    const ownedBackendBeforeStop = await findOwnedExecutableProcesses({
      pgid: gatewayPgid,
      executablePath: backendBinary,
    });
    assert.ok(ownedBackendBeforeStop.some(process => process.sha256 === configuredBefore.sha256), "the running Gateway process group must contain the fixed 4a executable image");
    const configuredAfter = await hashExecutableFile(backendBinary);
    assert.equal(configuredAfter.sha256, configuredBefore.sha256, "the configured fixed backend file must remain unchanged");

    await closeRpcAndWait(liveRpc, context, "final live RPC cleanup");
    liveRpc = null;
    await page.close().catch(() => {});
    await chromium.close();
    await context.stopOwned(gatewayLabel);
    gatewayStopped = true;
    const ownedBackendAfterStop = await waitFor(
      async () => {
        const processes = await findOwnedExecutableProcesses({ pgid: gatewayPgid, executablePath: backendBinary });
        return processes.length === 0 ? processes : null;
      },
      10_000,
      "owned fixed 4a backend process cleanup",
      50,
      context.abortSignal,
    );
    const sourceAfter = await verifyFrozenMobileSnapshot();
    assert.deepEqual(sourceAfter.fileDigests, sourceBefore.fileDigests, "the immutable root-owned 239-file Mobile/shared snapshot must remain unchanged through the run");

    const evidence = {
      sourceCommit: "UNVERIFIED",
      frozenSource: {
      manifest: relative(repoRoot, FROZEN_SOURCE_SNAPSHOT_MANIFEST).split(sep).join("/"),
      fileCount: sourceBefore.fileCount,
      manifestSha256: sourceBefore.manifestSha256,
      fileDigestSetSha256Before: sourceBefore.fileDigestSetSha256,
      fileDigestSetSha256AfterBundleResolution: sourceAfterBundleResolution.fileDigestSetSha256,
      fileDigestSetSha256AfterRun: sourceAfter.fileDigestSetSha256,
      sourceFilesUnchangedBeforeAfter: true,
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      sourceRoots: sourceBefore.sourceRoots,
      },
      mobileWebExport: {
        source: mobileWeb.source,
        sourceManifestSha256: mobileWeb.sourceManifestSha256,
        reuseProvenancePath: mobileWeb.provenancePath
          ? relative(context.runRoot, mobileWeb.provenancePath).split(sep).join("/")
          : null,
        exportPerformed: mobileWeb.exportPerformed,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        indexHtmlSha256: mobileWeb.indexHtmlSha256,
        retainedArtifactDirectory: retainedPublicBundle.directory,
        retainedArtifactManifest: retainedPublicBundle.manifest,
        retainedBundleSha256: retainedPublicBundle.bundleSha256,
      },
      fixedBackend: {
        configuredBefore,
        configuredAfter,
        sha256: configuredBefore.sha256,
        sourceCommit: "UNVERIFIED",
        processGroupId: gatewayPgid,
        ownedProcessesBeforeStop: ownedBackendBeforeStop,
        ownedProcessesAfterStop: ownedBackendAfterStop,
        gateWrapperSha256,
      },
      gatewayPort: gateway.port,
      providerObserver: {
        baseUrl: providerObserver.baseUrl,
        requestCount: finalProviderRequestCount,
        requests: providerObserver.requests,
      },
      flows: flowEvidence,
      appServerGateEvents: await readGateEvents(gateEventsPath),
      mobileRequests,
      mobileResponses,
      mobileSockets,
      diagnostics,
      cleanup: {
        gatewayStopped,
        chromiumClosed: true,
        rpcClientsClosed: liveRpc === null && receiptRpc === null && noReceiptRpc === null,
        backendProcessCountAfterStop: ownedBackendAfterStop.length,
      },
    };
    await context.writeArtifactJson("thread-start-ack-loss.json", evidence);
    await context.writeArtifactJson("visible-result.json", {
      mobileRouteAfterThreadStartTimeout: "/new workspace route retained; task route was never entered",
      lateStartResponseDelivered: mobileResponses.some(response => response.id === mobileStart.id && response.threadId === firstHeld.threadId),
      mobileTurnStartCount: mobileRequests.filter(request => request.method === "turn/start").length,
      providerRequestCount: finalProviderRequestCount,
      receiptCreationPreserved: flowEvidence.receiptDisconnect.sameThreadIdRecovered,
      noReceiptCreationCompensated: flowEvidence.unreceiptedDisconnect.absentFromList,
    });
    return {
      mobileTimeoutWithLateAckOwnerPreserved: true,
      receiptCreationPreservedAfterDisconnect: true,
      unreceiptedLateCreationCompensated: true,
      providerRequestCount: finalProviderRequestCount,
      mobileBundleSha256: mobileWeb.bundleSha256,
      backendSha256: configuredBefore.sha256,
      backendProcessesAfterStop: ownedBackendAfterStop.length,
    };
  } catch (error) {
    await context.writeArtifactJson("failure-state.json", {
      activeStage,
      message: context.redactText(error instanceof Error ? error.message : String(error)),
      flowEvidence,
      mobileRequests,
      mobileResponses,
      mobileSockets,
      providerRequestCount: providerObserver.requests.length,
      providerRequests: providerObserver.requests,
      gateEvents: await readGateEvents(gateEventsPath),
      diagnostics,
      gatewayStopped,
    }).catch(() => {});
    throw error;
  } finally {
    try { receiptRpc?.close(); } catch {}
    try { noReceiptRpc?.close(); } catch {}
    try { liveRpc?.close(); } catch {}
    await page.close().catch(() => {});
    await chromium.close().catch(() => {});
    if (!gatewayStopped) await context.stopOwned(gatewayLabel).catch(() => {});
    await providerObserver.close().catch(() => {});
  }
});

async function resolveMobileWebExport(context) {
  const retainedBundleRoot = process.env.KCODER_E2E_RETAINED_MOBILE_WEB_EXPORT_ROOT;
  const retainedManifestPath = process.env.KCODER_E2E_RETAINED_MOBILE_WEB_EXPORT_MANIFEST;
  assert.equal(Boolean(retainedBundleRoot), Boolean(retainedManifestPath), "retained Mobile Web reuse requires both bundle root and manifest paths");
  if (retainedBundleRoot && retainedManifestPath) {
    const absoluteBundleRoot = resolve(repoRoot, retainedBundleRoot);
    const absoluteManifestPath = resolve(repoRoot, retainedManifestPath);
    const retainedManifestBytes = await readFile(absoluteManifestPath);
    const retainedManifestSha256 = createHash("sha256").update(retainedManifestBytes).digest("hex");
    assert.equal(retainedManifestSha256, EXPECTED_RETAINED_EXPORT_MANIFEST_SHA256, "retained export manifest must match the root-approved artifact before copying");
    const retainedManifest = JSON.parse(retainedManifestBytes.toString("utf8"));
    assert.equal(retainedManifest.sourceTreeSha256, EXPECTED_FROZEN_SOURCE_TREE_SHA256, "retained export must derive from the immutable root-owned source snapshot");
    assert.equal(retainedManifest.bundleSha256, EXPECTED_RETAINED_EXPORT_BUNDLE_SHA256, "retained export bundle must match the root-approved 37-file artifact before copying");
    const reused = await reuseMobileWebExport(context, {
      bundleRoot: absoluteBundleRoot,
      manifestPath: absoluteManifestPath,
      expectedManifestSha256: EXPECTED_RETAINED_EXPORT_MANIFEST_SHA256,
      expectedBundleSha256: EXPECTED_RETAINED_EXPORT_BUNDLE_SHA256,
      expectedSourceTreeSha256: EXPECTED_FROZEN_SOURCE_TREE_SHA256,
      label: "thread-start-ack-loss-reviewed-export-reuse",
      outputName: "mobile-web-export",
    });
    assert.equal(reused.exportPerformed, false, "reviewed retained-bundle reuse must not invoke Expo");
    assert.equal(reused.sourceManifestSha256, EXPECTED_RETAINED_EXPORT_MANIFEST_SHA256, "copied source manifest must remain the root-approved artifact");
    assert.equal(reused.bundleSha256, EXPECTED_RETAINED_EXPORT_BUNDLE_SHA256, "copied bundle must remain the root-approved 37-file artifact");
    return {
      ...reused,
      source: "reviewed-retained-public-export",
      sourceManifestSha256: reused.sourceManifestSha256 ?? reused.sourceManifestSha,
      sourceTreeSha256: reused.sourceTreeSha256 ?? reused.sourceTreeSha,
      bundleSha256: reused.bundleSha256 ?? reused.bundleSha,
      bundleFileCount: reused.bundleFileCount ?? reused.bundleCount ?? reused.bundleFiles?.length,
      indexHtmlSha256: reused.indexHtmlSha256 ?? reused.indexHtmlSha,
      exportPerformed: reused.exportPerformed === true,
    };
  }

  const mobileRoot = resolve(FROZEN_SOURCE_SNAPSHOT_ROOT, "apps/kcoder-studio/mobile");
  const sharedRoot = resolve(FROZEN_SOURCE_SNAPSHOT_ROOT, "apps/kcoder-studio/shared");
  const exported = await exportMobileWeb(context, {
    label: "thread-start-ack-loss-mobile-export",
    outputName: "mobile-web-export",
    mobileRoot,
    sourceRoots: [
      { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot: MOBILE_DEPENDENCY_ROOT,
  });
  return {
    ...exported,
    source: "root-owned-immutable-source-export",
    sourceManifestSha256: EXPECTED_FROZEN_SNAPSHOT_MANIFEST_SHA256,
    exportPerformed: true,
  };
}

async function verifyFrozenMobileSnapshot() {
  const raw = await readFile(FROZEN_SOURCE_SNAPSHOT_MANIFEST, "utf8");
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  assert.equal(manifestSha256, EXPECTED_FROZEN_SNAPSHOT_MANIFEST_SHA256, "root-owned immutable snapshot manifest changed");
  const snapshot = JSON.parse(raw);
  assert.equal(snapshot.snapshotId, "20260930-205339Z-2f673d");
  assert.equal(snapshot.source?.sourceTreeSha256, EXPECTED_FROZEN_SOURCE_TREE_SHA256);
  assert.equal(snapshot.destination?.destinationTreeSha256, EXPECTED_FROZEN_SOURCE_TREE_SHA256);
  assert.equal(snapshot.source?.fileCount, EXPECTED_FROZEN_MOBILE_FILES);
  assert.equal(snapshot.destination?.fileCount, EXPECTED_FROZEN_MOBILE_FILES);
  assert.deepEqual(snapshot.roots?.map(root => ({
    name: root.name,
    destination: root.destination,
    fileCount: root.fileCount,
    sha256: root.destinationRecomputedSha256,
  })), [
    { name: "mobile", destination: "apps/kcoder-studio/mobile", fileCount: 230, sha256: "4a65c1c4ba869221b5512024da13e3278c4de6c9796bd83fe0df275d72722dc2" },
    { name: "studio-shared", destination: "apps/kcoder-studio/shared", fileCount: 9, sha256: "0f524a2080981948914acfb668efb0e4a0e88619e65e5fc23d5260160834f745" },
  ], "root-owned snapshot must describe the reviewed 230-file Mobile and 9-file shared source roots");

  const rootsByName = new Map(snapshot.roots.map(root => [root.name, root]));
  const rootFileRecords = new Map(snapshot.roots.map(root => [root.name, []]));
  const fileDigests = [];
  for (const entry of snapshot.files ?? []) {
    const root = rootsByName.get(entry.root);
    assert.ok(root, "snapshot entry must name a declared source root");
    assert.ok(entry.destinationPath.startsWith(`${root.destination}/`), "snapshot entry must stay inside its declared source root");
    assert.ok(!entry.destinationPath.startsWith("/") && !entry.destinationPath.split("/").includes(".."), "snapshot entry path must be relative and traversal-free");
    const filePath = resolve(FROZEN_SOURCE_SNAPSHOT_ROOT, entry.destinationPath);
    const pathFromSnapshot = relative(FROZEN_SOURCE_SNAPSHOT_ROOT, filePath);
    assert.ok(pathFromSnapshot && pathFromSnapshot !== ".." && !pathFromSnapshot.startsWith(`..${sep}`) && !pathFromSnapshot.startsWith(sep), "snapshot entry must remain inside its immutable root");
    const info = await lstat(filePath);
    assert.ok(info.isFile() && !info.isSymbolicLink(), "snapshot may contain only regular source files");
    const contents = await readFile(filePath);
    const digest = createHash("sha256").update(contents).digest("hex");
    assert.equal(contents.length, entry.size, `snapshot file size changed: ${entry.destinationPath}`);
    assert.equal(digest, entry.sourceSha256, `root-frozen source file changed: ${entry.destinationPath}`);
    assert.equal(digest, entry.destinationSha256, `root-frozen snapshot file changed: ${entry.destinationPath}`);
    const pathWithinRoot = entry.destinationPath.slice(root.destination.length + 1);
    rootFileRecords.get(root.name).push({ path: pathWithinRoot, size: contents.length, sha256: digest });
    fileDigests.push({ path: entry.destinationPath, sha256: digest });
  }
  assert.equal(fileDigests.length, EXPECTED_FROZEN_MOBILE_FILES, "the root-owned immutable snapshot must contain exactly 239 files");
  fileDigests.sort((left, right) => left.path.localeCompare(right.path));

  const computedRoots = [];
  for (const root of snapshot.roots) {
    const entries = rootFileRecords.get(root.name).sort((left, right) => left.path.localeCompare(right.path));
    assert.equal(entries.length, root.fileCount, `root-frozen file count changed for ${root.name}`);
    const sha256 = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    assert.equal(sha256, root.destinationRecomputedSha256, `root-frozen tree hash changed for ${root.name}`);
    computedRoots.push({ name: root.name, destination: root.destination, sha256 });
  }
  const sourceTreeSha256 = createHash("sha256").update(JSON.stringify(computedRoots)).digest("hex");
  assert.equal(sourceTreeSha256, EXPECTED_FROZEN_SOURCE_TREE_SHA256, "root-frozen Mobile/shared aggregate tree hash changed");
  return {
    fileCount: fileDigests.length,
    manifestSha256,
    sourceTreeSha256,
    fileDigestSetSha256: createHash("sha256").update(JSON.stringify(fileDigests)).digest("hex"),
    fileDigests,
    sourceRoots: snapshot.roots.map(root => ({
      name: root.name,
      sourceRoot: root.destination,
      destination: root.destination,
      sha256: root.destinationRecomputedSha256,
      fileCount: root.fileCount,
    })),
  };
}

async function retainPublicMobileBundle(context, mobileWeb) {
  assert.equal(mobileWeb.bundleFileCount, 37, "retain the expected frozen Mobile Web export only");
  const destinationRoot = context.pathInArtifacts("public-mobile-web-export");
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  const copiedFiles = [];
  for (const entry of mobileWeb.bundleFiles) {
    const sourcePath = resolve(mobileWeb.path, entry.path);
    const sourceRelative = relative(mobileWeb.path, sourcePath);
    assert.ok(sourceRelative && !sourceRelative.startsWith(`..${sep}`) && sourceRelative !== ".." && !sourceRelative.startsWith(sep), "public export entry must remain inside its owned output");
    const sourceStat = await lstat(sourcePath);
    assert.ok(sourceStat.isFile() && !sourceStat.isSymbolicLink(), "public export may contain only regular files");
    const sourceBytes = await readFile(sourcePath);
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    assert.equal(sourceBytes.length, entry.size, `export size changed before retention: ${entry.path}`);
    assert.equal(sourceSha256, entry.sha256, `export digest changed before retention: ${entry.path}`);

    const destinationPath = resolve(destinationRoot, entry.path);
    const destinationRelative = relative(destinationRoot, destinationPath);
    assert.ok(destinationRelative && !destinationRelative.startsWith(`..${sep}`) && destinationRelative !== ".." && !destinationRelative.startsWith(sep), "retained export entry must remain inside its artifact directory");
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, 0o600);
    const retainedBytes = await readFile(destinationPath);
    const retainedSha256 = createHash("sha256").update(retainedBytes).digest("hex");
    assert.equal(retainedBytes.length, entry.size, `retained export size mismatch: ${entry.path}`);
    assert.equal(retainedSha256, entry.sha256, `retained export digest mismatch: ${entry.path}`);
    copiedFiles.push({ path: entry.path, size: retainedBytes.length, sha256: retainedSha256 });
  }
  const copiedBundleSha256 = createHash("sha256").update(JSON.stringify(copiedFiles)).digest("hex");
  assert.equal(copiedFiles.length, 37);
  assert.equal(copiedBundleSha256, mobileWeb.bundleSha256, "retained public bundle must exactly match Expo's hashed export");
  const artifactDirectory = relative(context.runRoot, destinationRoot).split(sep).join("/");
  const artifactManifest = await context.writeArtifactJson("public-mobile-web-export-manifest.json", {
    schemaVersion: 1,
    purpose: "reusable public static Mobile Web export; contains no RunContext config, environment, or credentials",
    sourceCommit: "UNVERIFIED",
    sourceTreeSha256: mobileWeb.sourceTreeSha256,
    bundleSha256: copiedBundleSha256,
    bundleFileCount: copiedFiles.length,
    indexHtmlSha256: mobileWeb.indexHtmlSha256,
    directory: artifactDirectory,
    files: copiedFiles,
  });
  return {
    directory: artifactDirectory,
    manifest: relative(context.runRoot, artifactManifest).split(sep).join("/"),
    bundleSha256: copiedBundleSha256,
  };
}

function makeStdioGateWrapper({ backendBinary, gateDir, gateEventsPath }) {
  const encodedBackendBinary = JSON.stringify(backendBinary);
  const encodedGateDir = JSON.stringify(gateDir);
  const encodedEventsPath = JSON.stringify(gateEventsPath);
  return [
    "#!/usr/bin/env node",
    "\"use strict\";",
    "const { spawn } = require('node:child_process');",
    "const { access, appendFile } = require('node:fs/promises');",
    "const { setTimeout: delay } = require('node:timers/promises');",
    "const { once } = require('node:events');",
    "const readline = require('node:readline');",
    `const backendBinary = ${encodedBackendBinary};`,
    `const gateDir = ${encodedGateDir};`,
    `const gateEventsPath = ${encodedEventsPath};`,
    "const child = spawn(backendBinary, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });",
    "const requests = new Map();",
    "let gateIndex = 0;",
    "let stopping = false;",
    "let inputChain = Promise.resolve();",
    "const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "input.on('line', line => {",
    "  inputChain = inputChain.then(async () => {",
    "    let frame; try { frame = JSON.parse(line); } catch {}",
    "    if (frame && Number.isInteger(frame.id) && typeof frame.method === 'string') {",
    "      requests.set(String(frame.id), { method: frame.method, params: frame.params || {} });",
    "    }",
    "    if (frame?.method === 'thread/delete') {",
    "      await appendFile(gateEventsPath, JSON.stringify({ kind: 'delete-forwarded', idPresent: Object.hasOwn(frame, 'id'), requestId: Number.isSafeInteger(frame.id) ? frame.id : null, threadId: frame.params?.threadId || null }) + '\\n', { mode: 0o600 });",
    "    }",
    "    if (!child.stdin.write(line + '\\n')) await once(child.stdin, 'drain');",
    "  }).catch(error => { process.stderr.write('stdio gate input failure: ' + String(error?.message || error) + '\\n'); process.exitCode = 70; });",
    "});",
    "input.on('close', () => child.stdin.end());",
    "process.on('SIGTERM', () => { stopping = true; child.kill('SIGTERM'); });",
    "process.on('SIGINT', () => { stopping = true; child.kill('SIGINT'); });",
    "child.on('error', error => { process.stderr.write('fixed backend launch failure: ' + String(error?.message || error) + '\\n'); process.exitCode = 71; });",
    "const childExit = new Promise(resolve => child.once('exit', code => resolve(code)));",
    "const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });",
    "async function main() {",
    "for await (const line of output) {",
    "  let frame; try { frame = JSON.parse(line); } catch {}",
    "  if (frame && Number.isInteger(frame.id) && !frame.method) {",
    "    const request = requests.get(String(frame.id));",
    "    if (request?.method === 'thread/delete') {",
    "      await appendFile(gateEventsPath, JSON.stringify({ kind: 'delete-response', requestId: frame.id, threadId: request.params?.threadId || null, ok: !frame.error, errorCode: frame.error?.code ?? null }) + '\\n', { mode: 0o600 });",
    "    }",
    "    if (request?.method === 'thread/start') {",
    "      gateIndex += 1;",
    "      const event = { kind: 'held', index: gateIndex, requestId: frame.id, threadId: frame.result?.thread?.id || null, hasClientRequestId: typeof request.params?.clientRequestId === 'string' && request.params.clientRequestId.trim().length > 0 };",
    "      await appendFile(gateEventsPath, JSON.stringify(event) + '\\n', { mode: 0o600 });",
    "      const releasePath = require('node:path').join(gateDir, 'release-' + gateIndex);",
    "      while (!stopping) {",
    "        try { await access(releasePath); break; } catch {}",
    "        await delay(20);",
    "      }",
    "      if (stopping) break;",
    "      await appendFile(gateEventsPath, JSON.stringify({ kind: 'released', index: gateIndex, requestId: frame.id, threadId: event.threadId }) + '\\n', { mode: 0o600 });",
    "    }",
    "    requests.delete(String(frame.id));",
    "  }",
    "  if (!process.stdout.write(line + '\\n')) await once(process.stdout, 'drain');",
    "}",
    "const code = await childExit;",
    "if (process.exitCode === undefined) process.exitCode = Number.isInteger(code) ? code : 0;",
    "}",
    "main().catch(error => { process.stderr.write('stdio gate failure: ' + String(error?.message || error) + '\\n'); process.exitCode = 72; });",
    "",
  ].join("\n");
}

async function startProviderObserver(context) {
  const requests = [];
  const server = createServer((request, response) => {
    const record = { method: request.method || "", path: new URL(request.url || "/", "http://127.0.0.1").pathname, bytes: 0 };
    requests.push(record);
    request.on("data", chunk => { record.bytes += chunk.length; });
    request.on("error", () => {});
    request.resume();
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: { message: "E2E observer records unexpected Provider traffic and never generates a model response" } }));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  context.registerPort("thread-start-ack-loss-provider-observer", port);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise(resolveClose => server.close(() => resolveClose()));
  };
  context.addCleanup("close thread-start ACK loss Provider observer", close);
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close };
}

async function connectMobile(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function readGateEvents(path) {
  const raw = await readFile(path, "utf8").catch(error => error?.code === "ENOENT" ? "" : Promise.reject(error));
  return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function waitForGateEvent(context, path, index, kind, timeoutMs) {
  return waitFor(
    async () => (await readGateEvents(path)).find(event => event.index === index && event.kind === kind) ?? null,
    timeoutMs,
    `stdio gate ${kind} event ${index}`,
    25,
    context.abortSignal,
  );
}

async function releaseGate(gateDir, index) {
  const releasePath = resolve(gateDir, `release-${index}`);
  await writeFile(releasePath, "released\n", { mode: 0o600, flag: "wx" });
}

async function closeRpcAndWait(rpc, context, label) {
  rpc.close();
  await waitFor(
    () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
    5_000,
    label,
    25,
    context.abortSignal,
  );
}

async function captureRpcError(rpc, method, params) {
  const offset = rpc.messages().length;
  await assert.rejects(rpc.request(method, params, 5_000));
  const frame = rpc.messages().slice(offset).find(message => message.error && message.id !== undefined);
  assert.ok(frame?.error, `${method} must return a JSON-RPC error`);
  return { code: frame.error.code, message: frame.error.message };
}

async function collectThreadPaths(root, stateRoot, threadId) {
  const found = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      const relativePath = relative(stateRoot, path).split(sep).join("/");
      const components = relativePath.split("/");
      if (components.some(component => component === threadId || component.startsWith(`${threadId}.`))) {
        found.push(relativePath);
      }
      if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(root);
  return found.sort();
}
