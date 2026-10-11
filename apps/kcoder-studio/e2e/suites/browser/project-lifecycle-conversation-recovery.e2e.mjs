import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "project-edit-remove-and-conversation-refresh-recovery",
  tier: "browser-real-app-server",
  modelPolicy: "model-independent deterministic provider with a real KCoder app-server process",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const originalName = `lifecycle-${stamp}`;
  const renamedName = `lifecycle-renamed-${stamp}`;
  const marker = `LIFECYCLE_RECOVERY_OK_${stamp}`;
  const prompt = `Reply exactly ${marker}. Do not call any tool.`;
  const evidence = {
    stage: "setup",
    originalName,
    renamedName,
    marker,
    prompt,
    steps: [],
    cleanup: [],
    diagnostics: { console: [], failedResponses: [], requestFailures: [], sockets: [] },
  };
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "project-lifecycle-recovery" });
  const configDir = context.pathInState("kcoder-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("kcoder-config/settings.json", {});
  await context.writeStateJson("kcoder-config/credentials.json", {
    "project-lifecycle-e2e": { type: "api", key: "deterministic-local-fixture" },
  });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("kcoder-settings.json", {
    active_provider: "project-lifecycle-e2e",
    providers: {
      "project-lifecycle-e2e": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "project-lifecycle-e2e-model",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 8_192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Project Lifecycle E2E",
    runtime: "kcoder",
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    label: "project-lifecycle-recovery-gateway",
    workspace,
    serversFile,
    auth: true,
    env: { KCODER_CONFIG_DIR: configDir },
  });
  const chromium = await startChromium(context, { label: "project-lifecycle-recovery" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  let projectId = "";
  let taskId = "";
  let currentName = originalName;
  let failure;

  try {
    await login(page, gateway);
    evidence.stage = "root-project-pinning";
    const rootProject = byProject(page, "Project Lifecycle E2E");
    await rootProject.waitFor({ state: "visible", timeout: 30_000 });
    const rootProjectId = (await rootProject.locator('[data-testid^="project-row-"]').first().getAttribute("data-testid")).replace("project-row-", "");
    await toggleProjectPin(page, rootProjectId, false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertSidebarPinned(page, `project-row-${rootProjectId}`, false);
    await toggleProjectPin(page, rootProjectId, true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertSidebarPinned(page, `project-row-${rootProjectId}`, true);
    evidence.steps.push({ label: "root-project-pin-unpin-survives-reload" });
    evidence.stage = "create-project";
    projectId = await createProject(page, workspace, originalName);
    evidence.projectId = projectId;
    evidence.steps.push({ label: "project-created", projectId });
    await toggleProjectPin(page, projectId, true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertSidebarPinned(page, `project-row-${projectId}`, true);
    await toggleProjectPin(page, projectId, false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertSidebarPinned(page, `project-row-${projectId}`, false);
    evidence.steps.push({ label: "registered-project-pin-unpin-survives-reload" });
    await shot(page, context, "01-project-created.png");

    evidence.stage = "edit-project";
    const project = byProject(page, originalName);
    await project.hover();
    await page.getByTestId(`project-menu-${projectId}`).click();
    await page.getByTestId(`edit-project-${projectId}`).click();
    const edit = page.getByTestId("local-project-edit-dialog");
    await edit.waitFor({ state: "visible", timeout: 30_000 });
    const nameInput = edit.getByTestId("local-project-name-input");
    await nameInput.fill("");
    assert.equal(await edit.getByTestId("save-local-project-button").isDisabled(), true, "空名称仍可保存");
    evidence.steps.push({ label: "empty-name-disabled" });
    await nameInput.fill(renamedName);
    await edit.getByTestId("save-local-project-button").click();
    await edit.waitFor({ state: "detached", timeout: 30_000 });
    currentName = renamedName;
    await byProject(page, renamedName).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await byProject(page, originalName).count(), 0);
    evidence.steps.push({ label: "project-renamed" });
    await shot(page, context, "02-project-renamed.png");

    await page.reload({ waitUntil: "domcontentloaded" });
    await byProject(page, renamedName).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await byProject(page, originalName).count(), 0);
    evidence.steps.push({ label: "rename-survives-reload" });

    evidence.stage = "create-conversation";
    const renamed = byProject(page, renamedName);
    await renamed.hover();
    const create = renamed.getByTestId("project-new-conversation-button");
    assert.equal(await create.isDisabled(), false);
    await create.click();
    await send(page, prompt);
    await page.waitForFunction(() => new URL(location.href).searchParams.get("taskId")?.startsWith("kcoder:local:"), undefined, { timeout: 120_000 });
    taskId = new URL(page.url()).searchParams.get("taskId") || "";
    evidence.taskId = taskId;
    await page.waitForFunction(value => [...document.querySelectorAll('[data-testid="message-assistant"]')].some(node => node.textContent?.includes(value)), marker, { timeout: 180_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="thinking-indicator"],[data-testid="pause-response-button"]').length === 0, undefined, { timeout: 180_000 });
    const live = await conversationState(page, prompt, marker);
    assert.deepEqual(live, { users: 1, assistants: 1, promptMatches: 1, markerMatches: 1 });
    evidence.live = live;
    evidence.steps.push({ label: "conversation-completed", taskId });
    await shot(page, context, "03-conversation-complete.png");

    evidence.stage = "restore-conversation";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 120_000 });
    const restored = await conversationState(page, prompt, marker);
    assert.deepEqual(restored, live);
    assert.equal(new URL(page.url()).searchParams.get("taskId"), taskId);
    evidence.restored = restored;
    evidence.steps.push({ label: "conversation-survives-reload" });
    await shot(page, context, "04-conversation-restored.png");

    evidence.stage = "new-conversation-preserves-history";
    await byProject(page, renamedName).getByTestId("project-new-conversation-button").click();
    const secondMarker = `SECOND_HISTORY_OK_${stamp}`;
    await send(page, `Reply exactly ${secondMarker}. Do not call any tool.`);
    await page.waitForFunction(first => {
      const next = new URL(location.href).searchParams.get('taskId');
      return next?.startsWith('kcoder:local:') && next !== first;
    }, taskId, { timeout: 120_000 });
    const secondTaskId = new URL(page.url()).searchParams.get('taskId');
    await page.getByTestId('message-assistant').filter({ hasText: secondMarker }).waitFor({ state: 'visible', timeout: 120_000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="pause-response-button"]'), undefined, { timeout: 120_000 });
    for (let index = 0; index < 2; index++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const toggle = byProject(page, renamedName).getByTestId('project-item-button');
      await toggle.waitFor({ state: 'visible', timeout: 30_000 });
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await byProject(page, renamedName).getByTestId(`runtime-local-task-row-${taskId}`).waitFor({ state: 'visible', timeout: 30_000 });
      await byProject(page, renamedName).getByTestId(`runtime-local-task-row-${secondTaskId}`).waitFor({ state: 'visible', timeout: 30_000 });
    }
    await page.getByTestId(`runtime-local-task-row-${taskId}`).click();
    await page.getByTestId('message-user').filter({ hasText: prompt }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.deepEqual(await conversationState(page, prompt, marker), live);
    evidence.steps.push({ label: 'second-conversation-preserves-first-history', taskId, secondTaskId });

    evidence.stage = "conversation-pinning";
    const projectToggle = byProject(page, renamedName).getByTestId("project-item-button");
    if ((await projectToggle.getAttribute("aria-expanded")) !== "true") await projectToggle.click();
    await page.getByTestId(`runtime-local-task-row-${taskId}`).hover();
    await page.getByTestId(`runtime-local-task-mark-${taskId}`).click();
    await assertSidebarPinned(page, `runtime-local-task-row-${taskId}`, true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertSidebarPinned(page, `runtime-local-task-row-${taskId}`, true);
    await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("message-assistant").filter({ hasText: marker }).waitFor({ state: "visible", timeout: 30_000 });
    await shot(page, context, "04a-conversation-pinned-after-reload.png");
    await page.getByTestId(`runtime-local-task-row-${taskId}`).hover();
    await page.getByTestId(`runtime-local-task-mark-${taskId}`).click();
    await assertSidebarPinned(page, `runtime-local-task-row-${taskId}`, false);
    await page.reload({ waitUntil: "domcontentloaded" });
    const restoredProjectToggle = byProject(page, renamedName).getByTestId("project-item-button");
    await restoredProjectToggle.waitFor({ state: "visible", timeout: 30_000 });
    if ((await restoredProjectToggle.getAttribute("aria-expanded")) !== "true") await restoredProjectToggle.click();
    await assertSidebarPinned(page, `runtime-local-task-row-${taskId}`, false);
    evidence.steps.push({ label: "conversation-pin-unpin-survives-reload" });

    evidence.stage = "archive-remove";
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await archiveTask(page, renamedName, taskId);
    evidence.steps.push({ label: "task-archived" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await byProject(page, renamedName).waitFor({ state: "visible", timeout: 30_000 });
    const archived = await page.evaluate(async () =>
      window.__TAURI_INTERNALS__.invoke("local_executor_request", {
        method: "runtime.archived_conversations.list", params: {},
      }),
    );
    assert.ok(archived.items.some(item => item.taskId === taskId), "归档任务必须在刷新后从服务端恢复");
    evidence.steps.push({ label: "task-archive-survives-reload", taskId });
    taskId = "";
    await removeProject(page, renamedName, projectId);
    evidence.steps.push({ label: "project-removed" });
    projectId = "";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1_000);
    assert.equal(await byProject(page, renamedName).count(), 0, "移除项目在重载后回生");
    evidence.steps.push({ label: "removal-survives-reload" });
    assert.ok(model.requests.length >= 1, "确定性 provider 未收到会话请求");
    evidence.providerRequests = model.requests.length;
    evidence.stage = "passed";
    assertDiagnostics(evidence);
    await shot(page, context, "05-project-removed-after-reload.png");
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    evidence.failureDom = await page.locator("body").innerText().catch(domError => String(domError));
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    await cleanup(page, gateway.baseUrl, currentName, projectId, taskId, evidence);
    await context.writeArtifactJson("project-lifecycle-conversation-recovery.json", evidence);
  }
  if (failure) throw failure;
  return { steps: evidence.steps, live: evidence.live, restored: evidence.restored, providerRequests: evidence.providerRequests, diagnostics: evidence.diagnostics, cleanup: evidence.cleanup };
});

function observe(page, evidence) {
  const context = () => ({ stage: evidence.stage, at: new Date().toISOString(), url: page.url() });
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000), ...context() }));
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000), ...context() });
  });
  page.on("response", response => {
    if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname });
  });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname }));
  page.on("websocket", socket => {
    const record = { path: new URL(socket.url()).pathname, errors: [], closed: false };
    evidence.diagnostics.sockets.push(record);
    socket.on("socketerror", error => record.errors.push(String(error).slice(0, 500)));
    socket.on("close", () => { record.closed = true; });
  });
}

