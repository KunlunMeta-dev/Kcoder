import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import {
  installWebSocketReadyStateProbe,
  readWebSocketReadyStateProbe,
} from "../../harness/websocket-ready-state-probe.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const OLD_PROMPT = "E2E_REPEATABLE_PROMPT_SAME_TEXT";
const OLD_ASSISTANT = "E2E_REPEATABLE_OLD_ASSISTANT";
const NEW_ASSISTANT = "E2E_REPEATABLE_NEW_ASSISTANT";
const THREAD_ID = "e2e-repeated-text-thread";
const OLD_USER_ID = "persisted-old-user";
const OLD_ASSISTANT_ID = "persisted-old-assistant";
const NEW_USER_ID = "persisted-new-user";
const NEW_ASSISTANT_ID = "persisted-new-assistant";
const NEW_TURN_ID = "turn-repeated-text-new";
const NEW_ATTEMPT_ID = "attempt-repeated-text-new";
const ATTACHMENT_FILENAME = "new-turn-distinct-attachment.txt";
const ATTACHMENT_CONTENT = "only the later repeated-text turn owns this attachment\n";
const EXPECTED_BROKER_SHA256 =
  "de82c6d1b8d3811a82b182a1c852560e27dd88c2a80cae71095872687ba9b3ca";
const BROKER_SOURCE = resolve(
  repoRoot,
  "apps/kcoder-studio/src/workspace-app-server-broker.js",
);
const DEV_SERVER_SOURCE = resolve(repoRoot, "apps/kcoder-studio/dev-server.mjs");

