import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "runtime-workspace-state-contract",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway and app-server",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const projectName = `runtime-state-${stamp}`;
  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "runtime-workspace-state",
  });
  const configDir = context.pathInState("kcoder-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("kcoder-config/settings.json", {});
  await context.writeStateJson("kcoder-config/credentials.json", {});
  const gateway = await startGateway(context, {
    label: "runtime-workspace-state-gateway",
    workspace,
    auth: true,
    serversStore: context.pathInState("servers-store.json"),
    env: { KCODER_CONFIG_DIR: configDir },
  });
  const evidence = {
    stage: "setup",
    projectName,
    workspace: resolve(workspace),
    steps: [],
    cleanup: [],
    diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] },
  };
  const chromium = await startChromium(context, { label: "runtime-workspace-state" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  let projectId = "";
  let failure;

  try {
    evidence.stage = "login";
    await login(page, gateway);

    evidence.stage = "create-project";
    projectId = await createProject(page, workspace, projectName);
    evidence.projectId = projectId;
    evidence.steps.push({ label: "project-created", projectId });

    evidence.stage = "assert-live-state";
    const live = await workspaceState(page, projectName);
    evidence.live = live;
    assertWorkspaceContract(live, { projectId, projectName, workspace });
    evidence.steps.push({ label: "dom-and-runtime-state-agree" });
    await shot(page, context, "01-live-workspace-state.png");

    evidence.stage = "assert-reloaded-state";
    await page.reload({ waitUntil: "domcontentloaded" });
    await byProject(page, projectName).waitFor({ state: "visible", timeout: 30_000 });
    const restored = await workspaceState(page, projectName);
    evidence.restored = restored;
    assertWorkspaceContract(restored, { projectId, projectName, workspace });
    assert.deepEqual(restored.runtime, live.runtime, "重载后 runtime workspace 描述发生漂移");
    evidence.steps.push({ label: "state-survives-reload" });
    await shot(page, context, "02-reloaded-workspace-state.png");

    assertDiagnostics(evidence);
    evidence.stage = "passed";
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    evidence.failureDom = await page.locator("body").innerText().catch(domError => String(domError));
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    if (projectId) {
      try {
        await removeProject(page, projectName, projectId);
        evidence.cleanup.push({ kind: "project", id: projectId, remaining: 0 });
      } catch (error) {
        evidence.cleanup.push({ kind: "project", id: projectId, error: String(error) });
      }
    }
    await context.writeArtifactJson("runtime-workspace-state-diagnostic.json", evidence);
  }
  if (failure) throw failure;
  return {
    steps: evidence.steps,
    live: evidence.live,
    restored: evidence.restored,
    diagnostics: evidence.diagnostics,
    cleanup: evidence.cleanup,
  };
});

function observe(page, evidence) {
  const details = () => ({ stage: evidence.stage, at: new Date().toISOString(), url: page.url() });
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000), ...details() }));
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") {
      evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000), ...details() });
    }
  });
  page.on("response", response => {
    if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname, ...details() });
  });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname, ...details() }));
  page.on("websocket", socket => socket.on("socketerror", error => evidence.diagnostics.socketErrors.push({ text: String(error).slice(0, 500), ...details() })));
}

function assertDiagnostics(evidence) {
  assert.deepEqual(evidence.diagnostics.console, [], "工作区状态流程出现 console warning/error");
  assert.deepEqual(evidence.diagnostics.failedResponses, [], "工作区状态流程出现 4xx/5xx");
  assert.deepEqual(evidence.diagnostics.requestFailures, [], "工作区状态流程出现 request failure");
  assert.deepEqual(evidence.diagnostics.socketErrors, [], "工作区状态流程出现 WebSocket error");
}

function assertWorkspaceContract(state, expected) {
  assert.equal(state.tauri.exists, true, "Gateway Web shim 未安装 __TAURI_INTERNALS__");
  assert.equal(state.tauri.invokeType, "function", "Gateway Web shim 未提供 invoke");
  assert.equal(state.ipcError, null, `runtime.tasks.list 调用失败：${state.ipcError}`);
  assert.ok(state.runtime, "runtime.tasks.list 缺失新建项目 workspace");
  assert.equal(state.runtime.label, expected.projectName);
  assert.equal(resolve(state.runtime.workspacePath), resolve(expected.workspace));
  assert.equal(state.runtime.available, true, "存在的 workspace 被标为不可用");
  assert.equal(state.runtime.error, null, "可用 workspace 不应带错误");
  assert.equal(state.runtime.deviceStatus, "online", "本地 workspace 设备状态不是 online");
  assert.equal(state.dom.id, expected.projectId);
  assert.equal(state.dom.title, expected.projectName);
  assert.equal(state.dom.status, "local", "侧边栏未展示本地运行目标标识");
  assert.equal(state.dom.createDisabled, false, "可用 workspace 的新会话按钮被禁用");
  assert.equal(state.dom.createTitle, "新建项目对话", "可用 workspace 的新会话按钮提示异常");
  assert.match(state.dom.dotStyle || "", /rgb\(31, 214, 96\)/, "在线状态点未使用在线绿色");
}

