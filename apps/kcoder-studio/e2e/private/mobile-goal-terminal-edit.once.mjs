import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { startApprovalModelFixture } from "../harness/approval-model.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { captureMobileExportSourceSnapshot } from "../harness/mobile-export-source-snapshot.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { createMobileLatencyHelpers } from "../harness/mobile-latency-helpers.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from "../harness/run-context.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";

const READONLY_EXPLANATION = "此目标当前状态不支持编辑。你可以查看或清除它。";
const TERMINAL_STATUS = "budgetLimited";
const PINNED_KCODER_SHA256 = "7a87160fcf92c32654cfccdb501229c2ee02f6d251c5095be8ba8541e5137d76";
const F8_COMMIT = "f8d732422b07cc82edb754530d85ee4406a54477";
const AFTER_COMMIT = "d56dba7a10d633584b1800240edbdc66285f2f02";
const F8_BUNDLE_SHA256 = "3cd3558160c6e3f24bb48ea7443a84e0d05766a98f0a5e1bf09300622e4732bb";
const F8_SOURCE_TREE_SHA256 = "a32a1846da0486bd2c484967cd3672459a26f5131c98cefa1b8ad58e23153b4e";
const F8_DEPENDENCY_TREE_SHA256 = "9ffa00cbfe86e9181d2c517f15251358fe8607a7f108b7c3ed22fa06cfc000cd";
const F8_RUN_ROOT = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/mobile-ux-visual-diff.once.mjs/20261013-091631.571Z");
const F8_PROVENANCE_PATH = resolve(F8_RUN_ROOT, "artifacts/mobile-web-after-provenance.json");
const captureBefore = process.argv.includes("--capture-before-ui");
const captureAfter = process.argv.includes("--capture-after-ui");
assert.notEqual(captureBefore, captureAfter, "choose exactly one mode: --capture-before-ui or --capture-after-ui");
const mode = captureBefore ? "before" : "after";
process.umask(0o077);

