import assert from 'node:assert/strict';
import { startApprovalModelFixture } from '../../e2e/harness/approval-model.mjs';
import { startGateway } from '../../e2e/harness/gateway.mjs';
import { stopOwnedPeerWorkspaceProcess } from '../../e2e/harness/peer-workspace-process.mjs';
import { openOwnedPeerBrowserRuntime } from '../../e2e/harness/peer-browser-runtime.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';

process.umask(0o077);

// The fixed provider exercises the runtime and transport; it does not prove model judgement.
await runIntegration(import.meta.url, {
  testId: 'peer-background-conversation-without-viewer', tier: 'full-integration',
  modelPolicy: 'A deterministic loopback provider sends six linked exchanges between isolated sessions. The recipient has no viewer and is cold before the first message.',
}, async context => {
  assert.equal(process.platform, 'linux', 'the owned app-server is observed through /proc');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'KCoder Native candidate');
  const total = 6;
  const begun = new Set();
  const results = new Map();
  const received = new Set();
  let targetAddress;

  function peerReferences(messages) {
    return messages.flatMap(row => {
      const text = typeof row.content === 'string' ? row.content :
        Array.isArray(row.content) ? row.content.map(part => part.text ?? '').join('\n') : '';
      return text.split('\n').flatMap(line => {
        try {
          const value = JSON.parse(line.trim());
          return value?.kind === 'untrusted_peer_agent_reference' ? [value] : [];
        } catch { return []; }
      });
    });
  }
  function observeResults(messages) {
    for (const row of messages) {
      if (row.role !== 'tool' || !begun.has(row.tool_call_id) || results.has(row.tool_call_id)) continue;
      const content = typeof row.content === 'string' ? row.content : JSON.stringify(row.content);
      const line = content.split('\n').find(value => value.includes('{'));
      try {
        results.set(row.tool_call_id, line ? JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1)) : { error: content.slice(0, 256) });
      } catch { results.set(row.tool_call_id, { error: 'malformed tool result' }); }
    }
  }
  const finish = text => [{ delta: { content: text }, finishReason: 'stop' }];
  function send(id, target, text, original) {
    if (begun.has(id)) {
      assert.ok(results.has(id), 'an already started send must settle before the next provider call');
      return finish('OWNED_TURN_CONTINUES');
    }
    begun.add(id);
    const args = { targetThreadId: target.threadId, targetAddress: target,
      clientMessageId: id, text, ...(original ? { replyToMessageId: original } : {}) };
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
      function: { name: 'SendSessionMessage', arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' }];
  }
  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    responseSteps: ({ body }) => {
      observeResults(body.messages);
      const transcript = JSON.stringify(body.messages);
      const references = peerReferences(body.messages);
      if (transcript.includes('OWNED_RECEIVER_SEED')) {
        const incoming = references.filter(row => /^OWNED_PING_\d+$/.test(row.text)).at(-1);
        if (!incoming) return finish('OWNED_RECEIVER_READY');
        const n = Number(incoming.text.slice('OWNED_PING_'.length));
        assert.ok(n >= 1 && n <= total && incoming.sourceAddress && incoming.messageId);
        return send(`owned-pong-${n}`, incoming.sourceAddress, `OWNED_PONG_${n}`, incoming.messageId);
      }
      if (!transcript.includes('OWNED_SOURCE_START')) return finish('OWNED_SOURCE_READY');
      const incoming = references.filter(row => /^OWNED_PONG_\d+$/.test(row.text)).at(-1);
      if (!incoming) return send('owned-ping-1', targetAddress, 'OWNED_PING_1');
      const n = Number(incoming.text.slice('OWNED_PONG_'.length));
      assert.ok(n >= 1 && n <= total && incoming.sourceAddress && incoming.messageId);
      received.add(n);
      if (n === total) return finish('OWNED_CONVERSATION_COMPLETE');
      return send(`owned-ping-${n + 1}`, incoming.sourceAddress, `OWNED_PING_${n + 1}`, incoming.messageId);
    },
  });

  const sourceWorkspace = (await materializeWorkspace(context, 'minimal', { instanceId: 'conversation-source' })).path;
  const targetWorkspace = (await materializeWorkspace(context, 'minimal', { instanceId: 'conversation-target' })).path;
  const profile = context.pathInState('profile');
  const settingsFile = await context.writeStateJson('profile/settings.json', {
    active_provider: 'owned', permission_mode: 'yolo', credential_store: 'file', max_retries: 0,
    auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
    cross_session_messages: { enabled: true, wake_idle: true },
    providers: { owned: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'owned-model', no_proxy: true, discover_models: false,
      context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
      capabilities: { text: true, tools: true, reasoning: false } } },
  });
  const serverId = 'conversation-target';
  const serversFile = await context.writeStateJson('servers.json', [{ id: serverId, label: 'Owned target',
    transport: 'local', runtime: 'kcoder', command: binary, workspace: sourceWorkspace, settingsFile }]);
  const gateway = await startGateway(context, { kcoderBin: binary, workspace: sourceWorkspace, serversFile, auth: true,
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}),
    env: { KCODER_HOME: profile, KCODER_CONFIG_DIR: profile, KCODER_STUDIO_APP_SERVER_IDLE_MS: '400' } });
  const open = workspace => openOwnedPeerBrowserRuntime(context, gateway, { serverId, workspace, extraCapabilities: {
    sessionLifetimeV1: true, crossSessionMessageReceiptsV1: true, crossSessionMessageRepliesV1: true,
  } });
  const source = await open(sourceWorkspace);
  const receiver = await open(targetWorkspace);
  const turn = async (client, threadId, clientMessageId, text) => {
    await client.request('turn/start', { threadId, clientMessageId, input: [{ type: 'text', text }] });
    await waitFor(async () => {
      const { receipt } = await client.request('turn/receipt/read', { threadId, clientMessageId });
      assert.ok(!['failed', 'interrupted'].includes(receipt?.status));
      return receipt?.status === 'completed';
    }, 45000, 'owned seed completion');
  };
  try {
    await source.request('runtime.workspaces.open', { workspacePath: targetWorkspace });
    const { thread: sender } = await source.request('thread/start', {});
    // thread/start on the real sessionLifetimeV1 Gateway path automatically attaches this live source view.
    const sourceLifetime = await source.request('thread/lifetime/read', { threadId: sender.id });
    assert.equal(sourceLifetime.attachedClients, 1, 'the live source view must be an actual Gateway-managed attachment');
    const { thread: target } = await receiver.request('thread/start', {});
    await turn(source, sender.id, 'owned-source-seed', 'OWNED_SOURCE_SEED');
    await turn(receiver, target.id, 'owned-receiver-seed', 'OWNED_RECEIVER_SEED');
    let cursor;
    for (let page = 0; page < 32; page++) {
      const result = await source.request('thread/agentMessage/targets', { sourceThreadId: sender.id, ...(cursor ? { cursor } : {}) });
      const found = result.targets.find(row => row.threadId === target.id);
      if (found) { targetAddress = found.address; break; }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.ok(targetAddress, 'the exact destination must be discovered');
    const { processId } = await receiver.request('server/resources/read');
    await receiver.close();
    await stopOwnedPeerWorkspaceProcess(context, { processId, gatewayPid: gateway.child.pid, binary, workspace: targetWorkspace });
    const conversationMessageId = 'owned-conversation-start';
    await source.request('turn/start', { threadId: sender.id, clientMessageId: conversationMessageId,
      input: [{ type: 'text', text: 'OWNED_SOURCE_START' }] });
    await waitFor(() => {
      const failed = [...results].find(([, result]) => result.error || ['rejected_before_admission', 'unknown'].includes(result.status));
      assert.ok(!failed, `owned send failed: ${JSON.stringify(failed)}`);
      return received.has(total);
    }, 90000, 'the original sender to process all six replies without opening the recipient');
    await waitFor(() => results.size === total * 2, 15000, 'all original send outcomes');
    for (let n = 1; n <= total; n++) {
      const ping = results.get(`owned-ping-${n}`);
      const pong = results.get(`owned-pong-${n}`);
      assert.ok(ping?.messageId && pong?.messageId, `exchange ${n} has authoritative receipts`);
      assert.equal(pong.replyToMessageId, ping.messageId);
      if (n > 1) assert.equal(ping.replyToMessageId, results.get(`owned-pong-${n - 1}`).messageId);
    }
    const history = await source.request('thread/read', { threadId: sender.id, limit: 128 });
    assert.equal(history.messages.filter(row => row.role === 'peer_agent' && /^OWNED_PONG_\d+$/.test(row.content)).length, total);
    let initiatingTurnStatus;
    await waitFor(async () => {
      const result = await source.request('turn/receipt/read', { threadId: sender.id, clientMessageId: conversationMessageId });
      initiatingTurnStatus = result.receipt?.status;
      assert.ok(!['failed', 'interrupted', 'unknown'].includes(initiatingTurnStatus),
        `the initiating webpage turn did not complete cleanly: ${JSON.stringify(result.receipt)}`);
      return initiatingTurnStatus === 'completed';
    }, 15000, 'the initiating webpage turn receipt to complete');

    let finalAssistantTurn;
    let finalTurnCompletion;
    await waitFor(async () => {
      const finalHistory = await source.request('thread/read', { threadId: sender.id, limit: 128 });
      const markers = finalHistory.messages.filter(row => row.role === 'assistant' && row.content === 'OWNED_CONVERSATION_COMPLETE');
      if (markers.length === 0) return false;
      assert.equal(markers.length, 1, 'the final assistant marker must be persisted exactly once');
      finalAssistantTurn = markers[0];
      assert.ok(typeof finalAssistantTurn.turnId === 'string' && finalAssistantTurn.turnId.length > 0,
        'the persisted final assistant message must identify its turn');
      assert.ok(typeof finalAssistantTurn.attemptId === 'string' && finalAssistantTurn.attemptId.length > 0,
        'the persisted final assistant message must identify its attempt');
      assert.ok(!['failed', 'interrupted', 'unknown'].includes(finalAssistantTurn.status),
        `the persisted final assistant message is not successful: ${JSON.stringify(finalAssistantTurn)}`);
      assert.equal(finalAssistantTurn.error, undefined, 'the persisted final assistant message must have no error');

      finalTurnCompletion = source.messages().find(message => message.method === 'turn/completed' &&
        message.params?.threadId === sender.id &&
        message.params?.turnId === finalAssistantTurn.turnId &&
        message.params?.attemptId === finalAssistantTurn.attemptId &&
        message.params?.turn?.id === finalAssistantTurn.turnId &&
        message.params?.turn?.threadId === sender.id);
      if (!finalTurnCompletion) return false;
      assert.equal(finalTurnCompletion.params.turn.status, 'completed',
        `the final peer-woken turn did not complete: ${JSON.stringify(finalTurnCompletion.params.turn)}`);
      assert.ok(finalTurnCompletion.params.error == null,
        `the final peer-woken turn reported an error: ${JSON.stringify(finalTurnCompletion.params.error)}`);
      return true;
    }, 15000, 'the persisted final assistant turn and its matching terminal event');

    return { exchanges: total, receiverViewerClosed: true, senderProcessedLastReply: true,
      initiatingTurnStatus, finalAssistantTurnId: finalAssistantTurn.turnId,
      finalAssistantAttemptId: finalAssistantTurn.attemptId,
      finalAssistantTurnStatus: finalTurnCompletion.params.turn.status, paidCalls: 0 };
  } finally {
    await context.writeArtifactJson('peer-background-conversation-observation.json', {
      begun: [...begun], received: [...received], results: Object.fromEntries(results),
      providerRequests: model.requests.map((body, index) => ({ index,
        startedAfterMs: model.requestOutcomes[index]?.startedAtMs - model.requestOutcomes[0]?.startedAtMs,
        actor: JSON.stringify(body.messages).includes('OWNED_RECEIVER_SEED') ? 'receiver' : 'sender',
        references: peerReferences(body.messages).map(row => row.text),
        toolResults: body.messages.filter(row => row.role === 'tool').map(row => row.tool_call_id),
      })),
      senderEvents: source.messages().filter(row => /^(turn|item)\//.test(row.method ?? '')).map(row => ({
        method: row.method, threadId: row.params?.threadId, turnId: row.params?.turnId,
        attemptId: row.params?.attemptId, type: row.params?.item?.type, status: row.params?.turn?.status,
      })),
    });
  }
});
