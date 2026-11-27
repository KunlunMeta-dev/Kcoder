import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { startBackendModelTransport } from "../../e2e/harness/model-stream/backend-transport.mjs";
import { startModelStreamController } from "../../e2e/harness/model-stream/controller.mjs";
import { hashExecutableFile } from "../../e2e/harness/owned-executable-provenance.mjs";
import { materializeWorkspace } from "../../e2e/harness/workspace-fixture.mjs";
import { repoRoot, requireExecutable, runIntegration, waitFor } from "../../e2e/harness/run-context.mjs";

const fixtureRoot = resolve(repoRoot, "apps/kcoder-studio/e2e/fixtures/model-stream/chat-completions/minimax");
const TURN_TIMEOUT_MS = 45_000;

await runIntegration(import.meta.url, {
  testId: "manual-model-stream-direct-app-server-stdio",
  tier: "full-integration",
  modelPolicy: "offline sanitized Chat Completions SSE through real Rust app-server stdio; no live provider or Gateway",
}, async context => {
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const productBinaryPath = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, `target/debug/kcoder${executableSuffix}`));
  const driverBinaryPath = resolve(process.env.KCODER_E2E_STDIO_DRIVER_BIN || resolve(repoRoot, `target/debug/kcoder-e2e-stdio-driver${executableSuffix}`));
  const productBinary = await requireExecutable(productBinaryPath, "default KCoder CLI binary for loopback transport mode");
  const driverBinary = await requireExecutable(driverBinaryPath, "debug-only dedicated app-server transport driver");
  assert.equal(basename(driverBinary).replace(/\.exe$/i, ""), "kcoder-e2e-stdio-driver", "the injected transport must use the dedicated debug-only support binary");
  const [productIdentity, driverIdentity] = await Promise.all([
    hashExecutableFile(productBinary),
    hashExecutableFile(driverBinary),
  ]);

  const captured = await loadScenario("captured/text-completion");
  const loopbackWorkspace = (await materializeWorkspace(context, "minimal", { instanceId: "model-loopback" })).path;
  const loopback = await startModelStreamController(context, {
    scenarioId: captured.id,
    operationId: "stdio-loopback",
    scenario: captured,
  });
  const loopbackServer = await startConfiguredServer(context, {
    label: "model-loopback-stdio",
    binary: productBinary,
    workspace: loopbackWorkspace,
    controller: loopback,
    providerEndpoint: loopback.endpointUrl,
    providerId: "captured-minimax",
    modelId: captured.source.model,
    transportMode: "standard",
  });
  const loopbackInit = await initialize(loopbackServer.client, "model-loopback-stdio");
  assert.equal(loopbackInit.serverInfo.name, "kcoder-app-server");
  const loopbackThread = (await requestResult(loopbackServer.client, "thread/start", {})).thread;
  const loopbackTurn = await requestResult(loopbackServer.client, "turn/start", {
    threadId: loopbackThread.id,
    input: [{ type: "text", text: "KCODER_E2E:captured-minimax-sample" }],
  });
  const loopbackRequest = await loopback.waitForRequest("initial");
  assert.equal(loopbackRequest.status, "streaming");
  await loopback.release("initial", { frames: 1 });
  await loopbackServer.client.waitForNotification(frame =>
    frame.method === "item/delta"
    && frame.params?.turnId === loopbackTurn.turn.id
    && typeof frame.params?.delta?.text === "string"
    && frame.params.delta.text.includes("[REDACTED_SAMPLE_TEXT]"),
  TURN_TIMEOUT_MS, "first captured completion text delta");
  await loopback.release("initial", { frames: "all" });
  const loopbackComplete = await waitForTurn(loopbackServer.client, loopbackThread.id, loopbackTurn.turn.id);
  assert.equal(loopbackComplete.params.turn.status, "completed");
  assertUsage(loopbackServer.client, loopbackTurn.turn.id, { input: 232, output: 12, total: 244, cached: 192 });
  const loopbackSnapshot = loopback.snapshot();
  assert.equal(loopbackSnapshot.requests.length, 1);
  assert.equal(loopbackSnapshot.requests[0].framesWritten, captured.requests[0].frames.length);
  assert.equal(loopbackSnapshot.rejectedRequestCount, 0);
  const loopbackExit = await loopbackServer.close();
  assert.equal(loopbackExit.code, 0);

  const injectedScenario = captured;
  const injectedWorkspace = (await materializeWorkspace(context, "minimal", { instanceId: "model-private-transport" })).path;
  const fallback = await startFallbackProbe(context);
  const injected = await startModelStreamController(context, {
    scenarioId: injectedScenario.id,
    operationId: "stdio-private-transport",
    scenario: injectedScenario,
  });
  const injectedServer = await startConfiguredServer(context, {
    label: "model-private-transport-stdio",
    binary: driverBinary,
    workspace: injectedWorkspace,
    controller: injected,
    providerEndpoint: fallback.url,
    providerId: "private-captured-minimax",
    modelId: injectedScenario.source.model,
    transportMode: "private",
  });
  const injectedInit = await initialize(injectedServer.client, "model-private-transport-stdio");
  assert.equal(injectedInit.serverInfo.name, "kcoder-app-server");
  const injectedThread = (await requestResult(injectedServer.client, "thread/start", {})).thread;
  const unmatched = await requestResult(injectedServer.client, "turn/start", {
    threadId: injectedThread.id,
    input: [{ type: "text", text: "KCODER_E2E:must-not-match" }],
  });
  const rejectedTurn = await waitForTurn(injectedServer.client, injectedThread.id, unmatched.turn.id);
  assert.equal(rejectedTurn.params.turn.status, "failed", "an unmatched fixture request must fail closed");
  await waitFor(() => injected.snapshot().rejectedRequestCount === 1, 5_000, "unmatched request rejection receipt");
  assert.equal(injected.snapshot().requests.length, 0, "an unmatched request must not consume a fixture request");
  assert.equal(fallback.counts.post, 0, "private transport mismatch must never fall back to the configured provider endpoint");

  const accepted = await requestResult(injectedServer.client, "turn/start", {
    threadId: injectedThread.id,
    input: [{ type: "text", text: "KCODER_E2E:captured-minimax-sample" }],
  });
  const acceptedRequest = await injected.waitForRequest("initial");
  assert.equal(acceptedRequest.status, "streaming");
  await injected.release("initial", { frames: 1 });
  await injectedServer.client.waitForNotification(frame =>
    frame.method === "item/delta"
    && frame.params?.turnId === accepted.turn.id
    && typeof frame.params?.delta?.text === "string"
    && frame.params.delta.text.includes("[REDACTED_SAMPLE_TEXT]"),
  TURN_TIMEOUT_MS, "first injected completion text delta");
  await injected.release("initial", { frames: "all" });
  const injectedComplete = await waitForTurn(injectedServer.client, injectedThread.id, accepted.turn.id);
  assert.equal(injectedComplete.params.turn.status, "completed");
  assertUsage(injectedServer.client, accepted.turn.id, { input: 232, output: 12, total: 244, cached: 192 });
  assert.equal(fallback.counts.post, 0, "successful private transport must not reach the configured upstream endpoint");
  const injectedSnapshot = injected.snapshot();
  assert.equal(injectedSnapshot.rejectedRequestCount, 1);
  assert.equal(injectedSnapshot.requests.length, 1);
  assert.equal(injectedSnapshot.requests[0].framesWritten, injectedScenario.requests[0].frames.length);
  const injectedExit = await injectedServer.close();
  assert.equal(injectedExit.code, 0);

  const toolScenario = await loadScenario("tool-call-reconnect");
  const toolWorkspace = (await materializeWorkspace(context, "minimal", { instanceId: "model-tool-followup" })).path;
  await writeFile(resolve(toolWorkspace, "README.md"), "# KCoder E2E 最小工作区\nKCODER_E2E:TOOL_RESULT\n", { flag: "w", mode: 0o600 });
  const toolFallback = await startFallbackProbe(context);
  const toolController = await startModelStreamController(context, {
    scenarioId: toolScenario.id,
    operationId: "stdio-tool-followup",
    scenario: toolScenario,
  });
  const toolServer = await startConfiguredServer(context, {
    label: "model-tool-followup-private-stdio",
    binary: driverBinary,
    workspace: toolWorkspace,
    controller: toolController,
    providerEndpoint: toolFallback.url,
    providerId: "private-tool-minimax",
    modelId: "MiniMax-M2.7",
    transportMode: "private",
    toolConfig: true,
  });
  const toolInit = await initialize(toolServer.client, "model-tool-followup-private-stdio");
  assert.equal(toolInit.serverInfo.name, "kcoder-app-server");
  const toolThread = (await requestResult(toolServer.client, "thread/start", {})).thread;
  const toolTurn = await requestResult(toolServer.client, "turn/start", {
    threadId: toolThread.id,
    input: [{ type: "text", text: "KCODER_E2E:tool-call-reconnect" }],
  });
  const toolRequest = await toolController.waitForRequest("initial");
  assert.equal(toolRequest.status, "streaming");
  await toolController.release("initial", { frames: "all" });
  const reasoning = await toolServer.client.waitForNotification(frame =>
    frame.method === "item/event"
    && frame.params?.turnId === toolTurn.turn.id
    && frame.params?.event?.type === "assistant_thinking_delta"
    && String(frame.params.event.text).includes("inspect the requested fixture"),
  TURN_TIMEOUT_MS, "decoded reasoning content");
  assert.equal(reasoning.params.event.text, "inspect the requested fixture. ");
  const toolStarted = await toolServer.client.waitForNotification(frame =>
    frame.method === "item/started"
    && frame.params?.turnId === toolTurn.turn.id
    && frame.params?.item?.type === "toolCall",
  TURN_TIMEOUT_MS, "fragmented tool call start");
  assert.match(JSON.stringify(toolStarted.params.item.input), /README\.md/);
  const toolCompleted = await toolServer.client.waitForNotification(frame =>
    frame.method === "item/completed"
    && frame.params?.turnId === toolTurn.turn.id
    && frame.params?.item?.type === "toolCall"
    && JSON.stringify(frame.params.item.output).includes("KCODER_E2E:TOOL_RESULT"),
  TURN_TIMEOUT_MS, "tool result committed to app-server stream");
  assert.equal(toolCompleted.params.item.status, "completed");
  const followupRequest = await toolController.waitForRequest("after-tool");
  assert.equal(followupRequest.status, "streaming", "the second provider request must follow the real tool result");
  await toolController.release("after-tool", { frames: "all" });
  const toolComplete = await waitForTurn(toolServer.client, toolThread.id, toolTurn.turn.id);
  assert.equal(toolComplete.params.turn.status, "completed");
  const finalText = toolServer.client.notificationHistory.filter(frame =>
    frame.method === "item/delta"
    && frame.params?.turnId === toolTurn.turn.id)
    .map(frame => frame.params?.delta?.text ?? "")
    .join("");
  assert.equal(finalText, "KCODER_E2E:FOLLOWUP_COMPLETE I read the workspace README successfully.");
  assertUsage(toolServer.client, toolTurn.turn.id, { input: 27, output: 12, total: 39, cached: 0 });
  assert.equal(toolFallback.counts.post, 0, "tool turns must remain inside the controlled test transport");
  const toolSnapshot = toolController.snapshot();
  assert.equal(toolSnapshot.requests.length, 2);
  assert.equal(toolSnapshot.rejectedRequestCount, 0);
  assert.deepEqual(toolSnapshot.requests.map(request => request.id), ["initial", "after-tool"]);
  const toolExit = await toolServer.close();
  assert.equal(toolExit.code, 0);

  const ordinaryWorkspace = (await materializeWorkspace(context, "minimal", { instanceId: "model-no-test-entry" })).path;
  const ordinaryController = await startModelStreamController(context, {
    scenarioId: captured.id,
    operationId: "stdio-no-test-entry",
    scenario: captured,
  });
  const ordinaryProbe = await startFallbackProbe(context);
  const ordinaryServer = await startConfiguredServer(context, {
    label: "model-default-build-no-test-entry-stdio",
    binary: productBinary,
    workspace: ordinaryWorkspace,
    controller: ordinaryController,
    providerEndpoint: ordinaryProbe.url,
    providerId: "default-build-captured-minimax",
    modelId: captured.source.model,
    transportMode: "environment-only",
  });
  const ordinaryInit = await initialize(ordinaryServer.client, "model-default-build-no-test-entry-stdio");
  assert.equal(ordinaryInit.serverInfo.name, "kcoder-app-server");
  const ordinaryThread = (await requestResult(ordinaryServer.client, "thread/start", {})).thread;
  const ordinaryTurn = await requestResult(ordinaryServer.client, "turn/start", {
    threadId: ordinaryThread.id,
    input: [{ type: "text", text: "KCODER_E2E:captured-minimax-sample" }],
  });
  const ordinaryComplete = await waitForTurn(ordinaryServer.client, ordinaryThread.id, ordinaryTurn.turn.id);
  assert.equal(ordinaryComplete.params.turn.status, "failed", "environment variables alone must not enable the private transport in the ordinary CLI");
  assert.equal(ordinaryController.snapshot().requests.length, 0, "ordinary CLI must not send to the private controller route");
  assert.equal(ordinaryProbe.counts.post, 1, "ordinary CLI must retain its configured loopback provider transport");
  const ordinaryExit = await ordinaryServer.close();
  assert.equal(ordinaryExit.code, 0);

  const result = {
    products: {
      defaultCli: { path: productIdentity.path, sha256: productIdentity.sha256 },
      dedicatedDebugDriver: { path: driverIdentity.path, sha256: driverIdentity.sha256 },
    },
    loopbackHttp: {
      appServerStdio: true,
      decodedFirstFrameBeforeReleaseOfRemainder: true,
      complete: loopbackComplete.params.turn.status,
      requestCount: loopbackSnapshot.requests.length,
      frameCount: loopbackSnapshot.requests[0].frameCount,
      usage: { inputTokens: 232, outputTokens: 12, totalTokens: 244, cachedInputTokens: 192 },
      modelRequests: 1,
    },
    privateTransport: {
      appServerStdio: true,
      exactControlRouteUsed: true,
      mismatchRejected: true,
      mismatchDidNotConsumeExpectedRequest: true,
      mismatchDidNotReachConfiguredUpstream: fallback.counts.post === 0,
      decodedFirstFrameBeforeReleaseOfRemainder: true,
      complete: injectedComplete.params.turn.status,
      controllerRequestCount: injectedSnapshot.requests.length,
      rejectedRequestCount: injectedSnapshot.rejectedRequestCount,
      configuredUpstreamPostCount: fallback.counts.post,
      modelRequests: 2,
    },
    toolFollowup: {
      reasoningDeltaObserved: true,
      fragmentedToolArgumentsReassembled: JSON.stringify(toolStarted.params.item.input).includes("README.md"),
      toolResultObservedBeforeSecondRequest: true,
      followupRequestCount: toolSnapshot.requests.length,
      finalUsage: { inputTokens: 27, outputTokens: 12, totalTokens: 39 },
      terminalStatus: toolComplete.params.turn.status,
      configuredUpstreamPostCount: toolFallback.counts.post,
    },
    defaultBuildBoundary: {
      environmentVariablesAloneDidNotActivatePrivateTransport: true,
      privateControllerRequestCount: ordinaryController.snapshot().requests.length,
      configuredLoopbackPostCount: ordinaryProbe.counts.post,
      turnStatus: ordinaryComplete.params.turn.status,
    },
    boundary: "Captured MiniMax response structure replayed offline; no live provider request; no Gateway or Chromium in this suite",
  };
  await context.writeArtifactJson("model-stream-stdio.json", result);
  return result;
});

