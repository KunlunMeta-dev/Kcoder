import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const execFile = promisify(execFileCallback);
const ALPHA_MODEL = "alpha-e2e-model";
const BETA_MODEL = "beta-e2e-model";

await runE2E(import.meta.url, {
  testId: "workspace-conversation-model-project-preferences-persistence-isolation",
  tier: "browser-real-app-server",
  modelPolicy: "two model-independent deterministic providers through one real app-server",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const alphaName = `prefs-alpha-${stamp}`;
  const betaName = `prefs-beta-${stamp}`;
  const alphaPrompt = `ALPHA_CONVERSATION_${stamp}`;
  const betaPrompt = `BETA_CONVERSATION_${stamp}`;
  const alphaFixture = await materializeWorkspace(context, "minimal", { instanceId: "conversation-prefs-alpha" });
  const betaFixture = await materializeWorkspace(context, "minimal", { instanceId: "conversation-prefs-beta" });
  await initRepository(alphaFixture.path);
  await initRepository(betaFixture.path);
  const evidence = {
    stage: "setup", steps: [], models: [], preferences: [], tasks: [], cleanup: [],
    diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] },
  };

  const configDir = context.pathInState("kcoder-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("kcoder-config/settings.json", {});
  await context.writeStateJson("kcoder-config/credentials.json", {
    "alpha-e2e": { type: "api", key: "deterministic-alpha" },
    "beta-e2e": { type: "api", key: "deterministic-beta" },
  });
  const modelFixture = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("kcoder-settings.json", {
    active_provider: "beta-e2e",
    providers: {
      "alpha-e2e": provider(modelFixture.baseUrl, ALPHA_MODEL),
      "beta-e2e": provider(modelFixture.baseUrl, BETA_MODEL),
    },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Conversation Preferences E2E", runtime: "kcoder", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace: alphaFixture.path, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    label: "conversation-preferences-gateway", workspace: alphaFixture.path, serversFile, auth: true,
    env: { KCODER_CONFIG_DIR: configDir },
  });
  const chromium = await startChromium(context, { label: "conversation-preferences-chromium" });
  const browserContext = await chromium.browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await browserContext.newPage();
  observe(page, evidence);
  const projects = [];
  const tasks = [];
  const deletedTaskIds = new Set();
  let failure;

  try {
    await login(page, gateway);
    evidence.stage = "create-projects";
    const alphaId = await createProject(page, alphaFixture.path, alphaName); projects.push({ id: alphaId, name: alphaName });
    const betaId = await createProject(page, betaFixture.path, betaName); projects.push({ id: betaId, name: betaName });

    evidence.stage = "target-default-model";
    await selectProject(page, alphaId, alphaName);
    await assertModelButton(page, BETA_MODEL);
    evidence.models.push({ label: "target-current-provider-default", model: BETA_MODEL });
    await selectModel(page, ALPHA_MODEL);
    await assertModelButton(page, ALPHA_MODEL);

    evidence.stage = "alpha-conversation";
    await sendPrompt(page, alphaPrompt);
    const alphaTaskId = await waitConversation(page, alphaPrompt);
    tasks.push({ id: alphaTaskId, projectName: alphaName, prompt: alphaPrompt, projectId: alphaId });
    evidence.tasks.push({ label: "alpha-created", id: alphaTaskId, model: ALPHA_MODEL });
    assert.equal(modelFixture.requests.at(-1)?.model, ALPHA_MODEL);
    await assertTaskListed(page, alphaName, alphaTaskId, alphaPrompt);
    await shot(page, context, "01-alpha-explicit-model-task.png");

    evidence.stage = "project-preference";
    await openBlankProject(page, alphaName);
    await page.getByTestId("execution-mode-button").click();
    await page.getByTestId("execution-mode-git-worktree-button").click();
    await assertExecutionMode(page, /新工作树|worktree/i);
    evidence.preferences.push(await localPreferences(page, "alpha-worktree-selected"));
    await selectProject(page, betaId, betaName);
    await assertExecutionMode(page, /本地模式|在本地处理|current workspace|local/i);
    await selectProject(page, alphaId, alphaName);
    await assertExecutionMode(page, /新工作树|worktree/i);
    evidence.steps.push({ label: "execution-mode-preference-isolated-by-project" });

    evidence.stage = "refresh-blank-preferences";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await selectProject(page, alphaId, alphaName);
    await assertExecutionMode(page, /新工作树|worktree/i);
    const refreshedPreferences = await localPreferences(page, "after-refresh");
    evidence.preferences.push(refreshedPreferences);
    assert.equal(Boolean(refreshedPreferences.value?.new_chat_model_selection), false);
    assert.equal(refreshedPreferences.value?.wework_project_work_preferences?.[`project:${alphaId}`]?.executionMode, "git_worktree");
    await openBlankProject(page, betaName);
    await assertModelButton(page, BETA_MODEL);
    await assertExecutionMode(page, /本地模式|在本地处理|current workspace|local/i);
    evidence.steps.push({ label: "refresh-restores-ui-preference-but-target-default-model-remains-authoritative" });

    evidence.stage = "beta-conversation";
    await sendPrompt(page, betaPrompt);
    const betaTaskId = await waitConversation(page, betaPrompt);
    tasks.push({ id: betaTaskId, projectName: betaName, prompt: betaPrompt, projectId: betaId });
    evidence.tasks.push({ label: "beta-created", id: betaTaskId, model: BETA_MODEL });
    assert.equal(modelFixture.requests.at(-1)?.model, BETA_MODEL);
    await assertTaskListed(page, betaName, betaTaskId, betaPrompt);

    evidence.stage = "task-refresh-reconnect";
    await openRuntimeTask(page, alphaName, alphaTaskId);
    await assertConversation(page, alphaPrompt);
    await assertModelButton(page, ALPHA_MODEL);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await openRuntimeTask(page, alphaName, alphaTaskId);
    await assertConversation(page, alphaPrompt);
    await assertModelButton(page, ALPHA_MODEL);
    evidence.steps.push({ label: "task-model-and-transcript-restored-after-new-websocket" });
    await shot(page, context, "02-alpha-restored-after-reconnect.png");

    evidence.stage = "second-client-isolation";
    const secondContext = await chromium.browser.newContext({ viewport: { width: 1280, height: 800 } });
    const secondPage = await secondContext.newPage();
    observe(secondPage, evidence, "second-client");
    await login(secondPage, gateway);
    await openBlankProject(secondPage, alphaName);
    await assertExecutionMode(secondPage, /本地模式|在本地处理|current workspace|local/i);
    await assertModelButton(secondPage, BETA_MODEL);
    assert.equal(await secondPage.evaluate(() => localStorage.getItem("wework.localUser.preferences")), null);
    await openRuntimeTask(secondPage, alphaName, alphaTaskId);
    await assertConversation(secondPage, alphaPrompt);
    await assertModelButton(secondPage, ALPHA_MODEL);
    await secondContext.close();
    evidence.steps.push({ label: "second-browser-ui-preferences-isolated-but-task-model-shared" });

    evidence.stage = "archive";
    for (const task of tasks) {
      await archiveTask(page, task.projectName, task.id);
      evidence.cleanup.push({ kind: "task-archive", id: task.id, remaining: 0 });
    }
    evidence.archiveRawBeforeNavigation = await waitForArchivedCount(page, tasks.length);
    evidence.steps.push({ label: "both-tasks-archived-from-project-lists" });

    evidence.stage = "archived-lifecycle";
    await page.goto(`${gateway.baseUrl}/settings/archived-conversations`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("archived-conversations-settings-page").waitFor({ state: "visible", timeout: 30_000 });
    evidence.archiveRawAfterNavigation = await rawRuntimeRequest(page, "runtime.archived_conversations.list", {});
    const archivedBeforeByTaskId = new Map(
      evidence.archiveRawBeforeNavigation.items.map(item => [item.taskId, item]),
    );
    for (const archivedAfter of evidence.archiveRawAfterNavigation.items) {
      const archivedBefore = archivedBeforeByTaskId.get(archivedAfter.taskId);
      assert.ok(archivedBefore, `archive ${archivedAfter.taskId} disappeared across settings navigation`);
      assert.equal(
        archivedAfter.createdAt,
        archivedBefore.createdAt,
        `archive ${archivedAfter.taskId} changed createdAt across settings navigation`,
      );
    }
    const alphaArchivedRecord = evidence.archiveRawAfterNavigation.items.find(item => item.taskId === alphaTaskId);
    assert.ok(alphaArchivedRecord?.projectKey, "alpha archive did not retain its runtime project key");
    const alphaArchivedSuffix = sanitizeTestId(`local-${alphaTaskId}`);
    const betaArchivedSuffix = sanitizeTestId(`local-${betaTaskId}`);
    const alphaArchivedItem = page.getByTestId(`archived-item-${alphaArchivedSuffix}`);
    const betaArchivedItem = page.getByTestId(`archived-item-${betaArchivedSuffix}`);
    await alphaArchivedItem.waitFor({ state: "visible", timeout: 30_000 });
    await betaArchivedItem.waitFor({ state: "visible", timeout: 30_000 });

    const archivedSearch = page.getByTestId("archived-search-input");
    await archivedSearch.fill(alphaPrompt);
    await alphaArchivedItem.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await betaArchivedItem.count(), 0, "archived search did not isolate the matching task");
    await archivedSearch.fill("");
    await betaArchivedItem.waitFor({ state: "visible", timeout: 10_000 });

    await page.getByTestId("archived-filter-menu").click();
    await page.getByTestId("archived-source-option-cloud").click();
    assert.equal(await alphaArchivedItem.count(), 0, "cloud filter retained a local archive");
    await page.getByTestId("archived-filter-menu").click();
    await page.getByTestId("archived-source-option-local").click();
    await alphaArchivedItem.waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("archived-filter-menu").click();
    await page.getByTestId("archived-sort-option-alphabetical").click();
    await page.getByTestId("archived-filter-menu").click();
    assert.equal(
      await page.getByTestId("archived-sort-option-alphabetical").getAttribute("aria-checked"),
      "true",
    );
    await page.keyboard.press("Escape");

    await page.getByTestId("archived-project-filter").click();
    const projectFilterMenu = page.getByTestId("archived-project-filter-menu");
    await projectFilterMenu.getByRole("menuitemradio").filter({ hasText: alphaName }).click();
    await alphaArchivedItem.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await betaArchivedItem.count(), 0, "project filter retained another project archive");
    await page.getByTestId("archived-project-filter").click();
    await page.getByTestId("archived-project-option-all").click();
    await betaArchivedItem.waitFor({ state: "visible", timeout: 10_000 });
    evidence.steps.push({ label: "archived-search-source-sort-project-filters" });

    await page.getByTestId(`archived-unarchive-button-${alphaArchivedSuffix}`).click();
    await alphaArchivedItem.waitFor({ state: "detached", timeout: 30_000 });
    await page.getByTestId("archived-unarchive-success").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("archived-view-now-button").click();
    await page.waitForURL(url => url.searchParams.get("taskId") === alphaTaskId, { timeout: 30_000 });
    await assertConversation(page, alphaPrompt);
    await page.waitForTimeout(500);
    assert.equal(
      new URL(page.url()).searchParams.get("taskId"),
      alphaTaskId,
      "View now task deep link was overwritten after leaving settings",
    );
    evidence.steps.push({ label: "archived-task-unarchived-and-opened-via-view-now" });

    await archiveTask(page, alphaName, alphaTaskId);
    await waitForArchivedCount(page, tasks.length);
    await page.goto(`${gateway.baseUrl}/settings/archived-conversations`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("archived-conversations-settings-page").waitFor({ state: "visible", timeout: 30_000 });
    const rearchivedAlphaItem = page.getByTestId(`archived-item-${alphaArchivedSuffix}`);
    const archivedBetaItem = page.getByTestId(`archived-item-${betaArchivedSuffix}`);
    await rearchivedAlphaItem.waitFor({ state: "visible", timeout: 30_000 });
    await archivedBetaItem.waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("archived-bulk-delete-button").click();
    await page.getByTestId("archived-bulk-delete-confirm-dialog-confirm-button").click();
    await rearchivedAlphaItem.waitFor({ state: "detached", timeout: 30_000 });
    await archivedBetaItem.waitFor({ state: "detached", timeout: 30_000 });
    await waitForArchivedCount(page, 0);
    for (const task of tasks) {
      deletedTaskIds.add(task.id);
      evidence.cleanup.push({ kind: "task-delete-bulk", id: task.id, remaining: 0 });
    }
    evidence.steps.push({ label: "rearchived-tasks-permanently-deleted-in-bulk" });
    await shot(page, context, "03-archived-empty-after-delete.png");

    evidence.stage = "cleanup";
    await page.getByTestId("settings-back-button").click();
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    for (const project of [...projects].reverse()) {
      await removeProject(page, project.name, project.id);
      evidence.cleanup.push({ kind: "project", ...project, remaining: 0 });
      projects.splice(projects.findIndex(item => item.id === project.id), 1);
    }
    assertDiagnostics(evidence);
    evidence.stage = "passed";
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    evidence.body = (await page.locator("body").innerText().catch(() => "")).slice(0, 12000);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    if (failure) {
      for (const task of tasks) {
        if (deletedTaskIds.has(task.id)) continue;
        try { await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" }); await archiveTask(page, task.projectName, task.id); evidence.cleanup.push({ kind: "task-archive", id: task.id, remaining: 0 }); }
        catch (error) { evidence.cleanup.push({ kind: "task-archive", id: task.id, error: String(error) }); }
      }
    }
    for (const project of [...projects].reverse()) {
      try { await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" }); await removeProject(page, project.name, project.id); evidence.cleanup.push({ kind: "project", ...project, remaining: 0 }); }
      catch (error) { evidence.cleanup.push({ kind: "project", ...project, error: String(error) }); }
    }
    evidence.providerModels = modelFixture.requests.map(request => request?.model ?? null);
    await context.writeArtifactJson("workspace-conversation-preferences-persistence.json", evidence);
  }
  if (failure) throw failure;
  return evidence;
});

function provider(endpoint, defaultModel) {
  return { api_format: "openai_chat_completions", endpoint, default_model: defaultModel, context_window_tokens: 128_000, output_headroom_tokens: 8_192, max_output_tokens: 8_192, request_timeout_secs: 30, no_proxy: true, extra_body: {} };
}

async function initRepository(workspace) {
  await execFile("git", ["-C", workspace, "init", "-b", "main"]);
  await execFile("git", ["-C", workspace, "config", "user.name", "KCoder Studio E2E"]);
  await execFile("git", ["-C", workspace, "config", "user.email", "kcoder-studio-e2e@example.invalid"]);
  await execFile("git", ["-C", workspace, "add", "."]);
  await execFile("git", ["-C", workspace, "commit", "-m", "baseline"]);
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
  const pathInput = picker.getByTestId("device-folder-path-input");
  await pathInput.fill(workspace);
  await pathInput.press("Enter");
  await page.waitForTimeout(300);
  assert.equal(await pathInput.inputValue(), workspace, "目录选择器没有稳定到目标绝对路径");
  await picker.getByTestId("confirm-device-folder-picker-button").click();
  const dialog = page.getByTestId("local-project-create-dialog");
  await dialog.getByTestId("local-project-create-name-input").fill(name);
  await dialog.getByTestId("confirm-local-project-create-button").click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  const project = byProject(page, name); await project.waitFor({ state: "visible", timeout: 30_000 });
  const testId = await project.locator('[data-testid^="project-row-"]').first().getAttribute("data-testid");
  const id = testId?.replace("project-row-", "") || ""; assert.match(id, /^\d+$/); return id;
}

function byProject(page, name) { return page.getByTestId("project-item").filter({ hasText: name }).first(); }

async function selectProject(page, id, name) {
  await page.getByTestId("project-work-button").first().click();
  await page.getByTestId(`project-option-${id}`).click();
  await page.getByTestId("project-work-button").filter({ hasText: name }).waitFor({ state: "visible", timeout: 30_000 });
}

async function openBlankProject(page, name) {
  const project = byProject(page, name); await project.waitFor({ state: "visible", timeout: 30_000 });
  await project.hover(); await project.getByTestId("project-new-conversation-button").click();
  await page.getByTestId("project-work-button").filter({ hasText: name }).waitFor({ state: "visible", timeout: 30_000 });
}

async function selectModel(page, model) {
  await page.getByTestId("model-selector-button").click();
  const option = page.locator(`[data-testid^="model-option-"][data-testid$="::${model}"]:visible`);
  if (!(await option.isVisible().catch(() => false))) {
    await page.getByTestId("model-control-menu-model").click();
  }
  await option.click();
  await page.getByTestId("model-selector-menu").waitFor({ state: "visible", timeout: 30_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("model-selector-menu").waitFor({ state: "detached", timeout: 30_000 });
  await assertModelButton(page, model);
  await page.getByTestId("chat-message-input").click();
}

async function assertModelButton(page, model) {
  const button = page.getByTestId("model-selector-button");
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(expected => document.querySelector('[data-testid="model-selector-button"]')?.textContent?.includes(expected), model, { timeout: 30_000 });
}

async function assertExecutionMode(page, label) {
  const button = page.getByTestId("execution-mode-button");
  await button.waitFor({ state: "visible", timeout: 30_000 });
  assert.match((await button.innerText()).trim(), label);
}

async function sendPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input"); await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click(); await page.keyboard.insertText(prompt);
  await page.waitForFunction(() => { const button = document.querySelector('[data-testid="send-message-button"]'); return button instanceof HTMLButtonElement && !button.disabled; }, undefined, { timeout: 30_000 });
  await page.getByTestId("send-message-button").click();
}

async function waitConversation(page, prompt) {
  await assertConversation(page, prompt);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="thinking-indicator"],[data-testid="pause-response-button"]').length === 0, undefined, { timeout: 30_000 });
  const taskId = new URL(page.url()).searchParams.get("taskId") || "";
  assert.ok(taskId.startsWith("kcoder:local:"), `unexpected task id ${taskId}`);
  return taskId;
}

async function assertConversation(page, prompt) {
  await page.getByTestId("message-user").filter({ hasText: prompt }).last().waitFor({ state: "visible", timeout: 30_000 });
  const reply = `deterministic renderer response: ${prompt}`;
  await page.waitForFunction(expected => [...document.querySelectorAll('[data-testid="message-assistant"]')].some(node => node.textContent?.includes(expected)), reply, { timeout: 30_000 });
  assert.equal(await page.getByTestId("message-assistant").filter({ hasText: reply }).count(), 1);
}

async function assertTaskListed(page, projectName, taskId, prompt) {
  const project = byProject(page, projectName); const button = project.getByTestId("project-item-button");
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const row = page.locator(`[data-testid="runtime-local-task-row-${escapeCss(taskId)}"]:visible`);
  await row.waitFor({ state: "visible", timeout: 30_000 }); assert.match(await row.innerText(), new RegExp(prompt));
}

async function openRuntimeTask(page, projectName, taskId) {
  await assertTaskListed(page, projectName, taskId, "");
  const row = page.locator(`[data-testid="runtime-local-task-row-${escapeCss(taskId)}"]:visible`);
  await row.evaluate(node => node.click());
  await page.waitForURL(url => url.searchParams.get("taskId") === taskId, { timeout: 30_000 });
}

async function archiveTask(page, projectName, taskId) {
  const project = byProject(page, projectName); await project.waitFor({ state: "visible", timeout: 30_000 });
  const button = project.getByTestId("project-item-button"); if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const row = page.locator(`[data-testid="runtime-local-task-row-${escapeCss(taskId)}"]:visible`); await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.hover(); await page.getByTestId(`runtime-local-task-archive-${taskId}`).click();
  await row.waitFor({ state: "detached", timeout: 30_000 });
  await page.getByTestId(`runtime-local-task-archive-toast-close-${taskId}`).click().catch(() => undefined);
}

async function removeProject(page, name, id) {
  const project = byProject(page, name); await project.waitFor({ state: "visible", timeout: 30_000 }); await project.hover();
  await page.getByTestId(`project-menu-${id}`).click(); await page.getByTestId(`remove-project-${id}`).click();
  await page.getByTestId(`remove-project-dialog-${id}-confirm-button`).click();
  await page.locator(`[data-testid="project-row-${id}"]:visible`).waitFor({ state: "detached", timeout: 30_000 });
}

async function localPreferences(page, label) {
  return page.evaluate(snapshotLabel => { const raw = localStorage.getItem("wework.localUser.preferences"); return { label: snapshotLabel, raw, value: raw ? JSON.parse(raw) : null }; }, label);
}

async function rawRuntimeRequest(page, method, params) {
  return page.evaluate(async ({ method, params }) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return { unavailable: true };
    return internals.invoke("local_executor_request", { method, params });
  }, { method, params });
}

