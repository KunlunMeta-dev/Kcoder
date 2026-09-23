import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "real-browser-command-approval-round-trip",
    tier: "pr-smoke",
    modelPolicy:
      "model-independent deterministic provider protocol and approval UI check",
    retainSuccessLogs: true,
  },
  async (context) => {
    const model = await startApprovalModelFixture(context, {
      primeFirstRequest: true,
    });
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "approval-ui",
    });
    const configDir = context.pathInState("config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const settingsFile = await context.writeStateJson(
      "approval-settings.json",
      {
        active_provider: "approval-e2e",
        permission_mode: "ask",
        providers: {
          "approval-e2e": {
            api_format: "openai_chat_completions",
            endpoint: model.baseUrl,
            default_model: "approval-e2e-model",
            context_window_tokens: 128_000,
            output_headroom_tokens: 8_192,
            max_output_tokens: 8_192,
            request_timeout_secs: 30,
            no_proxy: true,
            extra_body: {},
          },
        },
      },
    );
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "approval-e2e": { type: "api", key: "deterministic-local-fixture" },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Local",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "approval-ui-gateway",
      workspace,
      serversFile,
      env: { KCODER_CONFIG_DIR: configDir },
    });
    const threadId = await seedCompletedThread(context, gateway);
    const chromium = await startChromium(context, {
      label: "approval-ui-chromium",
    });
    const page = await chromium.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await openSeededTask(page, gateway.baseUrl, threadId);
    await sendPrompt(page, "请运行命令输出 APPROVAL_E2E_ACCEPTED");

    const card = page.getByTestId("request-user-input-card");
    try {
      await card.waitFor({ state: "visible", timeout: 60_000 });
    } catch {
      const diagnostic = await page.evaluate(() => ({
        body: document.body.innerText.slice(0, 8_000),
        testIds: [...document.querySelectorAll("[data-testid]")]
          .map((node) => node.getAttribute("data-testid"))
          .filter(Boolean),
      }));
      await context.writeArtifactJson("approval-ui-diagnostic.json", {
        ...diagnostic,
        providerRequests: model.requests,
      });
      await page.screenshot({
        path: context.pathInArtifacts("approval-ui-failure.png"),
        fullPage: true,
      });
      throw new Error(
        `approval card did not render: ${JSON.stringify(diagnostic)}`,
      );
    }
    await card.getByText("Permission request", { exact: true }).waitFor();
    await card.getByText("Allow once", { exact: true }).click();
    // A single-question card submits immediately after selection; do not search for a submit button in the unmounted card.
    await card.waitFor({ state: "detached", timeout: 30_000 });
    await page.waitForFunction(
      () => document.body.innerText.includes("权限确认后的命令已执行。"),
      undefined,
      {
        timeout: 60_000,
      },
    );

    const requestsBeforeDecline = model.requests.length;
    await page.getByTestId("project-new-conversation-button").click();
    await sendPrompt(page, "请发起命令Permission request，本次将拒绝");
    const declineCard = page.getByTestId("request-user-input-card");
    await declineCard.waitFor({ state: "visible", timeout: 60_000 });
    await declineCard
      .getByText("Permission request", { exact: true })
      .waitFor();
    await declineCard.getByText("Decline", { exact: true }).click();
    await declineCard.waitFor({ state: "detached", timeout: 30_000 });
    await waitFor(
      () => model.requests.length >= requestsBeforeDecline + 2,
      30_000,
      "declined tool result reaches provider",
    );
    const declinedRequests = model.requests.slice(requestsBeforeDecline);
    const declinedToolResult = declinedRequests
      .flatMap((request) => request.messages ?? [])
      .find((message) => message?.role === "tool");
    assert.ok(
      declinedToolResult,
      "declined approval did not return a tool result to the provider",
    );
    assert.match(
      JSON.stringify(declinedToolResult),
      /declin|denied|拒绝|未批准/i,
    );

    const screenshot = context.pathInCase(
      "system-chromium",
      "approval",
      "approval-accepted.png",
    );
    await mkdir(resolve(screenshot, ".."), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.ok(
      model.requests.length >= 2,
      "provider did not receive the post-tool continuation request",
    );
    assert.ok(
      model.requests.some((request) =>
        request.messages?.some((message) => message?.role === "tool"),
      ),
      "provider did not receive a tool result after approval",
    );
    assert.deepEqual(
      browserErrors,
      [],
      `renderer emitted page errors: ${browserErrors.join("\n")}`,
    );
    return {
      approvalDecision: "accept",
      declineDecision: "decline",
      providerRequestCount: model.requests.length,
      commandResultReturnedToProvider: true,
      chromiumCdpPort: chromium.cdpPort,
      threadId,
    };
  },
);

async function seedCompletedThread(context, gateway) {
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
  await initializeRpc(rpc, "kcoder-e2e-approval-seeder");
  const started = await rpc.request("thread/start", {});
  const turn = await rpc.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: "初始化权限 UI 测试线程" }],
  });
  await rpc.waitFor(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.turnId === turn.turn.id,
    30_000,
    "approval seed turn",
  );
  await rpc.request("thread/metadata/update", {
    threadId: started.thread.id,
    title: "Approval UI E2E",
  });
  rpc.close();
  await waitFor(
    () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
    5_000,
    "approval seed RPC close",
  );
  return started.thread.id;
}

async function openSeededTask(page, baseUrl, threadId) {
  const taskId = `runtime-local-task-row-kcoder:local:${threadId}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await page.goto(`${baseUrl}/?e2e=1`, {
      waitUntil: "domcontentloaded",
    });
    if (response?.status() !== 200) {
      await page.waitForTimeout(250);
      continue;
    }
    const task = page.getByTestId(taskId);
    try {
      await task.waitFor({ state: "visible", timeout: 5_000 });
      await task.evaluate((node) => node.click());
      await page
        .getByTestId("chat-message-input")
        .waitFor({ state: "visible", timeout: 10_000 });
      return;
    } catch {
      // Reload and retry through the same dynamic gateway before app-server cold-start enumeration completes.
    }
  }
  throw new Error(`seeded approval task ${threadId} did not appear`);
}

async function sendPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="chat-message-input"]')
        ?.getAttribute("contenteditable") === "true",
    undefined,
    { timeout: 30_000 },
  );
  await page.keyboard.insertText(prompt);
  await page.waitForFunction(() => {
    const button = document.querySelector(
      '[data-testid="send-message-button"]',
    );
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await page.getByTestId("send-message-button").click();
}
