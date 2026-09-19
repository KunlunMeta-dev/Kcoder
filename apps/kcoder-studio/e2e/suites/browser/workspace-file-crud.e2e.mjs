import assert from "node:assert/strict";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "workspace-file-create-edit-conflict-rename-delete-user-flow",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway and app-server",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const projectName = `file-crud-${stamp}`;
  const secondProjectName = `file-crud-switch-${stamp}`;
  const evidence = { stage: "setup", projectName, secondProjectName, steps: [], disk: [], cleanup: [], diagnostics: [] };
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "workspace-file-crud" });
  const { path: secondWorkspace } = await materializeWorkspace(context, "minimal", { instanceId: "workspace-file-crud-switch" });
  const gateway = await startGateway(context, { label: "workspace-file-crud-gateway", workspace, auth: true });
  const chromium = await startChromium(context, { label: "workspace-file-crud-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", error => evidence.diagnostics.push({ type: "pageerror", stage: evidence.stage, text: error.message }));
  let projectId = "";
  let secondProjectId = "";
  let failure;

  try {
    await login(page, gateway);
    projectId = await createProject(page, workspace, projectName);
    secondProjectId = await createProject(page, secondWorkspace, secondProjectName);
    await selectProject(page, projectId, projectName);
    evidence.stage = "open-files";
    await page.getByTestId("toggle-right-workspace-panel-button").click();
    await page.getByTestId("right-workspace-file-option").click();
    await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30_000 });
    await waitForTreeItem(page, "README.md");

    evidence.stage = "create-directory";
    await createEntry(page, "workspace-file-create-directory-button", "dev-notes");
    await waitForTreeItem(page, "dev-notes");
    assert.equal((await stat(resolve(workspace, "dev-notes"))).isDirectory(), true);
    evidence.disk.push({ label: "directory-created", path: resolve(workspace, "dev-notes") });

    evidence.stage = "create-file";
    await createEntry(page, "workspace-file-create-file-button", "scratch.txt");
    await waitForTreeItem(page, "scratch.txt");
    const scratchPath = resolve(workspace, "dev-notes", "scratch.txt");
    assert.equal(await readFile(scratchPath, "utf8"), "");
    await page.getByTestId("workspace-file-edit-button").waitFor({ state: "visible", timeout: 30_000 });
    evidence.steps.push({ label: "directory-and-file-created" });
    await shot(page, context, "01-created.png");

    evidence.stage = "edit-save";
    await editCurrentFile(page, `SAVED_${stamp}\n`);
    await page.getByTestId("workspace-file-save-button").click();
    await page.getByTestId("workspace-file-editor").waitFor({ state: "detached", timeout: 30_000 });
    assert.equal(await readFile(scratchPath, "utf8"), `SAVED_${stamp}\n`);
    evidence.steps.push({ label: "file-edited-and-saved" });

    evidence.stage = "dirty-guard";
    await page.getByTestId("workspace-file-edit-button").click();
    await replaceEditor(page, `UNSAVED_${stamp}\n`);
    assert.equal(await page.getByTestId("workspace-file-save-button").isDisabled(), false);
    await clickTreeItem(page, "README.md");
    await page.getByTestId("workspace-file-unsaved-dialog").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("workspace-file-unsaved-cancel").click();
    assert.equal(await page.getByTestId("workspace-file-editor").isVisible(), true);
    await clickTreeItem(page, "README.md");
    await page.getByTestId("workspace-file-unsaved-dialog").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("workspace-file-unsaved-discard").click();
    await page.getByTestId("workspace-file-path").filter({ hasText: "README.md" }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await readFile(scratchPath, "utf8"), `SAVED_${stamp}\n`);
    await clickTreeItem(page, "scratch.txt");
    await page.getByTestId("workspace-file-path").filter({ hasText: "scratch.txt" }).waitFor({ state: "visible", timeout: 30_000 });
    evidence.steps.push({ label: "dirty-navigation-cancel-and-discard" });

    evidence.stage = "project-switch";
    await selectProject(page, secondProjectId, secondProjectName);
    await waitForFilePath(page, secondWorkspace);
    await selectProject(page, projectId, projectName);
    await waitForFilePath(page, workspace);
    await clickTreeItem(page, "dev-notes");
    await waitForTreeItem(page, "scratch.txt");
    await clickTreeItem(page, "scratch.txt");
    evidence.steps.push({ label: "project-switch-returned-to-correct-root" });

    evidence.stage = "external-conflict";
    await page.getByTestId("workspace-file-edit-button").click();
    await replaceEditor(page, `LOCAL_${stamp}\n`);
    await writeFile(scratchPath, `EXTERNAL_${stamp}\n`, "utf8");
    await page.getByTestId("workspace-file-save-button").click();
    const saveError = page.getByTestId("workspace-file-save-error");
    await saveError.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await saveError.innerText(), /changed on disk|磁盘.*变更|冲突/i);
    assert.equal(await readFile(scratchPath, "utf8"), `EXTERNAL_${stamp}\n`);
    await page.getByTestId("workspace-file-conflict-reload-button").click();
    await page.getByTestId("workspace-file-edit-button").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("workspace-file-edit-button").click();
    const reloadedEditor = page.getByTestId("workspace-file-editor").locator(".cm-content");
    await reloadedEditor.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await reloadedEditor.innerText(), new RegExp(`EXTERNAL_${stamp}`));
    await page.getByTestId("workspace-file-cancel-edit-button").click();
    await page.getByTestId("workspace-file-editor").waitFor({ state: "detached", timeout: 30_000 });
    evidence.steps.push({ label: "external-conflict-detected-and-reloaded" });
    await shot(page, context, "02-conflict-reloaded.png");

    evidence.stage = "rename";
    await page.getByTestId("workspace-file-rename-button").click();
    const renameInput = page.getByTestId("workspace-file-entry-name-input");
    await renameInput.fill("final-note.txt");
    await page.getByTestId("workspace-file-entry-confirm-button").click();
    const finalPath = resolve(workspace, "dev-notes", "final-note.txt");
    await waitForTreeItem(page, "final-note.txt");
    await access(finalPath);
    await assertMissing(scratchPath);
    evidence.steps.push({ label: "file-renamed" });

    evidence.stage = "delete-file";
    await clickTreeItem(page, "final-note.txt");
    await page.getByTestId("workspace-file-delete-button").click();
    await page.getByTestId("workspace-file-delete-confirm-button").click();
    await waitForTreeItemAbsent(page, "final-note.txt");
    await assertMissing(finalPath);

    evidence.stage = "delete-directory-refresh";
    await clickTreeItem(page, "dev-notes");
    await page.getByTestId("workspace-file-delete-button").click();
    await page.getByTestId("workspace-file-delete-confirm-button").click();
    await waitForTreeItemAbsent(page, "dev-notes");
    await assertMissing(resolve(workspace, "dev-notes"));
    await page.getByTestId("workspace-file-refresh-button").click();
    await waitForTreeItem(page, "README.md");
    await waitForTreeItemAbsent(page, "final-note.txt");
    await waitForTreeItemAbsent(page, "dev-notes");
    evidence.steps.push({ label: "entries-deleted-and-refresh-consistent" });
    await shot(page, context, "03-deleted-clean.png");
    evidence.stage = "passed";
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    evidence.body = (await page.locator("body").innerText().catch(() => "")).slice(0, 8000);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    if (await page.getByTestId("workspace-file-entry-name-input-overlay").isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "取消" }).last().click().catch(() => page.keyboard.press("Escape"));
    }
    for (const project of [{ id: secondProjectId, name: secondProjectName }, { id: projectId, name: projectName }]) if (project.id) {
      try { await removeProject(page, project.name, project.id); evidence.cleanup.push({ kind: "project", id: project.id, remaining: 0 }); }
      catch (error) { evidence.cleanup.push({ kind: "project", id: project.id, error: String(error) }); }
    }
    await context.writeArtifactJson("workspace-file-crud.json", evidence);
  }
  if (failure) throw failure;
  return evidence;
});

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
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  const testId = await project.locator('[data-testid^="project-row-"]').first().getAttribute("data-testid");
  const id = testId?.replace("project-row-", "") || "";
  assert.match(id, /^\d+$/);
  return id;
}

