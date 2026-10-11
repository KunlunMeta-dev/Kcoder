import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

await runE2E(
  import.meta.url,
  {
    testId:
      "mobile-web-real-approval-four-decisions-session-isolation-disconnect",
    tier: "full-integration",
    modelPolicy: "model-independent deterministic provider approval lifecycle",
    retainSuccessLogs: true,
  },
  async (context) => {
    const configuredBackendBefore = await hashExecutableFile(kcoderBinary);
    const mobileWeb = await exportMobileWeb(context, {
      label: "mobile-approval-lifecycle-export",
      outputName: "mobile-web-export",
      dependencyRoot: resolve(repoRoot, "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules"),
    });
    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    const marker = context.pathInState("approval-command-ran.txt");
    const draftFile = resolve(workspace, "approval-draft.txt");
    await mkdir(workspace, { recursive: true });
    await writeFile(draftFile, "ORIGINAL\n");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const model = await startApprovalModelFixture(context, {
      approvalCommand: `printf 'RAN\n' > '${marker}'`,
      sessionApprovalPrompt: "MOBILE_APPROVAL_SESSION",
      sessionApprovalCommands: [
        `printf 'SESSION_RAN_FIRST\n' >> '${marker}'`,
        `printf 'SESSION_RAN_SECOND\n' >> '${marker}'`,
      ],
      sessionApprovalCount: 2,
    });
    const settingsFile = await context.writeStateJson(
      "approval-settings.json",
      {
        active_provider: "approval-mobile",
        permission_mode: "ask",
        providers: {
          "approval-mobile": {
            api_format: "openai_chat_completions",
            endpoint: model.baseUrl,
            default_model: "approval-e2e-model",
            context_window_tokens: 128000,
            output_headroom_tokens: 8192,
            max_output_tokens: 8192,
            request_timeout_secs: 30,
            no_proxy: true,
            extra_body: {},
          },
        },
      },
    );
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "approval-mobile": { type: "api", key: "deterministic-local-fixture" },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Local",
        transport: "local",
        command: kcoderBinary,
        workspace,
        settingsFile,
      },
    ]);
    const gatewayOptions = {
      auth: true,
      workspace,
      serversFile,
      kcoderBin: kcoderBinary,
      env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileWeb.path },
    };
    const gateway = await startGateway(context, {
      ...gatewayOptions,
      label: "mobile-approval-gateway",
    });
    const chromium = await startChromium(context, {
      label: "mobile-approval-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = [];
    const diagnosticEvents = [];
    const rpcRequests = [];
    const rpcResponses = [];
    const serverInteractions = [];
    const interactionReplies = [];
    let diagnosticPhase = "approval-flow";
    page.on("pageerror", (error) => {
      const message = `pageerror: ${error.message}`;
      diagnostics.push(message);
      diagnosticEvents.push({ phase: diagnosticPhase, message });
    });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        const text = `${message.type()}: ${message.text()}`;
        diagnostics.push(text);
        diagnosticEvents.push({ phase: diagnosticPhase, message: text });
      }
    });
    page.on("websocket", (socket) => {
      const methodsById = new Map();
      const serverMethodsById = new Map();
      socket.on("framesent", (event) => {
        try {
          const value = JSON.parse(String(event.payload));
          if (value?.method) {
            rpcRequests.push({
              id: value.id ?? null,
              method: value.method,
              params: value.params ?? null,
            });
            if (value.id !== undefined) methodsById.set(value.id, value.method);
          } else if (
            value?.id !== undefined &&
            serverMethodsById.has(value.id)
          ) {
            interactionReplies.push({
              id: value.id,
              method: serverMethodsById.get(value.id),
              result: value.result ?? null,
              error: value.error ?? null,
            });
          }
        } catch {}
      });
      socket.on("framereceived", (event) => {
        try {
          const value = JSON.parse(String(event.payload));
          if (typeof value?.method === "string") {
            serverInteractions.push({
              id: value.id ?? null,
              method: value.method,
              params: value.params ?? null,
            });
            if (value.id !== undefined)
              serverMethodsById.set(value.id, value.method);
          }
          if (value?.id === undefined || !methodsById.has(value.id)) return;
          rpcResponses.push({
            id: value.id,
            method: methodsById.get(value.id),
            result: value.result ?? null,
            error: value.error ?? null,
          });
        } catch {}
      });
    });
    await connect(page, gateway);

    await createApprovalTask(page, "MOBILE_APPROVAL_ACCEPT");
    assert.match(
      await page.getByTestId("approval-card").innerText(),
      /printf.*approval-command-ran\.txt/s,
    );
    assert.equal(await page.getByTestId("approval-accept").isDisabled(), false);
    await page.getByTestId("approval-accept").click();
    await page
      .getByTestId("approval-card")
      .waitFor({ state: "hidden", timeout: 30_000 });
    await access(marker);

    await rm(marker);
    await returnHome(page);
    await createApprovalTask(page, "MOBILE_APPROVAL_SESSION");
    await page.getByTestId("approval-accept-session").click();
    await page
      .getByTestId("approval-card")
      .waitFor({ state: "hidden", timeout: 30_000 });
    await page
      .getByText("会话级批准验证完成。", { exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await readFile(marker, "utf8"),
      "SESSION_RAN_FIRST\nSESSION_RAN_SECOND\n",
      "会话级批准后同一 thread 的第二个同工具但不同参数命令不应再次弹出审批",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const persistedSessionApproval = page
      .getByTestId("message-assistant")
      .filter({ hasText: "会话级批准验证完成。" })
      .last();
    await persistedSessionApproval.waitFor({
      state: "visible",
      timeout: 30_000,
    });
    try {
      await persistedSessionApproval
        .locator('[data-testid^="interaction-summary-"]')
        .filter({ hasText: "Always allow for this session" })
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      const visibleSummaries = await page
        .locator('[data-testid^="interaction-summary-"]')
        .allInnerTexts()
        .catch(() => []);
      const visibleUserMessages = await page
        .getByTestId("message-user")
        .allInnerTexts()
        .catch(() => []);
      const visibleAssistantMessages = await page
        .getByTestId("message-assistant")
        .allInnerTexts()
        .catch(() => []);
      await context.writeArtifactJson("approval-summary-reload-failure.json", {
        route: new URL(page.url()).pathname,
        taskId: new URL(page.url()).pathname.split("/").at(-1),
        body: (await page.locator("body").innerText().catch(() => "")).slice(0, 12_000),
        visibleSummaries,
        visibleUserMessages,
        visibleAssistantMessages,
        providerMessageTrace: model.requests.map((request, requestIndex) => ({
          requestIndex,
          messages: (request.messages ?? [])
            .filter((message) =>
              message?.role === "tool" ||
              (message?.role === "user" &&
                /MOBILE_APPROVAL_SESSION/.test(String(message.content))),
            )
            .map((message) => ({
              role: message.role,
              name: message.name ?? null,
              content: String(message.content ?? "").slice(0, 2_000),
              toolCalls: (message.tool_calls ?? []).map((call) => ({
                name: call.function?.name ?? null,
                arguments: call.function?.arguments ?? null,
              })),
            })),
        })),
        rpcRequests: rpcRequests.filter((request) =>
          [
            "thread/start",
            "thread/read/indexed",
            "thread/resume",
            "turn/start",
            "approval/respond",
            "approval/response",
          ].includes(request.method),
        ),
        rpcResponses: rpcResponses.filter((response) =>
          [
            "thread/start",
            "thread/read/indexed",
            "thread/resume",
            "turn/start",
            "approval/respond",
            "approval/response",
          ].includes(response.method),
        ),
        marker: await readFile(marker, "utf8").catch(() => null),
        diagnostics,
        timeout: String(error),
      });
      await page
        .screenshot({
          path: context.pathInArtifacts("approval-summary-reload-failure.png"),
          fullPage: true,
        })
        .catch(() => undefined);
      throw error;
    }

    await rm(marker);
    await returnHome(page);
    await createApprovalTask(page, "MOBILE_APPROVAL_CANCEL");
    const requestsBeforeCancel = model.requests.length;
    await page.getByTestId("approval-cancel").click();
    await page
      .getByTestId("approval-card")
      .waitFor({ state: "hidden", timeout: 30_000 });
    await waitFor(page, () => model.requests.length > requestsBeforeCancel);
    await assert.rejects(access(marker), "Cancel request后命令仍被执行");
    assert.match(
      toolResultText(model.requests.slice(requestsBeforeCancel)),
      /cancel|denied|取消|未批准/i,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const cancelledMessage = page.getByTestId("message-assistant").last();
    await cancelledMessage.waitFor({ state: "visible", timeout: 30_000 });
    await cancelledMessage
      .locator('[data-testid^="interaction-summary-"]')
      .filter({ hasText: "Cancelled" })
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });

    await returnHome(page);
    await createApprovalTask(page, "MOBILE_APPROVAL_DECLINE");
    const requestsBeforeDecline = model.requests.length;
    await page.getByTestId("approval-decline").click();
    await page
      .getByTestId("approval-card")
      .waitFor({ state: "hidden", timeout: 30_000 });
    await waitFor(page, () => model.requests.length > requestsBeforeDecline);
    await assert.rejects(access(marker), "拒绝后命令仍被执行");
    assert.match(
      toolResultText(model.requests.slice(requestsBeforeDecline)),
      /declin|denied|拒绝|未批准/i,
    );

    await returnHome(page);
    await createApprovalTask(page, "MOBILE_APPROVAL_DISCONNECT");
    const requestsBeforeDisconnect = model.requests.length;
    await openFile(page, "approval-draft.txt");
    const dirtyDraft = "DIRTY_DURING_PENDING_APPROVAL\n";
    await page.getByTestId("file-editor").fill(dirtyDraft);
    await page.waitForTimeout(600);
    assert.equal(
      await readFile(draftFile, "utf8"),
      "ORIGINAL\n",
      "dirty draft 不能在用户保存前覆盖磁盘",
    );
    const taskUrlBeforePendingReload = page.url();
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(
      page.url(),
      taskUrlBeforePendingReload,
      "审批待决且文件 dirty 时刷新不能离开当前任务 URL",
    );
    await page
      .locator('[data-testid="files-panel"]:visible')
      .waitFor({ state: "visible", timeout: 30_000 });
    const recoveredEditor = page.locator('[data-testid="file-editor"]:visible');
    await recoveredEditor.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await recoveredEditor.inputValue(),
      dirtyDraft,
      "审批连接 fail-close 后必须保留独立的文件草稿",
    );
    const externalVersion = "EXTERNAL_DURING_PENDING_APPROVAL_RELOAD\n";
    await writeFile(draftFile, externalVersion);
    await page
      .locator('[data-testid="files-panel"]:visible')
      .getByLabel("保存", { exact: true })
      .click();
    await page
      .locator('[data-testid="file-conflict-banner"]:visible')
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await readFile(draftFile, "utf8"),
      externalVersion,
      "审批 fail-close 后恢复的旧草稿不能静默覆盖外部修改",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-testid="file-conflict-reload"]:visible').click();
    await page
      .locator('[data-testid="file-conflict-banner"]:visible')
      .waitFor({ state: "hidden", timeout: 30_000 });
    assert.equal(await recoveredEditor.inputValue(), externalVersion);
    const savedAfterConflict = `${externalVersion}SAVED_AFTER_CONFLICT\n`;
    await recoveredEditor.fill(savedAfterConflict);
    await page
      .locator('[data-testid="files-panel"]:visible')
      .getByLabel("保存", { exact: true })
      .click();
    await waitFor(
      page,
      async () => (await readFile(draftFile, "utf8")) === savedAfterConflict,
    );
    assert.equal(await readFile(draftFile, "utf8"), savedAfterConflict);
    await selectPanel(page, "agent");
    await page
      .locator('[data-testid="message-input-root"]:visible')
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .locator('[data-testid="approval-card"]:visible')
      .waitFor({ state: "hidden", timeout: 30_000 });
    await assert.rejects(access(marker), "审批连接断开后命令仍被执行");

    await returnHome(page);
    await createApprovalTask(page, "MOBILE_APPROVAL_REAL_GATEWAY_RESTART");
    await openFile(page, "approval-draft.txt");
    const realDisconnectDraft = "DIRTY_DURING_REAL_GATEWAY_RESTART\n";
    await page
      .locator('[data-testid="file-editor"]:visible')
      .fill(realDisconnectDraft);
    await page.waitForTimeout(600);
    const realDisconnectTaskUrl = page.url();
    const realDisconnectThreadId = new URL(realDisconnectTaskUrl).pathname
      .split("/")
      .at(-1);
    diagnosticPhase = "gateway-disconnected";
    const initialBackendProcesses = await findOwnedExecutableProcesses({
      pgid: gateway.child.pid,
      executablePath: configuredBackendBefore.path,
    });
    await context.stopOwned("mobile-approval-gateway");
    await selectPanel(page, "agent");
    await page
      .getByText("连接已断开，正在自动重连；恢复后会同步服务器上的最新状态。", {
        exact: true,
      })
      .waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(
      await page.locator('[data-testid="approval-card"]:visible').count(),
      0,
      "真实断线必须立即 fail-close 待决审批",
    );
    const restarted = await startGateway(context, {
      ...gatewayOptions,
      authToken: gateway.authToken,
      port: gateway.port,
      label: "mobile-approval-gateway-after",
    });
    assert.equal(restarted.baseUrl, gateway.baseUrl);
    await page
      .getByText("Gateway 会话已失效，请前往设置重新连接", { exact: true })
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.getByLabel("打开任务列表").click();
    await page.getByTestId("mobile-drawer").getByLabel("设置").click();
    const profileId = decodeURIComponent(
      realDisconnectTaskUrl.match(/\/h\/([^/]+)\/task\//)?.[1] ?? "",
    );
    await page.getByTestId(`reauthorize-profile-${profileId}`).click();
    await page.getByTestId("gateway-token").fill(gateway.authToken);
    diagnosticPhase = "reauthorizing";
    await page.getByTestId("gateway-connect").click();
    const restoredThread = page.locator(
      `[data-testid="thread-${realDisconnectThreadId}"]:visible`,
    );
    await restoredThread.waitFor({ state: "visible", timeout: 30_000 });
    await restoredThread.click();
    await selectPanel(page, "files-1");
    await page
      .locator('[data-testid="file-editor"]:visible')
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page.locator('[data-testid="file-editor"]:visible').inputValue(),
      realDisconnectDraft,
      "真实 Gateway/app-server 重启并重新授权后必须恢复文件草稿",
    );
    await selectPanel(page, "agent");
    assert.equal(
      await page.locator('[data-testid="approval-card"]:visible').count(),
      0,
      "重新授权后失效审批不得复活",
    );

    const unexpectedDiagnostics = diagnosticEvents.filter(({ phase, message }) => {
      if (/^error: WebSocket connection to '.+' failed: /.test(message))
        return false;
      if (
        phase === "gateway-disconnected" &&
        /error: Failed to load resource: net::ERR_CONNECTION_REFUSED$/.test(
          message,
        )
      )
        return false;
      if (
        ["gateway-disconnected", "reauthorizing"].includes(phase) &&
        /error: Failed to load resource: the server responded with a status of 401 \(Unauthorized\)$/.test(
          message,
        )
      )
        return false;
      return true;
    });
    const restartedBackendProcesses = await findOwnedExecutableProcesses({
      pgid: restarted.child.pid,
      executablePath: configuredBackendBefore.path,
    });
    const configuredBackendAfter = await hashExecutableFile(kcoderBinary);
    const backendBinaryUnchanged = JSON.stringify(configuredBackendAfter) === JSON.stringify(configuredBackendBefore);
    const backendProcessProvenance = {
      configuredBefore: configuredBackendBefore,
      configuredAfter: configuredBackendAfter,
      unchanged: backendBinaryUnchanged,
      gatewayProcessGroups: [
        {
          id: gateway.child.pid,
          status: initialBackendProcesses.some(item => item.sha256 === configuredBackendBefore.sha256) ? "verified" : "unverified",
          ownedProcesses: initialBackendProcesses,
        },
        {
          id: restarted.child.pid,
          status: restartedBackendProcesses.some(item => item.sha256 === configuredBackendBefore.sha256) ? "verified" : "unverified",
          ownedProcesses: restartedBackendProcesses,
        },
      ],
    };
    await context.writeArtifactJson("mobile-backend-binary-provenance.json", backendProcessProvenance);
    assert.equal(backendBinaryUnchanged, true, "configured KCoder backend binary changed during this run");
    await context.writeArtifactJson("approval-lifecycle-evidence.json", {
      mobileWebExport: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        bundleManifestPath: mobileWeb.bundleManifestPath,
      },
      backendBinary: backendProcessProvenance,
      providerRequestCount: model.requests.length,
      providerRequestsAfterDisconnect:
        model.requests.length - requestsBeforeDisconnect,
      accepted: true,
      acceptedForSessionWithoutSecondPrompt: true,
      cancelledFailClosed: true,
      declinedFailClosed: true,
      disconnectFailClosed: true,
      staleApprovalCardCleared: true,
      dirtyDraftSurvivedPendingApprovalReload: true,
      externalConflictProtected: true,
      savedAfterConflict: true,
      taskUrlBeforePendingReload,
      realGatewayRestartFailClosedApproval: true,
      realGatewayRestartDraftRecovered: true,
      serverInteractions: serverInteractions.filter((message) =>
        ["approval/request", "approval/resolved"].includes(message.method),
      ),
      interactionReplies,
      rpcRequests: rpcRequests.filter((request) =>
        ["thread/start", "thread/resume", "thread/read/indexed", "turn/start"].includes(
          request.method,
        ),
      ),
      unexpectedDiagnostics,
      diagnosticEvents,
      diagnostics,
    });
    await page
      .screenshot({
        path: context.pathInArtifacts("approval-lifecycle-final.png"),
        fullPage: true,
      })
      .catch(() => undefined);
    assert.deepEqual(unexpectedDiagnostics, []);
    await context.writeArtifactJson("mobile-real-approval-lifecycle.json", {
      mobileWebExport: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        bundleManifestPath: mobileWeb.bundleManifestPath,
      },
      backendBinary: backendProcessProvenance,
      providerRequestCount: model.requests.length,
      providerRequestsAfterDisconnect:
        model.requests.length - requestsBeforeDisconnect,
      accepted: true,
      acceptedForSessionWithoutSecondPrompt: true,
      cancelledFailClosed: true,
      declinedFailClosed: true,
      disconnectFailClosed: true,
      staleApprovalCardCleared: true,
      dirtyDraftSurvivedPendingApprovalReload: true,
      externalConflictProtected: true,
      savedAfterConflict: true,
      taskUrlBeforePendingReload,
      realGatewayRestartFailClosedApproval: true,
      realGatewayRestartDraftRecovered: true,
      unexpectedDiagnostics,
      diagnostics,
    });
    return {
      mobileWebExport: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleFileCount: mobileWeb.bundleFileCount,
        bundleManifestPath: mobileWeb.bundleManifestPath,
      },
      backendBinary: backendProcessProvenance,
      realProviderProtocol: true,
      acceptExecuted: true,
      acceptForSessionExecutedSecondWithoutPrompt: true,
      cancelFailClosed: true,
      declineFailClosed: true,
      disconnectFailClosed: true,
      dirtyDraftSurvivedPendingApprovalReload: true,
      externalConflictProtected: true,
      realGatewayRestartDraftRecovered: true,
    };
  },
);

