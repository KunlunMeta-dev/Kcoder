import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-project-host-settings",
  tier: "full-integration",
  modelPolicy: "model-independent real Gateway and app-server workspace APIs",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const createdWorkspace = resolve(workspace, "created-from-mobile");
  await mkdir(workspace, { recursive: true });
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-project-host-settings-gateway",
    workspace,
    env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-project-host-settings-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcRequests = [];
  const apiRequests = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) apiRequests.push({ method: request.method(), path: url.pathname });
  });
  page.on("websocket", socket => socket.on("framesent", event => {
    try {
      const value = JSON.parse(String(event.payload));
      if (value?.method) rpcRequests.push({ method: value.method, params: value.params ?? null });
    } catch {}
  }));

  await connect(page, gateway);
  const profileId = profileIdFromHome(page.url());
  await page.goto(`${gateway.baseUrl}/open-project?profileId=${encodeURIComponent(profileId)}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-project-route").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("新建目录", { exact: true }).locator("../..").click();
  await page.getByLabel("目录", { exact: true }).fill(createdWorkspace);
  await page.getByText("创建并打开", { exact: true }).click().catch(async error => {
    await context.writeArtifactJson("failure-state.json", { body: await page.locator("body").innerText() });
    await page.screenshot({ path: context.pathInArtifacts("failure.png") });
    throw error;
  });
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => await page.getByTestId("workspace-path").inputValue() === createdWorkspace,
    30_000, "创建目录后的新任务 workspace path");
  assert.equal(await page.getByTestId("workspace-path").inputValue(), createdWorkspace,
    "创建目录后新任务页必须使用 app-server 返回的 workspace path");
  await access(createdWorkspace);
  assert.ok(rpcRequests.some(request => request.method === "runtime.workspaces.prepare"
    && request.params?.workspacePath === createdWorkspace && request.params?.action === "create"),
  "新建目录必须调用真实 runtime.workspaces.prepare");

  await page.goto(`${gateway.baseUrl}/open-project?profileId=${encodeURIComponent(profileId)}`, { waitUntil: "domcontentloaded" });
  await page.getByText("created-from-mobile", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("created-from-mobile", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("created-from-mobile", { exact: true }).click();
  await page.getByText("打开项目", { exact: true }).click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => await page.getByTestId("workspace-path").inputValue() === createdWorkspace,
    30_000, "重开登记项目后的 workspace path");
  assert.equal(await page.getByTestId("workspace-path").inputValue(), createdWorkspace,
    "已登记项目刷新后应可重新选择并打开");
  assert.ok(rpcRequests.some(request => request.method === "runtime.workspaces.open"
    && request.params?.workspacePath === createdWorkspace), "重新打开登记项目必须调用真实 runtime.workspaces.open");

  await page.goto(`${gateway.baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("diagnostics-settings").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("diagnostics-settings").click();
  const diagnosticDialog = page.getByRole("dialog", { name: "连接诊断" });
  await diagnosticDialog.waitFor({ state: "visible", timeout: 30_000 });
  await diagnosticDialog.getByText(gateway.baseUrl, { exact: true }).waitFor({ state: "visible" });
  await diagnosticDialog.getByText(/Local app-server/).waitFor({ state: "visible" });
  const statusRequestsBeforeDiagnosticRefresh = countApi(apiRequests, "/api/servers/status");
  await diagnosticDialog.getByLabel("重新运行诊断").click();
  await waitFor(() => countApi(apiRequests, "/api/servers/status") > statusRequestsBeforeDiagnosticRefresh,
    30_000, "Settings 诊断刷新");
  await diagnosticDialog.getByLabel("关闭", { exact: true }).click();

  await page.getByTestId("settings-host-local").click();
  await page.getByTestId("host-details-route").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("已连接", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(workspace, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const statusRequestsBeforeHostRefresh = countApi(apiRequests, "/api/servers/status");
  await page.getByLabel("刷新 Host 状态").click();
  await waitFor(() => countApi(apiRequests, "/api/servers/status") > statusRequestsBeforeHostRefresh,
    30_000, "Host 详情刷新");
  await page.getByText("在此 Host 新建会话", { exact: true }).click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => await page.getByTestId("workspace-path").inputValue() === workspace,
    30_000, "Host 详情新建会话的默认 workspace path");
  assert.equal(await page.getByTestId("workspace-path").inputValue(), workspace,
    "Host 详情新建会话必须预选当前 Host 默认目录");

  await context.writeArtifactJson("mobile-real-project-host-settings.json", {
    profileId,
    workspace,
    createdWorkspace,
    workspacePrepareRequests: rpcRequests.filter(request => request.method === "runtime.workspaces.prepare"),
    workspaceOpenRequests: rpcRequests.filter(request => request.method === "runtime.workspaces.open"),
    statusApiRequests: apiRequests.filter(request => request.path === "/api/servers/status"),
    diagnostics,
  });
  assert.deepEqual(diagnostics, []);
  return {
    realDirectoryCreateAndOpen: true,
    registeredProjectSurvivesReload: true,
    settingsDiagnosticsRefresh: true,
    hostDetailsRefreshAndNewTask: true,
  };
});

async function connect(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
}

function profileIdFromHome(url) {
  const id = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[1] ?? "");
  assert.ok(id);
  return id;
}

function countApi(requests, path) {
  return requests.filter(request => request.path === path).length;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`等待 ${label} 超时 (${timeoutMs}ms)`);
}