function assertDiagnostics(evidence) {
  assert.deepEqual(
    evidence.diagnostics.console.filter(entry => entry.type === "error" || entry.type === "pageerror"),
    [],
    "用户流程出现 console/page error",
  );
  assert.deepEqual(evidence.diagnostics.failedResponses, [], "用户流程出现 4xx/5xx");
  assert.deepEqual(evidence.diagnostics.requestFailures, [], "用户流程出现 request failure");
  assert.equal(evidence.diagnostics.sockets.reduce((sum, socket) => sum + socket.errors.length, 0), 0, "用户流程出现 WebSocket error");
}

async function conversationState(page, prompt, marker) {
  return {
    users: await page.getByTestId("message-user").count(),
    assistants: await page.getByTestId("message-assistant").count(),
    promptMatches: await page.getByTestId("message-user").filter({ hasText: prompt }).count(),
    markerMatches: await page.getByTestId("message-assistant").filter({ hasText: marker }).count(),
  };
}

function byProject(page, name) { return page.getByTestId("project-item").filter({ hasText: name }).first(); }

async function assertSidebarPinned(page, id, pinned) {
  await page.waitForFunction(({ id, pinned }) => {
    const row = document.querySelector(`[data-testid="${CSS.escape(id)}"]`);
    return Boolean(row) && Boolean(row.closest('[data-testid="sidebar-pinned-section"]')) === pinned;
  }, { id, pinned }, { timeout: 30_000 });
}

