import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
const alphaModel = "mobile-alpha-e2e-model";
const betaModel = "mobile-beta-e2e-model";
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-turn-preferences-reload",
  tier: "full-integration",
  modelPolicy: "two model-independent deterministic providers through one real app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("turn-preferences-settings.json", {
    active_provider: "mobile-beta",
    providers: {
      "mobile-alpha": provider(model.baseUrl, alphaModel),
      "mobile-beta": provider(model.baseUrl, betaModel),
    },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", {
    "mobile-alpha": { type: "api", key: "deterministic-alpha" },
    "mobile-beta": { type: "api", key: "deterministic-beta" },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Local", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true, label: "mobile-turn-preferences-gateway", workspace, serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-turn-preferences-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcRequests = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("websocket", socket => {
    socket.on("framesent", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value?.method) rpcRequests.push({ method: value.method, params: value.params ?? null });
      } catch {}
    });
  });

  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("TURN_PREFERENCES_BOOTSTRAP");
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  await assertSelector(page, betaModel);

  await page.getByTestId("conversation-model-selector").click();
  const picker = page.getByRole("dialog", { name: "切换模型" });
  await picker.getByText(alphaModel, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await picker.getByText(alphaModel, { exact: true }).click();
  await picker.getByText("高", { exact: true }).click();
  await picker.getByLabel("关闭").click();
  await picker.waitFor({ state: "hidden", timeout: 10_000 });
  await assertSelector(page, `${alphaModel} · 高`);

  await send(page, "TURN_PREFERENCES_BEFORE_RELOAD");
  await page.getByTestId("message-assistant").last().waitFor({ state: "visible", timeout: 60_000 });
  const beforeReloadTurn = rpcRequests.filter(request => request.method === "turn/start").at(-1);
  assert.equal(beforeReloadTurn?.params?.model, `mobile-alpha::${alphaModel}`);
  assert.equal(beforeReloadTurn?.params?.reasoningEffort, "high");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-user").filter({ hasText: "TURN_PREFERENCES_BEFORE_RELOAD" }).waitFor({ state: "visible", timeout: 30_000 });
  const restoredSelectorText = await page.getByTestId("conversation-model-selector").innerText();
  await page.getByTestId("conversation-model-selector").click();
  const restoredPicker = page.getByRole("dialog", { name: "切换模型" });
  const selectedModel = restoredPicker.getByText(alphaModel, { exact: true }).locator("..").locator("..");
  await restoredPicker.getByText(alphaModel, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const restoredModelChecked = await selectedModel.getAttribute("aria-checked");
  const restoredHighChecked = await restoredPicker.getByText("高", { exact: true }).locator("..").getAttribute("aria-checked");
  await restoredPicker.getByLabel("关闭").click();

  await send(page, "TURN_PREFERENCES_AFTER_RELOAD");
  await page.getByTestId("message-user").filter({ hasText: "TURN_PREFERENCES_AFTER_RELOAD" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  const turnRequests = rpcRequests.filter(request => request.method === "turn/start");
  const afterReloadTurn = turnRequests.at(-1);
  const providerRequests = model.requests.filter(request =>
    JSON.stringify(request).includes("TURN_PREFERENCES_BEFORE_RELOAD")
    || JSON.stringify(request).includes("TURN_PREFERENCES_AFTER_RELOAD"));
  await context.writeArtifactJson("mobile-real-turn-preferences-reload.json", {
    selectorBeforeReload: `${alphaModel} · 高`,
    selectorAfterReload: `${alphaModel} · 高`,
    restoredSelectorText,
    restoredModelChecked,
    restoredHighChecked,
    turnPreferences: turnRequests.slice(-2).map(request => ({
      model: request.params?.model,
      reasoningEffort: request.params?.reasoningEffort,
    })),
    providerModels: providerRequests.map(request => request.model),
    diagnostics,
  });
  assert.match(restoredSelectorText, new RegExp(`${escapeRegex(alphaModel)}\\s*·\\s*高`));
  assert.equal(restoredModelChecked, "true");
  assert.equal(restoredHighChecked, "true");
  assert.equal(afterReloadTurn?.params?.model, `mobile-alpha::${alphaModel}`);
  assert.equal(afterReloadTurn?.params?.reasoningEffort, "high");
  assert.equal(providerRequests.length, 2);
  assert.deepEqual(providerRequests.map(request => request.model), [alphaModel, alphaModel]);
  assert.deepEqual(diagnostics, []);
  return {
    realModelCatalog: true,
    taskModelChanged: true,
    reasoningEffortChanged: true,
    preferencesSurvivedReload: true,
    subsequentTurnsUsedPreferences: true,
  };
});

function provider(endpoint, defaultModel) {
  return {
    api_format: "openai_chat_completions", endpoint, default_model: defaultModel,
    capabilities: { reasoning: true, vision: false },
    context_window_tokens: 128000, output_headroom_tokens: 8192,
    max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true, extra_body: {},
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function assertSelector(page, expected) {
  const selector = page.getByTestId("conversation-model-selector");
  await selector.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(value => document.querySelector('[data-testid="conversation-model-selector"]')?.textContent?.includes(value), expected, { timeout: 30_000 });
}

async function send(page, prompt) {
  await page.getByTestId("message-input").fill(prompt);
  await page.getByTestId("send-message").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
}
