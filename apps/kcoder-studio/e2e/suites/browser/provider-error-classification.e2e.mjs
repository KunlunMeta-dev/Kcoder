import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

// QA: a real loopback provider returns authentication, permission, rate, quota,
// and timeout failures through Rust and Gateway. Accepted user turns remain in
// transcript history and recovery retries the original turn once; this is not an
// unsent-composer-draft assertion. Fixtures and processes belong to this RunContext.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: "provider-http-auth-permission-rate-quota-timeout-recovery",
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
    httpErrorPrompt: null, httpErrorStatus: 401,
    httpErrorMessage: "Invalid API key. Review billing settings.",
    delayedRequestNumbers: [], streamDelayMs: 5000,
    textOnly: true, textOnlyResponse: "HTTP_ERROR_RECOVERY_OK",
  };
  const model = await startApprovalModelFixture(context, options);
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "error-fixture", max_retries: 0,
    providers: { "error-fixture": {
      api_format: "openai_chat_completions", endpoint: model.baseUrl,
      default_model: "error-fixture", context_window_tokens: 128000,
      output_headroom_tokens: 8192, max_output_tokens: 8192, no_proxy: true,
      max_retries: 0,
    } },
  });
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"));
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Provider Errors", runtime: "kcoder", transport: "local",
    command: binary, workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    workspace,
    serversFile,
    auth: true,
    startTimeoutMs: 300_000,
    // The regular stream idle watchdog is 180s. Accelerate only this owned
    // fixture through the existing training-mode test override so the same
    // Engine timeout path can be exercised without waiting three minutes.
    env: {
      KCODER_CONFIG_DIR: profile,
      KCODER_TRAINING_MODE: "true",
      KCODER_STREAM_IDLE_TIMEOUT_S: "1",
    },
  });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const checks = [];
  const statusResponses = [];
  const workspaceScanWarnings = [];
  page.on("response", async response => {
    if (new URL(response.url()).pathname !== "/api/servers/status") return;
    try {
      const payload = await response.json();
      statusResponses.push({
        httpStatus: response.status(),
        statuses: Array.isArray(payload.statuses)
          ? payload.statuses.map(({ id, status, latencyMs }) => ({ id, status, latencyMs }))
          : null,
      });
    } catch {
      statusResponses.push({ httpStatus: response.status(), invalidJson: true });
    }
  });
  page.on("console", message => {
    if (message.text().includes("无法读取 目标 的工作区注册表")) {
      workspaceScanWarnings.push(message.text());
    }
  });
  await page.addInitScript(() => {
    const probe = (window.__kcoderTargetProbe = { requests: [], responses: [] });
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.__kcoderTargetMethods = new Map();
        this.addEventListener("message", event => {
          try {
            const response = JSON.parse(event.data);
            const method = this.__kcoderTargetMethods.get(String(response.id));
            if (!method) return;
            this.__kcoderTargetMethods.delete(String(response.id));
            probe.responses.push({
              method,
              ok: !response.error,
              ...(response.error
                ? {
                    errorCode: response.error.code,
                    errorMessage: String(response.error.message ?? "").slice(0, 240),
                  }
                : {
                    itemCount: Array.isArray(response.result?.items)
                      ? response.result.items.length
                      : null,
                  }),
            });
          } catch {}
        });
      }

      send(data) {
        try {
          const request = JSON.parse(data);
          if (["runtime.workspaces.list", "runtime.worktrees.list"].includes(request.method)) {
            this.__kcoderTargetMethods.set(String(request.id), request.method);
            probe.requests.push({ method: request.method, deviceId: request.params?.deviceId ?? null });
          }
        } catch {}
        return super.send(data);
      }
    };
  });
  try {
    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login")), page.locator('button[type="submit"]').click()]);
    await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });
    const project = page.locator('[data-testid="project-item"]:visible').filter({ hasText: "Provider Errors" }).first();
    await project.waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);
    const targetProbe = await page.evaluate(() => window.__kcoderTargetProbe);
    const workbenchProbe = await page.evaluate(async () => {
      const bridge = window.__KCODER_STUDIO_E2E__;
      let runtimeStatus = { available: false };
      if (bridge?.invokeRuntimeCommand) {
        try {
          const status = await bridge.invokeRuntimeCommand("local_executor_status");
          runtimeStatus = {
            available: true,
            deviceId: status?.deviceId ?? null,
            running: status?.running ?? null,
            ready: status?.ready ?? null,
          };
        } catch (error) {
          runtimeStatus = { available: true, error: String(error).slice(0, 180) };
        }
      }
      const projectRows = [...document.querySelectorAll('[data-testid="project-item"]')].map(item => {
        const row = item.querySelector('[data-testid^="project-row-"]');
        const createButton = item.querySelector('[data-testid="project-new-conversation-button"]');
        return {
          projectId: row?.getAttribute("data-testid")?.replace("project-row-", "") ?? null,
          text: (item.textContent ?? "").trim().slice(0, 100),
          createDisabled: createButton?.disabled ?? null,
          createDisabledTitle: createButton?.disabled ? createButton.title : null,
        };
      });
      return {
        selectedServerId: localStorage.getItem("kcoder-studio:selected-server"),
        runtimeStatus,
        projectRows,
      };
    });
    await context.writeArtifactJson("target-status-diagnostic.json", {
      expectedTargetId: "local",
      statusResponses,
      workspaceScanWarnings,
      workspaceRpc: targetProbe,
      workbench: workbenchProbe,
    });
    const send = async prompt => {
      await project.hover();
      const createProjectConversation = project.getByTestId("project-new-conversation-button");
      if (await createProjectConversation.isDisabled()) {
        throw new Error("Project conversation is disabled after recording target status and workspace RPCs");
      }
      await createProjectConversation.click();
      await page.getByTestId("chat-message-input").click();
      await page.keyboard.insertText(prompt);
      await page.getByTestId("send-message-button").click();
    };
    const countRequestsContaining = marker => model.requests.filter(request =>
      JSON.stringify(request.messages ?? []).includes(marker)
    ).length;
    for (const [status, message, title, retryOriginal] of [
      [401, "Invalid API key. Review billing settings.", "API 认证失败", true],
      [403, "Forbidden: insufficient_quota. Contact billing support.", "访问被拒绝：您没有使用此资源的权限", false],
      [429, "Request rejected. Review billing settings.", "请求过于频繁，请稍后再试", true],
      [429, "insufficient_quota: You exceeded your current quota.", "当前模型的使用额度已耗尽", false],
    ]) {
      const prompt = `CLASSIFY_HTTP_ERROR_${checks.length}`;
      options.httpErrorPrompt = prompt;
      options.httpErrorStatus = status;
      options.httpErrorMessage = message;
      options.httpErrorCode = message.includes("insufficient_quota") ? "insufficient_quota" : undefined;
      await send(prompt);
      const card = page.locator('[data-testid="assistant-error-card"]:visible').last();
      await card.getByText(title, { exact: true }).waitFor({ timeout: 60000 });
      const text = await card.innerText();
      if (status === 401) assert.match(text, /应用配置再重试/);
      if (status === 429 && !message.includes("insufficient_quota")) assert.match(text, /稍后/);
      if (status !== 429) assert.doesNotMatch(text, /当前模型的使用额度已耗尽/);
      const acceptedMessage = page.getByTestId("message-user").filter({ hasText: prompt });
      await acceptedMessage.waitFor({ state: "visible", timeout: 30000 });
      assert.equal(await acceptedMessage.count(), 1, "the accepted user message stays in history once");
      assert.equal(countRequestsContaining(prompt), 1, "one initial provider request must reach the loopback fixture");
      checks.push({ status, title, acceptedTranscriptMessages: 1, initialProviderRequests: 1 });
      if (status === 401) await page.screenshot({ path: context.pathInArtifacts("authentication-error.png") });
      if (retryOriginal) {
        await page.waitForTimeout(status === 429 ? 1500 : 500);
        assert.equal(countRequestsContaining(prompt), 1, "no provider retry occurs without an explicit action");
        options.httpErrorPrompt = null;
        await card.getByTestId("assistant-error-retry").click();
        await page.getByText("HTTP_ERROR_RECOVERY_OK", { exact: true }).last().waitFor({ timeout: 60000 });
        assert.equal(countRequestsContaining(prompt), 2, "manual recovery retries the original provider turn once");
        assert.equal(await acceptedMessage.count(), 1, "retry must not append a duplicate user message");
        checks.at(-1).manualOriginalTurnRetryRequests = 1;
      }
    }

    options.httpErrorPrompt = null;
    const timeoutPrompt = "CLASSIFY_HTTP_TIMEOUT";
    const timeoutRequestNumber = model.requests.length + 1;
    options.delayedRequestNumbers = [timeoutRequestNumber];
    await send(timeoutPrompt);
    const timeoutCard = page.locator('[data-testid="assistant-error-card"]:visible').last();
    await timeoutCard.waitFor({ state: "visible", timeout: 60000 });
    assert.match(await timeoutCard.innerText(), /请求超时/);
    await timeoutCard.getByTestId("assistant-error-retry").waitFor({ state: "visible" });
    const timeoutMessage = page.getByTestId("message-user").filter({ hasText: timeoutPrompt });
    await timeoutMessage.waitFor({ state: "visible", timeout: 30000 });
    assert.equal(await timeoutMessage.count(), 1, "the timed-out accepted message stays in history once");
    assert.equal(countRequestsContaining(timeoutPrompt), 1, "timeout must not trigger a provider replay");
    assert.equal(model.requestOutcomes[timeoutRequestNumber - 1]?.aborted, true, "the local provider must observe the timeout abort");
    await page.waitForTimeout(500);
    assert.equal(countRequestsContaining(timeoutPrompt), 1, "timeout remains unretried until the user chooses recovery");
    options.delayedRequestNumbers = [];
    await timeoutCard.getByTestId("assistant-error-retry").click();
    await page.getByText("HTTP_ERROR_RECOVERY_OK", { exact: true }).last().waitFor({ timeout: 60000 });
    assert.equal(countRequestsContaining(timeoutPrompt), 2, "one explicit retry follows the timed-out request");
    assert.equal(await timeoutMessage.count(), 1, "timeout retry must not duplicate the accepted user message");
    checks.push({
      status: "timeout",
      title: "请求超时",
      acceptedTranscriptMessages: 1,
      initialProviderRequests: 1,
      manualOriginalTurnRetryRequests: 1,
      providerObservedAbort: true,
    });

    await send("Recover after the fixture accepts the request.");
    await page.getByText("HTTP_ERROR_RECOVERY_OK", { exact: true }).waitFor({ timeout: 60000 });
    assert.equal(await page.locator('[data-testid="assistant-error-card"]:visible').count(), 0);
    await context.writeArtifactJson("checks.json", { checks, recovered: true, providerRequests: model.requests.length });
    return { classifiedCases: checks.length, recovered: true };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts("failure.png") }).catch(() => {});
    await context.writeArtifactJson("checks.json", {
      checks,
      providerRequestCount: model.requests.length,
      providerRequestOutcomes: model.requestOutcomes,
      statusResponses,
      workspaceScanWarnings,
      error: error.message,
    });
    throw error;
  } finally {
    await page.close();
  }
});
