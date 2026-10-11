import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import {
  configureWebSocketReadyStateProbe,
  installWebSocketReadyStateProbe,
  readWebSocketReadyStateProbe,
} from "../../harness/websocket-ready-state-probe.mjs";
import {
  gatewayRpcUrl,
  initializeRpc,
  openRpc,
} from "../../harness/rpc.mjs";
import {
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";

const FROZEN_SOURCE_TREE_SHA256 =
  process.env.KCODER_E2E_TRANSCRIPT_SOURCE_TREE_SHA256 ??
  "2f673d69fc972b84851b52b50dead516f97fa8ca1fffcebf03024ed9aa2b3082";
const EXPECTED_BACKEND_SHA256 =
  "4a2521addc98dfb11ab021a3bd680f5fdbf01d20a38ec8bfa4837e29e430f03b";
const FROZEN_SOURCE_MANIFEST = resolve(
  repoRoot,
  process.env.KCODER_E2E_TRANSCRIPT_SOURCE_MANIFEST ??
    "target/test/coordination/mobile-source-freezes/20260930-205339Z-2f673d/source-snapshot-manifest.json",
);
const FROZEN_SOURCE_MANIFEST_SHA256 =
  process.env.KCODER_E2E_TRANSCRIPT_SOURCE_MANIFEST_SHA256 ?? "";
const FIXTURE_PROMPTS = [
  "E2E_TRANSCRIPT_LONG_TABLE_BOOTSTRAP",
  "E2E_TRANSCRIPT_HEIGHT_TURN_02",
  "E2E_TRANSCRIPT_HEIGHT_TURN_03",
  "E2E_TRANSCRIPT_HEIGHT_TURN_04",
  "E2E_TRANSCRIPT_HEIGHT_TURN_05",
  "E2E_TRANSCRIPT_FRESH_NOT_SENT_RETRY_TARGET",
];
const TARGET_PROMPT = FIXTURE_PROMPTS.at(-1);
const LONG_REPLY_END = "E2E_TRANSCRIPT_LONG_TABLE_REPLY_END";
const FOLLOWUP_MARKERS = FIXTURE_PROMPTS.slice(1, -1).map(
  (_prompt, index) => `E2E_TRANSCRIPT_HEIGHT_REPLY_${String(index + 2).padStart(2, "0")}`,
);
const ROW_MARKER = "E2E_TRANSCRIPT_VARIABLE_TABLE_ROW";
const CODE_MARKER = "E2E_TRANSCRIPT_VARIABLE_CODE_LINE_";

const longTable = Array.from({ length: 34 }, (_unused, index) => {
  const row = String(index + 1).padStart(2, "0");
  const wrapCount = index % 4 === 0 ? 14 : index % 4 === 1 ? 5 : index % 4 === 2 ? 9 : 2;
  const variableCell = Array.from(
    { length: wrapCount },
    (_value, wordIndex) => `cell${row}word${String(wordIndex + 1).padStart(2, "0")}`,
  ).join(" ");
  return `| ${ROW_MARKER} ${row} | ${variableCell} | tail-${row} |`;
}).join("\n");
const longCode = Array.from(
  { length: 72 },
  (_unused, index) =>
    `const ${CODE_MARKER}${String(index + 1).padStart(3, "0")} = "${"variable-height-code-fragment ".repeat(index % 5 + 1)}";`,
).join("\n");
const LONG_TABLE_REPLY = [
  "# Transcript virtualization fixture",
  "",
  "This fixed local-provider answer is only a layout and history fixture.",
  "",
  ...Array.from({ length: 7 }, (_unused, index) =>
    `Paragraph ${index + 1}: ${"variable wrapped transcript content ".repeat(index % 3 + 2)}`,
  ),
  "",
  "| marker | variable cell | tail |",
  "| --- | --- | --- |",
  longTable,
  "",
  "```typescript",
  longCode,
  "```",
  "",
  LONG_REPLY_END,
].join("\n");

await runE2E(
  import.meta.url,
  {
    testId: "mobile-qa-transcript-latest-after-retry",
    tier: "model-independent",
    modelPolicy:
      "real Mobile Web, isolated Gateway and fixed app-server; deterministic local Provider creates variable-height transcript content only; no model-quality or Provider-selection claim",
    retainSuccessLogs: true,
  },
  async (context) => {
    const suiteSourceSha256AtStart = await sha256File(new URL(import.meta.url));
    const evidence = {
      testSource: "apps/kcoder-studio/e2e/suites/mobile/mobile-qa-transcript-latest-after-retry.e2e.mjs",
      testSourceSha256: suiteSourceSha256AtStart,
      freeze: {
        sourceTreeSha256: FROZEN_SOURCE_TREE_SHA256,
        sourceManifestPath: relative(repoRoot, FROZEN_SOURCE_MANIFEST),
      },
      fixtureBoundary: {
        realMobileWeb: true,
        realGateway: true,
        deterministicLocalProvider: true,
        nativeIme: "UNVERIFIED",
      },
      phases: {},
      browserErrors: [],
      transcriptNavigation: { interactions: [] },
    };
    let page = null;
    let gateway = null;
    let rpcAudit = null;
    let mobileState = null;
    let model = null;
    let sourceBundle = null;
    let binaryProvenance = null;

    try {
      evidence.phases.sourceFreeze = await verifyFrozenSourceFiles();
      sourceBundle = await copyFrozenPublicBundle(context);
      evidence.fixtureBoundary.mobileBundle = sourceBundle.provenance;

      const configuredBinary = resolve(
        process.env.KCODER_E2E_KCODER_BIN ||
          resolve(repoRoot, "target/kcoder-relay/bin/kcoder"),
      );
      await access(configuredBinary);
      const configuredBinaryHash = await hashExecutableFile(configuredBinary);
      assert.equal(
        configuredBinaryHash.sha256,
        EXPECTED_BACKEND_SHA256,
        "the test must use the fixed root-authorized 4a app-server binary",
      );
      const ownedBinDir = context.pathInState("bin");
      await mkdir(ownedBinDir, { recursive: true, mode: 0o700 });
      const ownedBinary = resolve(ownedBinDir, "kcoder");
      await copyFile(configuredBinary, ownedBinary);
      await chmod(ownedBinary, 0o700);
      const ownedBinaryHash = await hashExecutableFile(ownedBinary);
      assert.equal(ownedBinaryHash.sha256, EXPECTED_BACKEND_SHA256);
      evidence.fixtureBoundary.appServerConfiguredBinary = {
        configuredPathRelativeToRepo: relative(repoRoot, configuredBinary),
        configuredSha256: configuredBinaryHash.sha256,
        ownedPathRelativeToRun: relative(context.runRoot, ownedBinary),
        ownedSha256: ownedBinaryHash.sha256,
      };

      const workspace = context.pathInState("private-workspace");
      const configDir = context.pathInState("private-config");
      await Promise.all([
        mkdir(workspace, { recursive: true, mode: 0o700 }),
        mkdir(configDir, { recursive: true, mode: 0o700 }),
      ]);
      model = await startApprovalModelFixture(context, {
        responseSteps: ({ body }) => {
          const lastUser = [...(body.messages ?? [])]
            .reverse()
            .find((message) => message?.role === "user");
          const lastUserContent = JSON.stringify(lastUser?.content ?? "");
          if (lastUserContent.includes(FIXTURE_PROMPTS[0])) {
            return [
              { delta: { role: "assistant", content: LONG_TABLE_REPLY } },
              { finishReason: "stop" },
            ];
          }
          const followupIndex = FIXTURE_PROMPTS.findIndex(
            (prompt) => prompt !== TARGET_PROMPT && lastUserContent.includes(prompt),
          );
          if (followupIndex > 0) {
            const marker = FOLLOWUP_MARKERS[followupIndex - 1];
            const lineCount = 1 + (followupIndex % 3) * 5;
            const response = Array.from(
              { length: lineCount },
              (_unused, index) => `${marker} line-${index + 1} variable ${"height ".repeat(index + 1)}`,
            ).join("\n\n");
            return [
              { delta: { role: "assistant", content: response } },
              { finishReason: "stop" },
            ];
          }
          return [
            { delta: { role: "assistant", content: "E2E_TRANSCRIPT_RETRY_ACK" } },
            { finishReason: "stop" },
          ];
        },
      });
      const providerSettings = await context.writeStateJson(
        "transcript-provider-settings.json",
        {
          active_provider: "mobile-transcript-layout-fixture",
          permission_mode: "yolo",
          max_retries: 0,
          providers: {
            "mobile-transcript-layout-fixture": providerConfig(
              model.baseUrl,
              "mobile-transcript-layout-model",
            ),
          },
        },
      );
      await context.writeStateJson("private-config/settings.json", {});
      const serversFile = await context.writeStateJson("servers.json", [
        {
          id: "local",
          label: "Isolated Mobile transcript fixture",
          transport: "local",
          command: ownedBinary,
          workspace,
          settingsFile: providerSettings,
        },
      ]);
      gateway = await startGateway(context, {
        auth: true,
        label: "mobile-transcript-latest-gateway",
        workspace,
        serversFile,
        kcoderBin: ownedBinary,
        env: {
          KCODER_CONFIG_DIR: configDir,
          KCODER_TRAINING_MODE: "true",
          KCODER_STUDIO_WEB_ROOT: sourceBundle.path,
        },
      });

      const chromium = await startChromium(context, {
        label: "mobile-transcript-latest-chromium",
      });
      page = await chromium.newPage({
        viewport: { width: 360, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const browserInputCapabilities = await page.evaluate(() => ({
        maxTouchPoints: navigator.maxTouchPoints,
        touchEventTargetSupported: "ontouchstart" in window,
        coarsePointer: window.matchMedia("(pointer: coarse)").matches,
      }));
      assert.ok(
        browserInputCapabilities.maxTouchPoints > 0,
        "the Playwright page must expose an active Chromium touch device before Locator.tap is used",
      );
      evidence.fixtureBoundary.browserInput = {
        playwrightPageOptions: { isMobile: true, hasTouch: true },
        ...browserInputCapabilities,
        locatorTapUsesTouchscreen: true,
        scrollGestureUsesCdpInputDispatchTouchEvent: true,
      };
      context.addCleanup("close Mobile transcript diagnostic page", () =>
        page?.close().catch(() => undefined),
      );
      mobileState = createMobileWireState();
      installMobileWireObserver(page, mobileState);
      page.on("pageerror", (error) => {
        evidence.browserErrors.push({
          kind: "pageerror",
          message: context.redactText(error.message).slice(0, 240),
        });
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          evidence.browserErrors.push({
            kind: "console-error",
            message: context.redactText(message.text()).slice(0, 240),
          });
        }
      });

      await connectMobile(page, gateway, async () => {
        await installWebSocketReadyStateProbe(page);
      });
      const readyStateAfterConnect = await readWebSocketReadyStateProbe(page);
      assert.equal(readyStateAfterConnect.windowConstructorMatchesWrapper, true);
      evidence.phases.gatewayConnected = {
        runtimeSocketCount: readyStateAfterConnect.runtimeSocketCount,
        wrapperStillInstalled: readyStateAfterConnect.windowConstructorMatchesWrapper,
        boundary:
          "the sessions page has connected to Gateway; task runtime RPC socket may not exist until a task is entered",
      };

      const workspacePath = context.pathInState("private-workspace");
      await page.getByTestId("new-workspace").tap();
      await page.getByTestId("server-option-local").tap();
      await page.getByTestId("workspace-path").fill(workspacePath);
      await page
        .getByTestId("new-workspace-prompt")
        .fill(FIXTURE_PROMPTS[0]);
      await page.getByTestId("create-workspace").tap();
      await page.getByTestId("message-input-root").waitFor({
        state: "visible",
        timeout: 30_000,
      });
      const readyStateAfterTaskEntry = await readWebSocketReadyStateProbe(page);
      assert.equal(readyStateAfterTaskEntry.windowConstructorMatchesWrapper, true);
      assert.ok(
        readyStateAfterTaskEntry.runtimeSocketCount > 0,
        "entering a Mobile task must construct a runtime WebSocket observed by the installed probe",
      );
      evidence.phases.mobileTaskRuntimeConnected = {
        runtimeSocketCount: readyStateAfterTaskEntry.runtimeSocketCount,
        wrapperStillInstalled:
          readyStateAfterTaskEntry.windowConstructorMatchesWrapper,
        sockets: safeProbe(readyStateAfterTaskEntry).sockets,
      };
      binaryProvenance = await captureOwnedAppServerProvenance(
        context,
        gateway,
        ownedBinary,
        EXPECTED_BACKEND_SHA256,
      );
      evidence.fixtureBoundary.appServerBinaryProvenanceAtRuntimeConnect =
        binaryProvenance;
      await page.getByText(LONG_REPLY_END, { exact: true }).waitFor({
        state: "attached",
        timeout: 60_000,
      });
      let longTableGeometryPollCount = 0;
      let lastLongTableGeometrySample = null;
      try {
        const settledTable = await waitFor(
          async () => {
            longTableGeometryPollCount += 1;
            lastLongTableGeometrySample = await inspectLongFixture(page);
            return lastLongTableGeometrySample.tableRowMarkerCount === 34 &&
              lastLongTableGeometrySample.finalTableRowVisibleWithinList &&
              lastLongTableGeometrySample.messageList.scrollHeight >
                lastLongTableGeometrySample.messageList.clientHeight
              ? lastLongTableGeometrySample
              : null;
          },
          10_000,
          "the natural latest-follow scroll to settle with the final table row inside the real message-list viewport",
          50,
          context.abortSignal,
        );
        evidence.phases.longTableRendered = {
          ...settledTable,
          geometryPollCount: longTableGeometryPollCount,
          settledByNaturalLatestFollow: true,
        };
      } catch (error) {
        evidence.phases.longTableGeometryWait = {
          geometryPollCount: longTableGeometryPollCount,
          lastSample: lastLongTableGeometrySample,
          scrollWasNotForcedByTheTest: true,
        };
        throw error;
      }
      assert.ok(
        evidence.phases.longTableRendered.tableRowMarkerCount === 34,
        "all 34 variable-height Markdown table row markers must exist in the rendered transcript",
      );
      assert.ok(
        evidence.phases.longTableRendered.finalTableRowVisibleWithinList,
        "the final table row marker and tail must have real text-range geometry inside the message-list viewport",
      );
      assert.ok(
        evidence.phases.longTableRendered.messageList.scrollHeight >
          evidence.phases.longTableRendered.messageList.clientHeight,
        "the long table transcript must exceed the visible message-list viewport",
      );
      assert.ok(
        evidence.phases.longTableRendered.messageList.scrollWidth <=
          evidence.phases.longTableRendered.messageList.clientWidth + 1,
        "the long Markdown fixture must not make its message-list viewport horizontally overflow at 360 CSS pixels",
      );

      for (let index = 1; index < FIXTURE_PROMPTS.length - 1; index += 1) {
        const prompt = FIXTURE_PROMPTS[index];
        const marker = FOLLOWUP_MARKERS[index - 1];
        await page.getByTestId("message-input").fill(prompt);
        await page.getByTestId("send-message").tap();
        await waitFor(
          () => countProviderRequestsForPrompt(model.requests, prompt) === 1,
          30_000,
          `accepted fixture turn ${index + 1} to reach the local Provider once`,
          50,
          context.abortSignal,
        );
        await page.getByText(marker, { exact: false }).last().waitFor({
          state: "visible",
          timeout: 30_000,
        });
      }
      evidence.phases.multipleAcceptedTurns = {
        acceptedFixtureTurnCount: FIXTURE_PROMPTS.length - 2,
        providerRequestCounts: FIXTURE_PROMPTS.slice(0, -1).map((prompt) => ({
          promptKey: promptKey(prompt),
          count: countProviderRequestsForPrompt(model.requests, prompt),
        })),
        beforeTarget: await sampleTranscript(page, mobileState),
      };

      const cdp = await page.context().newCDPSession(page);
      context.addCleanup("detach transcript gesture CDP session", () =>
        cdp.detach().catch(() => undefined),
      );
      const scrollGestures = [];
      let beforeUpwardGesture = await sampleTranscript(page, mobileState);
      for (let index = 0; index < 4; index += 1) {
        const gesture = await dispatchTouchSwipe(cdp, page, "down", 520);
        await page.waitForTimeout(250);
        const after = await sampleTranscript(page, mobileState);
        scrollGestures.push({
          gesture,
          after,
          movedTowardOlderMessages:
            after.scrollTop < beforeUpwardGesture.scrollTop - 1,
        });
        if (scrollGestures.at(-1).movedTowardOlderMessages) break;
        beforeUpwardGesture = after;
      }
      const upwardGestureObserved = scrollGestures.some(
        (entry) => entry.movedTowardOlderMessages,
      );
      evidence.phases.userScrolledOlder = {
        boundary: "Chromium mobile-emulation CDP touch gesture; not a native device",
        upwardGestureObserved,
        gestures: scrollGestures,
        latestButtonVisible: await page
          .getByTestId("jump-to-latest")
          .isVisible()
          .catch(() => false),
      };

      const rpcCredentials = await mobileBrowserRpcCredentials(
        page,
        gateway,
        context,
      );
      evidence.phases.threadReadAuth = {
        queryTokenFromLoggedInMobilePage: true,
        ownedBrowserSessionCookie: true,
        trustedGatewayOrigin: true,
        credentialsRecorded: false,
      };
      rpcAudit = await openRpc(
        gatewayRpcUrl(gateway, "local", rpcCredentials.rpcToken),
        { headers: rpcCredentials.headers },
      );
      context.addCleanup("close transcript history audit RPC", () =>
        rpcAudit?.close(),
      );
      await initializeRpc(rpcAudit, "mobile-transcript-history-audit");
      const targetThreadId =
        mobileState.threadIdByPrompt.get(FIXTURE_PROMPTS.at(-2));
      assert.ok(
        typeof targetThreadId === "string" && targetThreadId.length > 0,
        "the immediately preceding accepted Mobile fixture turn must expose the target task thread ID for history audit",
      );
      const historyBefore = await readThreadHistory(
        rpcAudit,
        targetThreadId,
        TARGET_PROMPT,
        null,
      );
      assert.equal(
        historyBefore.targetPromptCount,
        0,
        "the proven fresh notSent retry target must not already exist in authoritative thread history",
      );
      evidence.phases.historyBeforeNotSent = historyBefore.safe;

      const listBeforeFailure = await sampleTranscript(page, mobileState);
      const startCountBefore = mobileState.turnStartFramesByPrompt.get(TARGET_PROMPT)?.length ?? 0;
      const providerCountBefore = countProviderRequestsForPrompt(
        model.requests,
        TARGET_PROMPT,
      );
      const scrollSettle = await waitForTranscriptScrollSettle(
        page,
        context.abortSignal,
      );
      evidence.phases.userScrolledOlder.scrollSettleBeforeSubmit = scrollSettle;

      const composerInput = page.getByTestId("message-input");
      await composerInput.fill(TARGET_PROMPT);
      const stableDraft = await waitForComposerDraftStable(
        composerInput,
        TARGET_PROMPT,
        context.abortSignal,
      );
      const draftBeforeTouch = await inspectComposerDraftValue(composerInput);
      const sendButton = page.getByTestId("send-message");
      const sendButtonReady = await waitFor(
        async () => {
          if (await sendButton.count() !== 1) return null;
          if (!(await sendButton.isVisible()) || !(await sendButton.isEnabled())) {
            return null;
          }
          return inspectComposerSendControl(page);
        },
        5_000,
        "the unique real composer send button to be visible and enabled",
        50,
        context.abortSignal,
      );
      assert.equal(sendButtonReady.disabled, false);
      assert.equal(sendButtonReady.hitTestInsideButton, true);
      assert.equal(stableDraft.sha256, sha256Text(TARGET_PROMPT));

      const probeBeforeForce = await readWebSocketReadyStateProbe(page);
      assert.equal(probeBeforeForce.windowConstructorMatchesWrapper, true);
      assert.ok(probeBeforeForce.sockets.some((socket) => socket.unforcedReadyState === 1));
      await configureWebSocketReadyStateProbe(page, {
        targetPrompt: TARGET_PROMPT,
        forceClosed: true,
        resetTargetSendCount: true,
      });
      const probeBeforeSubmit = await readWebSocketReadyStateProbe(page);
      const appForcedReadsBefore =
        probeBeforeSubmit.applicationForcedClosedReadyStateReads;
      assert.ok(
        probeBeforeSubmit.sockets.some(
          (socket) => socket.unforcedReadyState === 1 && socket.effectiveReadyState === 3,
        ),
        "the fault must force CLOSED only on the same captured browser-facing runtime socket that remains unforced OPEN",
      );

      await installComposerDomEventProbe(page);
      await armComposerDomEventProbe(page, "playwright-locator-touch-tap");
      await sendButton.tap({ timeout: 5_000 });
      const touchTapOutcome = await observeFreshSubmissionOutcome({
        page,
        mobileState,
        model,
        prompt: TARGET_PROMPT,
        startCountBefore,
        providerCountBefore,
        appForcedReadsBefore,
        timeoutMs: 2_000,
      });
      touchTapOutcome.events = await disarmComposerDomEventProbe(page);
      touchTapOutcome.composerDraftAfter = await inspectComposerDraftValue(
        composerInput,
      ).catch(() => null);
      touchTapOutcome.controlAfter = await inspectComposerSendControl(page).catch(
        () => null,
      );

      let mouseControlOutcome = null;
      const touchReachedControl = touchTapOutcome.events.events.some(
        (event) => eventReachedSendControlViaTouch(event),
      );
      const noSubmissionSignalAfterTouch =
        !touchTapOutcome.failedCardVisible &&
        touchTapOutcome.applicationForcedClosedReads === appForcedReadsBefore &&
        touchTapOutcome.targetSendCalls === 0 &&
        touchTapOutcome.targetGatewayTurnStartFrames === 0 &&
        touchTapOutcome.targetProviderRequests === providerCountBefore;
      if (touchReachedControl && noSubmissionSignalAfterTouch) {
        const mousePrecondition = await inspectComposerSendControl(page).catch(
          () => null,
        );
        const currentDraft = await inspectComposerDraftValue(composerInput);
        assert.equal(currentDraft.sha256, stableDraft.sha256);
        assert.ok(mousePrecondition && !mousePrecondition.disabled);
        await armComposerDomEventProbe(page, "playwright-locator-mouse-control");
        await sendButton.click({ timeout: 5_000 });
        mouseControlOutcome = await observeFreshSubmissionOutcome({
          page,
          mobileState,
          model,
          prompt: TARGET_PROMPT,
          startCountBefore,
          providerCountBefore,
          appForcedReadsBefore,
          timeoutMs: 2_000,
        });
        mouseControlOutcome.events = await disarmComposerDomEventProbe(page);
        mouseControlOutcome.composerDraftBefore = currentDraft;
        mouseControlOutcome.composerDraftAfter = await inspectComposerDraftValue(
          composerInput,
        ).catch(() => null);
        mouseControlOutcome.controlAfter = await inspectComposerSendControl(page).catch(
          () => null,
        );
        mouseControlOutcome.actionBoundary =
          "Playwright Locator.click mouse-control ran only after the touch tap reached the same send control but produced no submit/probe signal, with no target frame or Provider request; it is not evidence of touch success.";
      }
      evidence.phases.notSentClickDiagnosis = {
        scrollSettleBeforeSubmit: scrollSettle,
        composerDraft: stableDraft,
        composerDraftBeforeTouch: draftBeforeTouch,
        controlBeforeTouch: sendButtonReady,
        forcedSocketProbeBeforeTouch: safeProbe(probeBeforeSubmit),
        forcedApplicationReadBaseline: appForcedReadsBefore,
        touchReachedSendControl: touchReachedControl,
        touchTapOutcome,
        mouseControlOutcome,
        fallbackReason: mouseControlOutcome
          ? "trusted touch event reached send control but the app produced no submit signal; a single real Playwright mouse control was used"
          : null,
      };

      const failedCard = page
        .getByTestId("failed-submission")
        .filter({ hasText: TARGET_PROMPT })
        .first();
      await failedCard.waitFor({ state: "visible", timeout: 15_000 });
      await page.getByText("发送失败，草稿已保留", { exact: true }).last().waitFor({
        state: "visible",
        timeout: 10_000,
      });
      const probeAfterFailure = await readWebSocketReadyStateProbe(page);
      const startCountAfterFailure = mobileState.turnStartFramesByPrompt.get(TARGET_PROMPT)?.length ?? 0;
      assert.ok(
        probeAfterFailure.applicationForcedClosedReadyStateReads > appForcedReadsBefore,
        "the Mobile submit path must read the injected CLOSED state on the actual captured socket",
      );
      assert.equal(probeAfterFailure.targetTurnStartSendInvocations, 0);
      assert.equal(startCountAfterFailure - startCountBefore, 0);
      assert.equal(
        countProviderRequestsForPrompt(model.requests, TARGET_PROMPT),
        providerCountBefore,
      );
      const failedDraftClientMessageId = await readFailedDraftId(
        page,
        TARGET_PROMPT,
      );
      const listAfterFailure = await sampleTranscript(page, mobileState);
      evidence.phases.freshNotSent = {
        promptKey: "target-retry",
        preFailureList: listBeforeFailure,
        failedCardList: listAfterFailure,
        forcedSocketProbeBefore: safeProbe(probeBeforeSubmit),
        forcedSocketProbeAfter: safeProbe(probeAfterFailure),
        injectedReadyStateReadByApp:
          probeAfterFailure.applicationForcedClosedReadyStateReads - appForcedReadsBefore,
        targetSendCalls: probeAfterFailure.targetTurnStartSendInvocations,
        targetGatewayTurnStartFrames: startCountAfterFailure - startCountBefore,
        targetProviderRequests: countProviderRequestsForPrompt(model.requests, TARGET_PROMPT),
        persistedClientMessageIdSha256: sha256Text(failedDraftClientMessageId),
      };
      assert.equal(
        await failedCard.getByTestId("verify-failed-submission").count(),
        0,
      );
      const retryButton = failedCard.getByTestId("retry-failed-submission");
      assert.equal(await retryButton.isVisible(), true);
      await configureWebSocketReadyStateProbe(page, { forceClosed: false });
      await retryButton.tap();
      await waitFor(
        () => countProviderRequestsForPrompt(model.requests, TARGET_PROMPT) === 1,
        30_000,
        "same-ID retry to reach the deterministic local Provider exactly once",
        50,
        context.abortSignal,
      );
      await page.getByText("E2E_TRANSCRIPT_RETRY_ACK", { exact: true }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      await failedCard.waitFor({ state: "hidden", timeout: 20_000 });
      const targetTurnStarts = mobileState.turnStartFramesByPrompt.get(TARGET_PROMPT) ?? [];
      assert.equal(targetTurnStarts.length, 1);
      const retryTurn = targetTurnStarts[0];
      assert.equal(retryTurn.clientMessageId, failedDraftClientMessageId);
      assert.equal(retryTurn.threadId, targetThreadId);
      assert.equal(countProviderRequestsForPrompt(model.requests, TARGET_PROMPT), 1);
      evidence.phases.retryAcceptedOnce = {
        targetTurnStartFrames: targetTurnStarts.length,
        clientMessageIdStable: retryTurn.clientMessageId === failedDraftClientMessageId,
        clientMessageIdSha256: sha256Text(retryTurn.clientMessageId),
        threadIdSha256: sha256Text(retryTurn.threadId),
        acceptedTurnResponse: mobileState.targetTurnResponse
          ? {
              hasNonEmptyTurnId: Boolean(mobileState.targetTurnResponse.turnId),
              turnIdSha256: mobileState.targetTurnResponse.turnId
                ? sha256Text(mobileState.targetTurnResponse.turnId)
                : null,
              status: mobileState.targetTurnResponse.status,
              threadMatchesRequest:
                mobileState.targetTurnResponse.threadId === targetThreadId,
            }
          : null,
        providerRequestsForTarget: countProviderRequestsForPrompt(
          model.requests,
          TARGET_PROMPT,
        ),
        listAfterRetryBeforeNavigation: await sampleTranscript(page, mobileState),
      };
      assert.ok(
        evidence.phases.retryAcceptedOnce.acceptedTurnResponse?.hasNonEmptyTurnId,
        "the retry's real turn/start response must identify an accepted turn",
      );
      assert.equal(
        evidence.phases.retryAcceptedOnce.acceptedTurnResponse.threadMatchesRequest,
        true,
        "the accepted turn/start response must identify the same thread as the retried request",
      );
      assert.ok(
        ["running", "completed", "failed", "interrupted"].includes(
          evidence.phases.retryAcceptedOnce.acceptedTurnResponse.status,
        ),
      );

      const historyAfter = await readThreadHistory(
        rpcAudit,
        targetThreadId,
        TARGET_PROMPT,
        retryTurn.clientMessageId,
      );
      evidence.phases.historyAfterRetry = historyAfter.safe;
      assert.equal(
        historyAfter.targetPromptCount,
        1,
        "authoritative thread/read must contain the accepted retried user message exactly once",
      );
      assert.equal(
        historyAfter.targetClientMessageIdCount,
        1,
        "authoritative thread/read must contain exactly one record with the stable clientMessageId",
      );

      let navigationMetrics = await sampleTranscript(page, mobileState);
      const navigationAttempts = 4;
      for (let index = 0; index < navigationAttempts; index += 1) {
        const targetRow = await inspectTargetUserRow(page, TARGET_PROMPT);
        const interaction = {
          index: index + 1,
          before: navigationMetrics,
          targetRowBefore: targetRow,
          action: null,
        };
        if (targetRow.visibleWithinList) {
          interaction.action = "target already visible";
          evidence.transcriptNavigation.interactions.push(interaction);
          break;
        }
        const latestButton = page.getByTestId("jump-to-latest");
        if (await latestButton.isVisible().catch(() => false)) {
          const bounds = await latestButton.boundingBox();
          interaction.action = "actual touch on jump-to-latest";
          interaction.jumpButtonBounds = bounds;
          await latestButton.tap();
        } else {
          const gesture = await dispatchTouchSwipe(cdp, page, "up", 640);
          interaction.action = "actual CDP touch swipe toward latest";
          interaction.gesture = gesture;
        }
        await page.waitForTimeout(900);
        interaction.after = await sampleTranscript(page, mobileState);
        interaction.targetRowAfter = await inspectTargetUserRow(page, TARGET_PROMPT);
        evidence.transcriptNavigation.interactions.push(interaction);
        navigationMetrics = interaction.after;
        if (interaction.targetRowAfter.visibleWithinList) break;
      }
      const finalTargetRow = await inspectTargetUserRow(page, TARGET_PROMPT);
      evidence.transcriptNavigation.finalTargetRow = finalTargetRow;
      evidence.transcriptNavigation.finalMetrics =
        await sampleTranscript(page, mobileState);
      evidence.transcriptNavigation.uiActionBoundary =
        "Only actual Chromium-emulated touch on jump-to-latest or a CDP touch swipe was used; no DOM scrollTop assignment or forced React state change.";
      evidence.transcriptNavigation.verdict =
        upwardGestureObserved && finalTargetRow.visibleWithinList
          ? "PASS"
          : upwardGestureObserved && historyAfter.targetPromptCount === 1
            ? "PARTIAL"
            : "UNVERIFIED";

      const finalBinaryProvenance = await captureOwnedAppServerProvenance(
        context,
        gateway,
        ownedBinary,
        EXPECTED_BACKEND_SHA256,
      );
      evidence.fixtureBoundary.appServerBinaryProvenanceAtEnd =
        finalBinaryProvenance;
      evidence.modelFixtureRequests = model.requests.length;
      evidence.browserErrors.sort((left, right) =>
        `${left.kind}:${left.message}`.localeCompare(`${right.kind}:${right.message}`),
      );
      assert.deepEqual(evidence.browserErrors, []);
      evidence.sourceFreezeAfterRun = await verifyFrozenSourceFiles();
      const suiteSourceSha256AfterRun = await sha256File(new URL(import.meta.url));
      assert.equal(suiteSourceSha256AfterRun, suiteSourceSha256AtStart);
      evidence.testSourceSha256AfterRun = suiteSourceSha256AfterRun;
      evidence.screenshot = {
        file: "transcript-latest-after-retry.png",
        reason:
          "preserve the final actual transcript viewport alongside authoritative thread/read and scroll geometry evidence",
      };
      await page.screenshot({
        path: context.pathInArtifacts("transcript-latest-after-retry.png"),
      });
      await context.writeArtifactJson("transcript-latest-after-retry.json", evidence);
      return {
        diagnosisStatus: evidence.transcriptNavigation.verdict,
        serverHasExactlyOneAcceptedRetry: true,
        targetVisibleAfterUIActions: finalTargetRow.visibleWithinList,
        upwardTouchGestureObserved: upwardGestureObserved,
        sourceTreeSha256: FROZEN_SOURCE_TREE_SHA256,
        bundleSha256: sourceBundle.bundleSha256,
        bundleFileCount: sourceBundle.bundleFileCount,
        actualAppServerSha256: EXPECTED_BACKEND_SHA256,
        nativeIme: "UNVERIFIED",
      };
    } catch (error) {
      evidence.error = context.redactText(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 600);
      evidence.testSourceSha256AtFailure = await sha256File(
        new URL(import.meta.url),
      ).catch(() => null);
      try {
        evidence.mobileWire = mobileState
          ? safeMobileWireEvidence(mobileState)
          : null;
      } catch (diagnosticError) {
        evidence.mobileWireCaptureError = context
          .redactText(
            diagnosticError instanceof Error
              ? diagnosticError.message
              : String(diagnosticError),
          )
          .slice(0, 240);
      }
      evidence.providerRequestCount = model?.requests?.length ?? null;
      evidence.appServerBinaryProvenance = binaryProvenance;
      if (page) {
        evidence.composerEventProbeAtFailure = await disarmComposerDomEventProbe(page)
          .catch((probeError) => ({
            captureError:
              probeError instanceof Error ? probeError.message : String(probeError),
          }));
        evidence.composerSendControlAtFailure = await inspectComposerSendControl(page)
          .catch((controlError) => ({
            captureError:
              controlError instanceof Error ? controlError.message : String(controlError),
          }));
        evidence.composerDraftAtFailure = await inspectComposerDraftValue(
          page.getByTestId("message-input"),
        ).catch((draftError) => ({
          captureError:
            draftError instanceof Error ? draftError.message : String(draftError),
        }));
        evidence.webSocketProbeAtFailure = await readWebSocketReadyStateProbe(page)
          .then(safeProbe)
          .catch((probeError) => ({
            captureError:
              probeError instanceof Error ? probeError.message : String(probeError),
          }));
        evidence.lastViewport = await sampleTranscript(page, mobileState).catch(
          () => null,
        );
        await page
          .screenshot({ path: context.pathInArtifacts("transcript-diagnostic-failure.png") })
          .catch(() => undefined);
      }
      await context.writeArtifactJson(
        "transcript-latest-after-retry.failure.json",
        evidence,
      );
      throw error;
    }
  },
);

async function copyFrozenPublicBundle(context) {
  const sourceWebRootValue = process.env.KCODER_E2E_TRANSCRIPT_WEB_ROOT;
  const sourceManifestValue = process.env.KCODER_E2E_TRANSCRIPT_WEB_MANIFEST;
  const expectedManifestSha256 =
    process.env.KCODER_E2E_TRANSCRIPT_WEB_MANIFEST_SHA256;
  const expectedBundleSha256 =
    process.env.KCODER_E2E_TRANSCRIPT_WEB_BUNDLE_SHA256;
  assert.ok(
    sourceWebRootValue && sourceManifestValue && expectedManifestSha256 &&
      expectedBundleSha256 && process.env.KCODER_E2E_TRANSCRIPT_SOURCE_TREE_SHA256 &&
      process.env.KCODER_E2E_TRANSCRIPT_SOURCE_MANIFEST &&
      process.env.KCODER_E2E_TRANSCRIPT_SOURCE_MANIFEST_SHA256,
    "UNMET_PREREQUISITE: explicit source snapshot, manifest, and retained public bundle pins are required; this suite never invokes Expo",
  );
  assert.match(FROZEN_SOURCE_TREE_SHA256, /^[a-f0-9]{64}$/);
  assert.match(expectedManifestSha256, /^[a-f0-9]{64}$/);
  assert.match(expectedBundleSha256, /^[a-f0-9]{64}$/);

  const reused = await reuseMobileWebExport(context, {
    bundleRoot: resolve(repoRoot, sourceWebRootValue),
    manifestPath: resolve(repoRoot, sourceManifestValue),
    expectedSourceTreeSha256: FROZEN_SOURCE_TREE_SHA256,
    expectedManifestSha256,
    expectedBundleSha256,
    label: "mobile-transcript-latest-export",
    outputName: "mobile-web-export",
  });
  assert.equal(reused.exportPerformed, false);

  const sourceManifest = JSON.parse(
    await readFile(reused.sourceManifestPath, "utf8"),
  );
  await context.writeArtifactJson(
    "mobile-web-export-source-manifest.json",
    sourceManifest,
  );
  const entry = reused.bundleFiles.find((file) =>
    file.path.startsWith("_expo/static/js/web/entry-") && file.path.endsWith(".js"),
  );
  assert.ok(entry, "the retained public bundle must include its Expo web entry JavaScript");
  const entryArtifactPath = context.pathInArtifacts("mobile-web-entry-code.js");
  await copyFile(resolve(reused.path, ...entry.path.split("/")), entryArtifactPath);
  const retainedEntrySha256 = await sha256File(entryArtifactPath);
  assert.equal(retainedEntrySha256, entry.sha256);
  assert.equal((await lstat(entryArtifactPath)).size, entry.size);

  const provenance = {
    exportPerformed: false,
    sourceSnapshotManifest: relative(repoRoot, FROZEN_SOURCE_MANIFEST),
    sourceSnapshotManifestSha256: FROZEN_SOURCE_MANIFEST_SHA256,
    sourceTreeSha256: reused.sourceTreeSha256,
    webManifest: relative(repoRoot, reused.sourceManifestPath),
    webManifestSha256: reused.sourceManifestSha256,
    expectedWebManifestSha256: reused.expectedManifestSha256,
    bundleSha256: reused.bundleSha256,
    expectedBundleSha256: reused.expectedBundleSha256,
    bundleFileCount: reused.bundleFileCount,
    indexHtmlSha256: reused.indexHtmlSha256,
    helperProvenance: relative(context.runRoot, reused.provenancePath),
    entryCode: {
      artifact: "mobile-web-entry-code.js",
      bundlePath: entry.path,
      size: entry.size,
      sha256: retainedEntrySha256,
    },
  };
  await context.writeArtifactJson("mobile-web-entry-code-provenance.json", provenance);
  return { ...reused, provenance };
}
async function verifyFrozenSourceFiles() {
  assert.ok(
    process.env.KCODER_E2E_TRANSCRIPT_SOURCE_MANIFEST &&
      process.env.KCODER_E2E_TRANSCRIPT_SOURCE_MANIFEST_SHA256 &&
      process.env.KCODER_E2E_TRANSCRIPT_SOURCE_TREE_SHA256,
    "UNMET_PREREQUISITE: explicit immutable Mobile/shared source snapshot path, manifest SHA, and source-tree SHA are required",
  );
  assert.match(FROZEN_SOURCE_TREE_SHA256, /^[a-f0-9]{64}$/);
  assert.match(FROZEN_SOURCE_MANIFEST_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(await realpath(FROZEN_SOURCE_MANIFEST), FROZEN_SOURCE_MANIFEST);
  const freezesRoot = resolve(repoRoot, "target/test/coordination/mobile-source-freezes");
  const snapshotRoot = dirname(FROZEN_SOURCE_MANIFEST);
  assert.ok(snapshotRoot.startsWith(`${freezesRoot}${sep}`));

  const sourceManifestBytes = await readFile(FROZEN_SOURCE_MANIFEST);
  const sourceManifestSha256 = hashBytes(sourceManifestBytes);
  assert.equal(sourceManifestSha256, FROZEN_SOURCE_MANIFEST_SHA256);
  const manifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.source.sourceTreeSha256, FROZEN_SOURCE_TREE_SHA256);
  assert.equal(manifest.destination.destinationTreeSha256, FROZEN_SOURCE_TREE_SHA256);
  const entries = manifest.files.map((file) => ({
    expectedSha256: file.destinationSha256,
    expectedSize: file.size,
    relativePath: file.destinationPath,
  }));
  assert.equal(entries.length, manifest.destination.fileCount);
  const mismatches = [];
  for (const entry of entries) {
    assert.ok(
      entry.relativePath.startsWith("apps/kcoder-studio/mobile/") ||
        entry.relativePath.startsWith("apps/kcoder-studio/shared/"),
      "the freeze manifest may only include Mobile and Studio shared source files",
    );
    const snapshotPath = resolve(snapshotRoot, entry.relativePath);
    assert.ok(snapshotPath.startsWith(`${snapshotRoot}${sep}`));
    const stat = await lstat(snapshotPath);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const actual = await sha256File(snapshotPath);
    if (actual !== entry.expectedSha256 || stat.size !== entry.expectedSize) {
      mismatches.push({
        path: entry.relativePath,
        expectedSha256: entry.expectedSha256,
        actualSha256: actual,
        expectedSize: entry.expectedSize,
        actualSize: stat.size,
      });
    }
  }
  assert.deepEqual(mismatches, [], "all frozen Mobile/shared source files must still match their source manifest");
  return {
    snapshotId: manifest.snapshotId,
    fileCount: entries.length,
    sourceManifestSha256,
    sourceManifestRelativePath: relative(repoRoot, FROZEN_SOURCE_MANIFEST),
    mismatches,
  };
}
function createMobileWireState() {
  return {
    methodCounts: {},
    threadIdByPrompt: new Map(),
    turnStartsByPrompt: new Map(),
    turnStartFramesByPrompt: new Map(),
    requestById: new Map(),
    targetTurnResponse: null,
    lastThreadId: null,
  };
}

function installMobileWireObserver(page, state) {
  page.routeWebSocket("**/rpc*", (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((raw) => {
      let outgoing = raw;
      try {
        const frame = JSON.parse(String(raw));
        if (typeof frame.method === "string") {
          state.methodCounts[frame.method] = (state.methodCounts[frame.method] ?? 0) + 1;
          const requestMeta = { method: frame.method, prompt: null };
          if (frame.method === "turn/start" && frame.id !== undefined) {
            const serializedInput = JSON.stringify(frame.params?.input ?? []);
            const prompt = FIXTURE_PROMPTS.find((candidate) => serializedInput.includes(candidate)) ?? null;
            requestMeta.prompt = prompt;
            const record = {
              threadId: typeof frame.params?.threadId === "string" ? frame.params.threadId : null,
              clientMessageId: typeof frame.params?.clientMessageId === "string" ? frame.params.clientMessageId : null,
              frameIndex: state.methodCounts[frame.method],
            };
            if (prompt) {
              const records = state.turnStartFramesByPrompt.get(prompt) ?? [];
              records.push(record);
              state.turnStartFramesByPrompt.set(prompt, records);
              state.turnStartsByPrompt.set(prompt, record);
              if (record.threadId) state.threadIdByPrompt.set(prompt, record.threadId);
            }
            if (record.threadId) state.lastThreadId = record.threadId;
          }
          if (frame.method === "thread/start" && frame.id !== undefined) {
            requestMeta.prompt = FIXTURE_PROMPTS.find((candidate) =>
              JSON.stringify(frame.params ?? {}).includes(candidate),
            ) ?? null;
          }
          if (frame.id !== undefined) state.requestById.set(frame.id, requestMeta);
        }
      } catch {
        // Observe only parseable RPC method metadata; forward every frame unchanged.
      }
      upstream.send(outgoing);
    });
    upstream.onMessage((raw) => {
      let outgoing = raw;
      try {
        const frame = JSON.parse(String(raw));
        const requestMeta = frame.id === undefined ? null : state.requestById.get(frame.id);
        if (requestMeta?.method === "thread/start" && frame.result?.thread?.id) {
          const threadId = frame.result.thread.id;
          state.lastThreadId = threadId;
          if (requestMeta.prompt) state.threadIdByPrompt.set(requestMeta.prompt, threadId);
        }
        if (requestMeta?.method === "turn/start" && frame.result?.turn) {
          const turn = frame.result.turn;
          if (requestMeta.prompt === TARGET_PROMPT) {
            state.targetTurnResponse = {
              threadId: typeof turn.threadId === "string" ? turn.threadId : null,
              turnId: typeof turn.id === "string" ? turn.id : null,
              status: typeof turn.status === "string" ? turn.status : null,
            };
          }
        }
        if (frame.id !== undefined) state.requestById.delete(frame.id);
      } catch {
        // Do not retain arbitrary frame payloads.
      }
      socket.send(outgoing);
    });
  });
}

async function connectMobile(page, gateway, beforeConnect) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  const loginInput = page.locator('input[name="token"]');
  if (await loginInput.count()) {
    await loginInput.fill(gateway.authToken);
    await Promise.all([
      page.waitForSelector('[data-testid="welcome-direct-connection"]', {
        timeout: 30_000,
      }),
      page.locator('button[type="submit"]').tap(),
    ]);
  }
  await page.getByTestId("welcome-direct-connection").tap();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await beforeConnect?.();
  await page.getByTestId("gateway-connect").tap();
  await page.getByTestId("new-workspace").waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

async function waitForTranscriptScrollSettle(page, signal) {
  let previous = null;
  let stableSamples = 0;
  let pollCount = 0;
  const settled = await waitFor(
    async () => {
      pollCount += 1;
      const current = await page.getByTestId("message-list").evaluate((element) => ({
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      if (
        previous &&
        Math.abs(current.scrollTop - previous.scrollTop) <= 1 &&
        current.scrollHeight === previous.scrollHeight &&
        current.clientHeight === previous.clientHeight
      ) {
        stableSamples += 1;
      } else {
        stableSamples = 0;
      }
      previous = current;
      return stableSamples >= 3 ? current : null;
    },
    6_000,
    "the real message-list touch/momentum scroll to remain stable for four samples",
    80,
    signal,
  );
  return {
    ...settled,
    stableSamples,
    pollCount,
    settleBoundary: "observed scrollTop/scrollHeight/clientHeight only; no scroll position was assigned",
  };
}

async function waitForComposerDraftStable(input, expectedValue, signal) {
  let previousValue = null;
  let stableSamples = 0;
  let pollCount = 0;
  const stable = await waitFor(
    async () => {
      pollCount += 1;
      const value = await input.inputValue();
      if (value === expectedValue && value === previousValue) {
        stableSamples += 1;
      } else {
        stableSamples = 0;
      }
      previousValue = value;
      return stableSamples >= 2
        ? { valueLength: value.length, sha256: sha256Text(value) }
        : null;
    },
    5_000,
    "the synthetic composer draft to match its expected value and remain stable across three reads",
    50,
    signal,
  );
  return { ...stable, stableSamples, pollCount };
}

async function inspectComposerDraftValue(input) {
  const value = await input.inputValue();
  return { valueLength: value.length, sha256: sha256Text(value) };
}

function eventReachedSendControlViaTouch(event) {
  if (!event.isTrusted || event.controlTestId !== "send-message") return false;
  if (["touchstart", "touchend"].includes(event.type)) return true;
  if (
    event.pointerType === "touch" &&
    ["pointerdown", "pointerup", "click"].includes(event.type)
  ) {
    return true;
  }
  return event.type === "click" && event.sourceCapabilitiesFiresTouchEvents === true;
}

async function inspectComposerSendControl(page) {
  return page.evaluate(() => {
    const button = document.querySelector('[data-testid="send-message"]');
    const input = document.querySelector('[data-testid="message-input"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    const hitPath = [];
    for (let node = hit; node && hitPath.length < 5; node = node.parentElement) {
      hitPath.push({
        tagName: node.tagName ?? null,
        testId: node.getAttribute?.("data-testid") ?? null,
      });
    }
    const domDisabled = "disabled" in button ? Boolean(button.disabled) : null;
    return {
      found: true,
      tagName: button.tagName,
      testId: button.getAttribute("data-testid"),
      disabled: domDisabled,
      ariaDisabled: button.getAttribute("aria-disabled"),
      pointerEvents: getComputedStyle(button).pointerEvents,
      touchAction: getComputedStyle(button).touchAction,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      center: { x: centerX, y: centerY },
      elementFromPointPath: hitPath,
      hitTestInsideButton: Boolean(hit && (hit === button || button.contains(hit))),
      composerValueLength:
        input && "value" in input && typeof input.value === "string"
          ? input.value.length
          : null,
    };
  });
}

async function installComposerDomEventProbe(page) {
  await page.evaluate(() => {
    const probeKey = "__kcoderE2eComposerInputEventProbe";
    if (window[probeKey]?.installed) return;
    const probe = { installed: true, armed: false, phase: null, events: [] };
    const watchedEvents = [
      "touchstart",
      "touchend",
      "touchcancel",
      "pointerdown",
      "pointerup",
      "pointercancel",
      "click",
    ];
    for (const type of watchedEvents) {
      document.addEventListener(
        type,
        (event) => {
          if (!probe.armed) return;
          let target = event.target;
          if (target && target.nodeType !== 1) target = target.parentElement;
          const sendControl = target?.closest?.(
            '[data-testid="send-message"], [data-testid="queue-message"]',
          );
          const composer = target?.closest?.('[data-testid="message-input-root"]');
          if (!sendControl && !composer) return;
          const control = sendControl ?? composer;
          const input = document.querySelector('[data-testid="message-input"]');
          probe.events.push({
            phase: probe.phase,
            type: event.type,
            isTrusted: event.isTrusted === true,
            pointerType:
              typeof event.pointerType === "string" ? event.pointerType : null,
            sourceCapabilitiesFiresTouchEvents:
              typeof event.sourceCapabilities?.firesTouchEvents === "boolean"
                ? event.sourceCapabilities.firesTouchEvents
                : null,
            targetTagName: target?.tagName ?? null,
            targetTestId: target?.getAttribute?.("data-testid") ?? null,
            controlTestId: control?.getAttribute?.("data-testid") ?? null,
            controlDisabled:
              sendControl && "disabled" in sendControl
                ? Boolean(sendControl.disabled)
                : null,
            controlAriaDisabled: sendControl?.getAttribute("aria-disabled") ?? null,
            clientX: Number.isFinite(event.clientX) ? event.clientX : null,
            clientY: Number.isFinite(event.clientY) ? event.clientY : null,
            touchCount:
              event.touches && Number.isInteger(event.touches.length)
                ? event.touches.length
                : null,
            changedTouchCount:
              event.changedTouches && Number.isInteger(event.changedTouches.length)
                ? event.changedTouches.length
                : null,
            elementFromPointPath: (() => {
              const touch = event.changedTouches?.[0] ?? event.touches?.[0];
              const x = Number.isFinite(event.clientX) ? event.clientX : touch?.clientX;
              const y = Number.isFinite(event.clientY) ? event.clientY : touch?.clientY;
              if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
              const hit = document.elementFromPoint(x, y);
              const path = [];
              for (let node = hit; node && path.length < 5; node = node.parentElement) {
                path.push({
                  tagName: node.tagName ?? null,
                  testId: node.getAttribute?.("data-testid") ?? null,
                });
              }
              return path;
            })(),
            composerValueLength:
              input && "value" in input && typeof input.value === "string"
                ? input.value.length
                : null,
          });
        },
        true,
      );
    }
    Object.defineProperty(window, probeKey, {
      value: probe,
      configurable: false,
    });
  });
}

async function armComposerDomEventProbe(page, phase) {
  await page.evaluate((nextPhase) => {
    const probe = window["__kcoderE2eComposerInputEventProbe"];
    if (!probe?.installed) throw new Error("composer DOM event probe is unavailable");
    probe.events.length = 0;
    probe.phase = nextPhase;
    probe.armed = true;
  }, phase);
}

async function disarmComposerDomEventProbe(page) {
  return page.evaluate(() => {
    const probe = window["__kcoderE2eComposerInputEventProbe"];
    if (!probe?.installed) return { installed: false, events: [] };
    probe.armed = false;
    return { installed: true, phase: probe.phase, events: probe.events.slice() };
  });
}

async function observeFreshSubmissionOutcome({
  page,
  mobileState,
  model,
  prompt,
  startCountBefore,
  providerCountBefore,
  appForcedReadsBefore,
  timeoutMs,
}) {
  const startedAt = Date.now();
  let pollCount = 0;
  let latest = null;
  while (Date.now() - startedAt <= timeoutMs) {
    pollCount += 1;
    const probe = await readWebSocketReadyStateProbe(page);
    const failedCard = page.getByTestId("failed-submission").filter({ hasText: prompt });
    const failedCardCount = await failedCard.count();
    const failedCardVisible =
      failedCardCount > 0 && (await failedCard.first().isVisible().catch(() => false));
    const targetGatewayTurnStartFrames =
      (mobileState.turnStartFramesByPrompt.get(prompt)?.length ?? 0) - startCountBefore;
    const targetProviderRequests = countProviderRequestsForPrompt(model.requests, prompt);
    latest = {
      pollCount,
      elapsedMs: Date.now() - startedAt,
      failedCardCount,
      failedCardVisible,
      applicationForcedClosedReads:
        probe.applicationForcedClosedReadyStateReads,
      applicationForcedClosedReadsDelta:
        probe.applicationForcedClosedReadyStateReads - appForcedReadsBefore,
      targetSendCalls: probe.targetTurnStartSendInvocations,
      targetGatewayTurnStartFrames,
      targetProviderRequests,
      probe: safeProbe(probe),
    };
    if (
      failedCardVisible ||
      latest.applicationForcedClosedReadsDelta > 0 ||
      latest.targetSendCalls > 0 ||
      targetGatewayTurnStartFrames > 0 ||
      targetProviderRequests > providerCountBefore
    ) {
      break;
    }
    await page.waitForTimeout(100);
  }
  return latest;
}

async function readThreadHistory(rpc, threadId, targetPrompt, clientMessageId) {
  const result = await rpc.request("thread/read", { threadId, limit: 100 }, 10_000);
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const userMessages = messages.filter((message) => message?.role === "user");
  const targetMessages = userMessages.filter((message) => message?.content === targetPrompt);
  const targetIdMessages = clientMessageId
    ? userMessages.filter((message) => message?.clientMessageId === clientMessageId)
    : [];
  return {
    targetPromptCount: targetMessages.length,
    targetClientMessageIdCount: targetIdMessages.length,
    safe: {
      rangeStart: result.rangeStart,
      rangeEnd: result.rangeEnd,
      hasMoreBefore: result.hasMoreBefore,
      userMessageCount: userMessages.length,
      targetPromptCount: targetMessages.length,
      targetClientMessageIdCount: targetIdMessages.length,
      targetRecords: targetMessages.map((message) => ({
        messageIdSha256: typeof message.id === "string" ? sha256Text(message.id) : null,
        clientMessageIdSha256:
          typeof message.clientMessageId === "string"
            ? sha256Text(message.clientMessageId)
            : null,
        contentSha256: typeof message.content === "string" ? sha256Text(message.content) : null,
        contentLength: typeof message.content === "string" ? message.content.length : null,
        status: typeof message.status === "string" ? message.status : null,
        contentTruncated: message.contentTruncated === true,
      })),
    },
  };
}

async function sampleTranscript(page, wireState) {
  const list = page.getByTestId("message-list");
  const raw = await list.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const rows = Array.from(element.querySelectorAll('[data-testid="message-user"]'));
    const rowRecords = rows.map((row) => {
      const rowRect = row.getBoundingClientRect();
      return {
        text: row.textContent ?? "",
        domId: row.getAttribute("id"),
        rect: {
          left: rowRect.left,
          right: rowRect.right,
          top: rowRect.top,
          bottom: rowRect.bottom,
          width: rowRect.width,
          height: rowRect.height,
        },
        intersectsList:
          rowRect.right > rect.left && rowRect.left < rect.right &&
          rowRect.bottom > rect.top && rowRect.top < rect.bottom,
        fullyWithinList:
          rowRect.left >= rect.left && rowRect.right <= rect.right &&
          rowRect.top >= rect.top && rowRect.bottom <= rect.bottom,
      };
    });
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      bottomGap: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop),
      rect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      mountedUserRowCount: rowRecords.length,
      rows: rowRecords,
    };
  });
  const rows = raw.rows.map((row) => {
    const key = promptKey(FIXTURE_PROMPTS.find((prompt) => row.text.includes(prompt)) ?? null);
    const prompt = FIXTURE_PROMPTS.find((candidate) => row.text.includes(candidate));
    const wireMessage = prompt ? wireState.turnStartsByPrompt.get(prompt) : null;
    return {
      contentSha256: sha256Text(row.text),
      contentLength: row.text.length,
      promptKey: key,
      domElementIdSha256: row.domId ? sha256Text(row.domId) : null,
      matchedClientMessageIdSha256: wireMessage?.clientMessageId
        ? sha256Text(wireMessage.clientMessageId)
        : null,
      identityMatchBoundary: prompt
        ? "mounted row text matched to one fixed synthetic prompt and its observed turn/start clientMessageId"
        : "content hash only; Mobile Web DOM exposes no app-server message ID on this row",
      rect: roundRect(row.rect),
      intersectsList: row.intersectsList,
      fullyWithinList: row.fullyWithinList,
    };
  });
  return {
    scrollTop: round(raw.scrollTop),
    scrollHeight: round(raw.scrollHeight),
    clientHeight: round(raw.clientHeight),
    scrollWidth: round(raw.scrollWidth),
    clientWidth: round(raw.clientWidth),
    bottomGap: round(raw.bottomGap),
    rect: roundRect(raw.rect),
    mountedUserRowCount: raw.mountedUserRowCount,
    rows,
  };
}

async function inspectTargetUserRow(page, targetPrompt) {
  const rows = page.getByTestId("message-user");
  const matching = rows.filter({ hasText: targetPrompt });
  const count = await matching.count();
  if (count === 0) return { domRowCount: 0, visibleWithinList: false };
  const geometry = await matching.last().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const list = document.querySelector('[data-testid="message-list"]');
    if (!list) return { listFound: false };
    const listRect = list.getBoundingClientRect();
    const left = Math.max(rect.left, listRect.left, 0);
    const right = Math.min(rect.right, listRect.right, window.innerWidth);
    const top = Math.max(rect.top, listRect.top, 0);
    const bottom = Math.min(rect.bottom, listRect.bottom, window.innerHeight);
    const intersectionArea = Math.max(0, right - left) * Math.max(0, bottom - top);
    const rowArea = Math.max(1, rect.width * rect.height);
    return {
      listFound: true,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      listRect: { left: listRect.left, right: listRect.right, top: listRect.top, bottom: listRect.bottom },
      intersectionArea,
      rowArea,
      intersectionRatio: intersectionArea / rowArea,
      visibleWithinList:
        rect.width > 0 && rect.height > 0 &&
        rect.left >= listRect.left - 1 && rect.right <= listRect.right + 1 &&
        rect.top >= listRect.top - 1 && rect.bottom <= listRect.bottom + 1 &&
        intersectionArea / rowArea >= 0.9,
      domElementId: element.getAttribute("id"),
      contentSha256: null,
      contentLength: (element.textContent ?? "").length,
    };
  });
  const text = await matching.last().textContent();
  return {
    domRowCount: count,
    visibleWithinList: geometry.visibleWithinList === true,
    contentSha256: text ? sha256Text(text) : null,
    contentLength: geometry.contentLength,
    domElementIdSha256: geometry.domElementId
      ? sha256Text(geometry.domElementId)
      : null,
    geometry: {
      rect: geometry.rect,
      listRect: geometry.listRect,
      intersectionArea: round(geometry.intersectionArea ?? 0),
      rowArea: round(geometry.rowArea ?? 0),
      intersectionRatio: round(geometry.intersectionRatio ?? 0),
    },
    rowIdentity: "unique synthetic prompt text; DOM has no stable app-server message ID attribute",
  };
}

async function inspectLongFixture(page) {
  const assistant = page.getByTestId("message-assistant").filter({
    hasText: LONG_REPLY_END,
  }).last();
  const messageList = page.getByTestId("message-list");
  const [assistantGeometry, listMetrics, tableEvidence, codeDisclosureCount] =
    await Promise.all([
      assistant.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      }),
      messageList.evaluate((element) => ({
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        bottomGap: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop),
      })),
      assistant.evaluate((element, { rowMarker, finalRowMarker, finalRowTail }) => {
        const content = element.textContent ?? "";
        const escapedMarker = rowMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const markerPattern = new RegExp(`${escapedMarker}\\s+(\\d{2})`, "g");
        const rowNumbers = [...content.matchAll(markerPattern)].map((match) => match[1]);
        const list = document.querySelector('[data-testid="message-list"]');
        if (!list) return { rowNumbers, listFound: false, finalRowMarker: null, finalRowTail: null };
        const listRect = list.getBoundingClientRect();
        const rangeRects = (needle) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const rects = [];
          let node;
          while ((node = walker.nextNode())) {
            const text = node.textContent ?? "";
            let offset = text.indexOf(needle);
            while (offset >= 0) {
              const range = document.createRange();
              range.setStart(node, offset);
              range.setEnd(node, offset + needle.length);
              for (const rect of range.getClientRects()) {
                const left = Math.max(rect.left, listRect.left);
                const right = Math.min(rect.right, listRect.right);
                const top = Math.max(rect.top, listRect.top);
                const bottom = Math.min(rect.bottom, listRect.bottom);
                const intersectionArea = Math.max(0, right - left) * Math.max(0, bottom - top);
                rects.push({
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  width: rect.width,
                  height: rect.height,
                  intersectionArea,
                  fullyWithinList:
                    rect.left >= listRect.left - 1 &&
                    rect.right <= listRect.right + 1 &&
                    rect.top >= listRect.top &&
                    rect.bottom <= listRect.bottom,
                });
              }
              offset = text.indexOf(needle, offset + needle.length);
            }
          }
          return rects;
        };
        const summarize = (needle) => {
          const rects = rangeRects(needle);
          return {
            fragmentCount: rects.length,
            visibleWithinList: rects.some(
              (rect) => rect.fullyWithinList && rect.width >= 8 && rect.height >= 8,
            ),
            rects: rects.map((rect) => ({
              left: Math.round(rect.left * 10) / 10,
              right: Math.round(rect.right * 10) / 10,
              top: Math.round(rect.top * 10) / 10,
              bottom: Math.round(rect.bottom * 10) / 10,
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
              intersectionArea: Math.round(rect.intersectionArea * 10) / 10,
              fullyWithinList: rect.fullyWithinList,
            })),
          };
        };
        return {
          rowNumbers,
          listFound: true,
          finalRowMarker: summarize(finalRowMarker),
          finalRowTail: summarize(finalRowTail),
        };
      }, {
        rowMarker: ROW_MARKER,
        finalRowMarker: `${ROW_MARKER} 34`,
        finalRowTail: "tail-34",
      }),
      assistant.getByTestId("code-disclosure").count(),
    ]);
  return {
    tableRowMarkerCount: tableEvidence.rowNumbers.length,
    tableRowMarkerNumbers: tableEvidence.rowNumbers,
    tableRowEvidenceBoundary:
      "Markdown table rows are React Native View elements in the current renderer, so this checks fixture marker text and Range geometry instead of HTML table tags",
    finalTableRowVisibleWithinList:
      tableEvidence.finalRowMarker?.visibleWithinList === true &&
      tableEvidence.finalRowTail?.visibleWithinList === true,
    finalTableRowMarker: tableEvidence.finalRowMarker,
    finalTableRowTail: tableEvidence.finalRowTail,
    codeDisclosureCount,
    assistantGeometry: roundRect(assistantGeometry),
    messageList: {
      scrollTop: round(listMetrics.scrollTop),
      scrollHeight: round(listMetrics.scrollHeight),
      clientHeight: round(listMetrics.clientHeight),
      scrollWidth: round(listMetrics.scrollWidth),
      clientWidth: round(listMetrics.clientWidth),
      bottomGap: round(listMetrics.bottomGap),
    },
  };
}

