import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import {
  buildGatewayMobileWebManifest,
  writeGatewayMobileWebManifest,
} from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const TEST_ID = "mobile-offline-projects-normal-project-flow";
const KCODER_BIN = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
const PREFERENCES_KEY = "kcoder-studio:mobile-app-preferences:v1";
const MESSAGE = "Keep this unsent draft while switching back to the local project.";
const LOCAL_SERVER_ID = "local";
const OFFLINE_SERVER_ID = "offline-ssh";
const OFFLINE_HOST = "kcoder-unreachable.invalid";
const OFFLINE_CWD = "/workspace/offline-project";
const LOCAL_PROJECT_LABEL = "Owned Local Project with a Deliberately Long Workspace Display Name";
const OFFLINE_PROJECT_LABEL = "Unreachable SSH Project with a Deliberately Long Target Display Name";
const TASK_SIDEBAR_TITLE = "Owned empty TaskScreen session with a deliberately long title for single-line ellipsis verification";
const SYNTHETIC_ROOT_PROJECT_KEY = "runtime-target:local";
const PIN_PROJECT_KEY = SYNTHETIC_ROOT_PROJECT_KEY;
const PIN_PROJECT_LABEL = LOCAL_PROJECT_LABEL;
const RENAMED_PROJECT_LABEL = "Owned Renamed Collision Project";
const STATUS_COLORS = {
  dark: { online: "#22C55E", offline: "#C64F43" },
  light: { online: "#15803D", offline: "#B91C1C" },
};
const NEUTRAL_ICON_COLORS = {
  dark: { textMuted: "#A1A1AA" },
  light: { textMuted: "#52525B" },
};
const MATRIX = [
  { width: 320, height: 640, language: "en", theme: "dark" },
  { width: 390, height: 844, language: "en", theme: "dark" },
  { width: 320, height: 640, language: "en", theme: "light" },
  { width: 390, height: 844, language: "en", theme: "light" },
  { width: 320, height: 640, language: "zh-CN", theme: "dark" },
  { width: 390, height: 844, language: "zh-CN", theme: "dark" },
  { width: 320, height: 640, language: "zh-CN", theme: "light" },
  { width: 390, height: 844, language: "zh-CN", theme: "light" },
];

