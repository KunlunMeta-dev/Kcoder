import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WorkspaceAppServerBroker } from './workspace-app-server-broker.js';
import { publicSharedCapabilities, requestsDedicatedCapabilities } from './broker-native-session-capabilities.js';
import { PRIVATE_MIGRATION_SOURCE_FIELD, MIGRATION_SOURCE_INTERNAL_PREFIX as PREFIX,
  hasPrivateMigrationSourceField, migrationSourcePrivateFrame } from './migration-source-private.js';

function fixture(t, { trusted = true, sourceTrusted = false, capable = true, recovery = false, nativeRemoteHostBackchannel } = {}) {
  const child = new EventEmitter(), frames = [];
  let buffered = '';
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\n'); buffered = lines.pop();
    for (const line of lines) if (line) frames.push(JSON.parse(line));
    done();
  } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, retentionParentV1: trusted, migrationSourceParentV1: sourceTrusted, residentThreads: true, nativeRemoteHostBackchannel,
    adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) }, maxMessageBytes: 2 * 1024 * 1024 });
  broker.initializeResponse = { result: { capabilities: { experimental: { migrationSourceTransferInternalV1: capable,
    migrationSourceTransferTargetRecoveryV1: recovery } } } };
  const replies = [], client = { channel: 'thread', initialized: true, send: value => replies.push(value), close() {} };
  broker.clients.add(client);
  t.after(() => child.emit('close', 0));
  return { broker, child, client, frames, replies };
}

test('raw clients cannot inject private migration authority, including escaped and duplicate keys', t => {
  const { broker, client, frames, replies } = fixture(t);
  const raws = [
    `{"jsonrpc":"2.0","id":1,"method":"${PREFIX}identity","params":{}}`,
    `{"jsonrpc":"2.0","id":2,"method":"thread/read","params":{"${PRIVATE_MIGRATION_SOURCE_FIELD}":{}}}`,
    '{"jsonrpc":"2.0","id":3,"method":"thread/read","params":{"kcoderPrivateMigrationSource":{},"params":{}},"params":{}}',
    '{"jsonrpc":"2.0","id":4,"method":"thread/read","params":{"kcoderPrivateMigrationSour\\u0063e":{}}}',
  ];
  for (const raw of raws) broker.receive(client, raw);
  assert.equal(replies.length, 4);
  assert.ok(replies.every(reply => reply.error.code === -32602));
  assert.equal(frames.length, 0);
  assert.equal(hasPrivateMigrationSourceField('{"text":"kcoderPrivateMigrationSource: safe data"}'), false);
});

test('ordinary clients cannot issue Native remote host calls or forge its private responses', t => {
  const { broker, client, frames, replies } = fixture(t);
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'server/nativeRemote/open', params: { owner: true } },
    { jsonrpc: '2.0', id: 'native-remote-host-actual-epoch:1', result: { opened: true } },
    { jsonrpc: '2.0', id: 'native-remote-host-actual-epoch:2', error: { code: 1, message: 'claimed' } },
  ]) broker.receive(client, JSON.stringify(message));
  assert.equal(frames.length, 0);
  assert.equal(replies.length, 3);
  assert.ok(replies.every(reply => reply.error.code === -32601));
});

test('Native host requests without a captured callback are refused before browser forwarding', t => {
  const { child, frames, replies } = fixture(t);
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'native-remote-host-owned:1',
    method: 'server/nativeRemote/open', params: { endpointId: 'claimed-name' } }) + '\n');
  assert.equal(replies.length, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].error.code, -32601);
  assert.equal(frames[0].error.message, 'Native Remote host owner unavailable');
});

test('broker failure closes its Native host lane before the child exits', t => {
  let closed = 0;
  const { broker, child } = fixture(t, { nativeRemoteHostBackchannel: {
    receiveBackend() { return true; }, close() { closed += 1; },
  } });
  broker.fail(new Error('owned source disconnected'));
  assert.equal(closed, 1);
  child.emit('close', 0);
  assert.equal(closed, 1);
});

test('only private peer acceptance receives the top-level proof, with ordinary Native results routed internally', async t => {
  const { broker, child, frames, replies } = fixture(t);
  const requestId = randomUUID(), proof = { version: 1, requestId, source: {}, target: {} };
  const pending = broker.sendMigrationSourceRequest(PREFIX + 'peer/accept', { requestId, role: 'source' }, proof);
  assert.equal(frames.length, 1); assert.deepEqual(frames[0][PRIVATE_MIGRATION_SOURCE_FIELD], proof);
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frames[0].id, result: { peerRef: 'private-owned-peer' } }) + '\n');
  assert.deepEqual((await pending).result, { peerRef: 'private-owned-peer' });
  assert.equal(replies.length, 0, 'private peer response is not broadcast to clients');
  assert.throws(() => migrationSourcePrivateFrame({ method: PREFIX + 'target/begin', params: {} }, proof));
  assert.throws(() => migrationSourcePrivateFrame({ method: 'thread/start', params: {} }));
});

