import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  const archiveRequests = [];
  // Capture only our bounded structured diagnostic; no raw console transcript.
  const installDiagnostics = [];
  page.on("console", async message => {
    if (!message.text().startsWith("[KCoder Studio plugins] install failed")) return;
    const payload = await message.args()[1]?.jsonValue();
    installDiagnostics.push(payload);
  });
  page.on("websocket", socket => socket.on("framesent", event => {
    try {
      const frame = JSON.parse(String(event.payload));
      const method = frame.method === "runtime.tasks.archive"
        ? frame.method
        : frame.method === "local_executor_request" && frame.params?.method === "runtime.tasks.archive"
          ? frame.params.method
          : null;
      if (method) archiveRequests.push({ method, id: String(frame.id ?? "") });
    } catch { /* Only method identity is retained; never raw frame bodies. */ }
  }));
  let workspaceMoved = false;
  try {
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login")), page.locator('button[type="submit"]').click()]);
    await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });

    evidence.stage = "marketplace-fixture";
    const source = context.pathInState("marketplace");
    await mkdir(source, { recursive: true });
    const manifest = resolve(source, "plugins/demo/.claude-plugin/plugin.json");
    const validManifest = JSON.stringify({ name: "demo", version: "1.0.0", description: "Recovery fixture plugin", skills: "./skills", interface: { logo: "./icon.svg" } });
    await mkdir(resolve(source, ".claude-plugin"), { recursive: true });
    await mkdir(resolve(source, "plugins/demo/.claude-plugin"), { recursive: true });
    await mkdir(resolve(source, "plugins/demo/skills/demo"), { recursive: true });
    await writeFile(resolve(source, ".claude-plugin/marketplace.json"), JSON.stringify({
      name: "recovery-market", owner: { name: "Fixture" },
      plugins: [{ name: "demo", source: "./plugins/demo", description: "Recovery fixture plugin" }, { name: "unsupported", source: { source: "unsupported-fixture" } }],
    }));
    await writeFile(resolve(source, "plugins/demo/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12" fill="black"/></svg>');
    await writeFile(manifest, validManifest);
    await writeFile(resolve(source, "plugins/demo/skills/demo/SKILL.md"), "---\nname: recovery-demo\ndescription: Owned inert catalog fixture\n---\nSynthetic skill content for marketplace availability.\n");
    await page.getByTestId("plugins-button").click();
    await page.getByTestId("plugins-workspace").waitFor({ timeout: 30000 });
    const sourceSwitcher = page.getByTestId("plugins-marketplace-source-switcher");
    const manageMarketplaces = sourceSwitcher.getByTestId("plugins-manage-marketplaces-button");
    const addMarketplace = sourceSwitcher.getByTestId("plugins-add-marketplace-button");
    const marketplaceAddName = await addMarketplace.getAttribute("aria-label");
    const marketplaceAddTitle = await addMarketplace.getAttribute("title");
    assert.ok(["添加插件市场", "Add marketplace"].includes(marketplaceAddName),
      `the add control must expose a localized accessible name, got: ${marketplaceAddName}`);
    assert.equal(marketplaceAddTitle, marketplaceAddName,
      "the add control tooltip must use the same localized copy as its accessible name");
    assert.equal(await sourceSwitcher.getByRole("button", { name: marketplaceAddName, exact: true }).count(), 1,
      "the add control must be discoverable by its accessible name");

    await manageMarketplaces.waitFor({ state: "visible", timeout: 30000 });
    assert.equal(await manageMarketplaces.isEnabled(), true, "the preceding marketplace control must be keyboard-focusable");
    assert.equal(await addMarketplace.isEnabled(), true, "the add control must remain enabled for keyboard navigation");
    await manageMarketplaces.focus();
    const managerFocused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
    assert.equal(managerFocused, "plugins-manage-marketplaces-button",
      "the preceding marketplace control must receive focus before the Tab check");
    await page.keyboard.press("Tab");
    const focusedControl = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);
    assert.equal(focusedControl, "plugins-add-marketplace-button",
      "keyboard Tab navigation from the marketplace manager button must reach the adjacent add control");
    await page.keyboard.press("Enter");
    const addMenu = page.getByTestId("plugins-add-marketplace-menu");
    await addMenu.waitFor({ state: "visible", timeout: 10000 });
    await addMenu.getByTestId("plugins-add-custom-marketplace-button").waitFor({ state: "visible" });
    await addMarketplace.click();
    await addMenu.waitFor({ state: "hidden", timeout: 10000 });
    await addMarketplace.click();
    await addMenu.waitFor({ state: "visible", timeout: 10000 });
    await addMenu.getByTestId("plugins-add-custom-marketplace-button").click();
    await page.getByTestId("plugins-marketplace-config-dialog").waitFor({ state: "visible", timeout: 10000 });
    evidence.marketplaceAddControl = {
      accessibleName: marketplaceAddName,
      title: marketplaceAddTitle,
      managerFocused: managerFocused === "plugins-manage-marketplaces-button",
      keyboardTabFocusableAfterManage: focusedControl === "plugins-add-marketplace-button",
      keyboardEnterOpensMenu: true,
      pointerClickOpensMenu: true,
      customMarketplaceOpensDialog: true,
    };
    await page.getByTestId("plugins-marketplace-browse-directory").click();
    await page.getByTestId("device-folder-path-input").fill(`${dirname(source)}/`);
    await page.getByTestId("device-folder-path-input").press("Enter");
    await page.getByTestId("device-folder-entry-button").filter({ hasText: /^marketplace$/ }).click();
    await page.getByTestId("confirm-device-folder-picker-button").click();
    assert.equal(await page.getByTestId("plugins-marketplace-path-input").inputValue(), source);
    const trust = page.getByTestId("plugins-marketplace-trust-directory");
    assert.equal(await trust.isChecked(), false);
    await trust.check();
    await page.getByTestId("plugins-marketplace-path-input").fill(source + "-changed");
    assert.equal(await trust.isChecked(), false, "changing the directory clears consent");
    await page.getByTestId("plugins-marketplace-path-input").fill(source);
    await trust.check();
    await page.getByTestId("plugins-marketplace-proxy-input").fill("invalid-proxy");
    await page.getByTestId("plugins-marketplace-save-button").click();
    await page.getByText(/插件代理地址无效/).waitFor();
    await page.getByTestId("plugins-marketplace-proxy-input").fill("");

    await page.getByTestId("plugins-marketplace-save-button").click();
    await page.getByTestId("plugins-marketplace-config-dialog").waitFor({ state: "detached", timeout: 30000 });
    const trustState = JSON.parse(await readFile(resolve(profile, "trusted-folders.json"), "utf8"));
    assert.ok(trustState.trusted.includes(source), "consent persists on the selected runtime target");
    assert.equal(trustState.trusted.includes(workspace), false, "consent must not trust the workspace ancestor");
    await page.getByTestId("plugin-marketplace-diagnostics").waitFor();
    const install = page.getByTestId("plugin-marketplace-install-demo@recovery-market");
    await install.waitFor({ timeout: 30000 });
    const installTarget = page.getByTestId("plugins-install-target");
    await installTarget.waitFor({ timeout: 30000 });
    await installTarget.locator("summary").click();
    const installTargetText = (await installTarget.innerText()).replace(/\s+/g, " ").trim();
    assert.ok(installTargetText.includes("local"), `the fixture must display its owned target: ${installTargetText}`);
    assert.ok(installTargetText.includes(workspace), `the fixture must display its owned workspace: ${installTargetText}`);
    const manageEntry = page.getByTestId("plugins-manage-button");
    await manageEntry.waitFor({ state: "visible", timeout: 30000 });
    assert.equal(await manageEntry.isEnabled(), true, "the marketplace must expose its existing management entry");
    assert.equal(await install.isEnabled(), true, "the owned catalog item must be available to install before it is installed");
    const itemRow = page.getByTestId("plugin-marketplace-row-demo@recovery-market");
    const itemRowText = (await itemRow.innerText()).replace(/\s+/g, " ").trim();
    assert.ok(itemRowText.includes("Recovery fixture plugin"), "the owned catalog item must show its fixture description");
    assert.match((await install.innerText()).trim(), /安装|Install/i, "the item must present its available install state");
    evidence.catalog = { target: "local", workspace, itemId: "demo@recovery-market",
      itemState: "available", installLabel: (await install.innerText()).trim(), descriptionVisible: true,
      managementEntryVisible: await manageEntry.isVisible() };

    evidence.stage = "trust-management";
    await manageEntry.click();
    await page.getByTestId("plugin-management-page").waitFor({ timeout: 30000 });
    await page.getByTestId("plugins-trust-manage-button").click();
    const trustRow = page.getByTestId("plugin-trust-entry").filter({ hasText: source });
    await trustRow.getByTestId("plugin-trust-revoke").click();
    assert.equal((JSON.parse(await readFile(resolve(profile, "trusted-folders.json"), "utf8"))).trusted.includes(source), true, "opening confirmation must not mutate trust");
    await page.getByTestId("plugin-trust-apply").click();
    await trustRow.getByTestId("plugin-trust-trust").waitFor();
    const revoked = JSON.parse(await readFile(resolve(profile, "trusted-folders.json"), "utf8"));
    assert.equal(revoked.trusted.includes(source), false);
    assert.ok(revoked.revoked_defaults.includes(source));
    await trustRow.getByTestId("plugin-trust-trust").click();
    await page.getByTestId("plugin-trust-apply").click();
    await trustRow.getByTestId("plugin-trust-revoke").waitFor();
    assert.ok((JSON.parse(await readFile(resolve(profile, "trusted-folders.json"), "utf8"))).trusted.includes(source));
    await page.getByTestId("plugins-trust-manage-button").click();
    await page.getByTestId("plugin-management-page").getByRole("button", { name: /返回|Back/ }).click();
    await page.getByTestId("plugins-workspace").waitFor({ timeout: 30000 });

    evidence.stage = "original-plugin-icon";
    const icon = page.getByTestId("plugin-marketplace-row-demo@recovery-market").locator("img");
    await icon.waitFor({ timeout: 30000 });
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-testid="plugin-marketplace-row-demo@recovery-market"] img');
      return image?.complete && image.naturalWidth > 0;
    });
    assert.match(await icon.getAttribute("src"), /^data:image\/svg\+xml;base64,/);

    evidence.stage = "list-install-error";
    await writeFile(manifest, "{ invalid fixture manifest");
    await install.focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("plugin-marketplace-action-error").waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId("plugin-detail-back-button").count(), 0, "nested Enter must not open the detail");
    assert.equal(await install.isEnabled(), true, "failed installation must leave retry available");
    evidence.listError = await page.getByTestId("plugin-marketplace-action-error").innerText();
    assert.match(evidence.listError, /操作失败，详情见诊断信息/);
    await page.waitForTimeout(100);
    assert.deepEqual(installDiagnostics, [{ failureCode: "unknown", phase: "plugin-install", retryable: false }]);
    evidence.diagnostic = installDiagnostics[0];
    await page.getByTestId("plugin-marketplace-dismiss-error").click();
    assert.equal(await page.getByTestId("plugin-marketplace-action-error").count(), 0);

    evidence.stage = "detail-install-error";
    await itemRow.getByRole("heading", { name: "demo", exact: true }).click();
    await page.getByTestId("plugin-detail-back-button").waitFor({ timeout: 30000 });
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
    assert.deepEqual(archiveRequests, [], "removing the failed local draft must not send runtime.tasks.archive through the owned Gateway socket");
    await rename(`${workspace}.held`, workspace);
    workspaceMoved = false;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });
    assert.equal(await page.locator('[data-testid^="runtime-task-creation-error-"]').count(), 0);
    evidence.stage = "passed";
    await context.writeArtifactJson("checks.json", { ...evidence, archiveRequests });
    return { pluginRowRetry: true, pluginDetailRetry: true, localDraftRemovedWithoutArchive: true,
      ownedCatalogTargetAndItemState: true, managementEntryVisible: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts(`failure-${evidence.stage}.png`) }).catch(() => {});
    await context.writeArtifactJson("checks.json", { ...evidence, failure: error.message });
    throw error;
  } finally {
    if (workspaceMoved) await rename(`${workspace}.held`, workspace);
    await page.close();
  }
});
