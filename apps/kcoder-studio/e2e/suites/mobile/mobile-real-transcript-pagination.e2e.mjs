import assert from "node:assert/strict";
import { chmod, mkdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { restorePinnedGatewayMobileDeployment } from "../../harness/mobile-pinned-gateway-deployment.mjs";
import {
  flattenNewestFirstPages,
  webTranscriptDomOrderToDisplayOrder,
} from "./mobile-transcript-pagination-order.mjs";
import {
  assertIndexedTranscriptPageBoundary,
  assertObservedTranscriptPageBoundary,
} from "./mobile-transcript-pagination-preflight.mjs";
import {
  observeTranscriptPageResponse,
  projectTranscriptPageObservation,
  transcriptRpcResponseMatchesRequest,
} from "./mobile-transcript-pagination-observation.mjs";
import { runHeldOwnerSwitchReleasePhase } from "./mobile-transcript-owner-switch-release.mjs";
import {
  observeAnchorScrollResponse,
} from "../../harness/mobile-session-cache-cold-diagnostics.mjs";
import {
  armTrustedTranscriptWheelObservation,
  readTranscriptViewport,
} from "../../harness/mobile-session-cache-transcript-scroll-host.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import {
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";

const title = "MOBILE_TRANSCRIPT_PAGINATION_TARGET";
const ownerBTitle = "MOBILE_TRANSCRIPT_PAGINATION_OWNER_B";
const liveCorrectionMarker = "TRANSCRIPT_LIVE_CORRECTION_A";
const sentinel = (index) => `TRANSCRIPT_SENTINEL_${String(index).padStart(2, "0")}`;
const transcriptObservationId = (cursor) =>
  /^tp1:ob1-([a-f0-9]{64}):[1-9]\d{0,19}$/.exec(cursor ?? "")?.[1] ?? null;
const transcriptPageLimit = 50;
const historyRefreshMaxSteps = 64;
const historyRefreshBudgetMs = 45_000;
const initialPageSmoke = process.argv.includes("--initial-page-smoke");
const activatedSnapshotMode = process.argv.includes("--activated-snapshot");
const oldestRevealSetupSmoke = process.argv.includes("--oldest-reveal-setup-smoke");
const ownerSwitchNavigationSmoke = process.argv.includes("--owner-switch-navigation-smoke");
const heldOwnerResponseReleaseSmoke = process.argv.includes("--held-owner-response-release-smoke");
assert.ok(!(initialPageSmoke && activatedSnapshotMode), "--initial-page-smoke is the default observation short gate and cannot be combined with --activated-snapshot");
assert.ok(!(oldestRevealSetupSmoke && (initialPageSmoke || activatedSnapshotMode)),
  "--oldest-reveal-setup-smoke is a separate default-observation UI gate and cannot be combined with other pagination modes");
assert.ok(!(ownerSwitchNavigationSmoke && (initialPageSmoke || activatedSnapshotMode || oldestRevealSetupSmoke)),
  "--owner-switch-navigation-smoke is a separate real one-turn A/B navigation gate and cannot be combined with other pagination modes");
assert.ok(!(heldOwnerResponseReleaseSmoke && (initialPageSmoke || activatedSnapshotMode || oldestRevealSetupSmoke || ownerSwitchNavigationSmoke)),
  "--held-owner-response-release-smoke is a separate real pagination and held-response gate and cannot be combined with other modes");

await runE2E(
  import.meta.url,
  {
    testId: activatedSnapshotMode
      ? "mobile-web-real-transcript-pagination-activated-snapshot"
      : ownerSwitchNavigationSmoke
        ? "mobile-web-real-transcript-pagination-owner-switch-navigation-smoke"
        : heldOwnerResponseReleaseSmoke
          ? "mobile-web-real-transcript-pagination-held-owner-response-release-smoke"
          : oldestRevealSetupSmoke
            ? "mobile-web-real-transcript-pagination-oldest-reveal-setup-smoke"
            : initialPageSmoke
              ? "mobile-web-real-transcript-pagination-initial-page-smoke"
              : "mobile-web-real-single-thread-transcript-pagination",
    tier: "full-integration",
    modelPolicy:
      "model-independent real app-server history cursor with deterministic local Provider fixture; no real Provider/model",
    retainSuccessLogs: true,
  },
  async (context) => {
    const configuredBinaryPath = process.env.KCODER_E2E_KCODER_BIN;
    const expectedBinarySha256 = process.env.KCODER_E2E_KCODER_BIN_SHA256;
    assert.ok(
      typeof configuredBinaryPath === "string" && isAbsolute(configuredBinaryPath),
      "UNMET_PREREQUISITE: KCODER_E2E_KCODER_BIN must be an explicit absolute path to the frozen KCoder binary",
    );
    assert.match(
      expectedBinarySha256 ?? "",
      /^[a-f0-9]{64}$/,
      "UNMET_PREREQUISITE: KCODER_E2E_KCODER_BIN_SHA256 must pin the frozen KCoder binary",
    );
    const kcoderBinary = resolve(configuredBinaryPath);
    const configuredBackendBefore = await hashExecutableFile(kcoderBinary);
    assert.equal(
      configuredBackendBefore.sha256,
      expectedBinarySha256,
      "configured KCoder binary does not match the caller-provided frozen binary SHA-256",
    );

    const {
      mobileWeb,
      deployment,
      sourceIdentity,
      sourcePins,
    } = await restorePinnedGatewayMobileDeployment(context, {
      outputName: "mobile-transcript-pagination-pinned-deployment",
    });
    assert.equal(deployment.inventoryVerifiedAgainstArchive, true);

    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    await mkdir(workspace, { recursive: true });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const model = await startApprovalModelFixture(context, { textOnly: true });
    const settingsFile = await context.writeStateJson(
      "transcript-settings.json",
      {
        active_provider: "transcript-seed",
        providers: {
          "transcript-seed": {
            api_format: "openai_chat_completions",
            endpoint: model.baseUrl,
            default_model: "transcript-e2e-model",
            context_window_tokens: 1000000,
            output_headroom_tokens: 8192,
            max_output_tokens: 8192,
            request_timeout_secs: 30,
            no_proxy: true,
            extra_body: {},
          },
        },
      },
    );
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "transcript-seed": { type: "api", key: "deterministic-local-fixture" },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Local",
        transport: "local",
        command: kcoderBinary,
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "mobile-transcript-pagination-gateway",
      workspace,
      serversFile,
      kcoderBin: kcoderBinary,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_MOBILE_WEB_ROOT: deployment.path,
        KCODER_STUDIO_WEB_ROOT: "",
      },
    });
    const token = await requestMobileRpcToken(context, gateway);

    const chromium = await startChromium(context, {
      label: "mobile-transcript-pagination-chromium",
    });
    const page = await chromium.newPage({
      viewport: { width: 390, height: 844 },
      locale: "zh-CN",
    });
    const diagnostics = [];
    const browserSockets = [];
    let nextBrowserSocketOrdinal = 0;
    const bridge = await installTranscriptRpcBridge(page);
    context.addCleanup("write transcript pagination RPC evidence", async () => {
      await context.writeArtifactJsonInternal(
        "mobile-transcript-pagination-rpc-evidence.json",
        serializeBridgeEvidence(bridge),
      );
    });
    page.on("pageerror", (error) =>
      diagnostics.push(`pageerror: ${error.message}`),
    );
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        diagnostics.push(`${message.type()}: ${message.text()}`);
    });
    page.on("websocket", (socket) => {
      const browserSocket = {
        ordinal: ++nextBrowserSocketOrdinal,
        url: socket.url(),
        sentFrames: [],
        receivedFrames: [],
      };
      browserSockets.push(browserSocket);
      socket.on("framesent", (event) => {
        const raw = String(event.payload);
        browserSocket.sentFrames.push({ raw, frame: parseJsonFrame(raw), atMs: performance.now() });
      });
      socket.on("framereceived", (event) => {
        const raw = String(event.payload);
        browserSocket.receivedFrames.push({ raw, frame: parseJsonFrame(raw), atMs: performance.now() });
      });
    });

    const mobileEntryUrl = new URL("/mobile/", gateway.baseUrl).href;
    const mobileEntryResponse = await page.goto(mobileEntryUrl, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(mobileEntryResponse?.status(), 200, "Gateway production /mobile/ mount must return the pinned Mobile document");
    assert.equal(new URL(page.url()).pathname, "/mobile/", "setup must start at the exact Gateway /mobile/ route");
    await connect(page, gateway, token);
    await page
      .getByTestId("new-workspace")
      .waitFor({ state: "visible", timeout: 30_000 });
    const uniqueHomeAction = page.getByTestId("new-workspace");
    assert.equal(await uniqueHomeAction.count(), 1, "Gateway /mobile/ setup must expose one unique home action TestID");
    assert.equal(await uniqueHomeAction.getAttribute("aria-label"), "新建任务");
    assert.equal(await uniqueHomeAction.isEnabled(), true, "the unique Mobile home action must be enabled");
    assert.ok(
      new URL(page.url()).pathname.startsWith("/mobile/"),
      "pairing from the production mount must remain under /mobile/",
    );
    const mobileMountSetupGate = {
      requestedPath: "/mobile/",
      documentStatus: mobileEntryResponse.status(),
      finalPath: new URL(page.url()).pathname,
      uniqueActionTestId: "new-workspace",
      exactAccessibleName: "新建任务",
      uniqueActionCount: 1,
      rpcTokenSource: "Gateway POST /api/mobile/session response in harness auth-disabled mode",
      passedBeforeLongSeed: true,
    };
    await context.writeArtifactJson("mobile-transcript-pagination-setup-gate.json", mobileMountSetupGate);

    const paginationFixtureRpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
    context.addCleanup("close pagination seed and preflight RPC", () =>
      closeRpcAndWait(paginationFixtureRpc, "pagination seed and preflight RPC"),
    );
    const fixtureInitialize = await paginationFixtureRpc.request("initialize", {
      protocolVersion: "2026-07-27",
      clientInfo: { name: activatedSnapshotMode ? "mobile-transcript-pagination-activated-snapshot" : "mobile-transcript-pagination-observation", version: "1" },
      capabilities: { experimental: {
        threadTranscriptSnapshotV1: true,
        ...(activatedSnapshotMode ? {} : { threadTranscriptObservationV1: true }),
      } },
    }, 15_000);
    assert.equal(
      fixtureInitialize?.capabilities?.experimental?.threadTranscriptSnapshotV1,
      true,
      "the real seed/preflight Gateway RPC must negotiate transcript snapshot support",
    );
    assert.equal(fixtureInitialize?.capabilities?.experimental?.threadIndexedPagesV1, true);
    if (!activatedSnapshotMode) {
      assert.equal(fixtureInitialize?.capabilities?.experimental?.threadTranscriptObservationV1, true,
        "the default fixture RPC must negotiate read-only transcript observation support");
      assert.equal(fixtureInitialize?.capabilities?.experimental?.threadResumeHistoryPageV1, true,
        "the default fixture RPC must negotiate inline resume history support");
    }
    const fixtureResources = await paginationFixtureRpc.request("server/resources/read", {}, 10_000);
    assert.ok(Number.isSafeInteger(fixtureResources?.processId) && fixtureResources.processId > 0);

    const seededTurnCount = ownerSwitchNavigationSmoke ? 1 : 26;
    const seededA = await seedThread(paginationFixtureRpc, {
      title,
      turns: seededTurnCount,
      promptForIndex: (index) => sentinel(index),
    });
    const seededB = initialPageSmoke || oldestRevealSetupSmoke ? null : await seedThread(paginationFixtureRpc, {
      title: ownerBTitle,
      turns: 1,
      promptForIndex: () => "TRANSCRIPT_OWNER_B_00",
    });
    if (seededB) {
      assert.notEqual(seededA.threadId, seededB.threadId, "A/B must be distinct real app-server thread owners");
    }

    const seededHistory = await inspectHistory(gateway, token, seededA.threadId);
    await context.writeArtifactJson("seeded-transcript-history.json", seededHistory);
    assert.equal(
      seededHistory.messageCount,
      seededTurnCount * 2,
      `真实 app-server 源历史必须保留 ${seededTurnCount * 2} 条消息，实际 ${seededHistory.messageCount}`,
    );
    assert.deepEqual(
      seededHistory.userSentinels,
      Array.from({ length: seededTurnCount }, (_, index) => sentinel(index)),
      `real app-server source history must contain ${seededTurnCount} seeded user turn(s) in order`,
    );

    const fixtureInfo = {
      mode: activatedSnapshotMode
        ? "activated-snapshot"
        : ownerSwitchNavigationSmoke
          ? "owner-switch-navigation-one-turn-smoke"
        : heldOwnerResponseReleaseSmoke
          ? "default-observation-held-owner-response-release-smoke"
        : initialPageSmoke
          ? "default-observation-initial-page-smoke"
          : oldestRevealSetupSmoke
            ? "default-observation-oldest-reveal-setup-smoke"
            : "default-observation-full-pagination",
      seededThreadCount: seededB ? 2 : 1,
    };
    const paginationPreflight = ownerSwitchNavigationSmoke
      ? null
      : activatedSnapshotMode
        ? await prepareIndexedPagination(
          context,
          paginationFixtureRpc,
          seededA.threadId,
          seededTurnCount * 2,
          fixtureInfo,
        )
        : await prepareObservedPagination(
          context,
          paginationFixtureRpc,
          seededA.threadId,
          seededTurnCount * 2,
          fixtureInfo,
        );
    if (paginationPreflight) {
      paginationPreflight.fixtureRpcProcessId = fixtureResources.processId;
      await context.writeArtifactJson(
        activatedSnapshotMode
          ? "mobile-transcript-pagination-index-preflight.json"
          : "mobile-transcript-pagination-observation-preflight.json",
        paginationPreflight,
      );
    }
    await closeRpcAndWait(paginationFixtureRpc, "pagination seed and preflight RPC");

    await openThread(page, seededA.threadId, title);
    const initialPage = await waitForTranscriptPage(
      bridge,
      (pageObservation) => pageObservation.threadId === seededA.threadId &&
        pageObservation.requestBeforeCursor === null && pageObservation.success,
      "initial real Mobile first page",
    );
    const mobileNegotiation = assertMobilePageRequestNegotiation(
      bridge,
      initialPage,
      { requireObservation: !activatedSnapshotMode },
    );
    await page
      .getByTestId("message-user")
      .filter({ hasText: sentinel(seededTurnCount - 1) })
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      initialPage.sourceMethod,
      "thread/resume",
      `the initial Mobile page must use the negotiated inline resume result, got ${initialPage.sourceMethod}`,
    );
    assert.equal(initialPage.historyStatus, "ready");
    if (ownerSwitchNavigationSmoke) {
      assert.ok(seededB, "owner-switch navigation smoke must seed a separate real B thread");
      assert.equal(initialPage.messageCount, 2, "the one-turn A task must load its two real message rows");
      assert.equal(initialPage.rangeStart, 0);
      assert.equal(initialPage.rangeEnd, 2);
      assert.equal(initialPage.hasMoreBefore, false, "the navigation-only smoke does not claim cursor pagination");
      assert.equal(initialPage.userMarkers.filter((marker) => marker === sentinel(0)).length, 1);
      assert.equal(await markerRowCount(page, sentinel(0)), 1);

      const taskPathBeforeReload = mobileRoutePath(page);
      assert.ok(taskPathBeforeReload.includes("/task/"), "A must be open on its real Mobile task route before reload");
      const reloadRequestStart = bridge.requests.length;
      await page.reload({ waitUntil: "domcontentloaded" });
      const reloadedFirstPage = await waitForTranscriptPage(
        bridge,
        (pageObservation) => pageObservation.request.requestOrdinal > reloadRequestStart &&
          pageObservation.threadId === seededA.threadId &&
          pageObservation.requestBeforeCursor === null && pageObservation.success,
        "one-turn A first page after direct task-route reload",
      );
      assert.equal(mobileRoutePath(page), taskPathBeforeReload,
        "the task deep-link route must survive a real page reload");
      assert.equal(reloadedFirstPage.sourceMethod, "thread/resume");
      assert.equal(reloadedFirstPage.messageCount, 2);
      assert.deepEqual(reloadedFirstPage.userMarkers, [sentinel(0)]);
      await page.getByTestId("message-user").filter({ hasText: sentinel(0) })
        .waitFor({ state: "visible", timeout: 30_000 });

      const ownerSwitchNavigation = await returnToHomeSessionsAndOpenThread(
        page,
        seededB.threadId,
        ownerBTitle,
      );
      assert.equal(await markerRowCount(page, "TRANSCRIPT_OWNER_B_00"), 1);
      assert.equal(await markerRowCount(page, sentinel(0)), 0,
        "the one-turn navigation smoke must show no A user row in B");
      const visibleOwnerBMarkers = await readVisibleUserMarkers(page);
      assert.deepEqual(visibleOwnerBMarkers, ["TRANSCRIPT_OWNER_B_00"]);
      assert.deepEqual(diagnostics, []);

      const ownedBackendProcesses = await findOwnedExecutableProcesses({
        pgid: gateway.child.pid,
        executablePath: configuredBackendBefore.path,
      });
      const configuredBackendAfter = await hashExecutableFile(kcoderBinary);
      assert.equal(configuredBackendAfter.sha256, expectedBinarySha256,
        "the caller-pinned KCoder binary must remain unchanged after the owner-switch navigation smoke");
      const matchingOwnedBackendProcesses = ownedBackendProcesses.filter(
        (item) => item.sha256 === expectedBinarySha256,
      );
      assert.ok(matchingOwnedBackendProcesses.length > 0,
        "the Gateway process group must contain the caller-pinned KCoder executable during the navigation smoke");
      const backendProcessProvenance = {
        configuredBefore: configuredBackendBefore,
        configuredAfter: configuredBackendAfter,
        expectedSha256: expectedBinarySha256,
        unchanged: true,
        gatewayProcessGroupId: gateway.child.pid,
        status: "verified",
        ownedProcesses: matchingOwnedBackendProcesses,
      };
      await context.writeArtifactJson("mobile-backend-binary-provenance.json", backendProcessProvenance);
      await context.writeArtifactJson("mobile-transcript-pagination-owner-switch-navigation-smoke.json", {
        status: "PASS",
        mode: "real-one-turn-A-B-navigation-after-task-route-reload",
        sourceClassification: {
          callerPinnedSourceSnapshot: sourceIdentity.snapshotProof,
          callerPinnedArchive: {
            path: sourcePins.archivePath,
            sha256: sourcePins.archiveSha256,
            bundleSha256: mobileWeb.bundleSha256,
          },
          productionGatewayDeployment: {
            path: deployment.path,
            manifestSha256: deployment.manifestSha256,
            inventoryVerifiedAgainstArchive: deployment.inventoryVerifiedAgainstArchive,
          },
          frozenBackendBinary: backendProcessProvenance,
        },
        seededThreads: {
          A: { threadId: seededA.threadId, turns: 1, messages: 2 },
          B: { threadId: seededB.threadId, turns: 1, messages: 2 },
          distinct: true,
        },
        taskRouteReload: {
          path: taskPathBeforeReload,
          firstPage: projectReadResponse(reloadedFirstPage),
        },
        navigation: ownerSwitchNavigation,
        visibleOwnerBMarkers,
        noAContentInB: true,
        cursorPaginationClaim: false,
        staleCursorClaim: false,
        heldOldPageIsolationClaim: false,
        ownerSwitchScopeClaim: "A-to-B navigation and visible thread isolation only; not A-to-B-to-A ABA and not a held stale page race",
      });
      return {
        callerPinnedMobileArchive: true,
        productionGatewayMobileMount: true,
        frozenBackendBinary: "verified",
        realOneTurnAThread: true,
        realOneTurnBThread: true,
        taskRouteReload: true,
        returnedToHomeThenSessions: true,
        activeOwnerB: true,
        noAContentInB: true,
        cursorPagination: false,
        staleCursorReconciliation: false,
        heldOldPageIsolation: false,
        paginationProofMode: "default-observation-navigation-only",
        realProvider: false,
      };
    }
    assert.equal(initialPage.messageCount, transcriptPageLimit, "the real Mobile first page must contain exactly 50 history rows");
    assert.equal(initialPage.hasMoreBefore, true, "the real Mobile first page must advertise the two older rows");
    const expectedFirstPage = activatedSnapshotMode
      ? paginationPreflight.indexedFirstPage
      : paginationPreflight.observedFirstPage;
    if (activatedSnapshotMode) {
      assert.equal(initialPage.transcriptSnapshotStatus, "available", "activated snapshot mode must use the explicitly refreshed snapshot");
      assert.equal(initialPage.transcriptObservationPresent, false, "activated snapshot mode must remain separate from default observation proof");
    } else {
      assert.equal(initialPage.transcriptSnapshotStatus, "unavailable", "default mode must not activate a committed transcript snapshot");
      assert.equal(initialPage.transcriptSnapshotCode, "legacyReader");
      assert.equal(initialPage.transcriptObservationPresent, true, "default Mobile inline page must carry the real source observation");
      assert.equal(initialPage.transcriptObservationIdPresent, true);
      assert.equal(initialPage.transcriptObservationViewKeyPresent, true);
      assert.equal(initialPage.returnedObservationCursorMatchesObservationId, true);
      assert.equal(initialPage.observationCursorOrdinal, 2);
      assert.equal(initialPage.historyRequestLimit, transcriptPageLimit);
      assert.equal(initialPage.historyRequestIndexed, true, "Mobile inline resume must negotiate the indexed-page contract");
    }
    assert.equal(initialPage.rangeStart, expectedFirstPage.rangeStart);
    assert.equal(initialPage.rangeEnd, expectedFirstPage.rangeEnd);
    assert.equal(initialPage.beforeCursor, expectedFirstPage.beforeCursor);

    if (initialPageSmoke) {
      assert.equal(initialPage.messageCount, 50);
      assert.equal(initialPage.rangeStart, 2);
      assert.equal(initialPage.rangeEnd, 52);
      assert.equal(initialPage.hasMoreBefore, true, "the short mode must verify the real 50-of-52 first-page boundary");
      assert.match(initialPage.beforeCursor ?? "", activatedSnapshotMode
        ? /^tp1:[^:]+:\d+$/
        : /^tp1:ob1-[a-f0-9]{64}:\d+$/,
      "the short mode must observe the actual older cursor for its selected proof mode");
      assert.deepEqual(initialPage.userMarkers, Array.from({ length: 25 }, (_, index) => sentinel(index + 1)));
      assert.equal(await markerRowCount(page, sentinel(0)), 0, "the oldest real seeded user turn must remain outside Mobile's first page");
      await page.getByTestId("load-older-messages").waitFor({ state: "visible", timeout: 30_000 });
      assert.deepEqual(diagnostics, []);

      const ownedBackendProcesses = await findOwnedExecutableProcesses({
        pgid: gateway.child.pid,
        executablePath: configuredBackendBefore.path,
      });
      const configuredBackendAfter = await hashExecutableFile(kcoderBinary);
      assert.equal(configuredBackendAfter.sha256, expectedBinarySha256, "the caller-pinned KCoder binary must remain unchanged after the short run");
      assert.ok(
        ownedBackendProcesses.some((item) => item.sha256 === expectedBinarySha256),
        "the Gateway process group must contain the caller-pinned KCoder executable during the short run",
      );
      const backendProcessProvenance = {
        configuredBefore: configuredBackendBefore,
        configuredAfter: configuredBackendAfter,
        expectedSha256: expectedBinarySha256,
        unchanged: true,
        gatewayProcessGroupId: gateway.child.pid,
        status: "verified",
        ownedProcesses: ownedBackendProcesses.filter((item) => item.sha256 === expectedBinarySha256),
      };
      await context.writeArtifactJson("mobile-backend-binary-provenance.json", backendProcessProvenance);
      await context.writeArtifactJson("mobile-transcript-pagination-initial-page-smoke.json", {
        sourceClassification: {
          callerPinnedSourceSnapshot: sourceIdentity.snapshotProof,
          callerPinnedArchive: {
            path: sourcePins.archivePath,
            sha256: sourcePins.archiveSha256,
            bundleSha256: mobileWeb.bundleSha256,
          },
          productionGatewayDeployment: {
            path: deployment.path,
            manifestSha256: deployment.manifestSha256,
            inventoryVerifiedAgainstArchive: deployment.inventoryVerifiedAgainstArchive,
          },
          frozenBackendBinary: backendProcessProvenance,
        },
        sourceHistory: {
          messageCount: seededHistory.messageCount,
          userSentinels: seededHistory.userSentinels,
        },
        mobileNegotiation,
        paginationPreflight,
        firstPage: projectTranscriptPageObservation(initialPage),
        visibleUserMarkers: await readVisibleUserMarkers(page),
        boundary: activatedSnapshotMode
          ? "26 real seeded turns plus an explicitly activated committed-snapshot 50+2 preflight verify this independent snapshot mode; this short mode does not replace the full UI older-page, stale-reconcile, or owner-switch flow"
          : "26 real seeded turns plus a no-refresh observed 50+2 preflight verify the warm same-backend Mobile page; this short mode does not claim a cold/nonresident restart or replace the full UI stale-reconcile and owner-switch flow",
      });
      return {
        callerPinnedMobileArchive: true,
        productionGatewayMobileMount: true,
        initialRealPageObserved: true,
        initialPageSourceMethod: initialPage.sourceMethod,
        initialPageMessageCount: initialPage.messageCount,
        paginationProofMode: activatedSnapshotMode ? "activated-snapshot" : "default-observation",
      realOlderPagePreflight: true,
        frozenBackendBinary: "verified",
        fullUiPaginationStaleReconcileAndOwnerSwitchRun: false,
        realProvider: false,
      };
    }

    assert.equal(await markerRowCount(page, sentinel(0)), 0, "first page must exclude the oldest seeded user turn");
    assert.equal(initialPage.hasMoreBefore, true, "the real 50-message first page must advertise older history");
    await page
      .getByTestId("load-older-messages")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.match(initialPage.beforeCursor ?? "", activatedSnapshotMode
      ? /^tp1:[^:]+:\d+$/
      : /^tp1:ob1-[a-f0-9]{64}:\d+$/,
    "the real first page must return its mode-specific older cursor");

    if (heldOwnerResponseReleaseSmoke) {
      assert.ok(!activatedSnapshotMode, "held owner-release smoke is scoped to default observation mode");
      const taskPathBeforeReload = mobileRoutePath(page);
      assert.ok(taskPathBeforeReload.includes("/task/"),
        "held owner-release smoke must start on A's real Mobile task route");
      const reloadRequestStart = bridge.requests.length;
      await page.reload({ waitUntil: "domcontentloaded" });
      const reloadedFirstPage = await waitForTranscriptPage(
        bridge,
        (pageObservation) => pageObservation.request.requestOrdinal > reloadRequestStart &&
          pageObservation.threadId === seededA.threadId &&
          pageObservation.requestBeforeCursor === null && pageObservation.success,
        "A first page after direct task-route reload before held owner navigation",
      );
      assert.equal(mobileRoutePath(page), taskPathBeforeReload,
        "A's real task deep-link route must survive reload before owner navigation");
      assert.equal(reloadedFirstPage.sourceMethod, "thread/resume");
      assert.equal(reloadedFirstPage.historyStatus, "ready");
      assert.equal(reloadedFirstPage.messageCount, initialPage.messageCount);
      assert.equal(reloadedFirstPage.rangeStart, initialPage.rangeStart);
      assert.equal(reloadedFirstPage.rangeEnd, initialPage.rangeEnd);
      assert.equal(reloadedFirstPage.hasMoreBefore, true);
      assert.match(reloadedFirstPage.beforeCursor ?? "", /^tp1:ob1-[a-f0-9]{64}:\d+$/,
        "the reloaded default-observation first page must retain its real opaque older cursor");
      assert.deepEqual(reloadedFirstPage.userMarkers, initialPage.userMarkers,
        "task-route reload must preserve the real A first-page marker projection");
      await page.getByTestId("message-user").filter({ hasText: sentinel(seededTurnCount - 1) })
        .waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(await markerRowCount(page, sentinel(0)), 0,
        "the reloaded A first page must still exclude the oldest row before the held request");
      await context.writeArtifactJson("mobile-transcript-pagination-held-owner-route-reload.json", {
        stage: "A-task-route-reloaded-before-held-older-request",
        path: taskPathBeforeReload.replace(/\/task\/[^/]+$/, "/task/[thread]"),
        requestOrdinal: reloadedFirstPage.request.requestOrdinal,
        sourceMethod: reloadedFirstPage.sourceMethod,
        historyStatus: reloadedFirstPage.historyStatus,
        rangeStart: reloadedFirstPage.rangeStart,
        rangeEnd: reloadedFirstPage.rangeEnd,
        messageCount: reloadedFirstPage.messageCount,
        hasMoreBefore: reloadedFirstPage.hasMoreBefore,
        cursorPresent: Boolean(reloadedFirstPage.beforeCursor),
        currentOldestRowCount: await markerRowCount(page, sentinel(0)),
        routePreserved: true,
      });
      const heldOwnerSwitch = await runHeldOwnerSwitchReleasePhase({
        context,
        page,
        bridge,
        browserSockets,
        seededA,
        seededB,
        ownerBTitle,
        ownerBMarker: "TRANSCRIPT_OWNER_B_00",
        oldestMarker: sentinel(0),
        aOnlyMarkers: [...Array.from({ length: seededTurnCount }, (_, index) => sentinel(index)), liveCorrectionMarker],
        expectedBeforeCursor: reloadedFirstPage.beforeCursor,
        expectedOlderRangeEnd: reloadedFirstPage.rangeStart,
        waitFor,
        returnToHomeSessionsAndOpenThread,
        markerRowCount,
        readVisibleUserMarkers,
      });
      assert.deepEqual(diagnostics, []);
      const ownedBackendProcesses = await findOwnedExecutableProcesses({
        pgid: gateway.child.pid,
        executablePath: configuredBackendBefore.path,
      });
      const configuredBackendAfter = await hashExecutableFile(kcoderBinary);
      assert.equal(configuredBackendAfter.sha256, expectedBinarySha256,
        "the caller-pinned KCoder binary must remain unchanged after the held-response release smoke");
      assert.ok(ownedBackendProcesses.some((item) => item.sha256 === expectedBinarySha256),
        "the Gateway process group must contain the caller-pinned KCoder executable during the held-response release smoke");
      const backendProcessProvenance = {
        configuredBefore: configuredBackendBefore,
        configuredAfter: configuredBackendAfter,
        expectedSha256: expectedBinarySha256,
        unchanged: true,
        gatewayProcessGroupId: gateway.child.pid,
        status: "verified",
        ownedProcesses: ownedBackendProcesses.filter((item) => item.sha256 === expectedBinarySha256),
      };
      await context.writeArtifactJson("mobile-backend-binary-provenance.json", backendProcessProvenance);
      await context.writeArtifactJson("mobile-transcript-pagination-held-owner-response-release-smoke.json", {
        status: "PASS",
        mode: "real-default-observation-held-older-response-owner-switch-release",
        sourceClassification: {
          callerPinnedSourceSnapshot: sourceIdentity.snapshotProof,
          callerPinnedArchive: {
            path: sourcePins.archivePath,
            sha256: sourcePins.archiveSha256,
            bundleSha256: mobileWeb.bundleSha256,
          },
          productionGatewayDeployment: {
            path: deployment.path,
            manifestSha256: deployment.manifestSha256,
            inventoryVerifiedAgainstArchive: deployment.inventoryVerifiedAgainstArchive,
          },
          frozenBackendBinary: backendProcessProvenance,
        },
        seededHistory: {
          A: { threadId: seededA.threadId, turns: seededTurnCount, messages: seededHistory.messageCount },
          B: { threadId: seededB.threadId, turns: 1, messages: 2 },
        },
        firstPage: projectReadResponse(initialPage),
        heldOlderPage: projectReadResponse(heldOwnerSwitch.held.response),
        routeForwardWitness: heldOwnerSwitch.routeForwardWitness,
        navigation: heldOwnerSwitch.navigation,
        ownerBMarkersBeforeRelease: heldOwnerSwitch.ownerBMarkersBeforeRelease,
        ownerBMarkersAfterRelease: heldOwnerSwitch.ownerBMarkersAfterRelease,
        claims: {
          realOlderCursorResponseHeld: true,
          exactOriginalResponseForwardedThroughRoute: true,
          noAContentPublishedIntoB: true,
          staleCursorReconciliation: false,
          oldestAnchorPreservation: false,
          coldOrNonresidentBehavior: false,
          aToBToAIsolation: false,
        },
      });
      return {
        callerPinnedMobileArchive: true,
        productionGatewayMobileMount: true,
        frozenBackendBinary: "verified",
        realAHistoryMessages: seededHistory.messageCount,
        realBThread: true,
        heldOlderResponseForwardedAfterBVisible: true,
        noAContentPublishedIntoB: true,
        staleCursorReconciliation: false,
        fullPaginationGate: false,
        realProvider: false,
      };
    }

    const olderUiStages = [];
    olderUiStages.push(await capturePaginationUiStage(context, page, {
      artifactName: "mobile-transcript-pagination-older-ui-before-click.json",
      stage: "before-load-older-click",
      oldestMarker: sentinel(0),
      firstPage: initialPage,
    }));
    await page.getByTestId("load-older-messages").click();
    olderUiStages.push(await capturePaginationUiStage(context, page, {
      artifactName: "mobile-transcript-pagination-older-ui-after-click-before-response.json",
      stage: "after-load-older-click-before-response",
      oldestMarker: sentinel(0),
      firstPage: initialPage,
    }));
    const initialOlderPage = await waitForRead(
      bridge,
      (read) => read.threadId === seededA.threadId &&
        read.requestBeforeCursor === initialPage.beforeCursor && read.success,
      "initial real indexed older page",
    );
    await page.evaluate(() => new Promise((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    olderUiStages.push(await capturePaginationUiStage(context, page, {
      artifactName: "mobile-transcript-pagination-older-ui-after-response-before-visible-gate.json",
      stage: "after-real-older-response-and-two-animation-frames",
      oldestMarker: sentinel(0),
      firstPage: initialPage,
      olderPage: initialOlderPage,
    }));
    let oldestReveal = null;
    try {
      oldestReveal = await scrollToTranscriptAnchor(page, sentinel(0), {
        maximumWheelSteps: 48,
      });
      olderUiStages.push(await capturePaginationUiStage(context, page, {
        artifactName: "mobile-transcript-pagination-older-ui-after-oldest-anchor-positioning.json",
        stage: "after-oldest-anchor-positioning-before-strict-ui-assertions",
        oldestMarker: sentinel(0),
        firstPage: initialPage,
        olderPage: initialOlderPage,
      }));
      assert.equal(oldestReveal.rowMatchCount, 1, "the real oldest user turn must mount as one transcript row after anchor positioning");
      assert.equal(oldestReveal.markerTextMatchCount, 1, "the oldest marker must remain unique after anchor positioning");
      assert.equal(oldestReveal.markerIntersectsWindow, true, "the oldest user marker must be visible in the window after anchor positioning");
      assert.equal(oldestReveal.markerIntersectsList, true, "the oldest marker must remain within the real Mobile message list");
      await page
        .getByTestId("message-user")
        .filter({ hasText: sentinel(0) })
        .waitFor({ state: "visible", timeout: 30_000 });
      await page
        .getByTestId("load-older-messages")
        .waitFor({ state: "hidden", timeout: 30_000 });
    } catch (error) {
      const failureStage = await capturePaginationUiStage(context, page, {
        artifactName: "mobile-transcript-pagination-older-ui-visible-gate-failure.json",
        stage: "oldest-visible-or-older-control-hidden-gate-failed",
        oldestMarker: sentinel(0),
        firstPage: initialPage,
        olderPage: initialOlderPage,
      });
      const screenshot = await capturePrivatePaginationFailureScreenshot(
        context,
        page,
        "mobile-transcript-pagination-older-ui-visible-gate-failure.png",
      );
      await context.writeArtifactJson("mobile-transcript-pagination-older-ui-failure.json", {
        status: "FAIL",
        failedGate: "oldest-anchor positioning, oldest user row visibility, or older-page control hidden after real older-page response",
        error: context.redactText(error?.message ?? String(error)).slice(0, 1_600),
        stageArtifacts: olderUiStages.map((stage) => stage.artifactName),
        failureStage: failureStage.artifactName,
        screenshot,
      });
      throw error;
    }
    olderUiStages.push(await capturePaginationUiStage(context, page, {
      artifactName: "mobile-transcript-pagination-older-ui-visible-gate-passed.json",
      stage: "oldest-visible-and-older-control-hidden",
      oldestMarker: sentinel(0),
      firstPage: initialPage,
      olderPage: initialOlderPage,
    }));
    assert.ok(initialOlderPage.messageCount > 0, "real older cursor response must contain server history rows");
    assert.equal(initialOlderPage.messageCount, seededHistory.messageCount - transcriptPageLimit,
      "real Mobile older-page response must contain exactly the two remaining source messages");
    assert.equal(initialOlderPage.sourceMethod, "thread/read/indexed");
    if (activatedSnapshotMode) {
      assert.equal(initialOlderPage.transcriptSnapshotStatus, "available");
      assert.equal(initialOlderPage.transcriptObservationPresent, false);
    } else {
      assert.equal(initialOlderPage.transcriptSnapshotStatus, "unavailable");
      assert.equal(initialOlderPage.transcriptSnapshotCode, "legacyReader");
      assert.equal(initialOlderPage.transcriptObservationPresent, true);
      assert.equal(initialOlderPage.requestedObservationCursorMatchesObservationId, true);
    }
    assert.equal(initialOlderPage.rangeStart, 0);
    assert.equal(initialOlderPage.rangeEnd, 2);
    assert.ok(initialOlderPage.userMarkers.includes(sentinel(0)));

    if (oldestRevealSetupSmoke) {
      const ownedBackendProcesses = await findOwnedExecutableProcesses({
        pgid: gateway.child.pid,
        executablePath: configuredBackendBefore.path,
      });
      const configuredBackendAfter = await hashExecutableFile(kcoderBinary);
      assert.equal(configuredBackendAfter.sha256, expectedBinarySha256,
        "the caller-pinned KCoder binary must remain unchanged after the oldest-reveal setup smoke");
      assert.ok(ownedBackendProcesses.some((item) => item.sha256 === expectedBinarySha256),
        "the Gateway process group must contain the caller-pinned KCoder executable during the oldest-reveal setup smoke");
      const backendProcessProvenance = {
        configuredBefore: configuredBackendBefore,
        configuredAfter: configuredBackendAfter,
        expectedSha256: expectedBinarySha256,
        unchanged: true,
        gatewayProcessGroupId: gateway.child.pid,
        status: "verified",
        ownedProcesses: ownedBackendProcesses.filter((item) => item.sha256 === expectedBinarySha256),
      };
      const wheelDiagnostics = await readTranscriptWheelDiagnostics(page);
      await context.writeArtifactJson("mobile-backend-binary-provenance.json", backendProcessProvenance);
      await context.writeArtifactJson("mobile-transcript-pagination-oldest-reveal-setup-smoke.json", {
        status: "PASS",
        mode: "default-observation-oldest-anchor-setup-smoke",
        sourceClassification: {
          callerPinnedSourceSnapshot: sourceIdentity.snapshotProof,
          callerPinnedArchive: {
            path: sourcePins.archivePath,
            sha256: sourcePins.archiveSha256,
            bundleSha256: mobileWeb.bundleSha256,
          },
          productionGatewayDeployment: {
            path: deployment.path,
            manifestSha256: deployment.manifestSha256,
            inventoryVerifiedAgainstArchive: deployment.inventoryVerifiedAgainstArchive,
          },
          frozenBackendBinary: backendProcessProvenance,
        },
        sourceHistory: {
          messageCount: seededHistory.messageCount,
          userSentinels: seededHistory.userSentinels,
        },
        firstPage: projectTranscriptPageObservation(initialPage),
        olderPage: projectReadResponse(initialOlderPage),
        oldestAnchorPositioning: {
          ...projectAnchor(oldestReveal),
          mode: oldestReveal.revealNeeded ? "trusted-wheel-reveal" : "noRevealNeeded",
          trustedWheelCalibration: oldestReveal.wheelCalibration,
          trustedWheelTraceCount: oldestReveal.wheelTrace.length,
        },
        wheelDiagnostics,
        boundary: "real 26-turn default-observation Mobile history stopped after the oldest row became visible and the real older-page control disappeared; stale-cursor and owner-switch flows were not run",
      });
      return {
        callerPinnedMobileArchive: true,
        productionGatewayMobileMount: true,
        realFirstPageAndOlderPageObserved: true,
        oldestUserRowVisible: true,
        oldestAnchorPositioningMode: oldestReveal.revealNeeded ? "trusted-wheel-reveal" : "noRevealNeeded",
        trustedWheelRevealPerformed: oldestReveal.revealNeeded,
        paginationProofMode: "default-observation",
        frozenBackendBinary: "verified",
        fullUiStaleReconcileAndOwnerSwitchRun: false,
        realProvider: false,
      };
    }

    await page.setViewportSize({ width: 390, height: 10_000 });
    await waitFor(
      async () => (await page.getByTestId("message-user").count()) === 26,
      30_000,
      "all 26 real user rows mounted together",
    );
    const originalUserMarkers = await readVisibleUserMarkers(page);
    assert.deepEqual(
      originalUserMarkers,
      Array.from({ length: 26 }, (_, index) => sentinel(index)),
      "the original 52-message transcript must paginate without duplicate rows or reordering",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const reloadRequestStart = bridge.requests.length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByTestId("message-user")
      .filter({ hasText: sentinel(25) })
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await markerRowCount(page, sentinel(0)), 0, "reload must restore the service's latest first-page boundary");
    await page
      .getByTestId("load-older-messages")
      .waitFor({ state: "visible", timeout: 30_000 });
    const reloadFirstPage = await waitForTranscriptPage(
      bridge,
      (pageObservation) => pageObservation.request.requestOrdinal > reloadRequestStart &&
        pageObservation.threadId === seededA.threadId &&
        pageObservation.requestBeforeCursor === null && pageObservation.success,
      "first page after Mobile reload",
    );
    assert.match(reloadFirstPage.beforeCursor ?? "", activatedSnapshotMode
      ? /^tp1:[^:]+:\d+$/
      : /^tp1:ob1-[a-f0-9]{64}:\d+$/,
    "reload must restore the current real cursor for the selected proof mode");
    assert.equal(reloadFirstPage.historyStatus, "ready");
    if (activatedSnapshotMode) {
      assert.equal(reloadFirstPage.transcriptSnapshotStatus, "available");
      assert.equal(reloadFirstPage.transcriptObservationPresent, false);
    } else {
      assert.equal(reloadFirstPage.transcriptSnapshotStatus, "unavailable");
      assert.equal(reloadFirstPage.transcriptSnapshotCode, "legacyReader");
      assert.equal(reloadFirstPage.transcriptObservationPresent, true);
      assert.equal(reloadFirstPage.returnedObservationCursorMatchesObservationId, true);
    }

    const staleRequestStart = bridge.requests.length;
    bridge.holdNextCursorRequest(seededA.threadId);
    await page.getByTestId("load-older-messages").click();
    const heldStaleRequest = await waitFor(
      () => bridge.heldCursorRequest,
      30_000,
      "held outbound older-page request before Gateway dispatch",
    );
    assert.equal(heldStaleRequest.request.threadId, seededA.threadId);
    assert.equal(heldStaleRequest.request.beforeCursor, reloadFirstPage.beforeCursor);
    assert.ok(heldStaleRequest.request.requestOrdinal > staleRequestStart);

    const anchorMarker = sentinel(15);
    const anchorBefore = await scrollToTranscriptAnchor(page, anchorMarker);
    assert.equal(anchorBefore.markerTextMatchCount, 1, "reading anchor must identify one real seeded user row");
    assert.equal(anchorBefore.markerIntersectsWindow, true, "reading anchor must be visible before the live correction");
    assert.ok(await page.getByTestId("jump-to-latest").count(), "the captured reading position must be away from latest");

    await page.getByTestId("message-input").fill(liveCorrectionMarker);
    await page.getByTestId("send-message").click();
    const correctionTurnStart = await waitFor(
      () => bridge.requests.find((request) =>
        request.method === "turn/start" && request.threadId === seededA.threadId &&
        JSON.stringify(request.params.input ?? []).includes(liveCorrectionMarker)),
      30_000,
      "real Mobile correction turn/start frame",
    );
    const correctionTurnAccepted = await waitFor(
      () => bridge.rpcResponses.find((response) =>
        transcriptRpcResponseMatchesRequest(response, correctionTurnStart)),
      30_000,
      "real correction turn/start response",
    );
    assert.equal(correctionTurnAccepted.success, true, "Gateway must accept the real same-thread correction turn");
    const correctionTurnId = correctionTurnAccepted.result?.turn?.id;
    assert.equal(typeof correctionTurnId, "string", "Gateway turn/start response must carry the real correction turn ID");
    const correctionCompletion = await waitFor(
      () => bridge.turnCompletions.find((event) =>
        event.threadId === seededA.threadId && event.turnId === correctionTurnId),
      30_000,
      "real app-server correction turn completion before releasing the old cursor",
    );
    assert.equal(correctionCompletion.status, "completed");

    bridge.releaseHeldCursorRequest();
    const staleCursorResponse = await waitForRead(
      bridge,
      (read) => transcriptRpcResponseMatchesRequest(read, heldStaleRequest.request),
      "real app-server stale cursor response",
    );
    assert.equal(staleCursorResponse.success, false);
    assert.equal(staleCursorResponse.errorCode, -32041, "stale cursor must be reported by the real Gateway app-server");
    assert.ok(Number.isSafeInteger(staleCursorResponse.requestOrdinalAtResponse));
    assert.ok(Number.isSafeInteger(staleCursorResponse.responseOrdinal));

    const isReconciliationFirstPageRequest = (request) =>
      isSameOwnerFirstPageRequest(request, heldStaleRequest.request);
    const reconciliationRequest = await waitFor(
      () => bridge.requests.find(isReconciliationFirstPageRequest),
      30_000,
      "same-owner bounded first-page request after the held older-page request",
    );
    const reconciledFirstPage = await waitForRead(
      bridge,
      (read) => transcriptRpcResponseMatchesRequest(read, reconciliationRequest),
      "same-owner first-page response superseding the held older-page request",
    );
    assert.equal(reconciledFirstPage.success, true);
    assert.equal(reconciledFirstPage.request.threadId, seededA.threadId);
    assert.equal(reconciledFirstPage.request.socketOrdinal, heldStaleRequest.request.socketOrdinal);
    assert.ok(reconciledFirstPage.request.requestOrdinal > heldStaleRequest.request.requestOrdinal);
    assert.equal(reconciledFirstPage.request.params?.limit, transcriptPageLimit,
      "the same-owner cursorless reconciliation request must retain the real bounded page limit");
    assert.equal(reconciledFirstPage.requestBeforeCursor, null,
      "the current owner must reconcile from a cursorless first page");
    assert.notEqual(reconciledFirstPage.beforeCursor, reloadFirstPage.beforeCursor,
      "the fresh first page must return a boundary for the changed transcript observation");
    const previousObservationId = transcriptObservationId(reloadFirstPage.beforeCursor);
    const reconciledObservationId = transcriptObservationId(reconciledFirstPage.beforeCursor);
    let freshObservationIdentityChanged = null;
    if (!activatedSnapshotMode) {
      assert.ok(previousObservationId, "the pre-correction first page must carry an observation identity");
      assert.ok(reconciledObservationId, "the reconciled first page must carry an observation identity");
      assert.notEqual(reconciledObservationId, previousObservationId,
        "the correction must reconcile onto a new transcript observation identity");
      freshObservationIdentityChanged = true;
    }
    assert.equal(reconciledFirstPage.sourceMethod, "thread/read/indexed");
    assert.ok(Number.isSafeInteger(reconciledFirstPage.responseOrdinal));
    assert.equal(reconciledFirstPage.messageCount, transcriptPageLimit,
      "the current owner must reconcile with one bounded first page");
    assert.equal(
      reconciledFirstPage.userMarkers.filter((marker) => marker === liveCorrectionMarker).length,
      1,
      "the fresh first page must include the completed live correction exactly once",
    );
    if (activatedSnapshotMode) {
      assert.equal(reconciledFirstPage.transcriptSnapshotStatus, "available");
      assert.equal(reconciledFirstPage.transcriptObservationPresent, false);
    } else {
      assert.equal(reconciledFirstPage.transcriptSnapshotStatus, "unavailable");
      assert.equal(reconciledFirstPage.transcriptSnapshotCode, "legacyReader");
      assert.equal(reconciledFirstPage.transcriptObservationPresent, true);
      assert.equal(reconciledFirstPage.returnedObservationCursorMatchesObservationId, true);
    }
    const freshFirstPageResponseRelativeToStaleError =
      reconciledFirstPage.responseOrdinal < staleCursorResponse.responseOrdinal
        ? "before-stale-error"
        : "after-stale-error";
    const olderControl = page.getByTestId("load-older-messages");
    await waitFor(
      async () => await olderControl.isEnabled(),
      30_000,
      "older-page control re-enabled after stale cursor reconciliation",
    );
    const reconciliationRequests = bridge.requests.filter(isReconciliationFirstPageRequest);
    const reconciliationResponses = reconciliationRequests.flatMap((request) =>
      bridge.readResponses.filter((read) => transcriptRpcResponseMatchesRequest(read, request)));
    assert.equal(reconciliationRequests.length, 1,
      "the full held older-page race must issue exactly one same-owner cursorless first-page request");
    assert.equal(reconciliationResponses.length, 1,
      "the one bounded first-page request must have exactly one correlated RPC response");
    assert.equal(reconciliationResponses[0], reconciledFirstPage);

    const anchorAfter = await readTranscriptViewport(page, {
      markerText: anchorMarker,
      rowTestId: "message-user",
    });
    assert.equal(typeof anchorBefore.rowDomId, "string", "the reading anchor must identify one mounted transcript row");
    assert.ok(anchorBefore.row);
    assert.ok(anchorAfter.row);
    assert.equal(anchorAfter.rowDomId, anchorBefore.rowDomId, "stale cursor reconciliation must retain the same reading-anchor row");
    assert.equal(anchorAfter.markerTextMatchCount, 1);
    assert.equal(anchorAfter.markerIntersectsWindow, true, "stale cursor reconciliation must keep the reading anchor visible");
    assert.ok(
      Math.abs(anchorAfter.row.offsetFromHost - anchorBefore.row.offsetFromHost) <= 12,
      `stale cursor reconciliation moved the reading anchor by ${Math.abs(anchorAfter.row.offsetFromHost - anchorBefore.row.offsetFromHost)}px`,
    );

    const reconciledUserMarkers = reconciledFirstPage.userMarkers;
    assert.equal(
      reconciledUserMarkers.filter((marker) => marker === liveCorrectionMarker).length,
      1,
      "real reconciled first page must include the live correction once",
    );
    await page.setViewportSize({ width: 390, height: 10_000 });
    await waitFor(
      async () => (await page.getByTestId("message-user").count()) === reconciledUserMarkers.length,
      30_000,
      "the reconciled first page's real user rows mounted together",
    );
    const visibleReconciledMarkers = await readVisibleUserMarkers(page);
    assert.deepEqual(
      visibleReconciledMarkers,
      reconciledUserMarkers,
      "bounded first-page reconciliation must match server order without duplicate appends or dropped live correction",
    );

    const heldOwnerSwitch = await runHeldOwnerSwitchReleasePhase({
      context,
      page,
      bridge,
      browserSockets,
      seededA,
      seededB,
      ownerBTitle,
      ownerBMarker: "TRANSCRIPT_OWNER_B_00",
      oldestMarker: sentinel(0),
      aOnlyMarkers: [...Array.from({ length: seededTurnCount }, (_, index) => sentinel(index)), liveCorrectionMarker],
      expectedBeforeCursor: reconciledFirstPage.beforeCursor,
      expectedOlderRangeEnd: reconciledFirstPage.rangeStart,
      waitFor,
      returnToHomeSessionsAndOpenThread,
      markerRowCount,
      readVisibleUserMarkers,
    });
    const heldOwnerResponse = heldOwnerSwitch.held;
    const ownerSwitchNavigation = heldOwnerSwitch.navigation;
    const ownerBMarkersBeforeRelease = heldOwnerSwitch.ownerBMarkersBeforeRelease;
    const ownerBMarkersAfterRelease = heldOwnerSwitch.ownerBMarkersAfterRelease;
    const routeForwardWitness = heldOwnerSwitch.routeForwardWitness;

    assert.deepEqual(diagnostics, []);
    const ownedBackendProcesses = await findOwnedExecutableProcesses({
      pgid: gateway.child.pid,
      executablePath: configuredBackendBefore.path,
    });
    const configuredBackendAfter = await hashExecutableFile(kcoderBinary);
    assert.equal(configuredBackendAfter.sha256, expectedBinarySha256, "the frozen KCoder binary must remain unchanged after the run");
    assert.equal(configuredBackendAfter.sha256, configuredBackendBefore.sha256);
    const matchingOwnedBackendProcesses = ownedBackendProcesses.filter(
      (item) => item.sha256 === expectedBinarySha256,
    );
    assert.ok(
      matchingOwnedBackendProcesses.length > 0,
      "the Gateway process group must contain the caller-pinned frozen KCoder executable",
    );
    const backendProcessProvenance = {
      configuredBefore: configuredBackendBefore,
      configuredAfter: configuredBackendAfter,
      expectedSha256: expectedBinarySha256,
      unchanged: true,
      gatewayProcessGroupId: gateway.child.pid,
      status: "verified",
      ownedProcesses: matchingOwnedBackendProcesses,
    };
    await context.writeArtifactJson("mobile-backend-binary-provenance.json", backendProcessProvenance);
    await context.writeArtifactJson("mobile-real-transcript-pagination.json", {
      sourceClassification: {
        callerPinnedSourceSnapshot: sourceIdentity.snapshotProof,
        callerPinnedArchive: {
          path: sourcePins.archivePath,
          sha256: sourcePins.archiveSha256,
          bundleSha256: mobileWeb.bundleSha256,
        },
        productionGatewayDeployment: {
          path: deployment.path,
          manifestSha256: deployment.manifestSha256,
          resourceCount: deployment.resourceCount,
          physicalFileCount: deployment.physicalFileCount,
          inventoryVerifiedAgainstArchive: deployment.inventoryVerifiedAgainstArchive,
          configuredGatewayVariable: "KCODER_STUDIO_MOBILE_WEB_ROOT",
          rootWebBundleOverride: false,
        },
        frozenBackendBinary: backendProcessProvenance,
      },
      mobileMountSetupGate,
      paginationProofMode: activatedSnapshotMode ? "activated-snapshot" : "default-observation",
      mobileNegotiation,
      paginationPreflight,
      explicitRefreshRequestCount: activatedSnapshotMode
        ? paginationPreflight.journalActivation?.steps?.length ?? 0
        : 0,
      executionProvenance: {
        modelIndependent: true,
        realAppServer: true,
        providerFixture: "deterministic local fixture",
        realProvider: false,
        noFakeHistoryResponses: true,
        explicitRefreshRequestCount: activatedSnapshotMode
          ? paginationPreflight.journalActivation?.steps?.length ?? 0
          : 0,
        defaultObservationClassification: activatedSnapshotMode
          ? "not exercised in this independent activated-snapshot run"
          : "warm same-backend ordinary-writer path; no Gateway restart or cold/nonresident claim",
      },
      threadOwners: {
        A: seededA.threadId,
        B: seededB.threadId,
        distinct: true,
      },
      originalPagination: {
        sourceMessages: seededHistory.messageCount,
        sourceUserTurns: seededHistory.userSentinels.length,
        initialFirstPageCursor: initialPage.beforeCursor,
        initialFirstPage: projectReadResponse(initialPage),
        initialOlderPageMessageCount: initialOlderPage.messageCount,
        orderedUserMarkers: originalUserMarkers,
        reloadRestoredFirstPageBoundary: true,
        reloadFirstPage: projectReadResponse(reloadFirstPage),
      },
      staleCursorReconciliation: {
        heldOldCursorRequest: heldStaleRequest.request,
        staleServerResponse: projectReadResponse(staleCursorResponse),
        completedLiveTurnId: correctionTurnId,
        completedLiveTurnStatus: correctionCompletion.status,
        reconciledFirstPage: projectReadResponse(reconciledFirstPage),
        freshObservationIdentityChanged,
        freshFirstPageResponseRelativeToStaleError,
        boundedFirstPageRequestCount: reconciliationRequests.length,
        boundedFirstPageResponseCount: reconciliationResponses.length,
        orderedUserMarkers: visibleReconciledMarkers,
        anchorMarker,
        anchorBefore: projectAnchor(anchorBefore),
        anchorAfter: projectAnchor(anchorAfter),
        anchorPreserved: true,
      },
      ownerSwitch: {
        heldResponse: projectReadResponse(heldOwnerResponse.response),
        exactServerFrameForwardedAfterSwitch: true,
        routeForwardWitness,
        navigation: ownerSwitchNavigation,
        activeOwner: "B",
        ownerBUserMarkersAfterRelease: ownerBMarkersAfterRelease,
        noAContentPublishedIntoB: true,
      },
      diagnostics,
    });
    return {
      callerPinnedMobileArchive: true,
      productionGatewayMobileMount: true,
      frozenBackendBinary: "verified",
      realAppServerHistoryMessages: seededHistory.messageCount,
      realAppServerUserTurns: seededHistory.userSentinels.length,
      cursorPagination: true,
      noDuplicates: true,
      ordered: true,
      reloadBoundary: true,
      realStaleCursorCode: staleCursorResponse.errorCode,
      freshObservationIdentityChanged,
      freshFirstPageResponseRelativeToStaleError,
      boundedFirstPageReconciliation: reconciliationRequests.length === 1,
      readingAnchorPreserved: true,
      heldAResponseDidNotCrossIntoOwnerB: true,
      paginationProofMode: activatedSnapshotMode ? "activated-snapshot" : "default-observation",
      explicitRefreshRequestCount: activatedSnapshotMode
        ? paginationPreflight.journalActivation?.steps?.length ?? 0
        : 0,
      realProvider: false,
    };
  },
);

async function seedThread(rpc, { title: threadTitle, turns, promptForIndex }) {
  const started = await rpc.request("thread/start", {});
  for (let index = 0; index < turns; index += 1) {
    const prompt = promptForIndex(index);
    const turn = await rpc.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: prompt }],
    });
    const completion = await rpc.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === turn.turn.id,
      30_000,
      `transcript seed ${threadTitle} turn ${index}`,
    );
    assert.equal(completion.params?.turn?.status, "completed", `transcript seed ${threadTitle} turn ${index} must complete successfully`);
  }
  await rpc.request("thread/metadata/update", {
    threadId: started.thread.id,
    title: threadTitle,
  });
  return { threadId: started.thread.id };
}

