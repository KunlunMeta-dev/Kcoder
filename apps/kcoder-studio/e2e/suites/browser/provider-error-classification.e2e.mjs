import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

// QA: a real loopback provider returns four HTTP failures through Rust and Gateway.
// Assert visible authentication/permission/rate/quota messages, then recover with
// HTTP 200. Fixtures, credentials and all processes belong only to this RunContext.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: "provider-http-auth-permission-rate-quota-error-classification",
  tier: "full-integration",
  modelPolicy: "model-independent HTTP error classification; synthetic credentials, no external provider",
  retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "provider-errors" });
  const profile = context.pathInState("profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await context.writeStateJson("profile/settings.json", {});
  context.registerSecret("fixture-classification-key");
  await context.writeStateJson("profile/credentials.json", {
    "error-fixture": { type: "api", key: "fixture-classification-key" },
  });
  const options = {
    httpErrorPrompt: "CLASSIFY_HTTP_ERROR", httpErrorStatus: 401,
    httpErrorMessage: "Invalid API key. Review billing settings.",
    textOnly: true, textOnlyResponse: "HTTP_ERROR_RECOVERY_OK",
  };
  const model = await startApprovalModelFixture(context, options);
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "error-fixture", max_retries: 0,
    providers: { "error-fixture": {
      api_format: "openai_chat_completions", endpoint: model.baseUrl,
      default_model: "error-fixture", context_window_tokens: 128000,
      output_headroom_tokens: 8192, max_output_tokens: 8192, no_proxy: true, max_retries: 0,
    } },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Provider Errors", runtime: "kcoder", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const checks = [];
  try {
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login")), page.locator('button[type="submit"]').click()]);
    await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });
    const project = page.locator('[data-testid="project-item"]:visible').filter({ hasText: "Provider Errors" }).first();
    await project.waitFor({ timeout: 60000 });
    const send = async prompt => {
      await project.hover();
      await project.getByTestId("project-new-conversation-button").click();
      await page.getByTestId("chat-message-input").click();
      await page.keyboard.insertText(prompt);
      await page.getByTestId("send-message-button").click();
    };
    for (const [status, message, title] of [
      [401, "Invalid API key. Review billing settings.", "API 认证失败"],
      [403, "Forbidden: insufficient_quota. Contact billing support.", "访问被拒绝：您没有使用此资源的权限"],
      [429, "Request rejected. Review billing settings.", "请求过于频繁，请稍后再试"],
      [429, "insufficient_quota: You exceeded your current quota.", "当前模型的使用额度已耗尽"],
    ]) {
      options.httpErrorStatus = status;
      options.httpErrorMessage = message;
      options.httpErrorCode = message.includes("insufficient_quota") ? "insufficient_quota" : undefined;
      await send(`CLASSIFY_HTTP_ERROR ${checks.length}`);
      const card = page.locator('[data-testid="assistant-error-card"]:visible').last();
      await card.getByText(title, { exact: true }).waitFor({ timeout: 60000 });
      const text = await card.innerText();
      if (status === 401) assert.match(text, /应用配置再重试/);
      if (status !== 429) assert.doesNotMatch(text, /当前模型的使用额度已耗尽/);
      assert.ok(model.requests.length >= checks.length + 1, "failure must reach the real HTTP fixture");
      checks.push({ status, title });
      if (status === 401) await page.screenshot({ path: context.pathInArtifacts("authentication-error.png") });
    }
    options.httpErrorPrompt = null;
    await send("Recover after the fixture accepts the request.");
    await page.getByText("HTTP_ERROR_RECOVERY_OK", { exact: true }).waitFor({ timeout: 60000 });
    assert.equal(await page.locator('[data-testid="assistant-error-card"]:visible').count(), 0);
    await context.writeArtifactJson("checks.json", { checks, recovered: true, providerRequests: model.requests.length });
    return { classifiedCases: checks.length, recovered: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts("failure.png") }).catch(() => {});
    await context.writeArtifactJson("checks.json", { checks, error: error.message });
    throw error;
  } finally {
    await page.close();
  }
});
