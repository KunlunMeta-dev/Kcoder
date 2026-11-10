import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { verifyConversationV3 } from "./helpers/conversation-v3.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { materializeOwnedDependencies } from "../../harness/owned-dependencies.mjs";
import { captureMobileExportSourceSnapshot } from "../../harness/mobile-export-source-snapshot.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";

const PREFS = "kcoder-studio:mobile-app-preferences:v1";
const MATRIX = [
  { width: 390, language: "zh-CN", theme: "light" },
  { width: 320, language: "zh-CN", theme: "dark" },
  { width: 390, language: "en", theme: "dark" },
  { width: 320, language: "en", theme: "light" },
];

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-interface-version", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "model-independent UI and ownership acceptance with real Gateway/app-server, synthetic histories and a gated loopback provider; no paid model or native-device claim",
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  const snapshotRoot = run.pathInState("source");
  const snapshot = await captureMobileExportSourceSnapshot({ snapshotRoot, layout: "preflight-source-root", sourceRoots: [
    { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
  ] });
  await run.writeArtifactJson("source.json", snapshot);
  const dependencies = await materializeOwnedDependencies(run, {
    sourceRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
    destination: run.pathInState("interface-dependencies"), label: "interface-dependencies",
  });
  const web = await exportMobileWeb(run, { label: "interface-web", deployMount: true,
    mobileRoot: resolve(snapshotRoot, "apps/kcoder-studio/mobile"), dependencyRoot: dependencies.root });
  await writeGatewayMobileWebManifest(web.path, await buildGatewayMobileWebManifest(web.path, { expectedFiles: web.bundleFiles }));
  const workspace = await materializeWorkspace(run, "minimal", { instanceId: "interface-project" });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 });
  await run.writeStateJson("config/settings.json", {});
  let holdTurn = false;
  const provider = await startApprovalModelFixture(run, { responseSteps: () => [
    { delta: { role: "assistant", content: "## 界面切换验证\n\n保留同一个会话、草稿和附件。" } },
    { ready: () => !holdTurn, delta: { content: "\n\n回合已完成。" } },
    { delta: {}, finishReason: "stop" },
  ] });
  const settingsFile = await run.writeStateJson("settings.json", { active_provider: "interface-fixture", permission_mode: "ask", providers: {
    "interface-fixture": { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: provider.baseUrl,
      default_model: "interface-model", context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 4096, request_timeout_secs: 180, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson("servers.json", [
    { id: "api", label: "CYX fixture", runtime: "kcoder", transport: "local", command: binary, workspace: workspace.path, settingsFile },
    { id: "offline", label: "Offline fixture", runtime: "kcoder", transport: "ssh", host: "kcoder-unreachable.invalid", port: 22, user: "fixture", command: "kcoder", workspace: "/workspace/offline" },
  ]);
  const browser = await startChromium(run, { label: "interface-browser", noSandbox: true });
  const screenshots = [], results = [], pageErrors = [];
  for (const scenario of process.argv.includes("--smoke") ? MATRIX.slice(0, 1) : MATRIX) {
    const label = `${scenario.width}-${scenario.language}-${scenario.theme}`;
    const gatewayLabel = `${label}-gateway`;
    const gateway = await startGateway(run, { label: gatewayLabel, auth: true, workspace: workspace.path, serversFile,
      env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ROOT: web.path }, kcoderBin: binary });
    const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
    let stage = "pairing";
    page.on("pageerror", error => {
      const failure = { label, stage, error: error.message, stack: error.stack };
      pageErrors.push(failure);
      console.error("[interface-version] pageerror", JSON.stringify(failure));
    });
    const ui = id => page.locator(`[data-testid="${id}"]:visible`);
    const back = async () => {
      if (await ui("v3-conversation-menu").count()) { await ui("v3-conversation-menu").click(); }
      else await page.locator(`[aria-label="${scenario.language === "en" ? "Back" : "返回"}"]:visible`).click();
    };
    const capture = async name => {
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForTimeout(180);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}/${name} horizontal overflow`);
      const path = run.pathInArtifacts(`${label}-${name}.png`);
      await page.screenshot({ path }); screenshots.push({ ...scenario, name, path });
      console.log(`[interface-version] ${label} ${name}`);
    };
    const openSettings = async source => {
      if (source === "task") {
        if (await ui("v3-conversation-menu").count()) { await ui("v3-conversation-menu").click(); await ui("home-settings").click(); }
        else { await ui("task-header-title").click(); await ui("drawer-settings").click(); }
      } else if (await ui("home-settings").count()) {
        await ui("home-settings").click();
      } else {
        await page.locator('[data-testid^="home-interface-"]:visible').locator(`[aria-label="${scenario.language === "en" ? "Task navigation" : "任务导航"}"]:visible:not([aria-modal="true"])`).first().click();
        await ui("drawer-settings").click();
      }
      await ui("settings-appearance").click();
      await ui("settings-interface-row").click();
    };
    const selectVersion = async (version, source) => {
      const fromSelection = source === "task" && await ui("v3-conversation-menu").count() > 0;
      const draftBeforeNavigation = fromSelection ? await ui("message-input").inputValue() : null;
      await openSettings(source);
      await ui(`settings-interface-choice-${version}`).click();
      await waitFor(async () => await page.evaluate(key => JSON.parse(localStorage.getItem(key) || "{}").interfaceVersion, PREFS) === version, 10_000, "interface choice is saved locally");
      await ui("settings-detail-back").click();
      await ui("settings-detail-back").click();
      if (fromSelection) {
        await page.goBack();
        await waitFor(async () => await ui("message-input").count() === 1 &&
          await ui("message-input").isEditable() && await ui("message-input").inputValue() === draftBeforeNavigation,
        15_000, "the selected conversation restores its writable composer and exact draft after returning through Home");
      }
    };
    try {
      await page.addInitScript(({ key, preferences }) => localStorage.getItem(key) || localStorage.setItem(key, JSON.stringify(preferences)), { key: PREFS, preferences: scenario });
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      await ui("welcome-direct-connection").click();
      await ui("gateway-endpoint").fill(gateway.baseUrl); await ui("gateway-token").fill(gateway.authToken); await ui("gateway-connect").click();
      await ui("home-interface-modern").waitFor({ timeout: 45_000 });
      const homeUrl = page.url();
      await waitFor(async () => await ui("new-workspace-api-0").isEnabled(), 45_000, "workspace actions are ready");
      const searchBox = await ui("home-search").boundingBox(), settingsBox = await ui("home-settings").boundingBox(), historyBox = await ui("sessions").boundingBox();
      assert.ok(searchBox && settingsBox && historyBox && searchBox.x + searchBox.width <= settingsBox.x && settingsBox.x + settingsBox.width <= historyBox.x,
        "Settings is placed immediately after Search and before History");
      await capture("modern-home");
      stage = "classic-settings";
      await openSettings("home"); await capture("version-setting");
      await ui("settings-interface-choice-classic").click();
      await ui("settings-detail-back").click(); await ui("settings-detail-back").click();
      await ui("home-interface-classic").waitFor();
      assert.equal(await ui("workspace-actions-api-0").count(), 1);
      const titleHeight = await ui("home-interface-classic").getByText(scenario.language === "en" ? "Conversations" : "对话", { exact: true })
        .evaluate(node => node.getBoundingClientRect().height);
      assert.ok(titleHeight <= 26, "classic home title remains a single line at narrow widths");
      await capture("classic-home");
      await page.reload({ waitUntil: "networkidle" });
      await ui("home-interface-classic").waitFor({ timeout: 30_000 });
      assert.equal(page.url(), homeUrl, "reload preserves both authorization and device-local classic choice");
      await ui("new-workspace-api-0").click();
      await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "classic draft uses the real target catalog");
      await capture("classic-draft");
      await ui("message-input").fill("从经典界面创建实际会话。");
      await ui("send-message").click();
      await ui("task-header").waitFor({ timeout: 45_000 });
      await waitFor(async () => await ui("stop-turn").count() === 0, 45_000, "first real app-server turn completes");
      await page.getByText("回合已完成。", { exact: true }).filter({ visible: true }).waitFor();
      const taskUrl = page.url();
      stage = "running-turn";
      holdTurn = true;
      const requestsBefore = provider.requests.length;
      await ui("message-input").fill("生成期间切换界面，不能取消或重发。"); await ui("send-message").click();
      await ui("stop-turn").waitFor();
      await waitFor(() => provider.requests.length === requestsBefore + 1, 15_000, "one model request accepted");
      await ui("message-input").fill("切换后仍保留的下一条草稿");
      await ui("composer-attachment").click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByText(scenario.language === "en" ? "Choose file" : "选择文件", { exact: true }).filter({ visible: true }).click();
      await (await chooser).setFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("retain this attachment across interface changes") });
      await ui("composer-file-attachment-keep.txt").waitFor({ timeout: 20_000 });
      await capture("classic-running-composer");
      const inputBefore = await ui("message-input").elementHandle();
      await selectVersion("modern", "task");
      assert.equal(page.url(), taskUrl);
      await ui("queue-message").waitFor();
      assert.equal(await ui("message-input").inputValue(), "切换后仍保留的下一条草稿");
      await ui("composer-file-attachment-keep.txt").waitFor();
      assert.equal(await ui("message-input").evaluate((node, original) => node === original, inputBefore), true, "switch retains the same DOM input instance");
      assert.equal(provider.requests.length, requestsBefore + 1, "switch must not replay the running turn");
      await capture("modern-running-composer");
      await selectVersion("classic", "task");
      await ui("task-header-connection").waitFor();
      await ui("queue-message").waitFor();
      assert.equal(await ui("message-input").inputValue(), "切换后仍保留的下一条草稿");
      await ui("composer-file-attachment-keep.txt").waitFor();
      assert.equal(provider.requests.length, requestsBefore + 1);
      holdTurn = false;
      await waitFor(async () => await ui("stop-turn").count() === 0, 45_000, "the original running turn completes after both switches");
      stage = "history-and-offline";
      await back(); await ui("sessions").click();
      await ui("sessions-list").waitFor({ timeout: 45_000 });
      await ui("sessions-host-all").waitFor(); await capture("classic-history");
      await back(); await selectVersion("modern", "home");
      await ui("sessions").click(); await ui("sessions-list").waitFor({ timeout: 45_000 }); await capture("modern-history");
      await back();
      await ui("new-workspace-api-0").click();
      await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "modern draft is ready");
      await capture("modern-draft");
      await ui("message-input").fill("从新版界面创建第二个实际会话。"); await ui("send-message").click();
      await ui("task-header").waitFor({ timeout: 45_000 });
      await page.getByText("回合已完成。", { exact: true }).filter({ visible: true }).waitFor({ timeout: 45_000 });
      assert.notEqual(page.url(), taskUrl, "modern creation must enter a distinct session through the same controller");
      await back(); await ui("new-workspace-api-0").click();
      await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "modern offline draft starts from a ready project");
      await ui("draft-context-server").click(); await ui("draft-context-server-option-offline").click();
      await ui("draft-offline-composer").waitFor({ timeout: 45_000 }); await capture("modern-offline");
      assert.equal(await ui("composer-quick-phrases").count(), 0);
      await back(); await selectVersion("classic", "home");
      await waitFor(async () => await page.locator('[data-testid^="home-interface-"]:visible [role="progressbar"]:visible').count() === 0, 45_000, "Home finishes refreshing before selecting the lower project");
      await waitFor(async () => await ui("new-workspace-offline-0").isEnabled(), 45_000, "offline workspace navigation ownership is restored");
      await ui("new-workspace-offline-0").scrollIntoViewIfNeeded();
      await ui("new-workspace-offline-0").click();
      await waitFor(async () => !(await ui("message-input").isEditable()), 45_000, "classic offline composer is read-only");
      assert.equal(await ui("composer-quick-phrases").count(), 0);
      assert.equal(await ui("send-message").isDisabled(), true);
      await capture("classic-offline");
      stage = "v3-conversation";
      await verifyConversationV3({ page, ui, capture, back, selectVersion, provider, setHold: value => { holdTurn = value; }, scenario });
      results.push({ ...scenario, v3PermissionsMoved: true, v3CreationAndSwitch: true, persisted: true, runningTurnPreserved: true, draftAndAttachmentPreserved: true, inputInstancePreserved: true });
    } catch (error) {
      await page.screenshot({ path: run.pathInArtifacts(`${label}-failure.png`) });
      await run.writeArtifactJson("failure-stage.json", { label, stage, path: new URL(page.url()).pathname, pageErrors, text: await page.locator("body").innerText() });
      throw error;
    } finally {
      holdTurn = false;
      await page.close();
      await run.stopOwned(gatewayLabel);
    }
  }
  await run.writeArtifactJson("page-errors.json", pageErrors);
  assert.deepEqual(pageErrors, []);
  return { results, screenshots, pageErrors };
});
