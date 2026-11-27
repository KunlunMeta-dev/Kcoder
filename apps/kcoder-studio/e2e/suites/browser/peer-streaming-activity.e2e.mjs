import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runE2E, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { openOwnedPeerStudioPage } from '../../harness/peer-studio-browser.mjs';
import { observePeerStudioPage, seedPeerStudioPage, sendPeerStudioUi } from '../../harness/peer-studio-ui.mjs';

const SOURCE = 'OWNED_SOURCE_TASK', TARGET = 'OWNED_TARGET_TASK', READY = 'OWNED_SEED_READY';
const AFTER = 'OWNED_STREAM_AFTER';
const PEER = 'OWNED_STREAM_PEER', WAKE = 'OWNED_BACKGROUND_WAKE';
const TARGET_TITLE = 'Owned streaming receiver';
process.umask(0o077);

await runE2E(import.meta.url, { testId: 'actual-peer-stream-order-and-unviewed-activity', tier: 'full-integration',
  modelPolicy: 'Two isolated Chromium pages and actual Native sessions; deterministic loopback responses verify UI ordering and background activity only.' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'frozen peer candidate');
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), process.env.KCODER_E2E_KCODER_BIN_SHA256);
  await assertRendererBuildFresh();
  let finishAfter = false, finishWake = false;
  const model = await startApprovalModelFixture(context, { textOnly: true, responseSteps: ({ body }) => {
    const transcript = JSON.stringify(body.messages);
    if (transcript.includes(WAKE)) return [
      { delta: { role: 'assistant', content: 'OWNED_WAKE_RUNNING' } },
      { ready: () => finishWake, finishReason: 'stop' },
    ];
    if (transcript.includes(PEER)) return [
      { delta: { role: 'assistant', content: AFTER } },
      { ready: () => finishAfter, finishReason: 'stop' },
    ];
    return [{ delta: { role: 'assistant', content: READY } }, { finishReason: 'stop' }];
  } });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'peer-streaming-activity' });
  const profile = context.pathInState('profile');
  const settings = await context.writeStateJson('profile/settings.json', { active_provider: 'owned', credential_store: 'file',
    permission_mode: 'yolo', max_retries: 0, cross_session_messages: { enabled: true, wake_idle: true },
    auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
    providers: { owned: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'owned-model', no_proxy: true, discover_models: false, context_window_tokens: 128000,
      max_output_tokens: 1024, output_headroom_tokens: 1024, capabilities: { text: true, tools: true, reasoning: false } } } });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned peer UI', runtime: 'kcoder',
    transport: 'local', command: binary, workspace, settingsFile: settings }]);
  const gateway = await startGateway(context, { auth: true, workspace, serversFile: servers, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: profile } });
  const { page: a } = await openOwnedPeerStudioPage(context, gateway, { label: 'peer-activity-source' });
  const { page: b } = await openOwnedPeerStudioPage(context, gateway, { label: 'peer-activity-target' });
  const aWire = observePeerStudioPage(a), bWire = observePeerStudioPage(b);
  try {
    const source = await seedPeerStudioPage(a, aWire, { marker: SOURCE, ready: READY, serverId: 'local' });
    const target = await seedPeerStudioPage(b, bWire, { marker: TARGET, ready: READY, serverId: 'local' });
    await waitFor(() => bWire.some(row => row.lane === 'browser-turn-state' && row.method === 'turn/completed' &&
      row.threadId === target.threadId), 30_000, 'target seed completion');
    const taskId = `kcoder:local:${target.threadId}`;
    await b.getByTestId(`runtime-local-task-row-${taskId}`).click({ button: 'right' });
    await b.getByTestId(`runtime-local-task-menu-rename-${taskId}`).click();
    await b.getByTestId(`rename-runtime-local-task-input-${taskId}`).fill(TARGET_TITLE);
    await b.getByTestId(`confirm-rename-runtime-local-task-${taskId}`).click();
    await waitFor(() => bWire.some(row => row.method === 'thread/metadata/update' && row.threadId === target.threadId &&
      row.replyObserved && !row.errorCode), 10000, 'confirmed peer title before discovery');
    await sendPeerStudioUi(a, aWire, { targetTitle: TARGET_TITLE, text: PEER, wake: true });
    await b.getByTestId('peer-agent-message').filter({ hasText: PEER }).waitFor({ timeout: 30_000 });
    await b.getByTestId('message-assistant').filter({ hasText: AFTER }).waitFor({ timeout: 30_000 });
    const order = await b.evaluate(({ before, peer, after }) => {
      const rows = [...document.querySelectorAll('[data-message-id]')];
      return [before, peer, after].map(text => rows.findIndex(row => row.textContent?.includes(text)));
    }, { before: READY, peer: PEER, after: AFTER });
    assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], `live DOM order ${order}`);
    const followup = bWire.findLast(row => row.lane === 'browser-turn-state' && row.method === 'turn/started' &&
      row.threadId === target.threadId && row.turnId !== 'turn-1');
    assert.ok(followup);
    assert.equal(bWire.some(row => row.method === 'turn/completed' && row.turnId === followup.turnId), false,
      'the order must be correct before turn completion');
    finishAfter = true;
    await waitFor(() => bWire.some(row => row.method === 'turn/completed' && row.turnId === followup.turnId),
      30_000, 'streaming followup completion');
    await b.close();
    const wake = await sendPeerStudioUi(a, aWire, { targetTitle: TARGET_TITLE, text: WAKE, wake: true });
    assert.equal(wake.settled.receipt.targetAddress.threadId, target.threadId);
    await waitFor(() => model.requests.some(body => JSON.stringify(body.messages).includes(WAKE)),
      30_000, 'unviewed peer model execution');
    const badge = a.getByTestId(`runtime-local-task-running-kcoder:local:${target.threadId}`);
    await badge.waitFor({ state: 'visible', timeout: 30_000 });
    assert.ok(new URL(a.url()).searchParams.get('taskId')?.endsWith(source.threadId), 'source remains the open session');
    finishWake = true;
    await badge.waitFor({ state: 'hidden', timeout: 30_000 });
    return { actualReactDom: true, livePeerOrder: order, unopenedTargetRunningAndSettled: true, paidCalls: 0 };
  } finally {
    await context.writeArtifactJson('streaming-observation.json', {
      providerRequests: model.requests.map(body => {
        const transcript = JSON.stringify(body.messages);
        return { peer: transcript.includes(PEER), wake: transcript.includes(WAKE) };
      }),
      sourceWire: aWire, targetWire: bWire,
      visibleTargetLabels: await a.getByTestId('session-message-target').allTextContents().catch(() => []),
      targetRows: await b.locator('[data-message-id]').evaluateAll(rows => rows.map(row => ({
        id: row.getAttribute('data-message-id'), text: row.textContent?.slice(0, 300),
      }))).catch(() => []),
    });
    await b.screenshot({ path: context.pathInArtifacts('target-streaming-final.png') }).catch(() => {});
    finishAfter = true; finishWake = true;
  }
});
