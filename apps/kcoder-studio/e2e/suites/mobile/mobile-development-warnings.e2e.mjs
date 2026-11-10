import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, requireExecutable, runE2E } from "../../harness/run-context.mjs";
import { startMobileDevelopmentServer } from "../../harness/mobile-development-server.mjs";
import { captureMobileExportSourceSnapshot } from "../../harness/mobile-export-source-snapshot.mjs";
import { materializeOwnedDependencies } from "../../harness/owned-dependencies.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { openOwnedMobileRpc } from "../../harness/owned-mobile-rpc.mjs";

const WARNING = /Require cycle:|shadow\*.*deprecated|props\.pointerEvents is deprecated/;
const MATRIX = [
  { width: 390, language: "zh-CN", theme: "light", interfaceVersion: "v3" },
  { width: 320, language: "zh-CN", theme: "dark", interfaceVersion: "v3" },
  { width: 390, language: "en", theme: "dark", interfaceVersion: "v3" },
  { width: 320, language: "en", theme: "light", interfaceVersion: "v3" },
  { width: 390, language: "zh-CN", theme: "light", interfaceVersion: "modern" },
  { width: 390, language: "zh-CN", theme: "light", interfaceVersion: "classic" },
];

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-development-warnings", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "Development-mode Mobile Web console regression with owned Gateway/app-server and a bounded deterministic loopback text provider; no paid model or native-device claim",
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  // Pin a stable copy before the long export; other sessions may edit the checkout.
  const snapshotRoot = run.pathInState("warning-source");
  const snapshot = await captureMobileExportSourceSnapshot({
    snapshotRoot, layout: "preflight-source-root",
    sourceRoots: [
      { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
    ],
  });
  await run.writeArtifactJson("source-snapshot.json", snapshot);
  const mobileRoot = resolve(snapshotRoot, "apps/kcoder-studio/mobile");
  await materializeOwnedDependencies(run, {
    sourceRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
    destination: resolve(mobileRoot, "node_modules"), label: "development-warning-dependencies",
  });
  const metro = await startMobileDevelopmentServer(run, { mobileRoot });
  const workspace = await materializeWorkspace(run, "minimal", { instanceId: "development-warnings" });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 });
  await run.writeStateJson("config/settings.json", {});
  const provider = await startApprovalModelFixture(run, { textOnly: true, textOnlyResponse: () => "Development warning regression reply." });
  const settingsFile = await run.writeStateJson("settings.json", { active_provider: "warnings", providers: {
    warnings: { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: provider.baseUrl,
      default_model: "warnings-model", context_window_tokens: 128000, max_output_tokens: 128, output_headroom_tokens: 4096,
      request_timeout_secs: 30, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson("servers.json", [{ id: "local", label: "Owned warning test", runtime: "kcoder", transport: "local", command: binary, workspace: workspace.path, settingsFile }]);
  const gateway = await startGateway(run, { auth: true, workspace: workspace.path, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ORIGINS: metro.baseUrl } });
  const observer = await openOwnedMobileRpc(run, gateway, "local", workspace.path);
  const created = await observer.rpc.request("thread/start", { cwd: workspace.path, clientRequestId: randomUUID() });
  const threadId = created.thread.id;
  const completed = observer.rpc.waitFor(frame => frame.method === "turn/completed" && frame.params?.threadId === threadId, 45_000);
  await observer.rpc.request("turn/start", { threadId, clientMessageId: randomUUID(), input: [{ type: "text", text: "Warning regression history" }] });
  await completed; await observer.close();
  const browser = await startChromium(run, { label: "development-warning-browser", noSandbox: true });
  const diagnostics = [], pageErrors = [], cases = [], captures = [];
  for (const scenario of MATRIX) {
    const label = `${scenario.interfaceVersion}-${scenario.width}-${scenario.language}-${scenario.theme}`;
    const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
    page.setDefaultNavigationTimeout(120_000);
    let stage = "pair";
    page.on("console", message => {
      if (["warning", "error"].includes(message.type())) diagnostics.push({ label, stage, type: message.type(), message: message.text() });
    });
    page.on("pageerror", error => pageErrors.push({ label, stage, message: error.message }));
    const ui = id => page.locator(`[data-testid="${id}"]:visible`);
    const capture = async name => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}/${name} must not overflow`);
      const path = run.pathInArtifacts(`${label}-${name}.png`); await page.screenshot({ path }); captures.push(path);
    };
    try {
      await page.addInitScript(preferences => {
        const key = "kcoder-studio:mobile-app-preferences:v1";
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(preferences));
      }, scenario);
      await page.goto(metro.baseUrl, { waitUntil: "domcontentloaded" });
      await ui("welcome-direct-connection").waitFor();
      assert.equal(await page.evaluate(() => globalThis.__DEV__), true, "Metro development diagnostics must be enabled");
      await ui("welcome-direct-connection").click(); await ui("gateway-endpoint").fill(gateway.baseUrl);
      await ui("gateway-token").fill(gateway.authToken); await ui("gateway-connect").click();
      await ui(`home-interface-${scenario.interfaceVersion}`).waitFor({ timeout: 45_000 });
      const home = page.url(); stage = "home";
      await ui(`thread-${threadId}`).waitFor({ timeout: 45_000 }); await capture("home");
      await ui(`thread-${threadId}`).click(); stage = "task";
      await ui("message-input").waitFor({ timeout: 45_000 }); await capture("task");
      await page.goto(home, { waitUntil: "domcontentloaded" }); stage = "draft";
      await ui("new-workspace").click(); await ui("message-input").waitFor({ timeout: 45_000 });
      await ui("message-input").fill("Keep this unsent draft."); await capture("draft");
      await page.reload({ waitUntil: "domcontentloaded" }); stage = "reload";
      await ui("message-input").waitFor({ timeout: 45_000 });
      await page.waitForTimeout(300);
      cases.push({ ...scenario, task: true, draft: true, reload: true });
      console.log(`[mobile-development] ${label} complete`);
    } catch (error) {
      await page.screenshot({ path: run.pathInArtifacts(`${label}-failure.png`) });
      await run.writeArtifactJson("failure-page.json", { label, stage, text: await page.locator("body").innerText() });
      throw error;
    } finally {
      await run.writeArtifactJson(`${label}-console-diagnostics.json`, diagnostics.filter(entry => entry.label === label));
      await run.writeArtifactJson(`${label}-page-errors.json`, pageErrors.filter(entry => entry.label === label));
      await page.close();
    }
  }
  await run.writeArtifactJson("console-diagnostics.json", diagnostics);
  await run.writeArtifactJson("page-errors.json", pageErrors);
  assert.deepEqual(pageErrors, [], "development pages must not throw");
  assert.deepEqual(diagnostics.filter(entry => WARNING.test(entry.message)), [], "development pages must not emit cycles or deprecated app styles");
  return { development: true, cases, captures, diagnostics };
});
