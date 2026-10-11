import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "workspace-file-read-negative-search-refresh-and-cancel-edit",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway and app-server",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const projectName = `file-read-${stamp}`;
  const evidence = { stage: "setup", projectName, steps: [], pathChecks: [], cleanup: [], diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] } };
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "workspace-file-read" });
  const gateway = await startGateway(context, { label: "workspace-file-read-gateway", workspace, auth: true });
  const messagePath = resolve(workspace, "src/message.txt");
  const originalContent = await readFile(messagePath, "utf8");
  const chromium = await startChromium(context, { label: "workspace-file-read" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  let projectId = "";
  let failure;

  try {
    await login(page, gateway);
    evidence.stage = "create-project";
    projectId = await createProject(page, workspace, projectName);
    evidence.projectId = projectId;
    evidence.steps.push({ label: "project-created" });

    evidence.stage = "open-files";
    await openRightFiles(page);
    await assertWorkspaceFilePath(page, workspace, evidence, "initial-root");
    const initialTree = await waitForWorkspaceTreeItem(page, "README.md");
    await waitForWorkspaceTreeItem(page, "src");
    evidence.treeSnapshots = [{ stage: "open-files", items: initialTree }];
    evidence.steps.push({ label: "file-tree-loaded" });
    await shot(page, context, "01-file-tree.png");

    evidence.stage = "negative-search";
    const search = page.getByTestId("workspace-file-search-input");
    await search.fill(`missing-${stamp}`);
    await page.getByTestId("workspace-file-search-empty").waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await page.getByTestId("workspace-file-search-empty").innerText(), /没有匹配的文件/);
    evidence.steps.push({ label: "missing-search-empty" });
    await shot(page, context, "02-search-empty.png");

    evidence.stage = "open-file";
    await search.fill("message.txt");
    await waitForWorkspaceTreeItem(page, "message.txt");
    await clickWorkspaceTreeItem(page, "message.txt");
    await page.getByTestId("workspace-file-preview").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("workspace-file-path").filter({ hasText: "message.txt" }).waitFor({ state: "visible", timeout: 30_000 });
    await assertWorkspaceFilePath(page, messagePath, evidence, "initial-file");
    assert.equal(await page.getByTestId("workspace-file-edit-button").isVisible(), true);
    evidence.steps.push({ label: "file-opened", pathText: await page.getByTestId("workspace-file-path").innerText() });
    await shot(page, context, "03-file-opened.png");

    evidence.stage = "cancel-edit";
    await page.getByTestId("workspace-file-edit-button").click();
    await page.getByTestId("workspace-file-editor").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByTestId("workspace-file-save-button").isDisabled(), true, "未修改文件时保存按钮应禁用");
    await page.getByTestId("workspace-file-cancel-edit-button").click();
    await page.getByTestId("workspace-file-editor").waitFor({ state: "detached", timeout: 30_000 });
    assert.equal(await readFile(messagePath, "utf8"), originalContent, "取消编辑仍修改了磁盘文件");
    evidence.steps.push({ label: "edit-cancelled-without-write" });

    evidence.stage = "refresh-page";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    const restoredProject = byProject(page, projectName);
    await restoredProject.waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("project-work-button").first().click();
    await page.getByTestId(`project-option-${projectId}`).click();
    await page.getByTestId("project-work-button").filter({ hasText: projectName }).waitFor({ state: "visible", timeout: 30_000 });
    await openRightFiles(page);
    await assertWorkspaceFilePath(page, workspace, evidence, "refresh-root");
    const restoredSearch = page.getByTestId("workspace-file-search-input");
    await restoredSearch.fill("message.txt");
    const restoredTree = await waitForWorkspaceTreeItem(page, "message.txt");
    evidence.treeSnapshots.push({ stage: "refresh-page", items: restoredTree });
    await clickWorkspaceTreeItem(page, "message.txt");
    await page.getByTestId("workspace-file-path").filter({ hasText: "message.txt" }).waitFor({ state: "visible", timeout: 30_000 });
    await assertWorkspaceFilePath(page, messagePath, evidence, "refresh-file");
    assert.equal(await readFile(messagePath, "utf8"), originalContent);
    evidence.steps.push({ label: "workspace-file-readable-after-refresh" });
    await shot(page, context, "04-file-restored.png");

    evidence.stage = "save-edit";
    const savedContent = `KCODER_E2E_SAVED_${stamp}\n`;
    await assertWorkspaceFilePath(page, messagePath, evidence, "before-write");
    await page.getByTestId("workspace-file-edit-button").click();
    const editorContent = page.getByTestId("workspace-file-editor").locator(".cm-content");
    await editorContent.waitFor({ state: "visible", timeout: 30_000 });
    await editorContent.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(savedContent);
    await page.getByTestId("workspace-file-save-button").click();
    await page.getByTestId("workspace-file-editor").waitFor({ state: "detached", timeout: 30_000 });
    await waitForFileContent(messagePath, savedContent);
    assert.equal(await readFile(messagePath, "utf8"), savedContent);
    evidence.steps.push({ label: "file-edit-saved-to-disk" });
    await shot(page, context, "05-file-saved.png");

    evidence.stage = "remove-project";
    await removeProject(page, projectName, projectId);
    projectId = "";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1_000);
    assert.equal(await byProject(page, projectName).count(), 0);
    evidence.steps.push({ label: "project-removed-after-refresh" });
    assertDiagnostics(evidence);
    evidence.stage = "passed";
    await shot(page, context, "06-clean.png");
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    try {
      const currentContent = await readFile(messagePath, "utf8");
      if (currentContent !== originalContent) await writeFile(messagePath, originalContent, "utf8");
      assert.equal(await readFile(messagePath, "utf8"), originalContent);
      evidence.cleanup.push({ kind: "fixture-content", path: messagePath, restored: true });
    } catch (error) {
      evidence.cleanup.push({ kind: "fixture-content", path: messagePath, error: String(error) });
    }
    if (projectId) {
      try { await removeProject(page, projectName, projectId); evidence.cleanup.push({ kind: "project", id: projectId, remaining: 0 }); }
      catch (error) { evidence.cleanup.push({ kind: "project", id: projectId, error: String(error) }); }
    }
    await context.writeArtifactJson("workspace-file-read-refresh.json", evidence);
  }
  if (failure) throw failure;
  return { steps: evidence.steps, diagnostics: evidence.diagnostics, cleanup: evidence.cleanup };
});