test('an untrusted or old Native cannot receive source-transfer internal requests', async t => {
  for (const options of [{ trusted: false }, { capable: false }]) {
    const { broker, frames } = fixture(t, options);
    await assert.rejects(broker.sendMigrationSourceRequest(PREFIX + 'identity', {}), { reason: 'source_transfer_authority_unavailable' });
    assert.equal(frames.length, 0);
  }
});

test('internal capability never becomes a shared downstream authorization', () => {
  assert.deepEqual(publicSharedCapabilities({ migrationSourceTransferInternalV1: true, migrationSourceTransferParentLaunchV1: true,
    migrationSourceTransferTargetRecoveryV1: true, migrationV1: true }), { migrationV1: true });
  assert.equal(requestsDedicatedCapabilities({ capabilities: { experimental: { migrationSourceTransferInternalV1: true } } }), true);
  assert.equal(requestsDedicatedCapabilities({ capabilities: { experimental: { migrationSourceTransferTargetRecoveryV1: true } } }), true);
});

test('target recovery requires its separate Native capability and never receives caller proof', async t => {
  const old = fixture(t);
  await assert.rejects(old.broker.sendMigrationSourceRequest(PREFIX + 'peer/recover-target', { requestId: randomUUID() }),
    { reason: 'source_transfer_authority_unavailable' });
  assert.equal(old.frames.length, 0);
  const current = fixture(t, { recovery: true });
  const params = { requestId: randomUUID() };
  const response = current.broker.sendMigrationSourceRequest(PREFIX + 'peer/recover-target', params);
  assert.deepEqual(current.frames[0].params, params);
  assert.equal(Object.hasOwn(current.frames[0], PRIVATE_MIGRATION_SOURCE_FIELD), false);
  current.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: current.frames[0].id,
    result: { peerRef: 'restricted-target-only' } }) + '\n');
  assert.equal((await response).result.peerRef, 'restricted-target-only');
  assert.equal(current.replies.length, 0);
  assert.throws(() => migrationSourcePrivateFrame({ method: PREFIX + 'peer/recover-target', params }, { version: 1, requestId: params.requestId }));
});

test('a separately negotiated migration parent can use its lane without enabling retention', async t => {
  const { broker, child, frames } = fixture(t, { trusted: false, sourceTrusted: true });
  const pending = broker.sendMigrationSourceRequest(PREFIX + 'identity', {});
  assert.equal(broker.retentionParentV1, false);
  assert.equal(frames.length, 1);
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frames[0].id, result: { authority: 'owned-fixture-result' } }) + '\n');
  assert.deepEqual((await pending).result, { authority: 'owned-fixture-result' });
});


test('private credentials require the dedicated cap and private results are never broadcast', async t => {
  const f = fixture(t);
  const requestId = randomUUID(), params = { requestId, peerRef: 'owned-target', offerId: randomUUID() };
  await assert.rejects(f.broker.sendMigrationSourceRequest(PREFIX + 'target/private/read', params),
    { reason: 'private_credentials_update_required' });
  assert.equal(f.frames.length, 0);
  f.broker.initializeResponse.result.capabilities.experimental.migrationSourceTransferPrivateCredentialsV1 = true;
  const reply = f.broker.sendMigrationSourceRequest(PREFIX + 'target/private/read', params);
  const message = { offer: { publicKey: 'SYNTHETIC_PUBLIC_KEY' }, envelope: { ciphertext: 'SYNTHETIC_CIPHERTEXT' } };
  f.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: f.frames[0].id, result: message }) + '\n');
  assert.deepEqual((await reply).result, message);
  assert.equal(f.replies.length, 0);
  f.broker.receive(f.client, JSON.stringify({ jsonrpc: '2.0', id: 90, method: PREFIX + 'target/private/read', params }));
  assert.equal(f.replies.at(-1).error.code, -32602);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(publicSharedCapabilities({ migrationV1: true, migrationSourceTransferPrivateCredentialsV1: true }), { migrationV1: true });
  assert.equal(requestsDedicatedCapabilities({ capabilities: { experimental: { migrationSourceTransferPrivateCredentialsV1: true } } }), true);
});
