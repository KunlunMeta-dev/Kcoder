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
    testId: "real-renderer-reconnect-and-background-job-terminal-state",
    tier: "pr-smoke",
    modelPolicy:
      "model-independent deterministic renderer connection lifecycle check",
    retainSuccessLogs: true,
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "renderer-reconnect",
    });
    const configDir = context.pathInState("config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "renderer-e2e": { type: "api", key: "deterministic-local-fixture" },
      "background-e2e": { type: "api", key: "deterministic-local-fixture" },
    });
    const model = await startApprovalModelFixture(context, {
      textOnly: true,
      delayedRequestNumber: 2,
      streamDelayMs: 30_000,
    });
    const settingsFile = await context.writeStateJson(
      "renderer-settings.json",
      {
        active_provider: "renderer-e2e",
        permission_mode: "ask",
        providers: {
          "renderer-e2e": {
            api_format: "openai_chat_completions",
            endpoint: model.baseUrl,
            default_model: "renderer-e2e-model",
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
    const gatewayOptions = {
      workspace,
      serversFile,
      env: { KCODER_CONFIG_DIR: configDir },
    };

    const seedGateway = await startGateway(context, {
      ...gatewayOptions,
      label: "renderer-seed-gateway",
    });
    const [busyThreadId] = await seedThreads(context, seedGateway, 1);
    await context.stopOwned("renderer-seed-gateway");

    const chromium = await startChromium(context, {
      label: "renderer-reconnect-chromium",
    });

    const busyGateway = await startGateway(context, {
      ...gatewayOptions,
      label: "renderer-busy-gateway",
    });
    const busyPage = await newTrackedPage(chromium);
    await openSeededTask(busyPage, busyGateway.baseUrl, busyThreadId);
    await sendPrompt(busyPage, "活动轮中断测试");
    await waitForAssistantText(
      busyPage,
      "ACTIVE_STREAM_PARTIAL: 活动轮中断测试",
      30_000,
    );
    const busyClosedUrl = await closeTaskRuntimeSocket(busyPage);
    const busyReconnect = busyPage
      .getByTestId("runtime-reconnecting-status")
      .last();
    await busyReconnect.waitFor({ state: "visible", timeout: 15_000 });
    await busyPage.waitForFunction(
      () => document.body.innerText.includes("连接已断开，已停止当前任务"),
      undefined,
      {
        timeout: 15_000,
      },
    );
    // Send while recovery is still active to cover the send/resume race; the runtime should await the same recovery promise.
    const nextTurnSend = sendPrompt(busyPage, "重连后继续下一轮");
    await assertReconnectCompleted(busyReconnect);
    await nextTurnSend;
    try {
      await waitForAssistantText(
        busyPage,
        "deterministic renderer response: 重连后继续下一轮",
        30_000,
      );
    } catch {
      const diagnostic = await browserDiagnostic(busyPage);
      await context.writeArtifactJson(
        "renderer-next-turn-diagnostic.json",
        diagnostic,
      );
      await busyPage.screenshot({
        path: context.pathInArtifacts("renderer-next-turn-failure.png"),
        fullPage: true,
      });
      throw new Error(
        `renderer did not finish next turn after reconnect: ${JSON.stringify(diagnostic)}`,
      );
    }
    await captureCase(
      busyPage,
      context,
      "active-turn",
      "reconnected-next-turn.png",
    );
    await busyPage.close();
    await context.stopOwned("renderer-busy-gateway");

    const backgroundModel = await startApprovalModelFixture(context, {
      backgroundJob: true,
      backgroundDelayMs: 10_000,
    });
    const { path: backgroundWorkspace } = await materializeWorkspace(
      context,
      "minimal",
      {
        instanceId: "renderer-background-reconnect",
      },
    );
    const backgroundConfigDir = context.pathInState("background-config");
    await mkdir(backgroundConfigDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("background-config/settings.json", {});
    await context.writeStateJson("background-config/credentials.json", {
      "background-e2e": { type: "api", key: "deterministic-local-fixture" },
    });
    const backgroundSettingsFile = await context.writeStateJson(
      "background-settings.json",
      {
        active_provider: "background-e2e",
        permission_mode: "yolo",
        providers: {
          "background-e2e": {
            api_format: "openai_chat_completions",
            endpoint: backgroundModel.baseUrl,
            default_model: "background-e2e-model",
            context_window_tokens: 128_000,
            output_headroom_tokens: 8_192,
            max_output_tokens: 8_192,
            request_timeout_secs: 60,
            no_proxy: true,
            extra_body: {},
          },
        },
      },
    );
    const backgroundServersFile = await context.writeStateJson(
      "background-servers.json",
      [
        {
          id: "local",
          label: "Local",
          transport: "local",
          command: resolve(repoRoot, "target/debug/kcoder"),
          workspace: backgroundWorkspace,
          settingsFile: backgroundSettingsFile,
        },
      ],
    );
    const backgroundGateway = await startGateway(context, {
      workspace: backgroundWorkspace,
      serversFile: backgroundServersFile,
      label: "renderer-background-gateway",
      env: { KCODER_CONFIG_DIR: backgroundConfigDir },
    });
    const backgroundPage = await newTrackedPage(chromium);
    await openNewTask(backgroundPage, backgroundGateway.baseUrl);
    await sendPrompt(backgroundPage, "启动后台 subagent 后验证断线终态");
    // Once the provider receives the child request and keeps SSE open, the background agent is genuinely running; no post-tool display text is required.
    await waitFor(
      () =>
        backgroundModel.requests.some((request) =>
          JSON.stringify(request.messages ?? []).includes(
            "BACKGROUND_CHILD_E2E",
          ),
        ),
      20_000,
      "background child provider request",
    );
    try {
      await backgroundPage.waitForFunction(
        () =>
          [
            ...document.querySelectorAll('[data-testid="subagent-tool-block"]'),
          ].some(
            (block) =>
              block.getAttribute("data-subagent-lifecycle") === "running",
          ),
        undefined,
        { timeout: 20_000 },
      );
    } catch {
      const diagnostic = await browserDiagnostic(backgroundPage);
      await context.writeArtifactJson(
        "background-job-running-diagnostic.json",
        diagnostic,
      );
      await backgroundPage.screenshot({
        path: context.pathInArtifacts("background-job-running-failure.png"),
        fullPage: true,
      });
      throw new Error(
        `active background child was not projected as running: ${JSON.stringify(diagnostic)}`,
      );
    }
    assert.ok(
      backgroundModel.activeBackgroundRequests > 0,
      "background child provider stream closed before disconnect",
    );
    const backgroundClosedUrl = await closeTaskRuntimeSocket(backgroundPage);
    const backgroundReconnect = await revealReconnectMarker(
      backgroundPage,
      20_000,
    );
    await assertReconnectCompleted(backgroundReconnect);
    await waitForTaskRuntimeSocketReopened(
      backgroundPage,
      backgroundClosedUrl,
      20_000,
    );
    const reconnectedSubagent = await revealSubagentLifecycle(
      backgroundPage,
      "BACKGROUND_CHILD_E2E: inspect the fixture and return a short report",
      /^running$/,
      5_000,
    );
    assert.equal(
      await reconnectedSubagent.getAttribute("data-subagent-lifecycle"),
      "running",
    );
    let terminalSubagent;
    try {
      terminalSubagent = await revealSubagentLifecycle(
        backgroundPage,
        "BACKGROUND_CHILD_E2E: inspect the fixture and return a short report",
        /^completed$/,
        30_000,
      );
    } catch {
      const diagnostic = await browserDiagnostic(backgroundPage);
      await context.writeArtifactJson(
        "background-job-terminal-diagnostic.json",
        diagnostic,
      );
      await backgroundPage.screenshot({
        path: context.pathInArtifacts("background-job-terminal-failure.png"),
        fullPage: true,
      });
      throw new Error(
        `background job did not publish its authoritative completion after reconnect: ${JSON.stringify(diagnostic)}`,
      );
    }
    assert.equal(
      await terminalSubagent.getAttribute("data-subagent-lifecycle"),
      "completed",
    );
    await captureCase(
      backgroundPage,
      context,
      "background-job",
      "background-completed.png",
    );

    return {
      chromiumCdpPort: chromium.cdpPort,
      idleTask: {
        closedSocketPath: new URL(busyClosedUrl).pathname,
        reconnected: true,
        nextTurnCompleted: true,
      },
      backgroundJob: {
        closedSocketPath: new URL(backgroundClosedUrl).pathname,
        preservedAcrossReconnect: true,
        terminalState: "completed",
      },
    };
  },
);

async function seedThreads(context, gateway, count) {
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
  await initializeRpc(rpc, "kcoder-e2e-renderer-reconnect-seeder");
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const started = await rpc.request("thread/start", {});
    const turn = await rpc.request("turn/start", {
      threadId: started.thread.id,
      input: [
        { type: "text", text: `初始化 renderer 重连测试线程 ${index + 1}` },
      ],
    });
    await rpc.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === turn.turn.id,
      30_000,
      `renderer seed turn ${index + 1}`,
    );
    await rpc.request("thread/metadata/update", {
      threadId: started.thread.id,
      title: `Renderer Reconnect E2E ${index + 1}`,
    });
    ids.push(started.thread.id);
  }
  rpc.close();
  await waitFor(
    () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
    5_000,
    "renderer seed RPC close",
  );
  return ids;
}

async function newTrackedPage(chromium) {
  const page = await chromium.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.addInitScript(() => {
    localStorage.setItem("wework:debug-runtime", "1");
    window.__KCODER_E2E_RUNTIME_DEBUG_LOGS__ = [];
    const nativeDebug = console.debug.bind(console);
    console.debug = (...args) => {
      window.__KCODER_E2E_RUNTIME_DEBUG_LOGS__.push(
        args
          .map((value) => {
            if (typeof value === "string") return value;
            try {
              return JSON.stringify(value);
            } catch {
              return String(value);
            }
          })
          .join(" "),
      );
      nativeDebug(...args);
    };
    const NativeWebSocket = window.WebSocket;
    const sockets = [];
    function TrackedWebSocket(...args) {
      const socket = new NativeWebSocket(...args);
      sockets.push(socket);
      return socket;
    }
    Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
    TrackedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = TrackedWebSocket;
    window.__KCODER_E2E_RUNTIME_SOCKETS__ = sockets;
  });
  return page;
}

async function openSeededTask(page, baseUrl, threadId) {
  const testId = `runtime-local-task-row-kcoder:local:${threadId}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await page.goto(`${baseUrl}/?e2e=1`, {
      waitUntil: "domcontentloaded",
    });
    if (response?.status() !== 200) continue;
    const task = page.getByTestId(testId);
    try {
      await task.waitFor({ state: "visible", timeout: 5_000 });
      await task.evaluate((node) => node.click());
      await page
        .getByTestId("chat-message-input")
        .waitFor({ state: "visible", timeout: 10_000 });
      return;
    } catch {
      // Reload the same dynamic gateway before cold-start thread enumeration completes.
    }
  }
  throw new Error(`seeded renderer task ${threadId} did not appear`);
}

async function openNewTask(page, baseUrl) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await page.goto(`${baseUrl}/?e2e=1`, {
      waitUntil: "domcontentloaded",
    });
    if (response?.status() !== 200) continue;
    try {
      const button = page.getByTestId("project-new-conversation-button");
      await button.waitFor({ state: "visible", timeout: 5_000 });
      await button.click();
      await page
        .getByTestId("chat-message-input")
        .waitFor({ state: "visible", timeout: 10_000 });
      return;
    } catch {
      // Reload the same dynamic gateway during app-server cold start.
    }
  }
  throw new Error("renderer new task entry did not become ready");
}

async function sendPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input");
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
  await page.waitForFunction(
    () => {
      const button = document.querySelector(
        '[data-testid="send-message-button"]',
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.getByTestId("send-message-button").click();
}

async function waitForAssistantText(page, expected, timeoutMs) {
  await page.waitForFunction(
    (value) => {
      const messages = [
        ...document.querySelectorAll('[data-testid="message-assistant"]'),
      ];
      return messages.at(-1)?.textContent?.includes(value);
    },
    expected,
    { timeout: timeoutMs },
  );
}

async function closeTaskRuntimeSocket(page) {
  return page.evaluate(() => {
    const sockets = window.__KCODER_E2E_RUNTIME_SOCKETS__ ?? [];
    const candidates = sockets.filter((socket) => {
      const url = new URL(socket.url);
      return (
        socket.readyState === WebSocket.OPEN &&
        url.pathname === "/rpc" &&
        url.searchParams.has("workspace") &&
        url.searchParams.get("channel") !== "browser"
      );
    });
    const target = candidates.at(-1);
    if (!target)
      throw new Error(
        `未找到任务 runtime WebSocket；已观察 ${sockets.length} 个 socket`,
      );
    const url = target.url;
    // One workspace may contain task, transcript, and short-lived clients simultaneously.
    // Save object identities and close all of them; accept only when every old socket is
    // CLOSED and a socket outside that set appears, avoiding at(-1) selection of a transient client.
    window.__KCODER_E2E_CLOSED_RUNTIME_SOCKETS__ = candidates;
    for (const socket of candidates)
      socket.close(4001, "KCoder E2E workspace renderer disconnect");
    return url;
  });
}

async function waitForTaskRuntimeSocketReopened(page, closedUrl, timeoutMs) {
  await page.waitForFunction(
    (url) => {
      const closed = window.__KCODER_E2E_CLOSED_RUNTIME_SOCKETS__ ?? [];
      const sockets = window.__KCODER_E2E_RUNTIME_SOCKETS__ ?? [];
      const workspace = new URL(url).searchParams.get("workspace");
      return (
        closed.length > 0 &&
        closed.every((socket) => socket.readyState === WebSocket.CLOSED) &&
        sockets.some(
          (socket) =>
            !closed.includes(socket) &&
            socket.readyState === WebSocket.OPEN &&
            new URL(socket.url).searchParams.get("workspace") === workspace,
        )
      );
    },
    closedUrl,
    { timeout: timeoutMs },
  );
}

async function assertReconnectCompleted(locator) {
  const deadline = Date.now() + 20_000;
  let observed;
  while (Date.now() < deadline) {
    await revealReconnectMarker(
      locator.page(),
      Math.max(1, deadline - Date.now()),
    );
    // Completion can move the marker into a newly collapsed final group.
    // Read one DOM snapshot without waiting on a locator that may be unmounted.
    observed = await locator.evaluateAll((nodes) => {
      const marker = nodes.at(-1);
      const message = marker?.closest('[data-testid="message-assistant"]');
      return {
        text: marker?.textContent ?? "",
        role: marker?.getAttribute("role"),
        settled:
          message != null &&
          !message.querySelector(
            '[data-testid="tool-block-waiting"], [data-testid="thinking-indicator"]',
          ),
      };
    });
    if (observed.text.includes("连接已恢复") && observed.settled) break;
    await locator.page().waitForTimeout(50);
  }
  assert.match(observed?.text ?? "", /连接已恢复/);
  assert.equal(observed?.role, "status");
  assert.equal(
    observed?.settled,
    true,
    "reconnect message must stop its waiting indicators",
  );
}

async function revealSubagentLifecycle(
  page,
  title,
  lifecyclePattern,
  timeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const toggleId of [
      "final-processing-toggle",
      "processing-summary-toggle",
      "processing-activity-group-toggle",
    ]) {
      const toggles = page.getByTestId(toggleId);
      for (let index = 0; index < (await toggles.count()); index += 1) {
        const toggle = toggles.nth(index);
        if ((await toggle.getAttribute("aria-expanded")) === "false")
          await toggle.click();
      }
    }
    const blocks = page
      .getByTestId("subagent-tool-block")
      .filter({ hasText: title });
    for (let index = 0; index < (await blocks.count()); index += 1) {
      const block = blocks.nth(index);
      if (
        lifecyclePattern.test(
          (await block.getAttribute("data-subagent-lifecycle")) ?? "",
        )
      )
        return block;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(
    `subagent lifecycle ${lifecyclePattern} did not appear after expanding processing groups`,
  );
}

async function revealReconnectMarker(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const marker = page.getByTestId("runtime-reconnecting-status").last();
    if (await marker.count()) return marker;
    for (const toggleId of [
      "final-processing-toggle",
      "processing-summary-toggle",
      "processing-activity-group-toggle",
    ]) {
      const toggles = page.getByTestId(toggleId);
      for (let index = 0; index < (await toggles.count()); index += 1) {
        const toggle = toggles.nth(index);
        if ((await toggle.getAttribute("aria-expanded")) === "false")
          await toggle.click();
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error(
    "runtime reconnect marker did not appear after workspace socket disconnect",
  );
}

async function captureCase(page, context, slug, filename) {
  const screenshot = context.pathInCase("system-chromium", slug, filename);
  await mkdir(resolve(screenshot, ".."), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
}

async function browserDiagnostic(page) {
  return page.evaluate(() => ({
    body: document.body.innerText.slice(0, 10_000),
    composer: document.querySelector('[data-testid="chat-message-input"]')
      ?.outerHTML,
    send: document.querySelector('[data-testid="send-message-button"]')
      ?.outerHTML,
    reconnect: [
      ...document.querySelectorAll(
        '[data-testid="runtime-reconnecting-status"]',
      ),
    ].map((node) => node.textContent),
    subagents: [
      ...document.querySelectorAll('[data-testid="subagent-tool-block"]'),
    ].map((node) => ({
      id: node.getAttribute("data-processing-block-id"),
      lifecycle: node.getAttribute("data-subagent-lifecycle"),
      text: node.textContent,
    })),
    runtimeDebugLogs: window.__KCODER_E2E_RUNTIME_DEBUG_LOGS__ ?? [],
    sockets: (window.__KCODER_E2E_RUNTIME_SOCKETS__ ?? []).map((socket) => ({
      url: socket.url,
      readyState: socket.readyState,
    })),
  }));
}