await runE2E(
  import.meta.url,
  {
    testId: TEST_ID,
    tier: "full-integration",
    modelPolicy: "real Mobile Web, isolated authenticated Gateway and Rust app-server; an owned local project plus an intentionally unreachable .invalid SSH target; two owned registry workspaces share a key equal to the synthetic local root key, with one workspace at the root's same path, to test discriminator isolation; both are pinned and unpinned through the real sidebar RPC; one owned empty thread is created for the real TaskScreen route, with no turn, configured provider, model call, user credentials, or shared development service",
    retainSuccessEvidence: true,
    retainSuccessLogs: true,
    evidenceReason: "Verify compact Home/Drawer and Sessions flows, real empty-thread history navigation, shared-target pin/unpin discriminator isolation and persistence, hidden offline SSH read errors with actual transport failure evidence, retry/recovery, and the real TaskScreen sidebar with one owned empty thread",
  },
  async (context) => {
    assert.equal(Number(process.versions.node.split(".", 1)[0]), 22,
      "this registered Mobile E2E requires Node 22");

    let stage = "mobile-export";
    let pairingComplete = false;
    let page = null;
    let mobileWeb;
    let gateway;
    let taskSidebarFixtureRpc = null;
    let taskSidebarFixture = null;
    let projectPinFixture = null;
    const projectPinSetupRequests = [];
    const projectPinSetupReads = [];
    const screenshots = [];
    const sessionsOfflineObservations = [];
    const taskScreenDrawerObservations = [];
    const projectEllipsisObservations = [];
    const projectRenameObservations = [];
    const threadActionsObservations = [];
    let taskDrawerRowEntry = null;
    const popups = [];
    const gatewayStatusSnapshots = [];
    const diagnostics = { pageErrors: [], consoleErrors: [] };
    const expectedWorkspaces = { [LOCAL_SERVER_ID]: null, [OFFLINE_SERVER_ID]: OFFLINE_CWD };
    const rpc = createRpcObserver(expectedWorkspaces);
    let projectPinReadinessStatus = null;
    let localDrawerInitialize = null;
    let offlineInitialize = null;
    let localRecoveryInitialize = null;
    let exportPhase;

    try {
      mobileWeb = await exportMobileWeb(context, {
        label: "mobile-offline-projects-export",
        outputName: "mobile-offline-projects-mobile-web",
        dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
        scratchBaseDirectory: "/tmp",
        deployMount: true,
        timeoutMs: 10 * 60_000,
        onProgress: (progress) => {
          const next = progress.phase ?? progress.event;
          if (next !== exportPhase) {
            console.log(`[mobile-offline-projects] ${next}`);
            exportPhase = next;
          }
        },
      });
      const mobileManifest = await buildGatewayMobileWebManifest(mobileWeb.path, {
        expectedFiles: mobileWeb.bundleFiles,
      });
      await writeGatewayMobileWebManifest(mobileWeb.path, mobileManifest);

      const localWorkspace = await materializeWorkspace(context, "minimal", {
        instanceId: "mobile-offline-projects-local-workspace",
      });
      expectedWorkspaces[LOCAL_SERVER_ID] = localWorkspace.path;
      const configDir = context.pathInState("config");
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await context.writeStateJson("config/settings.json", {});
      const credentialsPath = context.pathInState("config/credentials.json");
      await assert.rejects(access(credentialsPath), (error) => error?.code === "ENOENT",
        "the isolated Gateway config must not contain provider credentials");

      const serversFile = await context.writeStateJson("servers.json", [
        {
          id: LOCAL_SERVER_ID,
          label: LOCAL_PROJECT_LABEL,
          runtime: "kcoder",
          transport: "local",
          command: KCODER_BIN,
          workspace: localWorkspace.path,
        },
        {
          id: OFFLINE_SERVER_ID,
          label: OFFLINE_PROJECT_LABEL,
          runtime: "kcoder",
          transport: "ssh",
          host: OFFLINE_HOST,
          user: "fixture-user",
          port: 22,
          command: "kcoder",
          workspace: OFFLINE_CWD,
        },
      ]);
      const backend = await hashExecutable(KCODER_BIN);
      const serversSha256 = sha256(await readFile(serversFile));
      gateway = await startGateway(context, {
        auth: true,
        label: "mobile-offline-projects-gateway",
        workspace: localWorkspace.path,
        serversFile,
        kcoderBin: KCODER_BIN,
        env: {
          KCODER_CONFIG_DIR: configDir,
          KCODER_TRAINING_MODE: "true",
          KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path,
        },
      });

      const previousUmask = process.umask(0o077);
      let chromium;
      try {
        chromium = await startChromium(context, {
          label: "mobile-offline-projects-chromium",
          noSandbox: true,
          startTimeoutMs: 60_000,
        });
      } finally {
        process.umask(previousUmask);
      }
      page = await chromium.browser.contexts()[0].newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(({ key }) => {
        if (localStorage.getItem(key) === null) {
          localStorage.setItem(key, JSON.stringify({ language: "en", theme: "light" }));
        }
      }, { key: PREFERENCES_KEY });
      page.on("pageerror", (error) => diagnostics.pageErrors.push(error.name || "Error"));
      page.on("console", (message) => {
        if (message.type() === "error") diagnostics.consoleErrors.push("console error");
      });
      page.on("popup", (popup) => popups.push(popup.url().split("?")[0]));
      page.on("websocket", (socket) => rpc.observe(socket));
      page.on("response", (response) => observeGatewayStatusResponse(response, gateway.baseUrl, gatewayStatusSnapshots));

      stage = "welcome-manual-pairing";
      const welcome = await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      assert.equal(welcome?.status(), 200, "the isolated Gateway must serve the mounted Mobile Web Welcome screen");
      assert.equal(new URL(page.url()).pathname, "/mobile/",
        "the flow must begin at the real Mobile Web Welcome screen");
      await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
      await page.getByTestId("welcome-direct-connection").click();
      await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
      await page.getByTestId("gateway-token").fill(gateway.authToken);

      stage = "welcome-manual-pairing-session-exchange";
      const sessionResponsePromise = page.waitForResponse((response) => {
        let responseUrl;
        try {
          responseUrl = new URL(response.url());
        } catch {
          return false;
        }
        return responseUrl.origin === new URL(gateway.baseUrl).origin &&
          responseUrl.pathname === "/api/mobile/session" &&
          response.request().method() === "POST";
      }, { timeout: 30_000 });
      await page.getByTestId("gateway-connect").click();
      const sessionResponse = await sessionResponsePromise;
      assert.equal(sessionResponse.status(), 200,
        "the real Welcome manual pairing flow must exchange its token for an authenticated Mobile session");
      const sessionPayload = await sessionResponse.json();
      const mobileAccessToken = sessionPayload?.accessToken;
      const mobileRpcToken = sessionPayload?.rpcToken;
      assert.equal(typeof mobileAccessToken, "string",
        "the Mobile session response must contain its access token for authenticated RPC");
      assert.equal(typeof mobileRpcToken, "string",
        "the Mobile session response must contain its runtime RPC token");
      context.registerSecret(mobileAccessToken);
      context.registerSecret(mobileRpcToken);

      stage = "owned-empty-thread-task-sidebar-fixture";
      taskSidebarFixtureRpc = await openRpc(
        gatewayRpcUrl(gateway, LOCAL_SERVER_ID, mobileRpcToken),
        { headers: { Authorization: `Bearer ${mobileAccessToken}` } },
      );
      context.addCleanup("close owned TaskScreen sidebar fixture RPC", () =>
        closeRpcAndWait(taskSidebarFixtureRpc, "TaskScreen sidebar fixture RPC"));
      const fixtureInitialization = await initializeRpc(taskSidebarFixtureRpc, "mobile-offline-projects-task-sidebar");
      assert.equal(fixtureInitialization.capabilities?.experimental?.threadCreationReceiptsV1, true,
        "the real app-server must support stable creation receipts for the cross-connection empty-thread fixture");
      assert.equal(fixtureInitialization.capabilities?.experimental?.sidebarRootPinning, true,
        "the real local app-server must advertise the root-project pin contract used to normalize this owned fixture");
      const threadStartParams = { cwd: localWorkspace.path, clientRequestId: randomUUID() };
      const threadStart = await taskSidebarFixtureRpc.request("thread/start", threadStartParams);
      const threadId = threadStart.thread?.id;
      assert.equal(typeof threadId, "string", "the isolated Rust app-server must create an owned empty thread for TaskScreen");
      assert.ok(threadId.length > 0);
      const creationReceipt = await taskSidebarFixtureRpc.request("thread/creation/read", {
        clientRequestId: threadStartParams.clientRequestId,
      });
      assert.equal(creationReceipt.receipt?.status, "ready",
        "the real app-server must retain the stable empty-thread creation receipt");
      assert.equal(creationReceipt.receipt?.threadId, threadId,
        "the creation receipt must identify the owned empty thread");
      const titleUpdate = await taskSidebarFixtureRpc.request("thread/metadata/update", {
        threadId,
        title: TASK_SIDEBAR_TITLE,
      });
      assert.equal(titleUpdate.thread?.id, threadId,
        "the normal thread metadata update must acknowledge the owned TaskScreen fixture");
      assert.equal(titleUpdate.thread?.title, TASK_SIDEBAR_TITLE,
        "the real Rust app-server must acknowledge the long fixture title used for overflow verification");
      const emptyTranscript = await taskSidebarFixtureRpc.request("thread/read", { threadId, limit: 20 });
      assert.equal(emptyTranscript.thread?.id, threadId);
      assert.equal(emptyTranscript.thread?.title, TASK_SIDEBAR_TITLE);
      assert.deepEqual(emptyTranscript.messages, [], "TaskScreen fixture must contain no user or assistant messages");
      const residentThreads = await taskSidebarFixtureRpc.request("thread/list", { allowPartial: true });
      assert.ok(residentThreads.threads?.some((thread) => thread.id === threadId && thread.title === TASK_SIDEBAR_TITLE),
        "the real Rust app-server must expose the owned empty thread in its resident list");

      stage = "owned-multi-workspace-project-pin-fixture";
      const pinWorkspaceB = await materializeWorkspace(context, "minimal", {
        instanceId: "mobile-offline-projects-pin-workspace-b",
      });
      const pinWorkspacePaths = [localWorkspace.path, pinWorkspaceB.path];
      assert.equal(pinWorkspacePaths[0], localWorkspace.path,
        "the first registered project workspace must collide with the synthetic root at the same exact path");
      assert.equal(PIN_PROJECT_KEY, SYNTHETIC_ROOT_PROJECT_KEY,
        "the registered project key must collide with the synthetic runtime-target key used by the local root");
      assert.equal(new Set(pinWorkspacePaths).size, 2,
        "the same local sidebar project must contain two distinct owned workspace roots");
      const pinWorkspaceRegistrations = [];
      for (const workspacePath of pinWorkspacePaths) {
        const clientRequestId = randomUUID();
        const opened = await taskSidebarFixtureRpc.request("runtime.workspaces.open", {
          deviceId: LOCAL_SERVER_ID,
          runtime: "kcoder",
          workspacePath,
          label: PIN_PROJECT_LABEL,
          projectKey: PIN_PROJECT_KEY,
          clientRequestId,
        });
        assert.equal(opened.success, true,
          "the owned multi-workspace project must be registered by the real app-server workspace protocol");
        assert.equal(opened.accepted, true);
        assert.equal(opened.workspacePath, workspacePath);
        const receipt = await taskSidebarFixtureRpc.request("runtime.workspaces.operation/read", { clientRequestId });
        assert.equal(receipt.receipt?.status, "ready",
          "each owned workspace registration must have its real durable open receipt");
        assert.equal(receipt.receipt?.workspacePath, workspacePath);
        pinWorkspaceRegistrations.push({ clientRequestId, workspacePath, receiptStatus: receipt.receipt.status });
      }
      const beforePinNormalization = await readPinWorkspaceCatalog(taskSidebarFixtureRpc, LOCAL_SERVER_ID);
      projectPinSetupReads.push({ stage: "after-owned-registration", ...summarizePinWorkspaceCatalog(beforePinNormalization, PIN_PROJECT_KEY) });
      const beforePinProjectEntries = beforePinNormalization.items.filter((item) => item.projectKey === PIN_PROJECT_KEY);
      assert.equal(beforePinProjectEntries.length, 2,
        "the real workspace catalog must return both owned paths under the same project key");
      assert.deepEqual(new Set(beforePinProjectEntries.map((item) => item.workspacePath)), new Set(pinWorkspacePaths),
        "the real workspace catalog must resolve the exact two owned local paths");

      projectPinSetupRequests.push(await setPinThroughOwnedRpc(taskSidebarFixtureRpc, {
        deviceId: LOCAL_SERVER_ID,
        projectKey: localWorkspace.path,
        rootProject: true,
        pinned: false,
      }));
      projectPinSetupRequests.push(await setPinThroughOwnedRpc(taskSidebarFixtureRpc, {
        deviceId: LOCAL_SERVER_ID,
        projectKey: PIN_PROJECT_KEY,
        pinned: false,
      }));
      const normalizedPinCatalog = await readPinWorkspaceCatalog(taskSidebarFixtureRpc, LOCAL_SERVER_ID);
      projectPinSetupReads.push({ stage: "after-direct-unpinned-normalization", ...summarizePinWorkspaceCatalog(normalizedPinCatalog, PIN_PROJECT_KEY) });
      assert.equal(normalizedPinCatalog.rootProjectPinned, false,
        "the owned fixture root project must start unpinned independent of its fresh Gateway state");
      assertPinCatalogState(normalizedPinCatalog, PIN_PROJECT_KEY, pinWorkspacePaths, false);
      projectPinFixture = {
        projectKey: PIN_PROJECT_KEY,
        projectName: PIN_PROJECT_LABEL,
        workspacePaths: pinWorkspacePaths,
        sharesSyntheticRootPath: pinWorkspacePaths.includes(localWorkspace.path),
        syntheticRootProjectKey: SYNTHETIC_ROOT_PROJECT_KEY,
        projectGroupIndex: 0,
        workspaceIndices: [0, 1],
        registrations: pinWorkspaceRegistrations,
        initialRootProjectPinned: beforePinNormalization.rootProjectPinned,
        normalizedRootProjectPinned: normalizedPinCatalog.rootProjectPinned,
        normalizedWorkspacePins: normalizedPinCatalog.items.filter((item) => item.projectKey === PIN_PROJECT_KEY).map(({ workspacePath, projectPinned, projectPinnedOrder }) => ({
          workspacePath, projectPinned, projectPinnedOrder: projectPinnedOrder ?? null,
        })),
      };
      stage = "owned-empty-thread-and-multi-workspace-pin-fixtures-ready";
      taskSidebarFixture = {
        threadId,
        title: TASK_SIDEBAR_TITLE,
        workspacePath: localWorkspace.path,
        threadStartParams,
        creationReceiptStatus: creationReceipt.receipt.status,
        titleUpdateAcknowledged: true,
        residentThread: true,
        transcriptMessages: emptyTranscript.messages.length,
        turnsStarted: taskSidebarFixtureRpc.messages().filter((message) => message.method === "turn/started").length,
        serverProtocolVersion: fixtureInitialization.protocolVersion ?? null,
      };
      assert.equal(taskSidebarFixture.turnsStarted, 0,
        "the owned TaskScreen seed must remain an empty thread and must not start a model turn");
      await closeRpcAndWait(taskSidebarFixtureRpc, "TaskScreen sidebar fixture RPC after durable fixture verification");
      taskSidebarFixtureRpc = null;
      taskSidebarFixture.fixtureRpcClosedBeforeBrowserOpen = true;

      await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
      pairingComplete = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
      const profileId = profileIdFromUrl(page.url());
      const initialHome = new URL(page.url());
      assert.equal(initialHome.searchParams.has("provider"), false,
        "the paired Home route must not contain a special provider selector");
      await waitForProjectRows(page, "home");

      stage = "owned-local-project-pin-unpin-and-cross-connection-reconciliation";
      await assertRenderedPreferences(page, "en", "light");
      await setAppearanceFromHome(page, "en", "zh-CN", "light");
      const initialPinReadback = await readPinCatalogOnFreshAuthenticatedRpc(
        gateway, mobileRpcToken, mobileAccessToken, "mobile-offline-project-pin-initial-readback",
      );
      assert.equal(initialPinReadback.rootProjectPinned, projectPinFixture.normalizedRootProjectPinned,
        "the independently connected app-server must preserve the separately normalized synthetic root-project pin baseline");
      assertPinCatalogState(initialPinReadback, PIN_PROJECT_KEY, projectPinFixture.workspacePaths, false);
      projectPinSetupReads.push({ stage: "independent-connection-before-ui", ...summarizePinWorkspaceCatalog(initialPinReadback, PIN_PROJECT_KEY) });
      await assertHomeMultiWorkspacePinState(page, projectPinFixture, false);

      projectPinReadinessStatus = await waitForLocalOnlineGatewayStatus(gatewayStatusSnapshots);
      const pinMenu = await openHomeProjectPinMenu(page, projectPinFixture.workspaceIndices[0], false, "zh-CN");
      await captureScreenshot(page, context, screenshots,
        "home-multi-workspace-pin-menu-390-zh-cn-light.png",
        { width: 390, height: 844, language: "zh-CN", theme: "light" });
      const pinStartSequence = rpc.latestSequence();
      await pinMenu.button.click();
      const pinAck = await rpc.waitForProjectPinMutation(LOCAL_SERVER_ID, PIN_PROJECT_KEY, true, pinStartSequence);
      assert.equal(pinAck.workspacePath, localWorkspace.path,
        "the browser pin mutation must use the exact local target app-server workspace");
      assert.equal(pinAck.targetId, LOCAL_SERVER_ID,
        "the browser pin mutation must stay owned by the local target");
      assert.equal(pinAck.projectKey, SYNTHETIC_ROOT_PROJECT_KEY,
        "the browser pin ACK must preserve the colliding registry key");
      assert.equal(pinAck.rootProjectSpecified, false,
        "the browser registry pin request must omit the synthetic rootProject discriminator");
      assert.notEqual(pinAck.rootProject, true,
        "the browser registry pin request must never claim rootProject=true");
      await pinMenu.modal.waitFor({ state: "hidden", timeout: 20_000 });
      await assertHomeMultiWorkspacePinState(page, projectPinFixture, true);
      const pinnedStateReadback = await readPinCatalogOnFreshAuthenticatedRpc(
        gateway, mobileRpcToken, mobileAccessToken, "mobile-offline-project-pin-after-pin",
      );
      assert.equal(pinnedStateReadback.rootProjectPinned, projectPinFixture.normalizedRootProjectPinned,
        "pinning the same-key registered project must not mutate the separate synthetic root-project pin");
      assertPinCatalogState(pinnedStateReadback, PIN_PROJECT_KEY, projectPinFixture.workspacePaths, true);
      projectPinSetupReads.push({ stage: "independent-connection-after-ui-pin", ...summarizePinWorkspaceCatalog(pinnedStateReadback, PIN_PROJECT_KEY) });
      await captureScreenshot(page, context, screenshots,
        "home-multi-workspace-project-pinned-390-zh-cn-light.png",
        { width: 390, height: 844, language: "zh-CN", theme: "light" });

      await setAppearanceFromHome(page, "zh-CN", "zh-CN", "dark");
      await page.setViewportSize({ width: 320, height: 640 });
      await assertRenderedPreferences(page, "zh-CN", "dark");
      await assertHomeMultiWorkspacePinState(page, projectPinFixture, true);
      await captureScreenshot(page, context, screenshots,
        "home-multi-workspace-project-pinned-320-zh-cn-dark.png",
        { width: 320, height: 640, language: "zh-CN", theme: "dark" });
      await setAppearanceFromHome(page, "zh-CN", "zh-CN", "light");
      await page.setViewportSize({ width: 390, height: 844 });
      await assertRenderedPreferences(page, "zh-CN", "light");

      const unpinMenu = await openHomeProjectPinMenu(page, projectPinFixture.workspaceIndices[0], true, "zh-CN");
      const unpinStartSequence = rpc.latestSequence();
      await unpinMenu.button.click();
      const unpinAck = await rpc.waitForProjectPinMutation(LOCAL_SERVER_ID, PIN_PROJECT_KEY, false, unpinStartSequence);
      assert.equal(unpinAck.workspacePath, localWorkspace.path,
        "the browser unpin mutation must use the same exact local target workspace");
      assert.equal(unpinAck.targetId, LOCAL_SERVER_ID);
      assert.equal(unpinAck.projectKey, SYNTHETIC_ROOT_PROJECT_KEY,
        "the browser unpin ACK must preserve the colliding registry key");
      assert.equal(unpinAck.rootProjectSpecified, false,
        "the browser registry unpin request must omit the synthetic rootProject discriminator");
      assert.notEqual(unpinAck.rootProject, true,
        "the browser registry unpin request must never claim rootProject=true");
      await unpinMenu.modal.waitFor({ state: "hidden", timeout: 20_000 });
      await assertHomeMultiWorkspacePinState(page, projectPinFixture, false);
      const unpinnedStateReadback = await readPinCatalogOnFreshAuthenticatedRpc(
        gateway, mobileRpcToken, mobileAccessToken, "mobile-offline-project-pin-after-unpin",
      );
      assert.equal(unpinnedStateReadback.rootProjectPinned, projectPinFixture.normalizedRootProjectPinned,
        "unpinning the same-key registered project must preserve the synthetic root-project pin baseline");
      assertPinCatalogState(unpinnedStateReadback, PIN_PROJECT_KEY, projectPinFixture.workspacePaths, false);
      projectPinSetupReads.push({ stage: "independent-connection-after-ui-unpin", ...summarizePinWorkspaceCatalog(unpinnedStateReadback, PIN_PROJECT_KEY) });

      stage = "owned-project-rename-cancel-save-and-independent-readback";
      const projectRenameObservation = await renameOwnedProjectThroughHome({
        page,
        rpc,
        gateway,
        mobileRpcToken,
        mobileAccessToken,
        fixture: projectPinFixture,
        baselineCatalog: unpinnedStateReadback,
        context,
        screenshots,
        viewport: { width: 390, height: 844, language: "zh-CN", theme: "light" },
      });
      projectPinFixture.projectName = RENAMED_PROJECT_LABEL;
      projectRenameObservations.push(projectRenameObservation);
      await assertHomeMultiWorkspacePinState(page, projectPinFixture, false);

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
      await waitForProjectRows(page, "home");
      await assertHomeMultiWorkspacePinState(page, projectPinFixture, false);
      const persistedPinReadback = await readPinCatalogOnFreshAuthenticatedRpc(
        gateway, mobileRpcToken, mobileAccessToken, "mobile-offline-project-pin-after-home-reentry",
      );
      assert.equal(persistedPinReadback.rootProjectPinned, projectPinFixture.normalizedRootProjectPinned,
        "Home re-entry must preserve the synthetic root-project pin baseline");
      assertPinCatalogState(persistedPinReadback, PIN_PROJECT_KEY, projectPinFixture.workspacePaths, false);
      assertRenamedProjectCatalog(persistedPinReadback, projectPinFixture, RENAMED_PROJECT_LABEL, unpinnedStateReadback,
        "Home reload and re-entry");
      projectPinSetupReads.push({ stage: "independent-connection-after-home-reentry", ...summarizePinWorkspaceCatalog(persistedPinReadback, PIN_PROJECT_KEY) });

      stage = "home-thread-sibling-more-opens-actions-sheet-without-navigation";
      const homeThreadActions = await assertHomeThreadActions(page, {
        threadId: taskSidebarFixture.threadId,
        title: taskSidebarFixture.title,
        language: "zh-CN",
        context,
        screenshots,
        viewport: { width: 390, height: 844, language: "zh-CN", theme: "light" },
      });
      threadActionsObservations.push({ surface: "Home", ...homeThreadActions });

      stage = "normal-home-drawer-eight-layouts";
      let currentLanguage = await page.evaluate(() => document.documentElement.lang);
      for (const viewport of MATRIX) {
        await setAppearanceFromHome(page, currentLanguage, viewport.language, viewport.theme);
        currentLanguage = viewport.language;
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await assertRenderedPreferences(page, viewport.language, viewport.theme);
        await waitForProjectRows(page, "home");
        const homeThread = page.getByTestId(`thread-${taskSidebarFixture.threadId}`);
        await homeThread.waitFor({ state: "visible", timeout: 20_000 });
        await assertNoRightChevron(homeThread, "Home session row");
        await assertNoGitBranch(homeThread, "Home session row");
        const homeBadgeColors = await assertOrdinaryProjectControls(page, "home", localWorkspace.path,
          null, projectEllipsisObservations);
        await assertNoSpecialOfflineEntry(page);
        await assertNoHorizontalOverflow(page, `Home ${viewport.width}px ${viewport.language} ${viewport.theme}`);
        const suffix = `${viewport.width}-${localeSlug(viewport.language)}-${viewport.theme}`;
        await captureScreenshot(page, context, screenshots, `home-projects-${suffix}.png`, viewport);
        if (viewport === MATRIX[0] || viewport === MATRIX.at(-1)) {
          stage = `offline-sessions-${suffix}`;
          const sessionsStartSequence = rpc.latestSequence();
          await page.getByTestId("sessions").click();
          await page.getByTestId("session-search").waitFor({ state: "visible", timeout: 30_000 });
          const ownedSessionRow = page.getByTestId(`session-${taskSidebarFixture.threadId}`);
          await ownedSessionRow.waitFor({ state: "visible", timeout: 40_000 });
          assert.equal(await page.getByTestId("sessions-reload").count(), 0,
            "Sessions must not render the removed reload button");

          const offlineSessionRpcFailure = await rpc.waitForInitializeFailure(OFFLINE_SERVER_ID, sessionsStartSequence, 40_000);
          assert.equal(offlineSessionRpcFailure.workspacePath, OFFLINE_CWD,
            "the hidden Sessions copy must still correspond to a real failed SSH initialize for the configured offline cwd");
          assert.ok(["error-response", "socket-error", "socket-closed"].includes(offlineSessionRpcFailure.outcome),
            "the offline SSH failure must come from the observed app-server RPC response or socket lifecycle");
          await ownedSessionRow.waitFor({ state: "visible", timeout: 40_000 });
          await page.getByTestId("sessions-page-loading").waitFor({ state: "detached", timeout: 40_000 });

          const sessionsText = await page.locator("body").innerText();
          const removedWorkspaceCopyPrefixes = viewport.language === "en"
            ? [
                `Could not load sessions from ${OFFLINE_PROJECT_LABEL} · ${OFFLINE_CWD}:`,
                `Could not load projects for ${OFFLINE_PROJECT_LABEL}. Tried the default and previously registered directories:`,
              ]
            : [
                `无法读取 ${OFFLINE_PROJECT_LABEL} · ${OFFLINE_CWD} 的会话：`,
                `无法读取 ${OFFLINE_PROJECT_LABEL} 的项目列表；已尝试默认及此前登记的目录：`,
              ];
          for (const prefix of removedWorkspaceCopyPrefixes) {
            assert.equal(sessionsText.includes(prefix), false,
              `Sessions must hide the workspace error category starting with ${prefix}`);
          }
          const compactRow = await assertCompactHistorySessionRow(page, {
            threadId: taskSidebarFixture.threadId,
            title: taskSidebarFixture.title,
            localWorkspacePath: localWorkspace.path,
            language: viewport.language,
            theme: viewport.theme,
            gatewayStatusSnapshots,
          });
          const sessionsScreenshot = viewport === MATRIX[0]
            ? "sessions-offline-320-en-dark.png"
            : "sessions-offline-390-zh-cn-light.png";
          await captureScreenshot(page, context, screenshots, sessionsScreenshot, viewport);
          const sessionsRouteBeforeEntry = new URL(page.url());
          await page.getByTestId(`session-${taskSidebarFixture.threadId}`).click();
          await waitForTaskScreen(page, profileId, taskSidebarFixture.threadId, localWorkspace.path,
            taskSidebarFixture.title);
          const sessionRowRoute = new URL(page.url());
          await page.goBack();
          await page.getByTestId("session-search").waitFor({ state: "visible", timeout: 30_000 });
          await page.getByTestId(`session-${taskSidebarFixture.threadId}`).waitFor({ state: "visible", timeout: 30_000 });
          const sessionsRouteAfterEntry = new URL(page.url());
          assert.equal(sessionsRouteAfterEntry.pathname, sessionsRouteBeforeEntry.pathname,
            "the history row return must restore the exact real Sessions page");
          assert.equal(sessionsRouteAfterEntry.searchParams.get("profileId"), profileId,
            "the history row return must preserve the Welcome-paired profile");
          sessionsOfflineObservations.push({
            screenshot: sessionsScreenshot,
            language: viewport.language,
            theme: viewport.theme,
            width: viewport.width,
            ownedEmptyThreadVisible: true,
            compactRow,
            taskScreenRoute: {
              pathname: sessionRowRoute.pathname,
              profileId: sessionRowRoute.pathname.includes(`/h/${encodeURIComponent(profileId)}/`) ? profileId : null,
              serverId: LOCAL_SERVER_ID,
              threadId: taskSidebarFixture.threadId,
              cwd: sessionRowRoute.searchParams.get("cwd"),
              title: sessionRowRoute.searchParams.get("title"),
            },
            reloadControlAbsentAfterSettledRead: true,
            loadingIndicatorAbsent: true,
            offlineRpcFailure: offlineSessionRpcFailure,
            removedWorkspaceCopyPrefixesAbsent: removedWorkspaceCopyPrefixes.length,
          });

          await page.getByLabel(viewport.language === "en" ? "Back" : "返回", { exact: true }).click();
          await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 15_000 });
          await assertRenderedPreferences(page, viewport.language, viewport.theme);
          await waitForProjectRows(page, "home");
        }
        if (viewport === MATRIX[0]) await assertProjectToggleOnlyChangesExpansion(page, "home");

        await page.getByLabel(navigationLabel(viewport.language), { exact: true }).click();
        await page.getByTestId("mobile-drawer").waitFor({ state: "visible", timeout: 10_000 });
        await waitForProjectRows(page, "drawer");
        const drawerBadgeColors = await assertOrdinaryProjectControls(page, "drawer", localWorkspace.path,
          null, projectEllipsisObservations);
        assert.deepEqual(drawerBadgeColors, homeBadgeColors,
          `Home and Drawer must keep the same target badge colors at ${viewport.width}px ${viewport.language} ${viewport.theme}`);
        await assertNoSpecialOfflineEntry(page);
        await assertNoHorizontalOverflow(page, `Drawer ${viewport.width}px ${viewport.language} ${viewport.theme}`);
        await captureScreenshot(page, context, screenshots, `drawer-projects-${suffix}.png`, viewport);
        if (viewport === MATRIX[0]) await assertProjectToggleOnlyChangesExpansion(page, "drawer");

        if (viewport === MATRIX.at(-1)) {
          stage = "ordinary-drawer-local-project-plus-route";
          const localRouteStartSequence = rpc.latestSequence();
          await page.getByTestId(`drawer-new-workspace-${LOCAL_SERVER_ID}-0`).click();
          await assertProjectRoute(page, {
            profileId,
            serverId: LOCAL_SERVER_ID,
            cwd: localWorkspace.path,
            entry: "Drawer local project Plus",
          });
          await waitForDraft(page);
          await waitForStatus(page, true);
          localDrawerInitialize = await rpc.waitForInitializeSuccess(LOCAL_SERVER_ID, localRouteStartSequence);
          assert.equal(localDrawerInitialize.workspacePath, localWorkspace.path,
            "the Drawer Plus must initialize the configured local project cwd");
          await rpc.waitForMethodSuccess(LOCAL_SERVER_ID, "runtime.models.list", localRouteStartSequence);
          await assertNewDraftConnectionControls(page, { connected: true, hasMessage: false });
          await assertNoHorizontalOverflow(page, "local New Draft after Drawer project Plus");
          await captureScreenshot(page, context, screenshots, "new-local-from-drawer-390-zh-cn-light.png", viewport);
          await backToHome(page, viewport.language);
          await waitForProjectRows(page, "home");
        } else {
          await closeDrawerWithOuterScrim(page, page.getByTestId("mobile-drawer"), viewport.language);
        }
      }

      assert.equal(screenshots.filter((shot) => shot.name.startsWith("home-projects-")).length, 8,
        "all eight Home viewport/language/theme screenshots must be retained");
      assert.equal(screenshots.filter((shot) => shot.name.startsWith("drawer-projects-")).length, 8,
        "all eight Drawer viewport/language/theme screenshots must be retained");

      stage = "ordinary-home-offline-project-plus-route";
      const offlineHomePlus = page.getByTestId(`new-workspace-${OFFLINE_SERVER_ID}-0`);
      await offlineHomePlus.waitFor({ state: "visible", timeout: 15_000 });
      const offlineRouteStartSequence = rpc.latestSequence();
      await offlineHomePlus.click();
      await assertProjectRoute(page, {
        profileId,
        serverId: OFFLINE_SERVER_ID,
        cwd: OFFLINE_CWD,
        entry: "Home offline SSH project Plus",
      });
      await waitForDraft(page);

      stage = "real-ssh-initialize-failure-and-offline-ui";
      await waitForOfflineConnection(page, rpc, OFFLINE_SERVER_ID, offlineRouteStartSequence);
      offlineInitialize = rpc.initializeFailure(OFFLINE_SERVER_ID, offlineRouteStartSequence);
      assert.equal(offlineInitialize.workspacePath, OFFLINE_CWD,
        "the failed real SSH initialize must target the configured remote cwd");
      await assertNewDraftConnectionControls(page, { connected: false, hasMessage: false });
      assert.equal(await page.getByTestId("new-workspace-error").count(), 0,
        "the failed SSH app-server connection must not render the removed New Draft raw error text");
      assert.equal(await page.getByTestId("retry-new-workspace-catalogs").count(), 0,
        "catalog recovery must use the existing project-bar retry affordance, without a second retry button");
      const messageInput = page.getByTestId("message-input");
      await messageInput.fill(MESSAGE);
      assert.equal(await messageInput.inputValue(), MESSAGE,
        "the offline draft must accept unsent text before a target switch");
      const retry = page.getByTestId("new-task-gateway-retry");
      await retry.waitFor({ state: "visible", timeout: 10_000 });
      const expectedRetryLabel = currentLanguage === "en" ? "Retry connection" : "重试连接";
      assert.equal(await retry.getAttribute("aria-label"), expectedRetryLabel,
        "the retry affordance must be accessible in the selected locale");
      assert.equal(await retry.innerText(), "", "the retry control must remain icon-only");
      assert.equal(await retry.isEnabled(), true, "the retry icon must be enabled after the failed connection settles");
      await assertRetryAtContextBarRight(page);
      await assertNoHorizontalOverflow(page, "offline New Draft 390px zh-CN light");
      const finalViewport = { width: 390, height: 844, language: "zh-CN", theme: "light" };
      await captureScreenshot(page, context, screenshots, "new-offline-ssh-390-zh-cn-light.png", finalViewport);

      stage = "offline-project-picker-and-local-recovery";
      const projectSheet = await openProjectPicker(page);
      await projectSheet.getByTestId(projectOptionId(LOCAL_SERVER_ID, localWorkspace.path))
        .waitFor({ state: "visible", timeout: 15_000 });
      const offlineOption = projectSheet.getByTestId(projectOptionId(OFFLINE_SERVER_ID, OFFLINE_CWD));
      await offlineOption.waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await offlineOption.getAttribute("aria-pressed"), "true",
        "the unreachable project must remain selected in the ordinary project picker");
      await assertNoHorizontalOverflow(page, "offline project picker 390px zh-CN light");
      await captureScreenshot(page, context, screenshots, "offline-project-picker-390-zh-cn-light.png", finalViewport);
      const localRecoveryStartSequence = rpc.latestSequence();
      await projectSheet.getByTestId(projectOptionId(LOCAL_SERVER_ID, localWorkspace.path)).click();

      await waitForStatus(page, true);
      localRecoveryInitialize = await rpc.waitForInitializeSuccess(LOCAL_SERVER_ID, localRecoveryStartSequence);
      assert.equal(localRecoveryInitialize.workspacePath, localWorkspace.path,
        "switching projects must initialize the exact local cwd over its own RPC socket");
      const localModelCatalogAck = rpc.methodSuccess(LOCAL_SERVER_ID, "runtime.models.list");
      assert.ok(localModelCatalogAck,
        "the local target must have returned a real runtime.models.list ACK before its model selector is accepted");
      assert.equal(localModelCatalogAck.workspacePath, localWorkspace.path,
        "the real local model catalog ACK must belong to the configured local workspace");
      await waitFor(async () => {
        const modelEnabled = await page.getByTestId("draft-model-selector").isEnabled().catch(() => false);
        const sendEnabled = await page.getByTestId("send-message").isEnabled().catch(() => false);
        const permissionAvailable = await page.getByTestId("draft-permission-selector").count().catch(() => 0) > 0;
        return modelEnabled && sendEnabled && permissionAvailable;
      }, 15_000, "recovered local model, permission, and non-empty draft controls to become available", 50);
      await assertNewDraftConnectionControls(page, { connected: true, hasMessage: true });
      assert.equal(await messageInput.inputValue(), MESSAGE,
        "switching from the offline SSH project to local must preserve the unsent draft text");
      const recoveredPicker = await openProjectPicker(page);
      assert.equal(await recoveredPicker.getByTestId(projectOptionId(LOCAL_SERVER_ID, localWorkspace.path)).getAttribute("aria-pressed"), "true",
        "the ordinary project picker must show the local project as selected after recovery");
      assert.equal(await recoveredPicker.getByTestId(projectOptionId(OFFLINE_SERVER_ID, OFFLINE_CWD)).getAttribute("aria-pressed"), "false",
        "the offline project must no longer be selected after recovery");
      await recoveredPicker.getByTestId("draft-context-close").click();
      await recoveredPicker.waitFor({ state: "hidden", timeout: 10_000 });
      await assertNoHorizontalOverflow(page, "recovered local New Draft 390px zh-CN light");
      await captureScreenshot(page, context, screenshots, "new-local-recovered-390-zh-cn-light.png", finalViewport);

      await backToHome(page, "zh-CN");
      await waitForProjectRows(page, "home");
      const serverStatusSnapshot = await waitForExpectedGatewayServerStatus(gatewayStatusSnapshots);
      const settledHomeProjectHealth = await waitForProjectHealthRows(page, "home", "zh-CN", "light", localWorkspace.path, serverStatusSnapshot);
      await captureScreenshot(page, context, screenshots, "home-project-health-settled-390-zh-cn-light.png", finalViewport);
      const workspacePathMenu = await openWorkspacePathMenu(page, OFFLINE_SERVER_ID, OFFLINE_CWD,
        context, screenshots, finalViewport);
      await page.getByLabel(navigationLabel("zh-CN"), { exact: true }).click();
      await page.getByTestId("mobile-drawer").waitFor({ state: "visible", timeout: 10_000 });
      const settledDrawerProjectHealth = await waitForProjectHealthRows(page, "drawer", "zh-CN", "light", localWorkspace.path, serverStatusSnapshot);
      await captureScreenshot(page, context, screenshots, "drawer-project-health-settled-390-zh-cn-light.png", finalViewport);

      stage = "real-task-screen-inner-drawer-eight-layouts";
      const taskScreenHomeUrl = initialHome.href;
      const taskScreenUrl = buildTaskScreenUrl(taskScreenHomeUrl, profileId, LOCAL_SERVER_ID,
        taskSidebarFixture.threadId, localWorkspace.path);
      for (const viewport of MATRIX) {
        await page.goto(taskScreenHomeUrl, { waitUntil: "domcontentloaded" });
        await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
        const taskScreenCurrentLanguage = await page.evaluate(() => document.documentElement.lang);
        assert.ok(taskScreenCurrentLanguage === "en" || taskScreenCurrentLanguage === "zh-CN",
          `TaskScreen matrix must read a supported locale from the live Home document, got ${taskScreenCurrentLanguage}`);
        await setAppearanceFromHome(page, taskScreenCurrentLanguage, viewport.language, viewport.theme);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await assertRenderedPreferences(page, viewport.language, viewport.theme);
        await page.goto(taskScreenUrl, { waitUntil: "domcontentloaded" });
        await waitForTaskScreen(page, profileId, taskSidebarFixture.threadId, localWorkspace.path);
        await assertRenderedPreferences(page, viewport.language, viewport.theme);
        await page.getByLabel(taskListLabel(viewport.language), { exact: true }).click();
        const taskDrawer = page.getByTestId("mobile-drawer");
        await taskDrawer.waitFor({ state: "visible", timeout: 10_000 });
        const sidebarObservation = await assertTaskScreenInnerDrawer(page, {
          drawer: taskDrawer,
          profileId,
          threadId: taskSidebarFixture.threadId,
          localWorkspacePath: localWorkspace.path,
          language: viewport.language,
          theme: viewport.theme,
          apiSnapshot: serverStatusSnapshot,
          taskTitle: taskSidebarFixture.title,
          localProjectName: basename(localWorkspace.path),
          registeredProjectName: projectPinFixture.projectName,
          ellipsisObservations: projectEllipsisObservations,
        });
        taskScreenDrawerObservations.push({
          viewport: { width: viewport.width, height: viewport.height, language: viewport.language, theme: viewport.theme },
          ...sidebarObservation,
        });
        await assertNoHorizontalOverflow(page,
          `TaskScreen inner Drawer ${viewport.width}px ${viewport.language} ${viewport.theme}`);
        const suffix = `${viewport.width}-${localeSlug(viewport.language)}-${viewport.theme}`;
        await captureScreenshot(page, context, screenshots, `task-screen-drawer-${suffix}.png`, viewport);

        if (viewport === MATRIX.at(-1)) {
          stage = "task-screen-drawer-long-press-actions-sheet-and-preserved-row-entry";
          const drawerThreadActions = await assertDrawerLongPressThreadActions(page, {
            drawer: taskDrawer,
            threadId: taskSidebarFixture.threadId,
            title: taskSidebarFixture.title,
            language: viewport.language,
            context,
            screenshots,
            viewport,
          });
          threadActionsObservations.push({ surface: "TaskScreen Drawer", ...drawerThreadActions });
          taskDrawerRowEntry = await assertTaskDrawerRowEntry(page, viewport.language, profileId,
            taskSidebarFixture.threadId, taskSidebarFixture.title, localWorkspace.path, viewport.theme);
          await page.getByLabel(taskListLabel(viewport.language), { exact: true }).click();
          await taskDrawer.waitFor({ state: "visible", timeout: 10_000 });
          for (const serverId of [LOCAL_SERVER_ID, OFFLINE_SERVER_ID]) {
            const expectedPath = serverId === LOCAL_SERVER_ID ? localWorkspace.path : OFFLINE_CWD;
            await assertTaskDrawerWorkspaceMore(page, taskDrawer, serverId, expectedPath,
              context, screenshots, viewport, serverId === LOCAL_SERVER_ID);
          }
          await taskDrawer.getByTestId(`drawer-new-workspace-${LOCAL_SERVER_ID}-0`).click();
          await assertProjectRoute(page, {
            profileId,
            serverId: LOCAL_SERVER_ID,
            cwd: localWorkspace.path,
            entry: "TaskScreen inner Drawer local project Plus",
          });
          await waitForDraft(page);
          await page.goBack();
          await waitForTaskScreen(page, profileId, taskSidebarFixture.threadId, localWorkspace.path,
            taskSidebarFixture.title);
        }

        if (viewport !== MATRIX.at(-1)) {
          await closeDrawerWithOuterScrim(page, taskDrawer, viewport.language);
        }
      }
      const taskScreenMatrixScreenshots = screenshots.filter((shot) => MATRIX.some((viewport) =>
        shot.name === `task-screen-drawer-${viewport.width}-${localeSlug(viewport.language)}-${viewport.theme}.png`));
      assert.equal(taskScreenMatrixScreenshots.length, MATRIX.length,
        "all eight real TaskScreen inner Drawer viewport/language/theme screenshots must be retained");

      const mutationMethods = new Set(["thread/start", "turn/start", "attachment/save", "attachment/upload/start"]);
      const conversationMutations = rpc.requests.filter((request) => mutationMethods.has(request.method));
      assert.deepEqual(conversationMutations, [],
        "browser navigation, project listing, pin/unpin, failed initialization, retry, and recovery must not start a thread, turn, or attachment upload; the only thread is the owned empty setup fixture");
      const browserProjectPinRequests = rpc.projectPinRequests();
      assert.equal(PIN_PROJECT_KEY, SYNTHETIC_ROOT_PROJECT_KEY,
        "the E2E fixture must exercise a registry project key equal to the synthetic root-project key");
      assert.deepEqual(browserProjectPinRequests.map((request) => ({
        targetId: request.targetId,
        workspacePath: request.workspacePath,
        projectKey: request.projectKey,
        pinned: request.pinned,
        rootProjectSpecified: request.rootProjectSpecified,
        rootProject: request.rootProject,
      })), [
        { targetId: LOCAL_SERVER_ID, workspacePath: localWorkspace.path, projectKey: SYNTHETIC_ROOT_PROJECT_KEY, pinned: true, rootProjectSpecified: false, rootProject: null },
        { targetId: LOCAL_SERVER_ID, workspacePath: localWorkspace.path, projectKey: SYNTHETIC_ROOT_PROJECT_KEY, pinned: false, rootProjectSpecified: false, rootProject: null },
      ], "the browser must preserve the colliding registry key while omitting rootProject for both registry mutations");
      assert.equal(browserProjectPinRequests.some((request) => request.rootProject === true), false,
        "neither registry pin nor unpin may claim the synthetic root-project field");
      const browserProjectRenameRequests = rpc.projectRenameRequests();
      assert.equal(browserProjectRenameRequests.length, 1,
        "the saved project rename must dispatch exactly once; the canceled editor must dispatch none");
      assert.deepEqual(popups, [], "normal project Plus actions must not open popups");
      assert.deepEqual(diagnostics.pageErrors, [], "the Mobile Web flow must not emit page errors");
      assert.deepEqual(diagnostics.consoleErrors, [], "the Mobile Web flow must not emit browser console errors");

      const evidence = {
        source: {
          sourceTreeSha256: mobileWeb.sourceTreeSha256,
          buildInputTreeSha256: mobileWeb.buildInputTreeSha256,
          bundleSha256: mobileWeb.bundleSha256,
          bundleFileCount: mobileWeb.bundleFileCount,
          serversSha256,
          backendSha256: backend.sha256,
          backendBytes: backend.bytes,
        },
        pairing: { completedThroughWelcome: true, profileIdPresent: Boolean(profileId) },
        targets: {
          local: { id: LOCAL_SERVER_ID, workspacePath: localWorkspace.path, transport: "local" },
          offline: { id: OFFLINE_SERVER_ID, host: OFFLINE_HOST, workspacePath: OFFLINE_CWD, transport: "ssh" },
        },
        projectPinFixture: {
          projectKey: projectPinFixture.projectKey,
          syntheticRootProjectKey: projectPinFixture.syntheticRootProjectKey,
          sharesSyntheticRootPath: projectPinFixture.sharesSyntheticRootPath,
          projectGroupIndex: projectPinFixture.projectGroupIndex,
          workspaceIndices: projectPinFixture.workspaceIndices,
          initialProjectName: PIN_PROJECT_LABEL,
          projectName: projectPinFixture.projectName,
          workspacePaths: projectPinFixture.workspacePaths,
          registrations: projectPinFixture.registrations,
          initialRootProjectPinned: projectPinFixture.initialRootProjectPinned,
          normalizedRootProjectPinned: projectPinFixture.normalizedRootProjectPinned,
          normalizedWorkspacePins: projectPinFixture.normalizedWorkspacePins,
          directSetupPinRequests: projectPinSetupRequests,
          directAndIndependentReadCount: projectPinSetupReads.length,
          directAndIndependentReads: projectPinSetupReads,
          browserPinRequests: browserProjectPinRequests,
          browserPinAcknowledgements: [pinAck, unpinAck],
          persistedAfterHomeReentry: true,
          workspaceProjectNotDuplicatedAcrossSections: true,
        },
        projectRename: {
          fixtureKeyCollidesWithSyntheticRoot: projectPinFixture.projectKey === SYNTHETIC_ROOT_PROJECT_KEY,
          canceledRenameRequests: projectRenameObservation.canceledRenameRequests,
          acknowledgedRename: projectRenameObservation.acknowledgedRename,
          independentCatalogReadbacks: projectRenameObservation.independentCatalogReadbacks,
          persistedAfterHomeReentry: true,
          browserRequests: browserProjectRenameRequests,
          observations: projectRenameObservations,
        },
        threadActions: threadActionsObservations,
        projectPinReadinessStatus,
        screenshots,
        sessionsOfflineObservations,
        offlineInitializeFailure: offlineInitialize,
        localDrawerInitialize,
        localRecoveryInitialize,
        localModelCatalogAck,
        serverStatusSnapshot,
        settledHomeProjectHealth,
        settledDrawerProjectHealth,
        workspacePathMenu,
        taskSidebarFixture,
        taskScreenInnerDrawer: {
          route: "real TaskScreen route for an owned empty local thread",
          legacyLoadEntriesAbsentForTargets: [LOCAL_SERVER_ID, OFFLINE_SERVER_ID],
          currentThreadVisibleAndSelected: true,
          realProjectLabelsAndTaskTitleUseSingleLineEllipsis: true,
          projectChevronTracksExpandedState: true,
          taskRowIsClickableAndMoreRemainsAvailable: true,
          sessionEnteringChevronAbsent: true,
          taskDrawerMorePathsVerified: [localWorkspace.path, OFFLINE_CWD],
          localPlusRouteVerified: true,
          longPressActionsSheetVerified: threadActionsObservations.some((item) => item.surface === "TaskScreen Drawer"),
          rowEntry: taskDrawerRowEntry,
          projectEllipsisObservations,
          screenshotCount: taskScreenMatrixScreenshots.length,
          observations: taskScreenDrawerObservations,
        },
        browserConversationTurnAttachmentMutationRequests: conversationMutations.length,
        browserProjectRenameRequestCount: browserProjectRenameRequests.length,
        popupCount: popups.length,
        diagnostics,
        modelCalls: 0,
      };
      await context.writeArtifactJson("mobile-offline-projects-evidence.json", evidence);
      return {
        welcomePairing: true,
        ordinaryHomeAndDrawerProjectComponents: true,
        offlineSessionsWorkspaceErrorsHidden: true,
        exactProjectRoutes: true,
        realOfflineSshInitializeFailure: true,
        offlineSendModelPermissionDisabled: true,
        localRecoveryPreservedText: true,
        ownedMultiWorkspaceProjectPinUnpinAndPersistence: true,
        ownedCollisionProjectRenameAndPersistence: true,
        homeThreadMoreAndDrawerLongPressActionsSheet: true,
        taskScreenInnerDrawerLoadEntriesRemoved: true,
        taskScreenExistingThreadMoreAndPlusReachable: true,
        seededEmptyThreadOnly: true,
        screenshotCount: screenshots.length,
        modelCalls: 0,
      };
    } catch (error) {
      const projectPinReadiness = await collectProjectPinReadiness(page, gatewayStatusSnapshots).catch(() => null);
      await context.writeArtifactJson("failure-stage-evidence.json", {
        failedStage: stage,
        errorName: error instanceof Error ? error.name : "Error",
        error: context.redactText(error instanceof Error ? error.message : String(error)),
        pairingComplete,
        sourceTreeSha256: mobileWeb?.sourceTreeSha256 ?? null,
        bundleSha256: mobileWeb?.bundleSha256 ?? null,
        projectPinReadinessStatus,
        projectPinReadiness,
        rpc: rpc.evidence(),
        diagnostics,
        screenshots,
      }).catch(() => {});
      if (pairingComplete && page) {
        const failureScreenshot = context.pathInCase("system-chromium", "mobile-offline-projects", `failure-${slug(stage)}.png`);
        await mkdir(dirname(failureScreenshot), { recursive: true }).catch(() => {});
        await page.screenshot({ path: failureScreenshot, animations: "disabled" }).catch(() => {});
      }
      throw error;
    } finally {
      await page?.close().catch(() => {});
    }
  },
);