async function mobileBrowserRpcCredentials(page, gateway, context) {
  const rpcToken = await page
    .locator('meta[name="kcoder-rpc-token"]')
    .getAttribute("content");
  assert.ok(rpcToken, "the logged-in Mobile page must expose the Gateway RPC query token");
  context.registerSecret(rpcToken);
  const sessionCookie = (await page.context().cookies(gateway.baseUrl)).find(
    (cookie) => cookie.name === "kcoder_studio_session",
  )?.value;
  assert.ok(sessionCookie, "the browser must own a Gateway session cookie for the read-only history observer");
  context.registerSecret(sessionCookie);
  return {
    rpcToken,
    headers: {
      Cookie: `kcoder_studio_session=${sessionCookie}`,
      Authorization: `Bearer ${sessionCookie}`,
      Origin: gateway.baseUrl,
      "Sec-WebSocket-Protocol": `kcoder-studio, kcoder-session.${sessionCookie}`,
    },
  };
}

async function dispatchTouchSwipe(cdp, page, direction, distance) {
  assert.ok(direction === "up" || direction === "down");
  const listBounds = await page.getByTestId("message-list").boundingBox();
  assert.ok(listBounds, "touch gesture requires a real visible message-list hitbox");
  const x = Math.max(listBounds.x + 24, Math.min(listBounds.x + listBounds.width - 24, listBounds.x + listBounds.width / 2));
  const fromY = direction === "down"
    ? listBounds.y + Math.min(88, listBounds.height * 0.2)
    : listBounds.y + listBounds.height - Math.min(72, listBounds.height * 0.15);
  const toY = direction === "down"
    ? Math.min(listBounds.y + listBounds.height - 24, fromY + distance)
    : Math.max(listBounds.y + 24, fromY - distance);
  const points = 12;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: fromY, id: 1 }],
  });
  for (let index = 1; index <= points; index += 1) {
    const y = fromY + ((toY - fromY) * index) / points;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, id: 1 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  return {
    direction,
    pointCount: points + 2,
    start: { x: round(x), y: round(fromY) },
    end: { x: round(x), y: round(toY) },
    distance: round(Math.abs(toY - fromY)),
    hitRegion: roundRect(listBounds),
  };
}

