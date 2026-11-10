import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import {
  buildGatewayMobileWebManifest,
  writeGatewayMobileWebManifest,
} from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import {
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import { hashExecutableFile } from "../../harness/owned-executable-provenance.mjs";

const BASELINE_ROOT = process.env.KCODER_E2E_MOBILE_WEB_BASELINE_ROOT;
const BASELINE_SOURCE_REVISION = "02450a2ea928d940b14fb1ac07849e1458969e2d";
const BASELINE_ENTRY_SHA256 = "863fcd6583cf17bfcd1273e9286560ccaf2c8dd65cab1e4517e4785d54420e80";
const PREFERENCES_KEY = "kcoder-studio:mobile-app-preferences:v1";
const LATE_RECEIPT_QUIET_WINDOW_MS = 400;
const IS_BASELINE = Boolean(BASELINE_ROOT);
const KCODER_BIN = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");

if (BASELINE_ROOT) {
  assert.ok(isAbsolute(BASELINE_ROOT), "baseline Mobile Web root must be absolute");
}

// Real navigation and task acceptance. The Gateway, app-server, pairing, and browser
// RPC are real; KCODER_STUDIO_SCENARIO supplies deterministic model-independent frames.
await runE2E(
  import.meta.url,
  {
    testId: "mobile-new-task-default-draft-entry-contexts-and-late-receipt",
    tier: "full-integration",
    modelPolicy:
      "model-independent real Mobile Web/Gateway/app-server/browser RPC; deterministic full-turn scenario; no paid model calls",
    retainSuccessEvidence: true,
    evidenceReason:
      "New-task entry context, progressive disclosure, and late receipt route ownership need visual and RPC evidence",
  },
  async (context) => {
    const workspaceScratch = await context.createOwnedScratchDirectory("mobile-new-nav-workspace", {
      baseDirectory: "/tmp",
    });
    const workspace = workspaceScratch.path;
    const serversFile = await context.writeStateJson("mobile-new-navigation-servers.json", [{
      id: "local",
      label: "Local",
      transport: "local",
      command: KCODER_BIN,
      workspace,
    }]);
    await context.writeStateJson("config/settings.json", {});
    const baselineEvidence = IS_BASELINE
      ? await inspectImmutableBaseline(BASELINE_ROOT)
      : null;
    const dependencyInput = IS_BASELINE
      ? null
      : await createDependencyInputSnapshot(context);
    const mobileWeb = IS_BASELINE
      ? { path: await realpath(BASELINE_ROOT), provenance: baselineEvidence }
      : await exportMobileWeb(context, {
          label: "mobile-new-navigation-current-export",
          outputName: "mobile-new-navigation-mobile-web",
          dependencyRoot: dependencyInput.path,
          deployMount: true,
          timeoutMs: 10 * 60 * 1000,
        });
    let gatewayManifestEvidence = null;
    if (!IS_BASELINE) {
      const gatewayManifest = await buildGatewayMobileWebManifest(mobileWeb.path, {
        expectedFiles: mobileWeb.bundleFiles,
      });
      await writeGatewayMobileWebManifest(mobileWeb.path, gatewayManifest);
      const gatewayManifestPath = resolve(mobileWeb.path, "kcoder-mobile-web.json");
      const gatewayManifestBytes = await readFile(gatewayManifestPath);
      gatewayManifestEvidence = {
        path: relative(context.runRoot, gatewayManifestPath),
        sha256: sha256(gatewayManifestBytes),
        resourceCount: gatewayManifest.files.length,
        resourceTableSha256: sha256(Buffer.from(JSON.stringify(gatewayManifest.files.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }))))),
        source: "production Gateway mobile-web manifest builder; exact export bundleFiles asserted",
      };
    }
    const cliEvidence = await hashExecutableFile(KCODER_BIN);
    const suiteSourceSha256 = sha256(await readFile(new URL(import.meta.url)));
    const serverConfigSha256 = sha256(await readFile(serversFile));
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-new-navigation-gateway",
      workspace,
      serversFile,
      kcoderBin: KCODER_BIN,
      env: {
        KCODER_CONFIG_DIR: context.pathInState("config"),
        KCODER_STUDIO_SCENARIO: "full-turn",
        KCODER_STUDIO_WEB_ROOT: "",
        KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path,
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-new-navigation-chromium",
      startTimeoutMs: 60_000,
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(({ key }) => {
      localStorage.setItem(key, JSON.stringify({ language: "zh-CN", theme: "light" }));
    }, { key: PREFERENCES_KEY });

    const diagnostics = { console: [], pageErrors: [] };
    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        diagnostics.console.push({ type: message.type(), text: message.text() });
      }
    });

    const rpc = await observeTaskAcceptance(page);
    const screenshots = [];
    const drawerInteractions = [];
    try {
      await pairThroughMountedMobileWeb(page, gateway);
      const profileId = profileIdFromUrl(page.url());
      const initialHomeUrl = page.url();
      const initialHomePath = new URL(initialHomeUrl).pathname;
      assert.ok(initialHomePath.startsWith("/mobile/h/"), `pairing must land on Mobile home: ${initialHomeUrl}`);

      if (IS_BASELINE) {
        await page.getByTestId("new-workspace-local").waitFor({ state: "visible", timeout: 30_000 });
        await page.getByTestId("new-workspace-local").click();
        await waitForLegacyNewForm(page, rpc);
        const beforeServerEntry = assertLegacyEntryContext(page, { entry: "home-server", profileId, serverId: "local" });
        await capture(page, context, screenshots, "before-home-server-new-390-light.png", "light");
        await returnHome(page);

        await page.getByTestId("new-workspace").click();
        await waitForLegacyNewForm(page, rpc);
        const beforeGlobalEntry = assertLegacyEntryContext(page, { entry: "home-global", profileId });
        await capture(page, context, screenshots, "before-home-global-new-390-light.png", "light");
        await page.setViewportSize({ width: 320, height: 568 });
        await capture(page, context, screenshots, "before-home-global-new-320-light.png", "light");

        await returnHome(page);
        await setThemeThroughSettings(page, "dark");
        await page.getByTestId("new-workspace").click();
        await waitForLegacyNewForm(page, rpc);
        assertLegacyEntryContext(page, { entry: "home-global-dark", profileId });
        await page.setViewportSize({ width: 390, height: 844 });
        await capture(page, context, screenshots, "before-home-global-new-390-dark.png", "dark");

        const afterBaseline = await inspectImmutableBaseline(BASELINE_ROOT);
        assert.deepEqual(afterBaseline, baselineEvidence, "read-only baseline Mobile Web resources must stay byte-identical during the run");
        await context.writeArtifactJson("mobile-new-navigation-evidence.json", {
          runMode: "immutable-baseline-before",
          sourceRevision: BASELINE_SOURCE_REVISION,
          bundle: baselineEvidence,
          workspaceFixture: { kind: "empty-owned-scratch", path: workspace, sameDataAsAfter: false },
          gateway: { baseUrl: gateway.baseUrl, mobileMount: "/mobile/", authPairing: "real direct-connection UI", serverConfigSha256, server: { id: "local", label: "Local", workspacePath: workspace } },
          browser: { viewportScreenshots: screenshots, locale: "zh-CN", chromiumVersion: chromium.version ?? null },
          entries: [
            { entry: "home-global", context: "profileId only; no serverId or cwd", defaultLargeForm: true, ...beforeGlobalEntry },
            { entry: "home-server", context: "profileId + serverId; no cwd", defaultLargeForm: true, ...beforeServerEntry },
          ],
          rpc: summarizeRpc(rpc),
          diagnostics,
          cli: cliEvidence,
          suiteSourceSha256,
          runtime: { node: process.version, processUmask: `0${process.umask().toString(8)}` },
          baselineUnchanged: true,
          lateReceiptRegression: "not run in baseline; asserted against the current source run",
          sourceTreeSha256: null,
          dependencySourceTreeSha256: null,
          provenanceLimit: "The fixed pre-change artifact root is bound to the separately verified entry SHA; its manifest does not identify the source revision and the archive does not preserve source-tree or dependency-tree fingerprints.",
        });
        assert.deepEqual(diagnostics.pageErrors, [], "baseline pairing and navigation must not emit page errors");
        assert.deepEqual(diagnostics.console.filter((event) => event.type === "error"), [], "baseline pairing and navigation must not emit browser console errors");
        return {
          runMode: "immutable-baseline-before",
          baselineBundleVerified: true,
          baselineUnchanged: true,
          legacyEntryScreenshots: screenshots.length,
          homeGlobalAndServerEntries: true,
          lateReceiptRegressionReservedForCurrentSource: true,
          paidProviderRequests: 0,
        };
      }

      const entryResults = [];
      await openHomeGlobalNew(page);
      const homeGlobalDraft = await assertDraftContext(page, { entry: "home-global", profileId });
      const homeGlobalCatalogs = await waitForSettledDraftCatalogs(page, rpc, "home-global");
      const homeGlobalSelection = await assertDraftTargetAndWorkspace(page, {
        entry: "home-global",
        targetLabel: "服务器：Local",
        workspace,
      });
      await assertDocumentTheme(page, "light");
      await capture(page, context, screenshots, "after-home-global-new-390-light.png", "light");
      await page.setViewportSize({ width: 320, height: 568 });
      await capture(page, context, screenshots, "after-home-global-new-320-light.png", "light");
      entryResults.push({ entry: "home-global", context: "profileId only; no serverId or cwd", defaultDraft: true, selectedTargetAndWorkspace: homeGlobalSelection, ...homeGlobalDraft });

      await page.setViewportSize({ width: 390, height: 844 });
      const advancedState = await exerciseAdvancedDraftRoundTrip(page, context, screenshots);
      const advancedProjectHandoff = await openProjectFromAdvancedDraft(page, workspace, rpc);
      const handoffDraft = await assertDraftContext(page, {
        entry: "advanced-add-project-ack-return",
        profileId,
        serverId: "local",
        cwd: workspace,
      });
      const handoffCatalogs = await waitForSettledDraftCatalogs(page, rpc, "advanced-add-project-ack-return");
      const handoffSelection = await assertDraftTargetAndWorkspace(page, {
        entry: "advanced-add-project-ack-return",
        targetLabel: "服务器：Local",
        workspace,
      });
      await waitFor(async () => await page.getByTestId("message-input").inputValue() === advancedState.prompt,
        10_000, "draft prompt restoration after Add Project ACK");
      assert.equal(await page.getByTestId("message-input").inputValue(), advancedState.prompt,
        "Add Project ACK must restore the unsent draft prompt");
      assert.match(await page.getByTestId("new-task-draft-options-summary").innerText(), /orchestrate/,
        "Add Project ACK must restore the non-default execution mode");
      const handoffUrl = new URL(page.url());
      assert.equal(handoffUrl.searchParams.get("operationReceiptVersion"), "2",
        "the returned New route must carry the acknowledged V2 workspace receipt version");
      assert.ok(handoffUrl.searchParams.get("operationReceiptId"),
        "the returned New route must carry the real V2 workspace receipt identity");
      assert.equal(handoffUrl.searchParams.get("workspaceBookkeeping"), null,
        "the open-project receipt must be acknowledged before returning to New");
      await capture(page, context, screenshots, "after-advanced-project-return-draft-390-light.png", "light");
      const handoffBackNavigation = await returnHomeAfterDraftHandoff(page, context, screenshots, rpc);
      entryResults.push({
        entry: "advanced-add-project-ack-return",
        context: "profileId + serverId + cwd",
        defaultDraft: true,
        promptPreserved: true,
        executionModePreserved: "orchestrate",
        settledCatalogs: handoffCatalogs,
        workspaceReceipt: advancedProjectHandoff,
        backNavigation: handoffBackNavigation,
        selectedTargetAndWorkspace: handoffSelection,
        ...handoffDraft,
      });

      await page.getByTestId("new-workspace-local").click();
      const homeServerDraft = await assertDraftContext(page, { entry: "home-server", profileId, serverId: "local" });
      const homeServerCatalogs = await waitForSettledDraftCatalogs(page, rpc, "home-server");
      const homeServerSelection = await assertDraftTargetAndWorkspace(page, {
        entry: "home-server",
        targetLabel: "服务器：Local",
        workspace,
      });
      await capture(page, context, screenshots, "after-home-server-new-390-light.png", "light");
      entryResults.push({ entry: "home-server", context: "profileId + serverId; no cwd", defaultDraft: true, settledCatalogs: homeServerCatalogs, selectedTargetAndWorkspace: homeServerSelection, ...homeServerDraft });
      await returnHome(page);

      const drawerGlobalOpen = await openDrawer(page);
      const drawerGlobalInteraction = await clickDrawerEntry(
        page,
        drawerGlobalOpen.drawer,
        drawerGlobalOpen.drawer.getByText("新建对话", { exact: true }),
        "drawer-global",
        drawerInteractions,
      );
      const drawerGlobalDraft = await assertDraftContext(page, { entry: "drawer-global", profileId });
      const drawerGlobalSelection = await assertDraftTargetAndWorkspace(page, {
        entry: "drawer-global",
        targetLabel: "服务器：Local",
        workspace,
      });
      entryResults.push({ entry: "drawer-global", context: "profileId only; no serverId or cwd", defaultDraft: true, drawerState: drawerGlobalOpen.state, drawerInteraction: drawerGlobalInteraction, selectedTargetAndWorkspace: drawerGlobalSelection, ...drawerGlobalDraft });
      await returnHome(page);

      const drawerServerOpen = await openDrawer(page);
      const drawerServerInteraction = await clickDrawerEntry(
        page,
        drawerServerOpen.drawer,
        drawerServerOpen.drawer.getByLabel("在 Local 新建对话", { exact: true }),
        "drawer-server",
        drawerInteractions,
      );
      const drawerServerDraft = await assertDraftContext(page, { entry: "drawer-server", profileId, serverId: "local" });
      const drawerServerSelection = await assertDraftTargetAndWorkspace(page, {
        entry: "drawer-server",
        targetLabel: "服务器：Local",
        workspace,
      });
      entryResults.push({ entry: "drawer-server", context: "profileId + serverId; no cwd", defaultDraft: true, drawerState: drawerServerOpen.state, drawerInteraction: drawerServerInteraction, selectedTargetAndWorkspace: drawerServerSelection, ...drawerServerDraft });
      await returnHome(page);

      const drawerWorkspaceOpen = await openDrawer(page);
      const drawerWorkspaceInteraction = await clickDrawerEntry(
        page,
        drawerWorkspaceOpen.drawer,
        drawerWorkspaceOpen.drawer.getByText("在此工作区新建对话", { exact: true }),
        "drawer-workspace",
        drawerInteractions,
      );
      const drawerWorkspaceDraft = await assertDraftContext(page, { entry: "drawer-workspace", profileId, cwd: workspace, serverId: "local" });
      const drawerWorkspaceSelection = await assertDraftTargetAndWorkspace(page, {
        entry: "drawer-workspace",
        targetLabel: "服务器：Local",
        workspace,
      });
      entryResults.push({ entry: "drawer-workspace", context: "profileId + serverId + cwd", defaultDraft: true, drawerState: drawerWorkspaceOpen.state, drawerInteraction: drawerWorkspaceInteraction, selectedTargetAndWorkspace: drawerWorkspaceSelection, ...drawerWorkspaceDraft });
      await returnHome(page);

      await closeDrawerIfOpen(page);
      await openHostDetailsNew(page);
      const hostDetailsDraft = await assertDraftContext(page, { entry: "host-details", profileId, serverId: "local" });
      const hostDetailsSelection = await assertDraftTargetAndWorkspace(page, {
        entry: "host-details",
        targetLabel: "服务器：Local",
        workspace,
      });
      entryResults.push({ entry: "host-details", context: "profileId + serverId; no cwd", defaultDraft: true, selectedTargetAndWorkspace: hostDetailsSelection, ...hostDetailsDraft });
      const hostDetailsBack = await returnHomeFromHostDetailsNew(page);
      entryResults.push({ entry: "host-details-back-stack", ...hostDetailsBack });

      await setThemeThroughSettings(page, "dark");
      await page.getByTestId("new-workspace").click();
      await assertDraftContext(page, { entry: "home-global-dark-screenshot", profileId });
      await waitForSettledDraftCatalogs(page, rpc, "home-global-dark-screenshot");
      await assertDraftTargetAndWorkspace(page, {
        entry: "home-global-dark-screenshot",
        targetLabel: "服务器：Local",
        workspace,
      });
      await assertDocumentTheme(page, "dark");
      await capture(page, context, screenshots, "after-home-global-new-390-dark.png", "dark");

      const lateReceiptRegression = await runLateReceiptRegression(page, context, rpc, screenshots);
      assert.equal(rpc.successfulThreadStarts, 1, "one real thread/start receipt must complete");
      assert.equal(rpc.releasedThreadStartReceipts, 1, "the held real thread/start receipt must be released exactly once");
      assert.equal(rpc.acceptedTurns, 1, "the accepted first turn must be sent exactly once");
      assert.ok(rpc.workspaceOpenResponses.length >= 1, "Advanced Add Project must complete a real runtime.workspaces.openV2 RPC");
      assert.deepEqual(diagnostics.pageErrors, [], "Mobile new-task navigation must not emit page errors");
      assert.deepEqual(diagnostics.console.filter((event) => event.type === "error"), [], "Mobile new-task navigation must not emit browser console errors");

      await context.writeArtifactJson("mobile-new-navigation-evidence.json", {
        runMode: "current-source-after",
        sourceRevision: context.gitCommit,
        mobileWebExport: {
          sourceTreeSha256: mobileWeb.sourceTreeSha256,
          dependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
          dependencyOwnedTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
          bundleSha256: mobileWeb.bundleSha256,
          bundleFileCount: mobileWeb.bundleFileCount,
          indexHtmlSha256: mobileWeb.indexHtmlSha256,
          manifestPath: relative(context.runRoot, mobileWeb.bundleManifestPath),
          manifestSha256: sha256(await readFile(mobileWeb.bundleManifestPath)),
          gatewayManifest: gatewayManifestEvidence,
          sourceRoots: mobileWeb.sourceRoots,
          deployMount: true,
        },
        dependencyInputSnapshot: dependencyInput,
        workspaceFixture: { kind: "empty-owned-scratch", path: workspace, sameDataAsBefore: false },
        gateway: { baseUrl: gateway.baseUrl, mobileMount: "/mobile/", authPairing: "real direct-connection UI", serverConfigSha256, server: { id: "local", label: "Local", workspacePath: workspace } },
        browser: { viewportScreenshots: screenshots, locale: "zh-CN", chromiumVersion: chromium.version ?? null },
        entries: entryResults,
        advancedRoundTrip: advancedState,
        workspaceOpenReceipt: advancedProjectHandoff,
        lateReceiptRegression,
        drawerInteractions,
        rpc: summarizeRpc(rpc),
        diagnostics,
        cli: cliEvidence,
        suiteSourceSha256,
        runtime: { node: process.version, processUmask: `0${process.umask().toString(8)}` },
        modelBoundary: "The real app-server/Gateway RPC lifecycle uses a deterministic scenario; no paid provider is called and no paid model behavior is asserted.",
      });
      return {
        runMode: "current-source-after",
        exportedMobileWeb: true,
        entryResults,
        advancedPromptAndExecutionModePreserved: true,
        realWorkspaceOpenReceipt: advancedProjectHandoff,
        acceptedTurns: rpc.acceptedTurns,
        paidProviderRequests: 0,
        lateReceiptRegression,
      };
    } catch (error) {
      await page.screenshot({ path: context.pathInArtifacts("failure.png"), fullPage: true }).catch(() => {});
      await context.writeArtifactJson("mobile-new-navigation-failure.json", {
        runMode: IS_BASELINE ? "immutable-baseline-before" : "current-source-after",
        url: page.url(),
        diagnostics,
        drawerInteractions,
        rpc: summarizeRpc(rpc),
      }).catch(() => {});
      throw error;
    } finally {
      await page.close();
    }
  },
);

