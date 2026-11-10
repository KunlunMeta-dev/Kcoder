import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startProtocolStreamFixture } from '../../harness/protocol-stream-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { openPageGatewayRpc, initializeRpc, isTurnCompletion } from '../../harness/rpc.mjs';
import { registerOriginalCarrierCleanup } from '../../harness/native-systemd-carrier.mjs';
// Chromium creates its CDP file under the owned suite process umask.
process.umask(0o077);
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'three-protocol-studio-thinking-tools-and-eof', tier: 'full-integration',
  modelPolicy: 'model-independent real Studio projection of fixed protocol streams, an independent input client, and run-owned tool executions; no platform account or live model',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'protocol-ui' });
  const fixture = await startProtocolStreamFixture(context);
  const chromium = await startChromium(context);
  const results = [];
  for (const apiFormat of ['anthropic_messages', 'openai_chat_completions', 'openai_responses']) {
    const home = context.pathInState(apiFormat);
    const key = 'protocol-ui-only'; context.registerSecret(key);
    await context.writeStateJson(`${apiFormat}/credentials.json`, { fixture: { type: 'api', key } });
    await context.writeStateJson(`${apiFormat}/settings.json`, {
      active_provider: 'fixture', max_retries: 0, permission_mode: 'yolo',
      providers: { fixture: { api_format: apiFormat,
        endpoint: apiFormat === 'anthropic_messages' ? fixture.baseUrl.replace(/\/v1$/, '') : fixture.baseUrl,
        ...(apiFormat === 'openai_chat_completions' ? { chat_protocol: 'minimax' } : {}),
        default_model: 'fixture-model', no_proxy: true, context_window_tokens: 128000,
        max_output_tokens: 1024, output_headroom_tokens: 1024 } },
    });
    if (process.platform === 'linux') {
      const runtimeDir = `/run/user/${process.getuid()}`;
      registerOriginalCarrierCleanup(context, {
        profile: home, workspace, uid: process.getuid(), gid: process.getgid(),
        activeManagers: new Set(), env: context.isolatedEnvironment({
          KCODER_CONFIG_DIR: home, XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
        }),
      }, `${apiFormat}-original-task-host`);
    }
    const serversFile = await context.writeStateJson(`${apiFormat}-servers.json`, [{
      id: 'local', label: 'Protocol UI', transport: 'local', command: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), workspace,
    }]);
    const gateway = await startGateway(context, { label: apiFormat, workspace, serversFile, auth: true,
      // A source Gateway seals and verifies its SDK bundle at cold startup.
      startTimeoutMs: 60_000,
      env: { KCODER_CONFIG_DIR: home, KCODER_MAX_RETRIES: '0' } });
    const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
    const events = [];
    const consoleEvents = [];
    const requests = [];
    const socketIds = new WeakMap();
    let socketSequence = 0;
    let lastThreadId;
    await page.addInitScript(() => {
      localStorage.setItem('wework:debug-runtime-chat-stream', '1');
      localStorage.setItem('wework:debug-runtime', '1');
    });
    page.on('console', event => consoleEvents.push({ type: event.type(), text: event.text() }));
    page.on('pageerror', error => consoleEvents.push({ type: 'pageerror', text: error.message }));
    page.on('websocket', socket => {
      socketIds.set(socket, ++socketSequence);
      socket.on('framesent', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        requests.push({ atMs: Date.now(), socketId: socketIds.get(socket), id: message.id, method: message.method, threadId: message.params?.threadId });
      } catch {}
      });
    });
    page.on('websocket', socket => socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        events.push({ atMs: Date.now(), socketId: socketIds.get(socket), id: message.id, method: message.method, error: message.error?.message,
          threadId: message.params?.threadId, turnId: message.params?.turnId,
          turn: message.params?.turn ?? message.result?.turn,
          itemKind: message.params?.item?.type, eventType: message.params?.event?.type,
          resultKeys: message.result && typeof message.result === 'object' ? Object.keys(message.result) : undefined });
      } catch {}
    }));
    try {
      await page.goto(gateway.baseUrl);
      await page.locator('input[name="token"]').fill(gateway.authToken);
      await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
      await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
      const project = page.getByTestId('project-item').filter({ hasText: 'Protocol UI' }).first();
      page.on('websocket', socket => socket.on('framereceived', frame => {
        try {
          const message = JSON.parse(String(frame.payload));
          if (message.result?.thread?.id) lastThreadId = message.result.thread.id;
        } catch {}
      }));
      for (const mode of ['complete', 'eof', 'tool', 'no_thinking']) {
        const before = fixture.requests.length;
        const beforeEvents = events.length;
        const countBefore = await readFile(resolve(workspace, 'protocol-tool-count.txt'), 'utf8').catch(() => '');
        await project.hover();
        await project.getByTestId('project-new-conversation-button').click();
        await page.getByTestId('chat-message-input').click();
        await page.keyboard.insertText(`FIXTURE_${mode.toUpperCase()}`);
        await page.getByTestId('send-message-button').click();
        // The first task installs/loads its owned host. Measure that cold
        // boundary separately from the protocol/rendering deadline below.
        await waitFor(() => events.slice(beforeEvents).some(event =>
          event.method === 'turn/started' && event.threadId === lastThreadId),
        90_000, 'the original task host to accept this turn');
        await page.getByText('TEXT_TAIL', { exact: true }).waitFor({ timeout: 30000 });
        if (mode === 'eof') await page.getByTestId('assistant-error-card').waitFor({ timeout: 30000 });
        await waitFor(async () => await page.getByTestId('assistant-thinking-spinner').count() === 0, 30000, 'thinking terminal state');
        if (mode === 'no_thinking') {
          assert.equal(await page.getByTestId('assistant-thinking-details').count(), 0);
        } else {
        const processing = page.getByTestId('final-processing-toggle');
        const toggle = page.getByTestId('assistant-thinking-toggle');
        await waitFor(async () => {
          if (await toggle.isVisible()) return true;
          if (await processing.isVisible() && await processing.getAttribute('aria-expanded') !== 'true') await processing.click();
          return false;
        }, 30000, 'expand settled processing details');
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        assert.equal(await page.getByTestId('assistant-thinking-content').innerText(), 'THINK_TAIL');
        }
        assert.equal(await page.getByText('TEXT_TAIL', { exact: true }).count(), 1);
        assert.equal(await page.getByTestId('assistant-error-card').count(), mode === 'eof' ? 1 : 0);
        assert.equal(await readFile(resolve(workspace, 'protocol-tool-count.txt'), 'utf8').catch(() => ''), countBefore + (mode === 'tool' ? 'x' : ''));
        assert.equal(fixture.requests.length - before, mode === 'tool' ? 2 : 1);
        results.push({ apiFormat, mode, visibleThinking: mode !== 'no_thinking', preservedText: true });
      if (apiFormat === 'anthropic_messages' && mode === 'complete') {
        assert.ok(lastThreadId, 'Original UI task identity required');
        // A fresh idle viewer must subscribe before another input source starts.
        const idleCalls = [];
        page.on('websocket', socket => socket.on('framesent', frame => {
          try { idleCalls.push(JSON.parse(String(frame.payload))); } catch {}
        }));
        await page.reload();
        await page.getByTestId('chat-message-input').waitFor({ timeout: 60000 });
        await waitFor(() => idleCalls.some(call => call.method === 'thread/resume' &&
          call.params?.threadId === lastThreadId), 30000, 'idle viewer original-task subscription');
        const actor = await openPageGatewayRpc(context, page, gateway, 'close external-input actor');
        await initializeRpc(actor, 'external-original-task-input', { gatewaySharedThreadsV1: true });
        await actor.request('thread/resume', { threadId: lastThreadId });
        const marker = 'EXTERNAL_ORIGINAL_INPUT FIXTURE_TOOL';
        const before = fixture.requests.length;
        const started = await actor.request('turn/start', {
          threadId: lastThreadId, clientMessageId: 'external-protocol-original-input',
          input: [{ type: 'text', text: marker }],
        });
        const conversation = page.getByTestId('desktop-chat-scroll-content');
        await conversation.getByText(marker, { exact: true }).waitFor({ timeout: 30000 });
        const completed = await actor.waitFor(message => isTurnCompletion(message, lastThreadId,
          started.turn.id), 30000, 'external original-task terminal receipt');
        assert.equal(completed.params.turn.status, 'completed');
        await waitFor(async () => await conversation.getByText('TEXT_TAIL', { exact: true }).count() === 2,
          30000, 'external original-task final response');
        await waitFor(async () => await page.getByTestId('assistant-thinking-spinner').count() === 0 &&
          fixture.requests.length - before === 2, 30000, 'external tool turn completion');
        const processing = page.getByTestId('final-processing-toggle').last();
        if (await processing.isVisible() && await processing.getAttribute('aria-expanded') !== 'true') await processing.click();
        const thinking = page.getByTestId('assistant-thinking-toggle').last();
        if (await thinking.getAttribute('aria-expanded') !== 'true') await thinking.click();
        assert.equal(await page.getByTestId('assistant-thinking-content').last().innerText(), 'THINK_TAIL');
        assert.ok(await page.getByTestId('processing-tool-stats').last().isVisible(),
          'The externally started tool turn must retain the normal tool display');
        assert.equal(await conversation.getByText(marker, { exact: true }).count(), 1);
        assert.equal(idleCalls.filter(call => call.method === 'turn/start').length, 0,
          'The viewer must not originate an input to receive external events');
        results.push({ apiFormat, mode: 'idle-external-input', visibleThinking: true, visibleUser: true,
          toolRequests: 2, viewerStarts: 0, realPlatform: false });
        await context.writeArtifactJson('idle-external-input.json', results.at(-1));
        await page.screenshot({ path: context.pathInArtifacts('idle-external-input.png') });
      }
      }
    } catch (error) {
      if (lastThreadId) {
        const began = Date.now();
        try {
          const observer = await openPageGatewayRpc(context, page, gateway, 'close failed-page read observer');
          await initializeRpc(observer, 'original-history-failure-observer', {
            gatewaySharedThreadsV1: true, threadIndexedPagesV1: true,
          });
          const read = await observer.request('thread/read/indexed', { threadId: lastThreadId, limit: 50 }, 5000);
          await context.writeArtifactJson(`${apiFormat}-independent-history.json`, {
            elapsedMs: Date.now() - began, requestedThread: lastThreadId,
            actualThread: read.thread?.id, messageCount: read.messages?.length,
          });
        } catch (readError) {
          await context.writeArtifactJson(`${apiFormat}-independent-history.json`, {
            elapsedMs: Date.now() - began, requestedThread: lastThreadId, error: readError.message,
          });
        }
      }
      await context.writeArtifactJson(`${apiFormat}-failure-events.json`, {
        events, requests, consoleEvents, fixtureRequests: fixture.requests,
      });
      await page.screenshot({ path: context.pathInArtifacts(`${apiFormat}-failure.png`) }).catch(() => {});
      throw error;
    } finally { await page.close(); }
    await context.stopOwned(apiFormat);
  }
  return { results, requests: fixture.requests.length };
});
