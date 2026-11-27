import assert from 'node:assert/strict';
import { startApprovalModelFixture } from '../../e2e/harness/approval-model.mjs';
import { startGateway } from '../../e2e/harness/gateway.mjs';
import { stopOwnedPeerWorkspaceProcess } from '../../e2e/harness/peer-workspace-process.mjs';
import { openOwnedPeerBrowserRuntime } from '../../e2e/harness/peer-browser-runtime.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';

process.umask(0o077);

// This fixture verifies routing and receipt identity, not autonomous model decisions.
await runIntegration(import.meta.url, {
  testId: 'peer-reply-from-woken-session-without-viewer', tier: 'full-integration',
  modelPolicy: 'A deterministic loopback Provider selects the normal send tool in two isolated workspaces. The receiver has no client while it replies.',
}, async context => {
  assert.equal(process.platform, 'linux', 'this test observes its owned app-server via /proc');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'KCoder Native candidate');
  const sourceMarker = 'OWNED_ORIGINAL_SENDER';
  const receiverMarker = 'OWNED_ORIGINAL_RECEIVER';
  const question = 'OWNED_AGENT_QUESTION';
  const answer = 'OWNED_AGENT_DIRECT_REPLY';
  const calls = new Map();
  const started = new Set();
  let recipient;
  let replyOutcome;
  let sourceSawReply = false;

  function peerReferences(messages) {
    return messages.flatMap(row => {
      const text = typeof row.content === 'string' ? row.content :
        Array.isArray(row.content) ? row.content.map(part => part.text ?? '').join('\n') : '';
      return text.split('\n').flatMap(line => {
        try {
          const value = JSON.parse(line.trim());
          return value?.kind === 'untrusted_peer_agent_reference' ? [value] : [];
        } catch {
          return [];
        }
      });
    });
  }

  function toolResult(body, id) {
    const row = body.messages.findLast(message => message.role === 'tool' && message.tool_call_id === id);
    if (!row) return undefined;
    const content = typeof row.content === 'string' ? row.content : JSON.stringify(row.content);
    const line = content.split('\n').find(value => value.includes('{'));
    assert.ok(line, 'the normal tool must report its original receipt or error');
    return JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
  }

  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    responseSteps: ({ body }) => {
      const transcript = JSON.stringify(body.messages);
      const finish = text => [{ delta: { content: text }, finishReason: 'stop' }];
      const references = peerReferences(body.messages);
      if (transcript.includes(receiverMarker)) {
        const inbound = references.find(reference => reference.text === question);
        if (!inbound) return finish('OWNED_RECEIVER_READY');
        const result = toolResult(body, 'owned-receiver-reply');
        if (result) {
          replyOutcome = result;
          return finish('OWNED_RECEIVER_FINISHED');
        }
        assert.ok(inbound.sourceAddress && inbound.messageId, 'the actual inbound metadata is available to the agent');
        assert.ok(!started.has('reply'), 'the receiver must not replay a send');
        started.add('reply');
        calls.set('originalInbound', inbound.messageId);
        const args = { targetThreadId: inbound.sourceThreadId, targetAddress: inbound.sourceAddress,
          replyToMessageId: inbound.messageId, mode: 'wake_if_idle', text: answer, clientMessageId: 'owned-receiver-reply' };
        return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'owned-receiver-reply', type: 'function',
          function: { name: 'SendSessionMessage', arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' }];
      }
      if (!transcript.includes(sourceMarker)) return finish('OWNED_SENDER_READY');
      if (references.some(reference => reference.text === answer)) {
        sourceSawReply = true;
        return finish('OWNED_SENDER_RECEIVED_REPLY');
      }
      const sent = toolResult(body, 'owned-source-send');
      if (sent) {
        calls.set('sent', sent);
        return [{ ready: () => replyOutcome !== undefined, delta: { content: 'OWNED_SENDER_CONTINUES' }, finishReason: 'stop' }];
      }
      assert.ok(recipient && !started.has('send'), 'send the owned message once');
      started.add('send');
      const args = { targetThreadId: recipient.threadId, targetAddress: recipient, mode: 'wake_if_idle',
        text: question, clientMessageId: 'owned-source-send' };
      return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'owned-source-send', type: 'function',
        function: { name: 'SendSessionMessage', arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' }];
    },
  });

  const sourceWorkspace = (await materializeWorkspace(context, 'minimal', { instanceId: 'reply-source' })).path;
  const targetWorkspace = (await materializeWorkspace(context, 'minimal', { instanceId: 'reply-target' })).path;
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
  const serverId = 'local-peer';
  const serversFile = await context.writeStateJson('servers.json', [{ id: serverId, label: 'Owned target',
    transport: 'local', runtime: 'kcoder', command: binary, workspace: sourceWorkspace, settingsFile }]);
  const gateway = await startGateway(context, { kcoderBin: binary, workspace: sourceWorkspace, serversFile, auth: true,
    env: { KCODER_HOME: profile, KCODER_CONFIG_DIR: profile, KCODER_STUDIO_APP_SERVER_IDLE_MS: '400' } });
  const open = workspace => openOwnedPeerBrowserRuntime(context, gateway, { serverId, workspace, extraCapabilities: {
    crossSessionMessageReceiptsV1: true, crossSessionMessageRepliesV1: true,
  } });
  const source = await open(sourceWorkspace);
  const receiver = await open(targetWorkspace);
  const turn = async (client, threadId, clientMessageId, text) => {
    await client.request('turn/start', { threadId, clientMessageId, input: [{ type: 'text', text }] });
    await waitFor(async () => {
      const { receipt } = await client.request('turn/receipt/read', { threadId, clientMessageId });
      assert.ok(!['failed', 'interrupted'].includes(receipt?.status));
      return receipt?.status === 'completed';
    }, 45000, 'owned turn completion');
  };
  try {
    await source.request('runtime.workspaces.open', { workspacePath: targetWorkspace });
    const { thread: sender } = await source.request('thread/start', {});
    const { thread: target } = await receiver.request('thread/start', {});
    await turn(source, sender.id, 'owned-source-seed', 'OWNED_SOURCE_SEED');
    await turn(receiver, target.id, 'owned-receiver-seed', receiverMarker);
    let cursor;
    for (let page = 0; page < 32; page++) {
      const result = await source.request('thread/agentMessage/targets', { sourceThreadId: sender.id, ...(cursor ? { cursor } : {}) });
      const found = result.targets.find(row => row.threadId === target.id);
      if (found) { recipient = found.address; break; }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.ok(recipient, 'find the exact destination and address');
    const { processId } = await receiver.request('server/resources/read');
    await receiver.close();
    await stopOwnedPeerWorkspaceProcess(context, { processId, gatewayPid: gateway.child.pid, binary, workspace: targetWorkspace });
    await turn(source, sender.id, 'owned-source-request', sourceMarker);
    assert.equal(replyOutcome?.clientMessageId, 'owned-receiver-reply', JSON.stringify(replyOutcome));
    assert.equal(replyOutcome?.replyToMessageId, calls.get('sent')?.messageId);
    assert.equal(calls.get('originalInbound'), calls.get('sent')?.messageId);
    await waitFor(() => sourceSawReply, 30000, 'the original sender agent to receive the reply');
    const history = await source.request('thread/read', { threadId: sender.id, limit: 64 });
    const rows = history.messages.filter(row => row.role === 'peer_agent' && row.content === answer);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agentMessage.messageId, replyOutcome.messageId);
    assert.equal(rows[0].agentMessage.replyToMessageId, calls.get('sent').messageId);
    return { noReceiverViewer: true, originalSend: calls.get('sent').messageId,
      directReply: replyOutcome.messageId, sourceSawReply, paidCalls: 0 };
  } finally {
    await context.writeArtifactJson('peer-background-reply-observation.json', {
      attempted: [...started], sent: calls.get('sent'), reply: replyOutcome, sourceSawReply,
    });
  }
});
