import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
const kcoderBin = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
const viewportWidth = Number(process.env.KCODER_E2E_VIEWPORT_WIDTH || 390);
assert.ok([360, 390].includes(viewportWidth), "KCODER_E2E_VIEWPORT_WIDTH must be 360 or 390");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "task-flow-dual-workspace-history",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic provider; real Mobile UI, Gateway, app-server and workspace-scoped history RPCs",
  retainSuccessLogs: true,
}, async context => {
  const defaultWorkspace = context.pathInState("default-workspace");
  const configDir = context.pathInState("config");
  const workspaceA = resolve(context.stateDir, "registered-workspaces", "workspace-alpha");
  const workspaceB = resolve(context.stateDir, "registered-workspaces", "workspace-bravo");
  await mkdir(defaultWorkspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    textOnlyResponse: ({ userText }) => `TASK_FLOW_REPLY:${userText}`,
  });
  const settingsFile = await context.writeStateJson("model-settings.json", {
    active_provider: "task-flow-local",
    permission_mode: "yolo",
    providers: {
      "task-flow-local": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "task-flow-history-model",
        context_window_tokens: 128000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", {
    "task-flow-local": { type: "api", key: "task-flow-local-key" },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Local",
    transport: "local",
    command: kcoderBin,
    workspace: defaultWorkspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true,
    label: "task-flow-dual-workspace-gateway",
    workspace: defaultWorkspace,
    serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "task-flow-dual-workspace-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: viewportWidth, height: 844 });

  const diagnostics = [];
  const expectedPlatformWarnings = [];
  let currentUiPhase = "connect";
  const expectedMobileWebAnimatedWarning = "Animated: `useNativeDriver` is not supported because the native animated module is missing. Falling back to JS-based animation. To resolve this, add `RCTAnimation` module to this app, or remove `useNativeDriver`. Make sure to run `bundle exec pod install` first. Read more about autolinking: https://github.com/react-native-community/cli/blob/master/docs/autolinking.md";
  const apiRequests = [];
  const rpcSockets = [];
  const rpcRequests = [];
  const rpcResponses = [];
  page.on("pageerror", error => diagnostics.push({ kind: "pageerror", message: error.message, phase: currentUiPhase }));
  page.on("console", message => {
    if (!["error", "warning"].includes(message.type())) return;
    const entry = {
      kind: message.type(),
      message: message.text(),
      phase: currentUiPhase,
      route: `${new URL(page.url()).pathname}${new URL(page.url()).search}`,
    };
    if (entry.kind === "warning" && entry.message === expectedMobileWebAnimatedWarning) {
      expectedPlatformWarnings.push({ ...entry, occurrence: expectedPlatformWarnings.length + 1 });
      return;
    }
    diagnostics.push(entry);
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) apiRequests.push({ method: request.method(), path: url.pathname });
  });
  page.on("websocket", socket => {
    const socketIndex = rpcSockets.length;
    let socketRecord;
    try {
      const url = new URL(socket.url());
      socketRecord = {
        path: url.pathname,
        server: url.searchParams.get("server"),
        channel: url.searchParams.get("channel"),
        workspace: url.searchParams.get("workspace"),
      };
    } catch {
      socketRecord = { path: "<unparseable>" };
    }
    rpcSockets.push({ ...socketRecord, socketIndex });
    socket.on("framesent", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value?.method) rpcRequests.push({
          id: value.id ?? null,
          method: value.method,
          params: summarizeParams(value.method, value.params),
          socketWorkspace: socketRecord.workspace,
          socketIndex,
        });
      } catch {}
    });
    socket.on("framereceived", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value?.id !== undefined) {
          let matchingRequest = null;
          for (let index = rpcRequests.length - 1; index >= 0; index -= 1) {
            const request = rpcRequests[index];
            if (request.socketIndex === socketIndex && request.id === value.id) {
              matchingRequest = request;
              break;
            }
          }
          rpcResponses.push({
            id: value.id,
            ok: !value.error,
            errorCode: value.error?.code ?? null,
            result: summarizeResult(value.result),
            method: matchingRequest?.method ?? null,
            requestThreadId: matchingRequest?.params?.threadId ?? null,
            socketWorkspace: socketRecord.workspace,
            socketIndex,
          });
        }
      } catch {}
    });
  });

  try {
    await connect(page, gateway);
    const profileId = profileIdFromHome(page.url());
    const homeUrl = `${gateway.baseUrl}/h/${encodeURIComponent(profileId)}`;

    await registerWorkspace(page, gateway, profileId, workspaceA, "workspace-alpha");
    await registerWorkspace(page, gateway, profileId, workspaceB, "workspace-bravo");
    await access(workspaceA);
    await access(workspaceB);

    const alpha = await createTask(page, profileId, workspaceA, "TASK_FLOW_HISTORY_ALPHA");
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    const bravo = await createTask(page, profileId, workspaceB, "TASK_FLOW_HISTORY_BRAVO");

    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(async () => rpcRequests.filter(value => value.method === "thread/list").length >= 1, 30_000, "首页刷新后 thread/list");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1500);
    const homeRows = {
      alpha: await page.getByTestId(`thread-${alpha.threadId}`).count(),
      bravo: await page.getByTestId(`thread-${bravo.threadId}`).count(),
    };
    const homeListRequests = rpcRequests.filter(value => value.method === "thread/list");
    await page.screenshot({ path: context.pathInArtifacts("home-history.png") });

    await page.goto(`${gateway.baseUrl}/sessions?profileId=${encodeURIComponent(profileId)}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("sessions-list").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1500);
    const sessionsRows = {
      alpha: await page.getByTestId(`session-${alpha.threadId}`).count(),
      bravo: await page.getByTestId(`session-${bravo.threadId}`).count(),
    };
    const sessionsListRequests = rpcRequests.filter(value => value.method === "thread/list").slice(homeListRequests.length);
    await page.screenshot({ path: context.pathInArtifacts("sessions-history.png") });

    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId(`thread-${alpha.threadId}`).waitFor({ state: "visible", timeout: 30_000 });
    const beforeAlphaTaskRequests = rpcRequests.length;
    await page.getByTestId(`thread-${alpha.threadId}`).click();
    await waitFor(() => routeThreadId(page.url()) === alpha.threadId, 30_000, "drawer coverage Alpha task route");
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(() => {
      const lists = rpcRequests.slice(beforeAlphaTaskRequests).filter(value => value.method === "thread/list");
      return lists.some(value => value.socketWorkspace === workspaceA) && lists.some(value => value.socketWorkspace === workspaceB);
    }, 30_000, "TaskScreen history queries for both registered workspaces");
    const drawerAlphaListRequests = rpcRequests.slice(beforeAlphaTaskRequests).filter(value => value.method === "thread/list");
    await page.getByLabel("打开任务列表").click();
    const drawer = page.getByTestId("mobile-drawer");
    await drawer.waitFor({ state: "visible", timeout: 30_000 });
    await drawer.getByTestId(`drawer-thread-${alpha.threadId}`).waitFor({ state: "visible", timeout: 30_000 });
    await drawer.getByTestId(`drawer-thread-${bravo.threadId}`).waitFor({ state: "visible", timeout: 30_000 });
    const drawerRowsOnAlpha = {
      alpha: await drawer.getByTestId(`drawer-thread-${alpha.threadId}`).count(),
      bravo: await drawer.getByTestId(`drawer-thread-${bravo.threadId}`).count(),
    };
    const beforeBravoTaskRequests = rpcRequests.length;
    await drawer.getByTestId(`drawer-thread-${bravo.threadId}`).click();
    await waitFor(() => routeThreadId(page.url()) === bravo.threadId, 30_000, "drawer Alpha-to-Bravo route");
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-user").filter({ hasText: alpha.prompt }).waitFor({ state: "hidden", timeout: 30_000 });
    await page.getByTestId("message-user").filter({ hasText: bravo.prompt }).waitFor({ state: "visible", timeout: 30_000 });
    const bravoProjection = {
      routeThreadId: routeThreadId(page.url()),
      alphaMessages: await page.getByTestId("message-user").filter({ hasText: alpha.prompt }).count(),
      bravoMessages: await page.getByTestId("message-user").filter({ hasText: bravo.prompt }).count(),
    };
    const drawerBravoListRequests = rpcRequests.slice(beforeBravoTaskRequests).filter(value => value.method === "thread/list");

    await page.getByLabel("打开任务列表").click();
    await drawer.waitFor({ state: "visible", timeout: 30_000 });
    await drawer.getByTestId(`drawer-thread-${alpha.threadId}`).waitFor({ state: "visible", timeout: 30_000 });
    await drawer.getByTestId(`drawer-thread-${bravo.threadId}`).waitFor({ state: "visible", timeout: 30_000 });
    const drawerRowsOnBravo = {
      alpha: await drawer.getByTestId(`drawer-thread-${alpha.threadId}`).count(),
      bravo: await drawer.getByTestId(`drawer-thread-${bravo.threadId}`).count(),
    };
    const beforeAlphaAgainTaskRequests = rpcRequests.length;
    await drawer.getByTestId(`drawer-thread-${alpha.threadId}`).click();
    await waitFor(() => routeThreadId(page.url()) === alpha.threadId, 30_000, "drawer Bravo-to-Alpha route");
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-user").filter({ hasText: bravo.prompt }).waitFor({ state: "hidden", timeout: 30_000 });
    await page.getByTestId("message-user").filter({ hasText: alpha.prompt }).waitFor({ state: "visible", timeout: 30_000 });
    const alphaProjection = {
      routeThreadId: routeThreadId(page.url()),
      alphaMessages: await page.getByTestId("message-user").filter({ hasText: alpha.prompt }).count(),
      bravoMessages: await page.getByTestId("message-user").filter({ hasText: bravo.prompt }).count(),
    };
    const drawerAlphaAgainListRequests = rpcRequests.slice(beforeAlphaAgainTaskRequests)
      .filter(value => value.method === "thread/list");

    // Diagnose the old route stack before starting the retained-Sessions mutation
    // probe. The next document navigation resets only this pre-probe stack.
    await page.getByLabel("打开任务列表").click();
    const historyDrawer = page.getByTestId("mobile-drawer");
    await historyDrawer.waitFor({ state: "visible", timeout: 30_000 });
    await historyDrawer.getByText("历史", { exact: true }).click();
    await page.getByTestId("sessions-list").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(`[data-testid="session-${alpha.threadId}"]:visible`).waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(`[data-testid="session-${bravo.threadId}"]:visible`).waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(`[data-testid="session-${alpha.threadId}"]:visible`).click();
    await waitFor(() => routeThreadId(page.url()) === alpha.threadId, 30_000, "diagnose drawer-history route stack before mutations");
    const taskRootsBeforeReset = await inspectDomTestId(page, "message-input-root");
    await context.writeArtifactJson("task-route-duplicate-dom-diagnostic.json", {
      route: new URL(page.url()).pathname,
      nodes: taskRootsBeforeReset,
      visibleNodeCount: taskRootsBeforeReset.filter(node => node.playwrightVisible).length,
    });
    assert.equal(
      taskRootsBeforeReset.filter(node => node.playwrightVisible).length,
      1,
      "Drawer→Sessions→same task route must expose exactly one visible TaskScreen input root",
    );
    await page.locator('[data-testid="message-input-root"]:visible').waitFor({ state: "visible", timeout: 30_000 });

    // Start the actual cache-retention probe from a clean home navigation stack.
    // This is before any rename/archive/delete action, so the Sessions instance
    // stays mounted under its TaskAgent while the mutation sequence runs.
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("sessions").click();
    await page.getByTestId("sessions-list").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(`[data-testid="session-${alpha.threadId}"]:visible`).waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(`[data-testid="session-${bravo.threadId}"]:visible`).waitFor({ state: "visible", timeout: 30_000 });
    const retainedSessionsBeforeMutations = {
      alpha: await page.locator(`[data-testid="session-${alpha.threadId}"]:visible`).count(),
      bravo: await page.locator(`[data-testid="session-${bravo.threadId}"]:visible`).count(),
      route: new URL(page.url()).pathname,
    };
    await page.locator(`[data-testid="session-${alpha.threadId}"]:visible`).click();
    await waitFor(() => routeThreadId(page.url()) === alpha.threadId, 30_000, "retained Sessions opens Alpha TaskAgent");
    const activeTaskRoots = await inspectDomTestId(page, "message-input-root");
    await context.writeArtifactJson("retained-session-task-dom.json", {
      route: new URL(page.url()).pathname,
      nodes: activeTaskRoots,
      visibleNodeCount: activeTaskRoots.filter(node => node.playwrightVisible).length,
    });
    assert.equal(activeTaskRoots.filter(node => node.playwrightVisible).length, 1, "Current retained-Sessions TaskAgent must have one visible composer root");
    await page.locator('[data-testid="message-input-root"]:visible').waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-user").filter({ hasText: alpha.prompt }).waitFor({ state: "visible", timeout: 30_000 });

    const renamedAlphaTitle = `TASK_FLOW_ALPHA_RENAMED_${Date.now()}`;
    const renameStartRequestIndex = rpcRequests.length;
    const renameStartResponseIndex = rpcResponses.length;
    currentUiPhase = "taskmenu-rename";
    await page.getByLabel("更多").click();
    const renameMenu = page.getByRole("dialog", { name: "任务操作" });
    await renameMenu.getByLabel("任务标题").fill(renamedAlphaTitle);
    await renameMenu.getByText("重命名", { exact: true }).click();
    await renameMenu.getByText("标题已更新", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await renameMenu.getByLabel("关闭").click();
    const renamedTaskHeader = page.getByTestId("task-header-title");
    await renamedTaskHeader.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await renamedTaskHeader.innerText(), renamedAlphaTitle, "Task header should reflect the acknowledged rename");
    const renameAck = await waitForRpcAck({
      requests: rpcRequests.slice(renameStartRequestIndex),
      responses: rpcResponses.slice(renameStartResponseIndex),
      method: "thread/metadata/update",
      threadId: alpha.threadId,
      predicate: params => params.title === renamedAlphaTitle && !params.archivedAtPresent,
      label: "TaskMenu rename Alpha",
    });
    await page.screenshot({ path: context.pathInArtifacts("task-menu-renamed-alpha.png") });

    const archiveStartRequestIndex = rpcRequests.length;
    const archiveStartResponseIndex = rpcResponses.length;
    currentUiPhase = "taskmenu-archive";
    await page.getByLabel("更多").click();
    const archiveMenu = page.getByRole("dialog", { name: "任务操作" });
    page.once("dialog", dialog => dialog.accept());
    await archiveMenu.getByText("归档任务", { exact: true }).click();
    await waitForVisibleUniqueTestId(page, "new-workspace", context, "home-after-taskmenu-archive-control-dom.json");
    const archiveAck = await waitForRpcAck({
      requests: rpcRequests.slice(archiveStartRequestIndex),
      responses: rpcResponses.slice(archiveStartResponseIndex),
      method: "thread/metadata/update",
      threadId: alpha.threadId,
      predicate: params => params.archivedAtPresent && typeof params.archivedAt === "string",
      label: "TaskMenu archive Alpha",
    });
    assert.equal(await page.getByTestId(`thread-${alpha.threadId}`).count(), 0, "归档后 Alpha 必须从 Home 活动任务中消失");
    await page.screenshot({ path: context.pathInArtifacts("task-menu-archived-home.png") });

    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => null);
    await waitFor(() => new URL(page.url()).pathname === "/sessions", 30_000, "TaskMenu archive returns to retained Sessions route");
    await page.getByTestId("sessions-list").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("sessions-active").click();
    await page.getByTestId(`session-${bravo.threadId}`).waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(async () => await page.getByTestId(`session-${alpha.threadId}`).count() === 0, 30_000, "归档后 Sessions 活动列表移除 Alpha");
      const activeSessionsAfterArchive = {
      alpha: await page.getByTestId(`session-${alpha.threadId}`).count(),
      bravo: await page.getByTestId(`session-${bravo.threadId}`).count(),
    };
    await page.getByTestId("sessions-archived").click();
    const archivedAlphaRow = page.getByTestId(`session-${alpha.threadId}`);
    await archivedAlphaRow.waitFor({ state: "visible", timeout: 30_000 });
    await archivedAlphaRow.getByText(renamedAlphaTitle, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const archivedSessionsAfterArchive = {
      alpha: await archivedAlphaRow.count(),
      bravo: await page.getByTestId(`session-${bravo.threadId}`).count(),
    };
    await page.screenshot({ path: context.pathInArtifacts("sessions-archived-alpha.png") });

    const unarchiveStartRequestIndex = rpcRequests.length;
    const unarchiveStartResponseIndex = rpcResponses.length;
    currentUiPhase = "taskagent-unarchive";
    await archivedAlphaRow.click();
    await waitFor(() => routeThreadId(page.url()) === alpha.threadId, 30_000, "Sessions archived row opens Alpha TaskAgent");
    await page.getByTestId("unarchive-task").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("unarchive-task").click();
    await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
    const restoredTaskHeader = page.getByTestId("task-header-title");
    await restoredTaskHeader.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await restoredTaskHeader.innerText(), renamedAlphaTitle, "Task header should retain the title after unarchive");
    const unarchiveAck = await waitForRpcAck({
      requests: rpcRequests.slice(unarchiveStartRequestIndex),
      responses: rpcResponses.slice(unarchiveStartResponseIndex),
      method: "thread/metadata/update",
      threadId: alpha.threadId,
      predicate: params => params.archivedAtPresent && params.archivedAt === null,
      label: "TaskAgent unarchive Alpha",
    });
    await page.getByLabel("打开任务列表").click();
    const restoredDrawer = page.getByTestId("mobile-drawer");
    await restoredDrawer.waitFor({ state: "visible", timeout: 30_000 });
    await restoredDrawer.getByTestId(`drawer-thread-${alpha.threadId}`).waitFor({ state: "visible", timeout: 30_000 });
    await restoredDrawer.getByTestId(`drawer-thread-${bravo.threadId}`).waitFor({ state: "visible", timeout: 30_000 });
    const drawerRowsAfterUnarchive = {
      alpha: await restoredDrawer.getByTestId(`drawer-thread-${alpha.threadId}`).count(),
      bravo: await restoredDrawer.getByTestId(`drawer-thread-${bravo.threadId}`).count(),
      alphaTitle: await restoredDrawer.getByTestId(`drawer-thread-${alpha.threadId}`).innerText(),
    };
    await restoredDrawer.getByLabel("关闭导航").click();
    await page.screenshot({ path: context.pathInArtifacts("taskagent-unarchived-drawer.png") });

    const deleteStartRequestIndex = rpcRequests.length;
    const deleteStartResponseIndex = rpcResponses.length;
    currentUiPhase = "taskmenu-delete";
    await page.getByLabel("更多").click();
    const deleteMenu = page.getByRole("dialog", { name: "任务操作" });
    page.once("dialog", dialog => dialog.accept());
    await deleteMenu.getByText("删除任务", { exact: true }).click();
    await waitFor(() => new URL(page.url()).pathname === new URL(homeUrl).pathname, 30_000, "TaskScreen delete callback replaces the task route with profile Home");
    await waitForVisibleUniqueTestId(page, "new-workspace", context, "home-after-taskmenu-delete-control-dom.json");
    const deleteAck = await waitForRpcAck({
      requests: rpcRequests.slice(deleteStartRequestIndex),
      responses: rpcResponses.slice(deleteStartResponseIndex),
      method: "thread/delete",
      threadId: alpha.threadId,
      predicate: () => true,
      label: "TaskMenu delete Alpha",
    });
    // The documented onDeleted callback returns to profile Home; browser-back
    // returns to the retained Sessions screen without discarding its cache.
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => null);
    await waitFor(() => new URL(page.url()).pathname === "/sessions", 30_000, "TaskMenu delete returns to retained Sessions route");
    await page.getByTestId("sessions-list").waitFor({ state: "visible", timeout: 30_000 });
    currentUiPhase = "retained-sessions-delete-check";
    await page.getByTestId("sessions-active").click();
    await waitFor(async () =>
      await page.getByTestId(`session-${alpha.threadId}`).count() === 0 &&
      await page.getByTestId(`session-${bravo.threadId}`).count() === 1,
    30_000, "删除后 Sessions 活动列表移除 Alpha 并保留 Bravo");
    const activeSessionsAfterDelete = {
      alpha: await page.getByTestId(`session-${alpha.threadId}`).count(),
      bravo: await page.getByTestId(`session-${bravo.threadId}`).count(),
    };
    await page.getByTestId("sessions-archived").click();
    await waitFor(async () => await page.getByTestId(`session-${alpha.threadId}`).count() === 0, 30_000, "删除后 Sessions 归档列表移除 Alpha");
    const archivedSessionsAfterDelete = {
      alpha: await page.getByTestId(`session-${alpha.threadId}`).count(),
      bravo: await page.getByTestId(`session-${bravo.threadId}`).count(),
    };
    await page.screenshot({ path: context.pathInArtifacts("sessions-after-taskmenu-delete.png") });

    const providerUserPrompts = model.requests
      .map(request => [...(request.messages ?? [])].reverse().find(message => message?.role === "user")?.content)
      .filter(Boolean)
      .map(value => typeof value === "string" ? value : JSON.stringify(value));
    const evidence = {
      profileId,
      defaultWorkspace,
      registeredWorkspaces: [workspaceA, workspaceB],
      viewportWidth,
      createdTasks: [alpha, bravo],
      homeRows,
      sessionsRows,
      homeListRequests,
      sessionsListRequests,
      drawerRowsOnAlpha,
      drawerRowsOnBravo,
      drawerAlphaListRequests,
      drawerBravoListRequests,
      drawerAlphaAgainListRequests,
      drawerWorkspaceScopes: [...new Set([
        ...drawerAlphaListRequests,
        ...drawerBravoListRequests,
        ...drawerAlphaAgainListRequests,
      ].map(value => value.socketWorkspace))],
      drawerRouteProjections: { bravo: bravoProjection, alphaAgain: alphaProjection },
      crossScreenMutations: {
        renamedAlphaTitle,
        retainedSessionsBeforeMutations,
        renameAck,
        archiveAck,
        activeSessionsAfterArchive,
        archivedSessionsAfterArchive,
        unarchiveAck,
        drawerRowsAfterUnarchive,
        deleteAck,
        activeSessionsAfterDelete,
        archivedSessionsAfterDelete,
      },
      partialNextCursorCacheProbe: {
        protocolInjectionApplied: false,
        reason: "This suite keeps the browser WebSocket recorder read-only; no page-Gateway response was rewritten.",
        observedThreadListResponses: rpcResponses
          .filter(value => value.method === "thread/list")
          .map(value => ({
            socketWorkspace: value.socketWorkspace,
            threadIds: value.result?.threadIds ?? [],
            nextCursor: value.result?.nextCursor ?? null,
          })),
      },
      rpcSockets,
      rpcRequests,
      rpcResponses,
      apiRequests,
      providerUserPrompts,
      providerRequestCount: model.requests.length,
      diagnostics,
      expectedPlatformWarnings,
    };
    await context.writeArtifactJson("task-flow-dual-workspace-history.json", evidence);
    await context.writeArtifactJson("visible-result.json", {
      finalTaskBody: (await page.locator("body").innerText()).slice(0, 5000),
      url: new URL(page.url()).pathname,
      homeRows,
      sessionsRows,
      drawerRowsOnAlpha,
      drawerRowsOnBravo,
      drawerRouteProjections: { bravo: bravoProjection, alphaAgain: alphaProjection },
      crossScreenMutations: {
        renamedAlphaTitle,
        retainedSessionsBeforeMutations,
        activeSessionsAfterArchive,
        archivedSessionsAfterArchive,
        drawerRowsAfterUnarchive,
        activeSessionsAfterDelete,
        archivedSessionsAfterDelete,
      },
      diagnostics,
      expectedPlatformWarnings,
    });
    await page.screenshot({ path: context.pathInArtifacts("sessions-after-cross-screen-delete.png") });

    assert.deepEqual(diagnostics, [], "Mobile browser unexpected console/page diagnostics must remain empty");
    assert.ok(expectedPlatformWarnings.every(warning =>
      warning.kind === "warning" && warning.message === expectedMobileWebAnimatedWarning && warning.phase && warning.route,
    ), "Only the exact RN Web useNativeDriver fallback warning may be separately classified");
    assert.deepEqual(homeRows, { alpha: 1, bravo: 1 }, "Home should show both active tasks from separately registered workspaces after refresh");
    assert.deepEqual(sessionsRows, { alpha: 1, bravo: 1 }, "/sessions should show both active tasks from separately registered workspaces");
    assert.deepEqual(drawerRowsOnAlpha, { alpha: 1, bravo: 1 }, "Task drawer on Alpha must show both workspace task rows");
    assert.deepEqual(drawerRowsOnBravo, { alpha: 1, bravo: 1 }, "Task drawer on Bravo must show both workspace task rows");
    assert.deepEqual(bravoProjection, { routeThreadId: bravo.threadId, alphaMessages: 0, bravoMessages: 1 }, "Selecting Bravo from the drawer must switch the URL and visible transcript together");
    assert.deepEqual(alphaProjection, { routeThreadId: alpha.threadId, alphaMessages: 1, bravoMessages: 0 }, "Selecting Alpha again must switch the URL and visible transcript together");
    assert.deepEqual(activeSessionsAfterArchive, { alpha: 0, bravo: 1 }, "归档后的 Sessions 活动历史应移除 Alpha 并保留 Bravo");
    assert.deepEqual(archivedSessionsAfterArchive, { alpha: 1, bravo: 0 }, "归档后的 Sessions 归档历史应包含 Alpha 且不包含 Bravo");
    assert.deepEqual(drawerRowsAfterUnarchive, { alpha: 1, bravo: 1, alphaTitle: renamedAlphaTitle }, "TaskAgent 取消归档后 TaskScreen drawer 应显示恢复的 Alpha 和 Bravo");
    assert.deepEqual(retainedSessionsBeforeMutations, { alpha: 1, bravo: 1, route: "/sessions" }, "TaskMenu mutation probes must start above a Sessions route that contains both workspace rows");
    assert.deepEqual(activeSessionsAfterDelete, { alpha: 0, bravo: 1 }, "TaskMenu 永久删除后 Sessions 活动历史应只保留 Bravo");
    assert.deepEqual(archivedSessionsAfterDelete, { alpha: 0, bravo: 0 }, "TaskMenu 永久删除后 Sessions 归档历史不应保留 Alpha");
    for (const [name, mutation] of [
      ["rename", renameAck],
      ["archive", archiveAck],
      ["unarchive", unarchiveAck],
      ["delete", deleteAck],
    ])
      assert.equal(mutation.request.socketWorkspace, workspaceA, `Alpha ${name} RPC must use its registered workspace connection`);
    for (const [workspacePath, requests] of [
      [workspaceA, drawerAlphaListRequests],
      [workspaceB, drawerAlphaListRequests],
      [workspaceA, drawerBravoListRequests],
      [workspaceB, drawerBravoListRequests],
    ])
      assert.ok(requests.some(value => value.socketWorkspace === workspacePath), `TaskScreen drawer list must query ${workspacePath}`);
    return {
      bothRegisteredWorkspacesCreatedAndListed: true,
      homeRows,
      sessionsRows,
      drawerRowsOnAlpha,
      drawerRowsOnBravo,
      drawerRouteProjections: { bravo: bravoProjection, alphaAgain: alphaProjection },
      crossScreenMutations: {
        renamedAlphaTitle,
        retainedSessionsBeforeMutations,
        activeSessionsAfterArchive,
        archivedSessionsAfterArchive,
        drawerRowsAfterUnarchive,
        activeSessionsAfterDelete,
        archivedSessionsAfterDelete,
      },
      drawerWorkspaceScopes: [...new Set([
        ...drawerAlphaListRequests,
        ...drawerBravoListRequests,
        ...drawerAlphaAgainListRequests,
      ].map(value => value.socketWorkspace))],
      providerRequests: model.requests.length,
    };
  } catch (error) {
    await context.writeArtifactJson("failure-state.json", {
      message: error instanceof Error ? error.message : String(error),
      route: new URL(page.url()).pathname,
      body: await page.locator("body").innerText().catch(() => ""),
      rpcSockets,
      rpcRequests,
      rpcResponses,
      apiRequests,
      diagnostics,
      domNodeDiagnostics: {
        messageInputRoots: await inspectDomTestId(page, "message-input-root").catch(() => []),
        homeCreateButtons: await inspectDomTestId(page, "new-workspace").catch(() => []),
      },
    });
    await page.screenshot({ path: context.pathInArtifacts("failure.png") }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }
});

async function registerWorkspace(page, gateway, profileId, workspacePath, label) {
  await page.goto(`${gateway.baseUrl}/open-project?profileId=${encodeURIComponent(profileId)}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-project-route").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("新建目录", { exact: true }).locator("../..").click();
  await page.getByLabel("目录", { exact: true }).fill(workspacePath);
  await page.getByText("创建并打开", { exact: true }).click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => await page.getByTestId("workspace-path").inputValue() === workspacePath, 30_000, `${label}已打开`);
  assert.equal(await page.getByTestId("workspace-path").inputValue(), workspacePath);
  await page.getByTestId("new-workspace-prompt").waitFor({ state: "visible", timeout: 30_000 });
  await page.goto(`${gateway.baseUrl}/h/${encodeURIComponent(profileId)}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, profileId, workspacePath, prompt) {
  await page.goto(`${new URL(page.url()).origin}/new?profileId=${encodeURIComponent(profileId)}&serverId=local`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => await page.getByTestId("workspace-path").inputValue() !== "", 30_000, "新任务默认工作目录");
  await page.getByTestId(`workspace-option-${encodeURIComponent(workspacePath)}`).click();
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  const replyMarker = `TASK_FLOW_REPLY:${prompt}`;
  await page.getByText(replyMarker, { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  const threadId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1));
  assert.ok(threadId);
  return { threadId, workspacePath, prompt, replyMarker };
}

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

function profileIdFromHome(url) {
  const id = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[1] ?? "");
  assert.ok(id);
  return id;
}

function routeThreadId(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
}

async function inspectDomTestId(page, testId) {
  return page.locator(`[data-testid="${testId}"]`).evaluateAll(nodes => nodes.map((node, index) => {
    const ancestors = [];
    let current = node;
    while (current && ancestors.length < 10) {
      const style = window.getComputedStyle(current);
      const rect = current.getBoundingClientRect();
      ancestors.push({
        tag: current.tagName,
        testId: current.getAttribute("data-testid"),
        ariaHidden: current.getAttribute("aria-hidden"),
        inert: current.hasAttribute("inert"),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        transform: style.transform,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
      current = current.parentElement;
    }
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      index,
      route: `${window.location.pathname}${window.location.search}`,
      playwrightVisible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.visibility !== "collapse",
      ariaHiddenAncestor: ancestors.some(ancestor => ancestor.ariaHidden === "true"),
      inertAncestor: ancestors.some(ancestor => ancestor.inert),
      ancestors,
    };
  }));
}

async function waitForVisibleUniqueTestId(page, testId, context, artifactName) {
  const nodes = await inspectDomTestId(page, testId);
  const visibleNodeCount = nodes.filter(node => node.playwrightVisible).length;
  await context.writeArtifactJson(artifactName, {
    route: `${new URL(page.url()).pathname}${new URL(page.url()).search}`,
    nodes,
    visibleNodeCount,
  });
  assert.equal(visibleNodeCount, 1, `${testId} must have exactly one visible node`);
  const locator = page.locator(`[data-testid="${testId}"]:visible`);
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await locator.count(), 1, `${testId} visible locator must be unique`);
  return locator;
}

function summarizeParams(method, params) {
  if (!params || typeof params !== "object") return null;
  if (method === "turn/start") {
    return {
      threadId: params.threadId ?? null,
      promptMarkers: (params.input ?? []).filter(item => item?.type === "text").map(item => String(item.text ?? "").slice(0, 120)),
      clientMessageIdPresent: typeof params.clientMessageId === "string",
    };
  }
  if (method === "thread/list") {
    return { cursor: params.cursor ?? null, limit: params.limit ?? null, archived: params.archived ?? null, query: params.query ?? null };
  }
  if (method.startsWith("runtime.workspaces.")) {
    return { workspacePath: params.workspacePath ?? null, action: params.action ?? null };
  }
  if (method === "thread/read" || method === "thread/resume" || method === "thread/delete") return { threadId: params.threadId ?? null };
  if (method === "thread/metadata/update") return {
    threadId: params.threadId ?? null,
    cwd: params.cwd ?? null,
    title: params.title ?? null,
    archivedAtPresent: Object.hasOwn(params, "archivedAt"),
    archivedAt: Object.hasOwn(params, "archivedAt") ? params.archivedAt : null,
  };
  return {};
}

async function waitForRpcAck({ requests, responses, method, threadId, predicate, label }) {
  let matched;
  await waitFor(() => {
    matched = requests.find(request => request.method === method && request.params?.threadId === threadId && predicate(request.params ?? {}));
    if (!matched) return false;
    return responses.some(response => response.socketIndex === matched.socketIndex && response.id === matched.id && response.ok);
  }, 30_000, `${label} real RPC request and successful response`);
  const response = responses.find(value => value.socketIndex === matched.socketIndex && value.id === matched.id);
  assert.ok(response?.ok, `${label} must have a successful real RPC response`);
  return { request: matched, response };
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") return null;
  const threads = result.threads;
  if (Array.isArray(threads)) return {
    threadIds: threads.map(thread => thread?.id).filter(Boolean),
    nextCursor: result.nextCursor ?? null,
    totalCount: result.totalCount ?? null,
  };
  const thread = result.thread;
  if (thread?.id) return { threadId: thread.id, status: thread.status ?? null, cwd: thread.cwd ?? null };
  return Object.keys(result).slice(0, 16);
}