async function observeTaskAcceptance(page) {
  const state = {
    requests: [],
    responses: [],
    successfulThreadStarts: 0,
    acceptedTurns: 0,
    workspaceOpenRequests: [],
    workspaceOpenResponses: [],
    holdNextThreadStart: false,
    heldThreadStart: null,
    releasedThreadStartReceipts: 0,
    threadId: null,
  };
  await page.routeWebSocket("**/rpc*", (socket) => {
    const socketServerId = new URL(socket.url()).searchParams.get("server");
    const upstream = socket.connectToServer();
    const methods = new Map();
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== undefined) {
        methods.set(message.id, { method: message.method, params: message.params ?? null });
        state.requests.push({ method: message.method, id: message.id });
        if (message.method === "runtime.workspaces.openV2") {
          state.workspaceOpenRequests.push({
            id: message.id,
            serverId: socketServerId,
            workspacePath: message.params?.workspacePath ?? null,
            label: message.params?.label ?? null,
          });
        }
      }
      upstream.send(raw);
    });
    upstream.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      const request = methods.get(message.id);
      if (!request) {
        socket.send(raw);
        return;
      }
      const method = request.method;
      if (method === "thread/start" && message.result?.thread) {
        state.successfulThreadStarts++;
        state.threadId = message.result.thread.id;
        if (state.holdNextThreadStart && !state.heldThreadStart) {
          state.holdNextThreadStart = false;
          state.heldThreadStart = () => {
            state.releasedThreadStartReceipts++;
            socket.send(raw);
          };
          state.responses.push({ method, id: message.id, result: "held-genuine-thread-receipt" });
          return;
        }
      }
      if (method === "turn/start" && message.result) state.acceptedTurns++;
      if (method === "runtime.workspaces.openV2" && message.result) {
        state.workspaceOpenResponses.push({ id: message.id, serverId: socketServerId, result: summarizeWorkspaceReceipt(message.result) });
      }
      state.responses.push({ method, id: message.id, success: Boolean(message.result), error: message.error ? { code: message.error.code, message: message.error.message } : null });
      socket.send(raw);
    });
  });
  return state;
}