function createRpcObserver(expectedWorkspaces) {
  const requests = [];
  const responses = [];
  const socketEvents = [];
  let sequence = 0;
  let nextSocketIndex = 0;
  return {
    requests,
    observe(socket) {
      const socketPending = new Map();
      const socketIndex = ++nextSocketIndex;
      let serverId = null;
      let workspacePath = null;
      try {
        const parsed = new URL(socket.url());
        const candidate = parsed.searchParams.get("server");
        if ([LOCAL_SERVER_ID, OFFLINE_SERVER_ID].includes(candidate)) {
          serverId = candidate;
          const workspace = parsed.searchParams.get("workspace");
          workspacePath = workspace === expectedWorkspaces[serverId] ? workspace : "unexpected";
        }
      } catch { /* The socket URL is intentionally excluded from evidence. */ }
      socket.on("framesent", ({ payload }) => {
        let message;
        try { message = JSON.parse(payload); } catch { return; }
        if (typeof message.method !== "string") return;
        const request = {
          sequence: ++sequence,
          socketIndex,
          serverId,
          workspacePath,
          id: message.id,
          method: message.method,
          ...(message.method === "runtime.sidebar.projects.pin" ? {
            projectPin: {
              targetId: typeof message.params?.deviceId === "string" ? message.params.deviceId : null,
              projectKey: typeof message.params?.projectKey === "string" ? message.params.projectKey : null,
              pinned: typeof message.params?.pinned === "boolean" ? message.params.pinned : null,
              rootProjectSpecified: Object.hasOwn(message.params ?? {}, "rootProject"),
              rootProject: typeof message.params?.rootProject === "boolean" ? message.params.rootProject : null,
            },
          } : {}),
          ...(message.method === "runtime.workspaces.rename" ? {
            projectRename: {
              targetId: typeof message.params?.deviceId === "string" ? message.params.deviceId : null,
              projectKey: typeof message.params?.projectKey === "string" ? message.params.projectKey : null,
              workspacePath: typeof message.params?.workspacePath === "string" ? message.params.workspacePath : null,
              runtime: typeof message.params?.runtime === "string" ? message.params.runtime : null,
              name: typeof message.params?.name === "string" ? message.params.name : null,
              rootProjectSpecified: Object.hasOwn(message.params ?? {}, "rootProject"),
            },
          } : {}),
        };
        requests.push(request);
        socketPending.set(message.id, message.method);
      });
      socket.on("framereceived", ({ payload }) => {
        let message;
        try { message = JSON.parse(payload); } catch { return; }
        if (message.id === undefined) return;
        const method = socketPending.get(message.id) ?? null;
        responses.push({
          sequence: ++sequence,
          socketIndex,
          serverId,
          workspacePath,
          id: message.id,
          method,
          success: Boolean(message.result) && !message.error,
          error: Boolean(message.error),
          accepted: message.result?.accepted === true,
        });
        socketPending.delete(message.id);
      });
      socket.on("close", () => socketEvents.push({ sequence: ++sequence, socketIndex, serverId, event: "closed" }));
      socket.on("socketerror", () => socketEvents.push({ sequence: ++sequence, socketIndex, serverId, event: "error" }));
    },
    latestSequence() { return sequence; },
    async waitForInitializeFailure(serverId, afterSequence = 0, timeoutMs = 40_000) {
      return waitFor(() => this.initializeFailure(serverId, afterSequence), timeoutMs,
        `real initialize failure for target ${serverId}`, 50);
    },
    initializeFailure(serverId, afterSequence = 0) {
      const candidates = requests.filter((item) => item.sequence > afterSequence && item.serverId === serverId && item.method === "initialize");
      for (const request of candidates) {
        const response = responses.find((item) => item.socketIndex === request.socketIndex && item.id === request.id && item.method === "initialize");
        if (response?.error) return { requestSequence: request.sequence, responseSequence: response.sequence, outcome: "error-response", workspacePath: request.workspacePath };
        if (response) continue;
        const closed = socketEvents.find((item) => item.socketIndex === request.socketIndex && item.sequence > request.sequence);
        if (closed) return { requestSequence: request.sequence, responseSequence: null, outcome: `socket-${closed.event}`, workspacePath: request.workspacePath };
      }
      return null;
    },
    initializeSuccess(serverId, afterSequence = 0) {
      const candidates = requests.filter((item) => item.sequence > afterSequence && item.serverId === serverId && item.method === "initialize");
      for (const request of candidates) {
        const response = responses.find((item) => item.socketIndex === request.socketIndex && item.id === request.id && item.method === "initialize");
        if (response?.success) return { requestSequence: request.sequence, responseSequence: response.sequence, workspacePath: request.workspacePath };
      }
      return null;
    },
    async waitForInitializeSuccess(serverId, afterSequence = 0, timeoutMs = 30_000) {
      return waitFor(() => this.initializeSuccess(serverId, afterSequence), timeoutMs,
        `successful real initialize for target ${serverId}`, 50);
    },
    methodSuccess(serverId, method, afterSequence = 0) {
      const candidates = requests.filter((item) => item.sequence > afterSequence && item.serverId === serverId &&
        item.workspacePath === expectedWorkspaces[serverId] && item.method === method);
      for (const request of candidates) {
        const response = responses.find((item) => item.socketIndex === request.socketIndex && item.id === request.id && item.method === method);
        if (response?.success) return {
          requestSequence: request.sequence,
          responseSequence: response.sequence,
          workspacePath: request.workspacePath,
        };
      }
      return null;
    },
    async waitForMethodSuccess(serverId, method, afterSequence = 0, timeoutMs = 30_000) {
      return waitFor(() => this.methodSuccess(serverId, method, afterSequence), timeoutMs,
        `successful real ${method} for target ${serverId}`, 50);
    },
    projectPinMutation(serverId, projectKey, pinned, afterSequence = 0) {
      for (const request of requests) {
        if (request.sequence <= afterSequence || request.serverId !== serverId ||
            request.method !== "runtime.sidebar.projects.pin" ||
            request.projectPin?.projectKey !== projectKey || request.projectPin?.pinned !== pinned) continue;
        const response = responses.find((item) => item.socketIndex === request.socketIndex &&
          item.id === request.id && item.method === request.method);
        if (response?.success) return {
          requestSequence: request.sequence,
          responseSequence: response.sequence,
          targetId: request.projectPin.targetId,
          workspacePath: request.workspacePath,
          projectKey: request.projectPin.projectKey,
          pinned: request.projectPin.pinned,
          rootProjectSpecified: request.projectPin.rootProjectSpecified,
          rootProject: request.projectPin.rootProject,
          success: response.success,
        };
      }
      return null;
    },
    async waitForProjectPinMutation(serverId, projectKey, pinned, afterSequence = 0, timeoutMs = 30_000) {
      return waitFor(() => this.projectPinMutation(serverId, projectKey, pinned, afterSequence), timeoutMs,
        `acknowledged project pin=${pinned} for target ${serverId}`, 50);
    },
    projectPinRequests() {
      return requests.filter((item) => item.method === "runtime.sidebar.projects.pin").map((item) => ({
        targetId: item.projectPin?.targetId ?? null,
        serverId: item.serverId,
        workspacePath: item.workspacePath,
        projectKey: item.projectPin?.projectKey ?? null,
        pinned: item.projectPin?.pinned ?? null,
        rootProjectSpecified: item.projectPin?.rootProjectSpecified ?? false,
        rootProject: item.projectPin?.rootProject ?? null,
      }));
    },
    projectRenameMutation(serverId, { projectKey, workspacePath, name }, afterSequence = 0) {
      for (const request of requests) {
        if (request.sequence <= afterSequence || request.serverId !== serverId ||
            request.method !== "runtime.workspaces.rename" ||
            request.projectRename?.projectKey !== projectKey ||
            request.projectRename?.workspacePath !== workspacePath ||
            request.projectRename?.name !== name) continue;
        const response = responses.find((item) => item.socketIndex === request.socketIndex &&
          item.id === request.id && item.method === request.method);
        if (response?.success) return {
          requestSequence: request.sequence,
          responseSequence: response.sequence,
          serverId: request.serverId,
          socketWorkspacePath: request.workspacePath,
          targetId: request.projectRename.targetId,
          projectKey: request.projectRename.projectKey,
          workspacePath: request.projectRename.workspacePath,
          runtime: request.projectRename.runtime,
          name: request.projectRename.name,
          rootProjectSpecified: request.projectRename.rootProjectSpecified,
          success: response.success,
          accepted: response.accepted,
        };
      }
      return null;
    },
    async waitForProjectRenameMutation(serverId, params, afterSequence = 0, timeoutMs = 30_000) {
      return waitFor(() => this.projectRenameMutation(serverId, params, afterSequence), timeoutMs,
        `acknowledged project rename for target ${serverId}`, 50);
    },
    projectRenameRequests() {
      return requests.filter((item) => item.method === "runtime.workspaces.rename").map((item) => ({
        sequence: item.sequence,
        serverId: item.serverId,
        socketWorkspacePath: item.workspacePath,
        targetId: item.projectRename?.targetId ?? null,
        projectKey: item.projectRename?.projectKey ?? null,
        workspacePath: item.projectRename?.workspacePath ?? null,
        runtime: item.projectRename?.runtime ?? null,
        name: item.projectRename?.name ?? null,
        rootProjectSpecified: item.projectRename?.rootProjectSpecified ?? false,
      }));
    },
    evidence() {
      return {
        requests: requests.map(({ sequence: order, socketIndex, serverId, workspacePath, id, method, projectPin, projectRename }) => ({
          order, socketIndex, serverId, workspacePath, id, method,
          ...(projectPin ? { projectPin } : {}),
          ...(projectRename ? { projectRename } : {}),
        })),
        responses: responses.map(({ sequence: order, socketIndex, serverId, workspacePath, id, method, success, error, accepted }) => ({ order, socketIndex, serverId, workspacePath, id, method, success, error, accepted })),
        socketEvents,
      };
    },
  };
}

