import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-message-edit-fork-loaded-body-search", tier: "full-integration",
  modelPolicy: "model-independent UI and real Gateway/app-server rewind/fork protocol; deterministic loopback text provider; no model-quality claim",
  retainSuccessLogs: true,
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  const web = await exportMobileWeb(run, { label: "message-actions-web", outputName: "mobile-web", deployMount: true });
  await writeGatewayMobileWebManifest(web.path, await buildGatewayMobileWebManifest(web.path, { expectedFiles: web.bundleFiles }));
  const manifestSha256 = createHash("sha256").update(await readFile(resolve(web.path, "kcoder-mobile-web.json"))).digest("hex");
  const entry = web.bundleFiles.filter(file => file.path.startsWith("_expo/static/js/web/") && file.path.endsWith(".js"))
    .sort((left, right) => right.size - left.size)[0];
  assert(entry, "current-source entry bundle is required");
  const expectedEntry = Buffer.from((await readFile(resolve(web.path, entry.path), "utf8")).replaceAll("/__kcoder_mobile_mount_v1__", "/mobile"));
  const entrySha256 = createHash("sha256").update(expectedEntry).digest("hex");
  const workspace = await materializeWorkspace(run, "minimal", { instanceId: "message-actions" });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 });
  const model = await startApprovalModelFixture(run, { textOnly: true,
    textOnlyResponse: ({ requestNumber }) => `ANSWER_${requestNumber}: needle 正文检索。` });
  const settingsFile = await run.writeStateJson("model-settings.json", { active_provider: "message-fixture", permission_mode: "ask",
    providers: { "message-fixture": { api_format: "openai_chat_completions", authentication: { mode: "none" },
      endpoint: model.baseUrl, default_model: "message-fixture-model", context_window_tokens: 128000,
      output_headroom_tokens: 8192, max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true, extra_body: {} } } });
  await run.writeStateJson("config/settings.json", {});
  const serversFile = await run.writeStateJson("servers.json", [{ id: "local", label: "Fixture target", transport: "local", command: binary, workspace: workspace.path, settingsFile }]);
  const gateway = await startGateway(run, { auth: true, label: "message-actions-gateway", workspace: workspace.path, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ROOT: web.path } });
  const browser = await startChromium(run, { label: "message-actions-browser", noSandbox: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const ui = id => page.locator(`[data-testid="${id}"]:visible`);
  const transcript = () => ui("message-list");
  const errors = [];
  const methods = [];
  const historyShapes = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => {
    const requests = new Map();
    socket.on("framesent", ({ payload }) => {
      try { const frame = JSON.parse(String(payload)); if (frame.method) { methods.push({ method: frame.method, params: frame.params }); requests.set(frame.id, frame.method); } } catch { /* Ignore non-RPC frames. */ }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (requests.get(frame.id)?.startsWith("thread/read")) historyShapes.push({ thread: frame.result?.thread,
          messages: frame.result?.messages?.map(({ id, role, turnId, clientMessageId, status }) => ({ id, role, turnId, clientMessageId, status })) });
      } catch { /* Ignore non-RPC frames. */ }
    });
  });
  await page.addInitScript(() => { if (!localStorage.getItem("kcoder-studio:mobile-app-preferences:v1"))
    localStorage.setItem("kcoder-studio:mobile-app-preferences:v1", JSON.stringify({ language: "zh-CN", theme: "dark" })); });
  let stage = "connect";
  try {
    const entryResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/mobile/${entry.path}`);
    await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
    assert.equal(createHash("sha256").update(await (await entryResponse).body()).digest("hex"), entrySha256,
      "Gateway must serve this run's current-source Mobile JavaScript, after public mount replacement");
    await ui("welcome-direct-connection").click();
    await ui("gateway-endpoint").fill(gateway.baseUrl);
    await ui("gateway-token").fill(gateway.authToken);
    await ui("gateway-connect").click();
    await ui("new-workspace").waitFor({ timeout: 30_000 });
    stage = "first-send";
    await ui("new-workspace").click();
    await ui("message-input").fill("FIRST needle question");
    await waitFor(async () => await ui("send-message").isEnabled(), 30_000, "draft ready");
    await ui("send-message").click();
    await transcript().getByText("ANSWER_1: needle 正文检索。", { exact: true }).waitFor({ timeout: 60_000 });
    await ui("assistant-response-more").waitFor({ timeout: 10_000 });
    const sourceRoute = new URL(page.url()).pathname;
    stage = "second-send";
    await ui("message-input").fill("SECOND needle original");
    await ui("send-message").click();
    await transcript().getByText("ANSWER_2: needle 正文检索。", { exact: true }).waitFor({ timeout: 60_000 });
    await ui("message-user-actions-trigger").waitFor();
    await ui("message-input").fill("PRESERVED ordinary draft");
    stage = "search-loaded-body";
    const pagesBefore = methods.filter(call => call.params?.beforeCursor).length;
    await ui("task-more").click();
    await ui("task-menu-search").click();
    await ui("transcript-search-input").fill("needle");
    await ui("transcript-search-count").getByText("1/4", { exact: true }).waitFor();
    await ui("transcript-search-next").click();
    assert.equal(await ui("transcript-search-count").innerText(), "2/4");
    await ui("transcript-search-previous").click();
    assert.equal(await ui("transcript-search-count").innerText(), "1/4");
    assert.equal(methods.filter(call => call.params?.beforeCursor).length, pagesBefore);
    await page.screenshot({ path: resolve(run.artifactsDir, "search-390-zh-dark.png") });
    await ui("transcript-search-close").click();
    stage = "edit-last-message";
    await ui("message-user-actions-trigger").click({ delay: 650 });
    await ui("message-edit-last").click();
    await ui("edit-last-message-input").fill("SECOND corrected question");
    await waitFor(async () => {
      const sheet = await ui("transcript-action-sheet").boundingBox();
      return sheet && sheet.y >= 0 && sheet.y + sheet.height <= 845;
    }, 5_000, "edit sheet animation settles inside viewport");
    await page.screenshot({ path: resolve(run.artifactsDir, "edit-390-zh-dark.png") });
    await ui("transcript-action-confirm").click();
    await ui("transcript-action-sheet").waitFor({ state: "hidden", timeout: 30_000 });
    await transcript().getByText("ANSWER_3: needle 正文检索。", { exact: true }).waitFor({ timeout: 60_000 });
    assert.equal(await transcript().getByText("SECOND needle original", { exact: true }).count(), 0);
    assert.equal(await transcript().getByText("SECOND corrected question", { exact: true }).count(), 1);
    assert.equal(await transcript().getByText("ANSWER_2: needle 正文检索。", { exact: true }).count(), 0);
    assert.equal(await ui("message-input").inputValue(), "PRESERVED ordinary draft");
    assert.equal(methods.filter(call => call.method === "thread/rollback").length, 1);
    stage = "fork-completed-turn";
    await ui("message-assistant").filter({ hasText: "ANSWER_1:" }).getByTestId("assistant-response-more").click();
    await ui("message-fork").click();
    await ui("transcript-action-confirm").click();
    await waitFor(() => new URL(page.url()).pathname !== sourceRoute, 30_000, "new fork route");
    await waitFor(async () => await transcript().getByText("FIRST needle question", { exact: true }).count() === 1 &&
      await transcript().getByText("SECOND corrected question", { exact: true }).count() === 0 &&
      await ui("message-input").count() === 1 && await ui("message-input").inputValue() === "",
    30_000, "fork history and workspace draft are displayed");
    await ui("message-user-actions-trigger").waitFor({ timeout: 30_000 });
    assert.match(await ui("conversation-model-selector").innerText(), /message-fixture-model/);
    assert.equal(await transcript().getByText("SECOND corrected question", { exact: true }).count(), 0);
    assert.equal(methods.filter(call => call.method === "thread/fork").length, 1);
    assert.equal(methods.find(call => call.method === "thread/fork").params.cwd, workspace.path);
    await page.screenshot({ path: resolve(run.artifactsDir, "fork-390-zh-dark.png") });
    stage = "reload-and-narrow-layout";
    await page.reload({ waitUntil: "domcontentloaded" });
    await transcript().getByText("FIRST needle question", { exact: true }).waitFor({ timeout: 30_000 });
    await ui("message-user-actions-trigger").waitFor({ timeout: 30_000 });
    assert.match(await ui("conversation-model-selector").innerText(), /message-fixture-model/);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => localStorage.setItem("kcoder-studio:mobile-app-preferences:v1", JSON.stringify({ language: "en", theme: "light" })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui("task-more").waitFor({ timeout: 30_000 });
    await ui("task-more").click();
    await ui("task-menu-search").click();
    await ui("transcript-search-input").fill("needle");
    await ui("transcript-search-count").getByText("1/2", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(run.artifactsDir, "search-320-en-light.png") });
    assert.deepEqual(errors, []);
    return { sourceTreeSha256: web.sourceTreeSha256, bundleSha256: web.bundleSha256, manifestSha256, servedEntrySha256: entrySha256, scenarios: ["loaded-search-count-and-navigation", "rewind-once-and-resend", "draft-preserved", "fork-at-first-completed-turn", "fork-reloads", "320-en-light"],
      rollbackCount: methods.filter(call => call.method === "thread/rollback").length,
      forkCount: methods.filter(call => call.method === "thread/fork").length, errors };
  } catch (error) {
    await page.screenshot({ path: resolve(run.artifactsDir, "failure.png") }).catch(() => {});
    const diagnostics = await page.evaluate(() => {
      const element = [...document.querySelectorAll('[data-testid="message-list"]')].find(node => node.getBoundingClientRect().height > 0);
      const key = element && Object.keys(element).find(key => key.startsWith("__reactFiber$"));
      let fiber = key ? element[key] : null;
      const result = [];
      while (fiber) {
        const props = fiber.memoizedProps;
        const runtime = props?.model?.task ?? props?.task;
        if (runtime?.getSnapshot) {
          const snapshot = runtime.getSnapshot();
          const { messages, ...flags } = snapshot;
          result.push({ component: fiber.type?.name, enabled: { demo: props.demo, workspaceReady: props.workspaceReady, profile: props.profile?.id, server: props.server?.id },
            flags, actions: props.actions ? { editableId: props.actions.editableId, forks: [...props.actions.forkIds] } : undefined,
            messages: messages.map(({ id, role, status, turnId }) => ({ id, role, status, turnId })) });
        }
        fiber = fiber.return;
      }
      return result;
    }).catch(() => []);
    await run.writeArtifactJson("failure-stage.json", { stage, errors, diagnostics, historyShapes, methods: methods.map(call => call.method), text: await page.locator("body").innerText() });
    throw error;
  }
});
