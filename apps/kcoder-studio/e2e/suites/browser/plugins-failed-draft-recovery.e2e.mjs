import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

// QA: real marketplace errors during installation must retain list/detail retry controls. A real
// missing workspace must produce a removable local draft without remote archive.
// Recovery repairs only fixture files; RunContext owns and cleans every resource.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: "plugins-install-error-and-failed-local-draft-recovery",
  tier: "full-integration",
  modelPolicy: "model-independent error recovery; no model request is expected",
  retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "recovery" });
  const profile = context.pathInState("profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await context.writeStateJson("profile/settings.json", {});
  await context.writeStateJson("profile/credentials.json", {});
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "recovery-fixture",
    providers: { "recovery-fixture": {
      api_format: "openai_chat_completions", endpoint: "http://127.0.0.1:1/v1",
      default_model: "recovery-fixture", context_window_tokens: 128000,
      output_headroom_tokens: 8192, max_output_tokens: 8192, no_proxy: true,
    } },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Failure Recovery", runtime: "kcoder", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const evidence = { stage: "login" };
  let workspaceMoved = false;
  try {
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login")), page.locator('button[type="submit"]').click()]);
    await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });

    evidence.stage = "marketplace-fixture";
    const source = context.pathInState("marketplace");
    const manifest = resolve(source, "plugins/demo/.claude-plugin/plugin.json");
    const validManifest = JSON.stringify({ name: "demo", version: "1.0.0", description: "Recovery fixture plugin" });
    await mkdir(resolve(source, ".claude-plugin"), { recursive: true });
    await mkdir(resolve(source, "plugins/demo/.claude-plugin"), { recursive: true });
    await writeFile(resolve(source, ".claude-plugin/marketplace.json"), JSON.stringify({
      name: "recovery-market", owner: { name: "Fixture" },
      plugins: [{ name: "demo", source: "./plugins/demo", description: "Recovery fixture plugin" }],
    }));
    await writeFile(manifest, validManifest);
    await page.getByTestId("plugins-button").click();
    await page.getByTestId("plugins-workspace").waitFor({ timeout: 30000 });
    await page.getByTestId("plugins-add-marketplace-button").click();
    await page.getByTestId("plugins-add-custom-marketplace-button").click();
    await page.getByTestId("plugins-marketplace-path-input").fill(source);
    await page.getByTestId("plugins-marketplace-save-button").click();
    await page.getByTestId("plugins-marketplace-config-dialog").waitFor({ state: "detached", timeout: 30000 });
    const install = page.getByTestId("plugin-marketplace-install-demo@recovery-market");
    await install.waitFor({ timeout: 30000 });

    evidence.stage = "list-install-error";
    await writeFile(manifest, "{ invalid fixture manifest");
    await install.focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("plugin-marketplace-action-error").waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId("plugin-detail-back-button").count(), 0, "nested Enter must not open the detail");
    assert.equal(await install.isEnabled(), true, "failed installation must leave retry available");
    evidence.listError = await page.getByTestId("plugin-marketplace-action-error").innerText();
    await page.getByTestId("plugin-marketplace-dismiss-error").click();
    assert.equal(await page.getByTestId("plugin-marketplace-action-error").count(), 0);

    evidence.stage = "detail-install-error";
    await page.getByTestId("plugin-marketplace-row-demo@recovery-market").click();
    const detailInstall = page.locator('[data-testid^="plugin-detail-toggle-"]');
    await detailInstall.click();
    await page.getByTestId("plugin-detail-action-error").waitFor({ timeout: 30000 });
    evidence.detailError = await page.getByTestId("plugin-detail-action-error").innerText();
    await page.screenshot({ path: context.pathInArtifacts("plugin-install-error.png") });
    await writeFile(manifest, validManifest);
    await page.getByTestId("plugin-detail-dismiss-error").click();
    await detailInstall.click();
    await page.getByRole("button", { name: "在对话中试用", exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId("plugin-detail-action-error").count(), 0);
    await page.getByTestId("plugin-detail-back-button").click();
    await page.getByTestId("plugins-installed-strip-item-demo@recovery-market").waitFor({ timeout: 30000 });

    evidence.stage = "failed-draft";
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });
    const project = page.locator('[data-testid="project-item"]:visible').filter({ hasText: "Failure Recovery" }).first();
    await project.hover();
    await project.getByTestId("project-new-conversation-button").click();
    await page.getByTestId("chat-message-input").click();
    await page.keyboard.insertText("Fixture draft must fail before thread creation.");
    await page.evaluate(() => {
      window.__recoveryArchiveCalls = [];
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = function(command, args) {
        if (command === "local_executor_request" && args?.method === "runtime.tasks.archive") {
          window.__recoveryArchiveCalls.push(args.method);
        }
        return invoke.call(this, command, args);
      };
    });
    await rename(workspace, `${workspace}.held`);
    workspaceMoved = true;
    await page.getByTestId("send-message-button").click();
    const draftError = page.locator('[data-testid^="runtime-task-creation-error-"]').first();
    await draftError.waitFor({ timeout: 60000 });
    evidence.draftError = await draftError.innerText();
    const taskId = (await draftError.getAttribute("data-testid")).slice("runtime-task-creation-error-".length);
    assert.equal(taskId.includes(":"), false, "fixture must fail before a backend task is allocated");
    const remove = page.getByTestId(`runtime-local-task-archive-${taskId}`);
    assert.equal(await remove.getAttribute("aria-label"), "移除失败任务");
    assert.equal(await remove.isEnabled(), true);
    await page.screenshot({ path: context.pathInArtifacts("failed-draft-visible.png") });
    await page.getByTestId(`runtime-local-task-time-${taskId}`).hover();
    await remove.click();
    await draftError.waitFor({ state: "detached", timeout: 10000 });
    assert.equal(await page.locator('[data-testid^="runtime-local-task-archive-toast-"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__recoveryArchiveCalls), []);
    await rename(`${workspace}.held`, workspace);
    workspaceMoved = false;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });
    assert.equal(await page.locator('[data-testid^="runtime-task-creation-error-"]').count(), 0);
    evidence.stage = "passed";
    await context.writeArtifactJson("checks.json", evidence);
    return { pluginRowRetry: true, pluginDetailRetry: true, localDraftRemovedWithoutArchive: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts(`failure-${evidence.stage}.png`) }).catch(() => {});
    await context.writeArtifactJson("checks.json", { ...evidence, failure: error.message });
    throw error;
  } finally {
    if (workspaceMoved) await rename(`${workspace}.held`, workspace);
    await page.close();
  }
});