async function waitForArchivedCount(page, expected) {
  const deadline = Date.now() + 30_000;
  let response = { items: [], total: 0 };
  while (Date.now() < deadline) {
    response = await rawRuntimeRequest(page, "runtime.archived_conversations.list", {});
    if (response?.total === expected) return response;
    await page.waitForTimeout(150);
  }
  assert.equal(response?.total, expected, `expected ${expected} durable archives, got ${response?.total}`);
  return response;
}

function observe(page, evidence, client = "primary") {
  page.on("pageerror", error => evidence.diagnostics.console.push({ client, type: "pageerror", stage: evidence.stage, text: error.message }));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) evidence.diagnostics.console.push({ client, type: message.type(), stage: evidence.stage, text: message.text() }); });
  page.on("response", response => { if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ client, stage: evidence.stage, status: response.status(), path: new URL(response.url()).pathname }); });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ client, stage: evidence.stage, error: request.failure()?.errorText, path: new URL(request.url()).pathname }));
  page.on("websocket", socket => socket.on("socketerror", error => evidence.diagnostics.socketErrors.push({ client, stage: evidence.stage, text: String(error) })));
}

function assertDiagnostics(evidence) {
  assert.deepEqual(evidence.diagnostics.console, []); assert.deepEqual(evidence.diagnostics.failedResponses, []);
  assert.deepEqual(evidence.diagnostics.requestFailures, []); assert.deepEqual(evidence.diagnostics.socketErrors, []);
}

function sanitizeTestId(value) { return value.replace(/[^a-zA-Z0-9_-]/g, "-"); }
function escapeCss(value) { return value.replace(/["\\]/g, "\\$&"); }

async function shot(page, context, name) {
  const path = context.pathInCase("system-chromium", "workspace-conversation-preferences", name);
  await mkdir(dirname(path), { recursive: true }); await page.screenshot({ path, fullPage: true });
}
