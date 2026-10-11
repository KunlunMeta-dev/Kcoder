import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(
  import.meta.url,
  {
    testId: "task-flow-mobile-drawer-route-transcript-rpc-identity",
    tier: "full-integration",
    modelPolicy:
      "model-independent deterministic provider; validates Mobile route identity, real Gateway/app-server thread routing, and visible transcript projection",
    retainSuccessLogs: true,
  },
  async (context) => {
    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    await mkdir(workspace, { recursive: true });
    await mkdir(configDir, { recursive: true, mode: 0o700 });

    const model = await startApprovalModelFixture(context, { textOnly: true });
    const settingsFile = await context.writeStateJson("route-settings.json", {
      active_provider: "task-flow-route",
      permission_mode: "yolo",
      providers: {
        "task-flow-route": {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          default_model: "task-flow-route-model",
          context_window_tokens: 128000,
          output_headroom_tokens: 2048,
          max_output_tokens: 2048,
          request_timeout_secs: 30,
          no_proxy: true,
          extra_body: {},
        },
      },
    });
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "task-flow-route": { type: "api", key: "task-flow-local-key" },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Local",
        transport: "local",
        command: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      auth: true,
      label: "task-flow-route-gateway",
      workspace,
      serversFile,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_WEB_ROOT: mobileDist,
      },
    });
    const chromium = await startChromium(context, {
      label: "task-flow-route-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    const diagnostics = [];
    const network = [];
    const rpc = { requests: [], responses: [], notifications: [] };
    const requestMethods = new Map();
    const markers = {
      alpha: "TASK_FLOW_ROUTE_ALPHA",
      bravo: "TASK_FLOW_ROUTE_BRAVO",
      alpha390: "TASK_FLOW_ROUTE_ALPHA_CONTINUE_390",
      bravo390: "TASK_FLOW_ROUTE_BRAVO_CONTINUE_390",
      alpha360: "TASK_FLOW_ROUTE_ALPHA_CONTINUE_360",
      bravo360: "TASK_FLOW_ROUTE_BRAVO_CONTINUE_360",
    };

    page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        diagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      network.push({ kind: "requestfailed", path: url.pathname, error: request.failure()?.errorText ?? null });
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/") || url.pathname === "/rpc") {
        network.push({ kind: "response", path: url.pathname, status: response.status() });
      }
    });
    page.on("websocket", (socket) => {
      socket.on("framesent", (event) => {
        try {
          const frame = JSON.parse(String(event.payload));
          if (!frame?.method) return;
          const summary = summarizeRequest(frame);
          rpc.requests.push(summary);
          if (frame.id !== undefined) requestMethods.set(frame.id, frame.method);
        } catch {}
      });
      socket.on("framereceived", (event) => {
        try {
          const frame = JSON.parse(String(event.payload));
          if (frame.method) {
            if (["turn/started", "turn/completed", "thread/updated"].includes(frame.method)) {
              rpc.notifications.push(summarizeNotification(frame));
            }
            return;
          }
          if (frame.id === undefined || !requestMethods.has(frame.id)) return;
          rpc.responses.push({
            method: requestMethods.get(frame.id),
            ok: frame.error === undefined,
            errorCode: frame.error?.code ?? null,
            resultThreadId: frame.result?.thread?.id ?? frame.result?.threadId ?? null,
            resultTurnId: frame.result?.turn?.id ?? frame.result?.turnId ?? null,
            resultStatus: frame.result?.thread?.status ?? frame.result?.turn?.status ?? null,
          });
        } catch {}
      });
    });

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await connect(page, gateway);
      await createTask(page, markers.alpha);
      const alphaId = routeThreadId(page.url());
      await returnHome(page);
      await createTask(page, markers.bravo);
      const bravoId = routeThreadId(page.url());
      assert.notEqual(alphaId, bravoId, "两个不同任务必须对应不同的 app-server thread");

      const routeSnapshots = [];
      await selectThreadFromDrawer(page, alphaId);
      routeSnapshots.push(await assertThreadProjection(page, alphaId, markers.alpha, [markers.bravo]));
      await sendAndCheckRoute(page, alphaId, markers.alpha390, rpc, model);
      routeSnapshots.push(await assertThreadProjection(page, alphaId, markers.alpha, [markers.bravo]));

      await selectThreadFromDrawer(page, bravoId);
      routeSnapshots.push(await assertThreadProjection(page, bravoId, markers.bravo, [markers.alpha, markers.alpha390]));
      await sendAndCheckRoute(page, bravoId, markers.bravo390, rpc, model);
      routeSnapshots.push(await assertThreadProjection(page, bravoId, markers.bravo, [markers.alpha, markers.alpha390]));

      await selectThreadFromDrawer(page, alphaId);
      routeSnapshots.push(await assertThreadProjection(page, alphaId, markers.alpha, [markers.bravo, markers.bravo390]));
      await sendAndCheckRoute(page, alphaId, markers.alpha360, rpc, model);
      routeSnapshots.push(await assertThreadProjection(page, alphaId, markers.alpha, [markers.bravo, markers.bravo390]));

      await page.setViewportSize({ width: 360, height: 800 });
      await selectThreadFromDrawer(page, bravoId);
      routeSnapshots.push(await assertThreadProjection(page, bravoId, markers.bravo, [markers.alpha, markers.alpha390, markers.alpha360]));
      await sendAndCheckRoute(page, bravoId, markers.bravo360, rpc, model);
      routeSnapshots.push(await assertThreadProjection(page, bravoId, markers.bravo, [markers.alpha, markers.alpha390, markers.alpha360]));
      await selectThreadFromDrawer(page, alphaId);
      routeSnapshots.push(await assertThreadProjection(page, alphaId, markers.alpha, [markers.bravo, markers.bravo390, markers.bravo360]));

      const continuationCalls = rpc.requests.filter((request) => request.method === "turn/start" && request.text?.includes("TASK_FLOW_ROUTE_") && request.text.includes("CONTINUE"));
      assert.equal(continuationCalls.length, 4, "四次续发必须各自到达 Mobile Gateway WebSocket");
      for (const [marker, expectedThreadId] of [
        [markers.alpha390, alphaId],
        [markers.bravo390, bravoId],
        [markers.alpha360, alphaId],
        [markers.bravo360, bravoId],
      ]) {
        const call = continuationCalls.find((request) => request.text.includes(marker));
        assert.equal(call?.threadId, expectedThreadId, `${marker} 的 turn/start 必须路由到 URL 当前 thread`);
      }
      assert.deepEqual(diagnostics, [], "浏览器不能产生 JS 或 console 错误");

      const result = {
        alphaId,
        bravoId,
        routeSnapshots,
        continuationCalls,
        providerPromptCount: model.requests.length,
        rpcMethods: rpc.requests.map(({ method }) => method),
        rpcNotifications: rpc.notifications,
        httpNetwork: network,
        diagnostics,
        viewportWidths: [390, 360],
        modelBehaviorClaimed: false,
      };
      await context.writeArtifactJson("task-flow-drawer-route-identity.json", result);
      return {
        separateThreads: true,
        drawerAtoBtoAAt390And360: true,
        visibleTranscriptMatchesRoute: true,
        turnStartThreadIdMatchesRoute: true,
        providerRequests: model.requests.length,
        viewportWidths: [390, 360],
      };
    } catch (error) {
      const diagnostic = {
        url: page.url(),
        visibleUserMessages: await page.getByTestId("message-user").allInnerTexts().catch(() => []),
        body: (await page.locator("body").innerText().catch(() => "")).slice(0, 12000),
        rpc,
        httpNetwork: network,
        diagnostics,
        providerPromptCount: model.requests.length,
        failure: String(error?.stack ?? error),
      };
      await context.writeArtifactJson("task-flow-drawer-route-failure.json", diagnostic).catch(() => {});
      await page.screenshot({ path: context.pathInArtifacts("task-flow-drawer-route-failure.png") }).catch(() => {});
      throw error;
    } finally {
      await page.close().catch(() => {});
    }
  },
);

