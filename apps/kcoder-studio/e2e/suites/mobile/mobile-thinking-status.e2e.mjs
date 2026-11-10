import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { materializeOwnedDependencies } from "../../harness/owned-dependencies.mjs";
import { captureMobileExportSourceSnapshot } from "../../harness/mobile-export-source-snapshot.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";

const MATRIX = [
  { width: 390, language: "zh-CN", theme: "light" },
  { width: 320, language: "zh-CN", theme: "dark" },
  { width: 390, language: "en", theme: "dark" },
  { width: 320, language: "en", theme: "light" },
];
process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-live-thinking-status", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "Model-independent reasoning status over owned Gateway/Rust app-server, gated loopback SSE and Chromium with reduced motion; no paid model or native-device claim",
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  const frozen = run.pathInState("frozen-source");
  const source = await captureMobileExportSourceSnapshot({ snapshotRoot: frozen, layout: "preflight-source-root", freezeFiles: true,
    sourceRoots: [
      { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
    ],
  });
  await run.writeArtifactJson("frozen-source.json", source);
  const dependencies = await materializeOwnedDependencies(run, { sourceRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
    destination: run.pathInState("frozen-dependencies"), label: "thinking-dependencies" });
  const web = await exportMobileWeb(run, { label: "thinking-web", deployMount: true, dependencyRoot: dependencies.root,
    mobileRoot: resolve(frozen, "apps/kcoder-studio/mobile") });
  await writeGatewayMobileWebManifest(web.path, await buildGatewayMobileWebManifest(web.path, { expectedFiles: web.bundleFiles }));
  const workspace = await materializeWorkspace(run, "minimal", { instanceId: "thinking-status" });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 }); await run.writeStateJson("config/settings.json", {});
  let gate = 0;
  const provider = await startApprovalModelFixture(run, { responseSteps: () => [
    { delta: { role: "assistant", reasoning_content: "正在分析第一步。" } },
    { ready: () => gate >= 1, delta: { reasoning_content: "继续分析第二步。" } },
    { ready: () => gate >= 2, delta: { content: "THINKING_STATUS_REPLY" } },
    { finishReason: "stop" },
  ] });
  const settingsFile = await run.writeStateJson("settings.json", { active_provider: "thinking-status", providers: {
    "thinking-status": { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: provider.baseUrl,
      default_model: "thinking-model", context_window_tokens: 128000, max_output_tokens: 128, output_headroom_tokens: 4096,
      request_timeout_secs: 45, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson("servers.json", [{ id: "local", label: "Thinking target", transport: "local", command: binary, workspace: workspace.path, settingsFile }]);
  const browser = await startChromium(run, { label: "thinking-browser", noSandbox: true });
  const errors = [], cases = [], captures = [];
  for (const scenario of process.argv.includes("--smoke") ? MATRIX.slice(0, 1) : MATRIX) {
    gate = 0;
    const label = `${scenario.width}-${scenario.language}-${scenario.theme}`, gatewayLabel = `${label}-gateway`;
    const gateway = await startGateway(run, { label: gatewayLabel, auth: true, workspace: workspace.path, serversFile, kcoderBin: binary,
      env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ROOT: web.path } });
    const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
    const ui = id => page.locator(`[data-testid="${id}"]:visible`);
    const summarySelector = '[data-testid^="ordered-message-processing-"][data-testid$="-toggle"]:visible';
    const summaries = () => page.locator(summarySelector);
    const running = scenario.language === "en" ? "Running" : "进行中";
    const completed = scenario.language === "en" ? "Completed" : "已完成";
    const stopped = scenario.language === "en" ? "Stopped" : "已停止";
    let stage = "connect";
    page.on("pageerror", error => errors.push({ label, stage, message: error.message }));
    const capture = async name => {
      await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}/${name} overflow`);
      const path = run.pathInArtifacts(`${label}-${name}.png`); await page.screenshot({ path }); captures.push(path);
      console.log(`[thinking-status] ${label} ${name}`);
    };
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(preferences => localStorage.setItem("kcoder-studio:mobile-app-preferences:v1",
        JSON.stringify({ ...preferences, interfaceVersion: "v3", thinkingCollapsedByDefault: true, toolsCollapsedByDefault: true })), scenario);
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      await ui("welcome-direct-connection").click(); await ui("gateway-endpoint").fill(gateway.baseUrl);
      await ui("gateway-token").fill(gateway.authToken); await ui("gateway-connect").click();
      await ui("home-interface-v3").waitFor({ timeout: 45_000 }); await ui("new-workspace-local-0").click();
      await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "actual target is ready");
      stage = "first-reasoning-delta";
      await ui("message-input").fill("检查思考过程的真实状态。"); await ui("send-message").click();
      await summaries().last().waitFor({ timeout: 30_000 }); await ui("stop-turn").waitFor();
      const first = summaries().last();
      await waitFor(async () => (await first.getAttribute("aria-label")).includes(running), 10_000, "first reasoning delta is in progress");
      assert.equal((await first.getAttribute("aria-label")).includes(completed), false);
      assert.equal(await first.getAttribute("aria-expanded"), "false");
      await capture("thinking-running");
      await first.click(); await page.getByText("正在分析第一步。", { exact: false }).filter({ visible: true }).waitFor();
      gate = 1;
      await page.getByText("继续分析第二步。", { exact: false }).filter({ visible: true }).waitFor({ timeout: 15_000 });
      assert.ok((await first.getAttribute("aria-label")).includes(running));
      await first.click(); assert.equal(await first.getAttribute("aria-expanded"), "false");
      stage = "turn-complete"; gate = 2;
      await ui("message-assistant").getByText("THINKING_STATUS_REPLY", { exact: false }).waitFor({ timeout: 30_000 });
      await waitFor(async () => await ui("stop-turn").count() === 0, 30_000, "authoritative turn completion");
      // Authoritative history can replace live block IDs; identify the completed reply by its visible content.
      const past = ui("message-assistant").filter({ hasText: "THINKING_STATUS_REPLY" }).locator(summarySelector);
      assert.ok((await past.getAttribute("aria-label")).includes(completed));
      assert.equal((await past.getAttribute("aria-label")).includes(running), false);
      await capture("thinking-completed");
      stage = "next-turn"; gate = 0;
      await ui("message-input").fill("第二轮思考中停止。"); await ui("send-message").click();
      await waitFor(async () => await summaries().count() === 2, 30_000, "second reasoning row arrived");
      const second = ui("message-assistant").filter({ hasNotText: "THINKING_STATUS_REPLY" }).locator(summarySelector);
      assert.ok((await past.getAttribute("aria-label")).includes(completed), "past reasoning stays completed during another turn");
      await waitFor(async () => (await second.getAttribute("aria-label")).includes(running), 10_000, "second turn is in progress");
      stage = "stop-thinking";
      await ui("stop-turn").click();
      await waitFor(async () => await ui("stop-turn").count() === 0, 30_000, "interrupt acknowledged");
      assert.ok((await second.getAttribute("aria-label")).includes(stopped));
      assert.equal((await second.getAttribute("aria-label")).includes(completed), false);
      await capture("thinking-stopped");
      cases.push({ ...scenario, reducedMotion: true, streamingReasoning: true, completedReceipt: true, pastTurnUnchanged: true, interruptedReceipt: true });
    } catch (error) {
      gate = 2; await capture("failure"); await run.writeArtifactJson("failure-stage.json", { label, stage, errors, body: await page.locator("body").innerText() }); throw error;
    } finally { gate = 2; await page.close(); await run.stopOwned(gatewayLabel); }
  }
  await run.writeArtifactJson("page-errors.json", errors); assert.deepEqual(errors, []);
  return { cases, captures, errors };
});
