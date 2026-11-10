import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const execFile = promisify(execFileCallback);
const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-real-files-editor-save-conflict-draft",
    tier: "full-integration",
    modelPolicy: "model-independent deterministic real app-server",
    retainSuccessLogs: true,
  },
  async (context) => {
    const workspace = context.pathInState("workspace");
    await mkdir(resolve(workspace, "nested"), { recursive: true });
    const filePath = resolve(workspace, "README.md");
    await writeFile(filePath, "# Initial\nline two\n");
    await writeFile(resolve(workspace, "nested", "note.txt"), "nested\n");
    await execFile("git", ["init", "-b", "main"], { cwd: workspace });
    await execFile("git", ["config", "user.email", "mobile-e2e@kcoder.local"], { cwd: workspace });
    await execFile("git", ["config", "user.name", "Mobile E2E"], { cwd: workspace });
    await execFile("git", ["add", "."], { cwd: workspace });
    await execFile("git", ["commit", "-m", "baseline"], { cwd: workspace });
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-files-gateway",
      workspace,
      kcoderBin:
        process.env.KCODER_E2E_KCODER_BIN ||
        resolve(repoRoot, "target/debug/kcoder"),
      env: {
        KCODER_STUDIO_SCENARIO: "full-turn",
        KCODER_STUDIO_WEB_ROOT: mobileDist,
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-files-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = [];
    let transientRpcSocketCloseWarnings = 0;
    page.on("pageerror", (error) =>
      diagnostics.push(`pageerror: ${error.message}`),
    );
    page.on("console", (message) => {
      if (!["error", "warning"].includes(message.type())) return;
      const text = message.text();
      // A page reload may cancel an in-flight RPC handshake; keep that warning visible in the run evidence.
      if (
        message.type() === "warning" &&
        text.includes("WebSocket connection to '") &&
        text.includes("/rpc?") &&
        text.includes("WebSocket is closed before the connection is established")
      ) {
        transientRpcSocketCloseWarnings += 1;
        return;
      }
      diagnostics.push(`${message.type()}: ${text}`);
    });
    await connect(page, gateway);
    await createTask(page, "MOBILE_REAL_FILES").catch(async (error) => {
      await context.writeArtifactJson("task-create-failure.json", {
        body: await page.locator("body").innerText(),
        diagnostics,
      });
      await page.screenshot({
        path: context.pathInArtifacts("task-create-failure.png"),
      });
      throw error;
    });
    assert.equal(
      await page.getByTestId("composer-attachment").getAttribute("aria-label"),
      "Add attachment",
    );
    assert.equal(
      await page.getByTestId("send-message").getAttribute("aria-label"),
      "Send",
    );
    await openFiles(page);
    const files = page.getByTestId("files-panel");
    await files.getByLabel("Search files").click();
    await page.getByTestId("file-search").fill("readme");
    await files.getByRole("button", { name: /README\.md/ }).click();
    const editor = page.getByTestId("file-editor");
    await editor.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await editor.inputValue(), "# Initial\nline two\n");

    const firstSave = "# Saved from real mobile Files\nline two\n";
    await editor.fill(firstSave);
    await files.getByLabel("Save", { exact: true }).click();
    await files
      .getByText(/^Saved · Ln /)
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await readFile(filePath, "utf8"), firstSave);

    await files.getByLabel("Back to file tree").click();
    await files.getByTestId("workspace-recent-files-toggle").click();
    const recentFiles = files.getByTestId("workspace-recent-files");
    const recentReadme = recentFiles.getByRole("button", { name: /README\.md/ });
    await recentReadme.waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({
      path: context.pathInArtifacts("mobile-real-files-recent-path.png"),
    });
    await recentReadme.click();
    assert.equal(await editor.inputValue(), firstSave);

    const conflictDraft = `${firstSave}LOCAL DRAFT\n`;
    await editor.fill(conflictDraft);
    await writeFile(filePath, `${firstSave}EXTERNAL VERSION\n`);
    await files.getByLabel("Save", { exact: true }).click();
    await page
      .getByTestId("file-conflict-banner")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.match(
      await page.getByTestId("file-conflict-banner").innerText(),
      /The file on disk has changed/,
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("file-conflict-reload").click();
    await page
      .getByTestId("file-conflict-banner")
      .waitFor({ state: "hidden", timeout: 30_000 });
    assert.match(await editor.inputValue(), /EXTERNAL VERSION/);

    const overwriteDraft = `${await editor.inputValue()}LOCAL OVERWRITE\n`;
    await editor.fill(overwriteDraft);
    await writeFile(filePath, `${firstSave}EXTERNAL SECOND\n`);
    await files.getByLabel("Save", { exact: true }).click();
    await page
      .getByTestId("file-conflict-banner")
      .waitFor({ state: "visible", timeout: 30_000 });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("file-conflict-overwrite").click();
    await page
      .getByTestId("file-conflict-banner")
      .waitFor({ state: "hidden", timeout: 30_000 });
    assert.equal(await readFile(filePath, "utf8"), overwriteDraft);

    const recoveredDraft = `${overwriteDraft}UNSAVED RELOAD DRAFT\n`;
    await editor.fill(recoveredDraft);
    await page.waitForTimeout(600);
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByTestId("files-panel")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByTestId("file-editor")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page.getByTestId("file-editor").inputValue(),
      recoveredDraft,
    );
    await page
      .getByTestId("files-panel")
      .getByLabel("Save", { exact: true })
      .click();
    assert.equal(await readFile(filePath, "utf8"), recoveredDraft);
    await page.getByTestId("task-more").click();
    await page.getByTestId("task-menu-workspace").click();
    await page.getByTestId("workspace-tab-changes").click();
    await page.getByTestId("changes-mode-working").waitFor();
    assert.equal(
      await page.getByTestId("changes-mode-working").innerText(),
      "Working tree",
    );
    assert.equal(
      await page.getByTestId("changes-mode-staged").innerText(),
      "Staged",
    );
    const changes = page.getByTestId("changes-panel");
    await changes.getByText("README.md", { exact: true }).click();
    await changes.getByText(/\+.*UNSAVED RELOAD DRAFT/).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await changes.getByText("-# Initial", { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.screenshot({
      path: context.pathInArtifacts("mobile-real-files-diff-review.png"),
    });
    await changes.getByTestId("changes-open-file").click();
    await page.getByTestId("file-editor").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    assert.equal(await page.getByTestId("file-editor").inputValue(), recoveredDraft);
    await context.writeArtifactJson("mobile-real-files-editor.json", {
      workspace,
      firstSave: true,
      conflictReload: true,
      conflictOverwrite: true,
      draftReload: true,
      recentFileOpen: true,
      workingDiffReviewAndOpenFile: true,
      transientRpcSocketCloseWarnings,
      diagnostics,
    });
    assert.deepEqual(diagnostics, []);
    return {
      realAppServer: true,
      searchOpenEditSave: true,
      conflictReloadOverwrite: true,
      unsavedDraftReload: true,
      workingDiffReviewAndOpenFile: true,
      transientRpcSocketCloseWarnings,
    };
  },
);

async function connect(page, gateway) {
  await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome-direct-connection").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page
    .getByTestId("new-workspace")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page
    .getByTestId("workspace-path")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page
    .getByTestId("message-user")
    .filter({ hasText: prompt })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("send-message")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function openFiles(page) {
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  await page.getByTestId("workspace-tab-files-1").click();
  await page
    .getByTestId("files-panel")
    .waitFor({ state: "visible", timeout: 30_000 });
}
