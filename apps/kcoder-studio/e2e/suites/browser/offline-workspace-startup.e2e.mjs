import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "offline-or-deleted-workspace-startup-resilience",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway and app-server",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const deletedProjectName = `deleted-startup-${stamp}`;
  const evidence = {
    stage: "setup",
    deletedProjectName,
    steps: [],
    diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] },
  };
  const { path: healthyWorkspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "offline-startup-healthy",
  });
  const { path: deletedWorkspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "offline-startup-deleted",
  });
  const configDir = context.pathInState("kcoder-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("kcoder-config/settings.json", {});
  await context.writeStateJson("kcoder-config/credentials.json", {});
  const gateway = await startGateway(context, {
    label: "offline-workspace-startup-gateway",
    workspace: healthyWorkspace,
    auth: true,
    serversStore: context.pathInState("servers-store.json"),
    env: { KCODER_CONFIG_DIR: configDir },
  });
  const chromium = await startChromium(context, { label: "offline-workspace-startup-chromium" });
  let page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);

  try {
    evidence.stage = "create-persisted-project";
    await login(page, gateway);
  const projectId = await createProject(page, deletedWorkspace, deletedProjectName);
  evidence.projectId = projectId;
  evidence.steps.push({ label: "project-created", projectId, workspace: deletedWorkspace });
  await shot(page, context, "01-project-created.png");

  evidence.stage = "delete-workspace";
  await rm(deletedWorkspace, { recursive: true, force: true });
  evidence.steps.push({ label: "workspace-deleted-before-renderer-start", workspace: deletedWorkspace });
  await page.close();

  evidence.stage = "cold-renderer-start";
  page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  const startedAt = Date.now();
  await login(page, gateway);
  const deletedProject = byProject(page, deletedProjectName);
  await deletedProject.waitFor({ state: "visible", timeout: 30_000 });
  evidence.startupReadyMs = Date.now() - startedAt;

  const deletedSnapshot = await projectSnapshot(deletedProject);
  assert.equal(deletedSnapshot.status, "不可用", "已删除 workspace 没有标记为不可用");
  assert.equal(deletedSnapshot.createDisabled, true, "已删除 workspace 仍能创建会话");
  assert.match(deletedSnapshot.createTitle, /不可用/, "禁用按钮没有说明 workspace 不可用");
  assert.match(deletedSnapshot.createAriaLabel, /不可用/, "无障碍标签没有说明 workspace 不可用");
  assert.match(deletedSnapshot.dotClass, /color-sidebar-text-muted/, "离线状态点没有使用弱化颜色");
  assert.equal(deletedSnapshot.dotStyle, null, "离线状态点仍带在线绿色样式");

  const runtime = await runtimeWorkspaces(page);
  const deletedRuntime = runtime.find(item => item.label === deletedProjectName);
  assert.ok(deletedRuntime, "runtime.tasks.list 丢失已删除 workspace 的持久记录");
  assert.equal(deletedRuntime.available, false, "runtime.tasks.list 仍把已删除 workspace 标为可用");
  assert.ok(deletedRuntime.error, "已删除 workspace 缺少诊断错误");

  const healthyProject = page.getByTestId("project-item").filter({ hasNotText: deletedProjectName }).first();
  await healthyProject.waitFor({ state: "visible", timeout: 30_000 });
  const healthyButton = healthyProject.getByTestId("project-item-button");
  const beforeExpanded = await healthyButton.getAttribute("aria-expanded");
  await healthyButton.click();
  const afterExpanded = await healthyButton.getAttribute("aria-expanded");
  assert.notEqual(afterExpanded, beforeExpanded, "离线记录导致健康项目无法交互");

  await page.waitForTimeout(2_000);
  assert.equal(await deletedProject.count(), 1, "离线项目在启动后消失或重复");
  assert.deepEqual(evidence.diagnostics.console.filter(item => item.type === "pageerror" || item.type === "error"), [], "启动出现 console/page error");
  assert.deepEqual(evidence.diagnostics.failedResponses, [], "启动出现 4xx/5xx");
  assert.deepEqual(evidence.diagnostics.requestFailures, [], "启动出现 request failure");
  assert.deepEqual(evidence.diagnostics.socketErrors, [], "启动出现 WebSocket error");

  evidence.deletedProject = deletedSnapshot;
  evidence.runtimeWorkspace = deletedRuntime;
  evidence.healthyInteraction = { beforeExpanded, afterExpanded };
  evidence.steps.push({ label: "cold-start-survived-offline-record", startupReadyMs: evidence.startupReadyMs });
  evidence.stage = "passed";
  await shot(page, context, "02-cold-start-with-deleted-workspace.png");
  await context.writeArtifactJson("offline-workspace-startup.json", evidence);
    return {
      startupReadyMs: evidence.startupReadyMs,
      deletedWorkspacePersisted: true,
      deletedWorkspaceUnavailable: true,
      healthyProjectInteractive: true,
    };
  } catch (error) {
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
    await context.writeArtifactJson("offline-workspace-startup.json", evidence);
    throw error;
  }
});

function observe(page, evidence) {
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000) }));
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") {
      evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000) });
    }
  });
  page.on("response", response => {
    if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname });
  });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname }));
  page.on("websocket", socket => socket.on("socketerror", error => evidence.diagnostics.socketErrors.push(String(error).slice(0, 1000))));
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
  const pathInput = picker.getByTestId("device-folder-path-input");
  await pathInput.fill(workspace);
  await pathInput.press("Enter");
  await page.waitForTimeout(300);
  assert.equal(await pathInput.inputValue(), workspace, "目录选择器没有稳定到目标绝对路径");
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

function byProject(page, name) {
  return page.getByTestId("project-item").filter({ hasText: name }).first();
}

async function projectSnapshot(project) {
  return project.evaluate(node => {
    const row = node.querySelector('[data-testid^="project-row-"]');
    const id = row?.getAttribute("data-testid")?.replace("project-row-", "") || "";
    const create = node.querySelector('[data-testid="project-new-conversation-button"]');
    const dot = id ? node.querySelector(`[data-testid="project-device-status-${id}-dot"]`) : null;
    return {
      id,
      title: node.querySelector('[data-testid^="project-title-"]')?.textContent?.trim() || "",
      status: id ? node.querySelector(`[data-testid="project-device-status-${id}"]`)?.textContent?.trim() || "" : "",
      createDisabled: create instanceof HTMLButtonElement ? create.disabled : null,
      createTitle: create?.getAttribute("title") || "",
      createAriaLabel: create?.getAttribute("aria-label") || "",
      dotClass: dot?.getAttribute("class") || "",
      dotStyle: dot?.getAttribute("style") || null,
    };
  });
}

async function runtimeWorkspaces(page) {
  return page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") throw new Error("window.__TAURI_INTERNALS__.invoke 不可用");
    const value = await invoke("local_executor_request", { method: "runtime.tasks.list", params: {} });
    return Array.isArray(value?.workspaces) ? value.workspaces.map(workspace => ({
      label: typeof workspace?.label === "string" ? workspace.label : "",
      available: workspace?.available === true,
      error: typeof workspace?.error === "string" ? workspace.error : null,
      deviceStatus: typeof workspace?.deviceStatus === "string" ? workspace.deviceStatus : null,
      pathSuffix: String(workspace?.workspacePath || "").replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/"),
    })) : [];
  });
}

async function shot(page, context, name) {
  await page.screenshot({ path: context.pathInArtifacts(name), fullPage: true });
}
