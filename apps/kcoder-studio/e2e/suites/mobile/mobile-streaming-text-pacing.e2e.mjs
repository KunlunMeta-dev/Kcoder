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
  { width: 390, language: "zh-CN", theme: "light", interfaceVersion: "v3" },
  { width: 320, language: "zh-CN", theme: "dark", interfaceVersion: "v3" },
  { width: 390, language: "en", theme: "dark", interfaceVersion: "v3" },
  { width: 320, language: "en", theme: "light", interfaceVersion: "v3" },
  { width: 390, language: "zh-CN", theme: "light", interfaceVersion: "classic" },
  { width: 390, language: "zh-CN", theme: "light", interfaceVersion: "modern" },
];
const SMALL = "小增量立即显示。";
const BURST = "突发文字短暂平滑，中文与 emoji 😀 正常显示。".repeat(55);
const SPIKE = "积压过多立即追赶。".repeat(570);
const REDUCED = "减少动态效果时直接展示。".repeat(100);
const FINISH = "完成时直接补齐。".repeat(150);

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-streaming-text-pacing", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "Model-independent streaming display through an owned Gateway/Rust app-server, gated loopback provider and real Chromium; no paid model or physical-device claim",
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  let frozen, source;
  for (let attempt = 1; attempt <= 3; attempt++) {
    frozen = run.pathInState(`frozen-source-${attempt}`);
    try {
      source = await captureMobileExportSourceSnapshot({ snapshotRoot: frozen, layout: "preflight-source-root", freezeFiles: true,
        sourceRoots: [
          { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
          { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
        ],
      });
      break;
    } catch (error) {
      if (attempt === 3 || !/source changed/.test(error.message)) throw error;
      await run.writeArtifactJson(`source-changed-${attempt}.json`, { attempt, reason: "Source changed during verified capture; retrying with a fresh owned directory" });
    }
  }
  await run.writeArtifactJson("frozen-source.json", source);
  const dependencies = await materializeOwnedDependencies(run, { sourceRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"), destination: run.pathInState("frozen-dependencies"), label: "pacing-dependencies" });
  const web = await exportMobileWeb(run, { label: "pacing-web", deployMount: true, dependencyRoot: dependencies.root,
    mobileRoot: resolve(frozen, "apps/kcoder-studio/mobile"),
  });
  await writeGatewayMobileWebManifest(web.path, await buildGatewayMobileWebManifest(web.path, { expectedFiles: web.bundleFiles }));
  const workspace = await materializeWorkspace(run, "minimal", { instanceId: "pacing" });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 }); await run.writeStateJson("config/settings.json", {});
  let gate = 0;
  const provider = await startApprovalModelFixture(run, { responseSteps: () => [
    { delta: { role: "assistant", content: SMALL } },
    { ready: () => gate >= 1, delta: { content: BURST } },
    { ready: () => gate >= 2, delta: { content: SPIKE } },
    { ready: () => gate >= 3, delta: { content: REDUCED } },
    { ready: () => gate >= 4, delta: { content: FINISH } },
    { finishReason: "stop" },
  ] });
  const settingsFile = await run.writeStateJson("settings.json", { active_provider: "pacing", providers: {
    pacing: { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: provider.baseUrl,
      default_model: "pacing-model", context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192,
      request_timeout_secs: 60, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson("servers.json", [{ id: "local", label: "Pacing target", transport: "local", command: binary, workspace: workspace.path, settingsFile }]);
  const browser = await startChromium(run, { label: "pacing-browser", noSandbox: true });
  const errors = [], cases = [], captures = [];
  for (const scenario of process.argv.includes("--smoke") ? MATRIX.slice(0, 1) : MATRIX) {
    gate = 0;
    const label = `${scenario.interfaceVersion}-${scenario.width}-${scenario.language}-${scenario.theme}`;
    const gatewayLabel = `${label}-gateway`;
    const gateway = await startGateway(run, { label: gatewayLabel, auth: true, workspace: workspace.path, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ROOT: web.path } });
    const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
    const ui = id => page.locator(`[data-testid="${id}"]:visible`);
    const text = () => page.locator('[data-testid^="ordered-message-segment-text-"]').last().textContent();
    const stage = async name => page.evaluate(value => { window.pacingStage = value; }, name);
    const records = name => page.evaluate(value => window.pacingRecords.filter(row => row.stage === value), name);
    page.on("pageerror", error => errors.push({ label, message: error.message }));
    try {
      await page.addInitScript(preferences => localStorage.setItem("kcoder-studio:mobile-app-preferences:v1", JSON.stringify(preferences)), scenario);
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      await ui("welcome-direct-connection").click(); await ui("gateway-endpoint").fill(gateway.baseUrl);
      await ui("gateway-token").fill(gateway.authToken); await ui("gateway-connect").click();
      await ui(`home-interface-${scenario.interfaceVersion}`).waitFor({ timeout: 45_000 });
      await ui("new-workspace-local-0").click();
      await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "actual target catalog ready");
      await ui("message-input").fill("检查流式正文展示节奏。"); await ui("send-message").click();
      await waitFor(async () => await text().catch(() => "") === SMALL, 30_000, "small delta visible in full while provider remains open");
      await ui("stop-turn").waitFor();
      await page.evaluate(() => {
        window.pacingStage = "burst"; window.pacingRecords = [];
        const observe = () => {
          const node = [...document.querySelectorAll('[data-testid^="ordered-message-segment-text-"]')].at(-1);
          if (node) {
            const row = { stage: window.pacingStage, time: performance.now(), length: node.textContent.length };
            const last = window.pacingRecords.at(-1);
            if (!last || last.stage !== row.stage || last.length !== row.length) window.pacingRecords.push(row);
          }
        };
        new MutationObserver(observe).observe(document.body, { subtree: true, childList: true, characterData: true }); observe();
      });
      gate = 1;
      const burstEnd = SMALL + BURST;
      await waitFor(async () => await text() === burstEnd, 15_000, "burst display catches up");
      const burstRecords = await records("burst");
      assert.ok(burstRecords.some(row => row.length > SMALL.length && row.length < burstEnd.length), `${label}: real DOM must include an intermediate prefix`);
      assert.ok(burstRecords.every((row, index) => index === 0 || row.length >= burstRecords[index - 1].length), "display never moves backwards");
      const progress = burstRecords.filter(row => row.length > SMALL.length);
      assert.ok(progress.at(-1).time - progress[0].time < 1000, "browser rendering must catch up promptly (unit tests enforce the 160ms scheduling budget)");
      await stage("backlog"); gate = 2;
      const spikeEnd = burstEnd + SPIKE;
      await waitFor(async () => await text() === spikeEnd, 15_000, "large backlog displayed in full");
      assert.deepEqual((await records("backlog")).filter(row => row.length > burstEnd.length).map(row => row.length), [spikeEnd.length], "backlog bypasses pacing");
      await page.emulateMedia({ reducedMotion: "reduce" }); await page.waitForTimeout(50);
      await stage("reduced-motion"); gate = 3;
      const reducedEnd = spikeEnd + REDUCED;
      await waitFor(async () => await text() === reducedEnd, 15_000, "reduced motion displayed in full");
      assert.deepEqual((await records("reduced-motion")).filter(row => row.length > spikeEnd.length).map(row => row.length), [reducedEnd.length]);
      await page.emulateMedia({ reducedMotion: "no-preference" }); await page.waitForTimeout(50);
      await stage("completion"); gate = 4;
      await waitFor(async () => await text() === reducedEnd + FINISH && await ui("stop-turn").count() === 0, 30_000, "completion immediately reconciles final received text and controls");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label} overflow`);
      const path = run.pathInArtifacts(`${label}-completed.png`); await page.screenshot({ path }); captures.push(path);
      const trace = await page.evaluate(() => window.pacingRecords);
      await run.writeArtifactJson(`${label}-display-trace.json`, trace);
      cases.push({ ...scenario, smallImmediate: true, intermediatePrefixes: progress.length - 1, catchupMs: progress.at(-1).time - progress[0].time, backlogImmediate: true, reducedMotionImmediate: true, finalTextLength: (reducedEnd + FINISH).length });
      console.log(`[pacing] ${label} passed`);
    } catch (error) {
      await page.screenshot({ path: run.pathInArtifacts(`${label}-failure.png`) });
      await run.writeArtifactJson(`${label}-failure.json`, { errors, body: await page.locator("body").innerText(), trace: await page.evaluate(() => window.pacingRecords ?? []) });
      throw error;
    } finally { await page.close(); await run.stopOwned(gatewayLabel); }
  }
  await run.writeArtifactJson("page-errors.json", errors); assert.deepEqual(errors, []);
  assert.equal(provider.requests.length, cases.length, "one model-independent provider request per case, no replay");
  return { cases, captures, errors };
});