async function prepareIndexedPagination(context, rpc, threadId, expectedMessageCount, fixtureInfo) {
  const diagnostics = {
    schemaVersion: 1,
    classification: "redacted real Gateway fixture RPC evidence; transcript message bodies, raw frames, auth material, and actual thread IDs are omitted",
    artifactDirectory: "mobile-transcript-pagination-index-preflight-diagnostics",
    mode: fixtureInfo.mode,
    seededThreadCount: fixtureInfo.seededThreadCount,
    targetMessageCount: expectedMessageCount,
    sameSeedAndRefreshRpcConnection: true,
    events: [],
  };
  await persistPreflightStage(context, diagnostics, "preflight-started", {
    targetThreadIdPresent: typeof threadId === "string" && threadId.length > 0,
  });

  const unprimed = await requestPreflightRpc(
    context,
    diagnostics,
    rpc,
    "unprimed-indexed-read",
    "thread/read/indexed",
    { threadId, limit: transcriptPageLimit },
    15_000,
    (result) => summarizeIndexedProtocolPage(result, threadId),
  );
  assert.equal(unprimed.transcriptSnapshotV1?.status, "unavailable");
  assert.equal(unprimed.transcriptSnapshotV1?.code, "legacyReader");
  assert.equal(unprimed.messages?.length, transcriptPageLimit);
  assert.equal(unprimed.hasMoreBefore, true);
  assert.match(unprimed.beforeCursor ?? "", /^\d+$/, "the unprimed fixture read must retain its legacy numeric cursor evidence");

  const refresh = {
    method: "thread/history/refresh",
    acknowledgeExternalWriters: true,
    requiredJournalDomains: ["History", "ClientMetadata"],
    status: null,
    indexedSessions: null,
    issueCount: null,
    steps: [],
  };
  await refreshTranscriptHistory(context, rpc, refresh, diagnostics);
  await persistPreflightStage(context, diagnostics, "refresh-validated", {
    status: refresh.status,
    indexedSessions: refresh.indexedSessions,
    issueCount: refresh.issueCount,
  });

  const firstPage = await requestPreflightRpc(
    context,
    diagnostics,
    rpc,
    "indexed-first-page-read",
    "thread/read/indexed",
    { threadId, limit: transcriptPageLimit },
    15_000,
    (result) => summarizeIndexedProtocolPage(result, threadId),
  );
  assert.equal(firstPage.transcriptSnapshotV1?.status, "available", "history refresh must activate the indexed transcript snapshot");
  await persistPreflightStage(context, diagnostics, "indexed-first-page-validated", {
    snapshotStatus: firstPage.transcriptSnapshotV1?.status ?? null,
    snapshotCode: firstPage.transcriptSnapshotV1?.code ?? null,
    rangeStart: firstPage.rangeStart ?? null,
    rangeEnd: firstPage.rangeEnd ?? null,
    messageCount: firstPage.messages?.length ?? null,
  });

  const olderPage = await requestPreflightRpc(
    context,
    diagnostics,
    rpc,
    "indexed-older-page-read",
    "thread/read/indexed",
    {
      threadId,
      limit: transcriptPageLimit,
      beforeCursor: firstPage.beforeCursor,
    },
    15_000,
    (result) => summarizeIndexedProtocolPage(result, threadId),
  );
  assert.equal(olderPage.transcriptSnapshotV1?.status, "available", "the opaque older-page read must stay on the indexed snapshot");
  const boundary = assertIndexedTranscriptPageBoundary({
    firstPage,
    olderPage,
    olderPageRequestedBeforeCursor: firstPage.beforeCursor,
    expectedMessageCount,
    pageLimit: transcriptPageLimit,
  });
  const firstPageMarkers = userSentinelMarkers(firstPage.messages);
  const olderPageMarkers = userSentinelMarkers(olderPage.messages);
  assert.ok(!firstPageMarkers.includes(sentinel(0)), "indexed first page must exclude the oldest seeded turn");
  assert.ok(olderPageMarkers.includes(sentinel(0)), "the real indexed cursor page must contain the oldest seeded turn");
  await persistPreflightStage(context, diagnostics, "indexed-page-boundary-validated", {
    expectedMessageCount,
    pageLimit: transcriptPageLimit,
    firstPageRange: [firstPage.rangeStart, firstPage.rangeEnd],
    olderPageRange: [olderPage.rangeStart, olderPage.rangeEnd],
    firstPageSnapshotStatus: firstPage.transcriptSnapshotV1?.status ?? null,
    olderPageSnapshotStatus: olderPage.transcriptSnapshotV1?.status ?? null,
    firstPageCursorClass: classifyTranscriptCursor(firstPage.beforeCursor),
    olderRequestUsedFirstPageCursor: true,
  });

  return {
    classification: "real Gateway app-server RPC on the isolated fixture workspace; seed and refresh used the same initialized RPC connection",
    threadId,
    expectedMessageCount,
    seedAndRefreshSameRpcConnection: true,
    unprimedIndexedRead: {
      sourceMethod: "thread/read/indexed",
      snapshotStatus: unprimed.transcriptSnapshotV1.status,
      snapshotCode: unprimed.transcriptSnapshotV1.code,
      rangeStart: unprimed.rangeStart,
      rangeEnd: unprimed.rangeEnd,
      messageCount: unprimed.messages.length,
      hasMoreBefore: unprimed.hasMoreBefore,
      cursorClass: "legacy-numeric",
    },
    journalActivation: {
      method: refresh.method,
      acknowledgeExternalWriters: refresh.acknowledgeExternalWriters,
      requiredJournalDomains: refresh.requiredJournalDomains,
      refreshStatus: refresh.status,
      activationStatus: "verified_by_available_indexed_snapshot",
      indexedSessions: refresh.indexedSessions,
      issueCount: refresh.issueCount,
      proof: "subsequent thread/read/indexed pages returned transcriptSnapshotV1.status=available",
      domainEnumeration: "required domains are stated from the Rust read-fence contract; the RPC response does not enumerate domains separately",
      steps: refresh.steps,
    },
    boundary,
    indexedFirstPage: summarizeIndexedPage(firstPage),
    indexedOlderPage: summarizeIndexedPage(olderPage),
  };
}