async function readFailedDraftId(page, prompt) {
  let value = null;
  await waitFor(
    async () => {
      value = await page.evaluate((targetPrompt) => {
        const prefix = "kcoder-studio:mobile-workspace-state:v3:";
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          try {
            const state = JSON.parse(localStorage.getItem(key) ?? "null");
            const item = state?.failedSubmissions?.find(
              (entry) => entry?.content === targetPrompt && typeof entry.id === "string",
            );
            if (item) return item.id;
          } catch {
            // Ignore unrelated local state; inspect only this fixed synthetic draft.
          }
        }
        return null;
      }, prompt);
      return typeof value === "string" && value.length > 0;
    },
    10_000,
    "the unique synthetic fresh notSent draft ID to persist before retry",
    50,
  );
  return value;
}

async function captureOwnedAppServerProvenance(context, gateway, binaryPath, expectedSha256) {
  const configured = await hashExecutableFile(binaryPath);
  assert.equal(configured.sha256, expectedSha256);
  const gatewayProcessGroupId = gateway.child.pid;
  const processes = await waitFor(
    async () => {
      const observed = await findOwnedExecutableProcesses({
        pgid: gatewayProcessGroupId,
        executablePath: configured.path,
      });
      return observed.length > 0 ? observed : null;
    },
    15_000,
    "the app-server executable within this RunContext-owned Gateway process group",
    50,
    context.abortSignal,
  );
  const matchingProcesses = processes.filter((process) => process.sha256 === expectedSha256);
  assert.ok(matchingProcesses.length > 0);
  return {
    evidenceScope: "live executable lookup is restricted to this RunContext-owned Gateway process group; no command line or environment read",
    gatewayProcessGroupId,
    configuredBinarySha256: configured.sha256,
    actualAppServerProcesses: processes,
    matchingAppServerPids: matchingProcesses.map((process) => process.pid),
    actualExecutableMatchesConfiguredCopy: true,
  };
}