function byProject(page, name) { return page.getByTestId("project-item").filter({ hasText: name }).first(); }

async function waitForTreeItem(page, label) {
  await page.getByTestId("workspace-file-tree-pierre").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(expected => {
    const tree = document.querySelector('[data-testid="workspace-file-tree-pierre"]');
    return [...(tree?.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [])].some(button => {
      const path = button.getAttribute("data-item-path") || "";
      return button.getAttribute("aria-label") === expected || path.endsWith(`/${expected}`) || button.textContent?.includes(expected);
    });
  }, label, { timeout: 30_000 });
}

async function dispatchTreeContextMenu(page, label) {
  const dispatched = await page.getByTestId("workspace-file-tree-pierre").evaluate((tree, expected) => {
    const button = [...(tree.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [])].find(candidate => {
      const path = candidate.getAttribute("data-item-path") || "";
      return candidate.getAttribute("aria-label") === expected || path.endsWith(`/${expected}`) || candidate.textContent?.includes(expected);
    });
    if (!(button instanceof HTMLElement)) return false;
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, button: 2 }));
    return true;
  }, label);
  assert.equal(dispatched, true, `无法右键文件树项目 ${label}`);
}

async function clickTreeItem(page, label) {
  const point = await page.getByTestId("workspace-file-tree-pierre").evaluate((tree, expected) => {
    const button = [...(tree.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [])].find(candidate => {
      const path = candidate.getAttribute("data-item-path") || "";
      return candidate.getAttribute("aria-label") === expected || path.endsWith(`/${expected}`) || candidate.textContent?.includes(expected);
    });
    if (!(button instanceof HTMLElement)) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, label);
  assert.ok(point, `无法点击文件树项目 ${label}`);
  await page.mouse.click(point.x, point.y);
}

async function waitForTreeItemAbsent(page, label) {
  await page.waitForFunction(expected => {
    const tree = document.querySelector('[data-testid="workspace-file-tree-pierre"]');
    return ![...(tree?.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [])].some(button => {
      const path = button.getAttribute("data-item-path") || "";
      return button.getAttribute("aria-label") === expected || path.endsWith(`/${expected}`) || button.textContent?.includes(expected);
    });
  }, label, { timeout: 30_000 });
}

async function createEntry(page, buttonTestId, name) {
  await page.getByTestId(buttonTestId).click();
  await page.getByTestId("workspace-file-entry-name-input").fill(name);
  await page.getByTestId("workspace-file-entry-confirm-button").click();
  await page.waitForTimeout(300);
  const mutationError = page.getByTestId("workspace-file-mutation-error");
  if (await mutationError.isVisible().catch(() => false)) throw new Error((await mutationError.innerText()).trim());
  const dialogError = page.getByTestId("workspace-file-entry-name-input-overlay").locator(".text-red-500, .text-red-600, .text-red-700");
  if (await dialogError.isVisible().catch(() => false)) throw new Error((await dialogError.innerText()).trim());
}

async function editCurrentFile(page, content) {
  await page.getByTestId("workspace-file-edit-button").click();
  await replaceEditor(page, content);
}

async function replaceEditor(page, content) {
  const editor = page.getByTestId("workspace-file-editor").locator(".cm-content");
  await editor.waitFor({ state: "visible", timeout: 30_000 });
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(content);
}

async function selectProject(page, id, name) {
  await page.getByTestId("project-work-button").first().click();
  await page.getByTestId(`project-option-${id}`).click();
  await page.getByTestId("project-work-button").filter({ hasText: name }).waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForFilePath(page, expected) {
  await page.waitForFunction(path => document.querySelector('[data-testid="workspace-file-path"]')?.textContent?.trim() === path, resolve(expected), { timeout: 30_000 });
}

async function assertMissing(path) {
  await assert.rejects(access(path));
}

async function removeProject(page, name, id) {
  const project = byProject(page, name);
  await project.hover();
  await page.getByTestId(`project-menu-${id}`).click();
  await page.getByTestId(`remove-project-${id}`).click();
  await page.getByTestId(`remove-project-dialog-${id}-confirm-button`).click();
  await page.locator(`[data-testid="project-row-${id}"]:visible`).waitFor({ state: "detached", timeout: 30_000 });
}

async function shot(page, context, name) {
  const path = context.pathInCase("system-chromium", "workspace-file-crud", name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