async function prepareObservedPagination(context, rpc, threadId, expectedMessageCount, fixtureInfo) {
  const diagnostics = {
    schemaVersion: 1,
    classification: "redacted real Gateway app-server RPC evidence for a warm same-backend ordinary-writer path; message bodies, raw frames, auth material, and actual thread IDs are omitted; opaque cursor protocol values are retained for exact page correlation",
    artifactDirectory: "mobile-transcript-pagination-observation-preflight-diagnostics",
    mode: fixtureInfo.mode,
    seededThreadCount: fixtureInfo.seededThreadCount,
    targetMessageCount: expectedMessageCount,
    sameSeedAndObservationRpcConnection: true,
    coldOrNonresidentClaim: false,
    events: [],
  };
  await persistPreflightStage(context, diagnostics, "preflight-started", {
    targetThreadIdPresent: typeof threadId === "string" && threadId.length > 0,
    requestedHistoryLimit: transcriptPageLimit,
    requestedIndexedHistory: true,
    refreshCallCount: 0,
  });

  const resumeResponse = await requestPreflightRpc(
    context,
    diagnostics,
    rpc,
    "inline-resume-first-page",
    "thread/resume",
    { threadId, history: { limit: transcriptPageLimit, indexed: true } },
    15_000,
    (result) => summarizeObservedResumeProtocolResponse(result, threadId),
  );
  const firstPage = resumeResponse?.history?.status === "ready"
    ? resumeResponse.history.page
    : null;
  assert.equal(resumeResponse?.thread?.id, threadId, "real inline resume must return the requested thread");
  assert.equal(resumeResponse?.history?.status, "ready", "real inline resume must return a ready first history page");
  assert.ok(firstPage && typeof firstPage === "object", "real inline resume must include its actual first history page");

  await persistPreflightStage(context, diagnostics, "inline-resume-first-page-observed", {
    historyStatus: resumeResponse.history.status,
    threadIdentityMatchesRequest: true,
    page: summarizeObservedProtocolPage(firstPage, "thread/resume.history.page"),
    refreshCallCount: 0,
  });
  assert.match(firstPage.beforeCursor ?? "", /^tp1:ob1-[a-f0-9]{64}:[1-9]\d{0,19}$/, "real inline page must return an observation cursor before the older-page request");
  await persistPreflightStage(context, diagnostics, "inline-resume-cursor-validated", {
    cursorClass: classifyTranscriptCursor(firstPage.beforeCursor),
    cursorPresent: true,
    cursorOrdinal: Number(firstPage.beforeCursor.split(":").at(-1)),
    cursorMatchesObservationIdentity: summarizeObservedProtocolPage(firstPage, "thread/resume.history.page").transcriptObservationV1.cursorIdentityMatchesObservation,
    rangeStart: firstPage.rangeStart ?? null,
    rangeEnd: firstPage.rangeEnd ?? null,
  });
  const olderPageRequestedBeforeCursor = firstPage.beforeCursor;
  const olderPage = await requestPreflightRpc(
    context,
    diagnostics,
    rpc,
    "observed-older-page-read",
    "thread/read/indexed",
    {
      threadId,
      limit: transcriptPageLimit,
      beforeCursor: olderPageRequestedBeforeCursor,
    },
    15_000,
    (result) => summarizeObservedProtocolPage(result, "thread/read/indexed", threadId),
  );
  assert.equal(olderPage?.thread?.id, threadId, "real indexed older page must return the requested thread");
  const boundary = assertObservedTranscriptPageBoundary({
    firstPage,
    olderPage,
    olderPageRequestedBeforeCursor,
    expectedMessageCount,
    pageLimit: transcriptPageLimit,
  });
  assert.ok(
    userSentinelMarkers(firstPage.messages).includes(sentinel(25)),
    "observed first page must retain the newest real seeded user turn",
  );
  assert.ok(
    userSentinelMarkers(olderPage.messages).includes(sentinel(0)),
    "the real observed older cursor page must contain the oldest seeded user turn",
  );
  await persistPreflightStage(context, diagnostics, "observed-page-boundary-validated", {
    expectedMessageCount,
    pageLimit: transcriptPageLimit,
    firstPageRange: [firstPage.rangeStart, firstPage.rangeEnd],
    olderPageRange: [olderPage.rangeStart, olderPage.rangeEnd],
    firstPageSnapshotStatus: firstPage.transcriptSnapshotV1?.status ?? null,
    firstPageSnapshotCode: firstPage.transcriptSnapshotV1?.code ?? null,
    firstPageObservationPresent: Boolean(firstPage.transcriptObservationV1),
    olderPageObservationPresent: Boolean(olderPage.transcriptObservationV1),
    firstPageCursorClass: classifyTranscriptCursor(firstPage.beforeCursor),
    firstPageCursorOrdinalMatchesRangeStart: boundary.firstPage.cursorOrdinalMatchesRangeStart,
    olderRequestUsedFirstPageCursor: boundary.olderPage.requestedCursorMatchesFirstPage,
    sameObservationIdentityAcrossPages: boundary.olderPage.sameObservationIdentity,
    refreshCallCount: 0,
  });
  const explicitRefreshRequestCount = diagnostics.events.filter((event) =>
    event.stage.endsWith("-requested") && event.request?.method === "thread/history/refresh").length;
  assert.equal(explicitRefreshRequestCount, 0, "default observation preflight must not send an explicit history refresh");

  return {
    classification: "real Gateway app-server RPC on the isolated fixture workspace; ordinary turns were seeded on the same RPC connection, with no explicit history refresh; warm same-backend observation path only",
    mode: fixtureInfo.mode,
    threadIdentityMatched: true,
    expectedMessageCount,
    seedAndObservationSameRpcConnection: true,
    explicitRefreshRequestCount,
    coldOrNonresidentClaim: false,
    observation: {
      requestedMethod: "thread/resume",
      requestedHistoryLimit: transcriptPageLimit,
      requestedIndexedHistory: true,
      historyStatus: resumeResponse.history.status,
      snapshotStatus: firstPage.transcriptSnapshotV1?.status ?? null,
      snapshotCode: firstPage.transcriptSnapshotV1?.code ?? null,
      observationPresent: Boolean(firstPage.transcriptObservationV1),
      cursorClass: classifyTranscriptCursor(firstPage.beforeCursor),
      proof: "the real inline first page and the real older-page response share one observation identity while snapshot remains unavailable/legacyReader",
    },
    boundary,
    observedFirstPage: summarizeObservedProtocolPage(firstPage, "thread/resume.history.page"),
    observedOlderPage: summarizeObservedProtocolPage(olderPage, "thread/read/indexed"),
    diagnostics,
  };
}