function observeGatewayStatusResponse(response, gatewayBaseUrl, snapshots) {
  let url;
  try {
    url = new URL(response.url());
  } catch {
    return;
  }
  if (url.origin !== new URL(gatewayBaseUrl).origin || url.pathname !== "/api/servers/status" ||
      response.request().method() !== "GET") return;

  const snapshot = {
    sequence: snapshots.length + 1,
    httpStatus: response.status(),
    parsed: false,
    statuses: {},
  };
  snapshots.push(snapshot);
  void response.json().then((payload) => {
    if (!payload || !Array.isArray(payload.statuses)) return;
    const statuses = {};
    for (const item of payload.statuses) {
      if (!item || typeof item.id !== "string" || ![LOCAL_SERVER_ID, OFFLINE_SERVER_ID].includes(item.id)) continue;
      if (!["online", "offline", "checking"].includes(item.status)) continue;
      statuses[item.id] = item.status;
    }
    snapshot.statuses = statuses;
    snapshot.parsed = true;
  }).catch(() => {
    snapshot.parsed = false;
  });
}

async function waitForExpectedGatewayServerStatus(snapshots) {
  let expectedSnapshot = null;
  await waitFor(() => {
    expectedSnapshot = [...snapshots].reverse().find((snapshot) => snapshot.httpStatus === 200 &&
      snapshot.parsed && snapshot.statuses[LOCAL_SERVER_ID] === "online" &&
      snapshot.statuses[OFFLINE_SERVER_ID] === "offline") ?? null;
    return Boolean(expectedSnapshot);
  }, 30_000, "real Gateway status API to report local online and unreachable SSH offline", 50);
  return {
    sequence: expectedSnapshot.sequence,
    httpStatus: expectedSnapshot.httpStatus,
    statuses: { ...expectedSnapshot.statuses },
  };
}

async function waitForLocalOnlineGatewayStatus(snapshots) {
  let onlineSnapshot = null;
  await waitFor(() => {
    const latest = snapshots.at(-1);
    onlineSnapshot = latest?.httpStatus === 200 && latest.parsed &&
      latest.statuses[LOCAL_SERVER_ID] === "online"
      ? {
          sequence: latest.sequence,
          httpStatus: latest.httpStatus,
          localStatus: latest.statuses[LOCAL_SERVER_ID],
        }
      : null;
    return Boolean(onlineSnapshot);
  }, 30_000, "real Gateway status API to report the local target online before project pinning", 50);
  return onlineSnapshot;
}

async function assertCompactHistorySessionRow(page, { threadId, title, localWorkspacePath, language, gatewayStatusSnapshots }) {
  const localStatus = await waitForLocalOnlineGatewayStatus(gatewayStatusSnapshots);
  const onlineLabel = language === "en" ? "Online" : "在线";
  const row = page.getByTestId(`session-row-${threadId}`);
  const main = page.getByTestId(`session-${threadId}`);
  const titleNode = page.getByTestId(`session-title-${threadId}`);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  await main.waitFor({ state: "visible" });
  assert.equal(await page.getByTestId(`session-actions-${threadId}`).count(), 0,
    "reference history rows reserve space for the title and summary instead of a More column");
  await waitFor(async () => {
    const label = await main.getAttribute("aria-label");
    return Boolean(label?.startsWith(`${title} ·`) && label.includes(localWorkspacePath) && label.endsWith(` · ${onlineLabel}`));
  }, 30_000, "the real history owner and online status to settle", 50);
  const mainText = (await main.innerText()).trim();
  assert.ok(mainText.includes(title), "the real title must remain readable beside its history summary");
  assert.equal(mainText.includes(localWorkspacePath), false, "the full cwd stays in the accessible name and actions");
  assert.equal(await main.getAttribute("role"), "button");
  assert.equal(await main.locator("svg").count(), 0, "online reference history rows add no leading or trailing glyphs");
  const height = (await row.boundingBox()).height;
  assert.ok(height >= 44 && height <= 112, "title and summary retain a bounded accessible row");
  const titleEllipsis = await assertSingleLineEllipsis(titleNode, title, "History session title");
  const expectedRoute = page.url();
  await main.click({ delay: 650 });
  const sheet = await openAndVerifyThreadActionsSheet(page, { title, language, expectedRoute });
  await sheet.dialog.getByTestId("thread-archive-action").waitFor({ state: "visible" });
  await closeThreadActionsSheet(page, { ...sheet, expectedRoute, language });
  return { gatewayLocalStatus: localStatus.localStatus, titleAndSummaryVisible: true, titleEllipsis,
    accessibleOwnerAndStatus: true, longPressAndArchiveActionAvailable: true, rowHeight: height };
}