function summarizeRequest(frame) {
  const request = { method: frame.method };
  if (["thread/read", "thread/resume", "turn/start", "turn/interrupt"].includes(frame.method)) {
    request.threadId = frame.params?.threadId ?? null;
  }
  if (frame.method === "turn/start") {
    request.turnId = frame.params?.turnId ?? null;
    request.text = extractText(frame.params?.input).slice(0, 300);
  }
  if (frame.method === "turn/interrupt") request.turnId = frame.params?.turnId ?? null;
  return request;
}

function summarizeNotification(frame) {
  const params = frame.params ?? {};
  return {
    method: frame.method,
    threadId: params.threadId ?? null,
    turnId: params.turnId ?? params.turn?.id ?? null,
    status: params.turn?.status ?? params.status ?? null,
  };
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).join(" ");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  return Object.values(value).map(extractText).join(" ");
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

async function createTask(page, prompt) {
  await page.locator('[data-testid="new-workspace"]:visible').first().click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
}

async function returnHome(page) {
  await page.getByLabel("打开任务列表").click();
  await page.getByTestId("mobile-drawer").getByLabel("主页").click();
  await page.locator('[data-testid="new-workspace"]:visible').first().waitFor({ state: "visible", timeout: 30_000 });
}

async function selectThreadFromDrawer(page, threadId) {
  await page.getByLabel("打开任务列表").click();
  const drawer = page.getByTestId("mobile-drawer");
  await drawer.waitFor({ state: "visible", timeout: 30_000 });
  await drawer.getByTestId(`drawer-thread-${threadId}`).waitFor({ state: "visible", timeout: 30_000 });
  await drawer.getByTestId(`drawer-thread-${threadId}`).click();
  await waitFor(page, () => routeThreadId(page.url()) === threadId, 30_000, `URL route for thread ${threadId}`);
  await drawer.waitFor({ state: "hidden", timeout: 30_000 });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
}

