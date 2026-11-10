import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { materializeOwnedDependencies } from "../../harness/owned-dependencies.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";

const PREFS = "kcoder-studio:mobile-app-preferences:v1";
const MATRIX = [
  { width: 390, language: "zh-CN", theme: "light" },
  { width: 320, language: "zh-CN", theme: "dark" },
  { width: 390, language: "en", theme: "dark" },
  { width: 320, language: "en", theme: "light" },
];
const REPLY = "这个示例项目共用现有的会话控制器、权限与附件功能。界面切换只调整呈现，不会复制会话或重新发送消息。\n\n可以继续查看 [项目文档](https://example.invalid/docs)，也可以展开下方的思考与工具，核对实际读取结果。";

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-v3-conversation-reference", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "model-independent reference layout, ordered thinking/read tool and send controls with owned Gateway/app-server and bounded loopback provider; no paid model or native-device claim",
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  const dependencies = await materializeOwnedDependencies(run, { sourceRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"), destination: run.pathInState("frozen-dependencies"), label: "conversation-dependencies" });
  const web = await exportMobileWeb(run, { label: "conversation-web", deployMount: true, dependencyRoot: dependencies.root });
  await writeGatewayMobileWebManifest(web.path, await buildGatewayMobileWebManifest(web.path, { expectedFiles: web.bundleFiles }));
  const workspace = await materializeWorkspace(run, "minimal", { instanceId: "conversation" });
  const file = resolve(workspace.path, "layout-note.txt");
  await writeFile(file, "V3_OWNED_FILE_RESULT\nThis file belongs only to this UI test.\n");
  const provider = await startApprovalModelFixture(run, { responseSteps: ({ body }) => {
    const messages = body.messages ?? [];
    if (messages.at(-1)?.role === "tool") return [{ delta: { role: "assistant", content: "读取完成：V3_OWNED_FILE_RESULT。\n\n现在可以继续检查消息、工具步骤和底部输入区的间距。" } }, { finishReason: "stop" }];
    if (JSON.stringify(messages.at(-1)).includes("READ_LAYOUT")) return [
      { delta: { role: "assistant", reasoning_content: "我现在读取隔离项目的说明文件，检查工具执行过程和结果。" } },
      { delta: { tool_calls: [{ index: 0, id: "layout-read", type: "function", function: { name: "read", arguments: JSON.stringify({ file_path: file, offset: 1, limit: 10 }) } }] } },
      { finishReason: "tool_calls" },
    ];
    return [{ delta: { role: "assistant", content: REPLY } }, { finishReason: "stop" }];
  } });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 }); await run.writeStateJson("config/settings.json", {});
  const settingsFile = await run.writeStateJson("settings.json", { active_provider: "v3-layout", permission_mode: "ask", providers: {
    "v3-layout": { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: provider.baseUrl, default_model: "layout-model", context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 4096, request_timeout_secs: 30, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson("servers.json", [{ id: "local", label: "V3 layout target", transport: "local", command: binary, workspace: workspace.path, settingsFile }]);
  const browser = await startChromium(run, { label: "v3-conversation-browser", noSandbox: true });
  const errors = [], diagnostics = [], captures = [], cases = [];
  for (const scenario of process.argv.includes("--smoke") ? MATRIX.slice(0, 1) : MATRIX) {
    const label = `${scenario.width}-${scenario.language}-${scenario.theme}`;
    const gatewayLabel = `${label}-gateway`;
    const gateway = await startGateway(run, { label: gatewayLabel, auth: true, workspace: workspace.path, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ROOT: web.path } });
    const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
    let stage = "pair";
    page.on("pageerror", error => errors.push({ label, stage, message: error.message, stack: error.stack }));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      const text = run.redactText(message.text()), location = message.location();
      const expected = stage === "gateway-auto-recovery" && text === "Failed to load resource: net::ERR_FAILED" && /\/api\/servers(?:\/status)?$/.test(location.url ?? "");
      diagnostics.push({ label, stage, type: message.type(), text, expected });
    });
    const ui = id => page.locator(`[data-testid="${id}"]:visible`);
    const capture = async name => {
      await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}/${name} horizontal overflow`);
      const path = run.pathInArtifacts(`${label}-${name}.png`); await page.screenshot({ path }); captures.push(path);
      console.log(`[v3-conversation] ${label} ${name}`);
    };
    try {
      await page.addInitScript(({ key, preferences }) => localStorage.getItem(key) || localStorage.setItem(key, JSON.stringify(preferences)), { key: PREFS, preferences: { ...scenario, interfaceVersion: "modern", thinkingCollapsedByDefault: true, toolsCollapsedByDefault: true } });
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      await ui("welcome-direct-connection").click(); await ui("gateway-endpoint").fill(gateway.baseUrl); await ui("gateway-token").fill(gateway.authToken); await ui("gateway-connect").click();
      await ui("home-interface-modern").waitFor({ timeout: 45_000 });
      await ui("new-workspace-local-0").click();
      await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "owned workspace catalog ready");
      await ui("message-input").fill("呃呃呃呃呃呃呃呃"); await ui("send-message").click();
      await ui("message-assistant").getByText("可以继续查看", { exact: false }).waitFor({ timeout: 45_000 });
      await waitFor(async () => await ui("stop-turn").count() === 0, 45_000, "first turn complete");
      await capture("v2-reply");
      stage = "version";
      await ui("task-header-title").click(); await ui("drawer-settings").click(); await ui("settings-appearance").click(); await ui("settings-interface-row").click(); await ui("settings-interface-choice-v3").click(); await ui("settings-detail-back").click(); await ui("settings-detail-back").click();
      await ui("conversation-v3-background").waitFor();
      assert.equal(await ui("task-header-status").innerText(), "V3 layout target");
      assert.equal(await ui("v3-conversation-context").count(), 0, "existing conversations omit the duplicate target/project row");
      const originalTitle = await ui("task-header-title").innerText();
      assert.equal(await ui("assistant-response-like").isDisabled(), true);
      assert.equal(await ui("assistant-response-dislike").isDisabled(), true);
      await ui("assistant-response-copy").waitFor(); await ui("assistant-response-share").waitFor();
      await capture("v3-reply");
      stage = "tool";
      await ui("message-input").fill("READ_LAYOUT：检查工具状态"); await ui("send-message").click();
      await ui("approval-accept").waitFor({ timeout: 45_000 }); await ui("approval-accept").click();
      await ui("message-assistant").getByText("读取完成：V3_OWNED_FILE_RESULT。", { exact: false }).waitFor({ timeout: 45_000 });
      await waitFor(async () => await ui("stop-turn").count() === 0, 45_000, "read tool turn complete");
      const group = page.locator('[data-testid^="ordered-message-processing-"]:not([data-testid$="-toggle"]):not([data-testid$="-details"]):visible').last();
      const processingToggle = group.locator('[data-testid$="-toggle"]').first();
      if (await processingToggle.getAttribute("aria-expanded") !== "true") await processingToggle.click();
      await waitFor(async () => await processingToggle.getAttribute("aria-expanded") === "true", 5_000, "the processing group is expanded");
      const tool = page.locator('[data-testid^="tool-call-toggle-"]:visible').last();
      if (await tool.getAttribute("aria-expanded") !== "true") await tool.click();
      await page.locator('[data-testid^="tool-status-"]:visible').last().waitFor();
      await ui("bounded-output").last().getByText("V3_OWNED_FILE_RESULT", { exact: false }).waitFor();
      await group.locator('[data-testid$="-toggle"]').first().scrollIntoViewIfNeeded();
      await capture("v3-thinking-tools");
      await ui("assistant-response-more").last().click(); await ui("message-fork").waitFor(); await ui("assistant-response-menu-close").click();
      await ui("task-more").click(); await ui("v3-menu-permissions").waitFor();
      assert.equal(await ui("v3-menu-permissions").isDisabled(), false);
      await ui("task-menu-search").click(); await ui("transcript-search-input").fill("V3_OWNED_FILE_RESULT");
      await ui("transcript-search-count").waitFor(); await ui("transcript-search-close").click();
      stage = "short-viewport";
      const input = await ui("message-input").elementHandle(); await ui("message-input").fill("保留的草稿");
      await page.setViewportSize({ width: scenario.width, height: 420 }); await ui("message-input").focus(); await page.waitForTimeout(150);
      const header = await ui("task-header").boundingBox(), composer = await ui("message-input-root").boundingBox();
      assert.ok(header && composer && composer.y >= header.y + header.height && composer.y + composer.height <= 420);
      assert.equal(await ui("v3-conversation-context").count(), 0);
      assert.equal(await ui("message-input").evaluate((node, original) => node === original, input), true);
      assert.equal(await ui("message-input").inputValue(), "保留的草稿");
      await capture("v3-short-viewport");
      stage = "jump-to-latest";
      await ui("message-list").hover(); await page.mouse.wheel(0, -1200);
      await ui("jump-to-latest").waitFor();
      const listBox = await ui("message-list").boundingBox(), jumpBox = await ui("jump-to-latest").boundingBox();
      assert.ok(listBox && jumpBox && Math.abs(jumpBox.x + jumpBox.width / 2 - listBox.x - listBox.width / 2) <= 1, "latest arrow is centered above the composer");
      assert.ok(jumpBox.y >= header.y + header.height && jumpBox.y + jumpBox.height <= composer.y, "latest arrow stays above the composer");
      assert.equal(jumpBox.width, 36); assert.equal(jumpBox.height, 36);
      assert.equal(await ui("jump-to-latest").innerText(), "");
      assert.equal(await ui("submission-recovery-anchor").getByTestId("jump-to-latest").count(), 1);
      await capture("v3-jump-centered");
      await ui("jump-to-latest").click();
      await waitFor(async () => await ui("jump-to-latest").count() === 0, 5_000, "latest action resumes following the transcript");
      assert.equal(await ui("message-input").inputValue(), "保留的草稿");
      stage = "new-draft-context";
      await page.setViewportSize({ width: scenario.width, height: 844 });
      await ui("task-new").click();
      await ui("draft-context-server").waitFor(); await ui("draft-context-project").waitFor();
      await capture("v3-draft-context");
      stage = "gateway-auto-recovery";
      await ui("v3-conversation-menu").click();
      await ui("home-interface-v3").waitFor();
      const loadedThread = ui("home-interface-v3").getByText(originalTitle, { exact: true });
      await loadedThread.first().waitFor();
      let failedReads = 0;
      const failRuntimeRead = async route => { failedReads += 1; await route.abort("failed"); };
      await page.route("**/api/servers", failRuntimeRead);
      await page.route("**/api/servers/status", failRuntimeRead);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await ui("gateway-connection-error").waitFor();
      assert.equal(await ui("gateway-connection-error").count(), 1);
      assert.equal(await ui("server-status-error").count(), 0, "duplicate connection failures use one feedback surface");
      assert.ok(await loadedThread.count() > 0, "connection failure retains loaded sessions");
      await capture("v3-gateway-unavailable");
      const inventoryRecovered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/servers") && response.status() === 200, { timeout: 15_000 });
      const statusesRecovered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/servers/status") && response.status() === 200, { timeout: 15_000 });
      await page.unroute("**/api/servers", failRuntimeRead);
      await page.unroute("**/api/servers/status", failRuntimeRead);
      const successfulReads = await Promise.all([inventoryRecovered, statusesRecovered]);
      await Promise.all(successfulReads.map(response => response.finished()));
      await waitFor(async () => await ui("gateway-connection-error").count() === 0, 15_000, "Gateway reads recover on the retry timer without a manual click");
      assert.ok(failedReads >= 2); assert.ok(await loadedThread.count() > 0);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const runtimeReads = [];
      const observeRuntimeRead = request => { if (/\/api\/servers(?:\/status)?$/.test(new URL(request.url()).pathname)) runtimeReads.push(request.method()); };
      page.on("request", observeRuntimeRead);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      await waitFor(() => runtimeReads.length >= 2, 5_000, "a BFCache restore event refreshes runtime observations");
      assert.deepEqual([...new Set(runtimeReads)], ["GET"], "restoration only repeats runtime reads");
      page.off("request", observeRuntimeRead);
      await capture("v3-gateway-recovered");
      cases.push({ ...scenario, realReadTool: true, menuAndSearch: true, inputPreserved: true, contextOnlyOnDraft: true, centeredLatestAction: true,
        automaticRuntimeRetry: true, syntheticBrowserWakeEvents: true, loadedSessionsRetained: true });
    } catch (error) {
      await capture("failure"); await run.writeArtifactJson("failure-stage.json", { label, stage, errors, text: await page.locator("body").innerText(),
        disclosures: await page.locator('[aria-expanded]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute("data-testid"), expanded: node.getAttribute("aria-expanded") }))) }); throw error;
    } finally { await page.close(); await run.stopOwned(gatewayLabel); }
  }
  await run.writeArtifactJson("page-errors.json", errors); assert.deepEqual(errors, []);
  await run.writeArtifactJson("console.json", diagnostics);
  assert.deepEqual(diagnostics.filter(item => item.type === "error" && !item.expected), [], "no unexpected console errors");
  return { cases, captures, errors, diagnostics };
});