async function collectProjectPinReadiness(page, snapshots) {
  const statusSnapshots = snapshots.slice(-12).map((snapshot) => ({
    sequence: snapshot.sequence,
    httpStatus: snapshot.httpStatus,
    parsed: snapshot.parsed,
    statuses: {
      [LOCAL_SERVER_ID]: snapshot.statuses[LOCAL_SERVER_ID] ?? null,
      [OFFLINE_SERVER_ID]: snapshot.statuses[OFFLINE_SERVER_ID] ?? null,
    },
  }));
  const ui = { targets: [], pinButton: null };
  if (!page || page.isClosed()) return { statusSnapshots, ui };
  for (const serverId of [LOCAL_SERVER_ID, OFFLINE_SERVER_ID]) {
    const toggle = page.getByTestId(`toggle-server-${serverId}`);
    const count = await toggle.count().catch(() => 0);
    const ariaLabel = count === 1 ? await toggle.getAttribute("aria-label").catch(() => null) : null;
    ui.targets.push({
      serverId,
      present: count === 1,
      announcedStatus: typeof ariaLabel === "string" ? ariaLabel.split(" · ").at(-1) ?? null : null,
    });
  }
  const pinButton = page.getByTestId(`pin-project-${LOCAL_SERVER_ID}-0`);
  const pinCount = await pinButton.count().catch(() => 0);
  ui.pinButton = {
    present: pinCount === 1,
    enabled: pinCount === 1 ? await pinButton.isEnabled().catch(() => false) : null,
    disabledAttribute: pinCount === 1 ? await pinButton.getAttribute("disabled").catch(() => null) : null,
  };
  return { statusSnapshots, ui };
}

async function openWorkspacePathMenu(page, serverId, expectedPath, context, screenshots, viewport) {
  const index = 0;
  const trigger = page.getByTestId(index === 0 ? `toggle-server-${serverId}` : `toggle-workspace-${serverId}-${index}`);
  await trigger.waitFor({ state: "visible", timeout: 15_000 });
  await waitFor(() => trigger.isEnabled(), 10_000, `workspace More action enabled for ${serverId}`, 50);
  await trigger.click({ delay: 650 });

  const modal = page.getByTestId(`workspace-actions-menu-${serverId}-${index}`);
  const dialog = modal.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await dialog.count(), 1,
    "the workspace More menu must use its scoped inner dialog rather than the native Modal wrapper");
  const path = dialog.getByTestId(`workspace-actions-path-${serverId}-${index}`);
  await path.waitFor({ state: "visible", timeout: 10_000 });
  const pathLayout = await path.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return {
      text: node.innerText.trim(),
      width: box.width,
      height: box.height,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    };
  });
  assert.equal(pathLayout.text, expectedPath,
    "the More menu must expose the exact complete workspace path");
  assert.ok(pathLayout.width > 0 && pathLayout.height > 0,
    "the exact workspace path must be visibly laid out in the More menu");
  assert.ok(pathLayout.scrollWidth <= pathLayout.clientWidth + 1 &&
    pathLayout.scrollHeight <= pathLayout.clientHeight + 1,
  "the complete workspace path must fit visibly without clipping inside the More menu");
  assert.equal(await dialog.getByTestId(`refresh-history-${serverId}-${index}`).isVisible(), true,
    "the More menu may show its existing history refresh action without invoking it");
  await captureScreenshot(page, context, screenshots, "home-project-more-path-390-zh-cn-light.png", viewport);

  await dialog.getByTestId(`workspace-actions-close-${serverId}-${index}`).click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return { serverId, workspacePath: pathLayout.text, fullPathVisible: true, refreshInvoked: false };
}

async function waitForProjectRows(page, location) {
  const prefix = location === "home" ? "home-workspace-row" : "drawer-workspace-row";
  for (const serverId of [LOCAL_SERVER_ID, OFFLINE_SERVER_ID]) {
    await page.getByTestId(`${prefix}-${serverId}-0`).waitFor({ state: "visible", timeout: 30_000 });
  }
}

async function readPinWorkspaceCatalog(rpc, deviceId) {
  const result = await rpc.request("runtime.workspaces.list", { deviceId });
  assert.equal(result.success, true, "the real app-server must return its workspace pin catalog");
  assert.equal(result.deviceId, deviceId);
  assert.equal(typeof result.rootProjectPinned, "boolean",
    "the real app-server must expose the root project's persisted pin state");
  assert.ok(Array.isArray(result.items), "the real app-server must return registered workspace rows");
  return {
    rootProjectPinned: result.rootProjectPinned,
    items: result.items.map((item) => ({
      workspacePath: item.workspacePath,
      projectKey: item.projectKey,
      projectName: item.projectName,
      label: item.label,
      projectPinned: item.projectPinned,
      projectPinnedOrder: item.projectPinnedOrder,
    })),
  };
}

async function setPinThroughOwnedRpc(rpc, { deviceId, projectKey, rootProject = false, pinned }) {
  const params = { deviceId, projectKey, pinned, ...(rootProject ? { rootProject: true } : {}) };
  const result = await rpc.request("runtime.sidebar.projects.pin", params);
  assert.equal(result.success, true, "the owned app-server must acknowledge the initial pin-state normalization");
  assert.equal(result.accepted, true);
  assert.equal(result.deviceId, deviceId);
  return { method: "runtime.sidebar.projects.pin", targetId: deviceId, projectKey, pinned, rootProject };
}

function summarizePinWorkspaceCatalog(catalog, projectKey) {
  const entries = catalog.items.filter((item) => item.projectKey === projectKey);
  return {
    rootProjectPinned: catalog.rootProjectPinned,
    projectKey,
    matchingWorkspaceCount: entries.length,
    workspaces: entries.map(({ workspacePath, projectPinned, projectPinnedOrder }) => ({
      workspacePath,
      projectPinned: typeof projectPinned === "boolean" ? projectPinned : null,
      projectPinnedOrder: Number.isSafeInteger(projectPinnedOrder) ? projectPinnedOrder : null,
    })),
  };
}

function assertPinCatalogState(catalog, projectKey, expectedPaths, pinned) {
  const entries = catalog.items.filter((item) => item.projectKey === projectKey);
  assert.equal(entries.length, expectedPaths.length,
    `the target-owned project ${projectKey} must retain exactly ${expectedPaths.length} registered workspace(s)`);
  assert.deepEqual(new Set(entries.map((item) => item.workspacePath)), new Set(expectedPaths),
    `the target-owned project ${projectKey} must keep its exact owned workspace paths`);
  for (const item of entries) {
    assert.equal(item.projectPinned, pinned,
      `the authoritative catalog must persist projectPinned=${pinned} for ${item.workspacePath}`);
    if (pinned) assert.ok(Number.isSafeInteger(item.projectPinnedOrder),
      `a pinned workspace must have a stable integer projectPinnedOrder: ${item.workspacePath}`);
    else assert.equal(item.projectPinnedOrder == null, true,
      `an unpinned workspace must clear projectPinnedOrder: ${item.workspacePath}`);
  }
}

function assertRenamedProjectCatalog(catalog, fixture, expectedName, baselineCatalog, label) {
  assert.equal(catalog.rootProjectPinned, baselineCatalog.rootProjectPinned,
    `${label} must preserve the independent synthetic root-project pin value`);
  const entries = catalog.items.filter((item) => item.projectKey === fixture.projectKey);
  const baselineEntries = baselineCatalog.items.filter((item) => item.projectKey === fixture.projectKey);
  assert.equal(entries.length, fixture.workspacePaths.length,
    `${label} must retain every registered workspace root with the collision projectKey`);
  assert.equal(baselineEntries.length, fixture.workspacePaths.length,
    "the rename baseline must include every registered same-key workspace root");
  for (const item of entries) {
    assert.ok(fixture.workspacePaths.includes(item.workspacePath),
      `${label} must not change a registered workspace path`);
    assert.equal(item.projectName, expectedName,
      `${label} must persist the renamed projectName on ${item.workspacePath}`);
    assert.equal(item.label, expectedName,
      `${label} must persist the renamed registry label on ${item.workspacePath}`);
  }
  const projectState = (items) => items.map((item) => ({
    workspacePath: item.workspacePath,
    projectKey: item.projectKey,
    projectPinned: item.projectPinned,
    projectPinnedOrder: item.projectPinnedOrder ?? null,
  })).sort((left, right) => left.workspacePath.localeCompare(right.workspacePath));
  assert.deepEqual(projectState(entries), projectState(baselineEntries),
    `${label} must preserve every registry key and pin/order value while changing only the display name`);
  assert.deepEqual(new Set(entries.map((item) => item.workspacePath)), new Set(fixture.workspacePaths),
    `${label} must independently return both exact owned paths under the unchanged collision key`);
}

async function readPinCatalogOnFreshAuthenticatedRpc(gateway, rpcToken, accessToken, name) {
  const rpc = await openRpc(gatewayRpcUrl(gateway, LOCAL_SERVER_ID, rpcToken), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  try {
    const initialized = await initializeRpc(rpc, name);
    assert.equal(initialized.capabilities?.experimental?.sidebarRootPinning, true,
      "the independent app-server connection must advertise the same root pin capability");
    return await readPinWorkspaceCatalog(rpc, LOCAL_SERVER_ID);
  } finally {
    await closeRpcAndWait(rpc, `${name} authenticated reconciliation RPC`);
  }
}

async function assertHomeMultiWorkspacePinState(page, fixture, pinned) {
  const projectGroupId = `home-project-group-local-${fixture.projectGroupIndex}`;
  const projectTitleId = `home-project-local-${fixture.projectGroupIndex}`;
  const expectedSectionId = pinned ? "home-pinned-projects" : "home-projects";
  const otherSectionId = pinned ? "home-projects" : "home-pinned-projects";
  const expectedSection = page.getByTestId(expectedSectionId);
  const expectedGroup = expectedSection.getByTestId(projectGroupId);
  const otherSection = page.getByTestId(otherSectionId);
  await waitFor(async () => await expectedGroup.count() === 1 && await otherSection.getByTestId(projectGroupId).count() === 0,
    20_000, `the complete two-workspace project group must move to ${expectedSectionId}`, 50);
  assert.equal(await page.getByTestId(projectGroupId).count(), 1,
    "the multi-workspace project group must never be duplicated across pinned and unpinned sections");
  assert.equal(await expectedGroup.getByTestId(projectTitleId).innerText(), fixture.projectName,
    "the grouped workspace rows must keep their shared real project name");
  const observedWorkspacePaths = [];
  for (const groupIndex of fixture.workspaceIndices) {
    const row = expectedGroup.getByTestId(`home-workspace-row-local-${groupIndex}`);
    await row.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await row.getByTestId(`workspace-actions-local-${groupIndex}`).count(), 0,
      "project menus use the project row long press without an extra icon column");
    const toggleId = groupIndex === 0
      ? `toggle-server-${LOCAL_SERVER_ID}`
      : `toggle-workspace-${LOCAL_SERVER_ID}-${groupIndex}`;
    const accessibleName = await row.getByTestId(toggleId).getAttribute("aria-label");
    const matchingPath = fixture.workspacePaths.find((path) => accessibleName?.includes(`· ${path} ·`));
    assert.ok(matchingPath,
      `the real project row ${groupIndex} must retain its owned path in the workspace toggle's accessible name`);
    observedWorkspacePaths.push(matchingPath);
  }
  assert.deepEqual(new Set(observedWorkspacePaths), new Set(fixture.workspacePaths),
    "the one pinned project group must preserve both exact target-owned workspace paths");
  if (fixture.sharesSyntheticRootPath) {
    assert.equal(await page.getByTestId("home-project-group-local-0").count(), 1,
      "the same-path registry entry must replace the synthetic root projection instead of duplicating the workspace row");
  } else {
    const rootGroup = page.getByTestId("home-projects").getByTestId("home-project-group-local-0");
    await rootGroup.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.getByTestId("home-project-group-local-0").count(), 1,
      "pinning a registered project must leave the separate local root project in its own unpinned group");
  }
  assert.equal(fixture.workspacePaths.length, 2);
}

async function openHomeProjectPinMenu(page, workspaceIndex, pinned, language) {
  const trigger = page.getByTestId(workspaceIndex === 0 ? `toggle-server-${LOCAL_SERVER_ID}` : `toggle-workspace-${LOCAL_SERVER_ID}-${workspaceIndex}`);
  await waitFor(() => trigger.isEnabled(), 20_000,
    "the owned local workspace More action to become authorized by the settled history read", 50);
  await trigger.click({ delay: 650 });
  const modal = page.getByTestId(`workspace-actions-menu-${LOCAL_SERVER_ID}-${workspaceIndex}`);
  const dialog = modal.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await dialog.count(), 1,
    "the pin action must be scoped to the real inner More dialog, not an outer RN Modal wrapper");
  const button = dialog.getByTestId(`pin-project-${LOCAL_SERVER_ID}-${workspaceIndex}`);
  await button.waitFor({ state: "visible", timeout: 10_000 });
  const actionLabel = pinned ? (language === "en" ? "Unpin project" : "取消置顶项目")
    : (language === "en" ? "Pin project" : "置顶项目");
  assert.equal(await button.getAttribute("aria-label"), `${actionLabel} ${PIN_PROJECT_LABEL}`,
    "the real project pin control must expose the exact localized project action label");
  await waitFor(() => button.isEnabled().catch(() => false), 15_000,
    "the real local project pin action to become enabled after the Gateway status API reports online", 50);
  assert.equal(await button.isEnabled(), true, "the connected local project pin action must be enabled");
  return { modal, dialog, button };
}

async function renameOwnedProjectThroughHome({
  page,
  rpc,
  gateway,
  mobileRpcToken,
  mobileAccessToken,
  fixture,
  baselineCatalog,
  context,
  screenshots,
  viewport,
}) {
  const workspaceIndex = fixture.workspaceIndices[0];
  const routeBefore = page.url();
  const trigger = page.getByTestId(workspaceIndex === 0 ? `toggle-server-${LOCAL_SERVER_ID}` : `toggle-workspace-${LOCAL_SERVER_ID}-${workspaceIndex}`);
  await waitFor(() => trigger.isEnabled().catch(() => false), 20_000,
    "the owned local workspace More action to become available for project rename", 50);
  await trigger.click({ delay: 650 });
  const modal = page.getByTestId(`workspace-actions-menu-${LOCAL_SERVER_ID}-${workspaceIndex}`);
  const dialog = modal.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await dialog.count(), 1,
    "the project rename action must be scoped to the inner WorkspaceHistoryActionsSheet dialog");
  const path = dialog.getByTestId(`workspace-actions-path-${LOCAL_SERVER_ID}-${workspaceIndex}`);
  assert.equal((await path.innerText()).trim(), fixture.workspacePaths[0],
    "the rename menu must stay attached to the exact first owned workspace path");

  const renameAction = dialog.getByTestId(`rename-project-${LOCAL_SERVER_ID}-${workspaceIndex}`);
  await renameAction.waitFor({ state: "visible", timeout: 10_000 });
  await waitFor(() => renameAction.isEnabled().catch(() => false), 15_000,
    "the registered local project rename action to become enabled under the online target owner", 50);
  const requestCountBeforeCancel = rpc.projectRenameRequests().length;
  const cancelStartSequence = rpc.latestSequence();
  await renameAction.click();
  const editor = dialog.getByTestId(`rename-project-editor-${LOCAL_SERVER_ID}-${workspaceIndex}`);
  const nameInput = dialog.getByTestId(`rename-project-name-${LOCAL_SERVER_ID}-${workspaceIndex}`);
  await editor.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await nameInput.inputValue(), fixture.projectName,
    "the rename editor must start with the exact currently registered project name");
  await nameInput.fill("Canceled Owned Project Rename");
  await captureScreenshot(page, context, screenshots,
    "home-project-rename-editor-390-zh-cn-light.png", viewport);
  await dialog.getByTestId(`rename-project-cancel-${LOCAL_SERVER_ID}-${workspaceIndex}`).click();
  await editor.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(rpc.projectRenameRequests().length, requestCountBeforeCancel,
    "canceling the local project rename editor must emit zero runtime.workspaces.rename requests");
  assert.equal(rpc.projectRenameRequests().filter((request) => request.sequence > cancelStartSequence).length, 0,
    "the canceled rename must not dispatch late after the editor closes");
  assert.equal(page.url(), routeBefore,
    "opening and canceling the project rename editor must not navigate away from Home");

  await renameAction.waitFor({ state: "visible", timeout: 10_000 });
  await renameAction.click();
  await editor.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await nameInput.inputValue(), fixture.projectName,
    "reopening the project rename editor must restore the unchanged persisted project name");
  await nameInput.fill(RENAMED_PROJECT_LABEL);
  const saveStartSequence = rpc.latestSequence();
  const requestCountBeforeSave = rpc.projectRenameRequests().length;
  await dialog.getByTestId(`rename-project-save-${LOCAL_SERVER_ID}-${workspaceIndex}`).click();
  const acknowledgedRename = await rpc.waitForProjectRenameMutation(LOCAL_SERVER_ID, {
    projectKey: fixture.projectKey,
    workspacePath: fixture.workspacePaths[0],
    name: RENAMED_PROJECT_LABEL,
  }, saveStartSequence);
  assert.equal(acknowledgedRename.targetId, LOCAL_SERVER_ID,
    "the rename RPC must use the local server as its target identity");
  assert.equal(acknowledgedRename.serverId, LOCAL_SERVER_ID,
    "the rename RPC socket must remain owned by the local target");
  assert.equal(acknowledgedRename.socketWorkspacePath, fixture.workspacePaths[0],
    "the rename RPC must be sent through the exact selected local workspace owner");
  assert.equal(acknowledgedRename.workspacePath, fixture.workspacePaths[0],
    "the rename RPC payload must preserve the exact selected workspace path");
  assert.equal(acknowledgedRename.projectKey, SYNTHETIC_ROOT_PROJECT_KEY,
    "the rename RPC must preserve the registered key that collides with the synthetic root key");
  assert.equal(acknowledgedRename.runtime, "kcoder");
  assert.equal(acknowledgedRename.name, RENAMED_PROJECT_LABEL);
  assert.equal(acknowledgedRename.rootProjectSpecified, false,
    "the registered project rename must not claim the synthetic rootProject discriminator");
  assert.equal(acknowledgedRename.success, true);
  assert.equal(acknowledgedRename.accepted, true,
    "the same-owner runtime.workspaces.rename response must contain its real accepted receipt");
  await modal.waitFor({ state: "hidden", timeout: 30_000 });
  const savedRequests = rpc.projectRenameRequests().filter((request) => request.sequence > saveStartSequence);
  assert.equal(savedRequests.length, 1,
    "one Save action must produce exactly one runtime.workspaces.rename request, with no blind replay");
  assert.equal(rpc.projectRenameRequests().length, requestCountBeforeSave + 1,
    "the full UI flow must contain only the one acknowledged project rename write");
  assert.equal(page.url(), routeBefore,
    "saving a project display name must keep the user on the same Home route");

  const afterSaveCatalog = await readPinCatalogOnFreshAuthenticatedRpc(
    gateway, mobileRpcToken, mobileAccessToken, "mobile-offline-project-rename-independent-readback",
  );
  assertRenamedProjectCatalog(afterSaveCatalog, fixture, RENAMED_PROJECT_LABEL, baselineCatalog,
    "independent authenticated catalog read after rename");
  await captureScreenshot(page, context, screenshots,
    "home-project-renamed-390-zh-cn-light.png", viewport);
  return {
    canceledRenameRequests: 0,
    acknowledgedRename,
    independentCatalogReadbacks: [
      summarizePinWorkspaceCatalog(afterSaveCatalog, fixture.projectKey),
    ],
    sameOwnerAndPathVerified: true,
    sameCollisionKeyVerified: true,
    registryPathsAndPinStateUnchanged: true,
  };
}

