import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { startModelStreamController } from '../../harness/model-stream/controller.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { waitForSelectedModel } from '../../harness/model-selector.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();

const textFixturePath = resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/model-stream/chat-completions/minimax/text-completion/scenario.json');
const textFixtureBytes = await readFile(textFixturePath);
const textFixture = JSON.parse(textFixtureBytes.toString('utf8'));
const textFixtureRequest = textFixture.requests.find(request => request.id === 'initial');
assert.ok(textFixtureRequest, 'versioned text-completion fixture must contain its initial request');
const toolFixturePath = resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/model-stream/chat-completions/minimax/tool-call-reconnect/scenario.json');
const toolFixtureBytes = await readFile(toolFixturePath);
const toolFixture = JSON.parse(toolFixtureBytes.toString('utf8'));
assert.equal(toolFixture.requests.length, 2, 'versioned tool fixture must include the follow-up request');
const browserPrompt = textFixtureRequest.match.lastMessageIncludes;
const completedText = 'KCODER_E2E:REPLY_COMPLETE';
const transportMode = process.env.KCODER_E2E_MANUAL_STREAM_TRANSPORT || 'loopback-http';
assert.ok(['loopback-http', 'app-server-http-replacement'].includes(transportMode),
  'KCODER_E2E_MANUAL_STREAM_TRANSPORT must be loopback-http or app-server-http-replacement');

