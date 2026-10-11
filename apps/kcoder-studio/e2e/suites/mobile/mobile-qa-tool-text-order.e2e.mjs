import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const beforeMarker = "MOBILE_ORDER_BEFORE_VISIBLE";
const afterMarker = "MOBILE_ORDER_AFTER_VISIBLE";
const promptMarker = "MOBILE_ORDER_FIXTURE_TRIGGER";
const toolOutputMarker = "MOBILE_ORDER_TOOL_RESULT";
const toolId = "mobile-order-read";
const selectedModel = "mobile-order-selected-model";

await runE2E(
  import.meta.url,
  {
    testId: "mobile-visible-text-tool-text-order",
    tier: "full-integration",
    modelPolicy:
      "model-independent local Provider fixture validates streamed transcript presentation and persistence; it does not validate model tool selection",
    retainSuccessLogs: true,
  },
  async (context) => {
    const webRoot = await resolveMobileWebRoot(context);
    const gatewayBinary = await describeGatewayBinary(
      process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
    );
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "mobile-tool-text-order",
    });
    await writeFile(
      resolve(workspace, "src/mobile-order.txt"),
      `${toolOutputMarker}\n`,
      "utf8",
    );
    let releaseToolCall = false;
    let firstTextSentAt = 0;
    const model = await startApprovalModelFixture(context, {
      responseSteps: ({ body }) => {
        const hasToolResult = (body.messages ?? []).some(
          (message) => message?.role === "tool",
        );
        if (hasToolResult) {
          const afterFirstChunkAt = Date.now() + 120;
          return [
            { delta: { role: "assistant", content: "MOBILE_ORDER_AFTER_" } },
            {
              ready: () => Date.now() >= afterFirstChunkAt,
              delta: { content: "VISIBLE" },
            },
            { finishReason: "stop" },
          ];
        }
        firstTextSentAt = Date.now();
        return [
          { delta: { role: "assistant", content: "MOBILE_ORDER_BEFORE_" } },
          { delta: { content: "VISIBLE\n" } },
          {
            ready: () => releaseToolCall && Date.now() >= firstTextSentAt + 100,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: toolId,
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({
                      file_path: resolve(workspace, "src/mobile-order.txt"),
                      offset: 1,
                      limit: 10,
                    }),
                  },
                },
              ],
            },
          },
          { finishReason: "tool_calls" },
        ];
      },
    });
    const configDir = context.pathInState("config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const apiKey = "mobile-order-local-fixture-key";
    context.registerSecret(apiKey);
    const settingsFile = await context.writeStateJson("order-settings.json", {
      active_provider: "mobile-order-fixture",
      permission_mode: "yolo",
      max_retries: 0,
      providers: {
        "mobile-order-fixture": {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          default_model: selectedModel,
          // The Gateway advertises a large tool catalog; the 64k value blocked
          // the post-tool continuation at 63,046 estimated input tokens.
          context_window_tokens: 128_000,
          output_headroom_tokens: 1_024,
          max_output_tokens: 512,
          request_timeout_secs: 30,
          no_proxy: true,
          extra_body: {},
        },
      },
    });
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "mobile-order-fixture": { type: "api", key: apiKey },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Mobile ordering fixture",
        transport: "local",
        command: gatewayBinary.path,
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "mobile-order-gateway",
      workspace,
      serversFile,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_WEB_ROOT: webRoot.path,
      },
    });
    await waitForGatewayRpcToken(context, gateway);
    const declaredNoSandbox =
      process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
    const chromium = await startChromium(context, {
      label: declaredNoSandbox
        ? "mobile-order-chromium-declared-no-sandbox"
        : "mobile-order-chromium-sandbox-required",
    });
    const browserSecurity = {
      mode: chromium.noSandbox ? "declared-no-sandbox" : "sandbox-required",
      noSandbox: chromium.noSandbox,
      explicitFlag: chromium.noSandbox
        ? "KCODER_E2E_CHROMIUM_NO_SANDBOX=1"
        : "KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX=1",
      browserProfile: "RunContext-private",
      allowedNavigation: "RunContext-owned loopback Gateway only",
    };
    const page = await chromium.newPage({
      viewport: { width: 360, height: 800 },
    });
    const networkRequests = [];
    const websocketEvents = [];
    const websocketStarts = [];
    const clientErrors = [];
    page.on("pageerror", (error) => {
      clientErrors.push(safeClientError("pageerror", error, context));
    });
    page.on("console", (message) => {
      if (message.type() === "error")
        clientErrors.push(safeClientError("console", message, context));
    });
    page.on("request", (request) => {
      try {
        const url = new URL(request.url());
        if (url.origin === gateway.baseUrl)
          networkRequests.push({
            method: request.method(),
            path: url.pathname,
            resourceType: request.resourceType(),
          });
      } catch {
        // Keep only loopback route metadata; never persist raw request URLs.
      }
    });
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") return;
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          return;
        }
        if (frame?.method !== "thread/start" && frame?.method !== "turn/start")
          return;
        const params = frame.params ?? {};
        websocketStarts.push({
          method: frame.method,
          paramNames: Object.keys(params).sort(),
          selectedModel: typeof params.model === "string" ? params.model : null,
          settingsTemplatePresent: Object.hasOwn(params, "settingsTemplate"),
          settingsFilePresent: Object.hasOwn(params, "settingsFile"),
          inputItemTypes: Array.isArray(params.input)
            ? params.input.map((item) => typeof item?.type === "string" ? item.type : "unknown")
            : [],
          inputItemCount: Array.isArray(params.input) ? params.input.length : 0,
        });
      });
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          return;
        }
        const method = frame?.method;
        if (typeof method !== "string") return;
        const params = frame.params ?? {};
        const deltaText = typeof params.delta?.text === "string"
          ? params.delta.text
          : "";
        const runtimeEvent = params.event && typeof params.event === "object"
          ? params.event
          : null;
        const runtimeEventName = typeof runtimeEvent?.type === "string"
          ? runtimeEvent.type
          : runtimeEvent
            ? Object.keys(runtimeEvent)[0] ?? null
            : null;
        websocketEvents.push({
          sequence: websocketEvents.length,
          wireSequence: Number.isSafeInteger(params.sequence)
            ? params.sequence
            : null,
          method,
          threadId: typeof params.threadId === "string" ? params.threadId : null,
          turnId: typeof params.turnId === "string" ? params.turnId : null,
          itemType: typeof params.item?.type === "string" ? params.item.type : null,
          itemName: typeof params.item?.name === "string" ? params.item.name : null,
          itemStatus: typeof params.item?.status === "string" ? params.item.status : null,
          itemOutputPresent: params.item?.output != null,
          streamedTextMarker: deltaText.includes("MOBILE_ORDER_BEFORE_")
            ? "before"
            : deltaText.includes("MOBILE_ORDER_AFTER_")
              ? "after"
              : null,
          turnStatus: typeof params.turn?.status === "string" ? params.turn.status : null,
          error: safeErrorSummary(params.error, context),
          runtimeEventName,
          runtimeEventError: safeRuntimeEventError(runtimeEventName, runtimeEvent, context),
        });
      });
    });

    await connectMobile(page, gateway.baseUrl);
    await page.getByTestId("new-workspace").click();
    await page.getByTestId("server-option-local").click();
    await page
      .getByTestId("workspace-path")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("new-workspace-prompt").fill(promptMarker);
    await page.getByTestId("create-workspace").click();

    await page.getByText(beforeMarker, { exact: false }).waitFor({
      state: "visible",
      timeout: 60_000,
    });
    const partialStreamWasVisibleBeforeTool =
      await page.getByTestId(`tool-call-${toolId}`).count() === 0;
    releaseToolCall = true;
    try {
      const continuation = await waitForAfterOrTurnCompletion(page, websocketEvents, 10_000);
      assert.equal(
        continuation.afterVisible,
        true,
        "the streamed turn must request a provider continuation after completing the tool",
      );
    } catch (error) {
      const providerCalls = model.requests.map((request) => ({
        model: request.model,
        roles: (request.messages ?? []).map((message) => message?.role ?? "unknown"),
        advertisedTools: (request.tools ?? []).map(
          (tool) => tool.function?.name ?? tool.name ?? "unknown",
        ),
        assistantToolCalls: (request.messages ?? [])
          .filter((message) => message?.role === "assistant")
          .flatMap((message) => (message.tool_calls ?? []).map((call) => ({
            id: call.id,
            name: call.function?.name,
          }))),
        toolResultCount: (request.messages ?? []).filter(
          (message) => message?.role === "tool",
        ).length,
      }));
      await context.writeArtifactJson("mobile-order-prerequisite-failure.json", {
        pagePath: new URL(page.url()).pathname,
        webRoot,
        gatewayBinary,
        browserSecurity,
        clientErrors,
        visibleSignals: {
          beforeMarker:
            (await page.getByText(beforeMarker, { exact: false }).count()) > 0,
          afterMarker:
            (await page.getByText(afterMarker, { exact: false }).count()) > 0,
          toolCard: (await page.getByTestId(`tool-call-${toolId}`).count()) > 0,
          assistantRows: await page.getByTestId("message-assistant").count(),
        },
        providerCalls,
        runtimeEvents: websocketEvents,
        startupRequests: websocketStarts,
      });
      await page.screenshot({
        path: context.pathInArtifacts("mobile-order-prerequisite-failure.png"),
        fullPage: true,
      });
      throw error;
    }
    await revealToolOutput(page, toolId);

    const viewportOrders = [];
    for (const width of [360, 390, 414]) {
      await page.setViewportSize({ width, height: 844 });
      viewportOrders.push({ width, ...(await inspectVisibleOrder(page)) });
    }
    const initialRoutePath = new URL(page.url()).pathname;
    const reloadUrl = page.url();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(afterMarker, { exact: false }).waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await revealToolOutput(page, toolId);
    const reloadOrder = await inspectVisibleOrder(page);
    const providerCalls = model.requests.map((request) => ({
      model: request.model,
      containsToolResult: (request.messages ?? []).some(
        (message) => message?.role === "tool",
      ),
      advertisedToolCount: Array.isArray(request.tools) ? request.tools.length : 0,
    }));
    const report = {
      claim: "model-independent Mobile Web transcript presentation only",
      selectedFixtureModel: selectedModel,
      webRoot,
      gatewayBinary,
      browserSecurity,
      clientErrors,
      selectedFixtureModelObservedOnProviderRequests: providerCalls.every(
        (call) => call.model === selectedModel,
      ),
      partialStreamWasVisibleBeforeTool,
      route: {
        initialPath: initialRoutePath,
        reloadPath: new URL(reloadUrl).pathname,
        samePathAfterReload: initialRoutePath === new URL(reloadUrl).pathname,
      },
      providerCalls,
      startupRequests: websocketStarts,
      viewportOrders,
      reloadOrder,
      gatewayNetwork: networkRequests,
      runtimeEvents: websocketEvents,
    };
    await context.writeArtifactJson("mobile-visible-order.json", report);

    const badOrders = viewportOrders.filter(
      ({ order }) => order?.join(",") !== "before,tool,after",
    );
    const reloadBad = reloadOrder.order?.join(",") !== "before,tool,after";
    if (badOrders.length > 0 || reloadBad) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: context.pathInArtifacts("mobile-visible-order-red.png"),
        fullPage: true,
      });
    }

    assert.equal(
      partialStreamWasVisibleBeforeTool,
      true,
      "the browser must observe the first assistant text while the fixture is still holding the tool call",
    );
    assert.ok(
      providerCalls.length >= 2 &&
        providerCalls.every((call) => call.model === selectedModel) &&
        providerCalls.some((call) => call.containsToolResult),
      "the selected local Provider fixture must receive the tool result before the continuation",
    );
    for (const snapshot of viewportOrders)
      assert.equal(
        snapshot.visible,
        true,
        `all ordering markers must be visible at width ${snapshot.width}px`,
      );
    for (const snapshot of viewportOrders)
      assert.equal(
        snapshot.sameAssistantMessage,
        true,
        `before/tool/after must belong to the same assistant message at width ${snapshot.width}px`,
      );
    for (const snapshot of viewportOrders)
      assert.deepEqual(
        snapshot.order,
        ["before", "tool", "after"],
        `visible Mobile transcript order at width ${snapshot.width}px`,
      );
    assert.deepEqual(
      reloadOrder.order,
      ["before", "tool", "after"],
      "visible Mobile transcript order after reloading the active thread",
    );
    assert.equal(reloadOrder.visible, true, "all reloaded ordering markers must be visible");
    assert.equal(
      reloadOrder.sameAssistantMessage,
      true,
      "reloaded before/tool/after must belong to the same assistant message",
    );
    assert.ok(
      websocketEvents.some((event) => event.method === "turn/completed") &&
        websocketEvents.some((event) => event.method === "item/started") &&
        websocketEvents.some((event) => event.method === "item/completed"),
      "the visible sequence must be caused by streamed app-server tool lifecycle events",
    );
    const causalEvents = [
      websocketEvents.find((event) => event.method === "item/delta" && event.streamedTextMarker === "before"),
      websocketEvents.find((event) => event.method === "item/started" && event.itemType === "toolCall"),
      websocketEvents.find((event) => event.method === "item/completed" && event.itemType === "toolCall" && event.itemStatus === "completed"),
      websocketEvents.find((event) => event.method === "item/delta" && event.streamedTextMarker === "after"),
    ];
    assert.ok(
      causalEvents.every(Boolean) &&
        causalEvents.every((event) => event.threadId === causalEvents[0].threadId) &&
        causalEvents.every((event) => event.turnId === causalEvents[0].turnId) &&
        causalEvents.every((event) => Number.isSafeInteger(event.wireSequence)) &&
        causalEvents[0].sequence < causalEvents[1].sequence &&
        causalEvents[1].sequence < causalEvents[2].sequence &&
        causalEvents[2].sequence < causalEvents[3].sequence &&
        causalEvents[0].wireSequence < causalEvents[1].wireSequence &&
        causalEvents[1].wireSequence < causalEvents[2].wireSequence &&
        causalEvents[2].wireSequence < causalEvents[3].wireSequence,
      "the same thread and turn must stream before-text, tool start/completion, then after-text in transport and server sequence order",
    );
    assert.ok(
      websocketStarts.some((request) => request.method === "thread/start") &&
        websocketStarts.some((request) => request.method === "turn/start"),
      "capture actual thread/start and turn/start wire parameters without recording prompt content",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: context.pathInArtifacts("mobile-visible-order-pass.png"),
      fullPage: true,
    });
    return {
      viewports: viewportOrders.map(({ width, order }) => ({ width, order })),
      reloadOrder: reloadOrder.order,
      providerRequestCount: providerCalls.length,
    };
  },
);

