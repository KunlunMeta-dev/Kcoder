import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startFixtureSite } from "../../harness/fixture-site.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: "studio-web-links-streaming-marketplace-permissions-goals-reasoning",
  tier: "full-integration",
  modelPolicy: "model-independent UI, native RPC, Git import, and streaming lifecycle regression",
  retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "repairs" });
  const profile = context.pathInState("profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await context.writeStateJson("profile/settings.json", {});
  context.registerSecret("model-independent-key");
  await context.writeStateJson("profile/credentials.json", { "repair-model": { type: "api", key: "model-independent-key" } });
  const site = await startFixtureSite(context);
  const chunks = [
    `# Stable heading\n\n[Open fixture page](${site.url})\n\n`,
    ...Array.from({ length: 20 }, (_, index) => `\n## Section ${index}\n\n${"Readable output. ".repeat(80)}\n`),
    "\nWEB_REPAIR_STREAM_DONE\n",
  ];
  const model = await startApprovalModelFixture(context, {
    textOnly: true, textOnlyChunks: chunks, textOnlyChunkDelayMs: 80,
    textOnlyReasoning: "REASONING_FROM_UPSTREAM_ONLY",
  });
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "repair-model", permission_mode: "ask",
    providers: { "repair-model": {
      api_format: "openai_chat_completions", endpoint: model.baseUrl,
      default_model: "repair-model", context_window_tokens: 128000,
      output_headroom_tokens: 8192, max_output_tokens: 8192, no_proxy: true,
    } },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Web Repairs", runtime: "kcoder", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    window.__repairPermissions = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (typeof data === 'string') {
        try {
          const request = JSON.parse(data);
          if (request.method === 'turn/start') window.__repairPermissions.push(request.params?.permissionMode ?? null);
        } catch { /* Non-JSON frames are outside this diagnostic. */ }
      }
      return send.call(this, data);
    };
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login")), page.locator('button[type="submit"]').click()]);
  await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });
  const project = page.getByTestId("project-item").filter({ hasText: "Web Repairs" }).first();
  await project.waitFor({ timeout: 60000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
  await page.getByTestId("composer-permission-selector").click();
  await page.getByTestId("permission-mode-ask").click();
  await page.getByTestId("composer-permission-selector").click();
  assert.equal(await page.getByTestId("permission-mode-ask").getAttribute("aria-checked"), "true");
  await page.screenshot({ path: context.pathInArtifacts("permission-menu.png") });
  await page.keyboard.press("Escape");
  const composer = page.getByTestId("chat-message-input");
  await composer.click();
  await page.keyboard.insertText("Verify the Web transport.");
  await page.getByTestId("send-message-button").click();
  const heading = page.getByRole("heading", { name: "Stable heading", exact: true });
  await heading.waitFor({ timeout: 30000 });
  await heading.evaluate(node => { window.__repairHeading = node; });
  await page.getByText("WEB_REPAIR_STREAM_DONE", { exact: true }).waitFor({ timeout: 60000 });
  assert.deepEqual(await page.evaluate(() => window.__repairPermissions), ['ask']);
  assert.equal(await page.evaluate(() => window.__repairHeading?.isConnected), true, "streaming must not remount existing Markdown");
  const processing = page.getByTestId("final-processing-toggle").last();
  assert.equal(await processing.getAttribute("aria-expanded"), "false");
  await processing.click();
  const thinking = page.getByTestId("assistant-thinking-toggle").last();
  assert.equal(await thinking.getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByTestId("assistant-thinking-content").count(), 0);
  await thinking.click();
  assert.match(await page.getByTestId("assistant-thinking-content").innerText(), /REASONING_FROM_UPSTREAM_ONLY/);
  assert.equal(await page.getByTestId("thinking-indicator").count(), 0, "body output must not be labelled thinking");
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open fixture page" }).click();
  const popup = await popupEvent;
  await popup.waitForLoadState("domcontentloaded");
  assert.ok(popup.url().startsWith(site.url));
  await popup.close();
  await page.getByTestId("add-context-button").click();
  await page.getByTestId("set-goal-pro-button").click();
  assert.match(await page.getByTestId("goal-draft-pill").innerText(), /goal-pro/);
  await page.getByTestId("goal-draft-pill").hover();
  await page.getByTestId("cancel-goal-draft-button").click();
  await page.getByTestId("add-context-button").click();
  await page.getByTestId("set-goal-button").click();
  assert.match(await page.getByTestId("goal-draft-pill").innerText(), /\/goal/);
  await page.getByTestId("goal-draft-pill").hover();
  await page.getByTestId("cancel-goal-draft-button").click();

  const source = context.pathInState("git-marketplace");
  await mkdir(resolve(source, ".claude-plugin"), { recursive: true });
  await mkdir(resolve(source, "plugins/demo/.claude-plugin"), { recursive: true });
  await writeFile(resolve(source, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "web-repair-market", owner: { name: "Fixture" }, plugins: [{ name: "demo", source: "./plugins/demo", description: "Local Git marketplace fixture" }] }));
  await writeFile(resolve(source, "plugins/demo/.claude-plugin/plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0", description: "Fixture plugin" }));
  await mkdir(resolve(source, "plugins/demo/skills/demo"), { recursive: true });
  await writeFile(resolve(source, "plugins/demo/skills/demo/SKILL.md"), "---\nname: demo-skill\ndescription: Installed native skill\n---\nUse the fixture skill.");
  for (const [index, args] of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "fixture"]].entries()) {
    const child = context.spawnOwned(`git-fixture-${index}`, "/usr/bin/git", args, { cwd: source, env: context.isolatedEnvironment({}) });
    const result = await waitFor(() => child.exitCode === null ? null : { code: child.exitCode }, 5000, `git fixture ${index}`, 25, context.abortSignal);
    assert.equal(result.code, 0);
  }
  await page.getByTestId("plugins-button").click();
  await page.getByTestId("plugins-workspace").waitFor({ timeout: 30000 });
  assert.match(await page.getByTestId("plugins-install-target").innerText(), /local/);
  assert.equal(await page.getByTestId("plugins-create-button").count(), 0);
  await page.getByTestId("plugins-add-marketplace-button").click();
  await page.getByTestId("plugins-add-custom-marketplace-button").click();
  await page.getByTestId("plugins-marketplace-path-input").fill(`file://${source}`);
  await page.getByTestId("plugins-marketplace-save-button").click();
  await page.getByTestId("plugins-marketplace-config-dialog").waitFor({ state: "detached", timeout: 30000 });
  await page.getByTestId("plugin-marketplace-install-demo@web-repair-market").click();
  await page.getByTestId("plugins-installed-strip-item-demo@web-repair-market").waitFor({ timeout: 30000 });
  await page.screenshot({ path: context.pathInArtifacts("marketplace-installed.png") });
  await page.getByTestId("plugins-manage-button").click();
  await page.getByTestId("kcoder-plugin-management").waitFor({ state: "visible" });
  await page.getByTestId("kcoder-plugin-tab-skills").click();
  await page.getByText("demo-skill", { exact: true }).waitFor({ state: "visible" });
  await page.getByTestId("kcoder-plugin-tab-plugins").click();
  await page.getByTestId("kcoder-plugin-toggle-demo@web-repair-market").click();
  await waitFor(async () => (await page.getByTestId("kcoder-plugin-toggle-demo@web-repair-market").innerText()).includes("启用"), 10000, "disabled native plugin");
  await page.getByTestId("kcoder-plugin-tab-skills").click();
  assert.equal(await page.getByText("demo-skill", { exact: true }).count(), 0);
  await page.getByTestId("kcoder-plugin-tab-plugins").click();
  await page.getByTestId("kcoder-plugin-toggle-demo@web-repair-market").click();
  await waitFor(async () => (await page.getByTestId("kcoder-plugin-toggle-demo@web-repair-market").innerText()).includes("停用"), 10000, "enabled native plugin");
  await page.getByTestId("kcoder-plugin-uninstall-demo@web-repair-market").click();
  await page.getByTestId("kcoder-plugin-confirm-uninstall-demo@web-repair-market").click();
  await page.getByTestId("kcoder-plugin-row-demo@web-repair-market").waitFor({ state: "detached" });

  assert.deepEqual(errors, []);
  await context.writeArtifactJson("checks.json", { links: true, stableStreamingDom: true, realReasoningExpandable: true, goalModes: true, permissionMenu: true, gitMarketplaceInstalled: true });
  await page.close();
  return { passed: true };
});