async function loadScenario(path) {
  return JSON.parse(await readFile(resolve(fixtureRoot, path, "scenario.json"), "utf8"));
}

async function startConfiguredServer(context, {
  label,
  binary,
  workspace,
  controller,
  providerEndpoint,
  providerId,
  modelId,
  transportMode,
  toolConfig = false,
}) {
  const configDir = context.pathInState("config", label);
  const settingsFile = await context.writeStateJson(`config/${label}/settings.json`, {
    active_provider: providerId,
    model: modelId,
    permission_mode: toolConfig ? "yolo" : "ask",
    max_retries: 0,
    tools: { profile: toolConfig ? "full" : "none", disabled: [] },
    ...(toolConfig ? { allowed_tools: ["read"] } : {}),
    providers: {
      [providerId]: {
        api_format: "openai_chat_completions",
        endpoint: providerEndpoint,
        default_model: modelId,
        authentication: { mode: "none" },
        discover_models: false,
        context_window_tokens: 128000,
        max_output_tokens: 1024,
        output_headroom_tokens: 1024,
        max_retries: 0,
        no_proxy: true,
      },
    },
  });
  const server = await startBackendModelTransport(context, {
    label,
    binary,
    workspace,
    configDir,
    settingsFile,
    controller,
    transportMode,
  });
  return server;
}