async function refreshTranscriptHistory(context, rpc, evidence, diagnostics) {
  const deadline = Date.now() + historyRefreshBudgetMs;
  let response = await requestPreflightRpc(
    context,
    diagnostics,
    rpc,
    "history-refresh-begin",
    "thread/history/refresh",
    { acknowledgeExternalWriters: evidence.acknowledgeExternalWriters },
    5_000,
    summarizeRefreshProtocolResponse,
  );
  let step = 1;
  const seenCursors = new Set();
  recordHistoryRefreshStep(evidence, response, step);
  while (response.status === "building" && step < historyRefreshMaxSteps) {
    const cursor = response.nextCursor;
    assert.ok(typeof cursor === "string" && cursor.length > 0, "building history refresh must return a continuation cursor");
    assert.ok(!seenCursors.has(cursor), "history refresh must not repeat a continuation cursor");
    seenCursors.add(cursor);
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "fixture history refresh exceeded its bounded time budget");
    response = await requestPreflightRpc(
      context,
      diagnostics,
      rpc,
      `history-refresh-continuation-${step + 1}`,
      "thread/history/refresh",
      { cursor },
      Math.min(5_000, remaining),
      summarizeRefreshProtocolResponse,
    );
    step += 1;
    recordHistoryRefreshStep(evidence, response, step);
  }
  assert.equal(response.status, "ready", "explicit fixture history refresh must finish ready");
  assert.equal(response.issueCount, 0, "fixture history refresh must not skip source entries");
  assert.ok(Number.isSafeInteger(response.indexedSessions) && response.indexedSessions > 0, "refresh must index at least the seeded transcript session");
  evidence.status = response.status;
  evidence.indexedSessions = response.indexedSessions;
  evidence.issueCount = response.issueCount;
}