// This intentionally tests the real Mobile Web bundle and real Gateway HTTP /
// WebSocket transport against a RunContext-owned scripted app-server. It does
// not make a Rust Engine, persistence, Provider, or model behavior claim.
await runE2E(
  import.meta.url,
  {
    testId: "mobile-qa-repeated-text-attachment-recovery",
    tier: "model-independent",
    modelPolicy:
      "real frozen Mobile Web and real Studio Gateway HTTP/WebSocket; scripted stdio app-server controls stale history and receipt timing; no Rust Engine, Provider, or model claim",
    retainSuccessLogs: true,
  },
  async (context) => {
    const sourceShaBefore = await hashFile(fileURLToPath(import.meta.url));
    const brokerShaBefore = await hashFile(BROKER_SOURCE);
    const devServerShaBefore = await hashFile(DEV_SERVER_SOURCE);
    assert.equal(
      brokerShaBefore,
      EXPECTED_BROKER_SHA256,
      "the real Gateway broker must match the independently reviewed frozen source",
    );

    const retainedBundle = await requiredBundlePins();
    const mobileWeb = await reuseMobileWebExport(context, {
      bundleRoot: retainedBundle.bundleRoot,
      manifestPath: retainedBundle.manifestPath,
      expectedSourceTreeSha256: retainedBundle.sourceTreeSha256,
      expectedManifestSha256: retainedBundle.manifestSha256,
      expectedBundleSha256: retainedBundle.bundleSha256,
      label: "repeated-text-mobile-web-export",
      outputName: "reused-mobile-web-export",
    });
    assert.equal(mobileWeb.exportPerformed, false);
    assert.equal(mobileWeb.bundleFileCount, 37);

    const workspace = context.pathInState("private-workspace");
    const configDir = context.pathInState("private-config");
    const mockDir = context.pathInState("scripted-app-server");
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(configDir, { recursive: true, mode: 0o700 }),
      mkdir(mockDir, { recursive: true, mode: 0o700 }),
    ]);
    await context.writeStateJson("private-config/settings.json", {});
    await context.writeStateJson("private-config/credentials.json", {});

    const mockStatePath = resolve(mockDir, "state.json");
    const mockEventsPath = resolve(mockDir, "events.jsonl");
    const releaseStartAckPath = resolve(mockDir, "release-start-ack.signal");
    const releaseReceiptPath = resolve(mockDir, "release-receipt.signal");
    const mockSource = scriptedAppServerSource({
      threadId: THREAD_ID,
      workspace,
      oldPrompt: OLD_PROMPT,
      oldAssistant: OLD_ASSISTANT,
      newAssistant: NEW_ASSISTANT,
      oldUserId: OLD_USER_ID,
      oldAssistantId: OLD_ASSISTANT_ID,
      newUserId: NEW_USER_ID,
      newAssistantId: NEW_ASSISTANT_ID,
      newTurnId: NEW_TURN_ID,
      newAttemptId: NEW_ATTEMPT_ID,
      attachmentFilename: ATTACHMENT_FILENAME,
      attachmentPath: `/e2e-attachments/${ATTACHMENT_FILENAME}`,
      statePath: mockStatePath,
      eventsPath: mockEventsPath,
      releaseStartAckPath,
      releaseReceiptPath,
    });
    const mockScriptPath = resolve(mockDir, "scripted-app-server.mjs");
    const launcherPath = resolve(mockDir, "scripted-app-server-launcher");
    await writeFile(mockScriptPath, mockSource, { mode: 0o600, flag: "wx" });
    const launcherSource = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(mockScriptPath)}\n`;
    await writeFile(launcherPath, launcherSource, { mode: 0o700, flag: "wx" });
    const mockSourceSha = hashText(mockSource);
    const launcherSourceSha = hashText(launcherSource);

    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Isolated scripted transcript fixture",
        runtime: "kcoder",
        transport: "local",
        command: launcherPath,
        workspace,
      },
    ]);
    let gatewayProcessPid = null;
    context.addCleanup("verify scripted app-server child cleanup", async () => {
      const fixtureEvents = await readMockEvents(mockEventsPath);
      const bootEvents = fixtureEvents.filter(
        (event) => event.kind === "fixture-boot",
      );
      const fixturePids = [...new Set(
        bootEvents
          .map((event) => event.pid)
          .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      )];
      const fixtureProcessExits = [];
      for (const pid of fixturePids) {
        fixtureProcessExits.push({
          pid,
          exitedAfterGatewayCleanup: await waitForProcessExit(pid, 5_000),
        });
      }
      const gatewayExitedAfterCleanup =
        Number.isSafeInteger(gatewayProcessPid) && gatewayProcessPid > 0
          ? !(await processIsAlive(gatewayProcessPid))
          : null;
      const shutdownPids = fixtureEvents
        .filter((event) => event.kind === "fixture-shutdown")
        .map((event) => Number.isSafeInteger(event.pid) ? event.pid : null)
        .filter((pid) => pid !== null);
      const cleanupVerified =
        fixturePids.length > 0 &&
        fixtureProcessExits.every((item) => item.exitedAfterGatewayCleanup) &&
        gatewayExitedAfterCleanup === true;
      await context.writeArtifactJsonInternal("fixture-process-cleanup.json", {
        gatewayOwnerLabel: "repeated-text-scripted-gateway",
        gatewayPid: gatewayProcessPid,
        gatewayExitedAfterCleanup,
        fixtureBootCount: bootEvents.length,
        fixturePids,
        fixtureProcessExits,
        fixtureShutdownPids: shutdownPids,
        cleanupVerified,
      });
      if (fixturePids.length > 0 && !cleanupVerified)
        throw new Error("scripted app-server fixture child survived Gateway cleanup");
    });
    const gateway = await startGateway(context, {
      auth: true,
      label: "repeated-text-scripted-gateway",
      workspace,
      serversFile,
      // The configured server command is the RunContext-owned mock launcher;
      // this value also prevents the Gateway's unused fallback from resolving
      // mutable target/debug/kcoder.
      kcoderBin: launcherPath,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_TRAINING_MODE: "true",
        KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
      },
    });
    gatewayProcessPid = gateway.child.pid ?? null;

    const chromium = await startChromium(context, {
      label: "repeated-text-mobile-chromium",
    });
    const page = await chromium.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    context.addCleanup("close repeated-text Mobile page", () =>
      page.close().catch(() => undefined),
    );

    const browserErrors = [];
    const historyFrames = [];
    const turnStartFrames = [];
    const receiptFrames = [];
    const rpcRequestMethodCounts = {};
    const rpcResponseMethodCounts = {};
    const rpcResponseErrorCodeCounts = {};
    let wirePhase = "connection-bootstrap";
    let intentionalDisconnectWindow = false;
    page.on("pageerror", (error) => {
      browserErrors.push({
        kind: "pageerror",
        message: context.redactText(error.message).slice(0, 240),
        phase: wirePhase,
        intentionalDisconnectWindow,
        expectedDisconnectClass: null,
      });
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        const rawMessage = message.text();
        browserErrors.push({
          kind: "console-error",
          message: context.redactText(rawMessage).slice(0, 240),
          phase: wirePhase,
          intentionalDisconnectWindow,
          expectedDisconnectClass: classifyControlledDisconnectConsoleError(
            rawMessage,
            gateway.baseUrl,
          ),
        });
      }
    });
    observeMobileRpcFrames(page, {
      historyFrames,
      turnStartFrames,
      receiptFrames,
      rpcRequestMethodCounts,
      rpcResponseMethodCounts,
      rpcResponseErrorCodeCounts,
      phase: () => wirePhase,
    });

    await connectMobile(page, gateway);
    await page.evaluate(installRuntimeWebSocketSendProbeInPage);
    await page.getByTestId("sessions").click();
    await page.getByTestId("session-search").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.getByTestId("session-search").fill("Repeated text attachment identity fixture");
    const threadRow = page.getByTestId(`session-${THREAD_ID}`);
    await threadRow.waitFor({ state: "visible", timeout: 30_000 });
    await threadRow.click();
    await page.getByTestId("message-input-root").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.getByText(OLD_ASSISTANT, { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    assert.equal(await page.getByTestId("message-user").count(), 1);
    assert.equal(
      await page
        .getByTestId("message-user")
        .nth(0)
        .locator('[data-testid^="message-attachment-"]')
        .count(),
      0,
      "the already-persisted old user row starts without attachments",
    );
    const initialVisibleUsers = await inspectUserRows(page);
    const initialAssistantVisible = await page
      .getByText(OLD_ASSISTANT, { exact: true })
      .isVisible();
    const initialHistoryScreenshot = "initial-history-before-send.png";
    await page.screenshot({
      path: context.pathInArtifacts(initialHistoryScreenshot),
      fullPage: true,
      animations: "disabled",
      mask: [
        page.locator(
          'input[type="password"], input[name*="token"], input[name*="secret"], input[name*="password"]',
        ),
        page.getByTestId("gateway-token"),
      ],
      maskColor: "#000000",
    });
    await context.writeArtifactJson("initial-history-observer-diagnostic.json", {
      source: {
        suiteSha256: sourceShaBefore,
        gatewayBrokerSha256: brokerShaBefore,
        gatewayServerSha256: devServerShaBefore,
      },
      phase: wirePhase,
      screenshot: initialHistoryScreenshot,
      visibleTranscript: {
        oldAssistantVisible: initialAssistantVisible,
        userRowCount: initialVisibleUsers.length,
        users: initialVisibleUsers.map((row) => ({
          textHash: hashText(row.text),
          attachmentTestIds: row.attachmentTestIds,
        })),
      },
      wireSummary: {
        requestMethodCounts: sortedCounts(rpcRequestMethodCounts),
        responseMethodCounts: sortedCounts(rpcResponseMethodCounts),
        historyFrames: historyFrames.map((frame) => ({ ...frame })),
        rawFramesOrParamsWritten: false,
      },
    });
    const initialHistoryFrame = historyFrames.find(
      (frame) => frame.phase === "connection-bootstrap" && frame.userRowCount === 1,
    );
    assert.ok(initialHistoryFrame, "Mobile must load the old persisted transcript over real Gateway WebSocket");
    assert.deepEqual(initialHistoryFrame.rowIds, [OLD_USER_ID, OLD_ASSISTANT_ID]);

    // Stage a distinct real browser-selected file through Mobile's upload flow.
    await page.getByTestId("composer-attachment").click();
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByText("选择文件", { exact: false }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: ATTACHMENT_FILENAME,
      mimeType: "text/plain",
      buffer: Buffer.from(ATTACHMENT_CONTENT),
    });
    await page
      .getByTestId(`staged-attachment-${encodeURIComponent(ATTACHMENT_FILENAME)}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-input").fill(OLD_PROMPT);

    const preTurnProbe = await readWebSocketReadyStateProbe(page);
    const openRuntimeSocketIndexesBefore = preTurnProbe.sockets
      .filter((socket) => socket.unforcedReadyState === 1)
      .map((socket) => socket.index);
    assert.ok(
      openRuntimeSocketIndexesBefore.length > 0,
      "Mobile must own an actual open runtime WebSocket before the send",
    );
    wirePhase = "accepted-turn-ack-held";
    await page.getByTestId("send-message").click();
    let accepted;
    try {
      accepted = await waitFor(
        async () => {
          const events = await readMockEvents(mockEventsPath);
          return events.find((event) => event.kind === "turn-start-ack-held") ?? null;
        },
        15_000,
        "scripted app-server accepts the new clientMessageId and holds its turn/start ACK",
        25,
        context.abortSignal,
      );
    } catch (error) {
      const timeoutScreenshot = "turn-start-ack-timeout.png";
      let timeoutScreenshotWritten = false;
      try {
        await page.screenshot({
          path: context.pathInArtifacts(timeoutScreenshot),
          fullPage: true,
          animations: "disabled",
          mask: [
            page.locator(
              'input[type="password"], input[name*="token"], input[name*="secret"], input[name*="password"]',
            ),
            page.getByTestId("gateway-token"),
          ],
          maskColor: "#000000",
        });
        timeoutScreenshotWritten = true;
      } catch {
        // Keep the safe method and UI summaries even if Chromium cannot capture a screenshot.
      }
      const currentRows = await inspectUserRows(page).catch(() => []);
      const inputValue = await page.getByTestId("message-input").inputValue().catch(() => "");
      const sendButton = page.getByTestId("send-message");
      const sendButtonVisible = await sendButton.isVisible().catch(() => false);
      const sendButtonDisabled = await sendButton.isDisabled().catch(() => null);
      const stagedAttachmentCount = await page
        .locator('[data-testid^="staged-attachment-"]')
        .count()
        .catch(() => 0);
      const fixtureEvents = await readMockEvents(mockEventsPath);
      const fixtureEventKindCounts = {};
      for (const event of fixtureEvents) {
        if (typeof event.kind === "string")
          incrementCount(fixtureEventKindCounts, event.kind);
      }
      const socketProbe = await readWebSocketReadyStateProbe(page).catch(() => null);
      await context.writeArtifactJson("turn-start-ack-timeout-diagnostic.json", {
        source: {
          suiteSha256: sourceShaBefore,
          gatewayBrokerSha256: brokerShaBefore,
          gatewayServerSha256: devServerShaBefore,
        },
        phase: wirePhase,
        failureName: error instanceof Error ? error.name : "Error",
        screenshot: timeoutScreenshotWritten ? timeoutScreenshot : null,
        browserState: {
          inputValueHash: hashText(inputValue),
          sendButtonVisible,
          sendButtonDisabled,
          stagedAttachmentCount,
          visibleUserRows: currentRows.map((row) => ({
            textHash: hashText(row.text),
            attachmentTestIds: row.attachmentTestIds,
          })),
          browserErrorKinds: sortedCounts(
            browserErrors.reduce((counts, item) => {
              incrementCount(counts, item.kind);
              return counts;
            }, {}),
          ),
        },
        wireSummary: {
          requestMethodCounts: sortedCounts(rpcRequestMethodCounts),
          responseMethodCounts: sortedCounts(rpcResponseMethodCounts),
          turnStartFrames: turnStartFrames.map((frame) => ({ ...frame })),
          runtimeSocketSendEvidence: await readRuntimeWebSocketSendEvidence(page).catch(() => []),
          runtimeSockets: socketProbe?.sockets.map(({ index, unforcedReadyState }) => ({
            index,
            unforcedReadyState,
          })) ?? [],
          rawFramesOrParamsWritten: false,
        },
        fixtureEventKindCounts: sortedCounts(fixtureEventKindCounts),
      });
      throw error;
    }
    assert.equal(accepted.turnId, NEW_TURN_ID);
    assert.equal(accepted.clientMessageIdPresent, true);
    assert.equal(accepted.attachmentFilename, ATTACHMENT_FILENAME);
    assert.equal(
      (await readMockEvents(mockEventsPath)).filter(
        (event) => event.kind === "turn-start-ack-held",
      ).length,
      1,
      "the scripted service must accept exactly one turn/start",
    );
    const acceptedTurnStartFrame = await waitFor(
      async () => turnStartFrames.length === 1 ? turnStartFrames[0] : null,
      5_000,
      "the browser WebSocket observer captures the accepted turn/start frame",
      25,
      context.abortSignal,
    );
    const runtimeSocketSendEvidence = await waitFor(
      async () => {
        const records = await readRuntimeWebSocketSendEvidence(page);
        return records.find(
          (record) =>
            record.method === "turn/start" &&
            record.requestId === acceptedTurnStartFrame.requestId,
        ) ?? null;
      },
      5_000,
      "the page-owned runtime socket probe correlates the frame to its actual WebSocket index",
      25,
      context.abortSignal,
    );
    const activeSocketBefore = preTurnProbe.sockets.find(
      (socket) =>
        socket.index === runtimeSocketSendEvidence.socketIndex &&
        socket.unforcedReadyState === 1,
    );
    assert.ok(
      activeSocketBefore,
      "the actual turn/start sender was one of the open runtime sockets observed before the send",
    );
    assert.equal(
      runtimeSocketSendEvidence.socketIndex,
      activeSocketBefore.index,
      "the accepted turn/start used the exact Mobile runtime socket later observed CLOSED",
    );
    await stopRuntimeWebSocketSendProbe(page);

    const fixtureEventsBeforeDisconnect = await readMockEvents(mockEventsPath);
    const heldStartEvents = fixtureEventsBeforeDisconnect.filter(
      (event) => event.kind === "turn-start-ack-held",
    );
    assert.equal(heldStartEvents.length, 1);
    const acceptedHistoryScreenshot = "turn-start-accepted-before-disconnect.png";
    await page.screenshot({
      path: context.pathInArtifacts(acceptedHistoryScreenshot),
      fullPage: true,
      animations: "disabled",
      mask: [
        page.locator(
          'input[type="password"], input[name*="token"], input[name*="secret"], input[name*="password"]',
        ),
        page.getByTestId("gateway-token"),
      ],
      maskColor: "#000000",
    });
    const acceptedFixtureEventKinds = {};
    for (const event of fixtureEventsBeforeDisconnect) {
      if (typeof event.kind === "string")
        incrementCount(acceptedFixtureEventKinds, event.kind);
    }
    await context.writeArtifactJson("accepted-turn-start-socket-diagnostic.json", {
      source: {
        suiteSha256: sourceShaBefore,
        gatewayBrokerSha256: brokerShaBefore,
        gatewayServerSha256: devServerShaBefore,
      },
      phase: "accepted-turn-ack-held",
      screenshot: acceptedHistoryScreenshot,
      acceptedTurnStart: {
        requestId: acceptedTurnStartFrame.requestId,
        threadId: acceptedTurnStartFrame.threadId,
        clientMessageIdPresent: acceptedTurnStartFrame.clientMessageIdPresent,
        clientMessageIdHash: acceptedTurnStartFrame.clientMessageIdHash,
        inputTextHash: acceptedTurnStartFrame.inputTextHash,
        attachmentFilename: acceptedTurnStartFrame.attachmentFilename,
        socketIndex: runtimeSocketSendEvidence.socketIndex,
        socketWasOpenBeforeSend: activeSocketBefore.unforcedReadyState === 1,
      },
      appServerAcceptedExactlyOneHeldAck: true,
      fixtureEventKindCounts: sortedCounts(acceptedFixtureEventKinds),
      rawFramesOrParamsWritten: false,
    });

    // Put the real browser network stack offline, then close only the native
    // Mobile runtime WebSocket proven to have sent this accepted turn/start.
    // The close event and unforced readyState are observed before releasing the
    // mock server's held reply; this is not a Playwright routed-socket simulation.
    const cdp = await page.context().newCDPSession(page);
    context.addCleanup("detach repeated-text network CDP session", () =>
      cdp.detach().catch(() => undefined),
    );
    await cdp.send("Network.enable");
    intentionalDisconnectWindow = true;
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "none",
    });
    const controlledSocketClose = await closeExactRuntimeWebSocket(page, {
      requestId: acceptedTurnStartFrame.requestId,
      socketIndex: runtimeSocketSendEvidence.socketIndex,
    });
    await context.writeArtifactJson("controlled-runtime-websocket-close.json", {
      source: {
        suiteSha256: sourceShaBefore,
        gatewayBrokerSha256: brokerShaBefore,
        gatewayServerSha256: devServerShaBefore,
      },
      networkModeBeforeClose: "cdp-offline",
      ...controlledSocketClose,
      rawFramesOrParamsWritten: false,
    });
    assert.equal(
      controlledSocketClose.nativeCloseInvoked,
      true,
      "the test must invoke the browser's native close on the exact turn/start socket",
    );
    assert.equal(
      controlledSocketClose.closeEventObserved,
      true,
      "the actual runtime WebSocket must dispatch its close event",
    );
    assert.equal(
      controlledSocketClose.unforcedReadyStateAtClose,
      3,
      "the actual runtime WebSocket must report unforced CLOSED at its close event",
    );
    const closedSocket = await waitFor(
      async () => {
        const probe = await readWebSocketReadyStateProbe(page);
        return probe.sockets.find(
          (socket) =>
            socket.index === activeSocketBefore.index &&
            socket.unforcedReadyState === 3,
        )
          ? probe
          : null;
      },
      5_000,
      "the actual captured Mobile runtime WebSocket reaches readyState CLOSED after CDP offline",
      25,
      context.abortSignal,
    );
    wirePhase = "receipt-recovery-transient-history";
    await writeFile(releaseStartAckPath, "release\n", { mode: 0o600, flag: "wx" });
    await waitFor(
      async () =>
        (await readMockEvents(mockEventsPath)).find(
          (event) => event.kind === "turn-start-ack-released-after-disconnect",
        ) ?? null,
      5_000,
      "the accepted turn/start reply is released only after the old browser WebSocket is observed CLOSED",
      25,
      context.abortSignal,
    );
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    });

    const postDisconnectRecovery = await waitFor(
      async () => {
        const events = await readMockEvents(mockEventsPath);
        const fixtureTransientPage = events.find(
          (event) =>
            event.kind === "indexed-history-read" &&
            event.phase === "accepted-before-receipt" &&
            event.rowIds?.length === 2,
        );
        const browserTransientPage = historyFrames.find(
          (frame) =>
            frame.phase === "receipt-recovery-transient-history" &&
            frame.rowIds?.length === 2,
        );
        const probe = await readWebSocketReadyStateProbe(page);
        const reopened = probe.sockets.find(
          (socket) =>
            socket.index > activeSocketBefore.index &&
            socket.unforcedReadyState === 1,
        );
        const priorClosed = probe.sockets.find(
          (socket) =>
            socket.index === activeSocketBefore.index &&
            socket.unforcedReadyState === 3,
        );
        return fixtureTransientPage && browserTransientPage && reopened && priorClosed
          ? { events, fixtureTransientPage, browserTransientPage, probe, reopened }
          : null;
      },
      20_000,
      "Mobile reconnects over a new real WebSocket and both fixture and browser observe the old-only indexed page",
      25,
      context.abortSignal,
    );
    intentionalDisconnectWindow = false;
    assert.deepEqual(
      postDisconnectRecovery.fixtureTransientPage.rowIds,
      [OLD_USER_ID, OLD_ASSISTANT_ID],
    );
    assert.deepEqual(
      postDisconnectRecovery.browserTransientPage.rowIds,
      [OLD_USER_ID, OLD_ASSISTANT_ID],
    );
    assert.equal(postDisconnectRecovery.fixtureTransientPage.userRowCount, 1);
    const fixturePidBeforeCheck = postDisconnectRecovery.events.find(
      (event) => event.kind === "fixture-boot",
    )?.pid;
    assert.ok(Number.isSafeInteger(fixturePidBeforeCheck) && fixturePidBeforeCheck > 0);
    assert.equal(postDisconnectRecovery.fixtureTransientPage.pid, fixturePidBeforeCheck);

    const verifyFailedSubmission = page.getByTestId("verify-failed-submission").first();
    const manualVerificationReady = await waitFor(
      async () => {
        const cards = page.getByTestId("failed-submission");
        const cardCount = await cards.count();
        const cardVisible = cardCount === 1 && await cards.first().isVisible();
        const cardText = cardVisible ? await cards.first().innerText() : "";
        const buttonCount = await page.getByTestId("verify-failed-submission").count();
        const buttonVisible = buttonCount === 1 && await verifyFailedSubmission.isVisible();
        const buttonDisabled = buttonVisible
          ? await verifyFailedSubmission.isDisabled()
          : null;
        const users = await inspectUserRows(page);
        const separatedRows = users.length === 2 &&
          users.every((row) => row.text.includes(OLD_PROMPT)) &&
          users[0].attachmentTestIds.length === 0 &&
          users[1].attachmentTestIds.length === 1 &&
          users[1].attachmentTestIds[0] === attachmentTestId(ATTACHMENT_FILENAME);
        return cardVisible &&
          cardText.includes("发送状态待核对") &&
          cardText.includes(OLD_PROMPT) &&
          cardText.includes(ATTACHMENT_FILENAME) &&
          buttonVisible && buttonDisabled === false && separatedRows
          ? { cardText, cardCount, buttonCount, buttonDisabled, users }
          : null;
      },
      10_000,
      "the unknown-send card becomes actionable after the old-only reconnect page and preserves the two separate user rows",
      50,
      context.abortSignal,
    );
    assert.equal(turnStartFrames.length, 1);
    assert.equal(rpcRequestMethodCounts["turn/receipt/read"] ?? 0, 0);
    const manualVerificationScreenshot = "manual-verification-before-receipt.png";
    await page.screenshot({
      path: context.pathInArtifacts(manualVerificationScreenshot),
      fullPage: true,
      animations: "disabled",
      mask: [
        page.locator(
          'input[type="password"], input[name*="token"], input[name*="secret"], input[name*="password"]',
        ),
        page.getByTestId("gateway-token"),
      ],
      maskColor: "#000000",
    });
    await context.writeArtifactJson("manual-verification-before-receipt.json", {
      source: {
        suiteSha256: sourceShaBefore,
        gatewayBrokerSha256: brokerShaBefore,
        gatewayServerSha256: devServerShaBefore,
      },
      action: "unknown-submission-ready-for-user-verification-after-offline-reconnect",
      screenshot: manualVerificationScreenshot,
      priorSocket: {
        index: activeSocketBefore.index,
        unforcedReadyState: 3,
        closeCode: controlledSocketClose.closeCode,
        closeWasClean: controlledSocketClose.closeWasClean,
        closeReason: controlledSocketClose.closeReason,
      },
      reopenedSocketIndex: postDisconnectRecovery.reopened.index,
      fixturePid: fixturePidBeforeCheck,
      staleHistory: {
        fixtureRowIds: postDisconnectRecovery.fixtureTransientPage.rowIds,
        fixtureUserRowCount: postDisconnectRecovery.fixtureTransientPage.userRowCount,
        browserRowIds: postDisconnectRecovery.browserTransientPage.rowIds,
        browserUserRowCount: postDisconnectRecovery.browserTransientPage.userRowCount,
      },
      unknownSubmissionCard: {
        visible: true,
        titlePresent: true,
        cardCount: manualVerificationReady.cardCount,
        buttonTestId: "verify-failed-submission",
        buttonCount: manualVerificationReady.buttonCount,
        buttonEnabled: !manualVerificationReady.buttonDisabled,
        contentMatchesSubmittedPrompt: manualVerificationReady.cardText.includes(OLD_PROMPT),
        attachmentFilenameMatches: manualVerificationReady.cardText.includes(ATTACHMENT_FILENAME),
        contentHash: hashText(manualVerificationReady.cardText),
      },
      visibleUsers: manualVerificationReady.users.map((row) => ({
        messageTextHash: hashText(row.text),
        attachmentTestIds: row.attachmentTestIds,
      })),
      turnStartFrameCount: turnStartFrames.length,
      receiptReadRequestCountBeforeClick:
        rpcRequestMethodCounts["turn/receipt/read"] ?? 0,
      rawFramesOrParamsWritten: false,
    });

    wirePhase = "manual-acceptance-verification";
    await verifyFailedSubmission.click();
    let receiptHeld;
    try {
      receiptHeld = await waitFor(
        async () => {
          const events = await readMockEvents(mockEventsPath);
          const receipt = events.find((event) => event.kind === "turn-receipt-read-held");
          const transientPage = events.find(
            (event) =>
              event.kind === "indexed-history-read" &&
              event.phase === "accepted-before-receipt" &&
              event.rowIds?.length === 2,
          );
          return receipt && transientPage ? { receipt, transientPage, events } : null;
        },
        20_000,
        "after the user checks the unknown send, Mobile queries the accepted receipt following the old-only reconnect page",
        25,
        context.abortSignal,
      );
    } catch (error) {
      const fixtureEvents = await readMockEvents(mockEventsPath);
      const fixtureEventKindCounts = {};
      const ignoredRpcMethodCounts = {};
      for (const event of fixtureEvents) {
        if (typeof event.kind === "string")
          incrementCount(fixtureEventKindCounts, event.kind);
        if (event.kind === "ignored-rpc" && typeof event.method === "string")
          incrementCount(ignoredRpcMethodCounts, event.method);
      }
      const fixtureHistoryReads = fixtureEvents
        .filter((event) => event.kind === "indexed-history-read")
        .map((event) => ({
          phase: event.phase ?? null,
          pid: Number.isSafeInteger(event.pid) ? event.pid : null,
          rowIds: Array.isArray(event.rowIds) ? event.rowIds.map(String) : [],
          rowCount: Number.isSafeInteger(event.rowCount) ? event.rowCount : null,
          userRowCount: Number.isSafeInteger(event.userRowCount)
            ? event.userRowCount
            : null,
        }));
      const fixtureThreadResumes = fixtureEvents
        .filter((event) => event.kind === "thread-resume")
        .map((event) => ({
          pid: Number.isSafeInteger(event.pid) ? event.pid : null,
          threadId: event.threadId === THREAD_ID ? THREAD_ID : null,
          running: typeof event.running === "boolean" ? event.running : null,
        }));
      const fixtureAppServerBoots = fixtureEvents
        .filter((event) => event.kind === "fixture-boot")
        .map((event) => ({
          pid: Number.isSafeInteger(event.pid) ? event.pid : null,
          residentThreadsAdvertised: event.residentThreadsAdvertised === true,
        }));
      const fixtureTurnLifecycle = fixtureEvents
        .filter(
          (event) =>
            event.kind === "turn-start-ack-held" ||
            event.kind === "turn-start-ack-released-after-disconnect",
        )
        .map((event) => ({
          kind: event.kind,
          pid: Number.isSafeInteger(event.pid) ? event.pid : null,
          clientMessageIdPresent:
            typeof event.clientMessageIdPresent === "boolean"
              ? event.clientMessageIdPresent
              : null,
          attachmentFilename:
            typeof event.attachmentFilename === "string"
              ? event.attachmentFilename
              : null,
        }));
      const fixtureReceiptReads = fixtureEvents
        .filter((event) => event.kind === "turn-receipt-read-held")
        .map((event) => ({
          pid: Number.isSafeInteger(event.pid) ? event.pid : null,
          clientMessageIdMatchesAccepted:
            typeof event.clientMessageIdMatchesAccepted === "boolean"
              ? event.clientMessageIdMatchesAccepted
              : null,
          responseHeld: typeof event.responseHeld === "boolean"
            ? event.responseHeld
            : null,
        }));
      const fixtureStateSummary = await readMockStateSummary(mockStatePath);
      const socketProbe = await readWebSocketReadyStateProbe(page).catch(() => null);
      const visibleUsers = await inspectUserRows(page).catch(() => []);
      const stagedAttachmentCount = await page
        .locator('[data-testid^="staged-attachment-"]')
        .count()
        .catch(() => 0);
      const sendButton = page.getByTestId("send-message");
      const sendButtonVisible = await sendButton.isVisible().catch(() => false);
      const sendButtonDisabled = await sendButton.isDisabled().catch(() => null);
      const fixtureKinds = new Set(fixtureEvents.map((event) => event.kind));
      const reopenedSocket = socketProbe?.sockets.find(
        (socket) =>
          socket.index > activeSocketBefore.index &&
          socket.unforcedReadyState === 1,
      );
      const fixtureTransientRead = fixtureHistoryReads.find(
        (read) =>
          read.phase === "accepted-before-receipt" &&
          read.rowIds.length === 2,
      );
      const clientTransientRead = historyFrames.find(
        (frame) =>
          frame.phase === "receipt-recovery-transient-history" &&
          frame.rowIds?.length === 2,
      );
      await context.writeArtifactJson(
        "reconnect-history-receipt-timeout-diagnostic.json",
        {
          source: {
            suiteSha256: sourceShaBefore,
            gatewayBrokerSha256: brokerShaBefore,
            gatewayServerSha256: devServerShaBefore,
          },
          phase: wirePhase,
          failureName: error instanceof Error ? error.name : "Error",
          progress: {
            heldAckReleased: fixtureKinds.has(
              "turn-start-ack-released-after-disconnect",
            ),
            newRuntimeSocketOpen: Boolean(reopenedSocket),
            fixtureSawOldOnlyIndexedPage: Boolean(fixtureTransientRead),
            browserSawOldOnlyIndexedPage: Boolean(clientTransientRead),
            fixtureSawReceiptRead: fixtureReceiptReads.length > 0,
            browserSentReceiptRead:
              (rpcRequestMethodCounts["turn/receipt/read"] ?? 0) > 0,
            browserReceivedReceiptReply:
              (rpcResponseMethodCounts["turn/receipt/read"] ?? 0) > 0,
          },
          rpcSummary: {
            requestMethodCounts: sortedCounts(rpcRequestMethodCounts),
            responseMethodCounts: sortedCounts(rpcResponseMethodCounts),
            responseErrorCodeCounts: sortedCounts(rpcResponseErrorCodeCounts),
          },
          fixtureSummary: {
            eventKindCounts: sortedCounts(fixtureEventKindCounts),
            ignoredRpcMethodCounts: sortedCounts(ignoredRpcMethodCounts),
            appServerBoots: fixtureAppServerBoots,
            turnLifecycle: fixtureTurnLifecycle,
            indexedHistoryReads: fixtureHistoryReads,
            threadResumes: fixtureThreadResumes,
            receiptReads: fixtureReceiptReads,
            state: fixtureStateSummary,
          },
          browserSummary: {
            visibleUsers: visibleUsers.map((row) => ({
              textHash: hashText(row.text),
              attachmentTestIds: row.attachmentTestIds,
            })),
            stagedAttachmentCount,
            sendButtonVisible,
            sendButtonDisabled,
            historyFrames: historyFrames.map((frame) => ({
              phase: frame.phase,
              requestId: frame.requestId,
              rowIds: frame.rowIds,
              roles: frame.roles,
              rowCount: frame.rowCount,
              userRowCount: frame.userRowCount,
              attachmentCountsByUser: frame.attachmentCountsByUser,
            })),
            receiptFrames: receiptFrames.map((frame) => ({ ...frame })),
            runtimeSockets: socketProbe?.sockets.map(
              ({ index, unforcedReadyState }) => ({ index, unforcedReadyState }),
            ) ?? [],
            controlledSocketClose,
            browserErrorKinds: sortedCounts(
              browserErrors.reduce((counts, item) => {
                incrementCount(counts, item.kind);
                return counts;
              }, {}),
            ),
          },
          rawFramesOrParamsWritten: false,
        },
      );
      throw error;
    }
    assert.equal(receiptHeld.transientPage.userRowCount, 1);
    assert.deepEqual(receiptHeld.transientPage.rowIds, [OLD_USER_ID, OLD_ASSISTANT_ID]);
    assert.equal(receiptHeld.receipt.clientMessageIdMatchesAccepted, true);
    assert.equal(receiptHeld.receipt.responseHeld, true);

    const probeDuringRecovery = await waitFor(
      async () => {
        const probe = await readWebSocketReadyStateProbe(page);
        const reopened = probe.sockets.find(
          (socket) =>
            socket.index > activeSocketBefore.index &&
            socket.unforcedReadyState === 1,
        );
        return reopened ? probe : null;
      },
      10_000,
      "Mobile opens a new actual WebSocket after the real closed socket",
      25,
      context.abortSignal,
    );
    assert.ok(
      probeDuringRecovery.sockets.some(
        (socket) =>
          socket.index === activeSocketBefore.index &&
          socket.unforcedReadyState === 3,
      ),
      "the prior Mobile socket remains observably CLOSED after reconnection",
    );
    const recoveryPageFrame = historyFrames.find(
      (frame) =>
        frame.phase === "receipt-recovery-transient-history" &&
        frame.rowIds?.length === 2 &&
        frame.rowIds.includes(OLD_USER_ID),
    );
    assert.ok(
      recoveryPageFrame,
      "the real browser must receive the old-only indexed transcript page before the held receipt",
    );
    assert.deepEqual(recoveryPageFrame.rowIds, [OLD_USER_ID, OLD_ASSISTANT_ID]);

    await waitFor(
      async () => {
        const rows = await inspectUserRows(page);
        return rows.length === 2 &&
          rows[0].attachmentTestIds.length === 0 &&
          rows[1].attachmentTestIds.length === 1 &&
          rows[1].attachmentTestIds[0] === attachmentTestId(ATTACHMENT_FILENAME)
          ? rows
          : null;
      },
      10_000,
      "before receipt release the visible timeline retains old history and a separate optimistic repeated-text row with only the new attachment",
      50,
      context.abortSignal,
    );
    const visibleDuringHeldReceipt = await inspectUserRows(page);
    assert.equal(visibleDuringHeldReceipt.length, 2);
    assert.ok(visibleDuringHeldReceipt.every((row) => row.text.includes(OLD_PROMPT)));
    assert.deepEqual(visibleDuringHeldReceipt[0].attachmentTestIds, []);
    assert.deepEqual(visibleDuringHeldReceipt[1].attachmentTestIds, [attachmentTestId(ATTACHMENT_FILENAME)]);
    assert.equal(
      turnStartFrames.length,
      1,
      "Mobile must not submit a duplicate turn/start while the accepted receipt is pending",
    );

    wirePhase = "completed-receipt-history";
    await writeFile(releaseReceiptPath, "release\n", { mode: 0o600, flag: "wx" });
    await page.getByText(NEW_ASSISTANT, { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await waitFor(
      async () => {
        const rows = await inspectUserRows(page);
        return rows.length === 2 &&
          rows[0].attachmentTestIds.length === 0 &&
          rows[1].attachmentTestIds.length === 1 &&
          rows[1].attachmentTestIds[0] === attachmentTestId(ATTACHMENT_FILENAME)
          ? rows
          : null;
      },
      20_000,
      "completed receipt history renders exactly two same-text users and keeps the new attachment on the later row",
      50,
      context.abortSignal,
    );
    const finalVisibleUsers = await inspectUserRows(page);
    assert.equal(finalVisibleUsers.length, 2);
    assert.ok(finalVisibleUsers.every((row) => row.text.includes(OLD_PROMPT)));
    assert.deepEqual(finalVisibleUsers[0].attachmentTestIds, []);
    assert.deepEqual(finalVisibleUsers[1].attachmentTestIds, [attachmentTestId(ATTACHMENT_FILENAME)]);
    await page.getByTestId("message-assistant").filter({ hasText: NEW_ASSISTANT }).waitFor({
      state: "visible",
      timeout: 10_000,
    });

    const mockState = JSON.parse(await readFile(mockStatePath, "utf8"));
    const mockEvents = await readMockEvents(mockEventsPath);
    const acceptedEvent = mockEvents.find((event) => event.kind === "turn-start-ack-held");
    const transientPageEvent = mockEvents.find(
      (event) =>
        event.kind === "indexed-history-read" &&
        event.phase === "accepted-before-receipt",
    );
    const completedPageEvent = mockEvents.find(
      (event) =>
        event.kind === "indexed-history-read" &&
        event.phase === "completed-after-receipt",
    );
    const fixtureBootEvents = mockEvents.filter(
      (event) => event.kind === "fixture-boot",
    );
    const ackReleasedEvent = mockEvents.find(
      (event) => event.kind === "turn-start-ack-released-after-disconnect",
    );
    const receiptHeldEvent = mockEvents.find(
      (event) => event.kind === "turn-receipt-read-held",
    );
    const receiptReleasedEvent = mockEvents.find(
      (event) => event.kind === "turn-receipt-read-released",
    );
    const fixturePid = fixtureBootEvents[0]?.pid ?? null;
    const receiptFrame = receiptFrames.find(
      (frame) => frame.phase === "completed-receipt-history" && frame.status === "completed",
    );
    const transientPageIndex = mockEvents.findIndex(
      (event) =>
        event.kind === "indexed-history-read" &&
        event.phase === "accepted-before-receipt",
    );
    const receiptHeldEventIndex = mockEvents.findIndex(
      (event) => event.kind === "turn-receipt-read-held",
    );
    assert.equal(mockState.finalized, true);
    assert.equal(mockState.history.length, 4);
    assert.ok(acceptedEvent);
    assert.ok(transientPageEvent);
    assert.ok(completedPageEvent);
    assert.equal(fixtureBootEvents.length, 1, "one resident scripted app-server process serves the full recovery");
    assert.ok(Number.isSafeInteger(fixturePid) && fixturePid > 0);
    assert.equal(fixtureBootEvents[0].residentThreadsAdvertised, true);
    for (const [label, event] of [
      ["accepted turn/start", acceptedEvent],
      ["released turn/start ACK", ackReleasedEvent],
      ["stale indexed history read", transientPageEvent],
      ["held turn receipt read", receiptHeldEvent],
      ["released turn receipt read", receiptReleasedEvent],
      ["final indexed history read", completedPageEvent],
    ]) {
      assert.ok(event, `fixture event exists for ${label}`);
      assert.equal(event.pid, fixturePid, `${label} was handled by the booted resident fixture process`);
    }
    const ackReleasedEventIndex = mockEvents.findIndex(
      (event) => event.kind === "turn-start-ack-released-after-disconnect",
    );
    const receiptReleasedEventIndex = mockEvents.findIndex(
      (event) => event.kind === "turn-receipt-read-released",
    );
    const completedPageIndex = mockEvents.findIndex(
      (event) =>
        event.kind === "indexed-history-read" &&
        event.phase === "completed-after-receipt",
    );
    assert.ok(ackReleasedEventIndex > mockEvents.findIndex((event) => event.kind === "fixture-boot"));
    assert.ok(transientPageIndex > ackReleasedEventIndex);
    assert.ok(receiptHeldEventIndex > transientPageIndex);
    assert.ok(receiptReleasedEventIndex > receiptHeldEventIndex);
    assert.ok(completedPageIndex > receiptReleasedEventIndex);
    assert.equal(transientPageEvent.userRowCount, 1);
    assert.equal(completedPageEvent.userRowCount, 2);
    assert.deepEqual(completedPageEvent.rowIds, [
      OLD_USER_ID,
      OLD_ASSISTANT_ID,
      NEW_USER_ID,
      NEW_ASSISTANT_ID,
    ]);
    assert.ok(receiptFrame, "the actual Mobile WebSocket receives the completed receipt response");
    assert.ok(receiptHeldEventIndex > transientPageIndex, "the accepted receipt is queried only after the stale indexed history page");
    assert.equal(acceptedEvent.clientMessageIdPresent, true);
    assert.equal(acceptedEvent.turnStartCount, 1);
    assert.equal(mockState.turnStartCount, 1);
    assert.equal(mockEvents.filter((event) => event.kind === "duplicate-turn-start").length, 0);
    assert.equal(acceptedEvent.sameTextAsOldUser, true);
    assert.equal(acceptedEvent.attachmentFilename, ATTACHMENT_FILENAME);
    assert.deepEqual(
      mockState.history.filter((message) => message.role === "user").map((message) => message.id),
      [OLD_USER_ID, NEW_USER_ID],
      "the final canonical mock history contains each same-text user turn exactly once",
    );
    assert.equal(
      mockState.history.find((message) => message.id === NEW_USER_ID)?.clientMessageId,
      mockState.accepted.clientMessageId,
    );
    const brokerShaAfter = await hashFile(BROKER_SOURCE);
    const devServerShaAfter = await hashFile(DEV_SERVER_SOURCE);
    const sourceShaAfter = await hashFile(fileURLToPath(import.meta.url));
    assert.equal(brokerShaAfter, brokerShaBefore, "Gateway broker source must not change during this run");
    assert.equal(devServerShaAfter, devServerShaBefore, "Gateway server source must not change during this run");
    assert.equal(sourceShaAfter, sourceShaBefore, "test source must not change during this run");

    const expectedDisconnectErrors = browserErrors.filter(
      (event) =>
        event.kind === "console-error" &&
        event.intentionalDisconnectWindow === true &&
        typeof event.expectedDisconnectClass === "string",
    );
    const unexpectedBrowserErrors = browserErrors.filter(
      (event) =>
        event.kind === "pageerror" ||
        event.intentionalDisconnectWindow !== true ||
        typeof event.expectedDisconnectClass !== "string",
    );
    const expectedDisconnectErrorCounts = expectedDisconnectErrors.reduce(
      (counts, event) => {
        incrementCount(counts, event.expectedDisconnectClass);
        return counts;
      },
      {},
    );
    const browserErrorSummary = {
      intentionalDisconnectWindow: {
        openedAfterCdpOffline: true,
        closedAfterNewSocketAndOldHistoryObserved: true,
        closedBeforeManualVerificationClick: true,
        openAtFinalGate: intentionalDisconnectWindow,
      },
      allowedConsoleErrorClasses: [
        "offline-resource-disconnected",
        "owned-gateway-runtime-websocket-disconnected",
      ],
      maxAllowedTotal: 2,
      observedTotal: browserErrors.length,
      expectedDisconnectErrorCounts: sortedCounts(expectedDisconnectErrorCounts),
      expectedDisconnectErrorCount: expectedDisconnectErrors.length,
      unexpectedErrorCount: unexpectedBrowserErrors.length,
      events: browserErrors.map((event) => ({
        kind: event.kind,
        phase: event.phase,
        intentionalDisconnectWindow: event.intentionalDisconnectWindow,
        classification: event.expectedDisconnectClass,
      })),
    };
    await context.writeArtifactJson("recovery-core-observations.json", {
      stage: "core recovery assertions completed; browser error gate pending",
      coreRecoveryAssertionsCompleted: true,
      evidenceBoundary: {
        realMobileWeb: true,
        realStudioGatewayHttpAndWebSocket: true,
        scriptedJsonlAppServer: true,
        rustEngine: false,
        rustPersistence: false,
        providerConfigured: false,
        providerRequests: 0,
        modelBehaviorClaim: false,
        controlledNativeWebSocketClose: true,
        manualVerificationAfterOffline: true,
      },
      source: {
        suiteSha256: sourceShaBefore,
        gatewayBrokerSha256: brokerShaBefore,
        gatewayServerSha256: devServerShaBefore,
        mockAppServerSha256: mockSourceSha,
      },
      mobileBundle: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        exportPerformed: mobileWeb.exportPerformed,
      },
      fixtureProcess: {
        bootCount: fixtureBootEvents.length,
        pid: fixturePid,
        residentThreadsAdvertised: fixtureBootEvents[0].residentThreadsAdvertised,
        acceptedTurnStartPid: acceptedEvent.pid,
        releasedStartAckPid: ackReleasedEvent.pid,
        staleIndexedHistoryPid: transientPageEvent.pid,
        heldReceiptReadPid: receiptHeldEvent.pid,
        releasedReceiptReadPid: receiptReleasedEvent.pid,
        finalIndexedHistoryPid: completedPageEvent.pid,
        allLifecycleEventsShareBootPid: true,
        cleanupArtifact: "fixture-process-cleanup.json",
      },
      manualVerificationAfterOffline: {
        actionTestId: "verify-failed-submission",
        readinessArtifact: "manual-verification-before-receipt.json",
        turnStartFrameCount: turnStartFrames.length,
        receiptReadRequestCountBeforeClick: 0,
        receiptReadRequestCountAfterClick:
          rpcRequestMethodCounts["turn/receipt/read"] ?? 0,
      },
      finalHistory: mockState.history.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId ?? null,
        clientMessageIdPresent: Boolean(message.clientMessageId),
        attachmentCount: countAttachmentRecords(message.content),
      })),
      finalVisibleUsers: finalVisibleUsers.map((row) => ({
        messageTextHash: hashText(row.text),
        attachmentTestIds: row.attachmentTestIds,
      })),
      browserErrorSummary,
      rawFramesOrParamsWritten: false,
    });
    assert.equal(intentionalDisconnectWindow, false, "controlled disconnect error window must close before manual verification and the final gate");
    assert.equal(
      browserErrors.filter((event) => event.kind === "pageerror").length,
      0,
      "Mobile Web page errors are never allowed, including during the controlled disconnect",
    );
    assert.ok(
      expectedDisconnectErrors.length <= 2 &&
        Object.values(expectedDisconnectErrorCounts).every((count) => count <= 1),
      "only one exact owned-Gateway disconnect and one exact offline resource error are allowed",
    );
    assert.equal(
      unexpectedBrowserErrors.length,
      0,
      `Unexpected browser errors: ${JSON.stringify(browserErrorSummary.events.filter((event) => event.kind === "pageerror" || !event.intentionalDisconnectWindow || !event.classification))}`,
    );

    await context.writeArtifactJson("repeated-text-attachment-recovery.json", {
      evidenceBoundary: {
        realMobileWeb: true,
        realStudioGatewayHttpAndWebSocket: true,
        actualBrowserRuntimeSocketClosedByNativeClientCloseWhileCdpOffline: true,
        actualBrowserRuntimeSocketReopened: true,
        manualVerificationAfterOffline: true,
        manualVerificationTestId: "verify-failed-submission",
        scriptedJsonlAppServer: true,
        rustEngine: false,
        rustPersistence: false,
        providerConfigured: false,
        providerRequests: 0,
        modelBehaviorClaim: false,
      },
      source: {
        suiteSha256: sourceShaBefore,
        gatewayBrokerSha256: brokerShaBefore,
        gatewayServerSha256: devServerShaBefore,
        mockAppServerSha256: mockSourceSha,
        mockLauncherSha256: launcherSourceSha,
      },
      mobileBundle: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        exportPerformed: mobileWeb.exportPerformed,
        provenancePath: relative(context.runRoot, mobileWeb.provenancePath).split(sep).join("/"),
      },
      threadId: THREAD_ID,
      oldHistory: {
        userRowId: OLD_USER_ID,
        assistantRowId: OLD_ASSISTANT_ID,
        repeatedTextHash: hashText(OLD_PROMPT),
        wasAlreadyPresentBeforeSend: true,
        attachmentCount: 0,
      },
      acceptedNewTurn: {
        turnId: NEW_TURN_ID,
        attemptId: NEW_ATTEMPT_ID,
        clientMessageIdPresent: acceptedEvent.clientMessageIdPresent,
        clientMessageIdHash: acceptedEvent.clientMessageIdHash,
        samePromptHashAsOld: acceptedEvent.sameTextAsOldUser,
        attachmentFilename: ATTACHMENT_FILENAME,
        attachmentPathHash: acceptedEvent.attachmentPathHash,
        turnStartCount: acceptedEvent.turnStartCount,
      },
      fixtureProcess: {
        bootCount: fixtureBootEvents.length,
        pid: fixturePid,
        residentThreadsAdvertised: fixtureBootEvents[0].residentThreadsAdvertised,
        acceptedTurnStartPid: acceptedEvent.pid,
        releasedStartAckPid: ackReleasedEvent.pid,
        staleIndexedHistoryPid: transientPageEvent.pid,
        heldReceiptReadPid: receiptHeldEvent.pid,
        releasedReceiptReadPid: receiptReleasedEvent.pid,
        finalIndexedHistoryPid: completedPageEvent.pid,
        allLifecycleEventsShareBootPid: true,
        cleanupArtifact: "fixture-process-cleanup.json",
      },
      actualSocketRecovery: {
        priorSocketIndex: activeSocketBefore.index,
        acceptedTurnStartSocketIndex: runtimeSocketSendEvidence.socketIndex,
        priorSocketReadyStateAfterOffline: 3,
        reopenedSocketCount: probeDuringRecovery.runtimeSocketCount - 1,
        transientIndexedPageRows: transientPageEvent.rowIds,
        transientIndexedUserCount: transientPageEvent.userRowCount,
        receiptArrivedAfterTransientPage:
          receiptHeldEventIndex > transientPageIndex,
        manualVerificationAfterOffline: true,
        receiptReadRequestCountBeforeManualVerification: 0,
      },
      visibleBeforeReceipt: visibleDuringHeldReceipt.map((row) => ({
        messageTextHash: hashText(row.text),
        attachmentTestIds: row.attachmentTestIds,
      })),
      finalCanonicalHistory: mockState.history.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId ?? null,
        clientMessageIdPresent: Boolean(message.clientMessageId),
        attachmentCount: countAttachmentRecords(message.content),
      })),
      finalVisibleUsers: finalVisibleUsers.map((row) => ({
        messageTextHash: hashText(row.text),
        attachmentTestIds: row.attachmentTestIds,
      })),
      browserErrors,
      browserErrorSummary,
    });

    return {
      realMobileWeb: true,
      realGatewayHttpWebSocket: true,
      actualWebSocketCloseAndReconnect: true,
      manualVerificationAfterOffline: true,
      transientHistoryHadOnlyOldUser: true,
      finalVisibleUserCount: finalVisibleUsers.length,
      repeatedTextAppearsTwice: true,
      oldRowAttachmentCount: finalVisibleUsers[0].attachmentTestIds.length,
      newRowAttachmentCount: finalVisibleUsers[1].attachmentTestIds.length,
      turnStartCount: acceptedEvent.turnStartCount,
      receiptStatus: receiptFrame.status,
      providerRequests: 0,
      rustEngineClaim: false,
    };
  },
);