async function initialize(client, name) {
  return requestResult(client, "initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name, version: "1" },
  });
}

async function requestResult(client, method, params) {
  const frame = await client.request(method, params);
  assert.equal(frame.error, undefined, `${method} returned a JSON-RPC error`);
  assert.ok(frame.result && typeof frame.result === "object", `${method} response has no result object`);
  return frame.result;
}

async function waitForTurn(client, threadId, turnId) {
  return client.waitForNotification(frame =>
    frame.method === "turn/completed"
    && frame.params?.threadId === threadId
    && frame.params?.turnId === turnId,
  TURN_TIMEOUT_MS, `turn ${turnId} completion`);
}

function assertUsage(client, turnId, expected) {
  const usageEvent = client.notificationHistory.find(frame =>
    frame.method === "item/event"
    && frame.params?.turnId === turnId
    && frame.params?.event?.type === "context_usage_updated");
  assert.ok(usageEvent, "decoded Chat Completions usage must reach app-server notifications");
  const usage = usageEvent.params.event.contextUsage.last;
  assert.equal(usage.inputTokens, expected.input);
  assert.equal(usage.outputTokens, expected.output);
  assert.equal(usage.totalTokens, expected.total);
  assert.equal(usage.cachedInputTokens, expected.cached);
}

async function startFallbackProbe(context) {
  const counts = { get: 0, head: 0, post: 0 };
  const server = createServer((request, response) => {
    if (request.method === "HEAD") counts.head += 1;
    else if (request.method === "GET") counts.get += 1;
    else if (request.method === "POST") counts.post += 1;
    request.resume();
    response.writeHead(502, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ error: "upstream probe is deliberately unavailable" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  context.registerPort("backend transport no-fallback probe", port);
  context.addCleanup("close backend transport no-fallback probe", () => new Promise((accept, reject) => {
    server.close(error => error ? reject(error) : accept());
  }));
  return { url: `http://127.0.0.1:${port}/v1`, counts };
}