async function pairThroughMountedMobileWeb(page, gateway) {
  const response = await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "the isolated Gateway must serve the actual Mobile Web mount");
  assert.equal(new URL(page.url()).pathname, "/mobile/", "pairing must start at the hosted Mobile Web entry");
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createDependencyInputSnapshot(context) {
  const sourceRoot = await realpath(resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"));
  const snapshotRoot = context.pathInState("mobile-dependency-input-snapshot");
  await mkdir(snapshotRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory("isolated Mobile dependency input snapshot", snapshotRoot);
  const label = "mobile-new-nav-dependency-input-copy";
  const copyStartedAtUtc = new Date().toISOString();
  const child = context.spawnOwned(label, "cp", ["-aL", "--reflink=auto", `${sourceRoot}/.`, `${snapshotRoot}/`], {
    cwd: repoRoot,
    env: context.isolatedEnvironment(),
  });
  let spawnError = null;
  child.once("error", (error) => { spawnError = error; });
  try {
    await waitFor(
      () => spawnError || child.exitCode !== null || child.signalCode !== null,
      10 * 60_000,
      "private Mobile dependency input snapshot copy",
      100,
      context.abortSignal,
    );
    if (spawnError) throw new Error(`Mobile dependency input snapshot copy could not start: ${spawnError.message}`);
    assert.equal(child.exitCode, 0, `Mobile dependency input snapshot copy exited with ${child.signalCode || `code ${child.exitCode}`}`);
  } finally {
    await context.stopOwned(label);
  }
  return {
    path: snapshotRoot,
    runRelativePath: relative(context.runRoot, snapshotRoot),
    sourceRoot,
    copyPid: child.pid,
    copyStartedAtUtc,
    copyCompletedAtUtc: new Date().toISOString(),
    command: "cp -aL --reflink=auto",
    semantics: "RunContext-owned full private dependency snapshot; no cache or .vite files excluded",
  };
}

async function openHomeGlobalNew(page) {
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("new-task-advanced").waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForLegacyNewForm(page, rpc) {
  await page.getByTestId("server-option-local").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("create-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(() => new URL(page.url()).pathname.endsWith("/new"), 10_000, "legacy New route");
  await waitFor(() => rpc.responses.some((item) => item.method === "runtime.workspaces.list" && item.success)
    && rpc.responses.some((item) => item.method === "runtime.models.list" && item.success),
  30_000, "real target workspace and model catalogs");
  await page.getByTestId("server-option-local").getByText("在线", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => await page.getByTestId("new-workspace-projects-loading").count() === 0,
    10_000, "workspace catalog loading indicator to clear");
}

function assertLegacyEntryContext(page, { entry, profileId, serverId }) {
  const route = new URL(page.url());
  assert.equal(route.searchParams.get("profileId"), profileId, `${entry} must remain in the paired Gateway profile`);
  assert.equal(route.searchParams.get("serverId"), serverId ?? null, `${entry} must preserve only its actual server context`);
  assert.equal(route.searchParams.get("cwd"), null, `${entry} must not invent a workspace context`);
  return { url: page.url(), defaultLargeForm: true };
}

async function assertDraftContext(page, { entry, profileId, serverId, cwd }) {
  await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 10_000 });
  const advancedFormVisibility = {
    prompt: await inspectTestIdVisibility(page, "new-workspace-prompt"),
    create: await inspectTestIdVisibility(page, "create-workspace"),
  };
  assert.ok(advancedFormVisibility.prompt.every((item) => !item.visible), `${entry} must not show the Advanced prompt form`);
  assert.ok(advancedFormVisibility.create.every((item) => !item.visible), `${entry} must keep the large form behind Advanced`);
  const route = new URL(page.url());
  assert.ok(route.pathname.endsWith("/new"), `${entry} must open Mobile /new: ${page.url()}`);
  assert.equal(route.searchParams.get("profileId"), profileId, `${entry} must remain in the paired Gateway profile`);
  assert.equal(route.searchParams.get("serverId"), serverId ?? null, `${entry} must preserve only its actual server context`);
  assert.equal(route.searchParams.get("cwd"), cwd ?? null, `${entry} must preserve only its actual workspace context`);
  if (cwd) assert.equal(await page.getByTestId("new-task-draft-workspace").innerText(), cwd);
  return { url: page.url(), draftVisible: true, advancedFormVisibility };
}

async function assertDraftTargetAndWorkspace(page, { entry, targetLabel, workspace }) {
  const target = page.getByTestId("new-task-draft-target");
  await target.waitFor({ state: "visible", timeout: 10_000 });
  await waitFor(async () => await target.innerText() === targetLabel,
    30_000, `${entry} Draft target label ${targetLabel}`);
  const selectedTarget = await target.innerText();
  assert.equal(selectedTarget, targetLabel, `${entry} Draft must display the expected selected target`);

  const selectedWorkspace = page.getByTestId("new-task-draft-workspace");
  await waitFor(async () => await selectedWorkspace.count() === 1 && await selectedWorkspace.innerText() === workspace,
    30_000, `${entry} Draft workspace ${workspace}`);
  assert.equal(await selectedWorkspace.innerText(), workspace,
    `${entry} Draft must display the expected configured workspace even when cwd is absent from the URL`);
  return { targetLabel: selectedTarget, workspace: await selectedWorkspace.innerText() };
}

async function waitForSettledDraftCatalogs(page, rpc, entry) {
  await waitFor(() => rpc.responses.some((item) => item.method === "runtime.workspaces.list" && item.success)
    && rpc.responses.some((item) => item.method === "runtime.models.list" && item.success),
  30_000, `${entry} real workspace and model catalog RPC responses`);
  const activeDraft = page.locator('[data-testid="new-task-draft"]:visible');
  assert.equal(await activeDraft.count(), 1, `${entry} must have exactly one active visible Draft screen`);
  const status = activeDraft.getByTestId("new-task-draft-workspace-status");
  await waitFor(async () => {
    if (await status.count() === 0) return true;
    return !(await status.innerText()).includes("正在读取项目和模型选项");
  }, 30_000, `${entry} Draft catalog loading state to clear`);
  return {
    workspaceListResponse: true,
    modelListResponse: true,
    workspaceStatus: await status.count() ? await status.innerText() : null,
  };
}

async function returnHomeAfterDraftHandoff(page, context, screenshots, rpc) {
  await clickNewBackArrow(page);
  await page.getByTestId("new-workspace-prompt").waitFor({ state: "visible", timeout: 15_000 });
  const sourcePrompt = await page.getByTestId("new-workspace-prompt").inputValue();
  assert.equal(sourcePrompt, "", "the original Advanced prompt must clear after a successful draft handoff to avoid duplicate submission");
  const defaultMode = page.getByTestId("new-execution-mode-default");
  const orchestrateMode = page.getByTestId("new-execution-mode-orchestrate");
  const defaultModeStyle = await buttonBackground(defaultMode);
  const orchestrateModeStyle = await buttonBackground(orchestrateMode);
  assert.notEqual(defaultModeStyle, orchestrateModeStyle,
    "the original Advanced route must retain the non-default execution mode after Add Project handoff");
  await context.writeArtifactJson("mobile-new-navigation-handoff-observation.json", {
    observedRoute: page.url(),
    sourceAdvancedPromptValue: sourcePrompt,
    sourcePromptCleared: sourcePrompt === "",
    selectedMode: "orchestrate",
    selectedModeStyleDiffersFromDefault: orchestrateModeStyle !== defaultModeStyle,
    observation: "After backing from the acknowledged returned Draft to the retained source Advanced route; prompt was read from the live input via inputValue().",
  });
  await capture(page, context, screenshots, "after-handoff-source-advanced-prompt-cleared-390-light.png", "light");

  await page.getByTestId("new-task-advanced").click();
  await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await page.getByTestId("message-input").inputValue(), "",
    "the original source route must not restore a prompt already handed to the returned Draft");
  assert.match(await page.getByTestId("new-task-draft-options-summary").innerText(), /orchestrate/,
    "Advanced -> Draft must preserve the source route's non-default execution mode");
  await waitForSettledDraftCatalogs(page, rpc, "handoff-source-return-to-draft");
  await capture(page, context, screenshots, "after-handoff-source-back-to-draft-390-light.png", "light");

  await clickNewBackArrow(page);
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(new URL(page.url()).pathname.startsWith("/mobile/h/"), `Back from the original New route must return to Mobile home: ${page.url()}`);
  return {
    returnedFromDraftToOriginalAdvanced: true,
    sourcePromptCleared: true,
    sourceModePreserved: "orchestrate",
    advancedBackToDraftPreservedEmptyPromptAndMode: true,
    returnedHomeAfterSecondBack: true,
  };
}

async function clickNewBackArrow(page) {
  const back = page.locator('[aria-label="返回"]:visible:not([data-testid="new-task-advanced"])');
  await back.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await back.count(), 1, "the active New route must expose exactly one visible back arrow");
  await back.click();
}