function providerConfig(endpoint, defaultModel) {
  return {
    api_format: "openai_chat_completions",
    authentication: { mode: "none" },
    endpoint,
    default_model: defaultModel,
    capabilities: { reasoning: true, vision: false },
    reasoning_effort: "medium",
    reasoning_policy: { mode: "optional", efforts: ["none", "low", "medium", "high"] },
    context_window_tokens: 128_000,
    output_headroom_tokens: 8_192,
    max_output_tokens: 8_192,
    request_timeout_secs: 60,
    no_proxy: true,
    extra_body: {},
  };
}

function countProviderRequestsForPrompt(requests, prompt) {
  return requests.filter((request) => {
    const lastUser = [...(request.messages ?? [])]
      .reverse()
      .find((message) => message?.role === "user");
    return JSON.stringify(lastUser?.content ?? "").includes(prompt);
  }).length;
}

function safeProbe(probe) {
  return {
    boundary: probe.boundary,
    wrapperStillInstalled: probe.windowConstructorMatchesWrapper,
    runtimeSocketCount: probe.runtimeSocketCount,
    sockets: probe.sockets.map((socket) => ({
      index: socket.index,
      unforcedReadyState: socket.unforcedReadyState,
      effectiveReadyState: socket.effectiveReadyState,
      source: socket.unforcedStateSource,
    })),
    applicationForcedClosedReadyStateReads:
      probe.applicationForcedClosedReadyStateReads,
    targetTurnStartSendInvocations: probe.targetTurnStartSendInvocations,
  };
}

