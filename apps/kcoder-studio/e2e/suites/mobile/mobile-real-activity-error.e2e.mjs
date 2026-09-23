import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-activity-and-safe-error",
  tier: "full-integration",
  modelPolicy: "model-independent real app-server background activity and deterministic provider failure",
  retainSuccessLogs: true,
}, async context => {
  const chromium = await startChromium(context, { label: "mobile-activity-error-chromium" });
  const diagnostics = [];

  const activityWorkspace = context.pathInState("activity-workspace");
  const activityConfig = context.pathInState("activity-config");
  await mkdir(activityWorkspace, { recursive: true });
  await mkdir(activityConfig, { recursive: true, mode: 0o700 });
  await writeFile(resolve(activityWorkspace, "README.md"), "background activity fixture\n", "utf8");
  await context.writeStateJson("activity-config/settings.json", {});
  const activityServers = await context.writeStateJson("activity-servers.json", [localServer(activityWorkspace)]);
  const activityGateway = await startGateway(context, {
    label: "mobile-activity-gateway",
    workspace: activityWorkspace,
    serversFile: activityServers,
    env: {
      KCODER_CONFIG_DIR: activityConfig,
      KCODER_STUDIO_WEB_ROOT: mobileDist,
      KCODER_STUDIO_SCENARIO: "subagent-trace",
      KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS: "1500",
      KCODER_TUI_LAB_TEXT_CHUNK_CHARS: "20000",
    },
  });
  const activityPage = await mobilePage(chromium, diagnostics);
  await connect(activityPage, activityGateway);
  await createTask(activityPage, "app-server-background-subagent tui-lab-targeted-subagent-steer MOBILE_ACTIVITY_CARD");
  const activity = activityPage.locator('[data-testid^="activity-background-"]').first();
  await activity.waitFor({ state: "visible", timeout: 60_000 });
  assert.match(await activity.innerText(), /进行中/);
  await activity.getByText(/\d+ \/ 60/).waitFor({ timeout: 30_000 });
  await activity.getByTestId("subagent-steer-open").click();
  const mobileSteerSentinel = "MOBILE_TARGETED_SUBAGENT_STEER_E2E";
  await activity.getByTestId("subagent-steer-input").fill(mobileSteerSentinel);
  await activity.getByTestId("subagent-steer-submit").click();
  await activity.getByTestId("subagent-steer-status").filter({ hasText: "调整已排队" })
    .waitFor({ state: "visible", timeout: 30_000 });
  try {
    await activity.getByTestId("subagent-steer-status").filter({ hasText: "调整已应用" })
      .waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    await context.writeArtifactJson("mobile-steer-diagnostic.json", {
      body: await activityPage.locator("body").innerText(),
      activities: await activityPage.locator('[data-testid^="activity-background-"]').allTextContents(),
      steerStatuses: await activityPage.getByTestId("subagent-steer-status").allTextContents(),
      diagnostics,
    });
    await activityPage.screenshot({
      path: context.pathInArtifacts("mobile-steer-failure.png"),
      fullPage: true,
    });
    throw error;
  }
  assert.equal(
    await activityPage.getByTestId("message-user").filter({ hasText: mobileSteerSentinel }).count(),
    0,
    "Mobile 将定向子智能体指令错误写入父对话",
  );
  await activityPage.getByText("tui-lab-subagent-trace-final-sentinel", { exact: false })
    .waitFor({ state: "visible", timeout: 60_000 });
  await activity.getByText("完成", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await activityPage.reload({ waitUntil: "domcontentloaded" });
  await activityPage.getByText("tui-lab-subagent-trace-final-sentinel", { exact: false })
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await activityPage.locator('[data-testid^="activity-background-"]').count(), 0,
    "activity 是实时运行态，不应伪装成可持久化 transcript");

  const errorWorkspace = context.pathInState("error-workspace");
  const errorConfig = context.pathInState("error-config");
  await mkdir(errorWorkspace, { recursive: true });
  await mkdir(errorConfig, { recursive: true, mode: 0o700 });
  const errorModel = await startApprovalModelFixture(context, {
    textOnly: true,
    httpErrorPrompt: "MOBILE_PROVIDER_FAILURE",
    httpErrorStatus: 401,
    httpErrorMessage: "Incorrect API key provided secret-value-for-details",
  });
  const settingsFile = await context.writeStateJson("error-settings.json", {
    active_provider: "error-provider",
    permission_mode: "yolo",
    providers: {
      "error-provider": {
        api_format: "openai_chat_completions",
        endpoint: errorModel.baseUrl,
        default_model: "error-e2e-model",
        context_window_tokens: 128000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("error-config/settings.json", {});
  await context.writeStateJson("error-config/credentials.json", {
    "error-provider": { type: "api", key: "deterministic-local-fixture" },
  });
  const errorServers = await context.writeStateJson("error-servers.json", [{
    ...localServer(errorWorkspace),
    settingsFile,
  }]);
  const errorGateway = await startGateway(context, {
    label: "mobile-error-gateway",
    workspace: errorWorkspace,
    serversFile: errorServers,
    env: { KCODER_CONFIG_DIR: errorConfig, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const errorPage = await mobilePage(chromium, diagnostics);
  await connect(errorPage, errorGateway);
  await createTask(errorPage, "MOBILE_PROVIDER_FAILURE");
  const banner = errorPage.getByTestId("runtime-error-banner");
  await banner.waitFor({ state: "visible", timeout: 60_000 });
  assert.equal((await banner.innerText()).includes("secret-value-for-details"), false,
    "折叠摘要不得泄漏原始 Provider 凭据文本");
  assert.match(await banner.innerText(), /Provider 拒绝了请求/);
  const details = errorPage.getByTestId("runtime-error-details");
  assert.equal(await details.getAttribute("aria-expanded"), "false");
  await details.click();
  assert.equal(await details.getAttribute("aria-expanded"), "true");
  assert.doesNotMatch(await banner.innerText(), /secret-value-for-details/);
  assert.match(await banner.innerText(), /HTTP 401/);
  await errorPage.reload({ waitUntil: "domcontentloaded" });
  await errorPage.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await errorPage.getByTestId("runtime-error-banner").count(), 0,
    "瞬时 Provider error 不应在刷新后伪装成持久化消息");

  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-activity-error.json", {
    backgroundActivity: { runningVisible: true, completedVisible: true, durable: false, targetedSteer: true },
    providerError: { safeSummary: true, expandableDetails: true, durable: false },
    diagnostics,
  });
  return { backgroundActivity: true, targetedSubagentSteer: true, safeExpandableError: true, transientStateExplicit: true };
});

function localServer(workspace) {
  return {
    id: "local",
    label: "Local",
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
  };
}

async function mobilePage(chromium, diagnostics) {
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  return page;
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
}
