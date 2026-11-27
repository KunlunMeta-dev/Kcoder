import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../e2e/harness/approval-model.mjs';
import { startGateway } from '../../e2e/harness/gateway.mjs';
import { openOwnedPeerBrowserRuntime } from '../../e2e/harness/peer-browser-runtime.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';

process.umask(0o077);

const wakeBody = 'OWNED_WAKE_READ_TRIGGER';
const readerSeed = 'OWNED_PEER_READ_RECEIVER';
const senderPrompt = 'OWNED_SEND_WAKE_READ';
const readerComplete = 'OWNED_BACKGROUND_READS_COMPLETE';
const initialOutboxId = 'owned-original-outbox-id';

function foundToolResult(messages, toolCallId) {
  const row = messages.findLast(message => message.role === 'tool' && message.tool_call_id === toolCallId);
  if (!row) return null;
  let parsed;
  try { parsed = typeof row.content === 'string' ? JSON.parse(row.content) : row.content; }
  catch {
    const code = String(row.content).match(/(?:peer_message|session_discovery)_[a-z_]+/)?.[0] ?? 'invalid-result';
    throw new Error(`Original tool ${toolCallId} failed with ${code}`);
  }
  return parsed;
}
function tool(id, name, args) {
  return [{ delta: { role: 'assistant', tool_calls: [{
    index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] }, finishReason: 'tool_calls' }];
}
const finish = content => [{ delta: { content }, finishReason: 'stop' }];

await runIntegration(import.meta.url, {
  testId: 'actual-local-peer-reads-during-a-wake-turn',
  tier: 'full-integration',
  modelPolicy: 'Real logged-in Gateway and one Native workspace with two sessions. The deterministic loopback Provider exercises owned peer wake and read tool execution. No paid model, distinct runtime target, or model autonomy claim.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed Native for wake reads');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  let senderId, recipientId;
  const results = new Map();
  let requests = 0;
  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    responseSteps: ({ body }) => {
      assert.ok(++requests <= 10, 'the owned fixture must stay within its planned rounds');
      const messages = body.messages;
      const transcript = JSON.stringify(messages);
      if (transcript.includes(readerSeed)) {
        if (!transcript.includes(wakeBody)) {
          const seeded = foundToolResult(messages, 'owned-peer-read-seed-outbox');
          if (seeded) {
            results.set('seed', seeded.receipt ?? seeded);
            return finish('OWNED_PEER_READ_RECEIVER_READY');
          }
          return tool('owned-peer-read-seed-outbox', 'SendSessionMessage', {
            targetThreadId: senderId, mode: 'enqueue_only',
            clientMessageId: initialOutboxId, text: 'OWNED_INITIAL_OUTGOING_PEER_MESSAGE',
          });
        }
        for (const [id, name, params] of [
          ['owned-get-on-wake', 'GetSessionMessageReceipt', { clientMessageId: initialOutboxId }],
          ['owned-list-on-wake', 'ListSessionMessageReceipts', { limit: 10 }],
          ['owned-discover-on-wake', 'ListSessions', { limit: 20 }],
        ]) {
          const result = foundToolResult(messages, id);
          if (!result) return tool(id, name, params);
          results.set(id, result);
        }
        return finish(readerComplete);
      }
      if (!transcript.includes(senderPrompt)) return finish('OWNED_SENDER_READY');
      const sent = foundToolResult(messages, 'owned-send-for-wake-read');
      if (sent) return finish('OWNED_SENT_WAKE_TRIGGER');
      return tool('owned-send-for-wake-read', 'SendSessionMessage', {
        targetThreadId: recipientId, mode: 'wake_if_idle',
        clientMessageId: 'owned-wake-read-trigger', text: wakeBody,
      });
    },
  });
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
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
  const serverId = 'owned-peer-local';
  const serversFile = await context.writeStateJson('servers.json', [{
    id: serverId, label: 'Owned peer workspace', transport: 'local', runtime: 'kcoder',
    command: binary, workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, { kcoderBin: binary, workspace, serversFile, auth: true,
    env: { KCODER_HOME: profile, KCODER_CONFIG_DIR: profile } });
  const open = () => openOwnedPeerBrowserRuntime(context, gateway, {
    serverId, workspace, extraCapabilities: { crossSessionMessageReceiptsV1: true },
  });
  const source = await open(), receiver = await open();
  async function turn(client, threadId, clientMessageId, text) {
    await client.request('turn/start', { threadId, clientMessageId, input: [{ type: 'text', text }] });
    await waitFor(async () => {
      const { receipt } = await client.request('turn/receipt/read', { threadId, clientMessageId });
      assert.ok(!['failed', 'interrupted'].includes(receipt?.status), 'the owned user turn must finish');
      return receipt?.status === 'completed';
    }, 30_000, 'original client turn completion');
  }
  senderId = (await source.request('thread/start', {})).thread.id;
  recipientId = (await receiver.request('thread/start', {})).thread.id;
  await turn(source, senderId, 'owned-read-sender-seed', 'OWNED_READ_SENDER_SEED');
  await turn(receiver, recipientId, 'owned-read-receiver-seed', readerSeed);
  const seed = results.get('seed');
  assert.equal(seed?.clientMessageId, initialOutboxId);
  assert.ok(seed?.messageId);
  await receiver.close();
  await turn(source, senderId, 'owned-read-wake-send', senderPrompt);
  await waitFor(() => results.has('owned-discover-on-wake'), 30_000, 'three original tools in the wake turn');
  await waitFor(async () => {
    const history = await source.request('thread/read', { threadId: recipientId, limit: 30 });
    return history.messages.some(row => row.role === 'assistant' && row.content === readerComplete);
  }, 20_000, 'saved completion from the original wake turn');

  const get = results.get('owned-get-on-wake');
  assert.equal((get.receipt ?? get).messageId, seed.messageId);
  const list = results.get('owned-list-on-wake');
  const row = list.items.find(item => item.clientMessageId === initialOutboxId);
  assert.equal(row?.confirmation, 'confirmed');
  assert.equal(row?.receipt?.messageId, seed.messageId);
  assert.equal(list.unconfirmedCount, 0);
  const discovery = results.get('owned-discover-on-wake');
  assert.equal(discovery.completeness, 'partial');
  assert.ok(discovery.targets.some(target => target.threadId === senderId), 'local discovery keeps the sender visible');
  assert.equal(requests, 9);
  await context.writeArtifactJson('wake-read-facts.json', {
    binarySha256, sameHost: true, receiverViewerClosed: true, originalReceiptRead: true,
    listConfirmation: row.confirmation, discoveryCompleteness: discovery.completeness,
    providerRequests: requests,
  });
  return { wakeReadsVerified: true, providerAutonomyVerified: false };
});