async function workspaceState(page, projectName) {
  return page.evaluate(async name => {
    const internals = window.__TAURI_INTERNALS__;
    const project = [...document.querySelectorAll('[data-testid="project-item"]')]
      .find(node => node.querySelector('[data-testid^="project-title-"]')?.textContent?.trim() === name);
    const row = project?.querySelector('[data-testid^="project-row-"]');
    const id = row?.getAttribute("data-testid")?.replace("project-row-", "") || "";
    const create = project?.querySelector('[data-testid="project-new-conversation-button"]');
    const dot = id ? project?.querySelector(`[data-testid="project-device-status-${id}-dot"]`) : null;
    let value;
    let ipcError = null;
    try {
      if (typeof internals?.invoke !== "function") throw new Error("invoke unavailable");
      value = await internals.invoke("local_executor_request", { method: "runtime.tasks.list", params: {} });
    } catch (error) {
      ipcError = String(error).slice(0, 1000);
    }
    const workspace = Array.isArray(value?.workspaces)
      ? value.workspaces.find(candidate => candidate?.label === name)
      : null;
    return {
      tauri: { exists: Boolean(internals), invokeType: typeof internals?.invoke },
      ipcError,
      runtime: workspace ? {
        label: typeof workspace.label === "string" ? workspace.label : null,
        workspacePath: typeof workspace.workspacePath === "string" ? workspace.workspacePath : "",
        available: workspace.available ?? null,
        error: typeof workspace.error === "string" ? workspace.error : null,
        deviceStatus: workspace.deviceStatus ?? null,
      } : null,
      dom: {
        id,
        title: project?.querySelector('[data-testid^="project-title-"]')?.textContent?.trim() || "",
        status: id ? project?.querySelector(`[data-testid="project-device-status-${id}"]`)?.textContent?.trim() || "" : "",
        createDisabled: create instanceof HTMLButtonElement ? create.disabled : null,
        createTitle: create?.getAttribute("title") || "",
        dotStyle: dot?.getAttribute("style") || null,
      },
    };
  }, projectName);
}

function byProject(page, name) {
  return page.getByTestId("project-item").filter({ hasText: name }).first();
}

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  const input = page.locator('input[name="token"]');
  if (await input.count()) {
    await input.fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
}

async function createProject(page, workspace, name) {
  await page.getByTestId("projects-create-button").click();
  await page.getByTestId("project-create-local-option").click();
  const picker = page.getByTestId("standalone-folder-project-dialog");
  await picker.waitFor({ state: "visible", timeout: 30_000 });
  const input = picker.getByTestId("device-folder-path-input");
  await input.fill(workspace);
  await input.press("Enter");
  await page.waitForTimeout(300);
  assert.equal(await input.inputValue(), workspace, "目录选择器没有稳定到目标绝对路径");
  await picker.getByTestId("confirm-device-folder-picker-button").click();
  const dialog = page.getByTestId("local-project-create-dialog");
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await dialog.getByTestId("local-project-create-name-input").fill(name);
  await dialog.getByTestId("confirm-local-project-create-button").click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  const testId = await project.locator('[data-testid^="project-row-"]').first().getAttribute("data-testid");
  const id = testId?.replace("project-row-", "") || "";
  assert.match(id, /^\d+$/);
  return id;
}

async function removeProject(page, name, id) {
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  await project.hover();
  await page.getByTestId(`project-menu-${id}`).click();
  await page.getByTestId(`remove-project-${id}`).click();
  await page.getByTestId(`remove-project-dialog-${id}-confirm-button`).click();
  await page.locator(`[data-testid="project-row-${id}"]:visible`).waitFor({ state: "detached", timeout: 30_000 });
}

async function shot(page, context, name) {
  const path = context.pathInCase("system-chromium", "runtime-workspace-state", name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