await runE2E(import.meta.url, {
  testId: 'manual-model-stream-gateway-eof-and-browser-reconnect',
  tier: 'full-integration',
  modelPolicy: 'synthetic Chat Completions SSE through a real Gateway and Rust app-server; offline loopback HTTP or explicit test-only backend transport; no paid model',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', {
    instanceId: 'manual-model-stream-reconnect',
  });
  const scenarioId = `gateway-browser-${context.seed}`;
  const operationId = `operation-${context.seed}`;
  const appServerBinary = transportMode === 'app-server-http-replacement'
    ? process.env.KCODER_E2E_MODEL_TRANSPORT_BIN
    : process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  if (!appServerBinary) throw new Error('UNMET_PREREQUISITE: set KCODER_E2E_MODEL_TRANSPORT_BIN to the debug e2e-http-transport driver');
  await requireExecutable(appServerBinary, 'KCoder app-server test binary');
  const controller = await startModelStreamController(context, {
    scenarioId,
    operationId,
    scenario: {
      schemaVersion: 1,
      id: scenarioId,
      protocol: 'openai_chat_completions',
      source: { kind: 'synthetic', description: 'Versioned MiniMax Chat Completions fixtures replayed through an owned Gateway and desktop browser' },
      requests: [
        ...toolFixture.requests.map((request, index) => ({
          id: index === 0 ? 'gateway-tool-initial' : 'gateway-tool-after-tool',
          match: { ...request.match, model: 'manual-stream-fixture' },
          frames: request.frames,
        })),
        {
          id: 'gateway-eof',
          match: { model: 'manual-stream-fixture', lastMessageRole: 'user', lastMessageIncludes: 'MANUAL_GATEWAY_EOF' },
          // Keep the canonical stream intact, then close the transport after a partial release.
          frames: textFixtureRequest.frames,
        },
        {
          id: 'browser-reconnect',
          match: { model: 'manual-stream-fixture', lastMessageRole: 'user', lastMessageIncludes: browserPrompt },
          frames: textFixtureRequest.frames,
        },
      ],
    },
  });

  const configDir = context.pathInState('config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson('config/settings.json', {});
  const settingsFile = await context.writeStateJson('settings.json', {
    active_provider: 'manual-stream-fixture',
    max_retries: 0,
    permission_mode: 'yolo',
    allowed_tools: ['read'],
    tools: { profile: 'nano', disabled: [] },
    providers: {
      'manual-stream-fixture': {
        api_format: 'openai_chat_completions',
        chat_protocol: 'minimax',
        authentication: { mode: 'none' },
        endpoint: controller.endpointUrl,
        default_model: 'manual-stream-fixture',
        context_window_tokens: 128_000,
        output_headroom_tokens: 1_024,
        max_output_tokens: 1_024,
        request_timeout_secs: 120,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local',
    label: 'Manual model stream',
    runtime: 'kcoder',
    transport: 'local',
    command: appServerBinary,
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    workspace,
    serversFile,
    kcoderBin: appServerBinary,
    startTimeoutMs: 120_000,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_MAX_RETRIES: '0',
      ...(transportMode === 'app-server-http-replacement' ? {
        KCODER_E2E_MODEL_TRANSPORT_URL: `${controller.controlUrl}/transport`,
        KCODER_E2E_MODEL_TRANSPORT_TOKEN: controller.controlToken,
      } : {}),
    },
  });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)), {
    headers: { Origin: gateway.baseUrl },
    timeoutMs: 30_000,
  });
  context.addCleanup('close manual stream Gateway observer', () => rpc.close());
  await initializeRpc(rpc, 'manual-model-stream-chain');

  const toolThread = (await rpc.request('thread/start', {})).thread;
  const toolInputId = `manual-gateway-tool-${context.seed}`;
  const toolTurn = await rpc.request('turn/start', {
    threadId: toolThread.id,
    clientMessageId: toolInputId,
    input: [{ type: 'text', text: toolFixture.requests[0].match.lastMessageIncludes }],
  });
  await waitForModelRequestOrTerminal(context, controller, rpc, 'gateway-tool-initial', toolThread.id, toolTurn.turn.id);
  const toolInitialRelease = await controller.release('gateway-tool-initial', { frames: 'all' });
  assert.equal(toolInitialRelease.framesWritten, toolInitialRelease.frameCount);
  await controller.waitForRequest('gateway-tool-after-tool', { timeoutMs: 60_000 });
  const toolFinalText = rpc.waitFor(message => message.method === 'item/delta'
    && message.params?.threadId === toolThread.id
    && message.params?.turnId === toolTurn.turn.id
    && message.params?.delta?.text?.includes('KCODER_E2E:FOLLOWUP_COMPLETE'), 60_000, 'canonical tool follow-up text');
  const toolCompleted = rpc.waitFor(message => message.method === 'turn/completed'
    && message.params?.threadId === toolThread.id
    && message.params?.turnId === toolTurn.turn.id, 60_000, 'canonical Gateway tool turn completion');
  const toolFollowupRelease = await controller.release('gateway-tool-after-tool', { frames: 'all' });
  assert.equal(toolFollowupRelease.framesWritten, toolFollowupRelease.frameCount);
  await toolFinalText;
  assert.equal((await toolCompleted).params.turn.status, 'completed');
  const toolThinking = rpc.messages()
    .filter(message => message.params?.threadId === toolThread.id && message.params?.turnId === toolTurn.turn.id)
    .filter(message => message.params?.event?.type === 'assistant_thinking_delta')
    .map(message => message.params.event.text)
    .join('');
  const expectedToolThinking = toolFixture.requests.flatMap(request => request.frames)
    .flatMap(frame => [...frame.matchAll(/^data: (.+)$/gm)])
    .map(([, data]) => data)
    .filter(data => data !== '[DONE]')
    .map(data => JSON.parse(data))
    .flatMap(event => event.choices ?? [])
    .map(choice => choice.delta?.reasoning_content ?? '')
    .join('');
  assert.equal(toolThinking, expectedToolThinking, 'Gateway RPC must receive the complete canonical reasoning stream');
  const usageHistory = (await rpc.request('usage/stats')).history;
  const usageCounters = Object.values(usageHistory.days).map(day => day['manual-stream-fixture']).find(Boolean);
  assert.deepEqual(
    { inputTokens: usageCounters?.inputTokens, outputTokens: usageCounters?.outputTokens, totalTokens: usageCounters?.totalTokens },
    { inputTokens: 27, outputTokens: 12, totalTokens: 39 },
    'Gateway usage accounting must retain the canonical follow-up usage trailer',
  );

  const gatewayThread = (await rpc.request('thread/start', {})).thread;
  const gatewayInputId = `manual-gateway-eof-${context.seed}`;
  const gatewayTurn = await rpc.request('turn/start', {
    threadId: gatewayThread.id,
    clientMessageId: gatewayInputId,
    input: [{ type: 'text', text: 'MANUAL_GATEWAY_EOF' }],
  });
  await controller.waitForRequest('gateway-eof', { timeoutMs: 30_000 });
  const eofRelease = await controller.release('gateway-eof', { frames: 3 });
  assert.equal(eofRelease.framesWritten, 3);
  await rpc.waitFor(message => message.method === 'item/delta'
    && message.params?.threadId === gatewayThread.id
    && message.params?.turnId === gatewayTurn.turn.id
    && message.params?.delta?.text?.includes(completedText), 30_000, 'canonical partial Gateway response before model EOF');
  await controller.disconnect('gateway-eof');
  const failedTurn = await rpc.waitFor(message => message.method === 'turn/completed'
    && message.params?.threadId === gatewayThread.id
    && message.params?.turnId === gatewayTurn.turn.id, 60_000, 'failed Gateway turn after model stream EOF');
  assert.equal(failedTurn.params.turn.status, 'failed', 'an early model stream EOF must not produce a successful terminal result');

  const browser = await startChromium(context, { label: 'manual-model-stream-browser' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const browserErrors = [];
  let verified = false;
  page.on('pageerror', error => browserErrors.push(error.message));
  const failureScreenshot = context.pathInArtifacts('manual-model-stream-failure.png');
  const failureReport = context.pathInArtifacts('manual-model-stream-failure.json');
  context.addCleanup('capture manual stream browser failure', async () => {
    if (verified || page.isClosed()) return;
    await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => {});
    const gatewayEvents = rpc.messages().map(message => ({
      method: message.method,
      threadId: message.params?.threadId,
      turnId: message.params?.turnId,
      eventType: message.params?.event?.type,
      status: message.params?.turn?.status,
      error: safeError(context, message.params?.event?.error ?? message.params?.turn?.error),
    })).filter(event => event.method || event.eventType || event.status || event.error);
    await writeFile(failureReport, JSON.stringify({
      browserErrors,
      controller: controller.snapshot(),
      gatewayEvents,
    }, null, 2));
  });
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const probe = window.__manualStreamProbe = { sockets: [], starts: [], closed: [], received: [] };
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        probe.sockets.push(this);
        this.addEventListener('close', () => probe.closed.push(this.url));
        this.addEventListener('message', event => {
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          if (frame.method) probe.received.push({
            method: frame.method,
            threadId: frame.params?.threadId,
            turnId: frame.params?.turnId,
            status: frame.params?.turn?.status,
          });
          const start = probe.starts.find(entry => entry.requestId === frame.id);
          if (start && frame.result?.turn?.id) start.turnId = frame.result.turn.id;
        });
      }
      send(payload) {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.method === 'turn/start') probe.starts.push({ requestId: frame.id, params: frame.params, turnId: null });
        } catch { /* Non-JSON WebSocket frames are unrelated to app-server RPC. */ }
        return super.send(payload);
      }
    };
  });
  await page.goto(`${gateway.baseUrl}/?e2e=1`, { waitUntil: 'domcontentloaded' });
  await waitForSelectedModel(page, 'manual-stream-fixture');
  const newConversation = page.getByTestId('project-new-conversation-button');
  await newConversation.waitFor({ state: 'visible', timeout: 60_000 });
  await newConversation.click();
  const composer = page.getByTestId('chat-message-input');
  await composer.waitFor({ state: 'visible', timeout: 30_000 });
  await composer.click();
  await page.keyboard.insertText(browserPrompt);
  await page.getByTestId('send-message-button').click();

  await controller.waitForRequest('browser-reconnect', { timeoutMs: 30_000 });
  const browserPartialRelease = await controller.release('browser-reconnect', { frames: 3 });
  assert.equal(browserPartialRelease.framesWritten, 3);
  const processToggle = page.getByTestId('final-processing-toggle');
  await expect(processToggle).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 });
  await processToggle.click();
  await expect(page.getByText(completedText, { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => window.__manualStreamProbe.starts.some(entry =>
    JSON.stringify(entry.params.input ?? []).includes('KCODER_E2E:text-completion') && entry.turnId), undefined,
  { timeout: 30_000 });
  const browserStart = await page.evaluate(() => window.__manualStreamProbe.starts.find(entry =>
    JSON.stringify(entry.params.input ?? []).includes('KCODER_E2E:text-completion')));
  assert.ok(browserStart?.params.threadId, 'the actual browser turn/start request must expose its task identity');
  assert.ok(browserStart?.params.clientMessageId, 'the actual browser request must have a stable input identity');

  // Keep an independent Gateway reader attached so disconnecting the browser does not
  // become the last client attachment and interrupt the model-owned turn.
  await rpc.request('thread/resume', { threadId: browserStart.params.threadId }, 30_000);
  const disconnectedSocketUrl = await page.evaluate(() => {
    const sockets = window.__manualStreamProbe.sockets;
    const candidates = sockets.filter(socket => {
      const url = new URL(socket.url);
      return socket.readyState === WebSocket.OPEN && url.pathname === '/rpc'
        && url.searchParams.has('workspace') && url.searchParams.get('channel') !== 'browser';
    });
    if (!candidates.length) throw new Error('No active browser task runtime WebSocket was found');
    window.__manualStreamDisconnectedSockets = candidates;
    return candidates.at(-1).url;
  });
  await page.evaluate(() => {
    for (const socket of window.__manualStreamDisconnectedSockets ?? []) {
      if (socket.readyState < WebSocket.CLOSING) socket.close(4001, 'Owned manual-stream reconnect test');
    }
  });
  await page.waitForFunction(() => {
    const disconnected = window.__manualStreamDisconnectedSockets ?? [];
    return disconnected.length > 0 && disconnected.every(socket => socket.readyState === WebSocket.CLOSED);
  }, undefined, { timeout: 5_000 });
  await page.context().setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false, undefined, { timeout: 5_000 });
  const browserFinalRelease = await controller.release('browser-reconnect', { frames: 'all' });
  assert.equal(browserFinalRelease.framesWritten, browserFinalRelease.frameCount);
  const receipt = await waitFor(async () => {
    const response = await rpc.request('turn/receipt/read', {
      threadId: browserStart.params.threadId,
      clientMessageId: browserStart.params.clientMessageId,
    }, 10_000);
    const current = response.receipt;
    if (current?.status === 'completed') return current;
    if (['failed', 'interrupted', 'cancelled'].includes(current?.status)) {
      throw new Error(`Reconnect turn settled as ${current.status}`);
    }
    return null;
  }, 60_000, 'authoritative reconnect turn receipt', 250, context.abortSignal);
  assert.equal(receipt.status, 'completed');
  assert.ok(receipt.turnId, 'completed receipt must identify the original turn');
  assert.equal(await page.evaluate(({ threadId, turnId }) => window.__manualStreamProbe.received.some(event =>
    event.method === 'turn/completed' && event.threadId === threadId && event.turnId === turnId), {
    threadId: browserStart.params.threadId,
    turnId: browserStart.turnId,
  }), false, 'no browser WebSocket may receive the terminal event while its context is offline');
  assert.equal(await page.evaluate(() => (window.__manualStreamDisconnectedSockets ?? [])
    .every(socket => socket.readyState === WebSocket.CLOSED)), true, 'all original task runtime sockets must be detached');

  await page.context().setOffline(false);
  await expect(page.getByTestId('message-assistant').filter({
    hasText: `${completedText} The fixture is ready.`,
  })).toBeVisible({ timeout: 60_000 });
  assert.equal(await page.getByTestId('message-user').filter({ hasText: browserPrompt }).count(), 1,
    'reconnect history must retain the accepted user input exactly once');
  assert.equal(await page.getByTestId('message-assistant').filter({ hasText: completedText }).count(), 1,
    'reconnect history must render the completed assistant output exactly once');
  await page.waitForFunction(url => {
    const disconnected = window.__manualStreamDisconnectedSockets ?? [];
    const workspace = new URL(url).searchParams.get('workspace');
    return disconnected.length > 0 && disconnected.every(socket => socket.readyState >= WebSocket.CLOSING)
      && window.__manualStreamProbe.sockets.some(socket => !disconnected.includes(socket)
        && socket.readyState === WebSocket.OPEN
        && new URL(socket.url).searchParams.get('workspace') === workspace);
  }, disconnectedSocketUrl, { timeout: 30_000 });

  const sentTurns = await page.evaluate(() => window.__manualStreamProbe.starts);
  const matchingStarts = sentTurns.filter(entry => entry.params.threadId === browserStart.params.threadId
    && entry.params.clientMessageId === browserStart.params.clientMessageId);
  assert.equal(matchingStarts.length, 1, 'browser reconnect must not replay the accepted input');
  const controllerState = controller.snapshot();
  assert.equal(controllerState.requests.filter(request => request.id === 'browser-reconnect').length, 1,
    'the accepted turn must produce exactly one matched model request');
  assert.deepEqual(controllerState.requests.map(request => request.id), [
    'gateway-tool-initial', 'gateway-tool-after-tool', 'gateway-eof', 'browser-reconnect',
  ]);
  assert.deepEqual(controllerState.requests.map(request => request.status), ['completed', 'completed', 'disconnected', 'completed']);
  assert.equal(controllerState.rejectedRequestCount ?? 0, 0, 'no duplicate or unmatched model request may fall through');
  assert.deepEqual(browserErrors, []);
  await page.screenshot({ path: context.pathInArtifacts('manual-model-stream-reconnected.png'), fullPage: true });

  await context.writeArtifactJson('manual-model-stream-chain.json', {
    modelProtocol: textFixture.protocol,
    sourceFixtures: [
      { path: 'apps/kcoder-studio/e2e/fixtures/model-stream/chat-completions/minimax/tool-call-reconnect/scenario.json', sha256: createHash('sha256').update(toolFixtureBytes).digest('hex') },
      { path: 'apps/kcoder-studio/e2e/fixtures/model-stream/chat-completions/minimax/text-completion/scenario.json', sha256: createHash('sha256').update(textFixtureBytes).digest('hex') },
    ],
    appServerBinary,
    modelTransportMode: transportMode,
    gatewayToolRoundTrip: {
      threadId: toolThread.id,
      turnId: toolTurn.turn.id,
      clientMessageId: toolInputId,
      status: 'completed',
      reasoningReceived: toolThinking === expectedToolThinking,
      initialAndFollowupRequests: 2,
      usage: { inputTokens: usageCounters.inputTokens, outputTokens: usageCounters.outputTokens, totalTokens: usageCounters.totalTokens },
    },
    gatewayEof: { threadId: gatewayThread.id, turnId: gatewayTurn.turn.id, status: failedTurn.params.turn.status, releasedCanonicalFrames: 3 },
    browserReconnect: {
      threadId: browserStart.params.threadId,
      clientMessageId: browserStart.params.clientMessageId,
      turnId: receipt.turnId,
      status: receipt.status,
      browserDisconnected: true,
      browserReconnected: true,
      matchedModelRequests: controllerState.requests.filter(request => request.id === 'browser-reconnect').length,
      rejectedModelRequests: controllerState.rejectedRequestCount ?? 0,
      replayedInputCount: matchingStarts.length,
    },
  });
  verified = true;
  return { gatewayToolRoundTrip: 'completed', gatewayEof: failedTurn.params.turn.status, browserReconnect: receipt.status, matchedModelRequests: controllerState.requests.length };
});