async function inspectTestIdVisibility(page, testId) {
  const locator = page.getByTestId(testId);
  const matches = await locator.count();
  const evidence = [];
  for (let index = 0; index < matches; index += 1) {
    const item = locator.nth(index);
    evidence.push({
      visible: await item.isVisible(),
      ancestorStyles: await item.evaluate((element) => {
        const styles = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          const computed = getComputedStyle(current);
          styles.push({
            tag: current.tagName.toLowerCase(),
            testId: current.getAttribute("data-testid"),
            display: computed.display,
            visibility: computed.visibility,
            opacity: computed.opacity,
            ariaHidden: current.getAttribute("aria-hidden"),
            inert: current.hasAttribute("inert"),
          });
          current = current.parentElement;
        }
        return styles;
      }),
    });
  }
  return evidence;
}

async function exerciseAdvancedDraftRoundTrip(page, context, screenshots) {
  await page.getByTestId("new-task-advanced").click();
  const prompt = page.getByTestId("new-workspace-prompt");
  await prompt.waitFor({ state: "visible", timeout: 10_000 });
  await prompt.fill("ADVANCED_PROMPT_PRESERVE_E2E");
  const defaultMode = page.getByTestId("new-execution-mode-default");
  const orchestrateMode = page.getByTestId("new-execution-mode-orchestrate");
  await defaultMode.waitFor({ state: "visible", timeout: 10_000 });
  await orchestrateMode.click();
  const selectedStyle = await buttonBackground(orchestrateMode);
  const defaultStyle = await buttonBackground(defaultMode);
  assert.notEqual(selectedStyle, defaultStyle, "the non-default execution mode must be visibly selected in Advanced");
  await capture(page, context, screenshots, "after-advanced-prompt-orchestrate-390-light.png", "light");

  await page.getByTestId("new-task-advanced").click();
  const draftInput = page.getByTestId("message-input");
  await draftInput.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await draftInput.inputValue(), "ADVANCED_PROMPT_PRESERVE_E2E", "Advanced → draft must preserve the prompt text");
  assert.match(await page.getByTestId("new-task-draft-options-summary").innerText(), /orchestrate/, "Advanced → draft must retain the non-default execution mode");

  await page.getByTestId("new-task-advanced").click();
  await prompt.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await prompt.inputValue(), "ADVANCED_PROMPT_PRESERVE_E2E", "draft → Advanced must preserve the prompt text");
  assert.equal(await buttonBackground(orchestrateMode), selectedStyle, "draft → Advanced must retain the selected execution-mode state");
  return {
    fieldsExercised: ["prompt", "executionMode"],
    prompt: "ADVANCED_PROMPT_PRESERVE_E2E",
    promptPreserved: true,
    executionMode: "orchestrate",
    selectedModeStyleBefore: selectedStyle,
    selectedModeStyleAfter: await buttonBackground(orchestrateMode),
  };
}

