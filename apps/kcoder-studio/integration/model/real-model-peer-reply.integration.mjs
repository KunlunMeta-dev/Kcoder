import assert from 'node:assert/strict';
import { startGateway } from '../../e2e/harness/gateway.mjs';
import { startLiveModelObserver } from '../../e2e/harness/live-model-observer.mjs';
import { openOwnedPeerBrowserRuntime } from '../../e2e/harness/peer-browser-runtime.mjs';
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../e2e/harness/real-model.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';
import { runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';

process.umask(0o077);

await runIntegration(import.meta.url, {
  testId: 'real-model-peer-reply-when-needed', tier: 'real-model-credentialed',
  modelPolicy: 'Real model chooses whether and how to respond in two owned sessions. Maximum 16 requests, 512 output tokens per request, no retries, and a 120-second wait per turn.',
}, async context => {
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const observer = await startLiveModelObserver(context, model.providerConfig.endpoint, 16, {
    requestTimeoutMs: 90000,
    beforeForward: metadata => {
      assert.ok(metadata.outputTokenLimit <= 512, 'the live model output is bounded');
    },
  });
  const { path: sourceWorkspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'real-peer-source' });
  const { path: receiverWorkspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'real-peer-receiver' });
  const settingsFile = await context.writeStateJson('real-model-config/settings.json', {
    active_provider: model.provider,
    providers: { [model.provider]: { ...model.providerConfig, endpoint: observer.endpoint,
      no_proxy: true, discover_models: false, max_output_tokens: 512 } },
    permission_mode: 'yolo', max_tokens: 512, max_retries: 0, max_duration_secs: 120,
    auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
    tools: { profile: 'full', disabled: [] },
    cross_session_messages: { enabled: true, wake_idle: true },
  }, 0o400);
  const serverId = 'owned-model';
  const serversFile = await context.writeStateJson('servers.json', [{ id: serverId, label: 'Owned model target',
    transport: 'local', runtime: 'kcoder', command: model.kcoderBin, workspace: sourceWorkspace, settingsFile }]);
  const gateway = await startGateway(context, { workspace: sourceWorkspace, kcoderBin: model.kcoderBin, serversFile, auth: true,
    env: { KCODER_HOME: isolated.configDir, KCODER_CONFIG_DIR: isolated.configDir } });
  const options = { serverId, extraCapabilities: {
    crossSessionMessageRepliesV1: true, crossSessionMessageReceiptsV1: true,
  } };
  const source = await openOwnedPeerBrowserRuntime(context, gateway, { ...options, workspace: sourceWorkspace });
  const receiver = await openOwnedPeerBrowserRuntime(context, gateway, { ...options, workspace: receiverWorkspace });
  const turn = async (client, threadId, clientMessageId) => {
    await client.request('turn/start', { threadId, clientMessageId,
      input: [{ type: 'text', text: '这是一个独立的智能体协作测试。请简短回复“准备好了”。' }] });
    await waitFor(async () => {
      const { receipt } = await client.request('turn/receipt/read', { threadId, clientMessageId });
      assert.ok(!['failed', 'interrupted'].includes(receipt?.status), 'the owned seed turn failed');
      return receipt?.status === 'completed';
    }, 120000, 'real-model seed turn');
  };
  const completedPeerTurns = (client, threadId) => client.messages().filter(row =>
    row.method === 'turn/completed' && row.params?.threadId === threadId &&
    String(row.params?.turn?.id ?? row.params?.turnId ?? '').startsWith('peer-'));
  let stage = 'create owned sessions';
  const diagnostic = {};
  try {
    await source.request('runtime.workspaces.open', { workspacePath: receiverWorkspace });
    const { thread: sender } = await source.request('thread/start', {});
    const { thread: target } = await receiver.request('thread/start', {});
    stage = 'seed source';
    await turn(source, sender.id, 'real-peer-source-seed');
    stage = 'seed receiver';
    await turn(receiver, target.id, 'real-peer-target-seed');
    stage = 'discover receiver';
    let destination, cursor;
    for (let index = 0; index < 16; index++) {
      const page = await source.request('thread/agentMessage/targets', {
        sourceThreadId: sender.id, ...(cursor ? { cursor } : {}),
      });
      destination = page.targets.find(row => row.threadId === target.id);
      if (destination || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.ok(destination?.address && destination.allowedModes.includes('wake_if_idle'));
    stage = 'send question';
    const first = await source.request('thread/agentMessage/send', { sourceThreadId: sender.id, message: {
      targetThreadId: target.id, targetAddress: destination.address, clientMessageId: 'real-peer-question',
      mode: 'wake_if_idle', text: '你好！你能收到我的消息吗？请向我回复一下。',
    } });
    stage = 'wait for receiver';
    await waitFor(() => completedPeerTurns(receiver, target.id).length >= 1, 120000, 'the real receiver turn');
    let reply;
    stage = 'read reply';
    await waitFor(async () => {
      const history = await source.request('thread/read', { threadId: sender.id, limit: 64 });
      reply = history.messages.find(row => row.role === 'peer_agent' && row.agentMessage?.replyToMessageId === first.messageId);
      return Boolean(reply);
    }, 30000, 'the real model reply to arrive in the original sender history');
    assert.equal(reply.agentMessage.sourceThreadId, target.id);
    diagnostic.syntheticReply = typeof reply.content === 'string' ? context.redactText(reply.content).slice(0, 512) : null;
    stage = 'check sender does not acknowledge the reply';
    const beforeOutbox = await receiver.request('thread/agentMessage/receipts/list', { sourceThreadId: target.id, limit: 64 });
    const replyEntry = beforeOutbox.items.find(row => row.receipt?.messageId === reply.agentMessage.messageId);
    assert.ok(replyEntry && replyEntry.receipt?.replyToMessageId === first.messageId);
    assert.equal(replyEntry.mode, 'wake_if_idle', 'a timely answer must request the eligible sender wake');
    await waitFor(() => completedPeerTurns(source, sender.id).length >= 1, 120000, 'the original sender to process the reply');
    const senderOutbox = await source.request('thread/agentMessage/receipts/list', { sourceThreadId: sender.id, limit: 64 });
    diagnostic.senderOutbox = senderOutbox.items.map(row => ({ mode: row.mode, replyToMessageId: row.receipt?.replyToMessageId }));
    assert.deepEqual(senderOutbox.items.map(row => row.clientMessageId), ['real-peer-question'],
      'an answer without a new request must not trigger an automatic acknowledgement');
    const before = completedPeerTurns(receiver, target.id).length;
    stage = 'send completed exchange';
    const final = await source.request('thread/agentMessage/send', { sourceThreadId: sender.id, message: {
      targetThreadId: target.id, targetAddress: destination.address, clientMessageId: 'real-peer-complete',
      mode: 'wake_if_idle', text: '收到了，谢谢！本次协作结束，无需再回复。',
    } });
    stage = 'wait for completed exchange';
    await waitFor(() => completedPeerTurns(receiver, target.id).length > before, 120000, 'the real receiver to process the completed exchange');
    stage = 'check reply receipts';
    const outbox = await receiver.request('thread/agentMessage/receipts/list', { sourceThreadId: target.id, limit: 64 });
    assert.ok(outbox.items.some(row => row.receipt?.replyToMessageId === first.messageId));
    assert.deepEqual(outbox.items.map(row => row.clientMessageId).sort(), beforeOutbox.items.map(row => row.clientMessageId).sort(),
      'an explicitly completed exchange must not cause another send, linked or otherwise');
    assert.ok(observer.observations.some(row => row.status === 200));
    return { provider: model.provider, model: model.model, originalMessageId: first.messageId,
      replyMessageId: reply.agentMessage.messageId, completedExchangeMessageId: final.messageId,
      replyMode: replyEntry.mode, senderWakeChecked: replyEntry.mode === 'wake_if_idle',
      actualModelRequests: observer.observations.filter(row => row.request > 0).length };
  } finally {
    const rpcErrors = [...source.messages(), ...receiver.messages()].filter(row => row.error).map(row => ({
      code: row.error.code, message: row.error.message,
      stage: row.error.data?.stage, reason: row.error.data?.reason,
    }));
    await context.writeArtifactJson('provider-observations.json', { stage, rpcErrors, diagnostic, observations: observer.observations });
  }
});
