import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { startMobileDevelopmentServer } from "../../harness/mobile-development-server.mjs";
import { captureMobileExportSourceSnapshot } from "../../harness/mobile-export-source-snapshot.mjs";
import { materializeOwnedDependencies } from "../../harness/owned-dependencies.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { openOwnedMobileRpc } from "../../harness/owned-mobile-rpc.mjs";
import { openRpc } from "../../harness/rpc.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { registerOriginalCarrierCleanup } from "../../harness/native-systemd-carrier.mjs";

const MATRIX = [
  { width: 390, language: "zh-CN", theme: "light" },
  { width: 320, language: "zh-CN", theme: "dark" },
  { width: 390, language: "en", theme: "dark" },
  { width: 320, language: "en", theme: "light" },
];
process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-console-navigation", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "Model-independent development console and keyboard/modal navigation with owned Metro/Gateway/Rust app-server and bounded loopback provider; a synthetic unregistered-cwd directory row is injected at the owned browser RPC boundary to check history membership; no personal sessions or paid models",
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  const snapshotRoot = run.pathInState("source");
  const snapshot = await captureMobileExportSourceSnapshot({ snapshotRoot, layout: "preflight-source-root", sourceRoots: [
    { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
  ] });
  await run.writeArtifactJson("source.json", snapshot);
  const mobileRoot = resolve(snapshotRoot, "apps/kcoder-studio/mobile");
  await materializeOwnedDependencies(run, { sourceRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"), destination: resolve(mobileRoot, "node_modules"), label: "console-dependencies" });
  if (process.argv.includes("--build-only")) {
    const web = await exportMobileWeb(run, { label: "console-static-export", mobileRoot, dependencyRoot: resolve(mobileRoot, "node_modules"), deployMount: true });
    await writeGatewayMobileWebManifest(web.path, await buildGatewayMobileWebManifest(web.path, { expectedFiles: web.bundleFiles }));
    const html = await readFile(resolve(web.path, "index.html"), "utf8");
    assert.ok(html.includes('/__kcoder_mobile_mount_v1__/favicon.ico'), "static HTML must retain a mountable favicon URL");
    const workspace = await materializeWorkspace(run, "minimal", { instanceId: "static-console" });
    const gateway = await startGateway(run, { auth: true, startTimeoutMs: 120_000, workspace: workspace.path, env: { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_MOBILE_WEB_ROOT: web.path } });
    const response = await fetch(`${gateway.baseUrl}/mobile/`); assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('/mobile/favicon.ico'), "Gateway must rebase the HTML favicon");
    const favicon = await fetch(`${gateway.baseUrl}/mobile/favicon.ico`); assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type"), /^image\//);
    return { platform: "web", staticBuild: true, manifestVerified: true, gatewayEntry: 200, favicon: 200 };
  }
  const metro = await startMobileDevelopmentServer(run, { mobileRoot });
  const workspace = await materializeWorkspace(run, "minimal", { instanceId: "console" });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 }); await run.writeStateJson("config/settings.json", {});
  if (process.platform === "linux") {
    const runtimeDir = `/run/user/${process.getuid()}`;
    registerOriginalCarrierCleanup(run, { profile: config, workspace: workspace.path,
      uid: process.getuid(), gid: process.getgid(), activeManagers: new Set(),
      env: run.isolatedEnvironment({ XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` }),
    }, "console-owned-native-manager");
  }
  const provider = await startApprovalModelFixture(run, { textOnly: true, textOnlyResponse: () => "Owned console history reply." });
  const settingsFile = await run.writeStateJson("settings.json", { active_provider: "console", providers: {
    console: { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: provider.baseUrl,
      default_model: "console-model", context_window_tokens: 128000, max_output_tokens: 128, output_headroom_tokens: 4096,
      request_timeout_secs: 30, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson("servers.json", [{ id: "local", label: "Owned console target", transport: "local", command: binary, workspace: workspace.path, settingsFile }]);
  const gateway = await startGateway(run, { auth: true, startTimeoutMs: 120_000, workspace: workspace.path, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ORIGINS: metro.baseUrl } });
  const observer = await openOwnedMobileRpc(run, gateway, "local", workspace.path, {
    experimental: { threadCreationReceiptsV1: true },
    connect: (url, options) => openRpc(url, { ...options, timeoutMs: 60_000 }),
  });
  const created = await observer.rpc.request("thread/start", { cwd: workspace.path, clientRequestId: randomUUID() });
  const threadId = created.thread.id;
  const completion = observer.rpc.waitFor(frame => frame.method === "turn/completed" && frame.params?.threadId === threadId, 45_000);
  await Promise.all([
    completion,
    observer.rpc.request("turn/start", { threadId, clientMessageId: randomUUID(), input: [{ type: "text", text: "Owned console history" }] }),
  ]);
  await observer.close();
  const browser = await startChromium(run, { label: "console-browser", noSandbox: true });
  const diagnostics = [], errors = [], cases = [];
  for (const scenario of process.argv.includes("--smoke") ? MATRIX.slice(0, 1) : MATRIX) {
    const label = `${scenario.width}-${scenario.language}-${scenario.theme}`;
    const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
    await page.routeWebSocket("**/rpc*", socket => {
      const upstream = socket.connectToServer();
      const directoryRequests = new Set();
      socket.onMessage(raw => {
        try { const frame = JSON.parse(String(raw)); if (frame.method === "thread/list") directoryRequests.add(String(frame.id)); } catch { /* Non-JSON frames pass through unchanged. */ }
        upstream.send(raw);
      });
      upstream.onMessage(raw => {
        let frame;
        try { frame = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
        if (directoryRequests.delete(String(frame.id)) && Array.isArray(frame.result?.threads)) {
          frame.result.threads.push({ id: "unassigned-history-fixture", title: "Owned old-directory history", cwd: "/retired/preview/workspace", status: "idle", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 });
        }
        socket.send(JSON.stringify(frame));
      });
    });
    const cdp = await page.context().newCDPSession(page); await cdp.send("Log.enable"); await cdp.send("Accessibility.enable");
    let stage = "pair";
    const record = (source, level, message) => diagnostics.push({ label, stage, source, level, message: run.redactText(message) });
    page.on("console", message => { if (["warning", "error"].includes(message.type())) record("console", message.type(), message.text()); });
    cdp.on("Log.entryAdded", ({ entry }) => { if (["warning", "error"].includes(entry.level)) record("browser", entry.level, entry.text); });
    page.on("pageerror", error => errors.push({ label, stage, message: run.redactText(error.message) }));
    const ui = id => page.locator(`[data-testid="${id}"]:visible`);
    const step = async (name, action) => { stage = name; console.log(`[console-navigation] ${label}/${name}`); await action(); await cdp.send("Accessibility.getFullAXTree"); await page.waitForTimeout(350); };
    const activate = async id => { await ui(id).focus(); await page.keyboard.press("Enter"); };
    try {
      await page.addInitScript(preferences => localStorage.setItem("kcoder-studio:mobile-app-preferences:v1", JSON.stringify({ ...preferences, interfaceVersion: "v3" })), scenario);
      await page.goto(metro.baseUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
      await ui("welcome-direct-connection").click(); await ui("gateway-endpoint").fill(gateway.baseUrl); await ui("gateway-token").fill(gateway.authToken); await ui("gateway-connect").click();
      await ui("home-interface-v3").waitFor({ timeout: 45_000 });
      await ui(`thread-${threadId}`).waitFor({ timeout: 45_000 });
      assert.equal(await ui("thread-unassigned-history-fixture").count(), 0, "unregistered history cannot create a Home project");
      const home = page.url();
      await step("open-task-keyboard", async () => { await activate(`thread-${threadId}`); await ui("message-input").waitFor({ timeout: 45_000 }); });
      await step("task-more", async () => { await activate("task-more"); await ui("task-menu-search").waitFor(); });
      await step("task-search-from-menu", async () => { await activate("task-menu-search"); await ui("transcript-search-input").waitFor(); });
      await step("task-search-close", async () => { await ui("transcript-search-close").click(); });
      await step("navigation-history", async () => {
        await activate("v3-conversation-menu"); await activate("home-search"); await ui("session-search").waitFor();
        await ui("session-unassigned-history-fixture").waitFor();
        const membershipLabel = scenario.language === "zh-CN" ? /未归属项目/ : /Unassigned project/;
        await waitFor(async () => membershipLabel.test(await ui("session-row-unassigned-history-fixture").innerText()), 30_000, "authoritative project membership is ready");
        await page.screenshot({ path: run.pathInArtifacts(`${label}-unassigned-history.png`) });
      });
      await step("history-back", async () => { await page.goBack(); await ui("home-interface-v3").waitFor(); });
      await step("selection-thread", async () => { await activate(`thread-${threadId}`); await ui("message-input").waitFor(); });
      await page.goto(home, { waitUntil: "domcontentloaded" }); await ui("home-interface-v3").waitFor();
      await step("draft-open-keyboard", async () => { await activate("new-workspace-local-0"); await ui("message-input").waitFor(); });
      await step("project-picker", async () => { await activate("draft-context-project"); await ui("draft-context-close").waitFor(); });
      await step("project-picker-select", async () => { await page.locator('[data-testid^="draft-context-project-option-"]:visible').first().focus(); await page.keyboard.press("Enter"); });
      await step("draft-history-menu", async () => { await activate("v3-conversation-menu"); await activate("home-search"); await ui("session-search").waitFor(); });
      await step("draft-return", async () => { await page.goBack(); await page.goBack(); await ui("message-input").waitFor(); });
      await step("reload", async () => { await page.reload({ waitUntil: "domcontentloaded" }); await ui("message-input").waitFor(); });
      await page.screenshot({ path: run.pathInArtifacts(`${label}-draft.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      cases.push({ ...scenario, development: await page.evaluate(() => globalThis.__DEV__), keyboard: true, menus: true, history: true, selection: true, reload: true });
      console.log(`[console-navigation] ${label} complete`);
    } finally {
      await run.writeArtifactJson(`${label}-diagnostics.json`, diagnostics.filter(row => row.label === label));
      await run.writeArtifactJson(`${label}-page-errors.json`, errors.filter(row => row.label === label));
      await run.writeArtifactJson(`${label}-page-state.json`, { stage, text: await page.locator("body").innerText() });
      await page.close();
    }
  }
  assert.deepEqual(diagnostics, [], "Every development console/browser warning or error fails the regression");
  assert.deepEqual(errors, [], "No uncaught page exceptions");
  return { cases, diagnostics, errors };
});
