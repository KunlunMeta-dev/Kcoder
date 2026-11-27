import assert from 'node:assert/strict';
import { startApprovalModelFixture } from '../../e2e/harness/approval-model.mjs';
import { stopOwnedPeerWorkspaceProcess } from '../../e2e/harness/peer-workspace-process.mjs';
import { startGateway } from '../../e2e/harness/gateway.mjs';
import { openOwnedPeerBrowserRuntime } from '../../e2e/harness/peer-browser-runtime.mjs';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';

process.umask(0o077);
await runIntegration(import.meta.url, {
  testId: 'peer-wake-after-destination-workspace-exit', tier: 'full-integration',
  modelPolicy: 'Real authenticated Studio Gateway, one local target, two workspaces, deterministic Provider. Each send is made once by the source model tool. The destination has no viewer until its own wake turn replies.',
}, async context => {
  assert.equal(process.platform, 'linux', 'this actual process-exit fixture requires a Linux pidfd');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'peer Native candidate');
  const sourceMarker = 'OWNED_SOURCE_PEER_SEND';
  const seedMarker = 'OWNED_COLD_RECIPIENT_SEED';
  const queuedText = 'OWNED_COLD_QUEUED_MESSAGE';
  const wakeText = 'OWNED_COLD_WAKE_MESSAGE';
  const wakeReply = 'OWNED_COLD_RECIPIENT_REPLIED';
  const replyMarker = 'OWNED_LINK_REPLY_NOW';
  const replyText = 'OWNED_LINKED_RESPONSE';
  const sends = new Map();
  const started = new Set();
  const plans = new Map();
  const evidence = { receiverWakeRequests: 0, originalTargetExited: false };
  let targetAddress;
  const model = await startApprovalModelFixture(context, { textOnly: true,
    responseSteps: ({ body }) => {
      const messages = JSON.stringify(body.messages);
      const finish = content => [{ delta: { content }, finishReason: 'stop' }];
      let action;
      let args;
      if (messages.includes(seedMarker)) {
        if (messages.includes(replyMarker)) {
          action = 'linked-response';
          const reference = body.messages.flatMap(row => {
            const text = typeof row.content === 'string' ? row.content :
              (Array.isArray(row.content) ? row.content.map(part => part.text ?? '').join('\n') : '');
            return text.split('\n').flatMap(line => {
              try { const ref = JSON.parse(line.trim()); return ref?.kind === 'untrusted_peer_agent_reference' ? [ref] : []; }
              catch { return []; }
            });
          }).find(ref => ref.text === wakeText);
          assert.ok(reference?.sourceAddress && reference.messageId, 'model sees original peer MID and full return address');
          args = { targetThreadId: reference.sourceThreadId, targetAddress: reference.sourceAddress, mode: 'enqueue_only',
            clientMessageId: 'owned-linked-reply', replyToMessageId: reference.messageId, text: replyText };
        } else if (messages.includes(wakeText)) {
          evidence.receiverWakeRequests++;
          return finish(wakeReply);
        } else return finish('OWNED_SEED_COMPLETE');
      } else {
        const latestInput = body.messages.findLast(row => row.role === 'user' && JSON.stringify(row.content).includes(sourceMarker));
        const marker = JSON.stringify(latestInput?.content ?? '');
        action = [...plans.keys()].sort((a, b) => b.length - a.length).find(key => marker.includes(sourceMarker + ' ' + key));
        if (!action) return finish('OWNED_READY');
        args = plans.get(action);
      }
      const callId = 'owned-' + action;
      const result = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === callId);
      if (result) {
        const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
        // A failed tool's first line carries the original rejection JSON. Later lines may contain a schema example.
        const line = text.split('\n').find(part => part.includes('{'));
        const value = line ? JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1)) : undefined;
        sends.set(action, value?.receipt ?? value);
        return finish('OWNED_SEND_COMPLETE');
      }
      if (started.has(action)) return finish('OWNED_SEND_ALREADY_ATTEMPTED');
      started.add(action);
      return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function',
        function: { name: action.startsWith('outbox') ? 'ListSessionMessageReceipts' : 'SendSessionMessage', arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' }];
    },
  });
  const sourceWorkspace = (await materializeWorkspace(context, 'minimal', { instanceId: 'peer-sender' })).path;
  const destinationWorkspace = (await materializeWorkspace(context, 'minimal', { instanceId: 'peer-receiver' })).path;
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
  const serversFile = await context.writeStateJson('servers.json', [{ id: serverId, label: 'Owned local target',
    transport: 'local', runtime: 'kcoder', command: binary, workspace: sourceWorkspace, settingsFile }]);
  const gateway = await startGateway(context, { kcoderBin: binary, workspace: sourceWorkspace, serversFile, auth: true,
    gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT,
    env: { KCODER_HOME: profile, KCODER_CONFIG_DIR: profile, KCODER_STUDIO_APP_SERVER_IDLE_MS: '400' } });
  const open = workspace => openOwnedPeerBrowserRuntime(context, gateway, { serverId, workspace, extraCapabilities: {
    crossSessionMessageReceiptsV1: true, crossSessionMessageRepliesV1: true,
  } });
  const source = await open(sourceWorkspace);
  const receiver = await open(destinationWorkspace);
  const turn = async (client, threadId, clientMessageId, text) => {
    await client.request('turn/start', { threadId, clientMessageId, input: [{ type: 'text', text }] });
    await waitFor(async () => {
      const { receipt } = await client.request('turn/receipt/read', { threadId, clientMessageId });
      assert.ok(!['failed', 'interrupted'].includes(receipt?.status));
      return receipt?.status === 'completed';
    }, 30000, 'owned foreground turn to complete');
  };
  try {
    await source.request('runtime.workspaces.open', { workspacePath: destinationWorkspace });
    const { thread: sender } = await source.request('thread/start', {});
    const { thread: target } = await receiver.request('thread/start', {});
    await turn(source, sender.id, 'owned-sender-seed', 'OWNED_SENDER_SEED');
    await turn(receiver, target.id, 'owned-recipient-seed', seedMarker);
    let cursor;
    for (let i = 0; i < 32; i++) {
      const page = await source.request('thread/agentMessage/targets', { sourceThreadId: sender.id,
        ...(cursor ? { cursor } : {}) });
      const match = page.targets.find(row => row.threadId === target.id);
      if (match) {
        assert.ok(match.allowedModes.includes('wake_if_idle'));
        targetAddress = match.address;
        break;
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.ok(targetAddress, 'discover the real other workspace address');
    const { processId } = await receiver.request('server/resources/read');
    assert.ok(Number.isSafeInteger(processId) && processId > 0);
    await receiver.close();
    await stopOwnedPeerWorkspaceProcess(context, {
      processId, gatewayPid: gateway.child.pid, binary, workspace: destinationWorkspace,
    });
    evidence.originalTargetExited = true;

    for (const [mode, text] of [['enqueue_only', queuedText], ['wake_if_idle', wakeText]]) {
      plans.set(mode, { targetThreadId: targetAddress.threadId, targetAddress, mode, text,
        clientMessageId: 'cold-workspace-' + mode });
    }
    await turn(source, sender.id, 'owned-source-queue', sourceMarker + ' enqueue_only');
    const queued = sends.get('enqueue_only');
    assert.ok(queued?.messageId, 'receive a receipt for the saved session after its process exited');
    assert.equal(queued.clientMessageId, 'cold-workspace-enqueue_only');
    assert.equal(evidence.receiverWakeRequests, 0);

    await turn(source, sender.id, 'owned-source-wake', sourceMarker + ' wake_if_idle');
    const wake = sends.get('wake_if_idle');
    assert.ok(wake?.messageId, 'receive a receipt for the explicit cold wake');
    assert.equal(wake.clientMessageId, 'cold-workspace-wake_if_idle');
    // Polling a Gateway receipt can itself acquire a workspace broker. Observe the
    // Provider directly until the recipient runs so that polling cannot cause success.
    await waitFor(() => evidence.receiverWakeRequests > 0, 25000, 'recipient to run without another viewer or receipt lookup');

    const reader = await open(destinationWorkspace);
    await waitFor(async () => {
      const history = await reader.request('thread/read', { threadId: target.id, limit: 32 });
      const peers = history.messages.filter(row => row.role === 'peer_agent');
      if (!history.messages.some(row => row.role === 'assistant' && row.content === wakeReply)) return false;
      assert.deepEqual(peers.map(row => row.content), [queuedText, wakeText]);
      assert.equal(history.messages.filter(row => row.role === 'user').length, 1);
      return true;
    }, 10000, 'one peer history row per send and the actual receiver reply');
    for (const original of [queued, wake]) {
      const { receipt } = await source.request('thread/agentMessage/get', { sourceThreadId: sender.id,
        query: { clientMessageId: original.clientMessageId } });
      assert.equal(receipt?.messageId, original.messageId);
      assert.equal(receipt.status, 'applied');
    }
    assert.equal(evidence.receiverWakeRequests, 1);

    const filters = { targetThreadId: target.id, status: 'applied', createdAfterMs: Date.now() - 3600000,
      createdBeforeMs: Date.now() + 60000 };
    const recovered = [];
    let next;
    for (let i = 0; i < 12; i++) {
      const action = 'outbox-' + i;
      plans.set(action, { ...filters, limit: i ? 32 : 1, ...(next ? { cursor: next } : {}) });
      await turn(source, sender.id, 'owned-' + action, sourceMarker + ' ' + action);
      const page = sends.get(action);
      assert.ok(Array.isArray(page?.items), 'actual ListSessionMessageReceipts model result');
      assert.equal(page.unconfirmedCount, 0);
      for (const item of page.items) {
        assert.equal(item.confirmation, 'confirmed');
        assert.equal(item.receipt.status, 'applied');
        assert.ok(item.createdAtMs >= filters.createdAfterMs && item.expiresAtMs > item.createdAtMs);
        assert.deepEqual(item.targetAddress, targetAddress);
        recovered.push(item.receipt.messageId);
      }
      next = page.nextCursor;
      if (!next) break;
    }
    assert.ok(!next);
    assert.deepEqual(recovered.sort(), [queued.messageId, wake.messageId].sort());
    evidence.step = 'public-receipt-list';
    const none = await source.request('thread/agentMessage/receipts/list', { sourceThreadId: sender.id, ...filters, status: 'expired' });
    assert.deepEqual(none.items, []);
    evidence.step = 'authenticated-reply-turn';
    const resumed = await reader.request('thread/resume', { threadId: target.id });
    assert.equal(resumed.thread.id, target.id);
    await turn(reader, target.id, 'owned-return-linked', replyMarker);
    const reply = sends.get('linked-response');
    assert.equal(reply?.replyToMessageId, wake.messageId);
    await turn(source, sender.id, 'owned-consume-linked', 'OWNED_COLLECT_RESPONSE');
    await waitFor(async () => {
      const returned = await source.request('thread/read', { threadId: sender.id, limit: 64 });
      const linked = returned.messages.filter(row => row.role === 'peer_agent' && row.content === replyText);
      if (linked.length === 0) return false;
      assert.equal(linked.length, 1);
      assert.equal(linked[0].agentMessage.messageId, reply.messageId);
      assert.equal(linked[0].agentMessage.replyToMessageId, wake.messageId);
      return true;
    }, 15000, 'the queued linked reply to be appended exactly once');
    evidence.recoveredOutboundReceipts = recovered.length;
    evidence.linkedReplyInOriginalHistory = true;

    evidence.step = 'same-workspace-rejections';
    const { thread: archived } = await source.request('thread/start', {});
    await turn(source, archived.id, 'owned-archived-seed', 'OWNED_ARCHIVED_SEED');
    await source.request('thread/metadata/update', { threadId: archived.id, archivedAt: new Date().toISOString() });
    const refusals = [];
    for (const [name, id] of [['archived', archived.id], ['missing', 'owned-target-never-created']]) {
      const clientMessageId = 'local-refusal-' + name;
      plans.set(name, { targetThreadId: id, clientMessageId, mode: 'enqueue_only', text: 'OWNED_LOCAL_REFUSAL' });
      await turn(source, sender.id, 'owned-local-' + name, sourceMarker + ' ' + name);
      const lookup = await source.request('thread/agentMessage/get', { sourceThreadId: sender.id, query: { clientMessageId } });
      refusals.push({ name, clientMessageId, receipt: lookup.receipt });
    }
    const forgedCid = 'local-refusal-forged-reference';
    plans.set('forged', { targetThreadId: target.id, targetAddress, clientMessageId: forgedCid,
      mode: 'enqueue_only', text: 'OWNED_FORGED_REFERENCE', replyToMessageId: wake.messageId });
    await turn(source, sender.id, 'owned-forged-reference', sourceMarker + ' forged');
    const forged = await source.request('thread/agentMessage/get', { sourceThreadId: sender.id, query: { clientMessageId: forgedCid } });
    refusals.push({ name: 'forged', clientMessageId: forgedCid, receipt: forged.receipt });
    for (const { name, clientMessageId, receipt } of refusals) {
      const refusal = sends.get(name);
      assert.equal(refusal?.status, 'rejected_before_admission', name + ' must be refused by the model tool');
      assert.equal(refusal.clientMessageId, clientMessageId);
      assert.equal(receipt, null, name + ' must have no destination receipt');
    }
    return { originalDestinationExited: true, noViewerWake: true, uniquePeerRows: 2,
      missingAndArchivedModelSendsRefused: true, outboundReceiptsRecovered: 2, explicitLinkedReply: true, forgedReplyRefused: true, paidCalls: 0 };
  } catch (error) {
    const denied = source.messages().findLast(frame => frame.error && frame.id !== undefined)?.error;
    if (denied) evidence.sourceRpcError = { code: denied.code, reason: denied.data?.reason ?? null };
    throw error;
  } finally {
    await context.writeArtifactJson('cold-workspace-evidence.json', { ...evidence, attempts: [...started],
      originalReceipts: [...sends].map(([mode, row]) => ({ mode, status: row?.status, messageId: row?.messageId })) });
  }
});