async function requestPreflightRpc(context, diagnostics, rpc, stage, method, params, timeoutMs, summarizeResponse) {
  const requestSummary = summarizePreflightRequest(method, params);
  await persistPreflightStage(context, diagnostics, `${stage}-requested`, {
    request: requestSummary,
  });
  try {
    const response = await rpc.request(method, params, timeoutMs);
    await persistPreflightStage(context, diagnostics, `${stage}-response`, {
      request: requestSummary,
      response: summarizeResponse(response),
    });
    return response;
  } catch (error) {
    await persistPreflightStage(context, diagnostics, `${stage}-rpc-error`, {
      request: requestSummary,
      error: {
        name: error instanceof Error ? error.name : "Error",
        tag: diagnosticErrorTag(error),
      },
    });
    throw error;
  }
}

async function persistPreflightStage(context, diagnostics, stage, evidence) {
  const event = {
    sequence: diagnostics.events.length + 1,
    stage,
    ...evidence,
  };
  diagnostics.events.push(event);
  const sequence = String(event.sequence).padStart(2, "0");
  await context.writeArtifactJson(
    `${diagnostics.artifactDirectory}/${sequence}-${stage}.json`,
    {
      schemaVersion: diagnostics.schemaVersion,
      classification: diagnostics.classification,
      mode: diagnostics.mode,
      seededThreadCount: diagnostics.seededThreadCount,
      targetMessageCount: diagnostics.targetMessageCount,
      sameSeedAndRefreshRpcConnection: diagnostics.sameSeedAndRefreshRpcConnection,
      events: diagnostics.events,
    },
  );
}

function summarizePreflightRequest(method, params) {
  if (method === "thread/history/refresh") {
    return {
      method,
      acknowledgeExternalWriters: params.acknowledgeExternalWriters === true,
      continuationCursorPresent: typeof params.cursor === "string",
    };
  }
  return {
    method,
    targetThreadIdPresent: typeof params.threadId === "string" && params.threadId.length > 0,
    limit: params.limit ?? null,
    historyLimit: Number.isSafeInteger(params.history?.limit) ? params.history.limit : null,
    historyIndexed: typeof params.history?.indexed === "boolean" ? params.history.indexed : null,
    beforeCursor: typeof params.beforeCursor === "string" ? params.beforeCursor : null,
    beforeCursorClass: classifyTranscriptCursor(params.beforeCursor),
  };
}

function summarizeIndexedProtocolPage(page, requestedThreadId) {
  const snapshot = page?.transcriptSnapshotV1;
  return {
    threadIdentityMatchesRequest: page?.thread?.id === requestedThreadId,
    transcriptSnapshotV1: {
      status: snapshot?.status ?? null,
      code: snapshot?.code ?? null,
      snapshotIdPresent: typeof snapshot?.snapshotId === "string",
      viewKeyPresent: typeof snapshot?.viewKey === "string",
    },
    rangeStart: Number.isSafeInteger(page?.rangeStart) ? page.rangeStart : null,
    rangeEnd: Number.isSafeInteger(page?.rangeEnd) ? page.rangeEnd : null,
    messageCount: Array.isArray(page?.messages) ? page.messages.length : null,
    hasMoreBefore: page?.hasMoreBefore === true,
    beforeCursor: typeof page?.beforeCursor === "string" ? page.beforeCursor : null,
    beforeCursorClass: classifyTranscriptCursor(page?.beforeCursor),
  };
}

function summarizeRefreshProtocolResponse(response) {
  return {
    status: response?.status ?? null,
    indexedSessions: Number.isSafeInteger(response?.indexedSessions) ? response.indexedSessions : null,
    examinedEntries: Number.isSafeInteger(response?.examinedEntries) ? response.examinedEntries : null,
    issueCount: Number.isSafeInteger(response?.issueCount) ? response.issueCount : null,
    continuationCursorPresent: typeof response?.nextCursor === "string" && response.nextCursor.length > 0,
    continuationCursorLength: typeof response?.nextCursor === "string" ? response.nextCursor.length : null,
  };
}

function classifyTranscriptCursor(cursor) {
  if (typeof cursor !== "string") return null;
  if (/^tp1:ob1-[a-f0-9]{64}:\d+$/.test(cursor)) return "observed-tp1";
  if (cursor.startsWith("tp1:")) return "opaque-tp1";
  if (/^\d+$/.test(cursor)) return "legacy-numeric";
  return "other-string";
}

function summarizeObservedResumeProtocolResponse(response, requestedThreadId) {
  const page = response?.history?.status === "ready" ? response.history.page : null;
  return {
    threadIdentityMatchesRequest: response?.thread?.id === requestedThreadId,
    historyStatus: response?.history?.status ?? null,
    historyCode: response?.history?.code ?? null,
    page: page ? summarizeObservedProtocolPage(page, "thread/resume.history.page") : null,
  };
}

function summarizeObservedProtocolPage(page, sourceMethod, requestedThreadId = null) {
  const snapshot = page?.transcriptSnapshotV1;
  const observation = page?.transcriptObservationV1;
  const cursor = typeof page?.beforeCursor === "string"
    ? page.beforeCursor.match(/^tp1:ob1-([a-f0-9]{64}):(\d+)$/)
    : null;
  return {
    sourceMethod,
    threadIdentityMatchesRequest: requestedThreadId
      ? page?.thread?.id === requestedThreadId
      : null,
    transcriptSnapshotV1: {
      status: snapshot?.status ?? null,
      code: snapshot?.code ?? null,
      snapshotIdPresent: typeof snapshot?.snapshotId === "string",
      viewKeyPresent: typeof snapshot?.viewKey === "string",
    },
    transcriptObservationV1: {
      present: Boolean(observation),
      observationIdFormatValid: typeof observation?.observationId === "string" && /^[a-f0-9]{64}$/.test(observation.observationId),
      viewKeyFormatValid: typeof observation?.viewKey === "string" && /^[a-f0-9]{64}$/.test(observation.viewKey),
      cursorIdentityMatchesObservation: Boolean(cursor && cursor[1] === observation?.observationId),
    },
    rangeStart: Number.isSafeInteger(page?.rangeStart) ? page.rangeStart : null,
    rangeEnd: Number.isSafeInteger(page?.rangeEnd) ? page.rangeEnd : null,
    messageCount: Array.isArray(page?.messages) ? page.messages.length : null,
    hasMoreBefore: page?.hasMoreBefore === true,
    beforeCursor: typeof page?.beforeCursor === "string" ? page.beforeCursor : null,
    beforeCursorClass: classifyTranscriptCursor(page?.beforeCursor),
    beforeCursorOrdinal: cursor ? Number(cursor[2]) : null,
  };
}

function diagnosticErrorTag(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/(?:TRANSCRIPT|HISTORY|RPC)_[A-Z0-9_]+/)?.[0] ?? "unclassified-rpc-error";
}

function recordHistoryRefreshStep(evidence, response, step) {
  evidence.steps.push({
    step,
    status: response.status ?? "unknown",
    indexedSessions: response.indexedSessions ?? null,
    examinedEntries: response.examinedEntries ?? null,
    issueCount: response.issueCount ?? null,
    hasContinuation: typeof response.nextCursor === "string" && response.nextCursor.length > 0,
  });
}

function summarizeIndexedPage(page) {
  return {
    sourceMethod: "thread/read/indexed",
    snapshotStatus: page.transcriptSnapshotV1?.status ?? null,
    rangeStart: page.rangeStart ?? null,
    rangeEnd: page.rangeEnd ?? null,
    messageCount: page.messages?.length ?? null,
    userSentinels: userSentinelMarkers(page.messages),
    hasMoreBefore: page.hasMoreBefore === true,
    beforeCursor: page.beforeCursor ?? null,
  };
}

function userSentinelMarkers(messages) {
  return (messages ?? []).flatMap((message) =>
    message?.role === "user"
      ? String(message.content ?? "").match(/TRANSCRIPT_SENTINEL_\d{2}/g) ?? []
      : [],
  );
}

async function inspectHistory(gateway, token, threadId) {
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
  await initializeRpc(rpc, "mobile-transcript-pagination-inspector");
  const pages = [];
  const userSentinelsByPage = [];
  let messageCount = 0;
  let beforeCursor;
  for (;;) {
    const page = await rpc.request("thread/read", {
      threadId,
      limit: 50,
      ...(beforeCursor ? { beforeCursor } : {}),
    });
    messageCount += (page.messages ?? []).length;
    pages.push({
      rangeStart: page.rangeStart,
      rangeEnd: page.rangeEnd,
      hasMoreBefore: page.hasMoreBefore,
      beforeCursor: page.beforeCursor ?? null,
      messages: (page.messages ?? []).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      })),
    });
    const pageUserSentinels = [];
    for (const message of page.messages ?? []) {
      if (
        message.role === "user" &&
        String(message.content).includes("TRANSCRIPT_SENTINEL_")
      ) {
        pageUserSentinels.push(message.content);
      }
    }
    userSentinelsByPage.push(pageUserSentinels);
    if (!page.hasMoreBefore || !page.beforeCursor) break;
    beforeCursor = page.beforeCursor;
  }
  rpc.close();
  await waitFor(
    () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
    5_000,
    "transcript inspector RPC close",
  );
  return {
    threadId,
    messageCount,
    pages,
    userSentinels: flattenNewestFirstPages(userSentinelsByPage),
  };
}

async function openThread(page, threadId, threadTitle) {
  await page.getByTestId("sessions").click();
  await page.getByTestId("session-search").fill(threadTitle);
  await page
    .getByTestId(`session-${threadId}`)
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId(`session-${threadId}`).click();
  await page
    .getByTestId("message-input-root")
    .waitFor({ state: "visible", timeout: 30_000 });
}

function mobileRoutePath(page) {
  const pathname = new URL(page.url()).pathname;
  assert.ok(
    pathname === "/mobile" || pathname.startsWith("/mobile/"),
    `Mobile navigation must stay under the production /mobile mount, got ${pathname}`,
  );
  return pathname;
}