async function closeDrawerWithOuterScrim(page, drawer, language) {
  const closeLabel = closeNavigationLabel(language);
  const scrim = page.getByLabel(closeLabel, { exact: true });
  assert.equal(await scrim.count(), 1,
    "the outer scrim must be the only remaining exact close-navigation control");
  assert.equal(await drawer.getByLabel(closeLabel, { exact: true }).count(), 0,
    "the Drawer itself must not render the removed top close button");
  await scrim.waitFor({ state: "visible", timeout: 10_000 });

  const viewport = page.viewportSize();
  const scrimBounds = await scrim.boundingBox();
  const drawerBounds = await drawer.boundingBox();
  assert.ok(viewport && scrimBounds && drawerBounds,
    "the visible outer scrim, Drawer and viewport must have measurable bounds");

  const viewportPoint = { x: viewport.width - 4, y: viewport.height / 2 };
  const scrimPoint = {
    x: viewportPoint.x - scrimBounds.x,
    y: viewportPoint.y - scrimBounds.y,
  };
  assert.ok(scrimPoint.x >= 0 && scrimPoint.x < scrimBounds.width &&
    scrimPoint.y >= 0 && scrimPoint.y < scrimBounds.height,
  "the right-edge dismissal point must fall inside the full-screen scrim bounds");
  const pointCoveredByDrawer = viewportPoint.x >= drawerBounds.x &&
    viewportPoint.x < drawerBounds.x + drawerBounds.width &&
    viewportPoint.y >= drawerBounds.y &&
    viewportPoint.y < drawerBounds.y + drawerBounds.height;
  assert.equal(pointCoveredByDrawer, false,
    "the right-edge scrim click point must remain outside the open Drawer");

  await scrim.click({ position: scrimPoint });
  await drawer.waitFor({ state: "hidden", timeout: 10_000 });
}

async function assertDrawerChromeAndProjectHeading(drawer, language) {
  const removedLabels = language === "en"
    ? ["New conversation", "History", "Close navigation", "Home", "Help", "Settings"]
    : ["新建对话", "历史", "关闭导航", "主页", "帮助", "设置"];
  for (const label of removedLabels) {
    assert.equal(await drawer.getByLabel(label, { exact: true }).count(), 0,
      `the Drawer must not render the removed ${label} action`);
  }
  assert.equal(await drawer.getByTestId("drawer-gateway-status").count(), 0,
    "the Drawer must not render the removed Gateway status row");
  const sectionTitle = language === "en" ? "Projects" : "项目";
  assert.ok(await drawer.getByText(sectionTitle, { exact: true }).count() > 0,
    `the Drawer project group must use its ${sectionTitle} section title`);
}

async function assertOrdinaryProjectControls(page, location, localWorkspacePath, geometryResults = null, ellipsisObservations = null,
  localDisplayName = basename(localWorkspacePath)) {
  const prefix = location === "home" ? "home-workspace-row" : "drawer-workspace-row";
  const plusPrefix = location === "home" ? "new-workspace" : "drawer-new-workspace";
  const togglePrefix = location === "home" ? "toggle-server" : "drawer-toggle-server";
  const namePrefix = location === "home" ? "home-workspace-name" : "drawer-workspace-name";
  const badgePrefix = location === "home" ? "home-target-badge" : "drawer-target-badge";
  const statusPrefix = location === "home" ? "home-target-status" : "drawer-target-status";
  const controls = [];
  const toggles = [];
  const badgeColors = {};
  const language = await page.evaluate(() => document.documentElement.lang);
  if (location === "drawer") {
    const addProjectLabel = language === "en" ? "Add project" : "添加项目";
    const drawer = page.getByTestId("mobile-drawer");
    await assertDrawerChromeAndProjectHeading(drawer, language);
    assert.equal(await drawer.getByText(addProjectLabel, { exact: true }).count(), 0,
      `the Drawer must not render its removed ${addProjectLabel} action`);
  }
  for (const serverId of [LOCAL_SERVER_ID, OFFLINE_SERVER_ID]) {
    const row = page.getByTestId(`${prefix}-${serverId}-0`);
    await row.waitFor({ state: "visible", timeout: 15_000 });
    const expectedPath = serverId === LOCAL_SERVER_ID ? localWorkspacePath : OFFLINE_CWD;
    const expectedName = serverId === LOCAL_SERVER_ID ? localDisplayName : OFFLINE_PROJECT_LABEL;
    const visibleRowText = await row.innerText();
    const projectName = page.getByTestId(`${namePrefix}-${serverId}-0`);
    assert.equal(await projectName.innerText(), expectedName,
      `${location} project row ${serverId} must keep its readable workspace name`);
    const ellipsis = await assertSingleLineEllipsis(projectName, expectedName,
      `${location} ${serverId} project name`);
    ellipsisObservations?.push({ location, serverId, ...ellipsis });
    assert.equal(visibleRowText.includes(expectedPath), false,
      `${location} project row ${serverId} must keep the full path in its More menu`);
    const targetPrefix = serverId === LOCAL_SERVER_ID
      ? language === "en" ? "Local ·" : "本机 ·"
      : "SSH ·";
    assert.equal(visibleRowText.includes(targetPrefix), false,
      `${location} project row ${serverId} must not show target detail text inline`);
    assert.equal(visibleRowText.includes(OFFLINE_HOST), false,
      `${location} project row ${serverId} must not show target host text inline`);
    for (const statusLabel of ["Online", "Offline", "Checking", "Unknown", "在线", "离线", "检查中", "未知"]) {
      assert.equal(visibleRowText.includes(statusLabel), false,
        `${location} project row ${serverId} must not show textual connection status inline`);
    }
    assert.equal(await page.getByTestId(`${statusPrefix}-${serverId}-0`).count(), 0,
      `${location} ${serverId} folder badge must not contain a separate connection status dot`);

    const badge = page.getByTestId(`${badgePrefix}-${serverId}-0`);
    await badge.waitFor({ state: "visible", timeout: 15_000 });
    const badgeInfo = await badge.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        color: getComputedStyle(node).backgroundColor,
        width: box.width,
        height: box.height,
      };
    });
    assert.ok(badgeInfo.width >= 8 && badgeInfo.height >= 8,
      `${location} ${serverId} workspace folder must include its colored target badge`);
    assert.ok(badgeInfo.color && badgeInfo.color !== "rgba(0, 0, 0, 0)" && badgeInfo.color !== "transparent",
      `${location} ${serverId} target badge must have an actual color`);
    badgeColors[serverId] = badgeInfo.color;
    const geometry = await assertWorkspaceFolderBadgeLayout(page, location, serverId);
    if (geometryResults) geometryResults[serverId] = geometry;

    const plus = page.getByTestId(`${plusPrefix}-${serverId}-0`);
    await plus.waitFor({ state: "visible", timeout: 15_000 });
    await waitFor(() => plus.isEnabled(), 15_000, `${location} project Plus enabled for ${serverId}`, 50);
    const details = await plus.evaluate((node) => ({
      tag: node.tagName,
      role: node.getAttribute("role"),
      href: node.getAttribute("href"),
      target: node.getAttribute("target"),
    }));
    assert.equal(details.role, "button", `${location} ${serverId} project Plus must be an ordinary accessible button`);
    assert.notEqual(details.tag, "A", `${location} ${serverId} project Plus must not be a special Link`);
    assert.equal(details.href, null, `${location} ${serverId} project Plus must not carry a navigation href`);
    assert.equal(details.target, null, `${location} ${serverId} project Plus must not use target=_blank`);
    controls.push(details);

    const toggle = page.getByTestId(`${togglePrefix}-${serverId}`);
    await toggle.waitFor({ state: "visible", timeout: 15_000 });
    await assertProjectChevronDirection(page, location, serverId,
      await toggle.getAttribute("aria-expanded"));
    const toggleDetails = await toggle.evaluate((node) => ({
      tag: node.tagName,
      role: node.getAttribute("role"),
      href: node.getAttribute("href"),
      target: node.getAttribute("target"),
    }));
    assert.equal(toggleDetails.role, "button", `${location} ${serverId} project toggle must be an ordinary accessible button`);
    assert.notEqual(toggleDetails.tag, "A", `${location} ${serverId} project toggle must not be a special Link`);
    assert.equal(toggleDetails.href, null, `${location} ${serverId} project toggle must not carry a navigation href`);
    assert.equal(toggleDetails.target, null, `${location} ${serverId} project toggle must not use target=_blank`);
    toggles.push(toggleDetails);
  }
  assert.equal(controls[0].tag, controls[1].tag,
    `${location} local and SSH projects must render the same ordinary project Plus element`);
  assert.equal(toggles[0].tag, toggles[1].tag,
    `${location} local and SSH projects must render the same ordinary project toggle element`);
  assert.notEqual(badgeColors[LOCAL_SERVER_ID], badgeColors[OFFLINE_SERVER_ID],
    `${location} local and SSH workspace badges must use distinct target colors`);
  return badgeColors;
}

async function assertNoSpecialOfflineEntry(page) {
  assert.equal(await page.locator('[data-testid="home-unreachable-project"], [data-testid="drawer-unreachable-project"], [data-testid="unreachable-gateway-preview"]').count(), 0,
    "ordinary project lists must not render a special unreachable-project or preview entry");
  assert.equal(await page.locator('a[href*="gatewayPreview"], a[href*="gateway-preview"], a[href*="offline-preview"]').count(), 0,
    "project lists must not expose preview-specific links or query routes");
}

async function assertProjectToggleOnlyChangesExpansion(page, location) {
  const togglePrefix = location === "home" ? "toggle-server" : "drawer-toggle-server";
  const chevronPrefix = location === "home" ? "home-workspace-chevron" : "drawer-workspace-chevron";
  const toggle = page.getByTestId(`${togglePrefix}-${OFFLINE_SERVER_ID}`);
  const chevron = page.getByTestId(`${chevronPrefix}-${OFFLINE_SERVER_ID}-0`);
  const routeBefore = page.url();
  const initialExpanded = await toggle.getAttribute("aria-expanded");
  assert.ok(initialExpanded === "true" || initialExpanded === "false",
    "the ordinary offline project toggle must expose its expanded state");
  const initialDirection = await readChevronDirection(chevron);
  assert.equal(initialDirection, initialExpanded === "true" ? "down" : "right",
    `${location} project chevron must match its initial expanded state`);
  await toggle.click();
  await waitFor(async () => (await toggle.getAttribute("aria-expanded")) !== initialExpanded,
    10_000, "offline project expansion state to change", 50);
  const collapsedDirection = await readChevronDirection(chevron);
  assert.equal(collapsedDirection, initialExpanded === "true" ? "right" : "down",
    `${location} project chevron must turn right when collapsed and down when expanded`);
  assert.equal(page.url(), routeBefore, "toggling the offline project must not navigate to a special preview route");
  await toggle.click();
  await waitFor(async () => (await toggle.getAttribute("aria-expanded")) === initialExpanded,
    10_000, "offline project expansion state to restore", 50);
  assert.equal(await readChevronDirection(chevron), initialDirection,
    `${location} project chevron must restore its original direction with the expanded state`);
  assert.equal(page.url(), routeBefore, "restoring the offline project expansion must keep the ordinary Home route");
}

async function setAppearanceFromHome(page, currentLanguage, targetLanguage, theme) {
  await page.getByLabel(currentLanguage === "en" ? "Settings" : "设置", { exact: true }).click();
  const settings = page.getByTestId("settings-home");
  await settings.waitFor({ state: "visible", timeout: 15_000 });
  await settings.getByTestId("settings-appearance").click();
  const appearance = page.getByTestId("settings-appearance-screen");
  await appearance.waitFor({ state: "visible", timeout: 15_000 });

  await appearance.getByTestId("settings-theme-row").click();
  const themeSheet = page.getByTestId("settings-choice-sheet-theme").locator('[role="dialog"]');
  await themeSheet.waitFor({ state: "visible", timeout: 10_000 });
  await themeSheet.getByTestId(`settings-theme-choice-${theme}`).click();
  await themeSheet.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForFunction((expected) => document.documentElement.style.colorScheme === expected, theme,
    { timeout: 10_000 });

  await appearance.getByTestId("settings-language-row").click();
  const languageSheet = page.getByTestId("settings-choice-sheet-language").locator('[role="dialog"]');
  await languageSheet.waitFor({ state: "visible", timeout: 10_000 });
  const languageOption = targetLanguage === "en" ? "settings-language-choice-en" : "settings-language-choice-zh-cn";
  await languageSheet.getByTestId(languageOption).click();
  await languageSheet.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForFunction((expected) => document.documentElement.lang === expected,
    targetLanguage === "en" ? "en" : "zh-CN", { timeout: 10_000 });

  await appearance.getByTestId("settings-detail-back").click();
  await settings.waitFor({ state: "visible", timeout: 15_000 });
  await settings.getByTestId("settings-detail-back").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 15_000 });
  await assertRenderedPreferences(page, targetLanguage, theme);
}

async function assertRenderedPreferences(page, language, theme) {
  await page.waitForFunction(({ expectedLanguage, expectedTheme }) =>
    document.documentElement.lang === expectedLanguage &&
      document.documentElement.style.colorScheme === expectedTheme,
  { expectedLanguage: language === "en" ? "en" : "zh-CN", expectedTheme: theme }, { timeout: 10_000 });
}

async function assertProjectRoute(page, { profileId, serverId, cwd, entry }) {
  await waitForDraft(page);
  const route = new URL(page.url());
  assert.ok(route.pathname.endsWith("/new"), `${entry} must use the ordinary /new route`);
  assert.equal(route.searchParams.get("profileId"), profileId, `${entry} must preserve the exact paired profile`);
  assert.equal(route.searchParams.get("serverId"), serverId, `${entry} must preserve the exact server id`);
  assert.equal(route.searchParams.get("cwd"), cwd, `${entry} must preserve the exact project cwd`);
  assert.deepEqual([...route.searchParams.keys()].sort(), ["cwd", "profileId", "serverId"],
    `${entry} must not add preview, provider, or other special route parameters`);
}