async function requiredBundlePins() {
  const manifestPath = process.env.KCODER_E2E_REPEATED_TEXT_MOBILE_MANIFEST;
  const sourceTreeSha256 = process.env.KCODER_E2E_REPEATED_TEXT_SOURCE_TREE_SHA256;
  const manifestSha256 = process.env.KCODER_E2E_REPEATED_TEXT_MANIFEST_SHA256;
  const bundleSha256 = process.env.KCODER_E2E_REPEATED_TEXT_BUNDLE_SHA256;
  assert.ok(manifestPath, "UNMET_PREREQUISITE: root must provide the frozen Mobile export manifest path before run");
  assert.ok(sourceTreeSha256, "UNMET_PREREQUISITE: root must pin the frozen Mobile source tree before run");
  assert.ok(manifestSha256, "UNMET_PREREQUISITE: root must pin the retained Mobile export manifest before run");
  assert.ok(bundleSha256, "UNMET_PREREQUISITE: root must pin the retained Mobile bundle before run");
  const absoluteManifestPath = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
  const sourceRunRoot = dirname(dirname(absoluteManifestPath));
  const bundleRoot = resolve(sourceRunRoot, ...String(manifest.directory).split("/"));
  return {
    manifestPath: absoluteManifestPath,
    bundleRoot,
    sourceTreeSha256,
    manifestSha256,
    bundleSha256,
  };
}