async function returnToHomeSessionsAndOpenThread(page, threadId, threadTitle, onNavigationStep = () => {}) {
  const markStep = (step) => {
    let path = "[unavailable]";
    try {
      path = new URL(page.url()).pathname
        .replace(/\/h\/[^/]+/g, "/h/[profile]")
        .replace(/\/task\/[^/]+/g, "/task/[thread]");
    } catch {}
    onNavigationStep({ step, path });
  };
  markStep("validate-A-task-route");
  const priorTaskPath = mobileRoutePath(page);
  assert.ok(priorTaskPath.includes("/task/"), "Back navigation must start from a real Mobile task route");
  const expectedHomePath = priorTaskPath.split("/task/")[0].replace(/\/+$/, "");
  const taskHeader = page.getByTestId("task-header");
  assert.equal(await taskHeader.count(), 1, "the current task must expose one task header");
  const backButton = taskHeader.getByRole("button", { name: "返回", exact: true });
  assert.equal(await backButton.count(), 1, "the task header must expose one exact Back button");
  await backButton.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await backButton.isEnabled(), true, "the task Back button must be enabled");
  markStep("click-A-task-back");
  await backButton.click();

  const homeAction = page.getByTestId("new-workspace");
  markStep("wait-home-new-workspace-visible-after-back");
  await homeAction.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await homeAction.count(), 1, "Back must land on one real profile-home action");
  assert.equal(await homeAction.getAttribute("aria-label"), "新建任务");
  assert.equal(await homeAction.isEnabled(), true);
  const homePath = mobileRoutePath(page).replace(/\/+$/, "");
  assert.equal(homePath, expectedHomePath, "Back from a reloaded task must return to that profile's home route");

  const sessionsButton = page.getByTestId("sessions");
  assert.equal(await sessionsButton.count(), 1, "the profile home must expose one sessions navigation TestID");
  markStep("wait-profile-home-sessions-control");
  await sessionsButton.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await sessionsButton.isEnabled(), true, "the sessions navigation control must be enabled");
  markStep("click-profile-home-sessions");
  await sessionsButton.click();

  const sessionSearch = page.getByTestId("session-search");
  markStep("wait-sessions-search-visible");
  await sessionSearch.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await sessionSearch.count(), 1, "the sessions route must expose one search field");
  const sessionsPath = mobileRoutePath(page).replace(/\/+$/, "");
  assert.equal(sessionsPath, "/mobile/sessions", "the home sessions action must open the production sessions route");
  markStep("fill-sessions-search-for-B");
  await sessionSearch.fill(threadTitle);

  const sessionRow = page.getByTestId(`session-${threadId}`);
  markStep("wait-exact-B-session-row-visible");
  await sessionRow.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await sessionRow.count(), 1, "the exact B thread row must be unique after search");
  assert.equal(await sessionRow.isEnabled(), true, "the exact B thread row must be enabled");
  markStep("click-exact-B-session-row");
  await sessionRow.click();

  const composer = page.getByTestId("message-input-root");
  markStep("wait-B-composer-visible");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await composer.count(), 1, "the selected task route must expose one real message composer");
  const selectedTaskPath = mobileRoutePath(page);
  assert.ok(selectedTaskPath.includes("/task/"), "selecting B must open a Mobile task route");
  assert.ok(selectedTaskPath.endsWith(`/${threadId}`), "the selected task route must identify B's exact thread");
  const selectedTaskHeader = page.getByTestId("task-header");
  assert.equal(await selectedTaskHeader.count(), 1, "the selected B route must expose one task header");

  return {
    backButton: { testId: "task-header", role: "button", exactName: "返回", count: 1 },
    home: { path: homePath, actionTestId: "new-workspace", actionCount: 1 },
    sessions: { path: sessionsPath, buttonTestId: "sessions", buttonCount: 1, searchCount: 1 },
    selectedThread: {
      threadId,
      rowTestId: `session-${threadId}`,
      rowCount: 1,
      path: selectedTaskPath,
      composerCount: 1,
      taskHeaderCount: 1,
    },
  };
}

async function connect(page, gateway, token) {
  await page
    .getByTestId("welcome-direct-connection")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(token);
  await page.getByTestId("gateway-connect").click();
  await page
    .getByTestId("new-workspace")
    .waitFor({ state: "visible", timeout: 30_000 });
}

function assertMobilePageRequestNegotiation(bridge, pageObservation, { requireObservation }) {
  const socketOrdinal = pageObservation.request?.socketOrdinal;
  assert.ok(Number.isSafeInteger(socketOrdinal), "Mobile history page must retain its actual RPC socket identity");
  const initializeRequest = bridge.requests.find((request) =>
    request.method === "initialize" && request.socketOrdinal === socketOrdinal);
  assert.ok(initializeRequest, "the real Mobile history socket must have an observed initialize request");
  assert.equal(initializeRequest.params?.clientInfo?.name, "kcoder-studio-mobile");
  const offeredCapabilities = initializeRequest.params?.capabilities?.experimental ?? {};
  assert.equal(offeredCapabilities.threadTranscriptSnapshotV1, true);
  assert.equal(offeredCapabilities.threadTranscriptObservationV1, true, "Mobile must explicitly opt into transcript observations");

  const initializeResponse = bridge.rpcResponses.find((response) =>
    transcriptRpcResponseMatchesRequest(response, initializeRequest));
  assert.ok(initializeResponse, "the Mobile initialize response must be captured on the history socket");
  assert.equal(initializeResponse.success, true, "the Gateway must accept the actual Mobile initialize request");
  const serverCapabilities = initializeResponse.result?.capabilities?.experimental ?? {};
  assert.equal(serverCapabilities.threadIndexedPagesV1, true, "the actual Mobile Gateway route must negotiate indexed pages");
  assert.equal(serverCapabilities.threadResumeHistoryPageV1, true, "the actual Mobile Gateway route must negotiate inline resume history");
  assert.equal(serverCapabilities.threadTranscriptObservationV1, true, "the actual Mobile Gateway route must negotiate transcript observation");
  if (requireObservation) {
    assert.equal(pageObservation.transcriptObservationPresent, true);
    assert.equal(pageObservation.transcriptSnapshotStatus, "unavailable");
  }
  return {
    clientName: initializeRequest.params.clientInfo.name,
    socketOrdinal,
    mobileRequestedSnapshotCapability: true,
    mobileRequestedObservationCapability: true,
    serverSupportsIndexedPages: true,
    serverSupportsInlineResumeHistory: true,
    serverSupportsObservation: true,
    pageObservationRequired: requireObservation,
  };
}

async function requestMobileRpcToken(context, gateway) {
  assert.equal(
    gateway.authToken,
    "",
    "transcript pagination must use the E2E harness auth-disabled Gateway contract",
  );
  const response = await fetch(new URL("/api/mobile/session", gateway.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: gateway.authToken }),
  });
  assert.equal(
    response.status,
    200,
    "the production Mobile session API must issue a real session in auth-disabled E2E mode",
  );
  const payload = await response.json();
  assert.ok(
    typeof payload.accessToken === "string" && payload.accessToken.length > 0,
    "the production Mobile session API must return its actual access token",
  );
  assert.ok(
    Number.isFinite(payload.expiresAt),
    "the production Mobile session API must return the session expiry",
  );
  assert.ok(
    typeof payload.rpcToken === "string" && payload.rpcToken.length > 0,
    "the production Mobile session API must return its actual Gateway RPC token",
  );
  context.registerSecret(payload.accessToken);
  context.registerSecret(payload.rpcToken);
  return payload.rpcToken;
}

async function installTranscriptRpcBridge(page) {
  const bridge = {
    nextSocketOrdinal: 0,
    nextRequestOrdinal: 0,
    nextResponseOrdinal: 0,
    requests: [],
    rpcResponses: [],
    historyPageResponses: [],
    readResponses: [],
    turnCompletions: [],
    cursorRequestHolds: [],
    cursorResponseHolds: [],
    routeForwardResponses: [],
    heldCursorRequest: null,
    heldCursorResponse: null,
    requestedCursorHoldThreadId: null,
    requestedResponseHoldThreadId: null,
    holdNextCursorRequest(threadId) {
      assert.equal(this.requestedCursorHoldThreadId, null, "only one cursor request can be armed at a time");
      this.requestedCursorHoldThreadId = threadId;
    },
    releaseHeldCursorRequest() {
      const held = this.heldCursorRequest;
      assert.ok(held, "no outbound cursor request is held");
      assert.equal(held.clientClosed(), false, "held stale cursor request socket must remain open");
      this.heldCursorRequest = null;
      held.upstream.send(held.rawRequest);
      held.releasedAtMs = performance.now();
    },
    holdNextCursorResponse(threadId) {
      assert.equal(this.requestedResponseHoldThreadId, null, "only one cursor response can be armed at a time");
      this.requestedResponseHoldThreadId = threadId;
    },
    releaseHeldCursorResponse() {
      const held = this.heldCursorResponse;
      assert.ok(held, "no successful cursor response is held");
      assert.equal(held.clientClosed(), false, "held A response socket must remain open across the owner switch");
      this.heldCursorResponse = null;
      held.releasedAtMs = performance.now();
      held.route.send(held.rawResponse);
      held.forwardedAtMs = performance.now();
      held.routeForward = {
        request: held.response.request,
        rawResponse: held.rawResponse,
        socketOrdinal: held.socketOrdinal,
        responseOrdinal: held.response.responseOrdinal,
        heldAtMs: held.heldAtMs,
        releasedAtMs: held.releasedAtMs,
        forwardedAtMs: held.forwardedAtMs,
      };
      bridge.routeForwardResponses.push(held.routeForward);
    },
  };

  await page.routeWebSocket("**/rpc*", (route) => {
    const socketOrdinal = ++bridge.nextSocketOrdinal;
    const upstream = route.connectToServer();
    let clientClosed = false;
    let upstreamClosed = false;
    route.onClose(() => { clientClosed = true; });
    upstream.onClose(() => { upstreamClosed = true; });
    const requests = new Map();

    route.onMessage((raw) => {
      const frame = parseJsonFrame(raw);
      if (frame && frame.id !== undefined && typeof frame.method === "string") {
        const request = {
          id: String(frame.id),
          method: frame.method,
          threadId: frame.params?.threadId ?? null,
          beforeCursor: frame.params?.beforeCursor ?? null,
          params: structuredClone(frame.params ?? {}),
          requestOrdinal: ++bridge.nextRequestOrdinal,
          socketOrdinal,
          rawRequest: String(raw),
          atMs: performance.now(),
        };
        requests.set(request.id, request);
        bridge.requests.push(request);
        if (
          request.method === "thread/read/indexed" &&
          typeof request.beforeCursor === "string" &&
          request.threadId === bridge.requestedCursorHoldThreadId
        ) {
          bridge.requestedCursorHoldThreadId = null;
          const held = {
            request,
            rawRequest: String(raw),
            upstream,
            socketOrdinal,
            clientClosed: () => clientClosed,
            upstreamClosed: () => upstreamClosed,
            heldAtMs: performance.now(),
            releasedAtMs: null,
          };
          bridge.heldCursorRequest = held;
          bridge.cursorRequestHolds.push(held);
          return;
        }
      }
      upstream.send(raw);
    });

    upstream.onMessage((raw) => {
      const frame = parseJsonFrame(raw);
      const request = frame && frame.id !== undefined ? requests.get(String(frame.id)) : null;
      if (request) {
        const rpcResponse = {
          requestId: request.id,
          request,
          success: !frame.error,
          errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
          errorMessage: typeof frame.error?.message === "string" ? frame.error.message : null,
          result: frame.result ?? null,
          rawResponse: String(raw),
          responseOrdinal: ++bridge.nextResponseOrdinal,
          atMs: performance.now(),
        };
        bridge.rpcResponses.push(rpcResponse);
        const pageObservation = observeTranscriptPageResponse(request, rpcResponse);
        if (pageObservation) {
          pageObservation.requestOrdinalAtResponse = bridge.nextRequestOrdinal;
          bridge.historyPageResponses.push(pageObservation);
          if (request.method === "thread/read/indexed") {
            const readResponse = pageObservation;
            bridge.readResponses.push(readResponse);
            if (
              readResponse.success &&
              typeof request.beforeCursor === "string" &&
              request.threadId === bridge.requestedResponseHoldThreadId
            ) {
              bridge.requestedResponseHoldThreadId = null;
              const held = {
                response: readResponse,
                rawResponse: String(raw),
                route,
                socketOrdinal,
                clientClosed: () => clientClosed,
                upstreamClosed: () => upstreamClosed,
                heldAtMs: performance.now(),
                releasedAtMs: null,
              };
              bridge.heldCursorResponse = held;
              bridge.cursorResponseHolds.push(held);
              return;
            }
          }
        }
        route.send(raw);
        return;
      }

      if (frame?.method === "turn/completed") {
        bridge.turnCompletions.push({
          threadId: frame.params?.threadId ?? frame.params?.turn?.threadId ?? null,
          turnId: frame.params?.turnId ?? frame.params?.turn?.id ?? null,
          status: frame.params?.turn?.status ?? frame.params?.status ?? null,
          socketOrdinal,
          atMs: performance.now(),
        });
      }
      route.send(raw);
    });
  });
  return bridge;
}

async function waitForRead(bridge, predicate, label) {
  return waitFor(
    () => bridge.readResponses.find(predicate),
    30_000,
    label,
    25,
  );
}

async function capturePaginationUiStage(context, page, {
  artifactName,
  stage,
  oldestMarker,
  firstPage,
  olderPage = null,
}) {
  const collectionErrors = [];
  const capture = async (label, read) => {
    try {
      return await read();
    } catch (error) {
      collectionErrors.push({
        source: label,
        error: context.redactText(error?.message ?? String(error)).slice(0, 300),
      });
      return null;
    }
  };

  const userRows = page.getByTestId("message-user");
  const oldestRow = userRows.filter({ hasText: oldestMarker });
  const olderControl = page.getByTestId("load-older-messages");
  const [mountedUserRowCount, oldestRowCount, olderControlCount] = await Promise.all([
    capture("message-user locator count", () => userRows.count()),
    capture("oldest marker locator count", () => oldestRow.count()),
    capture("load-older locator count", () => olderControl.count()),
  ]);
  const [oldestRowVisible, oldestRowBoundingBox, olderControlVisible, olderControlEnabled, olderControlText] =
    await Promise.all([
      oldestRowCount === 1 ? capture("oldest marker visibility", () => oldestRow.isVisible()) : null,
      oldestRowCount === 1 ? capture("oldest marker bounds", () => oldestRow.boundingBox()) : null,
      olderControlCount === 1 ? capture("load-older visibility", () => olderControl.isVisible()) : null,
      olderControlCount === 1 ? capture("load-older enabled state", () => olderControl.isEnabled()) : null,
      olderControlCount === 1 ? capture("load-older label", () => olderControl.innerText()) : null,
    ]);
  const [dom, viewport, mountedUserMarkers, wheelDiagnostics] = await Promise.all([
    capture("DOM/window snapshot", () => page.evaluate((marker) => {
      const round = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
      const rect = (element) => {
        if (!(element instanceof Element)) return null;
        const bounds = element.getBoundingClientRect();
        return {
          top: round(bounds.top),
          bottom: round(bounds.bottom),
          left: round(bounds.left),
          right: round(bounds.right),
          width: round(bounds.width),
          height: round(bounds.height),
        };
      };
      const visible = (element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.width > 0 && bounds.height > 0 && style.display !== "none" &&
          style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
      };
      const list = document.querySelector('[data-testid="message-list"]');
      const users = list ? [...list.querySelectorAll('[data-testid="message-user"]')] : [];
      const assistants = list ? [...list.querySelectorAll('[data-testid="message-assistant"]')] : [];
      const oldestRows = users.filter((row) => (row.textContent ?? "").includes(marker));
      const controls = [...document.querySelectorAll('[data-testid="load-older-messages"]')];
      const viewport = window.visualViewport;
      const listBounds = list?.getBoundingClientRect() ?? null;
      return {
        window: {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          scrollX: round(window.scrollX),
          scrollY: round(window.scrollY),
          visualViewport: viewport ? {
            width: round(viewport.width),
            height: round(viewport.height),
            offsetLeft: round(viewport.offsetLeft),
            offsetTop: round(viewport.offsetTop),
            scale: round(viewport.scale),
          } : null,
        },
        document: {
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        },
        list: list ? {
          found: true,
          rect: rect(list),
          scrollTop: round(list.scrollTop),
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          userRowCount: users.length,
          assistantRowCount: assistants.length,
          rowWrapperCount: list.querySelectorAll('[id^="message-"]').length,
          oldestRowCount: oldestRows.length,
          oldestRows: oldestRows.slice(0, 2).map((row) => ({ rect: rect(row), visible: visible(row) })),
          mountedUserMarkers: users.flatMap((row) => (row.textContent ?? "").match(/TRANSCRIPT_[A-Z0-9_]+/g) ?? []).slice(0, 32),
          intersectsWindow: Boolean(listBounds && listBounds.bottom > 0 && listBounds.top < window.innerHeight),
        } : { found: false, userRowCount: 0, assistantRowCount: 0, rowWrapperCount: 0, oldestRowCount: 0 },
        olderControls: controls.slice(0, 2).map((control) => ({
          rect: rect(control),
          visible: visible(control),
          role: control.getAttribute("role"),
          disabledAttribute: control.hasAttribute("disabled"),
          ariaDisabled: control.getAttribute("aria-disabled"),
          ariaBusy: control.getAttribute("aria-busy"),
          labelPresent: Boolean((control.textContent ?? "").trim()),
          progressIndicatorCount: control.querySelectorAll('[role="progressbar"], [aria-busy="true"]').length,
        })),
        loadingSignals: {
          progressIndicatorCount: document.querySelectorAll('[role="progressbar"]').length,
          ariaBusyCount: document.querySelectorAll('[aria-busy="true"]').length,
        },
      };
    }, oldestMarker)),
    capture("transcript viewport geometry", () => readTranscriptViewport(page, {
      markerText: oldestMarker,
      rowTestId: "message-user",
    })),
    capture("mounted transcript markers", () => readVisibleUserMarkers(page)),
    capture("trusted transcript wheel diagnostics", () => readTranscriptWheelDiagnostics(page)),
  ]);

  const proof = {
    firstPage: projectPaginationProofForUi(firstPage),
    olderPage: olderPage ? projectPaginationProofForUi(olderPage) : null,
    olderResponseLinkedToFirstCursor: olderPage
      ? typeof firstPage?.beforeCursor === "string" && olderPage.requestBeforeCursor === firstPage.beforeCursor
      : null,
    olderResponseSameThread: olderPage ? olderPage.threadId === firstPage?.threadId : null,
    olderResponseSameMobileSocket: olderPage
      ? Number.isSafeInteger(firstPage?.request?.socketOrdinal) &&
        olderPage.request?.socketOrdinal === firstPage.request.socketOrdinal
      : null,
    oldestMarkerPresentInRealOlderResponse: olderPage
      ? olderPage.userMarkers?.includes(oldestMarker) === true
      : null,
  };
  const evidence = {
    stage,
    artifactName,
    capturedAt: new Date().toISOString(),
    oldestMarker,
    playwrightLocators: {
      mountedUserRowCount,
      oldestRowCount,
      oldestRowVisible,
      oldestRowBoundingBox,
      olderControlCount,
      olderControlVisible,
      olderControlEnabled,
      olderControlText: typeof olderControlText === "string" ? olderControlText.slice(0, 120) : null,
    },
    dom,
    transcriptViewport: viewport,
    mountedUserMarkers,
    wheelDiagnostics,
    sourceProof: proof,
    collectionErrors,
  };
  await context.writeArtifactJson(artifactName, evidence);
  return { artifactName, stage };
}