async function connectMobile(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page
    .getByTestId("welcome-direct-connection")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(baseUrl);
  await page.getByTestId("gateway-connect").click();
  await page
    .getByTestId("new-workspace")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function revealToolOutput(page, id) {
  const card = page.getByTestId(`tool-call-${id}`);
  const orderedToggle = page.getByTestId(
    `tool-call-toggle-${encodeURIComponent(id)}`,
  );
  if (await orderedToggle.count()) {
    await orderedToggle.waitFor({ state: "visible", timeout: 15_000 });
    if ((await orderedToggle.getAttribute("aria-expanded")) !== "true")
      await orderedToggle.click();
  } else {
    // Frozen pre-fix baseline exposes tool cards inside the legacy global disclosure.
    const processing = page.getByTestId("message-processing-toggle").last();
    await processing.waitFor({ state: "visible", timeout: 15_000 });
    if ((await processing.getAttribute("aria-expanded")) !== "true")
      await processing.click();
    await card.waitFor({ state: "visible", timeout: 15_000 });
    const detailToggle = card.getByRole("button").first();
    if ((await detailToggle.getAttribute("aria-expanded")) !== "true")
      await detailToggle.click();
  }
  await card.waitFor({ state: "visible", timeout: 15_000 });
  await page.getByText(toolOutputMarker, { exact: false }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

async function resolveMobileWebRoot(context) {
  const frozenArtifactRoot = process.env.KCODER_E2E_MOBILE_BASELINE_BUILD3;
  if (!frozenArtifactRoot) {
    const exported = await exportMobileWeb(context, {
      mobileRoot: resolve(appRoot, "mobile"),
      dependencyRoot: resolve(
        repoRoot,
        "target/packages/kcoder-studio-mobile/20260930-153437.732Z-arm64-release/caches/mobile-node_modules",
      ),
      label: "mobile-order-checkout-export",
      outputName: "mobile-order-checkout-web",
    });
    return { ...exported, source: "mutable-checkout-source-export" };
  }

  const archivePath = resolve(frozenArtifactRoot, "source/mobile-shared.tar.gz");
  const freezePath = resolve(frozenArtifactRoot, "source-freeze.json");
  const diffPath = resolve(frozenArtifactRoot, "source-snapshot-diff.json");
  const [freeze, sourceDiff] = await Promise.all([
    readFile(freezePath, "utf8").then(JSON.parse),
    readFile(diffPath, "utf8").then(JSON.parse),
  ]);
  assert.equal(await sha256File(archivePath), sourceDiff.sourceArchiveSha256,
    "Build3 frozen source archive must match its recorded digest");

  const extractedRoot = context.pathInState("build3-mobile-source");
  await mkdir(extractedRoot, { recursive: true });
  context.registerTemporaryDirectory("Build3 frozen Mobile web export", extractedRoot);
  await runOwned(context, "extract-build3-mobile-source", "tar", [
    "-xzf", archivePath, "-C", extractedRoot,
  ]);
  const sourceMobileRoot = resolve(extractedRoot, "apps/kcoder-studio/mobile");
  const frozenNodeModules = resolve(frozenArtifactRoot, "caches/mobile-node_modules");
  await access(resolve(frozenNodeModules, "expo/package.json"));
  const exported = await exportMobileWeb(context, {
    mobileRoot: sourceMobileRoot,
    dependencyRoot: frozenNodeModules,
    label: "mobile-order-build3-export",
    outputName: "mobile-order-build3-web",
  });
  return {
    ...exported,
    source: "build3-frozen-source-export",
    frozenAtUtc: freeze.frozenAtUtc,
    frozenMobileSharedSourceTreeSha256: freeze.treeSha256,
    sourceArchiveSha256: sourceDiff.sourceArchiveSha256,
  };
}

async function runOwned(context, label, command, args, options = {}) {
  const child = context.spawnOwned(label, command, args, options);
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveExit(0);
      else rejectExit(new Error(`${label} exited with ${signal || `code ${code}`}`));
    });
  });
  return exitCode;
}