async function waitForDraft(page) {
  const draft = page.getByTestId("new-task-draft");
  await draft.waitFor({ state: "visible", timeout: 30_000 });
  const input = draft.getByTestId("message-input");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await input.count(), 1, "the active NewTaskDraft must contain exactly one visible composer input");
}

async function waitForUniqueVisibleTaskScreen(page, label, timeoutMs = 20_000) {
  const headers = page.locator('[data-testid="task-header"]:visible');
  const inputs = page.locator('[data-testid="message-input"]:visible');
  await waitFor(async () => (await headers.count()) === 1 && (await inputs.count()) === 1,
    timeoutMs, `${label} must expose exactly one visible TaskScreen header and composer`, 50);
}

async function waitForOfflineConnection(page, rpc, serverId, afterSequence) {
  await rpc.waitForInitializeFailure(serverId, afterSequence, 40_000);
  await waitForStatus(page, false);
}

async function waitForStatus(page, connected) {
  const language = await page.evaluate(() => document.documentElement.lang);
  const expected = connected
    ? language === "en" ? "Online" : "在线"
    : language === "en" ? "Offline" : "离线";
  await waitFor(async () => {
    const status = await page.getByTestId("draft-context-status").innerText().catch(() => "");
    return status.trim() === expected;
  }, 30_000, `draft connection status ${expected}`, 50);
}

async function waitForProjectHealthRows(page, location, language, theme, localWorkspacePath, apiSnapshot,
  localDisplayName = basename(localWorkspacePath)) {
  assert.equal(apiSnapshot.statuses[LOCAL_SERVER_ID], "online",
    "the real Gateway status API must report the local target online");
  assert.equal(apiSnapshot.statuses[OFFLINE_SERVER_ID], "offline",
    "the real Gateway status API must report the SSH target offline");
  const expectedLocal = language === "en" ? "Online" : "在线";
  const expectedOffline = language === "en" ? "Offline" : "离线";
  const togglePrefix = location === "home" ? "toggle-server" : "drawer-toggle-server";
  const plusPrefix = location === "home" ? "new-workspace" : "drawer-new-workspace";
  const badgePrefix = location === "home" ? "home-target-badge" : "drawer-target-badge";
  const statusPrefix = location === "home" ? "home-target-status" : "drawer-target-status";
  const namePrefix = location === "home" ? "home-workspace-name" : "drawer-workspace-name";
  const statusColors = {};
  const neutralColors = {};
  await waitFor(async () => {
    for (const serverId of [LOCAL_SERVER_ID, OFFLINE_SERVER_ID]) {
      const expectedStatus = serverId === LOCAL_SERVER_ID ? expectedLocal : expectedOffline;
      const toggle = page.getByTestId(`${togglePrefix}-${serverId}`);
      const label = await toggle.getAttribute("aria-label").catch(() => null);
      if (!label?.endsWith(` · ${expectedStatus}`)) return false;
    }
    return true;
  }, 30_000, `${location} workspace statuses to settle to the real Gateway API snapshot`, 50);
  for (const serverId of [LOCAL_SERVER_ID, OFFLINE_SERVER_ID]) {
    const toggle = page.getByTestId(`${togglePrefix}-${serverId}`);
    await toggle.waitFor({ state: "visible", timeout: 15_000 });
    const expectedPath = serverId === LOCAL_SERVER_ID ? localWorkspacePath : OFFLINE_CWD;
    const expectedName = serverId === LOCAL_SERVER_ID ? localDisplayName : OFFLINE_PROJECT_LABEL;
    const expectedLabel = serverId === LOCAL_SERVER_ID ? expectedLocal : expectedOffline;
    const accessibleLabel = await toggle.getAttribute("aria-label");
    const accessibleSuffix = ` · ${expectedLabel}`;
    assert.ok(accessibleLabel?.includes(`${expectedName} · ${expectedPath} ·`),
      `${location} ${serverId} toggle accessibility label must preserve the exact project name and workspace path`);
    assert.ok(accessibleLabel.endsWith(accessibleSuffix),
      `${location} ${serverId} toggle accessibility label must announce the exact real Gateway status`);
    assert.ok(accessibleLabel.includes(`(${serverId})`),
      `${location} ${serverId} toggle accessibility label must identify the exact target`);
    assert.equal(await page.getByTestId(`${namePrefix}-${serverId}-0`).innerText(), expectedName,
      `${location} ${serverId} single-line project row must keep its readable name`);
    assert.equal(await page.getByTestId(`${statusPrefix}-${serverId}-0`).count(), 0,
      `${location} ${serverId} folder must not render a connection status dot`);

    const folderBadge = page.getByTestId(`${badgePrefix}-${serverId}-0`);
    const folderChildren = await folderBadge.evaluate((node) => {
      const folder = node.parentElement;
      return {
        sameFolder: Boolean(folder),
        childTestIds: [...(folder?.querySelectorAll(":scope > [data-testid]") ?? [])]
          .map((child) => child.getAttribute("data-testid")),
      };
    });
    assert.equal(folderChildren.sameFolder, true,
      `${location} ${serverId} target badge must remain on its folder icon`);
    assert.deepEqual(folderChildren.childTestIds, [`${badgePrefix}-${serverId}-0`],
      `${location} ${serverId} folder must contain only the target badge overlay and no status-dot overlay`);

    const plusButton = page.getByTestId(`${plusPrefix}-${serverId}-0`);
    const plusIcon = plusButton.locator("svg").first();
    await plusIcon.waitFor({ state: "visible", timeout: 10_000 });
    const actualStatus = apiSnapshot.statuses[serverId];
    const expectedStatusStroke = STATUS_COLORS[theme]?.[actualStatus];
    assert.ok(expectedStatusStroke, `the ${theme} theme must define the existing StatusDot color for ${actualStatus}`);
    const actualPlusStroke = await plusIcon.getAttribute("stroke");
    const expectedPlusStroke = NEUTRAL_ICON_COLORS[theme]?.textMuted;
    assert.ok(expectedPlusStroke, `the ${theme} theme must define the expected ${location} Plus icon color`);
    assert.equal(actualPlusStroke?.toLowerCase(), expectedPlusStroke.toLowerCase(),
      `${location} ${serverId} Plus SVG must keep the normal textMuted color`);

    const chevronPrefix = location === "home" ? "home-workspace-chevron" : "drawer-workspace-chevron";
    const chevronWrapper = page.getByTestId(`${chevronPrefix}-${serverId}-0`);
    const chevronIcon = chevronWrapper.locator("svg").first();
    await chevronIcon.waitFor({ state: "visible", timeout: 10_000 });
    const actualChevronStroke = await chevronIcon.getAttribute("stroke");
    const chevronSurface = await chevronWrapper.evaluate((node) => {
      const svgRect = node.querySelector("svg")?.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        backgroundColor: style.backgroundColor,
        iconWidth: svgRect?.width ?? 0,
        iconHeight: svgRect?.height ?? 0,
      };
    });
    assert.equal(normalizeCssColor(chevronSurface.backgroundColor), "transparent",
      `${location} ${serverId} workspace chevron wrapper must have no status-colored circular background`);
    assert.ok(Math.abs(chevronSurface.iconWidth - 13) <= 1 && Math.abs(chevronSurface.iconHeight - 13) <= 1,
      `${location} ${serverId} workspace chevron SVG must retain its 13px glyph size`);
    assert.equal(normalizeCssColor(actualChevronStroke), normalizeCssColor(expectedStatusStroke),
      `${location} ${serverId} workspace chevron SVG must use the real ${actualStatus} StatusDot theme color`);

    const plusLabel = await plusButton.getAttribute("aria-label");
    assert.ok(plusLabel?.endsWith(` · ${expectedLabel}`),
      `${location} ${serverId} project Plus accessibility label must preserve the real connection status`);
    statusColors[serverId] = expectedStatusStroke;
    neutralColors[serverId] = actualPlusStroke;
  }
  assert.notEqual(statusColors[LOCAL_SERVER_ID], statusColors[OFFLINE_SERVER_ID],
    `${location} online and offline status indicators must use their distinct real StatusDot colors`);
  assert.equal(neutralColors[LOCAL_SERVER_ID], neutralColors[OFFLINE_SERVER_ID],
    `${location} neutral project icon treatment must remain consistent across local and SSH targets`);
  assert.equal(await page.locator('[role="alert"]:visible').count(), 0,
    `the ordinary ${location} project health view must not render raw thread/workspace errors`);
  return {
    apiSequence: apiSnapshot.sequence,
    apiStatus: apiSnapshot.statuses,
    localStatusAccessible: true,
    offlineStatusAccessible: true,
    localStatus: apiSnapshot.statuses[LOCAL_SERVER_ID],
    offlineStatus: apiSnapshot.statuses[OFFLINE_SERVER_ID],
    localStatusColor: statusColors[LOCAL_SERVER_ID],
    offlineStatusColor: statusColors[OFFLINE_SERVER_ID],
    localNeutralIconColor: neutralColors[LOCAL_SERVER_ID],
    offlineNeutralIconColor: neutralColors[OFFLINE_SERVER_ID],
  };
}

async function waitForTaskScreen(page, profileId, threadId, cwd, expectedTitle = null) {
  await waitForUniqueVisibleTaskScreen(page, "TaskScreen navigation", 30_000);
  const route = new URL(page.url());
  assert.equal(route.pathname,
    `/mobile/h/${encodeURIComponent(profileId)}/task/${LOCAL_SERVER_ID}/${encodeURIComponent(threadId)}`,
    "the owned empty thread must be on its exact paired-profile TaskScreen route");
  assert.equal(route.searchParams.get("cwd"), cwd,
    "the owned empty thread must remain under its exact local workspace owner");
  const queryKeys = [...route.searchParams.keys()].sort();
  const hasServerId = route.searchParams.has("serverId");
  const hasThreadId = route.searchParams.has("threadId");
  assert.equal(hasServerId, hasThreadId,
    "Expo may mirror the TaskScreen path params into the query only as a complete server/thread pair");
  const expectedQueryKeys = ["cwd"];
  if (hasServerId) expectedQueryKeys.push("serverId", "threadId");
  if (expectedTitle !== null) expectedQueryKeys.push("title");
  expectedQueryKeys.sort();
  assert.deepEqual(queryKeys, expectedQueryKeys,
    "the TaskScreen route may carry only its exact workspace, normal task title and matching Expo path params");
  for (const key of queryKeys) {
    assert.equal(route.searchParams.getAll(key).length, 1,
      `the TaskScreen ${key} route parameter must not be duplicated`);
  }
  if (hasServerId) {
    assert.equal(route.searchParams.get("serverId"), LOCAL_SERVER_ID,
      "a mirrored Expo serverId must match the exact server in the TaskScreen path");
    assert.equal(route.searchParams.get("threadId"), threadId,
      "a mirrored Expo threadId must match the exact thread in the TaskScreen path");
  }
  if (expectedTitle !== null) {
    assert.equal(route.searchParams.get("title"), expectedTitle,
      "the normal task-row entry must preserve its server-acknowledged title");
  }
  await waitFor(async () => await page.getByTestId("task-workspace-recovery").count() === 0,
    30_000, "TaskScreen workspace state to finish restoring", 50);
}

async function assertTaskScreenInnerDrawer(page, {
  drawer,
  profileId,
  threadId,
  localWorkspacePath,
  language,
  theme,
  apiSnapshot,
  taskTitle,
  localProjectName,
  registeredProjectName,
  ellipsisObservations,
}) {
  await waitForProjectRows(page, "drawer");
  await drawer.getByTestId(`drawer-workspace-row-${LOCAL_SERVER_ID}-1`).waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => await drawer.getByTestId(`drawer-project-${LOCAL_SERVER_ID}-0`).innerText() === registeredProjectName,
    30_000, "TaskScreen Drawer to automatically load the target's registered multi-workspace project");
  const legacyLoadEntries = drawer.locator(
    '[data-testid^="drawer-load-server-"], [data-testid^="drawer-load-projects-"]',
  );
  assert.equal(await legacyLoadEntries.count(), 0,
    "TaskScreen's real callback-backed sidebar must not render any server or project load-more entry");
  const emptyOfflineWorkspace = drawer.getByTestId(`drawer-workspace-row-${OFFLINE_SERVER_ID}-0`);
  await emptyOfflineWorkspace.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await emptyOfflineWorkspace.locator('[data-testid^="drawer-thread-"]').count(), 0,
    "the isolated unreachable SSH workspace must remain an empty project fixture with no task rows");
  const emptyWorkspaceHint = language === "en" ? "No tasks" : "暂无任务";
  assert.equal(await emptyOfflineWorkspace.getByText(emptyWorkspaceHint, { exact: true }).count(), 0,
    "an empty workspace in TaskScreen's inner Drawer must show only its project row, without a no-tasks hint");

  const health = await waitForProjectHealthRows(page, "drawer", language, theme, localWorkspacePath,
    apiSnapshot, localProjectName);
  const folderBadgeGeometry = {};
  const badgeColors = await assertOrdinaryProjectControls(page, "drawer", localWorkspacePath,
    folderBadgeGeometry, ellipsisObservations, localProjectName);

  const activeThread = drawer.getByTestId(`drawer-thread-${threadId}`);
  await activeThread.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await drawer.getByTestId(`drawer-thread-actions-${threadId}`).count(), 0,
    "the TaskScreen Drawer must not render a separate More button beside its session row");
  const directChildMarkers = await activeThread.evaluate((node) => Array.from(node.children, (child) => {
    const bounds = child.getBoundingClientRect();
    const style = getComputedStyle(child);
    return {
      width: bounds.width,
      height: bounds.height,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
    };
  }));
  assert.equal(directChildMarkers.some((child) => child.width === 6 && child.height === 6 &&
    child.backgroundColor !== "transparent" && child.backgroundColor !== "rgba(0, 0, 0, 0)" &&
    child.borderRadius === "6px"), false,
  "the TaskScreen session row must not render the removed 6px thread-state dot");
  const activeThreadProjection = await activeThread.evaluate((node) => ({
    tabIndex: node.tabIndex,
    backgroundColor: getComputedStyle(node).backgroundColor,
  }));
  assert.equal(activeThreadProjection.tabIndex, 0,
    "the whole TaskScreen session Pressable row must remain keyboard-focusable");
  const expectedSelectedBackground = theme === "dark" ? "rgb(39, 39, 42)" : "rgb(241, 245, 249)";
  assert.equal(activeThreadProjection.backgroundColor, expectedSelectedBackground,
    "the current session row must show the real theme surfaceHover selection state");
  const currentTaskRoute = new URL(page.url());
  assert.ok(currentTaskRoute.pathname.includes(`/h/${encodeURIComponent(profileId)}/task/${LOCAL_SERVER_ID}/${encodeURIComponent(threadId)}`),
    "the visibly selected session row must match the exact paired-profile and current TaskScreen route");
  assert.equal(currentTaskRoute.searchParams.get("cwd"), localWorkspacePath,
    "the selected session row must remain scoped to the exact local workspace owner");
  await assertNoRightChevron(activeThread, "TaskScreen session row");
  await assertNoGitBranch(activeThread, "TaskScreen session row");
  assert.equal(await drawer.getByTestId(`drawer-thread-icon-${threadId}`).count(), 0,
    "TaskScreen's session row must not render the removed dedicated branch-icon wrapper");
  assert.equal(await drawer.locator('[data-testid^="drawer-thread-chevron-"]').count(), 0,
    "TaskScreen's session row must not render a separate entering chevron control");
  const taskTitleNode = activeThread.getByText(taskTitle, { exact: true });
  const taskTitleEllipsis = await assertSingleLineEllipsis(taskTitleNode, taskTitle,
    "TaskScreen sidebar session title");

  for (const serverId of [LOCAL_SERVER_ID, OFFLINE_SERVER_ID]) {
    const expectedPath = serverId === LOCAL_SERVER_ID ? localWorkspacePath : OFFLINE_CWD;
    const more = drawer.getByTestId(`drawer-workspace-actions-${serverId}-0`);
    const plus = drawer.getByTestId(`drawer-new-workspace-${serverId}-0`);
    await more.waitFor({ state: "visible", timeout: 15_000 });
    await plus.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await more.isEnabled(), true,
      `TaskScreen More must remain reachable for ${serverId} at ${expectedPath}`);
    assert.equal(await plus.isEnabled(), true,
      `TaskScreen Plus must remain reachable for ${serverId} at ${expectedPath}`);
  }

  assert.equal(new URL(page.url()).searchParams.get("cwd"), localWorkspacePath,
    `the ${language}/${theme} TaskScreen must retain its exact local workspace owner`);
  assert.equal(new URL(page.url()).pathname.includes(`/h/${encodeURIComponent(profileId)}/`), true,
    "the real TaskScreen must remain under the Welcome-paired profile route");
  return {
    legacyLoadEntries: 0,
    emptyOfflineWorkspaceHasNoHint: true,
    activeThreadVisible: true,
    health,
    badgeColors,
    folderBadgeGeometry,
    sessionBranchIconAbsent: true,
    separateThreadMoreAbsent: true,
    taskTitleEllipsis,
  };
}