await runE2E(import.meta.url, {
  testId: "mobile-goal-terminal-edit",
  tier: "one-off-acceptance",
  modelPolicy: "paired model-independent Mobile Web terminal Goal acceptance; one bounded loopback fixture turn only, no live Provider requests",
  retainSuccessLogs: true,
}, async context => {
  const mobileWeb = mode === "before"
    ? await verifyF8BaselineBundle(context)
    : await exportFrozenAfterBundle(context);
  await context.writeArtifactJson("mobile-goal-terminal-web-input.json", mobileWeb);

  const binarySource = process.env.KCODER_E2E_KCODER_BIN
    || resolve(repoRoot, "../Kunlun-Code-CYX/target/debug/kcoder");
  assert.ok(await requireExecutable(binarySource, "KCoder CLI app-server"), "KCoder CLI app-server must be available");
  assert.ok(resolve(binarySource) === binarySource, "KCoder CLI path must be absolute");
  const binaryInfo = await lstat(binarySource);
  assert.ok(binaryInfo.isFile() && !binaryInfo.isSymbolicLink(), "KCoder CLI source must be a regular non-symlink file");
  const binarySha256 = await hashFile(binarySource);
  assert.equal(binarySha256, PINNED_KCODER_SHA256, "KCoder CLI binary differs from the pinned backend used for both visual lanes");
  const ownedBinary = context.pathInState("mobile-goal-terminal-kcoder");
  await copyFile(binarySource, ownedBinary);
  await chmod(ownedBinary, 0o500);
  assert.equal(await hashFile(ownedBinary), binarySha256, "RunContext-owned CLI copy must retain its source hash");

  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "mobile-goal-terminal",
  });
  const configDir = context.pathInState("mobile-goal-terminal-config");
  await mkdir(configDir, { recursive: false, mode: 0o700 });
  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    textOnlyResponse: "MOBILE_GOAL_TERMINAL_LOCAL_FIXTURE_REPLY",
  });
  const settingsFile = await context.writeStateJson("mobile-goal-terminal-settings.json", {
    active_provider: "mobile-goal-terminal-fixture",
    permission_mode: "yolo",
    providers: {
      "mobile-goal-terminal-fixture": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "mobile-goal-terminal-fixture",
        context_window_tokens: 128000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("mobile-goal-terminal-config/settings.json", {});
  await context.writeStateJson("mobile-goal-terminal-config/credentials.json", {
    "mobile-goal-terminal-fixture": { type: "api", key: "deterministic-local" },
  });
  const serversFile = await context.writeStateJson("mobile-goal-terminal-servers.json", [{
    id: "local",
    label: "本机",
    transport: "local",
    command: ownedBinary,
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-goal-terminal-gateway",
    workspace,
    serversFile,
    kcoderBin: ownedBinary,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_WEB_ROOT: mobileWeb.bundleRoot,
    },
  });

  const chromium = await startChromium(context, { label: "mobile-goal-terminal-chromium" });
  const browserContext = await chromium.browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  context.addCleanup("close owned Goal terminal browser context", async () => {
    await browserContext.close();
  });
  const page = await browserContext.newPage();
  context.addCleanup("close owned Goal terminal browser page", async () => {
    await page.close();
  });
  await page.addInitScript(() => {
    localStorage.setItem("kcoder-studio:mobile-app-preferences:v1", JSON.stringify({
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 10_000,
      conversationFontScale: "normal",
      conversationLineSpacing: "normal",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: true,
      toolsCollapsedByDefault: true,
      quickPhrases: [],
    }));
  });

  const diagnostics = [];
  const browserGoalRequests = [];
  const browserGoalResponses = [];
  const goalNotifications = [];
  const fixtureWrites = [];
  const goalRpcFixture = await installGoalRpcFixtureBridge(page, {
    browserGoalRequests,
    browserGoalResponses,
    goalNotifications,
    fixtureWrites,
  });
  page.on("pageerror", error => diagnostics.push("pageerror: " + error.message));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push("console: " + message.text());
  });

  let stage = "mobile-connect";
  let threadId = null;
  try {
    await connectMobile(page, gateway);
    stage = "create-real-browser-thread";
    await page.getByText("在此项目新建任务", { exact: true }).click();
    await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-input").fill("MOBILE_GOAL_TERMINAL_BOOTSTRAP");
    await page.getByTestId("send-message").click();
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
    await page.getByTestId("message-user").filter({ hasText: "MOBILE_GOAL_TERMINAL_BOOTSTRAP" })
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.getByText("MOBILE_GOAL_TERMINAL_LOCAL_FIXTURE_REPLY", { exact: true })
      .waitFor({ state: "visible", timeout: 60_000 });
    threadId = threadIdFromUrl(page.url());
    assert.ok(threadId, "the browser-created task route must identify the real thread");
    await waitFor(() => model.requests.length === 1, 30_000, "single bounded local model fixture turn");

    stage = "seed-server-goal";
    const firstGoal = await goalRpcFixture.request("thread/goal/set", {
      threadId,
      objective: "MOBILE_GOAL_TERMINAL_EXISTING",
      requireNoGoal: true,
    });
    assert.equal(firstGoal.goal?.threadId, threadId);
    assert.equal(firstGoal.goal?.status, "active");
    await waitForGoalNotification(goalNotifications, threadId, firstGoal.goal, "active");
    await page.getByTestId("task-goal-controls").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("task-goal-objective").filter({ hasText: "MOBILE_GOAL_TERMINAL_EXISTING" })
      .waitFor({ state: "visible", timeout: 30_000 });

    stage = "existing-terminal-goal";
    const terminalGoal = await setBudgetLimited(goalRpcFixture, threadId, firstGoal.goal);
    const authoritativeTerminal = await goalRpcFixture.request("thread/goal/get", { threadId }, threadId);
    assert.equal(authoritativeTerminal.goal?.goalId, terminalGoal.goalId);
    assert.equal(authoritativeTerminal.goal?.revision, terminalGoal.revision);
    assert.equal(authoritativeTerminal.goal?.status, TERMINAL_STATUS,
      "terminal fixture state must come from the real app-server Goal projection");
    await waitForGoalNotification(goalNotifications, threadId, terminalGoal, TERMINAL_STATUS);
    await page.getByTestId("task-goal-status").filter({ hasText: "预算受限" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("task-goal-expand").click();
    if (mode === "before") {
      assert.equal(await page.getByTestId("task-goal-edit").count(), 1,
        "the pinned f8d bundle must reproduce its terminal edit affordance");
      await page.screenshot({
        path: context.pathInArtifacts("mobile-goal-terminal-before-edit-visible.png"),
        animations: "disabled",
      });

      stage = "old-terminal-edit-rejected-by-server";
      await page.getByTestId("task-goal-edit").click();
      await page.getByTestId("task-goal-edit-input").fill("MOBILE_GOAL_TERMINAL_EDIT_REJECTED");
      await page.getByTestId("task-goal-save").click();
      const editRequest = await waitFor(() => browserGoalRequests.find(request =>
        request.method === "thread/goal/set" && request.edit && request.threadId === threadId,
      ) ?? null, 30_000, "browser terminal Goal edit RPC");
      const editResponse = await waitFor(() => browserGoalResponses.find(response =>
        response.socketId === editRequest.socketId && response.id === editRequest.id &&
        response.method === "thread/goal/set" &&
        response.errorMessage === "terminal goal cannot be edited",
      ) ?? null, 30_000, "real server rejection for old terminal Goal edit UI");
      assert.ok(editResponse, "the real app-server must reject the old UI's edit=true RPC");
      assert.equal(editResponse.threadId, threadId, "old edit rejection must belong to the browser-created thread");
      await page.getByTestId("task-goal-error").filter({ hasText: "terminal goal cannot be edited" })
        .waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(browserGoalRequests.filter(request => request.edit).length, 1,
        "the before bundle must send exactly one real terminal edit attempt");
      await page.screenshot({
        path: context.pathInArtifacts("mobile-goal-terminal-before-edit-rejected.png"),
        animations: "disabled",
      });
      const rejectedGoal = await goalRpcFixture.request("thread/goal/get", { threadId }, threadId);
      assert.equal(rejectedGoal.goal?.goalId, terminalGoal.goalId);
      assert.equal(rejectedGoal.goal?.revision, terminalGoal.revision);
      assert.equal(rejectedGoal.goal?.status, TERMINAL_STATUS,
        "server rejection must leave the terminal Goal unchanged");
      const beforeClear = await goalRpcFixture.request("thread/goal/clear", {
        threadId,
        expectedGoalId: terminalGoal.goalId,
        expectedRevision: terminalGoal.revision,
      }, threadId);
      assert.equal(beforeClear.cleared, true, "before-case Goal cleanup must receive a real server receipt");
      await waitFor(() => goalNotifications.some(event => event.threadId === threadId && event.isCleared),
        30_000, "real server clear notification after old UI rejection");
      const finalGoal = await goalRpcFixture.request("thread/goal/get", { threadId }, threadId);
      assert.equal(finalGoal.goal, null, "before-case fixture must be cleaned up on the real server");
      assert.equal(model.requests.length, 1, "before-case rejection must not start further model turns");
      assert.deepEqual(diagnostics, [], "browser must not report console or page errors");
      const result = {
        mode,
        evidenceClass: "f8d Mobile Web bundle with pinned real KCoder app-server, isolated Chromium, and real server Goal lifecycle",
        fixtureTransport: "browser edit attempt and fixture state setup use the same browser-owned Gateway WebSocket and real app-server; no DOM or React state is injected",
        threadId,
        terminalStatus: TERMINAL_STATUS,
        serverFixtureWrites: fixtureWrites,
        browserGoalRequests,
        browserGoalResponses,
        browserGoalNotifications: goalNotifications,
        terminalEditCase: {
          editControlVisible: true,
          editRequestReachedServer: true,
          serverError: editResponse.errorMessage,
          goalUnchangedAfterRejection: true,
        },
        localModelFixtureRequests: model.requests.length,
        externalProviderRequests: 0,
        nativeAndroidImeExercised: false,
        screenshots: [
          "mobile-goal-terminal-before-edit-visible.png",
          "mobile-goal-terminal-before-edit-rejected.png",
        ],
        cliSha256: binarySha256,
        sourceCommit: mobileWeb.sourceCommit,
        mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
        mobileBundleSha256: mobileWeb.bundleSha256,
        browserDiagnostics: diagnostics,
      };
      await context.writeArtifactJson("mobile-goal-terminal-evidence.json", result);
      return result;
    }

    assert.equal(await page.getByTestId("task-goal-edit").count(), 0,
      "the current terminal Goal must not expose an edit action");
    await page.getByTestId("task-goal-terminal-readonly").filter({ hasText: READONLY_EXPLANATION })
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(browserGoalRequests.filter(request => request.edit).length, 0,
      "terminal Goal display must not send an edit RPC");
    await page.screenshot({
      path: context.pathInArtifacts("mobile-goal-terminal-after-readonly.png"),
      animations: "disabled",
    });

    stage = "clear-real-server-goal-for-race-case";
    const clearResult = await goalRpcFixture.request("thread/goal/clear", {
      threadId,
      expectedGoalId: terminalGoal.goalId,
      expectedRevision: terminalGoal.revision,
    }, threadId);
    assert.equal(clearResult.cleared, true, "real terminal Goal fixture cleanup must receive a server receipt");
    await waitFor(() => goalNotifications.some(event => event.threadId === threadId && event.isCleared),
      30_000, "real server clear notification to the browser owner");
    await page.getByTestId("task-goal-controls").waitFor({ state: "detached", timeout: 30_000 });

    stage = "seed-active-goal-for-edit-race";
    const raceGoal = await goalRpcFixture.request("thread/goal/set", {
      threadId,
      objective: "MOBILE_GOAL_TERMINAL_RACE_BASE",
      requireNoGoal: true,
    });
    assert.equal(raceGoal.goal?.status, "active");
    await waitForGoalNotification(goalNotifications, threadId, raceGoal.goal, "active");
    await page.getByTestId("task-goal-objective").filter({ hasText: "MOBILE_GOAL_TERMINAL_RACE_BASE" })
      .waitFor({ state: "visible", timeout: 30_000 });

    stage = "open-editor-before-terminal-broadcast";
    await page.getByTestId("task-goal-edit").click();
    const editInput = page.getByTestId("task-goal-edit-input");
    await editInput.waitFor({ state: "visible", timeout: 10_000 });
    await editInput.fill("MOBILE_GOAL_EDIT_DRAFT_RETAINED");
    const notificationsBeforeTerminal = goalNotifications.length;
    const editRequestsBeforeTerminal = browserGoalRequests.filter(request => request.edit).length;

    stage = "broadcast-terminal-state-while-editor-open";
    const raceTerminal = await setBudgetLimited(goalRpcFixture, threadId, raceGoal.goal);
    const terminalNotification = await waitFor(() => {
      const event = goalNotifications.slice(notificationsBeforeTerminal).find(candidate =>
        candidate.threadId === threadId && candidate.goalId === raceTerminal.goalId &&
        candidate.revision === raceTerminal.revision && candidate.status === TERMINAL_STATUS,
      );
      return event ?? null;
    }, 30_000, "real thread/goal/updated terminal notification while editor is open");
    assert.ok(terminalNotification, "the browser must receive the real server terminal-state notification");
    await editInput.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await editInput.inputValue(), "MOBILE_GOAL_EDIT_DRAFT_RETAINED",
      "terminal-state notification must preserve unsaved edit text");
    await page.getByTestId("task-goal-edit-state-changed").filter({ hasText: READONLY_EXPLANATION })
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.getByTestId("task-goal-save").isDisabled(), true,
      "a stale edit modal must disable Save after a terminal server notification");
    assert.equal(browserGoalRequests.filter(request => request.edit).length, editRequestsBeforeTerminal,
      "terminal-state notification must not issue an edit RPC");
    await page.screenshot({
      path: context.pathInArtifacts("mobile-goal-terminal-after-edit-race.png"),
      animations: "disabled",
    });

    const finalGoal = await goalRpcFixture.request("thread/goal/get", { threadId }, threadId);
    assert.equal(finalGoal.goal?.goalId, raceTerminal.goalId);
    assert.equal(finalGoal.goal?.revision, raceTerminal.revision);
    assert.equal(finalGoal.goal?.status, TERMINAL_STATUS);
    assert.equal(model.requests.length, 1, "Goal setup and terminal race must not start further model turns");
    assert.deepEqual(diagnostics, [], "browser must not report console or page errors");

    const result = {
      mode,
      evidenceClass: "current Mobile Web bundle with pinned real KCoder app-server, isolated Chromium, and real server Goal lifecycle; local fixture response only bootstraps one browser-owned thread",
      fixtureTransport: "actual Goal RPCs use the same browser-owned Gateway WebSocket and real app-server; no DOM or React state is injected",
      threadId,
      terminalStatus: TERMINAL_STATUS,
      serverFixtureWrites: fixtureWrites,
      authoritativeTerminalRead: summarizeServerWrite("get-after-race", finalGoal.goal),
      browserGoalRequests,
      browserGoalResponses,
      browserGoalNotifications: goalNotifications,
      existingTerminalCase: {
        editControlAbsent: true,
        readonlyExplanationVisible: true,
        editRpcCount: browserGoalRequests.filter(request => request.edit).length,
      },
      openModalRaceCase: {
        serverNotificationObserved: true,
        editDraftPreserved: true,
        saveDisabled: true,
        noEditRpc: browserGoalRequests.filter(request => request.edit).length === editRequestsBeforeTerminal,
      },
      localModelFixtureRequests: model.requests.length,
      externalProviderRequests: 0,
      nativeAndroidImeExercised: false,
      screenshots: [
        "mobile-goal-terminal-after-readonly.png",
        "mobile-goal-terminal-after-edit-race.png",
      ],
      cliSha256: binarySha256,
      sourceCommit: mobileWeb.sourceCommit,
      mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
      mobileBundleSha256: mobileWeb.bundleSha256,
      browserDiagnostics: diagnostics,
    };
    await context.writeArtifactJson("mobile-goal-terminal-evidence.json", result);
    return result;
  } catch (error) {
    await context.writeArtifactJson("mobile-goal-terminal-failure.json", {
      stage,
      error: error instanceof Error ? error.message : String(error),
      threadId,
      serverFixtureWrites: fixtureWrites,
      browserGoalRequests,
      browserGoalResponses,
      browserGoalNotifications: goalNotifications,
      browserDiagnostics: diagnostics,
      modelFixtureRequests: model.requests.length,
      pageText: await page.locator("body").innerText().catch(() => null),
      cliSha256: binarySha256,
      sourceCommit: mobileWeb.sourceCommit,
      mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
      mobileBundleSha256: mobileWeb.bundleSha256,
    });
    await page.screenshot({
      path: context.pathInArtifacts("mobile-goal-terminal-failure.png"),
      fullPage: true,
      animations: "disabled",
    }).catch(() => undefined);
    throw error;
  }
});