function observeMobileRpcFrames(
  page,
  {
    historyFrames,
    turnStartFrames,
    receiptFrames,
    rpcRequestMethodCounts,
    rpcResponseMethodCounts,
    rpcResponseErrorCodeCounts,
    phase,
  },
) {
  page.on("websocket", (socket) => {
    const methodsById = new Map();
    socket.on("framesent", (event) => {
      const message = parseFrame(event.payload);
      if (!message || !Number.isSafeInteger(message.id)) return;
      methodsById.set(message.id, message.method);
      if (typeof message.method === "string") incrementCount(rpcRequestMethodCounts, message.method);
      if (message.method === "turn/start") {
        const inputText = message.params?.input?.[0]?.text ?? "";
        const attachment = parseAttachment(inputText);
        turnStartFrames.push({
          phase: phase(),
          requestId: message.id,
          threadId: message.params?.threadId,
          clientMessageIdPresent: typeof message.params?.clientMessageId === "string",
          clientMessageIdHash: hashText(String(message.params?.clientMessageId ?? "")),
          inputTextHash: hashText(inputText),
          attachmentFilename: attachment?.filename ?? null,
          attachmentPathHash: hashText(attachment?.path ?? ""),
        });
      }
    });
    socket.on("framereceived", (event) => {
      const message = parseFrame(event.payload);
      if (!message || !Number.isSafeInteger(message.id)) return;
      const method = methodsById.get(message.id);
      methodsById.delete(message.id);
      if (typeof method === "string") incrementCount(rpcResponseMethodCounts, method);
      if (message.error) {
        const code = Number.isSafeInteger(message.error.code)
          ? String(message.error.code)
          : "unknown";
        incrementCount(
          rpcResponseErrorCodeCounts,
          `${typeof method === "string" ? method : "unknown"}:${code}`,
        );
      }
      if (method === "thread/read/indexed" && message.result) {
        historyFrames.push({
          phase: phase(),
          requestId: message.id,
          ...summarizeHistoryPage(message.result.messages ?? []),
        });
      }
      if (method === "turn/receipt/read" && message.result) {
        receiptFrames.push({
          phase: phase(),
          status: message.result.receipt?.status ?? null,
          turnId: message.result.receipt?.turnId ?? null,
          clientMessageIdMatchEvidence: Boolean(message.result.receipt),
        });
      }
    });
  });
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function classifyControlledDisconnectConsoleError(message, gatewayBaseUrl) {
  if (message === "Failed to load resource: net::ERR_INTERNET_DISCONNECTED")
    return "offline-resource-disconnected";
  const prefix = "WebSocket connection to '";
  if (!message.startsWith(prefix)) return null;
  const closingQuote = message.indexOf("'", prefix.length);
  if (closingQuote < 0) return null;
  if (!/(?:failed|closed|disconnect|ERR_INTERNET_DISCONNECTED)/i.test(message))
    return null;
  try {
    const target = new URL(message.slice(prefix.length, closingQuote));
    const gateway = new URL(gatewayBaseUrl);
    const expectedProtocol = gateway.protocol === "https:" ? "wss:" : "ws:";
    if (
      target.protocol === expectedProtocol &&
      target.host === gateway.host &&
      target.pathname === "/rpc" &&
      target.searchParams.get("server") === "local" &&
      target.searchParams.get("channel") === "runtime"
    )
      return "owned-gateway-runtime-websocket-disconnected";
  } catch {
    return null;
  }
  return null;
}

function sortedCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarizeHistoryPage(messages) {
  const values = Array.isArray(messages) ? messages : [];
  const userRows = values.filter((message) => message?.role === "user");
  return {
    rowIds: values.map((message) => String(message?.id ?? "")),
    roles: values.map((message) => String(message?.role ?? "")),
    rowCount: values.length,
    userRowCount: userRows.length,
    attachmentCountsByUser: userRows.map((message) => countAttachmentRecords(message?.content)),
  };
}

async function inspectUserRows(page) {
  return page.getByTestId("message-user").evaluateAll((rows) =>
    rows.map((row) => ({
      text: row.innerText.trim(),
      attachmentTestIds: [...row.querySelectorAll('[data-testid^="message-attachment-"]')]
        .map((element) => element.getAttribute("data-testid"))
        .filter(Boolean),
    })),
  );
}

function parseAttachment(value) {
  const match = String(value).match(/<kcoder_attachments[^>]*>\s*([\s\S]*?)\s*<\/kcoder_attachments>/i);
  if (!match?.[1]) return null;
  for (const line of match[1].split(/\r?\n/)) {
    try {
      const attachment = JSON.parse(line);
      if (typeof attachment?.filename === "string" && typeof attachment?.path === "string")
        return attachment;
    } catch {}
  }
  return null;
}

function countAttachmentRecords(value) {
  return (String(value ?? "").match(/"filename"\s*:/g) ?? []).length;
}

function attachmentTestId(filename) {
  return `message-attachment-${encodeURIComponent(filename)}`;
}

function parseFrame(value) {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

async function connectMobile(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  const loginInput = page.locator('input[name="token"]');
  if (await loginInput.count()) {
    await loginInput.fill(gateway.authToken);
    await Promise.all([
      page.waitForSelector('[data-testid="welcome-direct-connection"]', {
        timeout: 30_000,
      }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await installWebSocketReadyStateProbe(page);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

function installRuntimeWebSocketSendProbeInPage() {
  const probe = window["__kcoderE2eWebSocketReadyStateProbe"];
  if (!probe?.installed) {
    throw new Error("page-owned readyState probe is unavailable for send correlation");
  }
  const key = "__kcoderE2eRuntimeWebSocketSendEvidence";
  const evidence = { records: [], wrapped: new WeakSet(), timer: null };
  const wrapNewSockets = () => {
    probe.runtimeSockets.forEach((socket, socketIndex) => {
      if (evidence.wrapped.has(socket)) return;
      evidence.wrapped.add(socket);
      const originalSend = socket.send;
      Object.defineProperty(socket, "send", {
        configurable: true,
        writable: true,
        value(data) {
          try {
            const message = JSON.parse(String(data));
            if (message?.method === "turn/start") {
              evidence.records.push({
                socketIndex,
                requestId: message.id,
                method: message.method,
              });
            }
          } catch {
            // The evidence probe records only parseable turn/start frames.
          }
          return originalSend.call(socket, data);
        },
      });
    });
  };
  wrapNewSockets();
  evidence.timer = window.setInterval(wrapNewSockets, 10);
  Object.defineProperty(window, key, { value: evidence, configurable: false });
  return { installed: true, wrappedSocketCount: probe.runtimeSockets.length };
}

async function readRuntimeWebSocketSendEvidence(page) {
  return page.evaluate(() => {
    const evidence = window["__kcoderE2eRuntimeWebSocketSendEvidence"];
    if (!evidence) throw new Error("runtime WebSocket send evidence is unavailable");
    return evidence.records.map((record) => ({ ...record }));
  });
}

async function stopRuntimeWebSocketSendProbe(page) {
  await page.evaluate(() => {
    const evidence = window["__kcoderE2eRuntimeWebSocketSendEvidence"];
    if (evidence?.timer !== null) window.clearInterval(evidence.timer);
    if (evidence) evidence.timer = null;
  });
}

async function closeExactRuntimeWebSocket(page, { requestId, socketIndex }) {
  return page.evaluate(
    ({ requestId: targetRequestId, socketIndex: targetSocketIndex }) =>
      new Promise((resolve) => {
        const probe = window["__kcoderE2eWebSocketReadyStateProbe"];
        const evidence = window["__kcoderE2eRuntimeWebSocketSendEvidence"];
        const matchingSendRecords = (evidence?.records ?? []).filter(
          (record) =>
            record.method === "turn/start" &&
            record.requestId === targetRequestId &&
            record.socketIndex === targetSocketIndex,
        );
        const socket = probe?.runtimeSockets?.[targetSocketIndex];
        const stateSource = socket ? probe.stateReadSources.get(socket) : null;
        const base = {
          requestId: targetRequestId,
          socketIndex: targetSocketIndex,
          matchingTurnStartSendRecordCount: matchingSendRecords.length,
          socketFound: Boolean(socket),
        };
        const stateBefore = stateSource?.readUnforcedReadyState?.() ?? null;
        if (matchingSendRecords.length !== 1 || !socket || !stateSource) {
          resolve({
            ...base,
            unforcedReadyStateBeforeClose: stateBefore,
            nativeCloseInvoked: false,
            closeEventObserved: false,
            failureKind: "exact-turn-start-socket-correlation-missing",
          });
          return;
        }
        if (stateBefore !== 1) {
          resolve({
            ...base,
            unforcedReadyStateBeforeClose: stateBefore,
            nativeCloseInvoked: false,
            closeEventObserved: false,
            failureKind: "exact-turn-start-socket-not-open-before-close",
          });
          return;
        }

        let settled = false;
        let timeout = null;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (timeout !== null) window.clearTimeout(timeout);
          resolve(result);
        };
        timeout = window.setTimeout(() => {
          finish({
            ...base,
            unforcedReadyStateBeforeClose: stateBefore,
            nativeCloseInvoked: true,
            closeEventObserved: false,
            unforcedReadyStateAfterTimeout: stateSource.readUnforcedReadyState(),
            failureKind: "native-close-event-timeout",
          });
        }, 5_000);
        socket.addEventListener(
          "close",
          (event) => {
            finish({
              ...base,
              unforcedReadyStateBeforeClose: stateBefore,
              nativeCloseInvoked: true,
              closeEventObserved: true,
              closeCode: event.code,
              closeReason: event.reason,
              closeWasClean: event.wasClean,
              unforcedReadyStateAtClose: stateSource.readUnforcedReadyState(),
            });
          },
          { once: true },
        );
        try {
          const nativeClose = probe.originalConstructor?.prototype?.close;
          if (typeof nativeClose !== "function") {
            finish({
              ...base,
              unforcedReadyStateBeforeClose: stateBefore,
              nativeCloseInvoked: false,
              closeEventObserved: false,
              failureKind: "native-websocket-close-unavailable",
            });
            return;
          }
          nativeClose.call(socket, 4000, "owned-test-disconnect");
        } catch (error) {
          finish({
            ...base,
            unforcedReadyStateBeforeClose: stateBefore,
            nativeCloseInvoked: false,
            closeEventObserved: false,
            failureKind:
              error instanceof Error ? error.name : "native-close-threw",
          });
        }
      }),
    { requestId, socketIndex },
  );
}

async function readMockEvents(path) {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
  });
}

async function readMockStateSummary(path) {
  let state;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  const accepted =
    state.accepted !== null &&
    typeof state.accepted === "object" &&
    !Array.isArray(state.accepted)
      ? state.accepted
      : null;
  return {
    accepted: Boolean(accepted),
    acceptedClientMessageIdPresent:
      typeof accepted?.clientMessageId === "string" &&
      accepted.clientMessageId.length > 0,
    acceptedAttachmentPresent: Boolean(accepted?.attachment),
    acceptedAttachmentFilename:
      typeof accepted?.attachment?.filename === "string"
        ? accepted.attachment.filename
        : null,
    turnCompleted: state.turnCompleted === true,
    finalized: state.finalized === true,
    turnStartCount: Number.isSafeInteger(state.turnStartCount)
      ? state.turnStartCount
      : null,
    indexedReadCount: Number.isSafeInteger(state.indexedReadCount)
      ? state.indexedReadCount
      : null,
    historyRows: Array.isArray(state.history)
      ? state.history.map((message) => ({
          id: typeof message?.id === "string" ? message.id : null,
          role:
            message?.role === "user" || message?.role === "assistant"
              ? message.role
              : null,
          status: typeof message?.status === "string" ? message.status : null,
          turnIdPresent: typeof message?.turnId === "string",
          attemptIdPresent: typeof message?.attemptId === "string",
          attachmentCount: countAttachmentRecords(message?.content),
        }))
      : [],
  };
}

function scriptedAppServerSource(config) {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const config = ${JSON.stringify(config)};
const oldUser = {
  id: config.oldUserId,
  turnId: "turn-old",
  role: "user",
  content: config.oldPrompt,
  timestampMs: Date.now() - 60_000,
  blocks: [],
};
const oldAssistant = {
  id: config.oldAssistantId,
  turnId: "turn-old",
  attemptId: "turn-old",
  role: "assistant",
  content: "",
  status: "completed",
  timestampMs: Date.now() - 30_000,
  blocks: [{ id: "old-assistant-text", type: "text", content: config.oldAssistant, status: "done" }],
};
const state = {
  accepted: null,
  turnCompleted: false,
  finalized: false,
  history: [oldUser, oldAssistant],
  indexedReadCount: 0,
  turnStartCount: 0,
};
function saveState() {
  const temporary = config.statePath + ".tmp";
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, config.statePath);
}
function record(kind, fields = {}) {
  appendFileSync(config.eventsPath, JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...fields }) + "\\n", { mode: 0o600 });
}
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
function ok(id, result) {
  if (id !== undefined) send({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code, message } });
}
function thread() {
  const running = Boolean(state.accepted && !state.turnCompleted);
  return {
    id: config.threadId,
    cwd: config.workspace,
    title: "Repeated text attachment identity fixture",
    model: "scripted-model",
    modelProvider: "scripted",
    status: running ? "running" : "idle",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    updatedAt: new Date().toISOString(),
    runSummary: {
      mainTurn: running ? "running" : "idle",
      pendingApprovals: 0,
      pendingQuestions: 0,
      activeJobs: 0,
      tasksPending: 0,
      tasksRunning: 0,
      pendingFollowups: 0,
      pendingGoals: 0,
    },
  };
}
function readResult() {
  const messages = state.history;
  const phase = state.finalized ? "completed-after-receipt" : state.accepted ? "accepted-before-receipt" : "seed-history";
  state.indexedReadCount += 1;
  const rowIds = messages.map((message) => message.id);
  const userRowCount = messages.filter((message) => message.role === "user").length;
  record("indexed-history-read", { phase, rowIds, userRowCount, rowCount: messages.length });
  saveState();
  return {
    thread: thread(),
    messages,
    rangeStart: 0,
    rangeEnd: messages.length,
    hasMoreBefore: false,
    beforeCursor: null,
  };
}
function attachmentFromInput(input) {
  const text = Array.isArray(input) ? String(input[0]?.text ?? "") : "";
  const match = text.match(/<kcoder_attachments[^>]*>\\s*([\\s\\S]*?)\\s*<\\/kcoder_attachments>/i);
  if (!match?.[1]) return null;
  for (const line of match[1].split(/\\r?\\n/)) {
    try {
      const value = JSON.parse(line);
      if (typeof value?.filename === "string" && typeof value?.path === "string") return value;
    } catch {}
  }
  return null;
}
function completedHistory() {
  const inputText = String(state.accepted.inputText ?? "");
  const newUser = {
    id: config.newUserId,
    clientMessageId: state.accepted.clientMessageId,
    turnId: config.newTurnId,
    attemptId: config.newAttemptId,
    role: "user",
    content: inputText,
    timestampMs: Date.now(),
    blocks: [],
  };
  const newAssistant = {
    id: config.newAssistantId,
    turnId: config.newTurnId,
    attemptId: config.newAttemptId,
    role: "assistant",
    content: "",
    status: "completed",
    timestampMs: Date.now() + 1,
    blocks: [{ id: "new-assistant-text", type: "text", content: config.newAssistant, status: "done" }],
  };
  state.history = [oldUser, oldAssistant, newUser, newAssistant];
  state.finalized = true;
  saveState();
}
async function handle(message) {
  if (!message || typeof message.method !== "string") return;
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: "2026-07-27",
        capabilities: {
          threadResume: true,
          experimental: {
            residentThreads: true,
            threadIndexedPagesV1: true,
            turnReceiptsV1: true,
            threadRunSummaryV1: true,
          },
        },
      });
    case "thread/list":
      return ok(id, { threads: [thread()], completeness: "complete", issueCount: 0 });
    case "thread/resume":
      record("thread-resume", { threadId: params.threadId ?? null, running: Boolean(state.accepted && !state.turnCompleted) });
      return ok(id, { thread: thread() });
    case "thread/read/indexed":
    case "thread/read":
      return ok(id, readResult());
    case "thread/metadata/update":
      return ok(id, { thread: thread() });
    case "runtime.workspaces.list":
      return ok(id, { items: [{ workspacePath: config.workspace, label: "Repeated text fixture", workspaceKind: "workspace" }] });
    case "runtime.worktrees.list":
      return ok(id, { items: [] });
    case "runtime.models.list":
      return ok(id, {
        data: [
          {
            id: "scripted::scripted-model",
            model: "scripted-model",
            displayName: "Scripted model",
            providerId: "scripted",
            providerName: "Scripted",
            providerCurrent: true,
            isDefault: true,
          },
        ],
      });
    case "attachment/save": {
      const filename = String(params.filename ?? "");
      const path = "/e2e-attachments/" + filename;
      record("attachment-saved", { filename });
      ok(id, { path });
      return;
    }
    case "attachment/delete":
      return ok(id, { deleted: true });
    case "turn/start": {
      state.turnStartCount += 1;
      if (state.accepted) {
        record("duplicate-turn-start", { turnStartCount: state.turnStartCount });
        return fail(id, -32047, "duplicate scripted turn submission");
      }
      const clientMessageId = typeof params.clientMessageId === "string" ? params.clientMessageId : "";
      const inputText = String(params.input?.[0]?.text ?? "");
      const attachment = attachmentFromInput(params.input);
      if (params.threadId !== config.threadId || !clientMessageId) {
        return fail(id, -32602, "invalid scripted repeated-text turn identity");
      }
      state.accepted = { clientMessageId, inputText, attachment };
      saveState();
      record("turn-start-ack-held", {
        turnId: config.newTurnId,
        attemptId: config.newAttemptId,
        clientMessageIdPresent: true,
        clientMessageIdHash: hash(clientMessageId),
        sameTextAsOldUser: inputText.startsWith(config.oldPrompt),
        attachmentFilename: attachment?.filename ?? null,
        attachmentPathHash: hash(attachment?.path ?? ""),
        turnStartCount: state.turnStartCount,
      });
      // The receipt is accepted, but this simulated server deliberately withholds
      // the original start reply until the test observes the Mobile socket CLOSED.
      while (!existsSync(config.releaseStartAckPath)) await delay(20);
      ok(id, { turn: { id: config.newTurnId, threadId: config.threadId, attemptId: config.newAttemptId, status: "running" } });
      record("turn-start-ack-released-after-disconnect", { turnId: config.newTurnId });
      send({ jsonrpc: "2.0", method: "turn/started", params: {
        serverId: "scripted-local",
        threadId: config.threadId,
        turnId: config.newTurnId,
        attemptId: config.newAttemptId,
        sequence: 1,
        turn: { id: config.newTurnId, threadId: config.threadId, attemptId: config.newAttemptId, status: "running" },
      } });
      // The deterministic fixture completes while the lost ACK is being
      // recovered. This terminal event releases Gateway's interrupted-start
      // drain before the new client resumes the thread.
      state.turnCompleted = true;
      saveState();
      send({ jsonrpc: "2.0", method: "turn/completed", params: {
        serverId: "scripted-local",
        threadId: config.threadId,
        turnId: config.newTurnId,
        sequence: 2,
        turn: { id: config.newTurnId, threadId: config.threadId, attemptId: config.newAttemptId, status: "completed" },
        error: null,
      } });
      return;
    }
    case "turn/interrupt":
      record("late-interrupt-after-terminal-event", { turnId: params.turnId ?? null });
      return ok(id, {});
    case "turn/receipt/read": {
      const matches = state.accepted && params.clientMessageId === state.accepted.clientMessageId;
      record("turn-receipt-read-held", { clientMessageIdMatchesAccepted: Boolean(matches), responseHeld: true });
      if (!matches) return ok(id, { receipt: null });
      while (!existsSync(config.releaseReceiptPath)) await delay(20);
      completedHistory();
      record("turn-receipt-read-released", { status: "completed", turnId: config.newTurnId });
      ok(id, { receipt: { threadId: config.threadId, turnId: config.newTurnId, attemptId: config.newAttemptId, status: "completed" } });
      return;
    }
    default:
      record("ignored-rpc", { method });
      return ok(id, {});
  }
}

function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return (result >>> 0).toString(16).padStart(8, "0");
}
saveState();
record("fixture-boot", { residentThreadsAdvertised: true });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    void handle(message).catch((error) => {
      record("fixture-error", { message: String(error?.message ?? error).slice(0, 200) });
      if (message?.id !== undefined) fail(message.id, -32603, "scripted app-server fixture failed");
    });
  } catch {
    // Invalid input is ignored; the app-server stdout remains JSONL-only.
  }
});
input.on("close", () => {
  record("fixture-shutdown", { reason: "stdin-closed" });
  process.exit(0);
});
`;
}

function hashText(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return !processIsAlive(pid);
}

async function hashFile(path) {
  return hashText(await readFile(path));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
