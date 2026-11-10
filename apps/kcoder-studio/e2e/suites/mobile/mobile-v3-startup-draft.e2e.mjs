import { captureMobileExportSourceSnapshot } from "../../harness/mobile-export-source-snapshot.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { materializeOwnedDependencies } from "../../harness/owned-dependencies.mjs";
import { readCacheStorageSnapshot } from "./mobile-session-cache-storage-corruption-fixture.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";

const MATRIX = [
  { width: 390, language: "zh-CN", theme: "light" },
  { width: 320, language: "zh-CN", theme: "dark" },
  { width: 390, language: "en", theme: "dark" },
  { width: 320, language: "en", theme: "light" },
];
process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-v3-startup-draft-recovery", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "Model-independent V3 cold-entry, offline draft and first-send contracts through owned Gateway/app-server and a bounded loopback provider; no paid models or native-device claim",
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  const frozen = run.pathInState("frozen-source");
  const source = await captureMobileExportSourceSnapshot({ snapshotRoot: frozen, layout: "preflight-source-root", freezeFiles: true, sourceRoots: [
    { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
  ] });
  await run.writeArtifactJson("frozen-source.json", source);
  const dependencies = await materializeOwnedDependencies(run, {
    sourceRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
    destination: run.pathInState("frozen-mobile-dependencies"), label: "v3-startup-dependencies",
  });
  await run.writeArtifactJson("owned-dependencies.json", dependencies);
  const web = await exportMobileWeb(run, { label: "v3-startup-web", deployMount: true, dependencyRoot: dependencies.root, mobileRoot: resolve(frozen, "apps/kcoder-studio/mobile") });
  await writeGatewayMobileWebManifest(web.path, await buildGatewayMobileWebManifest(web.path, { expectedFiles: web.bundleFiles }));
  const alpha = await materializeWorkspace(run, "minimal", { instanceId: "alpha" });
  const beta = await materializeWorkspace(run, "minimal", { instanceId: "beta" });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 });
  await run.writeStateJson("config/settings.json", {});
  const provider = await startApprovalModelFixture(run, { textOnly: true, textOnlyResponse: () => "V3_STARTUP_DRAFT_REPLY" });
  const settingsFile = await run.writeStateJson("settings.json", { active_provider: "v3-startup", providers: {
    "v3-startup": { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: provider.baseUrl,
      default_model: "startup-model", context_window_tokens: 128000, max_output_tokens: 64, output_headroom_tokens: 4096,
      request_timeout_secs: 30, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson("servers.json", [
    { id: "alpha", label: "Alpha server", transport: "local", command: binary, workspace: alpha.path, settingsFile },
    { id: "beta", label: "Beta server", transport: "local", command: binary, workspace: beta.path, settingsFile },
    { id: "offline", label: "Offline server", transport: "ssh", host: "kcoder-unreachable.invalid", user: "fixture", command: "kcoder", workspace: "/workspace/offline-project" },
  ]);
  const browser = await startChromium(run, { label: "v3-startup-browser", noSandbox: true });
  const errors = [], captures = [], cases = [];
  const scenarios = process.argv.includes("--smoke") ? MATRIX.slice(0, 1) : MATRIX;
  for (const scenario of scenarios) {
    const label = `${scenario.width}-${scenario.language}-${scenario.theme}`;
    const gatewayLabel = `${label}-gateway`;
    const gateway = await startGateway(run, { label: gatewayLabel, auth: true, workspace: alpha.path, serversFile,
      env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ROOT: web.path }, kcoderBin: binary });
    const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
    const ui = id => page.locator(`[data-testid="${id}"]:visible`);
    const methods = [], firstStartModels = [];
    let stage = "pair", releaseInventory;
    page.on("pageerror", error => errors.push({ label, stage, message: error.message }));
    page.on("websocket", socket => socket.on("framesent", event => {
      try { const frame = JSON.parse(String(event.payload)); if (frame.method) methods.push(frame.method); if (frame.method === "thread/start") firstStartModels.push(frame.params?.model); } catch {}
    }));
    const starts = () => methods.filter(method => method === "thread/start").length;
    const capture = async name => {
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}/${name} overflow`);
      const path = run.pathInArtifacts(`${label}-${name}.png`); await page.screenshot({ path }); captures.push(path);
      console.log(`[v3-startup] ${label} ${name}`);
    };
    const selectServer = async id => { await ui("draft-context-server").click(); await ui(`draft-context-server-option-${id}`).click(); };
    const rememberedBeta = () => page.evaluate(() => Object.keys(localStorage).some(key => {
      if (!key.startsWith("kcoder-studio:mobile-new-workspace:") || !key.endsWith(":last-project")) return false;
      return JSON.parse(localStorage.getItem(key)).serverId === "beta";
    }));
    try {
      await page.addInitScript(preferences => {
        const key = "kcoder-studio:mobile-app-preferences:v1";
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ ...preferences, interfaceVersion: "v3" }));
      }, scenario);
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      await ui("welcome-direct-connection").click(); await ui("gateway-endpoint").fill(gateway.baseUrl);
      await ui("gateway-token").fill(gateway.authToken); await ui("gateway-connect").click();
      await ui("home-interface-v3").waitFor({ timeout: 45_000 });
      stage = "empty-cold-entry";
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      await ui("new-task-draft").waitFor({ timeout: 45_000 });
      await waitFor(async () => await ui("message-input").isEditable(), 30_000, "empty V3 draft accepts text");
      assert.equal(starts(), 0, "cold entry must not create a backend conversation");
      await capture("empty-draft");
      await selectServer("beta");
      await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "Beta model catalog and actual connection ready");
      assert.ok((await ui("draft-context-server").innerText()).includes("Beta server"));
      assert.equal(await ui("draft-context-project-name").innerText(), "beta");
      const followDefault = scenario.language === "en" ? "Follow target default (startup-model)" : "跟随目标默认（startup-model）";
      await waitFor(async () => (await ui("draft-model-selector").innerText()) === followDefault, 45_000, "draft shows its resolved default while following target settings");
      assert.ok((await ui("draft-model-selector").getAttribute("aria-label")).includes(followDefault), "the full model name stays accessible when the visible label truncates");
      await capture("default-model");
      await waitFor(rememberedBeta, 15_000, "connected Beta saved as last valid project");
      stage = "remembered-cold-entry";
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      await ui("new-task-draft").waitFor({ timeout: 45_000 });
      await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "remembered Beta reconnects");
      assert.ok((await ui("draft-context-server").innerText()).includes("Beta server"));
      assert.equal(await ui("draft-context-project-name").innerText(), "beta");
      assert.equal(starts(), 0, "restoring only a project remains a draft");
      await capture("remembered-project");
      stage = "offline-draft";
      await selectServer("offline");
      await ui("message-input").fill("先写下问题，再切换到可连接的项目。");
      await waitFor(async () => (await ui("draft-context-status").getAttribute("aria-label")) === (scenario.language === "en" ? "Offline" : "离线"), 45_000, "actual unreachable target becomes offline");
      assert.equal(await ui("draft-model-selector").isDisabled(), true);
      assert.equal(await ui("composer-attachment").isDisabled(), true);
      assert.equal(await ui("send-message").isDisabled(), true);
      await ui("task-more").click(); assert.equal(await ui("v3-menu-permissions").isDisabled(), true);
      await ui("v3-draft-more-close").click();
      assert.equal(await rememberedBeta(), true, "offline selection must not replace the last valid project");
      await capture("offline-writing");
      await ui("v3-conversation-menu").click();
      await ui("home-interface-v3").waitFor();
      for (const id of ["home-search", "interaction-inbox", "home-settings"]) await ui(id).waitFor();
      assert.equal(await ui("v3-conversation-menu-sheet").count(), 0);
      await capture("navigation"); await page.goBack(); await ui("draft-context-server").waitFor();
      await selectServer("beta");
      await waitFor(async () => await ui("send-message").isEnabled(), 45_000, "text can be sent only after returning to a connected project");
      assert.equal(await ui("message-input").inputValue(), "先写下问题，再切换到可连接的项目。");
      assert.equal(starts(), 0);
      stage = "first-send";
      await ui("send-message").click();
      await ui("message-assistant").getByText("V3_STARTUP_DRAFT_REPLY", { exact: false }).waitFor({ timeout: 45_000 });
      await waitFor(async () => await ui("stop-turn").count() === 0, 45_000, "one first turn completed");
      assert.equal(starts(), 1, "first send creates exactly one backend conversation");
      assert.equal(firstStartModels[0], undefined, "displaying the default model name never turns it into an explicit selection");
      await waitFor(async () => (await ui("conversation-model-selector").innerText()).includes("startup-model"), 30_000, "the established conversation shows its actual model name");
      const taskPath = new URL(page.url()).pathname;
      await waitFor(async () => {
        try { return (await readCacheStorageSnapshot(page)).rows.some(row => row.raw.includes("V3_STARTUP_DRAFT_REPLY")); }
        catch { return false; }
      }, 20_000, "confirmed transcript persisted before closing the page");
      stage = "cached-cold-entry";
      const inventory = new Promise(done => { releaseInventory = done; });
      await page.route("**/api/servers*", async route => { await inventory; await route.continue(); });
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      await ui("session-cache-view").waitFor({ timeout: 45_000 });
      assert.equal(new URL(page.url()).pathname, taskPath, "cold entry restores the exact previous conversation");
      assert.equal(await ui("message-input").isEditable(), false, "cached conversations remain read only");
      await capture("restored-cache");
      await ui("v3-conversation-menu").click(); await ui("home-interface-v3").waitFor();
      releaseInventory();
      const resumedThreadId = decodeURIComponent(taskPath.split("/").at(-1));
      await ui(`thread-${resumedThreadId}`).waitFor({ timeout: 45_000 });
      await ui(`thread-${resumedThreadId}`).click();
      await waitFor(async () => await ui("message-input").isEditable(), 45_000, "selecting the restored conversation reconnects");
      assert.equal(starts(), 1, "restoration never replays thread creation");
      await ui("v3-conversation-menu").click();
      await ui("home-interface-v3").waitFor(); await ui("home-settings").waitFor();
      await ui("home-search").waitFor(); await ui("sessions").waitFor(); await ui("interaction-inbox").waitFor();
      cases.push({ ...scenario, emptyDraft: true, rememberedProject: true, offlineWriting: true, firstSendCreatesOnce: true, cachedResume: true, navigation: true });
    } catch (error) {
      releaseInventory?.();
      await capture("failure"); await run.writeArtifactJson("failure-stage.json", { label, stage, errors, body: await page.locator("body").innerText() }); throw error;
    } finally { releaseInventory?.(); await page.unrouteAll({ behavior: "wait" }); await page.close(); await run.stopOwned(gatewayLabel); }
  }
  await run.writeArtifactJson("page-errors.json", errors); assert.deepEqual(errors, []);
  return { cases, captures, errors };
});