async function buttonBackground(locator) {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function openDrawer(page) {
  const drawer = page.locator('[data-testid="mobile-drawer"]:visible');
  assert.equal(await drawer.count(), 0, "the previous drawer modal must be closed before opening the navigation drawer");
  const trigger = page.locator('[aria-label="任务导航"]:visible:not([aria-modal="true"])');
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await trigger.count(), 1, "Home must expose exactly one navigation drawer trigger");
  await trigger.click();
  await drawer.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await drawer.count(), 1, "opening the drawer must expose exactly one current visible modal");
  return { drawer, state: "opened-from-closed" };
}

async function clickDrawerEntry(page, drawer, target, entry, observations) {
  await target.waitFor({ state: "visible", timeout: 10_000 });
  await target.scrollIntoViewIfNeeded();
  const observation = { entry, initial: await inspectPointerTarget(target) };
  observations.push(observation);
  await waitFor(async () => {
    try {
      observation.last = await inspectPointerTarget(target);
    } catch (error) {
      observation.last = { targetDetachedDuringInspection: true, error: error instanceof Error ? error.message : String(error) };
      return false;
    }
    return observation.last.hitWithinTarget;
  }, 10_000, `${entry} visible drawer entry to receive pointer events`);
  observation.hitTargetReady = true;
  try {
    await target.click();
    observation.clickCompleted = true;
    await drawer.waitFor({ state: "hidden", timeout: 10_000 });
    observation.drawerHiddenAfterNavigation = true;
    assert.equal(await page.locator('[data-testid="mobile-drawer"]:visible').count(), 0,
      `${entry} navigation must finish closing the old drawer modal before the next route assertion`);
  } catch (error) {
    observation.actionError = error instanceof Error ? error.message : String(error);
    observation.afterError = await inspectPointerTarget(target).catch((inspectionError) => ({ error: String(inspectionError) }));
    throw error;
  }
  return observation;
}

