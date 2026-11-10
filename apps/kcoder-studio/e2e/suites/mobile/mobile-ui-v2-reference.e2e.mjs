import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { createMobileRenderProfileSourceInputs } from "../../harness/mobile-render-profile-source-inputs.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { openOwnedMobileRpc } from "../../harness/owned-mobile-rpc.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { verifyDraftNotices } from "./helpers/draft-notice-review.mjs";

const V1 = "3b3a2aeac9f924dfd519b90ac8d7c0ebc4277b0c";
const VERSIONS = process.argv.includes("--current-only") ? ["v2"] : ["v1", "v2"];
const PREFS = "kcoder-studio:mobile-app-preferences:v1";
const REPLY = "## 下一步可以帮你做的事\n\n1. 先确认应用依赖了哪些后端能力：数据库、文件存储与登录。\n2. 如果要迁移，我可以帮你写：\n   - 数据导出脚本\n   - 自建后端代码模板\n   - Docker Compose 部署文件\n3. 如果要加固，可以增加应用层加密与密钥管理。\n\n你倾向哪条路径？也可以先介绍项目当前的结构。";
const MATRIX = [
  { width: 390, language: "zh-CN", theme: "light" },
  { width: 320, language: "zh-CN", theme: "dark" },
  { width: 390, language: "en", theme: "dark" },
  { width: 320, language: "en", theme: "light" },
  { width: 1050, language: "zh-CN", theme: "light" },
];
const SCENARIOS = process.argv.includes("--smoke") ? MATRIX.slice(0, 1) : MATRIX;

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-v1-v2-reference-layout", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "model-independent visual/layout and exact-target selection acceptance; real Gateway/app-server with owned synthetic histories and deterministic loopback text provider; no paid provider or native-device claim",
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  const { runOwnedSourceCommand } = createMobileRenderProfileSourceInputs({ assert, repoRoot, waitFor });
  const baseline = run.pathInState("v1-source"); await mkdir(baseline, { mode: 0o700 });
  const archive = run.pathInState("v1-source.tar");
  await runOwnedSourceCommand(run, "v1-archive", "git", ["archive", `--output=${archive}`, V1, "apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"]);
  await runOwnedSourceCommand(run, "v1-extract", "tar", ["-xf", archive, "-C", baseline]);
  const builds = [];
  for (const version of VERSIONS) {
    console.log(`[mobile-ui-v2] export ${version}`);
    const web = await exportMobileWeb(run, { label: `${version}-ui`, stateNamespace: `${version}-export`, outputName: `${version}-web`, deployMount: true,
      ...(version === "v1" ? { mobileRoot: resolve(baseline, "apps/kcoder-studio/mobile"), dependencyRoot: resolve(appRoot, "mobile/node_modules") } : {}) });
    await writeGatewayMobileWebManifest(web.path, await buildGatewayMobileWebManifest(web.path, { expectedFiles: web.bundleFiles }));
    builds.push({ version, web });
  }
  const apiWorkspace = await materializeWorkspace(run, "minimal", { instanceId: "user-center" });
  const docsWorkspace = await materializeWorkspace(run, "minimal", { instanceId: "product-docs" });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 });
  await run.writeStateJson("config/settings.json", {});
  const provider = await startApprovalModelFixture(run, { textOnly: true, textOnlyResponse: () => REPLY });
  const settingsFile = await run.writeStateJson("settings.json", { active_provider: "v2-layout", permission_mode: "ask", providers: {
    "v2-layout": { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: provider.baseUrl,
      default_model: "layout-model", context_window_tokens: 128000, max_output_tokens: 2048, output_headroom_tokens: 4096, request_timeout_secs: 30, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson("servers.json", [
    { id: "api", label: "prod-api-cluster", runtime: "kcoder", transport: "local", command: binary, workspace: apiWorkspace.path, settingsFile },
    { id: "docs", label: "doc-platform", runtime: "kcoder", transport: "local", command: binary, workspace: docsWorkspace.path, settingsFile },
    { id: "offline", label: "analytics-cn-east", runtime: "kcoder", transport: "ssh", host: "kcoder-unreachable.invalid", port: 22, user: "fixture", command: "kcoder", workspace: "/workspace/analytics" },
  ]);
  const browser = await startChromium(run, { label: "v2-reference-browser", noSandbox: true });
  const screenshots = [], errors = [], functional = [];
  let seededThread;
  const seededRows = [];
  for (const { version, web } of builds) {
    for (const scenario of version === "v1" ? MATRIX.slice(0, 1) : SCENARIOS) {
      const label = `${version}-${scenario.width}-${scenario.language}-${scenario.theme}`;
      const gatewayLabel = `${label}-gateway`;
      const gateway = await startGateway(run, { label: gatewayLabel, auth: true, workspace: apiWorkspace.path, serversFile,
        env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ROOT: web.path }, kcoderBin: binary });
      if (!seededThread) {
        for (const [id, workspace, titles] of [["api", apiWorkspace.path, ["本地部署后端云服务", "JWT 异常码统一规范"]], ["docs", docsWorkspace.path, ["产品 PRD 第三节修订"]]]) {
          const observer = await openOwnedMobileRpc(run, gateway, id, workspace);
          for (const [index, title] of titles.entries()) {
            const created = await observer.rpc.request("thread/start", { cwd: workspace, clientRequestId: randomUUID() });
            const threadId = created.thread.id;
            seededRows.push(threadId);
            const finished = observer.rpc.waitFor(message => message.method === "turn/completed" && message.params?.threadId === threadId, 60_000);
            await observer.rpc.request("turn/start", { threadId, clientMessageId: randomUUID(), input: [{ type: "text", text: index === 0 ? "请介绍这个项目，并列出后续可以推进的工作。" : "请检查接口异常码的规范。" }] });
            await finished;
            if (id === "api" && index === 0) {
              seededThread = threadId;
            }
            await observer.rpc.request("thread/metadata/update", { threadId, title });
          }
          await observer.close();
        }
      }
      const entry = web.bundleFiles.filter(file => file.path.startsWith("_expo/static/js/web/") && file.path.endsWith(".js")).sort((a, b) => b.size - a.size)[0];
      const expectedJs = Buffer.from((await readFile(resolve(web.path, entry.path), "utf8")).replaceAll("/__kcoder_mobile_mount_v1__", "/mobile"));
      const page = await browser.newPage({ viewport: { width: scenario.width, height: 844 } });
      let stage = "pairing";
      try {
      const ui = id => page.locator(`[data-testid="${id}"]:visible`);
      page.on("pageerror", error => errors.push({ label, message: error.message }));
      await page.addInitScript(({ key, preferences }) => localStorage.setItem(key, JSON.stringify(preferences)), { key: PREFS, preferences: {
        ...scenario, quickPhrases: [{ id: "reference-phrase", title: "保留草稿", content: "菜单插入的快捷短语" }],
      } });
      const assetResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/mobile/${entry.path}`);
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      assert.equal(createHash("sha256").update(await (await assetResponse).body()).digest("hex"), createHash("sha256").update(expectedJs).digest("hex"));
      await ui("welcome-direct-connection").click();
      await ui("gateway-endpoint").fill(gateway.baseUrl); await ui("gateway-token").fill(gateway.authToken); await ui("gateway-connect").click();
      await ui("new-workspace").waitFor({ timeout: 45_000 });
      const homeUrl = page.url();
      const capture = async name => {
        await page.evaluate(() => document.activeElement?.blur());
        await page.waitForTimeout(250);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        assert.equal(overflow, false, `${label} ${name} must fit the viewport`);
        const path = run.pathInArtifacts(`${label}-${name}.png`); await page.screenshot({ path }); screenshots.push({ version, ...scenario, name, path });
        console.log(`[mobile-ui-v2] ${label} ${name}`);
      };
      const navigateHome = async () => {
        await page.goto(homeUrl, { waitUntil: "networkidle" });
        await ui("new-workspace").waitFor({ timeout: 30_000 });
        await waitFor(async () => await ui("new-workspace-api-0").isEnabled(), 45_000, "home workspace actions follow refreshed target ownership");
      };
      await ui("toggle-server-api").waitFor({ timeout: 45_000 });
      await ui(`thread-${seededThread}`).waitFor({ timeout: 45_000 });
      stage = "home";
      if (version === "v2") {
        assert.equal(await ui("interaction-inbox").locator("..").locator("svg").count(), 4, "home exposes Inbox, Search, Settings and Clock without the old Menu icon");
        assert.equal(await page.locator('[data-testid^="workspace-actions-"]:visible').count(), 0, "project actions do not reserve an extra icon column");
        assert.equal(await page.locator('[data-testid^="thread-actions-"]:visible').count(), 0, "task actions use long press");
        await page.waitForLoadState("networkidle");
        await waitFor(async () => await ui("new-workspace-api-0").isEnabled(), 45_000, "workspace ownership is ready for long press");
        await ui("toggle-server-api").click({ delay: 650 });
        await ui("workspace-actions-path-api-0").waitFor();
        assert.equal(await ui("workspace-actions-path-api-0").innerText(), apiWorkspace.path);
        await ui("workspace-actions-close-api-0").click();
        await ui(`thread-${seededThread}`).click({ delay: 650 });
        await ui("thread-rename-input").waitFor();
        assert.equal(new URL(page.url()).pathname, new URL(homeUrl).pathname, "long press opens task actions without navigating");
        await page.keyboard.press("Escape");
        await ui("thread-rename-input").waitFor({ state: "hidden" });
        functional.push(`${label}: reference home icons retain exact-workspace actions through long press`);
      }
      await capture("home");
      await ui("sessions").click(); await ui(`session-${seededThread}`).waitFor({ timeout: 45_000 });
      for (const id of seededRows) await ui(`session-${id}`).waitFor({ timeout: 45_000 });
      stage = "history";
      if (version === "v2") {
        await ui("sessions-page-loading").waitFor({ state: "hidden", timeout: 45_000 });
        for (const id of ["sessions-load-error", "sessions-load-notice", "sessions-partial-indicator"]) {
          assert.equal(await ui(id).count(), 0, "an unreachable target must not add history diagnostics or filter badges");
        }
        assert.equal(await page.locator('[role="alert"]:visible').count(), 0, "loaded history must remain readable without disconnect alerts");
        for (const id of seededRows) await ui(`session-${id}`).waitFor();
        functional.push(`${label}: unreachable target preserves loaded histories without extra diagnostics`);
        await ui(`session-${seededThread}`).click({ delay: 650 });
        await ui("thread-rename-input").waitFor();
        await page.keyboard.press("Escape");
        await ui("thread-rename-input").waitFor({ state: "hidden" });
        assert.equal(await page.locator('[data-testid^="session-actions-"]:visible').count(), 0, "history actions use long press instead of the extra More column");
      }
      await capture("history");
      if (version === "v2") {
        await ui("sessions-open-filters").click(); await ui("sessions-filter-page").waitFor(); await capture("filter");
        await ui("sessions-host-docs").click(); await ui("sessions-filter-apply").click();
        await waitFor(async () => await ui(`session-${seededThread}`).count() === 0, 20_000, "server filter removes other target rows");
        await ui("sessions-open-filters").click(); await ui("sessions-filter-reset").click(); await ui("sessions-filter-apply").click();
        await ui(`session-${seededThread}`).waitFor({ timeout: 30_000 });
        for (const id of seededRows) await ui(`session-${id}`).waitFor({ timeout: 45_000 });
        functional.push(`${label}: filter apply/reset preserves target scope`);
      }
      stage = "open-conversation";
      await ui(`session-${seededThread}`).click(); await ui("message-input").waitFor({ timeout: 30_000 });
      await page.getByText("下一步可以帮你做的事", { exact: true }).filter({ visible: true }).waitFor({ timeout: 30_000 });
      if (version === "v2") {
        const selector = await ui("conversation-model-selector").boundingBox();
        assert.ok(selector && selector.width >= 72 && selector.width <= 220, "the conversation model control must remain readable without stretching into a wide pill");
        const input = await ui("message-input").boundingBox(), toolbar = await ui("composer-toolbar").boundingBox();
        assert.ok(input && toolbar && input.y + input.height <= toolbar.y + 1, "input text and toolbar must occupy separate rows");
        assert.equal(await ui("mobile-subagents-open").count(), 0, "subagent actions belong in More, outside the normal transcript");
        await ui("task-header-person").waitFor();
        assert.deepEqual(await ui("assistant-response-actions").locator("button").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-testid"))),
          ["assistant-response-like", "assistant-response-dislike", "assistant-response-copy", "assistant-response-share", "assistant-response-more"],
          "response controls follow the reference order with a trailing More action");
        assert.equal(await ui("assistant-response-like").isDisabled(), true, "rating controls remain UI-only as requested");
        assert.equal(await ui("assistant-response-dislike").isDisabled(), true);
        assert.equal(await ui("message-fork").count(), 0, "forking is available in response More");
        assert.equal(await ui("message-edit-last").count(), 0, "message editing is available on long press");
        for (const id of ["task-search", "workspace-tab-switcher", "composer-quick-phrases", "task-menu-search", "task-menu-workspace"]) {
          assert.equal(await ui(id).count(), 0, `${id} must not appear on the normal conversation surface`);
        }
        for (const id of ["task-new", "task-more"]) {
          const outline = await ui(id).locator(":scope > div").evaluate(element => {
            const style = getComputedStyle(element);
            return { border: parseFloat(style.borderTopWidth), radius: parseFloat(style.borderTopLeftRadius) };
          });
          assert.ok(outline.border >= 1 && outline.radius > 0, "header actions use the reference rounded outlines");
        }
      }
      await capture("conversation");
      if (version === "v2") {
        stage = "more-navigation";
        await ui("message-input").fill("保留原草稿");
        await ui("task-more").click();
        await ui("task-menu-search").waitFor();
        await capture("more");
        await ui("task-menu-search").click();
        await ui("transcript-search-input").fill("后端");
        await waitFor(async () => (await ui("transcript-search-count").innerText()) !== "0/0", 10_000, "loaded-body search still finds rendered text");
        await ui("transcript-search-close").click();
        await ui("task-more").click(); await ui("task-menu-workspace").click();
        await ui("workspace-tab-agent").click();
        await ui("task-more").click(); await ui("task-quick-phrases").click();
        await ui("quick-phrase-use-reference-phrase").click();
        assert.equal(await ui("message-input").inputValue(), "保留原草稿\n菜单插入的快捷短语");
        await ui("message-input").fill("");
        await ui("task-new").click();
        await ui("draft-context-project").waitFor();
        const draftRoute = new URL(page.url());
        assert.equal(draftRoute.searchParams.get("serverId"), "api");
        assert.equal(draftRoute.searchParams.get("cwd"), apiWorkspace.path);
        functional.push(`${label}: outlined header, person subtitle, More search/tabs/quick phrases, preserved draft and exact-workspace new conversation`);
      }
      await navigateHome();
      stage = "new";
      await ui("new-workspace-api-0").click(); await ui("draft-context-project").waitFor(); await ui("draft-model-selector").waitFor();
      await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "model options follow a connected project");
      if (version === "v2") {
        const selector = await ui("draft-model-selector").boundingBox();
        assert.ok(selector && selector.width >= 72, "ready draft model labels use the readable conversation control");
        const permission = await ui("draft-permission-selector").boundingBox();
        assert.ok(permission && permission.x < selector.x, "ready drafts put the shield permission control before the model");
        assert.equal(await ui("draft-model-selector").locator("svg").count(), 0, "model labels do not add an arrow absent from the reference");
        assert.equal(await ui("draft-permission-selector").locator("svg").count(), 1, "draft permissions share the conversation shield icon");
        await ui("message-input").fill("检查展开态的图标");
        assert.equal(await ui("composer-quick-phrases").count(), 0, "expanded drafts keep quick phrases in the add menu");
        await ui("message-input").fill("");
      }
      await capture("new");
      if (version === "v2") {
        stage = "create-and-send";
        const requestsBefore = provider.requests.length;
        await ui("message-input").fill("1+1=，请回复结果。");
        await waitFor(async () => await ui("send-message").isEnabled(), 30_000, "workspace draft can send");
        await ui("send-message").click();
        await ui("message-list").getByText("下一步可以帮你做的事", { exact: true }).waitFor({ timeout: 60_000 });
        assert.equal(provider.requests.length, requestsBefore + 1, "creating a conversation dispatches exactly one model request");
        await capture("sent");
        functional.push(`${label}: workspace creation and first send receive a completed real app-server turn`);
        if (scenario.width === 390 && scenario.language === "zh-CN") {
          stage = "retained-draft-notices";
          await verifyDraftNotices({ page, ui, workspace: apiWorkspace.path, capture });
          assert.equal(provider.requests.length, requestsBefore + 1, "draft review must not restore or resend another authorization's work");
          functional.push(`${label}: retained settings stay quiet, real other-scope drafts stay isolated, and already-saved file drafts do not conflict`);
          stage = "unsafe-config-failure";
          await chmod(config, 0o775);
          try {
            await ui("message-input").fill("配置目录故障测试，请保留恢复边界。");
            await ui("send-message").click();
            await ui("message-attempt-failure").waitFor({ timeout: 45_000 });
            assert.equal(await ui("runtime-error-banner").count(), 0, "one failed turn must not produce duplicate failure banners");
            assert.equal(await page.getByText("configuration root is writable by other users", { exact: true }).filter({ visible: true }).count(), 0, "technical configuration errors remain behind explicit details");
            await capture("configuration-failure");
            await ui("failure-technical-details").click();
            await page.getByText("configuration root is writable by other users", { exact: true }).filter({ visible: true }).waitFor();
            await ui("failure-technical-details").click();
          } finally {
            await chmod(config, 0o700);
          }
          stage = "configuration-recovery";
          assert.equal(await ui("message-continue-failure").count(), 0, "runtime failures must not offer provider-only continuation");
          await ui("message-user-actions-trigger").click({ delay: 650 });
          await ui("message-edit-last").click();
          await ui("edit-last-message-input").fill("配置已修复，请继续。");
          await ui("transcript-action-confirm").click();
          await waitFor(async () => await ui("message-list").getByText("下一步可以帮你做的事", { exact: true }).count() === 2, 60_000, "corrected configuration allows explicit edit and resend");
          functional.push(`${label}: unsafe config fails closed, stays compact, and permits explicit edit/resend after permissions are restored`);
        }
        await navigateHome();
        await ui("new-workspace-api-0").click();
        await waitFor(async () => await ui("draft-model-selector").isEnabled(), 45_000, "another workspace draft is ready");
      }
      await ui("message-input").fill("保留这段未发送草稿，切换服务器后不要丢失。");
      if (version === "v2") {
        stage = "offline";
        await ui("draft-context-server").click(); await ui("draft-context-server-option-offline").click();
        await ui("draft-offline-composer").waitFor({ timeout: 45_000 }); await capture("offline");
        assert.equal(await ui("draft-permission-selector").count(), 0);
        await ui("draft-context-server").click(); await ui("draft-context-server-option-api").click();
        await waitFor(async () => await ui("message-input").isEditable(), 45_000, "connected project restores the composer");
        assert.equal(await ui("message-input").inputValue(), "保留这段未发送草稿，切换服务器后不要丢失。");
        functional.push(`${label}: offline gating and draft restore`);
        await navigateHome();
        await page.locator('[aria-label="任务导航"]:visible:not([aria-modal="true"])').or(page.locator('[aria-label="Task navigation"]:visible:not([aria-modal="true"])')).click();
        await ui("drawer-settings").click();
        await waitFor(() => new URL(page.url()).pathname.endsWith("/settings"), 15_000, "Settings remains reachable through the navigation drawer");
        functional.push(`${label}: Settings navigation retained`);
      }
      await page.close();
      await run.stopOwned(gatewayLabel);
      assert.equal(run.processes.get(gatewayLabel)?.stopped, true, "each visual case releases its exact Gateway and app-server ownership before the next client opens history");
      } catch (error) {
        await page.screenshot({ path: run.pathInArtifacts(`${label}-failure.png`) });
        await run.writeArtifactJson("failure-stage.json", { label, stage, path: new URL(page.url()).pathname, errors, text: await page.locator("body").innerText() });
        throw error;
      }
    }
  }
  assert.deepEqual(errors, []);
  return { baselineCommit: V1, versions: VERSIONS, smoke: process.argv.includes("--smoke"), appServerSha256: createHash("sha256").update(await readFile(binary)).digest("hex"), screenshots, functional, errors };
});
