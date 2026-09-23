import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: "restored-provider-default-model-remains-available",
  tier: "full-integration",
  modelPolicy: "model-independent restored model catalog readiness; real Gateway, CLI and HTTP fixture",
  retainSuccessLogs: true,
}, async context => {
  // QA: restore a real conversation, withhold its real catalog response, keep typing
  // but reject Enter/click until the catalog arrives; then send the exact draft once.
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "schedules" });
  const profile = context.pathInState("profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await context.writeStateJson("profile/settings.json", {});
  context.registerSecret("schedule-fixture-key");
  await context.writeStateJson("profile/credentials.json", { schedule: { type: "api", key: "schedule-fixture-key" } });
  const modelOptions = { textOnly: true, textOnlyChunks: ["SCHEDULE_RESPONSE_DONE"], textOnlyChunkDelayMs: 0 };
  const model = await startApprovalModelFixture(context, modelOptions);
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "schedule", providers: { schedule: {
      api_format: "openai_chat_completions", endpoint: model.baseUrl, default_model: "schedule",
      context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192, no_proxy: true,
    } },
  });
  const serversFile = await context.writeStateJson("servers.json", [{ id: "local", label: "Schedules", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC" });
  let holdCatalog = false;
  const heldCatalogs = [];
  await page.routeWebSocket('**/rpc?**', route => {
    const upstream = route.connectToServer();
    const catalogIds = new Set();
    route.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.method === 'runtime.models.list') catalogIds.add(frame.id);
      upstream.send(message);
    });
    upstream.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (holdCatalog && catalogIds.has(frame.id)) heldCatalogs.push(() => route.send(message));
      else route.send(message);
    });
  });
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login")), page.locator('button[type="submit"]').click()]);
  const project = page.getByTestId("project-item").filter({ hasText: "Schedules" }).first();
  await project.waitFor({ timeout: 60000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
  await page.getByTestId("chat-message-input").click();
  await page.keyboard.insertText("Schedule smoke conversation\nORIGINAL_HISTORY_MUST_NOT_LEAK");
  await page.getByTestId("send-message-button").click();
  await page.getByText("SCHEDULE_RESPONSE_DONE", { exact: true }).waitFor({ timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1500)));
  assert.equal(await page.getByTestId("thinking-indicator").count(), 0);
  holdCatalog = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId('desktop-sidebar').locator('[data-testid^="runtime-local-task-row-"]').filter({ hasText: 'Schedule smoke conversation' }).first().click();
  await page.getByTestId("chat-message-input").click();
  await page.keyboard.insertText("RESTORED_MODEL_MARKER");
  await waitFor(() => heldCatalogs.length > 0, 10000, 'real catalog response held');
  assert.equal(await page.getByTestId('send-message-button').isDisabled(), true);
  await page.keyboard.press('Enter');
  assert.equal(model.requests.length, 1, 'loading catalog must not submit or change models');
  assert.ok((await page.getByTestId('chat-message-input').innerText()).includes('RESTORED_MODEL_MARKER'));
  holdCatalog = false;
  for (const release of heldCatalogs.splice(0)) release();
  await page.getByTestId("send-message-button").click();
  await waitFor(() => model.requests.some(request => JSON.stringify(request.messages).includes("RESTORED_MODEL_MARKER")),
    10000, "restored conversation sends with original provider", 100, context.abortSignal).catch(async error => {
      await context.writeArtifactJson('restore-failure.json', { text: await page.locator('body').innerText() });
      throw error;
    });
  await page.getByTestId('pause-response-button').waitFor({ state: 'detached', timeout: 15000 });
  assert.equal(model.requests.length, 2);
  return { restoredDefaultModel: true, lateCatalogBlocksSend: true, draftPreserved: true };
});
