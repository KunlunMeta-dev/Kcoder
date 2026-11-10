import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { buildGatewayMobileWebManifest, MOBILE_WEB_BASE_TOKEN, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { captureMobileRouteFailure, isExpectedMobileReloadSocketClose, observeMobileRuntimeInitialize } from "../../harness/mobile-runtime-initialize.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

await runE2E(import.meta.url, {
  testId: "mobile-web-real-terminal-pty-tabs-reload",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic real app-server",
  retainSuccessLogs: true,
}, async context => {
  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-terminal-pty-web-export",
    outputName: "mobile-web-export",
    dependencyRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
    deployMount: true,
  });
  const mobileDist = mobileWeb.path;
  const gatewayManifest = await buildGatewayMobileWebManifest(mobileDist, { expectedFiles: mobileWeb.bundleFiles });
  assert.deepEqual(gatewayManifest.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })), mobileWeb.bundleFiles);
  await writeGatewayMobileWebManifest(mobileDist, gatewayManifest);
  const gatewayManifestBytes = await readFile(resolve(mobileDist, "kcoder-mobile-web.json"));
  const gatewayManifestSha256 = createHash("sha256").update(gatewayManifestBytes).digest("hex");
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-terminal-gateway",
    workspace,
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDist,
    },
  });
  await verifyMobileStaticEntry(context, gateway, mobileDist, mobileWeb, gatewayManifestSha256, gatewayManifest.files.length);
  const chromium = await startChromium(context, { label: "mobile-terminal-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const diagnosticEvents = [];
  const expectedReloadSocketCloseWarnings = [];
  let reloadDiagnosticsPhase = "idle";
  const runtimeInitialize = observeMobileRuntimeInitialize(page, {
    gatewayBaseUrl: gateway.baseUrl,
    workspacePath: workspace,
    getPhase: () => reloadDiagnosticsPhase,
    redactText: value => context.redactText(value),
  });
  const rpcRequests = [];
  const rpcResponses = [];
  page.on("pageerror", error => {
    const message = context.redactText(error.message);
    diagnosticEvents.push({ phase: reloadDiagnosticsPhase, type: "pageerror", message, location: null });
    diagnostics.push(`pageerror: ${message}`);
  });
  page.on("console", message => {
    if (!["error", "warning"].includes(message.type())) return;
    const text = message.text();
    const location = message.location();
    const event = {
      phase: reloadDiagnosticsPhase,
      type: message.type(),
      message: context.redactText(text),
      location: { url: context.redactText(location.url || ""), lineNumber: location.lineNumber, columnNumber: location.columnNumber },
    };
    diagnosticEvents.push(event);
    const classifierInput = { kind: message.type(), phase: reloadDiagnosticsPhase, message: text };
    if (isExpectedMobileReloadSocketClose(classifierInput, { gatewayBaseUrl: gateway.baseUrl, workspacePath: workspace })) {
      expectedReloadSocketCloseWarnings.push({ phase: reloadDiagnosticsPhase, route: "local runtime RPC", workspaceMatches: true });
      return;
    }
    diagnostics.push(`${message.type()}: ${event.message}`);
  });
  page.on("websocket", socket => {
    socket.on("framesent", event => { try { const value = JSON.parse(String(event.payload)); if (value?.method) rpcRequests.push({ id: value.id, method: value.method, params: value.params ?? null }); } catch {} });
    socket.on("framereceived", event => { try { const value = JSON.parse(String(event.payload)); if (value?.id !== undefined) rpcResponses.push({ id: value.id, result: value.result ?? null, error: value.error ?? null }); } catch {} });
  });
  await connect(page, gateway);
  await createTask(page, "MOBILE_REAL_TERMINAL", { context, runtimeInitialize, diagnosticEvents });

  await selectPanel(page, "terminal-1");
  await runCommand(page, "pwd", workspace);
  await runCommand(page, "printf ONE > one.txt", "");
  assert.equal(await readFile(resolve(workspace, "one.txt"), "utf8"), "ONE");

  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  await page.getByTestId("workspace-new-panel").click();
  await page.getByTestId("workspace-new-panel-option-terminal").click();
  await activeTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
  await assertEventuallyEnabled(activeTerminal(page).getByTestId("terminal-enter"));
  await terminalText(page, /KCoder Terminal/);
  await runCommand(page, "printf TWO > two.txt", "");
  assert.equal(await readFile(resolve(workspace, "two.txt"), "utf8"), "TWO");

  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  const secondTab = page.locator('[data-testid^="workspace-tab-terminal-"]').nth(1);
  await secondTab.waitFor({ state: "visible", timeout: 10_000 });
  const secondPanelId = (await secondTab.getAttribute("data-testid"))?.replace("workspace-tab-", "");
  assert.ok(secondPanelId, "新增终端标签必须暴露稳定的 panel id");
  await page.getByTestId("workspace-tab-terminal-1").click();
  await terminalText(page, /printf ONE > one\.txt/);
  assert.doesNotMatch(await terminalContent(page), /printf TWO > two\.txt/, "两个终端的回滚内容必须隔离");
  const terminalStartsBeforeReload = rpcRequests.filter(request => request.method === "terminal/start");
  assert.equal(terminalStartsBeforeReload.length, 2, "刷新前两个标签应各自只创建一个 PTY");

  const successfulInitializationsBeforeReload = runtimeInitialize.successfulInitializations().length;
  reloadDiagnosticsPhase = "page-reload-restore";
  await page.reload({ waitUntil: "domcontentloaded" });
  await activeTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
  let runtimeInitializeAfterReload;
  try {
    runtimeInitializeAfterReload = await runtimeInitialize.waitForSuccessfulInitializeAfter(successfulInitializationsBeforeReload);
    assert.equal(runtimeInitializeAfterReload.testPhaseAtSocket, "page-reload-restore", "刷新后的 initialize 必须来自重载阶段创建的 runtime socket");
    assert.equal(runtimeInitializeAfterReload.requestTestPhase, "page-reload-restore", "刷新后的 initialize 请求必须在重载阶段发出");
    assert.equal(runtimeInitializeAfterReload.testPhase, "page-reload-restore", "刷新后的 initialize 成功响应必须在重载阶段收到");
  } catch (error) {
    await context.writeArtifactJson("runtime-reload-initialize-failure.json", {
      expectedReloadSocketCloseWarnings,
      runtimeSocketObservations: runtimeInitialize.sockets,
      diagnostics,
      diagnosticEvents,
      rpcRequests,
      rpcResponses,
    });
    throw error;
  }
  try {
    await terminalText(page, /printf ONE > one\.txt/);
  } catch (error) {
    await context.writeArtifactJson("terminal-reload-persistence-failure.json", {
      activeTranscript: await terminalContent(page).catch(() => ""),
      rpcRequests,
      rpcResponses,
    });
    throw error;
  }
  assert.equal(rpcRequests.filter(request => request.method === "terminal/start").length, terminalStartsBeforeReload.length,
    "刷新必须附着已有 PTY，不能为保留的终端标签新建会话");
  reloadDiagnosticsPhase = "post-reload-terminal-actions";
  await runCommand(page, "printf BACK >> one.txt", "");
  assert.equal(await readFile(resolve(workspace, "one.txt"), "utf8"), "ONEBACK");

  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  await page.getByTestId(`workspace-tab-${secondPanelId}`).click();
  await terminalText(page, /printf TWO > two\.txt/);
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId(`workspace-close-panel-${secondPanelId}`).click();
  await page.getByTestId(`workspace-tab-${secondPanelId}`).waitFor({ state: "hidden", timeout: 30_000 });

  await context.writeArtifactJson("mobile-real-terminal-console-diagnostics.json", {
    diagnosticEvents,
    expectedReloadSocketCloseWarnings,
    runtimeSocketObservations: runtimeInitialize.sockets,
    diagnostics,
  });
  assert.ok(expectedReloadSocketCloseWarnings.length <= 1, "reload may emit at most one expected local RPC handshake-close warning");
  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-terminal-pty.json", {
    workspace,
    mobileWebExport: { sourceTreeSha256: mobileWeb.sourceTreeSha256, bundleSha256: mobileWeb.bundleSha256, bundleFileCount: mobileWeb.bundleFileCount },
    runtimeInitializeAfterReload,
    runtimeSocketObservations: runtimeInitialize.sockets,
    cwd: true,
    input: true,
    isolatedTabs: true,
    reloadRestore: true,
    close: true,
    rpcRequests,
    rpcResponses,
    expectedReloadSocketCloseWarnings,
    diagnostics,
  });
  return {
    realAppServer: true,
    cwd: true,
    terminalInput: true,
    isolatedTabs: true,
    reloadRestore: true,
    runtimeInitializeAfterReload: runtimeInitializeAfterReload.protocolVersion,
    expectedReloadSocketCloseWarnings: expectedReloadSocketCloseWarnings.length,
    mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
    mobileBundleSha256: mobileWeb.bundleSha256,
    closeCleanup: true,
  };
});