async function inspectPointerTarget(target) {
  return target.evaluate((element) => {
    const drawerElement = element.closest('[data-testid="mobile-drawer"]');
    if (!drawerElement) throw new Error("drawer entry is no longer contained by the current mobile-drawer");
    const describe = (node) => {
      if (!(node instanceof Element)) return null;
      const style = getComputedStyle(node);
      return {
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        testId: node.getAttribute("data-testid"),
        ariaLabel: node.getAttribute("aria-label"),
        role: node.getAttribute("role"),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        transform: style.transform,
        ariaHidden: node.getAttribute("aria-hidden"),
        inert: node.hasAttribute("inert"),
      };
    };
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const hitPath = [];
    for (let current = hit; current instanceof Element; current = current.parentElement) {
      hitPath.push(describe(current));
      if (current === element) break;
    }
    const targetAncestors = [];
    for (let current = element; current instanceof Element; current = current.parentElement) {
      targetAncestors.push(describe(current));
      if (current === document.body) break;
    }
    const drawerStyle = getComputedStyle(drawerElement);
    return {
      point: { x: Math.round(x), y: Math.round(y) },
      target: describe(element),
      targetRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      targetAncestors,
      drawer: {
        visible: drawerElement.getClientRects().length > 0,
        opacity: drawerStyle.opacity,
        pointerEvents: drawerStyle.pointerEvents,
        transform: drawerStyle.transform,
      },
      hitElement: describe(hit),
      hitWithinTarget: hit === element || Boolean(hit && element.contains(hit)),
      hitPath,
    };
  });
}