async function sha256File(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function describeGatewayBinary(path) {
  const metadata = await stat(path);
  return {
    path,
    sha256: await sha256File(path),
    sizeBytes: metadata.size,
    mtimeUtc: metadata.mtime.toISOString(),
    selection: process.env.KCODER_E2E_KCODER_BIN
      ? "explicit KCODER_E2E_KCODER_BIN"
      : "default target/debug/kcoder",
    sourceCommit: null,
    sourceCommitStatus: "unverified; binary provenance supplied independently",
  };
}

function safeClientError(source, error, context) {
  const message = typeof error?.message === "function"
    ? error.message()
    : typeof error?.message === "string"
      ? error.message
      : String(error ?? "");
  const lower = message.toLowerCase();
  let category = "client_error";
  if (/is not defined|not defined|undefined is not a function/.test(lower))
    category = "reference_error";
  else if (/networkerror|failed to fetch|net::err_/.test(lower))
    category = "network_error";
  else if (/timeout|timed out/.test(lower)) category = "timeout";
  return {
    source,
    errorName: typeof error?.name === "string" ? error.name : null,
    category,
    message: safeDiagnosticText(message, context),
  };
}

function safeErrorSummary(error, context) {
  if (!error || typeof error !== "object") return null;
  const code = typeof error.code === "number" || typeof error.code === "string"
    ? error.code
    : null;
  const message = typeof error.message === "string" ? error.message : "";
  return {
    code,
    category: classifyErrorMessage(message.toLowerCase()),
    message: message ? safeDiagnosticText(message, context) : null,
    providerFailure: safeProviderFailure(error.details ?? error.data?.details),
  };
}

function safeProviderFailure(value) {
  if (!value || typeof value !== "object") return null;
  const allowedEnums = new Set([
    "authentication_error",
    "forbidden",
    "model_or_route",
    "invalid_parameter",
    "context_length_exceeded",
    "rate_limit",
    "quota_exceeded",
    "network_error",
    "timeout_error",
    "model_protocol_error",
    "provider_error",
    "needs_human",
    "diagnose_only",
  ]);
  const category = typeof value.category === "string" && allowedEnums.has(value.category)
    ? value.category
    : null;
  const recoveryAction = typeof value.recoveryAction === "string" && allowedEnums.has(value.recoveryAction)
    ? value.recoveryAction
    : typeof value.recovery_action === "string" && allowedEnums.has(value.recovery_action)
      ? value.recovery_action
      : null;
  return {
    category,
    recoveryAction,
    httpStatus: Number.isInteger(value.httpStatus ?? value.http_status)
      ? value.httpStatus ?? value.http_status
      : null,
    retryable: typeof value.retryable === "boolean" ? value.retryable : null,
    resumeSafe: typeof value.resumeSafe === "boolean"
      ? value.resumeSafe
      : typeof value.resume_safe === "boolean"
        ? value.resume_safe
        : null,
    retryAfterMs: Number.isInteger(value.retryAfterMs ?? value.retry_after_ms)
      ? value.retryAfterMs ?? value.retry_after_ms
      : null,
  };
}

function safeRuntimeEventError(name, payload, context) {
  const normalizedName = typeof name === "string" ? name.toLowerCase() : "";
  if (!/(error|failed|aborted|limit|denied)/.test(normalizedName)) return null;
  const message = typeof payload === "string"
    ? payload
    : typeof payload?.message === "string"
      ? payload.message
      : typeof payload?.reason === "string"
        ? payload.reason
        : typeof payload?.text === "string"
          ? payload.text
          : "";
  return {
    category: classifyErrorMessage(message.toLowerCase()),
    message: message ? safeDiagnosticText(message, context) : null,
  };
}

function classifyErrorMessage(message) {
  if (/provider.{0,24}http\s*\d{3}|http\s*\d{3}.{0,24}provider/.test(message))
    return "provider_http_failure";
  if (/permission|denied|approval/.test(message))
    return "permission_or_approval_failure";
  if (/tool/.test(message) && /failed|error|invalid|unable|cannot/.test(message))
    return "tool_failure";
  if (/provider/.test(message) && /failed|error|invalid|unable|cannot/.test(message))
    return "provider_failure";
  if (/max.turns|turn.limit/.test(message)) return "turn_limit";
  if (/context|token.budget|goal.budget/.test(message)) return "context_or_budget_limit";
  if (/cancel|interrupt/.test(message)) return "cancelled";
  if (/failed|error|invalid|unable|cannot/.test(message)) return "reported_failure";
  return message ? "reported_error" : "message_unavailable";
}

function safeDiagnosticText(value, context) {
  return context.redactText(String(value))
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|auth(?:entication)?[_-]?token|cookie|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s)]+/gi, "[URL]")
    .slice(0, 240);
}