function observe(page, evidence) {
  const context = () => ({ stage: evidence.stage, at: new Date().toISOString(), url: page.url() });
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000), ...context() }));
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000), ...context() });
  });
  page.on("response", response => { if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname, ...context() }); });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname, ...context() }));
  page.on("websocket", socket => socket.on("socketerror", error => evidence.diagnostics.socketErrors.push({ text: String(error).slice(0, 500), ...context() })));
}

function assertDiagnostics(evidence) {
  assert.deepEqual(evidence.diagnostics.console.filter(entry => entry.type === "error" || entry.type === "pageerror"), [], "文件流程出现 console/page error");
  assert.deepEqual(evidence.diagnostics.failedResponses, [], "文件流程出现 4xx/5xx");
  assert.deepEqual(evidence.diagnostics.requestFailures, [], "文件流程出现 request failure");
  assert.deepEqual(evidence.diagnostics.socketErrors, [], "文件流程出现 WebSocket error");
}

function byProject(page, name) { return page.getByTestId("project-item").filter({ hasText: name }).first(); }

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

async function shot(page, context, name) { const path = context.pathInCase("system-chromium", "workspace-file-read", name); await mkdir(dirname(path), { recursive: true }); await page.screenshot({ path, fullPage: true }); }

async function openRightFiles(page) {
  if (await page.getByTestId("workspace-file-tree").isVisible().catch(() => false)) return;
  if (!(await page.getByTestId("right-workspace-launcher").isVisible().catch(() => false))) {
    await page.getByTestId("toggle-right-workspace-panel-button").click();
  }
  await page.getByTestId("right-workspace-launcher").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("right-workspace-file-option").click();
  await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForWorkspaceTreeItem(page, label) {
  const host = page.getByTestId("workspace-file-tree-pierre");
  await host.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    expectedLabel => {
      const tree = document.querySelector('[data-testid="workspace-file-tree-pierre"]');
      const buttons = tree?.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [];
      return [...buttons].some(button => {
        const itemPath = button.getAttribute("data-item-path") ?? "";
        const ariaLabel = button.getAttribute("aria-label") ?? "";
        return ariaLabel === expectedLabel || itemPath.endsWith(`/${expectedLabel}`) || button.textContent?.trim().includes(expectedLabel);
      });
    },
    label,
    { timeout: 30_000 },
  );
  return host.evaluate(tree => ({
    hasShadowRoot: tree.shadowRoot !== null,
    items: [...(tree.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [])].map(button => ({
      ariaLabel: button.getAttribute("aria-label"),
      path: button.getAttribute("data-item-path"),
      text: button.textContent?.trim() ?? "",
    })),
  }));
}

async function clickWorkspaceTreeItem(page, label) {
  const clicked = await page.getByTestId("workspace-file-tree-pierre").evaluate((tree, expectedLabel) => {
    const buttons = tree.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [];
    const button = [...buttons].find(candidate => {
      const itemPath = candidate.getAttribute("data-item-path") ?? "";
      const ariaLabel = candidate.getAttribute("aria-label") ?? "";
      return ariaLabel === expectedLabel || itemPath.endsWith(`/${expectedLabel}`) || candidate.textContent?.trim().includes(expectedLabel);
    });
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, label);
  assert.equal(clicked, true, `无法点击文件树项目 ${label}`);
}

async function waitForFileContent(path, expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await readFile(path, "utf8").catch(() => null) === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await readFile(path, "utf8"), expected, "保存后的磁盘内容不匹配");
}

async function assertWorkspaceFilePath(page, expectedPath, evidence, label) {
  const actualPath = (await page.getByTestId("workspace-file-path").innerText()).trim();
  const expected = resolve(expectedPath);
  const actual = resolve(actualPath);
  evidence.pathChecks.push({ label, expected, actual, matches: actual === expected });
  assert.equal(actual, expected, `${label} 的文件面板路径绑定错误`);
}
