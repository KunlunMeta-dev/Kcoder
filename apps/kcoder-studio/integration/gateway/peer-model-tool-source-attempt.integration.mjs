import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { startPeerSshTargets } from '../../e2e/harness/peer-ssh-targets.mjs';

process.umask(0o077);
await runIntegration(import.meta.url, {
  testId: 'actual-model-tool-source-attempt-cross-manager', tier: 'full-integration',
  modelPolicy: 'Actual HTTP-login Gateway and local/owned loopback SSH app-servers; deterministic model protocol selects real ListSessions/SendSessionMessage/GetSessionMessageReceipt tools. No private host, paid model, distinct UID or autonomous behavior claim.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed current Native');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const marker = 'OWNED_MODEL_TOOL_SOURCE_SCOPE';
  const peerText = 'OWNED_REAL_MODEL_TOOL_ENQUEUE';
  const toolResults = [], failures = [], discoveryPages = [];
  const maximumDiscoveryPages = 32;
  let targetId, selected, sent, received, sourceRequests = 0, pendingTool;
  const fixture = await startPeerSshTargets(context, binary, { modelOptions: {
    responseSteps: ({ body }) => {
      if (!JSON.stringify(body.messages).includes(marker)) return [{ delta: { content: 'OWNED_CROSS_TARGET_PEER_READY' }, finishReason: 'stop' }];
      assert.ok(++sourceRequests <= maximumDiscoveryPages + 3, 'Only bounded original discovery pages followed by one Send and Get may run');
      const results = body.messages.filter(message => message.role === 'tool');
      const tool = (name, args) => {
        pendingTool = name;
        return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `owned-model-source-${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' }];
      };
      if (!results.length) return tool('ListSessions', { title: '安装包', allowedMode: 'enqueue_only', limit: 32 });
      const last = results.at(-1);
      const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      toolResults.push({ toolCallId: last.tool_call_id, text });
      if (text.startsWith('Tool `')) {
        failures.push({ toolCallId: last.tool_call_id, text });
        return [{ delta: { content: 'OWNED_NATIVE_TOOL_FAILURE_RETAINED' }, finishReason: 'stop' }];
      }
      const value = JSON.parse(text);
      if (pendingTool === 'ListSessions') {
        discoveryPages.push({ coverage: value.coverage, completeness: value.completeness, targets: value.targets, nextCursor: value.nextCursor });
        assert.ok(value.targets.every(row => row.title?.includes('安装包')), 'ListSessions must apply the model-supplied title filter');
        selected = value.targets?.find(target => target.threadId === targetId);
        if (!selected && value.nextCursor) {
          assert.ok(discoveryPages.length < maximumDiscoveryPages, 'The real target must be found within bounded actual model discovery pages');
          return tool('ListSessions', { cursor: value.nextCursor });
        }
        assert.ok(selected?.address && selected.allowedModes.includes('enqueue_only'), 'The actual ListSessions model result must identify the real other target');
        return tool('SendSessionMessage', { targetThreadId: selected.threadId, targetAddress: selected.address, mode: 'enqueue_only', text: peerText });
      }
      if (pendingTool === 'SendSessionMessage') {
        sent = value.receipt ?? value;
        assert.ok(sent.messageId && sent.clientMessageId, 'Use only the original actual Send tool receipt');
        return tool('GetSessionMessageReceipt', { clientMessageId: sent.clientMessageId });
      }
      received = value.receipt;
      assert.equal(received?.messageId, sent.messageId);
      assert.equal(received.clientMessageId, sent.clientMessageId);
      return [{ delta: { content: 'OWNED_MODEL_TOOL_SOURCE_SCOPE_COMPLETE' }, finishReason: 'stop' }];
    },
  } });
  const target = await fixture.seed('peer-ssh'); targetId = target.id;
  const source = fixture.clients.get('peer-local'), receiver = fixture.clients.get('peer-ssh');
  await receiver.request('thread/metadata/update', { threadId: targetId, title: 'Windows 安装包联验' });
  const { thread } = await source.request('thread/start', {});
  const clientMessageId = 'owned-model-tool-original-user';
  await source.request('turn/start', { threadId: thread.id, clientMessageId, input: [{ type: 'text', text: marker }] });
  let terminal;
  try {
    await waitFor(async () => {
      terminal = (await source.request('turn/receipt/read', { threadId: thread.id, clientMessageId })).receipt;
      return ['completed', 'failed', 'interrupted'].includes(terminal?.status);
    }, 45000, 'actual original model-tool turn terminal');
    assert.deepEqual(failures, [], 'Actual model received a Native ToolError; never replace it with successful JSON');
    assert.equal(terminal.status, 'completed');
    assert.equal(sourceRequests, discoveryPages.length + 3, 'Only real List pages, one Send, one Get and one final response are allowed');
    assert.ok(selected && sent && received, 'All three actual tools must cross their real manager/Gateway route');
    let applied;
    await waitFor(async () => {
      applied = (await source.request('thread/agentMessage/get', { sourceThreadId: thread.id, query: { clientMessageId: sent.clientMessageId } })).receipt;
      return applied?.status === 'applied';
    }, 30000, 'same original model-tool message Applied');
    assert.equal(applied.messageId, sent.messageId);
    const history = await receiver.request('thread/read', { threadId: targetId, limit: 100 });
    assert.equal(history.messages.filter(row => row.origin === 'peer_agent' && row.content === peerText).length, 1);
    assert.equal(history.messages.filter(row => row.role === 'user').length, 1);
    assert.equal(fixture.model.requests.length, sourceRequests + 1, 'Enqueue-only adds no receiver Provider or fake User beyond its one seed');
    return { actualModelTools: ['ListSessions', 'SendSessionMessage', 'GetSessionMessageReceipt'], discoveryPageCount: discoveryPages.length, originalMessageId: sent.messageId, originalClientMessageId: sent.clientMessageId, sourceRequests, totalProviderRequests: fixture.model.requests.length, receiverSeedRequests: 1, receiverEnqueueRequests: 0, fakeUserPrompts: 0, paidCalls: 0 };
  } finally {
    await context.writeArtifactJson('model-tool-source-attempt.json', { binary, binarySha256, sourceThreadId: thread.id, targetThreadId: targetId, terminal, sourceRequests, discoveryPages, selected, sent, received, failures, toolResults });
  }
});