async function closeDrawerIfOpen(page) {
  const drawer = page.locator('[data-testid="mobile-drawer"]:visible');
  const count = await drawer.count();
  assert.ok(count <= 1, "only one current drawer modal may be visible");
  if (count === 0) return { state: "already-closed" };
  await drawer.getByLabel("关闭导航", { exact: true }).click();
  await drawer.waitFor({ state: "hidden", timeout: 10_000 });
  return { state: "closed-by-current-drawer" };
}

async function returnHome(page) {
  await clickNewBackArrow(page);
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(new URL(page.url()).pathname.startsWith("/mobile/h/"), `Back must return to Mobile home: ${page.url()}`);
}

async function openProjectFromAdvancedDraft(page, workspace, rpc) {
  const startingRequests = rpc.workspaceOpenRequests.length;
  const startingResponses = rpc.workspaceOpenResponses.length;
  await page.getByTestId("new-task-add-project").click();
  await page.getByTestId("open-project-route").waitFor({ state: "visible", timeout: 30_000 });
  const directoryInput = page.getByTestId("open-project-path");
  await waitFor(async () => await directoryInput.inputValue() === workspace,
    30_000, "Add Project default path from the paired Local server");
  const openButton = page.getByTestId("open-project-submit");
  await openButton.waitFor({ state: "visible", timeout: 10_000 });
  await waitFor(() => openButton.isEnabled(), 10_000, "server-bound Open Project action to become ready");
  await openButton.click();
  await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(() => rpc.workspaceOpenResponses.length > startingResponses, 15_000, "real runtime.workspaces.openV2 receipt");
  const request = rpc.workspaceOpenRequests.slice(startingRequests).find((item) => item.workspacePath === workspace);
  const response = rpc.workspaceOpenResponses.slice(startingResponses).find((item) => item.result?.workspacePath === workspace || item.result?.requestedPath === workspace);
  assert.ok(request, "Advanced Add Project must dispatch runtime.workspaces.openV2 to the selected server");
  assert.equal(request.serverId, "local", "runtime.workspaces.openV2 must use the server selected by the original draft");
  assert.ok(response, `runtime.workspaces.openV2 must return its real receipt for ${workspace}`);
  assert.equal(response.serverId, "local", "the open-project receipt must return on the same Local server RPC connection");
  assert.equal(response.result.state, "ready", "the open-project V2 receipt must report a ready result");
  assert.equal(response.result.workspacePath, workspace, "the open-project receipt must bind the exact requested workspace");
  return { method: "runtime.workspaces.openV2", request, response, acknowledged: true };
}

async function openHostDetailsNew(page) {
  const homeSettingsButton = page.locator('[aria-label="设置"]:visible:not([aria-modal="true"])');
  await homeSettingsButton.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await homeSettingsButton.count(), 1, "Home must expose exactly one visible settings entry");
  await homeSettingsButton.click();
  const settingsHome = await visibleScreen(page, "settings-home");
  await settingsHome.getByTestId("settings-manage-connections").click();
  const connections = await visibleScreen(page, "settings-connections-screen");
  await connections.getByTestId("settings-host-local").click();
  const hostDetails = await visibleScreen(page, "host-details-route");
  await hostDetails.getByText("在此主机新建对话", { exact: true }).click();
  await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 30_000 });
}

async function returnHomeFromHostDetailsNew(page) {
  await clickNewBackArrow(page);
  const hostDetails = await visibleScreen(page, "host-details-route");
  await hostDetails.getByLabel("返回", { exact: true }).click();
  const connections = await visibleScreen(page, "settings-connections-screen");
  await connections.getByTestId("settings-detail-back").click();
  const settingsHome = await visibleScreen(page, "settings-home");
  await settingsHome.getByTestId("settings-detail-back").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(new URL(page.url()).pathname.startsWith("/mobile/h/"), `Back through Host Details and Settings must return to Mobile home: ${page.url()}`);
  return {
    newToHostDetails: true,
    hostDetailsToConnections: true,
    connectionsToSettingsHome: true,
    settingsHomeToMobileHome: true,
  };
}

async function setThemeThroughSettings(page, theme) {
  await closeDrawerIfOpen(page);
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const settingsButton = page.locator('[aria-label="设置"]:visible:not([aria-modal="true"])');
  await settingsButton.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await settingsButton.count(), 1, "Home must expose exactly one visible settings entry before theme changes");
  await settingsButton.click();
  const settingsHome = await visibleScreen(page, "settings-home");
  await settingsHome.getByTestId("settings-appearance").click();
  const appearance = await visibleScreen(page, "settings-appearance-screen");
  await appearance.getByTestId("settings-theme-row").click();
  const themeSheet = page.locator('[data-testid="settings-choice-sheet-theme"]:visible');
  await themeSheet.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await themeSheet.count(), 1, "the appearance theme picker must expose one current visible choice sheet");
  await themeSheet.getByTestId(`settings-theme-choice-${theme}`).click();
  await themeSheet.waitFor({ state: "hidden", timeout: 10_000 });
  await assertDocumentTheme(page, theme);
  await appearance.getByTestId("settings-detail-back").click();
  const homeAfterAppearance = await visibleScreen(page, "settings-home");
  await homeAfterAppearance.getByTestId("settings-detail-back").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function visibleScreen(page, testId) {
  const screen = page.locator(`[data-testid="${testId}"]:visible`);
  await screen.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await screen.count(), 1, `expected exactly one visible ${testId} screen`);
  return screen;
}

async function assertDocumentTheme(page, theme) {
  await page.waitForFunction((expected) => document.documentElement.style.colorScheme === expected, theme, { timeout: 10_000 });
}

