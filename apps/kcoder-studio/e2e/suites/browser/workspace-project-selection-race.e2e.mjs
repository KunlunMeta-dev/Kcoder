import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "workspace-project-selection-race-ten-consecutive-attempts",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway and app-server",
  retainSuccessLogs: true,
}, async context => {
  const evidence = {
    stage: "setup",
    expectedWorkspace: "",
    attempts: [],
    cleanup: [],
    diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [], runtimeRpc: [] },
  };
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "workspace-project-selection-race" });
  evidence.expectedWorkspace = resolve(workspace);
  const gateway = await startGateway(context, { label: "workspace-project-selection-race-gateway", workspace, auth: true });
  const chromium = await startChromium(context, { label: "workspace-project-selection-race" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  const projects = [];
  let failure;

  try {
    await login(page, gateway);
    for (let index = 1; index <= 10; index += 1) {
      evidence.stage = `attempt-${index}-create`;
      const projectName = `root-race-${Date.now()}-${index}`;
      const projectId = await createProject(page, workspace, projectName);
      projects.push({ id: projectId, name: projectName });

      evidence.stage = `attempt-${index}-open-files`;
      const startedAt = Date.now();
      const composerProjectText = (await page.getByTestId("project-work-button").first().innerText()).trim();
      await openRightFiles(page);
      const panelRootPath = (await page.getByTestId("workspace-file-path").innerText()).trim();
      const openedInMs = Date.now() - startedAt;
      const rootMatches = resolve(panelRootPath) === resolve(workspace);
      const composerMatches = composerProjectText.includes(projectName);
      const attempt = { index, projectName, projectId, composerProjectText, composerMatches, panelRootPath, expectedWorkspace: resolve(workspace), rootMatches, openedInMs };
      evidence.attempts.push(attempt);
      await shot(page, context, `attempt-${index}-${rootMatches ? "matched" : "mismatch"}.png`);
      if (!composerMatches) throw new Error(`COMPOSER_PROJECT_MISMATCH attempt=${index} expected=${projectName} actual=${composerProjectText}`);
      if (!rootMatches) throw new Error(`WORKSPACE_ROOT_MISMATCH attempt=${index} expected=${resolve(workspace)} actual=${panelRootPath}`);

      await closeRightWorkspace(page);
      evidence.stage = `attempt-${index}-cleanup-project`;
      await removeProject(page, projectName, projectId);
      projects.splice(projects.findIndex(project => project.id === projectId), 1);
      await page.waitForTimeout(200);
    }
    assert.equal(evidence.attempts.length, 10);
    assert.equal(evidence.attempts.every(attempt => attempt.composerMatches), true);
    assert.equal(evidence.attempts.every(attempt => attempt.rootMatches), true);
    assertDiagnostics(evidence.diagnostics);
    evidence.stage = "passed";
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    for (const project of [...projects].reverse()) {
      try {
        await removeProject(page, project.name, project.id);
        evidence.cleanup.push({ kind: "project", id: project.id, name: project.name, remaining: 0 });
      } catch (error) {
        evidence.cleanup.push({ kind: "project", id: project.id, name: project.name, error: String(error) });
      }
    }
    await context.writeArtifactJson("workspace-project-selection-race.json", evidence);
  }
  if (failure) throw failure;
  return { attempts: evidence.attempts, diagnostics: evidence.diagnostics, cleanup: evidence.cleanup };
});

function observe(page, evidence) {
  const details = () => ({ stage: evidence.stage, at: new Date().toISOString(), url: page.url() });
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000), ...details() }));
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000), ...details() });
  });
  page.on("response", response => { if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname, ...details() }); });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname, ...details() }));
  page.on("websocket", socket => {
    const trackedRequests = new Map();
    socket.on("framesent", event => {
      const payload = parseSocketPayload(event.payload);
      if (!payload || typeof payload !== "object") return;
      const method = typeof payload.method === "string" ? payload.method : "";
      if (method !== "runtime.projects.upsert_local" && method !== "runtime.tasks.list") return;
      const id = payload.id == null ? "" : String(payload.id);
      if (id) trackedRequests.set(id, method);
      evidence.diagnostics.runtimeRpc.push({ direction: "sent", method, id, params: payload.params, ...details() });
    });
    socket.on("framereceived", event => {
      const payload = parseSocketPayload(event.payload);
      if (!payload || typeof payload !== "object") return;
      const id = payload.id == null ? "" : String(payload.id);
      const method = trackedRequests.get(id);
      if (!method) return;
      trackedRequests.delete(id);
      evidence.diagnostics.runtimeRpc.push({ direction: "received", method, id, result: payload.result, error: payload.error, ...details() });
    });
    socket.on("socketerror", error => evidence.diagnostics.socketErrors.push({ text: String(error).slice(0, 500), ...details() }));
  });
}

function parseSocketPayload(payload) {
  try {
    return JSON.parse(typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"));
  } catch {
    return null;
  }
}

function assertDiagnostics(diagnostics) {
  assert.deepEqual(diagnostics.console, []);
  assert.deepEqual(diagnostics.failedResponses, []);
  assert.deepEqual(diagnostics.requestFailures, []);
  assert.deepEqual(diagnostics.socketErrors, []);
}

function byProject(page, name) { return page.getByTestId("project-item").filter({ hasText: name }).first(); }

async function openRightFiles(page) {
  if (await page.getByTestId("workspace-file-tree").isVisible().catch(() => false)) return;
  if (!(await page.getByTestId("right-workspace-launcher").isVisible().catch(() => false))) {
    await page.getByTestId("toggle-right-workspace-panel-button").click();
  }
  await page.getByTestId("right-workspace-launcher").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("right-workspace-file-option").click();
  await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30_000 });
}

async function closeRightWorkspace(page) {
  const panelVisible = await page.getByTestId("workspace-file-tree").isVisible().catch(() => false)
    || await page.getByTestId("right-workspace-launcher").isVisible().catch(() => false);
  if (panelVisible) await page.getByTestId("toggle-right-workspace-panel-button").click();
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
  await picker.getByTestId("device-folder-path-input").fill(workspace);
  await picker.getByTestId("device-folder-path-input").press("Enter");
  await page.waitForTimeout(300);
  assert.equal(
    await picker.getByTestId("device-folder-path-input").inputValue(),
    workspace,
    "late home resolution replaced the user-entered absolute workspace path",
  );
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
  const path = context.pathInCase("system-chromium", "workspace-project-selection-race", name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