async function waitFor(page, condition) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > 60_000)
      throw new Error("等待审批生命周期事件超时");
    await page.waitForTimeout(100);
  }
}

function toolResultText(requests) {
  return JSON.stringify(
    requests
      .flatMap((request) => request.messages ?? [])
      .filter((message) => message?.role === "tool"),
  );
}

async function returnHome(page) {
  await page.getByLabel("返回", { exact: true }).click();
  await page
    .getByTestId("new-workspace")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function createApprovalTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page
    .getByTestId("workspace-path")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page
    .getByTestId("approval-card")
    .waitFor({ state: "visible", timeout: 60_000 });
}

async function selectPanel(page, id) {
  await page.locator('[data-testid="workspace-tab-switcher"]:visible').click();
  await page.locator(`[data-testid="workspace-tab-${id}"]:visible`).click();
}

async function openFile(page, name) {
  await selectPanel(page, "files-1");
  const files = page.locator('[data-testid="files-panel"]:visible');
  await files.getByLabel("搜索文件").click();
  await page.locator('[data-testid="file-search"]:visible').fill(name);
  await files
    .getByRole("button", { name: `文件 ${name}`, exact: true })
    .click();
  await page
    .locator('[data-testid="file-editor"]:visible')
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page
    .getByTestId("new-workspace")
    .waitFor({ state: "visible", timeout: 30_000 });
}