async function terminalContent(page) {
  return activeTerminal(page).locator(".xterm-accessibility-tree").innerText();
}

async function terminalText(page, expected) {
  await activeTerminal(page).locator(".xterm-accessibility-tree").filter({ hasText: expected }).waitFor({ state: "visible", timeout: 30_000 });
}

async function runCommand(page, command, expected) {
  await activeTerminal(page).getByTestId("terminal-enter").waitFor({ state: "visible", timeout: 30_000 });
  await assertEventuallyEnabled(activeTerminal(page).getByTestId("terminal-enter"));
  await activeTerminal(page).locator(".xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await terminalText(page, new RegExp(expected || command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

async function assertEventuallyEnabled(locator) {
  await locator.page().waitForFunction(element => !element?.hasAttribute("disabled") && element?.getAttribute("aria-disabled") !== "true", await locator.elementHandle(), { timeout: 30_000 });
}

function activeTerminal(page) {
  return page.locator('[data-testid="terminal-panel"]:visible');
}

async function selectPanel(page, id) {
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  await page.getByTestId(`workspace-tab-${id}`).click();
  await page.getByTestId("terminal-emulator").waitFor({ state: "visible", timeout: 30_000 });
}

async function connect(page, gateway) {
  await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt, failureCapture) {
  await page.getByTestId("new-workspace").click();
  try {
    await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    try {
      await captureMobileRouteFailure(page, {
        context: failureCapture.context,
        artifactName: "new-task-draft-wait-failure.json",
        screenshotName: "new-task-draft-wait-failure.png",
        testPhase: "create-task-after-home-new",
        testIds: [
          "new-workspace", "new-task-draft", "new-task-advanced", "server-option-local",
          "workspace-path", "new-workspace-prompt", "create-workspace", "welcome-direct-connection",
          "gateway-connect", "new-workspace-error", "workspace-task-handoff-error",
        ],
        diagnosticEvents: failureCapture.diagnosticEvents,
        runtimeSocketObservations: failureCapture.runtimeInitialize.sockets,
        error,
      });
    }
    catch { /* Preserve the original locator timeout if failure evidence cannot be written. */ }
    throw error;
  }
  await page.getByTestId("new-task-advanced").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
}

async function verifyMobileStaticEntry(context, gateway, mobileDist, mobileWeb, gatewayManifestSha256, gatewayManifestResourceCount) {
  const entry = mobileWeb.bundleFiles.find(file => file.path.startsWith("_expo/static/js/web/entry-") && file.path.endsWith(".js"));
  assert.ok(entry, "current Mobile Web export must include its Expo web entry chunk");
  const exportedBytes = await readFile(resolve(mobileDist, entry.path));
  assert.equal(createHash("sha256").update(exportedBytes).digest("hex"), entry.sha256, "entry bytes must match the exporter inventory");
  const expectedMountedBytes = Buffer.from(exportedBytes.toString("utf8").replaceAll(MOBILE_WEB_BASE_TOKEN, "/mobile"));
  const expectedMountedSha256 = createHash("sha256").update(expectedMountedBytes).digest("hex");
  const response = await fetch(new URL(`/mobile/${entry.path}`, gateway.baseUrl));
  const servedBytes = Buffer.from(await response.arrayBuffer());
  const servedSha256 = createHash("sha256").update(servedBytes).digest("hex");
  assert.equal(response.status, 200, "Gateway Mobile mount must serve the current export entry");
  assert.equal(servedSha256, expectedMountedSha256, "Gateway Mobile entry must match the deploy-base transformed current export");
  await context.writeArtifactJson("mobile-web-mounted-entry.json", {
    path: entry.path,
    status: response.status,
    exportSha256: entry.sha256,
    expectedMountedSha256,
    servedSha256,
    matchesDeployTransform: true,
    gatewayManifestSha256,
    gatewayManifestResourceCount,
  });
}