async function assertThreadProjection(page, threadId, expectedMarker, forbiddenMarkers) {
  const urlThreadId = routeThreadId(page.url());
  assert.equal(urlThreadId, threadId, "route URL must identify the selected app-server thread");
  const expected = markerMessage(page, expectedMarker);
  await expected.waitFor({ state: "visible", timeout: 30_000 });
  const staleMarkers = {};
  for (const marker of forbiddenMarkers) {
    const count = await markerMessage(page, marker).count();
    staleMarkers[marker] = count;
    assert.equal(count, 0, `thread ${threadId} transcript must not contain another task's marker ${marker}`);
  }
  return {
    urlThreadId,
    expectedMarker,
    expectedMessageCount: await expected.count(),
    staleMarkers,
    composerVisible: await page.getByTestId("message-input").isVisible().catch(() => false),
  };
}

function markerMessage(page, marker) {
  return page.getByTestId("message-user").filter({
    hasText: new RegExp(`${escapeRegex(marker)}(?![A-Za-z0-9_])`),
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

async function sendAndCheckRoute(page, threadId, marker, rpc, model) {
  const previousCalls = rpc.requests.filter((request) => request.method === "turn/start").length;
  await page.getByTestId("message-input").fill(marker);
  await page.getByTestId("send-message").click();
  await page.getByTestId("message-user").filter({ hasText: marker }).waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(
    () => rpc.requests.filter((request) => request.method === "turn/start" && request.text?.includes(marker)).length === 1,
    30_000,
    `turn/start containing ${marker}`,
  );
  const call = rpc.requests.filter((request) => request.method === "turn/start").at(-1);
  assert.ok(rpc.requests.filter((request) => request.method === "turn/start").length > previousCalls);
  assert.equal(call.text.includes(marker), true);
  assert.equal(call.threadId, threadId, `${marker} must be sent to URL thread ${threadId}`);
  await waitFor(() => model.requests.some((request) => JSON.stringify(request).includes(marker)), 30_000, `fixture Provider request containing ${marker}`);
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
}

function routeThreadId(url) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts.at(-1) ?? "");
}

async function waitFor(pageOrCondition, conditionOrTimeout, timeoutOrLabel, maybeLabel) {
  const condition = typeof pageOrCondition === "function" ? pageOrCondition : conditionOrTimeout;
  const timeoutMs = typeof pageOrCondition === "function" ? conditionOrTimeout : timeoutOrLabel;
  const label = typeof pageOrCondition === "function" ? timeoutOrLabel : maybeLabel;
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    if (typeof pageOrCondition === "function") {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    } else {
      await pageOrCondition.waitForTimeout(50);
    }
  }
}