async function waitForAfterOrTurnCompletion(page, events, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const afterVisible = await page.getByText(afterMarker, { exact: false }).isVisible().catch(() => false);
    const completedTurn = [...events].reverse().find((event) => event.method === "turn/completed");
    if (afterVisible || completedTurn)
      return { afterVisible, completedTurn: completedTurn ?? null };
    await page.waitForTimeout(50);
  }
  throw new Error("neither the continuation text nor turn/completed arrived before the fixture timeout");
}

async function inspectVisibleOrder(page) {
  return page.evaluate(
    ({ beforeMarker, afterMarker, toolId }) => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid="message-assistant"]'),
      );
      const leafFor = (marker) => {
        for (const row of rows) {
          const match = Array.from(row.querySelectorAll("*"))
          .filter((node) => node.childElementCount === 0)
          .find((node) => node.textContent?.includes(marker));
          if (match) return { node: match, row };
        }
        return null;
      };
      const before = leafFor(beforeMarker);
      const after = leafFor(afterMarker);
      const tool = document.querySelector(
        `[data-testid="tool-call-${toolId}"]`,
      );
      if (!before || !after || !tool)
        return { order: null, visible: false, sameAssistantMessage: false };
      const nodes = [
        { key: "before", node: before.node, row: before.row },
        { key: "tool", node: tool, row: rows.find((row) => row.contains(tool)) },
        { key: "after", node: after.node, row: after.row },
      ];
      const visible = (node) => {
        if (!node || node.getClientRects().length === 0) return false;
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const order = nodes.every(({ node }) => node)
        ? [...nodes]
            .sort((left, right) =>
              left.node.compareDocumentPosition(right.node) &
              Node.DOCUMENT_POSITION_FOLLOWING
                ? -1
                : 1,
            )
            .map(({ key }) => key)
        : null;
      return {
        order,
        visible: nodes.every(({ node }) => visible(node)),
        sameAssistantMessage: nodes.every(({ row }) => row === nodes[0].row),
      };
    },
    { beforeMarker, afterMarker, toolId },
  );
}