async function assertWorkspaceFolderBadgeLayout(page, location, serverId) {
  const prefix = location === "home" ? "home" : "drawer";
  const badge = page.getByTestId(`${prefix}-target-badge-${serverId}-0`);
  const layout = await badge.evaluate((targetBadge, ids) => {
    const folder = targetBadge.parentElement;
    if (!folder) return null;
    const folderRect = folder.getBoundingClientRect();
    const targetRect = targetBadge.getBoundingClientRect();
    const statusNode = folder.querySelector(`[data-testid="${ids.statusId}"]`);
    return {
      folder: { x: folderRect.x, y: folderRect.y, width: folderRect.width, height: folderRect.height },
      target: { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height },
      hasStatusDot: Boolean(statusNode),
      childTestIds: [...folder.querySelectorAll(":scope > [data-testid]")]
        .map((child) => child.getAttribute("data-testid")),
      targetColor: getComputedStyle(targetBadge).backgroundColor,
    };
  }, {
    statusId: `${prefix}-target-status-${serverId}-0`,
  });
  assert.ok(layout, `${location} ${serverId} folder must contain its target badge`);
  assert.equal(layout.hasStatusDot, false,
    `${location} ${serverId} folder icon must not contain a separate connection status dot`);
  assert.deepEqual(layout.childTestIds, [`${prefix}-target-badge-${serverId}-0`],
    `${location} ${serverId} folder must contain only its target badge overlay`);
  assert.ok(Math.abs(layout.folder.width - 16) <= 1 && Math.abs(layout.folder.height - 16) <= 1,
    `${location} ${serverId} target badge must overlay the standard 16px folder icon`);
  assert.ok(Math.abs((layout.target.x + layout.target.width) - (layout.folder.x + layout.folder.width + 3)) <= 1,
    `${location} ${serverId} target badge must remain at the folder's lower-right corner`);
  assert.ok(Math.abs((layout.target.y + layout.target.height) - (layout.folder.y + layout.folder.height + 2)) <= 1,
    `${location} ${serverId} target badge must remain aligned to the folder's lower edge`);
  assert.ok(layout.targetColor && layout.targetColor !== "rgba(0, 0, 0, 0)" && layout.targetColor !== "transparent",
    `${location} ${serverId} right-bottom target server badge must retain its visible color`);
  return {
    folderStatusDotAbsent: true,
    rightBottomTargetBadge: true,
    targetColor: layout.targetColor,
    folderSize: { width: layout.folder.width, height: layout.folder.height },
    targetOffset: {
      right: layout.target.x + layout.target.width - (layout.folder.x + layout.folder.width),
      bottom: layout.target.y + layout.target.height - (layout.folder.y + layout.folder.height),
    },
  };
}

async function assertSingleLineEllipsis(locator, expectedText, label) {
  const layout = await locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      text: node.textContent?.trim() ?? "",
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      clientHeight: node.clientHeight,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      overflowX: style.overflowX,
    };
  });
  assert.equal(layout.text, expectedText, `${label} must come from real owned fixture data`);
  assert.ok(layout.clientWidth > 0 && layout.clientHeight > 0,
    `${label} must have a visible layout box`);
  assert.equal(layout.textOverflow, "ellipsis",
    `${label} must use computed text-overflow: ellipsis`);
  assert.equal(layout.whiteSpace, "nowrap",
    `${label} must remain on one line`);
  assert.ok(layout.scrollWidth > layout.clientWidth,
    `${label} must contain actual overflowing text rather than only an ellipsis style`);
  return {
    text: layout.text,
    actualOverflow: true,
    textOverflow: layout.textOverflow,
    whiteSpace: layout.whiteSpace,
    overflowX: layout.overflowX,
    clientWidth: layout.clientWidth,
    scrollWidth: layout.scrollWidth,
  };
}

async function assertProjectChevronDirection(page, location, serverId, expandedAttribute) {
  assert.ok(expandedAttribute === "true" || expandedAttribute === "false",
    `${location} ${serverId} project toggle must expose its expansion state`);
  const prefix = location === "home" ? "home-workspace-chevron" : "drawer-workspace-chevron";
  const actual = await readChevronDirection(page.getByTestId(`${prefix}-${serverId}-0`));
  const expected = expandedAttribute === "true" ? "down" : "right";
  assert.equal(actual, expected,
    `${location} ${serverId} project chevron must match aria-expanded=${expandedAttribute}`);
  return actual;
}

async function readChevronDirection(locator) {
  return locator.evaluate((node) => {
    const svg = node.tagName.toLowerCase() === "svg" ? node : node.querySelector("svg");
    const paths = [...(svg?.querySelectorAll("path") ?? [])]
      .map((path) => path.getAttribute("d")?.toLowerCase().replace(/\s+/g, " ").trim() ?? "");
    if (paths.some((path) => path.includes("m9 18 6-6-6-6"))) return "right";
    if (paths.some((path) => path.includes("m6 9 6 6 6-6"))) return "down";
    return { tag: node.tagName.toLowerCase(), paths };
  });
}

function normalizeCssColor(value) {
  const color = String(value ?? "").trim().toLowerCase();
  if (color === "transparent" || color === "rgba(0, 0, 0, 0)") return "transparent";
  const rgb = parseRgbColor(color);
  return rgb ? `rgb(${rgb.map((channel) => Math.round(channel)).join(",")})` : color;
}

function parseRgbColor(value) {
  const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join("") : hex;
    return [0, 2, 4].map((index) => Number.parseInt(expanded.slice(index, index + 2), 16));
  }
  const match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (!match) return null;
  if (match[4] !== undefined && Number(match[4]) === 0) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

async function assertNoRightChevron(row, label) {
  const count = await row.evaluate((node) => [...node.querySelectorAll("path")]
    .filter((path) => path.getAttribute("d")?.toLowerCase().replace(/\s+/g, " ").trim()
      .includes("m9 18 6-6-6-6"))
    .length);
  assert.equal(count, 0, `${label} must not render a separate entering chevron`);
}

async function assertNoGitBranch(row, label) {
  const count = await row.locator('svg path[d="M18 9a9 9 0 0 1-9 9"]').count();
  assert.equal(count, 0, `${label} must not render the removed GitBranch icon`);
}

async function openAndVerifyThreadActionsSheet(page, { title, language, expectedRoute }) {
  const renameInput = page.getByTestId("thread-rename-input");
  await renameInput.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await renameInput.count(), 1,
    "opening thread actions must present exactly one original ThreadActionsSheet rename editor");
  const dialog = renameInput.locator('xpath=ancestor::*[@role="dialog"][1]');
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await dialog.count(), 1,
    "the original ThreadActionsSheet must be scoped to one visible inner dialog");
  assert.equal(await renameInput.inputValue(), title,
    "thread actions must preserve the server-acknowledged title without modifying it");
  await dialog.getByTestId("thread-archive-action").waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByTestId("thread-delete-action").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(page.url(), expectedRoute,
    "opening thread actions must not navigate to or away from the exact TaskScreen route");
  return { dialog, renameInput };
}

async function closeThreadActionsSheet(page, { dialog, renameInput, expectedRoute, language }) {
  await dialog.getByLabel(language === "en" ? "Close" : "关闭", { exact: true }).click();
  await renameInput.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(page.url(), expectedRoute,
    "closing thread actions must leave the current route unchanged");
}

async function assertHomeThreadActions(page, { threadId, title, language, context, screenshots, viewport }) {
  const expectedRoute = page.url();
  const row = page.getByTestId("thread-" + threadId);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await page.getByTestId("thread-actions-" + threadId).count(), 0,
    "reference home rows reserve their trailing space for the task time");
  assert.equal(await row.getAttribute("role"), "button");
  await row.click({ delay: 650 });
  const sheet = await openAndVerifyThreadActionsSheet(page, { title, language, expectedRoute });
  await captureScreenshot(page, context, screenshots, "home-thread-actions-390-zh-cn-light.png", viewport);
  await closeThreadActionsSheet(page, { ...sheet, expectedRoute, language });
  return { longPressActivated: true, originalRenameArchiveDeleteSheet: true, navigationSuppressed: true, route: expectedRoute };
}

async function assertDrawerLongPressThreadActions(page, {
  drawer,
  threadId,
  title,
  language,
  context,
  screenshots,
  viewport,
}) {
  const expectedRoute = page.url();
  const separateMoreCount = await drawer.getByTestId("drawer-thread-actions-" + threadId).count();
  assert.equal(separateMoreCount, 0,
    "the TaskScreen Drawer must not render a separate thread More button");
  const row = drawer.getByTestId("drawer-thread-" + threadId);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await row.evaluate((node) => node.tabIndex), 0,
    "the Drawer session row must remain keyboard-focusable while long press supplies its More action");
  const bounds = await row.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0,
    "the owned Drawer session row must have a real visible hit target for long press");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  const sheet = await openAndVerifyThreadActionsSheet(page, { title, language, expectedRoute });
  assert.equal(page.url(), expectedRoute,
    "releasing a successful 650ms Drawer long press must not also navigate the session row");
  await captureScreenshot(page, context, screenshots,
    "task-screen-drawer-longpress-actions-390-zh-cn-light.png", viewport);
  await closeThreadActionsSheet(page, { ...sheet, expectedRoute, language });
  await drawer.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(page.url(), expectedRoute,
    "closing the long-press action sheet must keep the TaskScreen and Drawer owner unchanged");
  return {
    separateMoreAbsent: true,
    delayLongPressMs: 500,
    heldMs: 650,
    releasedWithoutNavigation: true,
    originalRenameArchiveDeleteSheet: true,
    route: expectedRoute,
  };
}

async function assertTaskDrawerRowEntry(page, language, profileId, threadId, title, cwd, theme) {
  const routeBefore = new URL(page.url());
  assert.equal(routeBefore.pathname,
    `/mobile/h/${encodeURIComponent(profileId)}/task/${LOCAL_SERVER_ID}/${encodeURIComponent(threadId)}`,
    "the task-row interaction must start from the exact paired-profile TaskScreen route");
  assert.equal(routeBefore.searchParams.get("cwd"), cwd,
    "the task-row interaction must start under the exact local workspace owner");
  const drawer = page.getByTestId("mobile-drawer");
  const opener = page.getByLabel(taskListLabel(language), { exact: true });
  if (!(await drawer.isVisible().catch(() => false))) await opener.click();
  await drawer.waitFor({ state: "visible", timeout: 10_000 });
  const row = drawer.getByTestId(`drawer-thread-${threadId}`);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await row.evaluate((node) => node.tabIndex), 0,
    "the entire TaskScreen session row must remain keyboard-focusable");
  const selectedBackground = await row.evaluate((node) => getComputedStyle(node).backgroundColor);
  const expectedSelectedBackground = theme === "dark" ? "rgb(39, 39, 42)" : "rgb(241, 245, 249)";
  assert.equal(selectedBackground, expectedSelectedBackground,
    "the current TaskScreen session row must preserve its theme-specific selected highlight before entry");
  await assertNoRightChevron(row, "TaskScreen session row");
  await row.click();
  await drawer.waitFor({ state: "hidden", timeout: 10_000 });
  await waitForTaskScreen(page, profileId, threadId, cwd, title);
  const routeAfter = new URL(page.url());
  assert.equal(routeAfter.pathname, routeBefore.pathname,
    "the entire session row must re-enter its exact TaskScreen route");
  assert.equal(routeAfter.searchParams.get("cwd"), cwd,
    "the TaskScreen row entry must retain the exact workspace owner");
  assert.equal(routeAfter.searchParams.get("title"), title,
    "the TaskScreen row entry must use the exact server-acknowledged title");
  assert.equal(routeAfter.searchParams.get("profileId"), routeBefore.searchParams.get("profileId"),
    "the TaskScreen row entry must retain the paired profile");
  return { wholeRowEntryVerified: true, routePreserved: true, titlePreserved: true };
}

async function assertTaskDrawerWorkspaceMore(page, drawer, serverId, expectedPath, context, screenshots, viewport, capture) {
  const index = 0;
  const trigger = drawer.getByTestId(`drawer-workspace-actions-${serverId}-${index}`);
  await trigger.click();
  const modal = page.getByTestId(`workspace-actions-menu-${serverId}-${index}`);
  const dialog = modal.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await dialog.count(), 1,
    "the TaskScreen More menu must expose one scoped inner dialog");
  const path = dialog.getByTestId(`workspace-actions-path-${serverId}-${index}`);
  await path.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await path.innerText()).trim(), expectedPath,
    `TaskScreen More must keep the complete ${serverId} workspace path available`);
  await dialog.getByTestId(`refresh-history-${serverId}-${index}`).waitFor({ state: "visible", timeout: 10_000 });
  if (capture) {
    await captureScreenshot(page, context, screenshots,
      "task-screen-drawer-local-more-path-390-zh-cn-light.png", viewport);
  }
  await dialog.getByTestId(`workspace-actions-close-${serverId}-${index}`).click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return { serverId, workspacePath: expectedPath, pathVisible: true, refreshInvoked: false };
}

async function assertNewDraftConnectionControls(page, { connected, hasMessage }) {
  const language = await page.evaluate(() => document.documentElement.lang);
  const send = page.getByTestId("send-message");
  const model = page.getByTestId("draft-model-selector");
  await send.waitFor({ state: "visible", timeout: 10_000 });
  await model.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await send.isDisabled(), !connected || !hasMessage,
    connected && hasMessage ? "Send must enable for a non-empty recovered draft" : "Send must stay disabled without a connected target and non-empty text");
  assert.equal(await model.isDisabled(), !connected,
    connected ? "model selection must enable after local initialization succeeds" : "model selection must remain disabled while SSH is offline");
  const permissionCount = await page.getByTestId("draft-permission-selector").count();
  assert.equal(permissionCount > 0, connected,
    connected ? "the real initialized local target must enable its permission selector" : "permission selection must stay unavailable while SSH is offline");
  const contextStatus = await page.getByTestId("draft-context-status").innerText();
  assert.equal(contextStatus.trim(), connected ? (language === "en" ? "Online" : "在线")
    : (language === "en" ? "Offline" : "离线"));
}

async function assertRetryAtContextBarRight(page) {
  const bar = page.getByTestId("draft-context-bar");
  const retry = page.getByTestId("new-task-gateway-retry");
  const barBox = await bar.boundingBox();
  const retryBox = await retry.boundingBox();
  assert.ok(barBox && retryBox, "the offline retry icon and context bar must have visible layout boxes");
  assert.ok(retryBox.x + retryBox.width >= barBox.x + barBox.width - 12,
    "the retry icon must sit at the right edge of the project context bar");
}

async function openProjectPicker(page) {
  await page.getByTestId("draft-context-project").click();
  const modal = page.getByTestId("draft-context-project-modal");
  const inner = modal.locator('[role="dialog"]');
  await inner.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await inner.count(), 1,
    "the project picker must use its scoped inner dialog rather than the native Modal wrapper");
  return inner;
}

function projectOptionId(serverId, cwd) {
  return `draft-context-project-option-${encodeURIComponent(serverId)}-${encodeURIComponent(cwd)}`;
}

async function backToHome(page, language) {
  await page.getByLabel(language === "en" ? "Back" : "返回", { exact: true }).click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 15_000 });
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(dimensions.document <= dimensions.viewport && dimensions.body <= dimensions.viewport,
    `${label} must not overflow horizontally: ${JSON.stringify(dimensions)}`);
}

async function captureScreenshot(page, context, screenshots, name, viewport) {
  const path = context.pathInArtifacts("screenshots", name);
  await mkdir(dirname(path), { recursive: true });
  const bytes = await page.screenshot({ path, animations: "disabled" });
  screenshots.push({
    name,
    path: relative(context.runRoot, path),
    sha256: sha256(bytes),
    width: viewport.width,
    height: viewport.height,
    language: viewport.language,
    theme: viewport.theme,
  });
}

function profileIdFromUrl(value) {
  const segments = new URL(value).pathname.split("/").filter(Boolean);
  const index = segments.indexOf("h");
  const profileId = decodeURIComponent(segments[index + 1] ?? "");
  assert.ok(profileId, "the Welcome-paired Mobile Home must expose its exact Gateway profile route");
  return profileId;
}

function buildTaskScreenUrl(homeUrl, profileId, serverId, threadId, cwd) {
  const route = new URL(homeUrl);
  const profileMarker = `/h/${encodeURIComponent(profileId)}`;
  const profileOffset = route.pathname.indexOf(profileMarker);
  assert.ok(profileOffset >= 0, "the paired Home URL must identify its profile route prefix");
  const mobileBase = route.pathname.slice(0, profileOffset);
  route.pathname = `${mobileBase}${profileMarker}/task/${encodeURIComponent(serverId)}/${encodeURIComponent(threadId)}`;
  route.search = "";
  route.searchParams.set("cwd", cwd);
  route.hash = "";
  return route.href;
}

function taskListLabel(language) {
  return language === "en" ? "Open task list" : "打开任务列表";
}

function navigationLabel(language) {
  return language === "en" ? "Task navigation" : "任务导航";
}

function closeNavigationLabel(language) {
  return language === "en" ? "Close navigation" : "关闭导航";
}

function localeSlug(language) {
  return language === "en" ? "en" : "zh-cn";
}

function slug(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "stage";
}

async function hashExecutable(path) {
  const bytes = await readFile(path);
  return { sha256: sha256(bytes), bytes: bytes.byteLength };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
