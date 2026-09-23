import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-files-editor-save-conflict-draft",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic real app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(resolve(workspace, "nested"), { recursive: true });
  const filePath = resolve(workspace, "README.md");
  await writeFile(filePath, "# Initial\nline two\n");
  await writeFile(resolve(workspace, "nested", "note.txt"), "nested\n");
  const gateway = await startGateway(context, { auth: true, label: "mobile-files-gateway", workspace, env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist } });
  const chromium = await startChromium(context, { label: "mobile-files-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`); });
  await connect(page, gateway);
  await createTask(page, "MOBILE_REAL_FILES").catch(async error => {
    await context.writeArtifactJson("task-create-failure.json", { body: await page.locator("body").innerText(), diagnostics });
    await page.screenshot({ path: context.pathInArtifacts("task-create-failure.png") });
    throw error;
  });
  await openFiles(page);
  const files = page.getByTestId("files-panel");
  await files.getByLabel("搜索文件").click();
  await page.getByTestId("file-search").fill("readme");
  await files.getByRole("button", { name: "文件 README.md", exact: true }).click();
  const editor = page.getByTestId("file-editor");
  await editor.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await editor.inputValue(), "# Initial\nline two\n");

  const firstSave = "# Saved from real mobile Files\nline two\n";
  await editor.fill(firstSave);
  await files.getByLabel("保存", { exact: true }).click();
  await files.getByText(/^已保存 · Ln /).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await readFile(filePath, "utf8"), firstSave);

  const conflictDraft = `${firstSave}LOCAL DRAFT\n`;
  await editor.fill(conflictDraft);
  await writeFile(filePath, `${firstSave}EXTERNAL VERSION\n`);
  await files.getByLabel("保存", { exact: true }).click();
  await page.getByTestId("file-conflict-banner").waitFor({ state: "visible", timeout: 30_000 });
  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId("file-conflict-reload").click();
  await page.getByTestId("file-conflict-banner").waitFor({ state: "hidden", timeout: 30_000 });
  assert.match(await editor.inputValue(), /EXTERNAL VERSION/);

  const overwriteDraft = `${await editor.inputValue()}LOCAL OVERWRITE\n`;
  await editor.fill(overwriteDraft);
  await writeFile(filePath, `${firstSave}EXTERNAL SECOND\n`);
  await files.getByLabel("保存", { exact: true }).click();
  await page.getByTestId("file-conflict-banner").waitFor({ state: "visible", timeout: 30_000 });
  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId("file-conflict-overwrite").click();
  await page.getByTestId("file-conflict-banner").waitFor({ state: "hidden", timeout: 30_000 });
  assert.equal(await readFile(filePath, "utf8"), overwriteDraft);

  const recoveredDraft = `${overwriteDraft}UNSAVED RELOAD DRAFT\n`;
  await editor.fill(recoveredDraft);
  await page.waitForTimeout(600);
  page.once("dialog", dialog => dialog.accept());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("files-panel").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("file-editor").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByTestId("file-editor").inputValue(), recoveredDraft);
  await page.getByTestId("files-panel").getByLabel("保存", { exact: true }).click();
  assert.equal(await readFile(filePath, "utf8"), recoveredDraft);
  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-files-editor.json", { workspace, firstSave: true, conflictReload: true, conflictOverwrite: true, draftReload: true, diagnostics });
  return { realAppServer: true, searchOpenEditSave: true, conflictReloadOverwrite: true, unsavedDraftReload: true };
});

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
}

async function openFiles(page) {
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId("workspace-tab-files-1").click();
  await page.getByTestId("files-panel").waitFor({ state: "visible", timeout: 30_000 });
}