async function verifyF8BaselineBundle() {
  const runManifest = JSON.parse(await readFile(resolve(F8_RUN_ROOT, "manifest.json"), "utf8"));
  assert.equal(runManifest.status, "passed", "f8d before browser run must have passed");
  assert.equal(runManifest.gitCommit, F8_COMMIT, "f8d before browser run must identify the frozen product commit");
  const provenance = JSON.parse(await readFile(F8_PROVENANCE_PATH, "utf8"));
  assert.equal(provenance.bundleSha256, F8_BUNDLE_SHA256);
  assert.equal(provenance.bundleSourceTreeSha256, F8_SOURCE_TREE_SHA256);
  assert.equal(provenance.dependencySourceTreeSha256, F8_DEPENDENCY_TREE_SHA256);
  const bundleRoot = resolve(provenance.bundleRoot);
  assert.equal(bundleRoot, resolve(F8_RUN_ROOT, "artifacts/mobile-web-after"),
    "the old lane must use the exact f8d after bundle");
  assert.ok(isAbsolute(provenance.pairedAfterExportManifestPath), "f8d export manifest path must be absolute");
  const e2eArtifactRoot = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
  assert.ok(provenance.pairedAfterExportManifestPath.startsWith(`${e2eArtifactRoot}${sep}`),
    "f8d export manifest must remain under the E2E artifact root");
  const exportManifest = JSON.parse(await readFile(provenance.pairedAfterExportManifestPath, "utf8"));
  assert.equal(exportManifest.status, "complete", "f8d source export must have completed");
  assert.equal(exportManifest.failurePhase, null);
  assert.equal(exportManifest.sourceTreeSha256, F8_SOURCE_TREE_SHA256);
  assert.equal(exportManifest.buildInputTreeBeforeCopySha256, F8_SOURCE_TREE_SHA256);
  assert.equal(exportManifest.buildInputTreeAfterExportSha256, F8_SOURCE_TREE_SHA256);
  assert.equal(exportManifest.bundleSha256, F8_BUNDLE_SHA256);
  assert.equal(exportManifest.dependencyProvenance?.sourceTreeSha256Before, F8_DEPENDENCY_TREE_SHA256);
  assert.equal(exportManifest.dependencyProvenance?.sourceTreeSha256After, F8_DEPENDENCY_TREE_SHA256);
  const bundleFiles = await hashRegularTree(bundleRoot);
  assert.deepEqual(bundleFiles, exportManifest.bundleFiles,
    "f8d bundle file inventory must match its original exporter manifest");
  assert.equal(hashJson(bundleFiles), F8_BUNDLE_SHA256,
    "f8d bundle bytes must match the pinned original export hash");
  return {
    mode,
    evidenceClass: "reused f8d Mobile Web bundle; verified against original browser-run manifest, exporter manifest, and full bundle tree",
    bundleRoot,
    bundleSha256: F8_BUNDLE_SHA256,
    sourceCommit: F8_COMMIT,
    sourceTreeSha256: F8_SOURCE_TREE_SHA256,
    dependencySourceTreeSha256: F8_DEPENDENCY_TREE_SHA256,
    browserRunManifest: resolve(F8_RUN_ROOT, "manifest.json"),
    exporterManifest: provenance.pairedAfterExportManifestPath,
    provenancePath: F8_PROVENANCE_PATH,
  };
}

