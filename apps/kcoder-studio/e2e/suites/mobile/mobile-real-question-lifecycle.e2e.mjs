import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-question-answer-cancel-disconnect",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic provider question lifecycle",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { question: true });
  const settingsFile = await context.writeStateJson("question-settings.json", {
    active_provider: "question-mobile",
    permission_mode: "ask",
    providers: { "question-mobile": { api_format: "openai_chat_completions", endpoint: model.baseUrl, default_model: "approval-e2e-model", context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true, extra_body: {} } },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", { "question-mobile": { type: "api", key: "deterministic-local-fixture" } });
  const serversFile = await context.writeStateJson("servers.json", [{ id: "local", label: "Local", transport: "local", command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile }]);
  const gateway = await startGateway(context, { auth: true, label: "mobile-question-gateway", workspace, serversFile, env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist } });
  const chromium = await startChromium(context, { label: "mobile-question-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`); });
  await connect(page, gateway);

  await createQuestionTask(page, "MOBILE_QUESTION_ANSWER");
  const card = page.getByTestId("question-card");
  assert.match(await card.innerText(), /请选择部署方式/);
  const automatic = card.getByRole("radio", { name: /自动[,，]\s*由系统自动完成部署/ });
  const manual = card.getByRole("radio", { name: /手动[,，]\s*保留人工控制步骤/ });
  assert.equal(await automatic.getAttribute("aria-checked"), "false");
  assert.equal(await manual.getAttribute("aria-checked"), "false");
  assert.equal(await page.getByTestId("question-submit").isDisabled(), true);
  await automatic.click();
  await waitFor(page, async () => !(await page.getByTestId("question-submit").isDisabled()));
  assert.equal(await automatic.getAttribute("aria-checked"), "true");
  assert.equal(await manual.getAttribute("aria-checked"), "false");
  const requestsBeforeAnswer = model.requests.length;
  await page.getByTestId("question-submit").click();
  await card.waitFor({ state: "hidden", timeout: 30_000 });
  await waitFor(page, () => model.requests.length > requestsBeforeAnswer);
  assert.match(JSON.stringify(model.requests.slice(requestsBeforeAnswer)), /自动/);

  await returnHome(page);
  await createQuestionTask(page, "MOBILE_QUESTION_CANCEL");
  const requestsBeforeCancel = model.requests.length;
  await page.getByTestId("question-cancel").click();
  await page.getByTestId("question-card").waitFor({ state: "hidden", timeout: 30_000 });
  await waitFor(page, () => model.requests.length > requestsBeforeCancel);
  assert.match(JSON.stringify(model.requests.slice(requestsBeforeCancel)), /cancel|取消|declin|denied/i);

  await returnHome(page);
  await createQuestionTask(page, "MOBILE_QUESTION_DISCONNECT");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("question-card").waitFor({ state: "hidden", timeout: 30_000 });

  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-question-lifecycle.json", { providerRequestCount: model.requests.length, answerRoundTrip: true, cancelRoundTrip: true, disconnectClearedStaleCard: true, diagnostics });
  return { realProviderProtocol: true, answerRoundTrip: true, cancelRoundTrip: true, disconnectClearedStaleCard: true };
});

async function waitFor(page, condition) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > 60_000) throw new Error("等待问题生命周期事件超时");
    await page.waitForTimeout(100);
  }
}

async function returnHome(page) {
  await page.getByLabel("返回", { exact: true }).click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createQuestionTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  const approval = page.getByTestId("approval-card");
  await approval.waitFor({ state: "visible", timeout: 60_000 });
  assert.match(await approval.innerText(), /AskUserQuestion|请选择部署方式|问题/i);
  assert.equal(await page.getByTestId("approval-accept").isDisabled(), false);
  await page.getByTestId("approval-accept").click();
  await approval.waitFor({ state: "hidden", timeout: 30_000 });
  await page.getByTestId("question-card").waitFor({ state: "visible", timeout: 60_000 });
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}