async function runLateReceiptRegression(page, context, rpc, screenshots) {
  await page.getByTestId("message-input").fill("CREATION_ROUTE_OWNER");
  rpc.holdNextThreadStart = true;
  await page.getByTestId("send-message").click();
  await waitFor(() => rpc.heldThreadStart, 15_000, "genuine thread/start success receipt held");
  await clickNewBackArrow(page);
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const chosenRoute = new URL(page.url()).pathname;
  assert.ok(chosenRoute.startsWith("/mobile/h/"), "the user must be able to choose Home while the real receipt is held");
  rpc.heldThreadStart();
  await waitFor(() => rpc.acceptedTurns === 1, 15_000, "one accepted real turn/start RPC");
  await waitFor(() => rpc.releasedThreadStartReceipts === 1, 10_000, "held thread/start receipt release");
  await page.waitForTimeout(LATE_RECEIPT_QUIET_WINDOW_MS);
  assert.equal(new URL(page.url()).pathname, chosenRoute, "a late receipt must not replace the route chosen after leaving New task");
  assert.equal(await page.locator('[data-testid="task-header"]:visible').count(), 0, "late receipt must not show the created task over the user-chosen Home route");
  await capture(page, context, screenshots, "current-creation-keeps-home-route.png", "dark");
  assert.equal(rpc.successfulThreadStarts, 1, "the held thread/start receipt must execute once");
  assert.equal(rpc.releasedThreadStartReceipts, 1, "the held real thread/start receipt must be released exactly once");
  return {
    chosenRoute,
    routeAfterRelease: new URL(page.url()).pathname,
    visibleTaskHeaderCount: 0,
    heldThreadStartReceipts: rpc.releasedThreadStartReceipts,
    acceptedTurns: rpc.acceptedTurns,
    quietObservationWindowMs: LATE_RECEIPT_QUIET_WINDOW_MS,
    observationLimit: "Route and visible task-header state were checked after the accepted turn and remained stable for the recorded 400ms quiet window; this does not cover arbitrarily delayed callbacks.",
  };
}

async function capture(page, context, screenshots, name, theme) {
  const path = context.pathInArtifacts(name);
  await page.screenshot({ path, animations: "disabled", fullPage: true });
  const bytes = await readFile(path);
  assert.equal(bytes.toString("ascii", 1, 4), "PNG", `screenshot ${name} must be a PNG`);
  const record = {
    path,
    sha256: sha256(bytes),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    viewport: page.viewportSize(),
    theme,
    locale: await page.locator("html").getAttribute("lang"),
    route: new URL(page.url()).pathname,
    routeContext: routeContext(new URL(page.url())),
  };
  assert.equal(record.locale, "zh-CN", `screenshot ${name} must use the requested Chinese locale`);
  if (screenshots) screenshots.push(record);
  return record;
}

function profileIdFromUrl(url) {
  const path = new URL(url).pathname.split("/").filter(Boolean);
  const profileId = decodeURIComponent(path[path.indexOf("h") + 1] ?? "");
  assert.ok(profileId, `paired Mobile home URL must include a profileId: ${url}`);
  return profileId;
}

function routeContext(url) {
  return {
    profileIdPresent: Boolean(url.searchParams.get("profileId")),
    serverId: url.searchParams.get("serverId"),
    cwd: url.searchParams.get("cwd"),
  };
}

function summarizeWorkspaceReceipt(result) {
  const receipt = result?.receipt ?? result?.operationReceipt ?? null;
  return {
    requestedPath: result?.request?.workspacePath ?? result?.workspacePath ?? result?.result?.workspacePath ?? null,
    workspacePath: typeof result?.result === "string" ? result.result : result?.receipt?.workspacePath ?? result?.result?.path ?? result?.result?.workspacePath ?? result?.resultPath ?? result?.workspace?.path ?? null,
    receiptVersion: receipt?.version ?? result?.version ?? 2,
    receiptId: receipt?.clientRequestId ?? receipt?.id ?? receipt?.receiptId ?? result?.receiptId ?? null,
    operationId: receipt?.operationId ?? result?.operationId ?? null,
    state: receipt?.status ?? receipt?.state ?? result?.state ?? null,
  };
}

function summarizeRpc(rpc) {
  return {
    requests: rpc.requests,
    responses: rpc.responses,
    workspaceOpenRequests: rpc.workspaceOpenRequests,
    workspaceOpenResponses: rpc.workspaceOpenResponses,
    successfulThreadStarts: rpc.successfulThreadStarts,
    acceptedTurns: rpc.acceptedTurns,
    releasedThreadStartReceipts: rpc.releasedThreadStartReceipts,
    threadId: rpc.threadId,
  };
}

async function inspectImmutableBaseline(rootPath) {
  const root = await realpath(rootPath);
  const manifestPath = resolve(root, "kcoder-mobile-web.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.version, 1, "baseline Mobile Gateway manifest must use version 1");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === 48, "baseline archive must contain the pinned 48 resources");
  const normalizedResources = [];
  for (const resource of manifest.files) {
    assert.equal(typeof resource.path, "string");
    const filePath = resolve(root, resource.path);
    assert.ok(filePath.startsWith(`${root}${sep}`), `baseline manifest path must stay under its root: ${resource.path}`);
    const info = await lstat(filePath);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `baseline resource must be a regular non-symlink file: ${resource.path}`);
    assert.equal(info.size, resource.size, `baseline resource size changed: ${resource.path}`);
    const digest = sha256(await readFile(filePath));
    assert.equal(digest, resource.sha256, `baseline resource hash changed: ${resource.path}`);
    normalizedResources.push({ path: resource.path, size: resource.size, sha256: resource.sha256 });
  }
  const entry = manifest.files.find((resource) => resource.path === "_expo/static/js/web/entry-97911032e9ab8e90b8aea2551af0f0f6.js");
  assert.ok(entry, "pinned baseline entry chunk must exist");
  assert.equal(entry.sha256, BASELINE_ENTRY_SHA256, "pinned baseline entry chunk must match the separately verified pre-change SHA-256");
  const archivePath = resolve(root, "..", "mobile-web.tar.gz");
  const archiveInfo = await lstat(archivePath);
  assert.ok(archiveInfo.isFile() && !archiveInfo.isSymbolicLink(), "baseline archive must be a regular file");
  return {
    root,
    revision: BASELINE_SOURCE_REVISION,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    resourceCount: manifest.files.length,
    resourceSetSha256: sha256(Buffer.from(JSON.stringify(normalizedResources))),
    archivePath,
    archiveSha256: sha256(await readFile(archivePath)),
    entry: { path: entry.path, size: entry.size, sha256: entry.sha256 },
    sourceTreeSha256: null,
    dependencySourceTreeSha256: null,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