async function exportFrozenAfterBundle(context) {
  const sourceRoot = requiredAbsolutePath("KCODER_E2E_MOBILE_GOAL_TERMINAL_SOURCE_ROOT");
  const sourceCommit = process.env.KCODER_E2E_MOBILE_GOAL_TERMINAL_SOURCE_HEAD;
  assert.equal(sourceCommit, AFTER_COMMIT, "after source must be the pinned Goal owner-fence commit");
  const expectedSourceTreeSha256 = process.env.KCODER_E2E_MOBILE_GOAL_TERMINAL_SOURCE_SHA256;
  if (expectedSourceTreeSha256 !== undefined) assertSha256(expectedSourceTreeSha256, "expected after source tree hash");
  const expectedDependencySha256 = process.env.KCODER_E2E_MOBILE_GOAL_TERMINAL_DEPENDENCY_SHA256
    || F8_DEPENDENCY_TREE_SHA256;
  assert.equal(expectedDependencySha256, F8_DEPENDENCY_TREE_SHA256,
    "paired before/after runs must use the exact f8 dependency source tree");

  await assertPhysicalDirectory(sourceRoot, "frozen source root");
  const mobileRoot = resolve(sourceRoot, "apps/kcoder-studio/mobile");
  const sharedRoot = resolve(sourceRoot, "apps/kcoder-studio/shared");
  assert.notEqual(await realpath(mobileRoot), resolve(appRoot, "mobile"),
    "after export must not read the mutable checkout's Mobile source");
  const snapshotRoot = context.pathInArtifacts("after-source-snapshot");
  const snapshot = await captureMobileExportSourceSnapshot({
    sourceRoots: [
      { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
    ],
    snapshotRoot,
    layout: "preflight-source-root",
    freezeFiles: true,
  });
  if (expectedSourceTreeSha256) assert.equal(snapshot.sourceTreeSha256, expectedSourceTreeSha256,
    "frozen after source hash differs from the caller's explicit source pin");
  await context.writeArtifactJson("mobile-goal-terminal-source-snapshot.json", {
    schemaVersion: 1,
    mode,
    sourceCommit,
    sourceRoot,
    snapshotRoot,
    sourceTreeSha256: snapshot.sourceTreeSha256,
    fileCount: snapshot.fileCount,
    byteCount: snapshot.byteCount,
    roots: snapshot.roots,
    evidenceClass: "Git-archive source identified by pinned commit; bytes copied to a read-only RunContext snapshot before export",
  });
  await context.writeArtifactJson("mobile-goal-terminal-source-inventory.json", snapshot);

  const snapshotMobileRoot = resolve(snapshotRoot, "apps/kcoder-studio/mobile");
  const snapshotSharedRoot = resolve(snapshotRoot, "apps/kcoder-studio/shared");
  const dependencySnapshot = await createMobileLatencyHelpers({}).createDependencySnapshot(
    context,
    resolve(appRoot, "mobile"),
  );
  const dependencyRoot = dependencySnapshot.path;
  await assertPhysicalDirectory(dependencyRoot, "RunContext-owned frozen dependency root");
  const dependencyFiles = await hashRegularTree(dependencyRoot);
  const dependencyRootSha256 = hashJson(dependencyFiles);
  const dependencySourceTreeSha256 = hashJson([{
    name: "mobile-dependencies",
    destination: "apps/kcoder-studio/mobile/node_modules",
    sha256: dependencyRootSha256,
  }]);
  await context.writeArtifactJson("mobile-goal-terminal-dependency-preflight.json", {
    sourceRoot: dependencySnapshot.sourceRoot,
    snapshotRoot: dependencyRoot,
    fileCount: dependencyFiles.length,
    sourceTreeSha256: dependencySourceTreeSha256,
    expectedSourceTreeSha256: expectedDependencySha256,
    hashMatchesF8Before: dependencySourceTreeSha256 === expectedDependencySha256,
  });
  assert.equal(dependencySourceTreeSha256, expectedDependencySha256,
    "installed dependencies differ from the pinned f8d before dependency tree; stop before Web export");
  const exported = await exportMobileWeb(context, {
    mobileRoot: snapshotMobileRoot,
    sourceRoots: [
      { name: "mobile", path: snapshotMobileRoot, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: snapshotSharedRoot, destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot,
    label: "mobile-goal-terminal-after-export",
    outputName: "mobile-goal-terminal-after-web",
    timeoutMs: 10 * 60_000,
    overallTimeoutMs: 45 * 60_000,
  });
  assert.equal(exported.sourceTreeSha256, snapshot.sourceTreeSha256);
  assert.equal(exported.buildInputTreeSha256, snapshot.sourceTreeSha256);
  assert.equal(exported.dependencySourceTreeSha256, expectedDependencySha256,
    "after export did not use the same pinned dependency source as f8d before");
  const exportedBundleFiles = await hashRegularTree(exported.path);
  assert.equal(hashJson(exportedBundleFiles), exported.bundleSha256,
    "exported after bundle bytes do not match the exporter's bundle hash");
  const retainedBundleRoot = context.pathInArtifacts("mobile-goal-terminal-after-web");
  await copyRegularTree(exported.path, retainedBundleRoot);
  const retainedBundleFiles = await hashRegularTree(retainedBundleRoot);
  assert.deepEqual(retainedBundleFiles, exportedBundleFiles,
    "RunContext-retained after bundle must match the frozen export byte-for-byte");
  assert.equal(hashJson(retainedBundleFiles), exported.bundleSha256,
    "RunContext-retained after bundle hash differs from the frozen export");
  await context.writeArtifactJson("mobile-goal-terminal-after-bundle-retained.json", {
    sourceCommit,
    sourceTreeSha256: snapshot.sourceTreeSha256,
    dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    exporterBundleRoot: exported.path,
    retainedBundleRoot,
    bundleSha256: exported.bundleSha256,
    bundleFileCount: retainedBundleFiles.length,
    exporterMatchesRetainedBundle: true,
    evidenceClass: "byte-for-byte copy of the verified Web export retained under this RunContext artifacts before Gateway or Chromium starts",
  });
  await context.writeArtifactJson("mobile-goal-terminal-dependency-snapshot.json", {
    ...dependencySnapshot,
    sourceTreeSha256: exported.dependencySourceTreeSha256,
    expectedSourceTreeSha256: expectedDependencySha256,
    hashMatchesF8Before: true,
  });
  const result = {
    mode,
    evidenceClass: "Git-archive Mobile/shared source and fixed dependency source copied and verified by the RunContext exporter before Gateway startup",
    sourceCommit,
    sourceRoot,
    sourceSnapshotRoot: snapshotRoot,
    sourceTreeSha256: exported.sourceTreeSha256,
    buildInputTreeSha256: exported.buildInputTreeSha256,
    dependencyRoot,
    dependencySnapshotSource: dependencySnapshot.sourceRoot,
    dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    exporterBundleRoot: exported.path,
    bundleRoot: retainedBundleRoot,
    bundleSha256: exported.bundleSha256,
    bundleFileCount: retainedBundleFiles.length,
    indexHtmlSha256: exported.indexHtmlSha256,
  };
  await context.writeArtifactJson("mobile-goal-terminal-export.json", result);
  return result;
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), `set ${name} to an absolute frozen input path`);
  assert.equal(resolve(value), value, `${name} must be normalized`);
  return value;
}

async function assertPhysicalDirectory(path, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a physical directory`);
  assert.equal(await realpath(path), path, `${label} must not traverse a symlink`);
}

async function hashRegularTree(root) {
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "bundle root must be a regular directory");
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), "bundle tree must not contain symlinks");
      if (info.isDirectory()) await visit(path);
      else {
        assert.ok(info.isFile(), "bundle tree must contain only regular files and directories");
        const bytes = await readFile(path);
        const pathName = relative(root, path).split(sep).join("/");
        files.push({ path: pathName, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function copyRegularTree(sourceRoot, destinationRoot) {
  const rootInfo = await lstat(sourceRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "bundle source must be a regular directory");
  await mkdir(destinationRoot, { mode: 0o700 });
  async function visit(sourceDirectory, destinationDirectory) {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = resolve(sourceDirectory, entry.name);
      const destinationPath = resolve(destinationDirectory, entry.name);
      const info = await lstat(sourcePath);
      assert.ok(!info.isSymbolicLink(), "bundle source must not contain symlinks");
      if (info.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await visit(sourcePath, destinationPath);
      } else {
        assert.ok(info.isFile(), "bundle source must contain only regular files");
        await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      }
    }
  }
  await visit(sourceRoot, destinationRoot);
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertSha256(value, label) {
  assert.match(value ?? "", /^[a-f0-9]{64}$/, `${label} must be a SHA-256 hex digest`);
}

async function connectMobile(page, gateway) {
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

async function setBudgetLimited(rpc, threadId, goal) {
  assert.ok(goal?.goalId && Number.isInteger(goal.revision), "server Goal fixture requires a real ID and revision");
  const result = await rpc.request("thread/goal/set", {
    threadId,
    status: TERMINAL_STATUS,
    clearTokenBudget: true,
    expectedGoalId: goal.goalId,
    expectedRevision: goal.revision,
  }, threadId);
  assert.equal(result.goal?.threadId, threadId);
  assert.equal(result.goal?.goalId, goal.goalId);
  assert.ok(Number.isInteger(result.goal?.revision) && result.goal.revision > goal.revision);
  assert.equal(result.goal?.status, TERMINAL_STATUS);
  return result.goal;
}

async function installGoalRpcFixtureBridge(page, {
  browserGoalRequests,
  browserGoalResponses,
  goalNotifications,
  fixtureWrites,
}) {
  const sockets = new Map();
  const threadOwners = new Map();
  const pendingFixtureRequests = new Map();
  let socketSequence = 0;
  let nextFixtureId = 1_700_000_000;
  // Fixture mutations stay on the real Gateway socket that owns the browser-created thread.
  // This changes server state only through JSON-RPC; the page DOM and React state are untouched.
  await page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    const socketId = ++socketSequence;
    const methodsById = new Map();
    const threadIdsById = new Map();
    sockets.set(socketId, { socketId, upstream });

    socket.onMessage(raw => {
      for (const frame of parseFrames(raw)) {
        if (typeof frame?.method !== "string") continue;
        if (frame.id !== undefined) {
          methodsById.set(String(frame.id), frame.method);
          if (typeof frame.params?.threadId === "string")
            threadIdsById.set(String(frame.id), frame.params.threadId);
        }
        if (!frame.method.startsWith("thread/goal/")) continue;
        browserGoalRequests.push({
          socketId,
          id: frame.id ?? null,
          method: frame.method,
          threadId: frame.params?.threadId ?? null,
          edit: frame.params?.edit === true,
          status: frame.params?.status ?? null,
          expectedGoalId: frame.params?.expectedGoalId ?? null,
          expectedRevision: frame.params?.expectedRevision ?? null,
          objectiveIsRaceDraft: frame.params?.objective === "MOBILE_GOAL_EDIT_DRAFT_RETAINED",
        });
      }
      upstream.send(raw);
    });

    upstream.onMessage(raw => {
      for (const frame of parseFrames(raw)) {
        if (frame?.method === "thread/goal/updated") {
          goalNotifications.push({
            socketId,
            threadId: frame.params?.threadId ?? null,
            goalId: frame.params?.goal?.goalId ?? null,
            revision: frame.params?.goal?.revision ?? null,
            status: frame.params?.goal?.status ?? null,
            isCleared: frame.params?.goal == null,
          });
        }
        if (frame?.id === undefined) continue;
        const requestId = String(frame.id);
        const method = methodsById.get(requestId);
        const requestedThreadId = threadIdsById.get(requestId);
        if (method?.startsWith("thread/goal/")) {
          browserGoalResponses.push({
            socketId,
            id: frame.id,
            method,
            threadId: requestedThreadId ?? null,
            errorCode: frame.error?.code ?? null,
            errorMessage: frame.error?.message ?? null,
          });
        }
        if (method === "thread/start" && typeof frame.result?.thread?.id === "string")
          threadOwners.set(frame.result.thread.id, socketId);
        else if (method === "thread/resume" && !frame.error && requestedThreadId &&
          (frame.result?.thread?.id === requestedThreadId || frame.result?.threadId === requestedThreadId))
          threadOwners.set(requestedThreadId, socketId);
        methodsById.delete(requestId);
        threadIdsById.delete(requestId);
        const fixtureRequest = pendingFixtureRequests.get(socketId + ":" + requestId);
        if (!fixtureRequest) continue;
        pendingFixtureRequests.delete(socketId + ":" + requestId);
        clearTimeout(fixtureRequest.timer);
        if (frame.error) fixtureRequest.reject(new Error(
          "real app-server fixture RPC " + fixtureRequest.method + " failed: " +
          String(frame.error.message ?? "unknown error"),
        ));
        else fixtureRequest.resolve(frame.result);
      }
      socket.send(raw);
    });
  });

  return {
    async request(method, params = {}, threadId = params.threadId) {
      assert.ok(typeof threadId === "string" && threadId.length > 0,
        "real Goal fixture RPC must identify its browser-owned thread");
      const socketId = threadOwners.get(threadId);
      const connection = sockets.get(socketId);
      assert.ok(connection, "fixture RPC must use the browser Gateway socket that owns the thread");
      const id = nextFixtureId++;
      const key = socketId + ":" + String(id);
      const result = await new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pendingFixtureRequests.delete(key);
          rejectRequest(new Error("real app-server fixture RPC timed out: " + method));
        }, 30_000);
        pendingFixtureRequests.set(key, { resolve: resolveRequest, reject: rejectRequest, timer, method });
        connection.upstream.send(JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }));
      });
      fixtureWrites.push({
        method,
        params: {
          threadId,
          status: params.status ?? null,
          objective: params.objective ?? null,
          edit: params.edit === true,
          requireNoGoal: params.requireNoGoal === true,
          expectedGoalId: params.expectedGoalId ?? null,
          expectedRevision: params.expectedRevision ?? null,
          clearTokenBudget: params.clearTokenBudget === true,
        },
        receipt: method === "thread/goal/clear"
          ? { cleared: result?.cleared === true }
          : method === "thread/goal/get"
            ? { goal: summarizeServerWrite("read", result?.goal) }
            : { goal: summarizeServerWrite("write", result?.goal) },
      });
      return result;
    },
  };
}

async function waitForGoalNotification(events, threadId, goal, status) {
  return waitFor(() => events.some(event =>
    event.threadId === threadId &&
    event.goalId === (goal?.goalId ?? null) &&
    event.revision === (goal?.revision ?? null) &&
    event.status === (status ?? null) &&
    event.isCleared === (goal == null),
  ), 30_000, "real server Goal notification to the browser thread owner");
}

function summarizeServerWrite(kind, goal) {
  return {
    kind,
    threadId: goal?.threadId ?? null,
    goalId: goal?.goalId ?? null,
    revision: goal?.revision ?? null,
    status: goal?.status ?? null,
    objective: goal?.objective ?? null,
  };
}

function parseFrames(payload) {
  try {
    const value = JSON.parse(String(payload));
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

function threadIdFromUrl(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const taskIndex = segments.indexOf("task");
  if (taskIndex < 0 || !segments[taskIndex + 2]) return null;
  return decodeURIComponent(segments[taskIndex + 2]);
}

async function hashFile(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}