function safeMobileWireEvidence(state) {
  return {
    methodCounts: { ...state.methodCounts },
    turnStartCountsByPrompt: Object.fromEntries(
      [...state.turnStartFramesByPrompt.entries()].map(([prompt, records]) => [
        promptKey(prompt),
        records.length,
      ]),
    ),
    threadIdsByPromptSha256: Object.fromEntries(
      [...state.threadIdByPrompt.entries()].map(([prompt, threadId]) => [
        promptKey(prompt),
        sha256Text(threadId),
      ]),
    ),
    targetTurnResponse: state.targetTurnResponse
      ? {
          threadIdSha256: state.targetTurnResponse.threadId
            ? sha256Text(state.targetTurnResponse.threadId)
            : null,
          turnIdSha256: state.targetTurnResponse.turnId
            ? sha256Text(state.targetTurnResponse.turnId)
            : null,
          status: state.targetTurnResponse.status,
        }
      : null,
  };
}

function promptKey(prompt) {
  if (!prompt) return null;
  const index = FIXTURE_PROMPTS.indexOf(prompt);
  return index === FIXTURE_PROMPTS.length - 1
    ? "target-retry"
    : index >= 0
      ? `accepted-turn-${index + 1}`
      : "unknown-fixture-prompt";
}

function round(value) {
  return Math.round(Number(value) * 10) / 10;
}

function roundRect(rect) {
  return Object.fromEntries(
    Object.entries(rect).map(([key, value]) => [key, round(value)]),
  );
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return hashBytes(Buffer.from(String(value), "utf8"));
}

async function sha256File(path) {
  return hashBytes(await readFile(path));
}
