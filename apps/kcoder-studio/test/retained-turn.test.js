import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { injectRetainedTurnAuthority, PRIVATE_RETENTION_FIELD } from '../src/retention-context.js';

const authority = () => ({ gatewayNamespaceId: 'installation', deviceId: 'device',
  authorizationGeneration: 'generation-1', targetFingerprint: 'target',
  principal: { kind: 'localOs' }, workspaceTargetId: 'registered-target' });
const request = () => ({ jsonrpc: '2.0', id: 7, method: 'turn/start', params: {
  threadId: 'thread-a', clientMessageId: 'original-message', input: [{ type: 'text', text: 'hello' }],
  retention: { references: [{ retentionId: `r1.root.1.${'a'.repeat(32)}`, expectedRevision: 1, entryIds: ['entry-a'] }],
    attachments: [{ entryId: 'entry-a', filename: 'note.txt', mimeType: 'text/plain' }] },
} });

test('retained public metadata uses UTF8 and Unicode control boundaries matching Rust', () => {
  const valid = request();
  valid.params.clientMessageId = 'é'.repeat(128); // 256 UTF-8 bytes.
  valid.params.retention.references[0].entryIds = ['é'.repeat(128)];
  valid.params.retention.attachments[0].entryId = 'é'.repeat(128);
  valid.params.retention.attachments[0].filename = `${'é'.repeat(127)}x`; // 255 bytes.
  const projected = injectRetainedTurnAuthority(valid, authority());
  assert.deepEqual(projected.params, valid.params);
  assert.equal(projected[PRIVATE_RETENTION_FIELD].workspaceTargetId, 'registered-target');
  for (const mutate of [
    r => { r.params.clientMessageId = `${'é'.repeat(128)}x`; },
    r => { r.params.clientMessageId = 'bad\u0085id'; },
    r => { r.params.retention.attachments[0].filename = 'é'.repeat(128); },
    r => { r.params.retention.attachments[0].filename = 'bad\u0085name'; },
    r => { r.params.retention.references[0].entryIds = ['entry-a', 'entry-a']; },
    r => { r.params.retention.attachments = []; },
    r => { r.params.retention.attachments[0].path = '/foreign'; },
    r => { r.params.retention.trustedContext = authority(); },
    r => { r.params.retention.references[0].entryIds = ['bad\u0085id']; },
  ]) {
    const invalid = request(); mutate(invalid);
    assert.throws(() => injectRetainedTurnAuthority(invalid, authority()), e => e.code === -32602);
  }
});

async function fixture(t, backendReady = true) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const frames = []; let buffer = '';
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    buffer += chunk.toString();
    for (;;) { const index = buffer.indexOf('\n'); if (index < 0) break;
      frames.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
    done();
  } });
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'registered-target', residentThreads: true,
    retentionParentV1: true, maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => { broker.clearTransientState(); child.emit('close', 0, null);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  let current = authority();
  const client = { channel: 'runtime', authorizationOwner: 'owner', retentionAuthority: () => current,
    messages: [], send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  const reply = async (frame, result) => { child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`);
    await new Promise(resolve => setImmediate(resolve)); };
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-retained-turn', version: '1' } } }));
  await reply(frames.at(-1), { capabilities: { experimental: { residentThreads: true,
    stagedAttachmentRetentionReceiptsV1: backendReady } } });
  // Actual thread/resume path establishes the broker's owner gate.
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/resume', params: { threadId: 'thread-a' } }));
  await reply(frames.at(-1), { thread: { id: 'thread-a' } });
  return { broker, client, frames, reply, revoke() { current = { ...current, authorizationGeneration: 'generation-2' }; } };
}

test('retained turn uses current private authority and strips late success after generation drift', async t => {
  const f = await fixture(t);
  assert.equal(f.client.messages.find(m => m.id === 1).result.capabilities.experimental.stagedAttachmentRetentionReceiptsV1, false);
  const before = f.frames.length;
  f.broker.receive(f.client, JSON.stringify(request()));
  assert.equal(f.frames.length, before + 1);
  const frame = f.frames.at(-1);
  assert.deepEqual(frame.params.retention, request().params.retention);
  assert.equal(frame[PRIVATE_RETENTION_FIELD].context.authorizationGeneration, 'generation-1');
  f.revoke();
  await f.reply(frame, { turn: { id: 'turn-1', threadId: 'thread-a', attemptId: 'turn-1', status: 'running' } });
  const late = f.client.messages.find(m => m.id === 7);
  assert.equal(late.error.code, -32001);
  assert.equal(Object.hasOwn(late, 'result'), false);
});

test('legacy backend cannot receive retained turn while ordinary turns keep their existing path', async t => {
  const f = await fixture(t, false);
  const before = f.frames.length;
  f.broker.receive(f.client, JSON.stringify(request()));
  assert.equal(f.frames.length, before);
  assert.equal(f.client.messages.find(m => m.id === 7).error.code, -32001);
  const ordinary = request(); delete ordinary.params.retention; ordinary.id = 8;
  f.broker.receive(f.client, JSON.stringify(ordinary));
  assert.equal(f.frames.length, before + 1);
  assert.equal(Object.hasOwn(f.frames.at(-1), PRIVATE_RETENTION_FIELD), false);
});