function projectPaginationProofForUi(page) {
  if (!page) return null;
  return {
    requestId: page.requestId ?? null,
    sourceMethod: page.sourceMethod ?? null,
    threadId: page.threadId ?? null,
    requestSocketOrdinal: page.request?.socketOrdinal ?? null,
    requestOrdinal: page.requestOrdinal ?? null,
    responseOrdinal: page.responseOrdinal ?? null,
    success: page.success === true,
    errorCode: Number.isSafeInteger(page.errorCode) ? page.errorCode : null,
    historyStatus: page.historyStatus ?? null,
    rangeStart: Number.isSafeInteger(page.rangeStart) ? page.rangeStart : null,
    rangeEnd: Number.isSafeInteger(page.rangeEnd) ? page.rangeEnd : null,
    messageCount: Number.isSafeInteger(page.messageCount) ? page.messageCount : null,
    userMarkers: Array.isArray(page.userMarkers) ? page.userMarkers : [],
    hasMoreBefore: page.hasMoreBefore === true,
    snapshotStatus: page.transcriptSnapshotStatus ?? null,
    snapshotCode: page.transcriptSnapshotCode ?? null,
    observationPresent: page.transcriptObservationPresent === true,
    requestBeforeCursorPresent: typeof page.requestBeforeCursor === "string",
    returnedCursorPresent: typeof page.beforeCursor === "string",
    requestedObservationCursorMatchesObservationId:
      page.requestedObservationCursorMatchesObservationId === true,
    returnedObservationCursorMatchesObservationId:
      page.returnedObservationCursorMatchesObservationId === true,
  };
}

async function capturePrivatePaginationFailureScreenshot(context, page, artifactName) {
  try {
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        'input[type="password"], input[name*="token" i], input[id*="token" i], [data-testid*="token" i]',
      )) {
        if (element instanceof HTMLInputElement) {
          element.value = "";
          element.setAttribute("value", "");
        }
        element.style.visibility = "hidden";
      }
    });
    const screenshotPath = context.pathInArtifacts(artifactName);
    await page.screenshot({
      path: screenshotPath,
      fullPage: false,
      animations: "disabled",
      timeout: 5_000,
    });
    await chmod(screenshotPath, 0o600);
    const mode = (await stat(screenshotPath)).mode & 0o777;
    if (mode !== 0o600) throw new Error("pagination failure screenshot permissions were not private");
    return { artifact: artifactName, status: "captured", mode: "0600", credentialInputsMasked: true };
  } catch (error) {
    return {
      artifact: null,
      status: "capture-failed",
      error: context.redactText(error?.message ?? String(error)).slice(0, 300),
    };
  }
}

async function waitForTranscriptPage(bridge, predicate, label) {
  return waitFor(
    () => bridge.historyPageResponses.find(predicate),
    30_000,
    label,
    25,
  );
}

