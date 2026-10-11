import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

const kcoderBinary = process.env.KCODER_E2E_KCODER_BIN
  ? resolve(process.env.KCODER_E2E_KCODER_BIN)
  : resolve(repoRoot, "target/kcoder-relay/bin/kcoder");
const alphaModel = "mobile-alpha-e2e-model";
const betaModel = "mobile-beta-e2e-model";

await runE2E(import.meta.url, {
  testId: "mobile-web-real-turn-preferences-reload",
  tier: "full-integration",
  modelPolicy: "model-independent real app-server and model catalog with two deterministic local Provider fixtures; no real Provider/model",
  retainSuccessLogs: true,
}, async context => {
  const configuredBackendBefore = await hashExecutableFile(kcoderBinary);
  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-turn-preferences-reload-export",
    outputName: "mobile-web-export",
    dependencyRoot: resolve(repoRoot, "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules"),
  });
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
    command: kcoderBinary, workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true, label: "mobile-turn-preferences-gateway", workspace, serversFile,
    kcoderBin: kcoderBinary,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileWeb.path },
  });
  const chromium = await startChromium(context, { label: "mobile-turn-preferences-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcRequests = [];
  const rpcMethodById = new Map();
  const modelCatalogResponses = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("websocket", socket => {
    socket.on("framesent", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value?.method) {
          rpcRequests.push({ method: value.method, params: value.params ?? null });
          rpcMethodById.set(value.id, value.method);
        }
      } catch {}
    });
    socket.on("framereceived", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (rpcMethodById.get(value?.id) !== "runtime.models.list") return;
        modelCatalogResponses.push({
          error: value.error?.message ?? null,
          models: value.result?.data?.map(model => ({
            id: model.id,
            providerId: model.providerId,
            model: model.model,
            providerCurrent: model.providerCurrent,
            isDefault: model.isDefault,
            supportedReasoningEfforts: model.supportedReasoningEfforts ?? null,
            defaultReasoningEffort: model.defaultReasoningEffort ?? null,
            configuration: {
              capabilities: model.configuration?.capabilities ?? null,
              reasoningPolicy: model.configuration?.reasoningPolicy ?? model.configuration?.reasoning_policy ?? null,
              reasoningEffort: model.configuration?.reasoningEffort ?? model.configuration?.reasoning_effort ?? null,
            },
          })) ?? null,
          activeConfiguration: value.result?.activeConfiguration ?? null,
        });
        rpcMethodById.delete(value.id);
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
  const effortPickerDom = await picker.evaluate(dialog => ({
    text: dialog.innerText,
    buttons: [...dialog.querySelectorAll("button")].map(button => ({
      text: button.innerText,
      disabled: button.disabled,
      checked: button.getAttribute("aria-checked"),
      label: button.getAttribute("aria-label"),
    })),
  }));
  const highEffortOptionCount = await picker.getByText("高", { exact: true }).count();
  if (highEffortOptionCount === 0)
    await page.screenshot({ path: context.pathInArtifacts("effort-picker-before-select.png") });
  await context.writeArtifactJson("model-effort-picker-diagnostic.json", {
    modelCatalogResponses,
    effortPickerDom,
    highEffortOptionCount,
  });
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
  const ownedBackendProcesses = await findOwnedExecutableProcesses({
    pgid: gateway.child.pid,
    executablePath: configuredBackendBefore.path,
  });
  const configuredBackendAfter = await hashExecutableFile(kcoderBinary);
  const backendProcessProvenance = {
    configuredBefore: configuredBackendBefore,
    configuredAfter: configuredBackendAfter,
    unchanged: JSON.stringify(configuredBackendAfter) === JSON.stringify(configuredBackendBefore),
    gatewayProcessGroupId: gateway.child.pid,
    status: ownedBackendProcesses.some(item => item.sha256 === configuredBackendBefore.sha256) ? "verified" : "unverified",
    ownedProcesses: ownedBackendProcesses,
    unverifiedReason: ownedBackendProcesses.some(item => item.sha256 === configuredBackendBefore.sha256)
      ? null
      : "no readable matching configured executable found in this run's Gateway process group",
  };
  await context.writeArtifactJson("mobile-backend-binary-provenance.json", backendProcessProvenance);
  assert.equal(backendProcessProvenance.unchanged, true, "configured KCoder backend binary changed during this run");
  await context.writeArtifactJson("mobile-real-turn-preferences-reload.json", {
    mobileWebExport: {
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      bundleSha256: mobileWeb.bundleSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
      bundleManifestPath: mobileWeb.bundleManifestPath,
    },
    backendBinary: backendProcessProvenance,
    executionProvenance: {
      modelIndependent: true,
      realAppServer: true,
      providerFixture: "two deterministic local fixtures",
      realProvider: false,
    },
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
    mobileSourceSha256: mobileWeb.sourceTreeSha256,
    mobileBundleSha256: mobileWeb.bundleSha256,
    backendExecutableProvenance: backendProcessProvenance.status,
    realAppServerModelCatalog: true,
    deterministicProviderFixtures: true,
    realProvider: false,
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
    reasoning_effort: "medium",
    reasoning_policy: { mode: "optional", efforts: ["none", "low", "medium", "high"] },
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