async function toggleProjectPin(page, id, pinned) {
  const row = page.getByTestId(`project-row-${id}`);
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.hover();
  await page.getByTestId(`project-menu-${id}`).click();
  await page.getByTestId(`pin-project-${id}`).click();
  await assertSidebarPinned(page, `project-row-${id}`, pinned);
}

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  const input = page.locator('input[name="token"]');
  if (await input.count()) {
    await input.fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
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

async function send(page, prompt) {
  const input = page.getByTestId("chat-message-input");
  await input.waitFor({ state: "visible", timeout: 120_000 });
  await input.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-message-input"]')?.getAttribute("contenteditable") === "true", undefined, { timeout: 120_000 });
  await page.keyboard.insertText(prompt);
  await page.waitForFunction(() => { const button = document.querySelector('[data-testid="send-message-button"]'); return button instanceof HTMLButtonElement && !button.disabled; }, undefined, { timeout: 120_000 });
  await page.getByTestId("send-message-button").click();
}

async function archiveTask(page, projectName, taskId) {
  const project = byProject(page, projectName);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  const button = project.getByTestId("project-item-button");
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const row = page.locator(`[data-testid="runtime-local-task-row-${escapeCss(taskId)}"]:visible`);
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.hover();
  await page.getByTestId(`runtime-local-task-archive-${taskId}`).click();
  const toast = page.getByTestId(`runtime-local-task-archive-toast-${taskId}`);
  await toast.waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId(`runtime-local-task-archive-undo-${taskId}`).click();
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(3_100);
  assert.equal(await row.isVisible(), true, "撤销后不得继续执行归档定时器");
  await row.hover();
  await page.getByTestId(`runtime-local-task-archive-${taskId}`).click();
  await toast.waitFor({ state: "visible", timeout: 10_000 });
  await toast.waitFor({ state: "detached", timeout: 15_000 });
  await page.getByTestId(`runtime-local-task-row-${taskId}`).waitFor({ state: "detached", timeout: 30_000 });
}

async function removeProject(page, name, id) {
  const project = byProject(page, name);
  await project.hover();
  await page.getByTestId(`project-menu-${id}`).click();
  await page.getByTestId(`remove-project-${id}`).click();
  await page.getByTestId(`remove-project-dialog-${id}-confirm-button`).click();
  await page.locator(`[data-testid="project-row-${id}"]:visible`).waitFor({ state: "detached", timeout: 30_000 });
}

async function cleanup(page, baseUrl, projectName, projectId, taskId, evidence) {
  if (taskId) {
    try { await page.goto(baseUrl, { waitUntil: "domcontentloaded" }); await archiveTask(page, projectName, taskId); evidence.cleanup.push({ kind: "task", id: taskId, remaining: 0 }); }
    catch (error) { evidence.cleanup.push({ kind: "task", id: taskId, error: String(error) }); }
  }
  if (projectId) {
    try { await removeProject(page, projectName, projectId); evidence.cleanup.push({ kind: "project", id: projectId, remaining: 0 }); }
    catch (error) { evidence.cleanup.push({ kind: "project", id: projectId, error: String(error) }); }
  }
}

function escapeCss(value) { return value.replace(/["\\]/g, "\\$&"); }
async function shot(page, context, name) { const path = context.pathInCase("system-chromium", "project-lifecycle-recovery", name); await mkdir(dirname(path), { recursive: true }); await page.screenshot({ path, fullPage: true }); }