async function scrollToTranscriptAnchor(page, markerText, { maximumWheelSteps = 12 } = {}) {
  assert.ok(Number.isSafeInteger(maximumWheelSteps) && maximumWheelSteps > 0,
    "trusted transcript-anchor scrolling requires a positive finite wheel-step bound");
  const list = page.getByTestId("message-list");
  assert.ok(await list.boundingBox(), "the real Mobile transcript list must have a browser viewport");
  let snapshot = await readTranscriptAnchorSnapshot(page, markerText);
  const targetInitiallyVisible = snapshot.markerIntersectsWindow && snapshot.markerIntersectsList;
  const revealNeeded = !targetInitiallyVisible;
  let wheelCalibration = null;
  if (revealNeeded) {
    const calibrationAnchor = await findVisibleTranscriptCalibrationAnchor(page, snapshot);
    wheelCalibration = await calibrateTranscriptWheelAxis(page, calibrationAnchor);
    snapshot = await readTranscriptAnchorSnapshot(page, markerText);
  } else {
    await armTrustedTranscriptWheelObservation(page, { markerText, rowTestId: "message-user" });
    await resetTranscriptWheelDiagnostics(page);
  }
  let movementPerWheelDelta = wheelCalibration?.rowOffsetPerWheelDelta ?? null;
  for (
    let step = 0;
    step < maximumWheelSteps && !(snapshot.markerIntersectsWindow && snapshot.markerIntersectsList);
    step += 1
  ) {
    assert.ok(Number.isFinite(movementPerWheelDelta) && Math.abs(movementPerWheelDelta) >= 0.01,
      "transcript scrolling requires a nonzero row movement measured from trusted wheel input");
    const wheelDeltaY = transcriptAnchorWheelDelta(snapshot, markerText, movementPerWheelDelta);
    const before = snapshot;
    const wheelBounds = await list.boundingBox();
    assert.ok(wheelBounds, "the real Mobile transcript list must remain mounted during anchor scrolling");
    await page.mouse.move(wheelBounds.x + wheelBounds.width / 2, wheelBounds.y + wheelBounds.height / 2);
    await page.mouse.wheel(0, wheelDeltaY);
    await page.evaluate(() => new Promise((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    snapshot = await readTranscriptAnchorSnapshot(page, markerText);
    const wheelEvent = await readLastTranscriptWheelEvent(page);
    const response = observeTranscriptRowWheelMovement(before, snapshot, wheelEvent?.deltaY);
    await appendTranscriptWheelTrace(page, {
      phase: "anchor-reveal",
      step: step + 1,
      targetMarker: markerText,
      inputDeltaY: wheelDeltaY,
      wheelEvent,
      before: projectTranscriptWheelGeometry(before),
      after: projectTranscriptWheelGeometry(snapshot),
      geometryDelta: transcriptWheelGeometryDelta(before, snapshot),
      observedMovement: response,
      rowOffsetPerWheelDelta: response?.rowOffsetPerWheelDelta ?? null,
    });
    assert.ok(wheelEvent?.isTrusted === true && wheelEvent.targetInsideList === true,
      "every transcript-anchor movement must be an observed trusted wheel inside the real list");
    assert.equal(wheelEvent.deltaY, wheelDeltaY, "the browser must observe the wheel delta selected from measured row movement");
    if (response && before.host.scrollHeight === snapshot.host.scrollHeight &&
      before.rowDomId === snapshot.rowDomId && Number.isFinite(wheelEvent.deltaY) && Math.abs(wheelEvent.deltaY) >= 0.5) {
      const measured = response.rowOffsetDeltaPx / wheelEvent.deltaY;
      if (Number.isFinite(measured) && Math.abs(measured) >= 0.01) movementPerWheelDelta = measured;
    }
  }
  assert.equal(snapshot.listFound, true);
  assert.equal(snapshot.rowMatchCount, 1, "anchor marker must resolve to one real transcript row");
  assert.equal(snapshot.markerTextMatchCount, 1, "anchor marker must appear once in the mounted real transcript");
  assert.equal(snapshot.markerIntersectsWindow, true, "anchor positioning must leave the marker in the viewport");
  assert.equal(snapshot.markerIntersectsList, true, "anchor must remain inside the Mobile message list");
  const wheelDiagnostics = await readTranscriptWheelDiagnostics(page);
  assert.ok(wheelDiagnostics.trace.every((entry) =>
    entry.wheelEvent?.isTrusted === true && entry.wheelEvent?.targetInsideList === true),
  "the anchor setup must retain trusted inside-list evidence for every calibration and reveal wheel");
  if (revealNeeded) {
    assert.ok(wheelCalibration, "an initially hidden anchor must have a measured trusted-wheel calibration");
    assert.ok(wheelDiagnostics.calibration,
      "an initially hidden anchor must retain its trusted-wheel calibration in diagnostics");
    assert.ok(wheelDiagnostics.trace.filter((entry) => entry.phase === "axis-calibration").length >= 2,
      "an initially hidden anchor must retain both trusted calibration wheel events");
  } else {
    assert.equal(wheelCalibration, null, "an already visible anchor must not claim a trusted-wheel reveal");
    assert.equal(wheelDiagnostics.trace.length, 0,
      "an already visible anchor must report no reveal instead of an empty trusted-wheel trace as proof");
  }
  return {
    ...snapshot,
    targetInitiallyVisible,
    revealNeeded,
    wheelCalibration,
    wheelTrace: wheelDiagnostics.trace,
  };
}

async function readTranscriptAnchorSnapshot(page, markerText, { rowDomId = null } = {}) {
  const [geometry, mountedUserMarkers] = await Promise.all([
    readTranscriptViewport(page, { markerText, rowDomId, rowTestId: "message-user" }),
    readVisibleUserMarkers(page),
  ]);
  return {
    ...geometry,
    mountedUserMarkers: mountedUserMarkers.filter((marker) => /^TRANSCRIPT_SENTINEL_\d+$/.test(marker)),
  };
}

async function findVisibleTranscriptCalibrationAnchor(page, targetSnapshot) {
  const candidates = targetSnapshot.mountedUserMarkers ?? [];
  let selected = null;
  const listCenterY = (targetSnapshot.list?.top + targetSnapshot.list?.bottom) / 2;
  assert.ok(Number.isFinite(listCenterY), "wheel-axis calibration requires measured Mobile message-list bounds");
  for (const markerText of candidates) {
    const geometry = await readTranscriptViewport(page, { markerText, rowTestId: "message-user" });
    if (geometry.rowMatchCount !== 1 || geometry.markerTextMatchCount !== 1 ||
      !geometry.markerIntersectsWindow || !geometry.markerIntersectsList ||
      !geometry.rowIntersectsWindow || !geometry.rowIntersectsList ||
      !Number.isFinite(geometry.marker?.centerY)) continue;
    const distance = Math.abs(geometry.marker.centerY - listCenterY);
    if (!selected || distance < selected.distance) selected = { markerText, geometry, distance };
  }
  assert.ok(selected, "wheel-axis calibration requires one real visible user marker inside the message list");
  return selected;
}

async function calibrateTranscriptWheelAxis(page, candidate) {
  const deltaY = -24;
  await armTrustedTranscriptWheelObservation(page, {
    markerText: candidate.markerText,
    rowDomId: candidate.geometry.rowDomId,
    rowTestId: "message-user",
  });
  const start = await readTranscriptAnchorSnapshot(page, candidate.markerText, {
    rowDomId: candidate.geometry.rowDomId,
  });
  assert.equal(start.rowDomId, candidate.geometry.rowDomId, "calibration must retain the selected real user row");
  assert.equal(start.markerIntersectsWindow, true);
  assert.equal(start.markerIntersectsList, true);
  assert.ok(start.host.scrollHeight > start.host.clientHeight, "the real message list must have scroll range for wheel calibration");
  await resetTranscriptWheelDiagnostics(page);

  const first = await performCalibratingTranscriptWheel(page, {
    markerText: candidate.markerText,
    rowDomId: candidate.geometry.rowDomId,
    before: start,
    deltaY,
    step: 1,
  });
  const firstResponse = observeTranscriptRowWheelMovement(start, first.after, first.wheelEvent.deltaY);
  assert.ok(firstResponse, "the first trusted calibration wheel must move both the real list and its exact user-row offset");
  assert.equal(first.after.host.scrollHeight, start.host.scrollHeight,
    "wheel-axis calibration must occur while virtualized transcript height is stable");
  const expectedScrollTopDirection = Math.sign(firstResponse.scrollTopDeltaPx);
  assert.notEqual(expectedScrollTopDirection, 0);

  const second = await performCalibratingTranscriptWheel(page, {
    markerText: candidate.markerText,
    rowDomId: candidate.geometry.rowDomId,
    before: first.after,
    deltaY,
    step: 2,
  });
  const secondResponse = observeTranscriptRowWheelMovement(first.after, second.after, second.wheelEvent.deltaY);
  assert.ok(secondResponse, "the repeated trusted calibration wheel must produce a second measured row movement");
  assert.equal(firstResponse.sameRow, true, "the first wheel must measure the exact selected user row");
  assert.equal(secondResponse.sameRow, true, "the repeated wheel must measure the exact selected user row");
  assert.equal(second.after.rowDomId, first.after.rowDomId,
    "virtualized transcript changes must not replace the exact row used to calibrate wheel movement");
  assert.equal(second.after.rowMatchCount, 1,
    "the repeated calibration snapshot must retain one exact user row");
  assert.equal(second.after.markerTextMatchCount, 1,
    "the repeated calibration snapshot must retain one exact user marker");
  assert.equal(second.after.markerIntersectsWindow, true);
  assert.equal(second.after.markerIntersectsList, true);
  assert.equal(second.wheelEvent.isTrusted, true);
  assert.equal(second.wheelEvent.targetInsideList, true);
  assert.equal(second.wheelEvent.deltaY, first.wheelEvent.deltaY,
    "the repeated calibration must use the same trusted wheel delta");
  assert.equal(second.wheelEvent.deltaY, deltaY);
  assert.equal(Math.sign(secondResponse.scrollTopDeltaPx), expectedScrollTopDirection,
    "the repeated wheel must move the real host in the first measured direction");
  assert.equal(Math.sign(secondResponse.rowOffsetDeltaPx), Math.sign(firstResponse.rowOffsetDeltaPx),
    "repeated trusted wheels must move the exact visible user row in the same observed direction");
  const firstScrollTopPerWheelDelta = firstResponse.scrollTopDeltaPx / first.wheelEvent.deltaY;
  const secondScrollTopPerWheelDelta = secondResponse.scrollTopDeltaPx / second.wheelEvent.deltaY;
  const firstRowOffsetPerWheelDelta = firstResponse.rowOffsetDeltaPx / first.wheelEvent.deltaY;
  const secondRowOffsetPerWheelDelta = secondResponse.rowOffsetDeltaPx / second.wheelEvent.deltaY;
  const scrollTopRatioTolerance = Math.max(0.05, Math.abs(firstScrollTopPerWheelDelta) * 0.1);
  const rowOffsetRatioTolerance = Math.max(0.05, Math.abs(firstRowOffsetPerWheelDelta) * 0.1);
  assert.ok(Math.abs(secondScrollTopPerWheelDelta - firstScrollTopPerWheelDelta) <= scrollTopRatioTolerance,
    "the repeated wheel must preserve the observed host movement per input delta");
  assert.ok(Math.abs(secondRowOffsetPerWheelDelta - firstRowOffsetPerWheelDelta) <= rowOffsetRatioTolerance,
    "the repeated wheel must preserve the observed row movement per input delta");
  const scrollHeightChangePx = second.after.host.scrollHeight - first.after.host.scrollHeight;
  const repeatedMovement = {
    expectedScrollTopDirection,
    actualScrollTopDirection: Math.sign(secondResponse.scrollTopDeltaPx),
    firstScrollTopPerWheelDelta,
    secondScrollTopPerWheelDelta,
    scrollTopRatioTolerance,
    firstRowOffsetPerWheelDelta,
    secondRowOffsetPerWheelDelta,
    rowOffsetRatioTolerance,
    sameTrustedWheelDelta: second.wheelEvent.deltaY === first.wheelEvent.deltaY,
    sameRow: secondResponse.sameRow,
    scrollHeightChangePx,
    rangeStable: Math.abs(scrollHeightChangePx) <= 0.5,
  };

  const rowOffsetPerWheelDelta = (
    firstResponse.rowOffsetDeltaPx / first.wheelEvent.deltaY +
    secondResponse.rowOffsetDeltaPx / second.wheelEvent.deltaY
  ) / 2;
  assert.ok(Number.isFinite(rowOffsetPerWheelDelta) && Math.abs(rowOffsetPerWheelDelta) >= 0.01,
    "the real transcript must expose a measurable row-offset response to trusted wheel input");
  const calibration = {
    markerText: candidate.markerText,
    rowDomId: candidate.geometry.rowDomId,
    deltaY,
    firstResponse,
    secondResponse,
    rowOffsetPerWheelDelta,
    repeatedMovement,
    firstWheelScrollHeightStable: first.after.host.scrollHeight === start.host.scrollHeight,
  };
  await page.evaluate((value) => {
    const audit = window.__sessionCacheWheelAudit;
    if (audit) audit.calibration = value;
  }, calibration);
  return calibration;
}

async function performCalibratingTranscriptWheel(page, {
  markerText,
  rowDomId,
  before,
  deltaY,
  step,
}) {
  await page.mouse.move(before.marker.centerX, before.marker.centerY);
  await page.mouse.wheel(0, deltaY);
  await page.evaluate(() => new Promise((resolveFrame) =>
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
  const after = await readTranscriptAnchorSnapshot(page, markerText, { rowDomId });
  const wheelEvent = await readLastTranscriptWheelEvent(page);
  const observedMovement = observeTranscriptRowWheelMovement(before, after, wheelEvent?.deltaY);
  await appendTranscriptWheelTrace(page, {
    phase: "axis-calibration",
    step,
    targetMarker: markerText,
    inputDeltaY: deltaY,
    wheelEvent,
    before: projectTranscriptWheelGeometry(before),
    after: projectTranscriptWheelGeometry(after),
    geometryDelta: transcriptWheelGeometryDelta(before, after),
    observedMovement,
  });
  assert.ok(wheelEvent?.isTrusted === true && wheelEvent.targetInsideList === true,
    "wheel-axis calibration must use a trusted wheel event on the real message list");
  assert.equal(wheelEvent.deltaY, deltaY, "the observed calibration event must retain its requested delta");
  assert.equal(after.rowDomId, rowDomId, "wheel-axis calibration must retain the exact same user row");
  assert.equal(after.rowMatchCount, 1, "wheel-axis calibration must retain one exact user row");
  assert.equal(after.markerTextMatchCount, 1);
  assert.equal(after.markerIntersectsWindow, true);
  assert.equal(after.markerIntersectsList, true);
  assert.equal(after.rowIntersectsList, true);
  assert.equal(after.rowIntersectsWindow, true);
  return { after, wheelEvent };
}

async function readLastTranscriptWheelEvent(page) {
  return page.evaluate(() => {
    const event = window.__sessionCacheWheelAudit?.events?.at(-1);
    return event ? {
      isTrusted: event.isTrusted === true,
      targetInsideList: event.targetInsideList === true,
      deltaY: Number.isFinite(event.deltaY) ? event.deltaY : null,
    } : null;
  });
}

async function appendTranscriptWheelTrace(page, entry) {
  await page.evaluate((value) => {
    const audit = window.__sessionCacheWheelAudit;
    if (!audit) return;
    audit.trace ??= [];
    audit.trace.push(value);
  }, entry);
}

async function resetTranscriptWheelDiagnostics(page) {
  await page.evaluate(() => {
    const audit = window.__sessionCacheWheelAudit;
    if (!audit) return;
    audit.events.length = 0;
    audit.trace = [];
    audit.calibration = null;
  });
}

async function readTranscriptWheelDiagnostics(page) {
  return page.evaluate(() => {
    const audit = window.__sessionCacheWheelAudit;
    return {
      calibration: audit?.calibration ?? null,
      events: (audit?.events ?? []).map((event) => ({
        isTrusted: event.isTrusted === true,
        targetInsideList: event.targetInsideList === true,
        deltaY: Number.isFinite(event.deltaY) ? event.deltaY : null,
      })),
      trace: Array.isArray(audit?.trace) ? audit.trace : [],
    };
  });
}

function projectTranscriptWheelGeometry(snapshot) {
  const markers = snapshot.mountedUserMarkers ?? [];
  return {
    host: snapshot.host ? {
      testId: snapshot.host.testId,
      scrollTop: snapshot.host.scrollTop,
      scrollHeight: snapshot.host.scrollHeight,
      clientHeight: snapshot.host.clientHeight,
    } : null,
    list: snapshot.list ? { top: snapshot.list.top, bottom: snapshot.list.bottom } : null,
    rowDomId: snapshot.rowDomId ?? null,
    rowMatchCount: snapshot.rowMatchCount ?? 0,
    row: snapshot.row ? {
      top: snapshot.row.top,
      bottom: snapshot.row.bottom,
      offsetFromHost: snapshot.row.offsetFromHost,
    } : null,
    marker: snapshot.marker ? {
      top: snapshot.marker.top,
      bottom: snapshot.marker.bottom,
      centerY: snapshot.marker.centerY,
    } : null,
    markerIntersectsWindow: snapshot.markerIntersectsWindow === true,
    markerIntersectsList: snapshot.markerIntersectsList === true,
    rowIntersectsWindow: snapshot.rowIntersectsWindow === true,
    rowIntersectsList: snapshot.rowIntersectsList === true,
    mountedUserRowCount: Array.isArray(snapshot.mountedUserMarkers) ? markers.length : null,
    mountedOldestMarker: markers[0] ?? null,
    mountedNewestMarker: markers.at(-1) ?? null,
  };
}

function observeTranscriptRowWheelMovement(before, after, deltaY) {
  const response = observeAnchorScrollResponse({
    startScrollTop: before?.host?.scrollTop,
    startOffset: before?.row?.offsetFromHost,
    endScrollTop: after?.host?.scrollTop,
    endOffset: after?.row?.offsetFromHost,
  });
  if (!response) return null;
  return {
    ...response,
    deltaY: Number.isFinite(deltaY) ? deltaY : null,
    rowOffsetPerWheelDelta: Number.isFinite(deltaY) && Math.abs(deltaY) >= 0.5
      ? roundNumber(response.rowOffsetDeltaPx / deltaY)
      : null,
    scrollHeightDeltaPx: Number.isFinite(before?.host?.scrollHeight) && Number.isFinite(after?.host?.scrollHeight)
      ? after.host.scrollHeight - before.host.scrollHeight
      : null,
    sameRow: before?.rowDomId === after?.rowDomId,
  };
}

function transcriptWheelGeometryDelta(before, after) {
  const difference = (start, end) => Number.isFinite(start) && Number.isFinite(end)
    ? roundNumber(end - start)
    : null;
  return {
    hostScrollTopDeltaPx: difference(before?.host?.scrollTop, after?.host?.scrollTop),
    hostScrollHeightDeltaPx: difference(before?.host?.scrollHeight, after?.host?.scrollHeight),
    rowOffsetDeltaPx: difference(before?.row?.offsetFromHost, after?.row?.offsetFromHost),
    rowTopDeltaPx: difference(before?.row?.top, after?.row?.top),
    markerTopDeltaPx: difference(before?.marker?.top, after?.marker?.top),
    markerBottomDeltaPx: difference(before?.marker?.bottom, after?.marker?.bottom),
    sameRow: typeof before?.rowDomId === "string" && before.rowDomId === after?.rowDomId,
  };
}

function transcriptAnchorWheelDelta(snapshot, targetMarker, movementPerWheelDelta) {
  const desiredScreenDirection = desiredTranscriptAnchorMovement(snapshot, targetMarker);
  assert.notEqual(desiredScreenDirection, 0,
    "the transcript anchor must be geometrically classifiable before selecting a wheel direction");
  const wheelDirection = Math.sign(desiredScreenDirection / movementPerWheelDelta);
  assert.notEqual(wheelDirection, 0, "measured wheel geometry must select a nonzero input direction");
  const marker = snapshot.marker;
  let desiredScreenDistance = null;
  if (marker && snapshot.list) {
    if (desiredScreenDirection > 0 && marker.bottom <= snapshot.list.top) {
      desiredScreenDistance = snapshot.list.top - marker.bottom + 24;
    } else if (desiredScreenDirection < 0 && marker.top >= snapshot.list.bottom) {
      desiredScreenDistance = marker.top - snapshot.list.bottom + 24;
    }
  }
  const magnitude = Number.isFinite(desiredScreenDistance)
    ? Math.min(180, Math.max(24, desiredScreenDistance / Math.abs(movementPerWheelDelta)))
    : 180;
  return wheelDirection * magnitude;
}

function desiredTranscriptAnchorMovement(snapshot, targetMarker) {
  const marker = snapshot.marker;
  const list = snapshot.list;
  if (marker && list) {
    if (marker.bottom <= list.top) return 1;
    if (marker.top >= list.bottom) return -1;
    if (snapshot.markerIntersectsList && snapshot.markerIntersectsWindow) return 0;
    return marker.centerY < list.top ? 1 : -1;
  }

  const targetIndex = Number(/TRANSCRIPT_SENTINEL_(\d+)/.exec(targetMarker)?.[1]);
  const mountedIndices = (snapshot.mountedUserMarkers ?? [])
    .map((value) => Number(/TRANSCRIPT_SENTINEL_(\d+)/.exec(value)?.[1]))
    .filter(Number.isSafeInteger);
  if (!Number.isSafeInteger(targetIndex) || mountedIndices.length === 0) return 0;
  const oldestMountedIndex = Math.min(...mountedIndices);
  const newestMountedIndex = Math.max(...mountedIndices);
  if (targetIndex < oldestMountedIndex) return 1;
  if (targetIndex > newestMountedIndex) return -1;
  return 0;
}

function roundNumber(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

async function markerRowCount(page, marker) {
  return page.getByTestId("message-user").filter({ hasText: marker }).count();
}

async function readVisibleUserMarkers(page) {
  const texts = await page.getByTestId("message-user").allInnerTexts();
  return webTranscriptDomOrderToDisplayOrder(
    texts.flatMap((text) => transcriptMarkers(text)),
  );
}

function transcriptMarkers(value) {
  return String(value ?? "").match(/TRANSCRIPT_[A-Z0-9_]+/g) ?? [];
}

function parseJsonFrame(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function projectReadResponse(read) {
  return projectTranscriptPageObservation(read);
}

function projectAnchor(snapshot) {
  return {
    rowDomId: snapshot.rowDomId,
    markerTextMatchCount: snapshot.markerTextMatchCount,
    markerIntersectsWindow: snapshot.markerIntersectsWindow,
    markerIntersectsList: snapshot.markerIntersectsList,
    offsetFromHost: snapshot.row?.offsetFromHost ?? null,
    scrollTop: snapshot.host?.scrollTop ?? null,
  };
}

function serializeBridgeEvidence(bridge) {
  return {
    classification: {
      transportHoldOnly: false,
      firstRaceUsesRealServerStaleCursor: true,
      noFakeHistoryResponses: true,
      secondRaceHoldsUnmodifiedSuccessfulServerResponse: true,
    },
    indexedRequests: bridge.requests
      .filter((request) => request.method === "thread/read/indexed")
      .map((request) => ({
        id: request.id,
        threadId: request.threadId,
        beforeCursor: request.beforeCursor,
        requestOrdinal: request.requestOrdinal,
        socketOrdinal: request.socketOrdinal,
        rawRequest: request.rawRequest,
      })),
    indexedResponses: bridge.readResponses.map((read) => projectReadResponse(read)),
    historyPageResponses: bridge.historyPageResponses.map((page) =>
      projectTranscriptPageObservation(page)),
    turnCompletions: bridge.turnCompletions,
    heldCursorRequests: bridge.cursorRequestHolds.map((held) => ({
      request: {
        id: held.request.id,
        threadId: held.request.threadId,
        beforeCursor: held.request.beforeCursor,
        requestOrdinal: held.request.requestOrdinal,
        socketOrdinal: held.socketOrdinal,
        rawRequest: held.rawRequest,
      },
      heldAtMs: held.heldAtMs,
      releasedAtMs: held.releasedAtMs,
    })),
    heldCursorResponses: bridge.cursorResponseHolds.map((held) => ({
      response: projectReadResponse(held.response),
      heldAtMs: held.heldAtMs,
      releasedAtMs: held.releasedAtMs,
      forwardedAtMs: held.forwardedAtMs ?? null,
      clientClosedBeforeRelease: held.clientClosed(),
      upstreamClosedBeforeRelease: held.upstreamClosed(),
    })),
    clientFacingRouteForwards: bridge.routeForwardResponses.map((forward) => ({
      requestId: forward.request.id,
      requestOrdinal: forward.request.requestOrdinal,
      gatewayRpcSocketOrdinal: forward.socketOrdinal,
      threadId: forward.request.threadId,
      beforeCursor: forward.request.beforeCursor,
      responseOrdinal: forward.responseOrdinal,
      heldAtMs: forward.heldAtMs,
      releasedAtMs: forward.releasedAtMs,
      forwardedAtMs: forward.forwardedAtMs,
      rawFrameOmitted: true,
    })),
    staleCursorRace: serializeStaleCursorRaceEvidence(bridge),
  };
}

function isSameOwnerFirstPageRequest(request, heldRequest) {
  return request?.method === "thread/read/indexed" &&
    request.threadId === heldRequest?.threadId &&
    request.socketOrdinal === heldRequest?.socketOrdinal &&
    Number.isSafeInteger(request.requestOrdinal) &&
    request.requestOrdinal > heldRequest.requestOrdinal &&
    request.beforeCursor === null;
}

function serializeStaleCursorRaceEvidence(bridge) {
  const held = bridge.cursorRequestHolds[0];
  if (!held) return { status: "not-observed" };
  const heldRequest = held.request;
  const staleResponse = bridge.readResponses.find((read) =>
    transcriptRpcResponseMatchesRequest(read, heldRequest));
  const firstPageRequests = bridge.requests.filter((request) =>
    isSameOwnerFirstPageRequest(request, heldRequest));
  const firstPageResponses = firstPageRequests.flatMap((request) =>
    bridge.readResponses.filter((read) =>
      transcriptRpcResponseMatchesRequest(read, request)));
  const firstPageResponse = firstPageResponses.length === 1 ? firstPageResponses[0] : null;
  const firstPageResponseRelativeToStaleError = !staleResponse
    ? "stale-error-not-observed"
    : firstPageResponses.length === 0
      ? "first-page-response-not-observed"
      : firstPageResponses.length !== 1
        ? "multiple-first-page-responses"
        : firstPageResponse.responseOrdinal < staleResponse.responseOrdinal
          ? "before-stale-error"
          : "after-stale-error";
  return {
    status: staleResponse ? "stale-response-observed" : "stale-response-pending",
    heldRequest: {
      id: heldRequest.id,
      method: heldRequest.method,
      threadId: heldRequest.threadId,
      beforeCursor: heldRequest.beforeCursor,
      requestOrdinal: heldRequest.requestOrdinal,
      socketOrdinal: heldRequest.socketOrdinal,
    },
    staleResponse: staleResponse ? {
      requestOrdinal: staleResponse.requestOrdinal,
      responseOrdinal: staleResponse.responseOrdinal,
      success: staleResponse.success,
      errorCode: staleResponse.errorCode,
    } : null,
    firstPageRequests: firstPageRequests.map((request) => ({
      id: request.id,
      method: request.method,
      threadId: request.threadId,
      beforeCursorPresent: typeof request.beforeCursor === "string",
      requestOrdinal: request.requestOrdinal,
      socketOrdinal: request.socketOrdinal,
    })),
    firstPageResponseCount: firstPageResponses.length,
    firstPageResponse: firstPageResponse ? {
      requestId: firstPageResponse.requestId,
      requestOrdinal: firstPageResponse.requestOrdinal,
      responseOrdinal: firstPageResponse.responseOrdinal,
      success: firstPageResponse.success,
      errorCode: firstPageResponse.errorCode,
      messageCount: firstPageResponse.messageCount,
      userMarkers: firstPageResponse.userMarkers,
    } : null,
    firstPageResponseRelativeToStaleError,
  };
}