async function waitForModelRequestOrTerminal(context, controller, rpc, requestId, threadId, turnId) {
  const requestWait = controller.waitForRequest(requestId, { timeoutMs: 30_000 })
    .then(value => ({ kind: 'model-request', value }), error => ({ kind: 'request-timeout', error }));
  const terminalWait = rpc.waitFor(message => message.method === 'turn/completed'
    && message.params?.threadId === threadId && message.params?.turnId === turnId,
  30_000, 'initial Gateway model turn terminal')
    .then(value => ({ kind: 'terminal', value }), error => ({ kind: 'terminal-timeout', error }));
  const outcome = await Promise.race([requestWait, terminalWait]);
  if (outcome.kind === 'model-request') return outcome.value;

  const turnEvents = rpc.messages()
    .filter(message => message.params?.threadId === threadId && message.params?.turnId === turnId)
    .map(message => ({
      method: message.method,
      eventType: message.params?.event?.type,
      itemType: message.params?.item?.type,
      status: message.params?.turn?.status,
      error: safeError(context, message.params?.event?.error ?? message.params?.event?.message
        ?? message.params?.turn?.error ?? message.params?.error ?? message.error?.message),
    }))
    .filter(event => event.method || event.eventType || event.status || event.error);
  await context.writeArtifactJson('gateway-tool-initial-failure.json', {
    phase: 'waiting-for-first-model-request',
    outcome: outcome.kind,
    waitError: safeError(context, outcome.error?.message),
    controller: controller.snapshot(),
    turnEvents,
  });
  const terminal = turnEvents.findLast(event => event.method === 'turn/completed');
  throw new Error(`Initial Gateway tool turn ended before its model request (${terminal?.status ?? outcome.kind})`);
}

function safeError(context, value) {
  if (typeof value !== 'string' || !value) return undefined;
  return context.redactText(value).slice(0, 600);
}
