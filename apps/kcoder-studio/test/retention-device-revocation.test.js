import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMobileDeviceAuth } from '../src/mobile-device-auth.js';
import { localRetentionRoute, validRevocationRequest } from '../src/retention-device-revocation.js';
import { createRetentionRevocationPump } from '../src/retention-revocation-pump.js';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RetentionAuthorityError } from '../src/retention-context.js';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

const route = workspacePath => localRetentionRoute({ targetId: 'local', targetFingerprint: 'a'.repeat(64), workspacePath });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kc-revocation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, identity: 'test-identity' };
  return { directory, options, auth: createMobileDeviceAuth(options) };
}
test('durable revoke retains original routed facts after restart, pairing and credential rotation', async t => {
  const { auth, options, directory } = await fixture(t);
  const a = await auth.pair('A'), b = await auth.pair('B');
  assert.equal(Object.hasOwn(a, 'key'), false);
  const verifier = await auth.privateRetentionVerifier();
  for (const path of ['/owned/a', '/owned/b']) await auth.registerRetentionRoute({ deviceId: a.deviceId, authorizationGeneration: a.authorizationGeneration, route: route(path) });
  await auth.registerRetentionRoute({ deviceId: b.deviceId, authorizationGeneration: b.authorizationGeneration, route: route('/owned/b') });
  const first = await auth.revokeAndReadProof(a.deviceId);
  assert.ok(first);
  await assert.rejects(auth.refresh(a.refreshToken, 'revoke-rotation-0001'));
  const restarted = createMobileDeviceAuth(options);
  assert.deepEqual(await restarted.revokeAndReadProof(a.deviceId), first);
  await restarted.pair('C');
  const pending = await restarted.pendingRetentionRevocations();
  assert.equal(pending.length, 2);
  assert.ok(pending.every(request => request.statement.deviceId === a.deviceId && validRevocationRequest(request, verifier)));
  await assert.rejects(restarted.registerRetentionRoute({ deviceId: a.deviceId, authorizationGeneration: a.authorizationGeneration, route: route('/owned/late') }));
  const rotated = createMobileDeviceAuth({ ...options, identity: 'next-identity' });
  const afterRotation = await rotated.pendingRetentionRevocations();
  assert.equal(afterRotation.length, 3);
  assert.ok(afterRotation.some(request => JSON.stringify(request) === JSON.stringify(pending[0])));
  assert.deepEqual(await rotated.privateRetentionVerifier(), verifier);
  assert.equal(await rotated.revokeAndReadProof('never-registered-device'), null);
  const stored = JSON.parse(await readFile(join(directory, 'mobile-device-auth/devices.json')));
  assert.equal(stored.revocations.find(row => row.statement.deviceId === a.deviceId).statement.revocationId, first.revocationId);
});
test('registered routes serialize against revocation and completed routes do not erase pending peers', async t => {
  const { auth, options } = await fixture(t);
  const a = await auth.pair();
  const register = path => auth.registerRetentionRoute({ deviceId: a.deviceId, authorizationGeneration: a.authorizationGeneration, route: route(path) });
  await Promise.all([register('/owned/one'), register('/owned/two')]);
  await auth.revokeAndReadProof(a.deviceId);
  const pending = await auth.pendingRetentionRevocations();
  assert.equal(pending.length, 2);
  const progress = { version: 1, revocationId: pending[0].statement.revocationId, routeId: pending[0].route.routeId, complete: true };
  await auth.confirmRetentionRevocation(progress);
  await auth.confirmRetentionRevocation(progress);
  const remaining = await createMobileDeviceAuth(options).pendingRetentionRevocations();
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0], pending[1]);
  await assert.rejects(register('/owned/three'));
  await assert.rejects(auth.confirmRetentionRevocation({ ...progress, routeId: 'f'.repeat(64) }));
});
test('private request binds full route and installation verifier; Unicode controls and forged facts reject', async t => {
  const { auth } = await fixture(t);
  const a = await auth.pair();
  await auth.registerRetentionRoute({ deviceId: a.deviceId, authorizationGeneration: a.authorizationGeneration, route: route('/owned/source') });
  await auth.revokeAndReadProof(a.deviceId);
  const [request] = await auth.pendingRetentionRevocations();
  const verifier = await auth.privateRetentionVerifier();
  assert.ok(validRevocationRequest(request, verifier));
  assert.equal(validRevocationRequest({ ...request, statement: { ...request.statement, authorizationGeneration: 'other' } }, verifier), false);
  assert.equal(validRevocationRequest({ ...request, route: route('/owned/foreign') }, verifier), false);
  assert.equal(validRevocationRequest(request, { ...verifier, key: 'f'.repeat(64) }), false);
  assert.equal(validRevocationRequest({ ...request, extra: true }, verifier), false);
  assert.throws(() => route('/owned/\u0085bad'));
});

test('durable delivery cursor passes 32 blocked routes after Gateway restart', async t => {
  const { auth, options } = await fixture(t);
  const device = await auth.pair();
  for (let i = 0; i < 35; i++) await auth.registerRetentionRoute({ deviceId: device.deviceId,
    authorizationGeneration: device.authorizationGeneration, route: route(`/owned/${i}`) });
  await auth.revokeAndReadProof(device.deviceId);
  const jobs = await auth.pendingRetentionRevocations();
  const key = job => createHash('sha256').update(JSON.stringify([job.statement.revocationId, job.route.routeId])).digest('hex');
  jobs.sort((a, b) => key(a).localeCompare(key(b)));
  const blocked = new Set(jobs.slice(0, 32).map(job => job.route.routeId));
  const delivered = [];
  const brokerForRoute = async route => blocked.has(route.routeId) ? null : ({ revokeRetainedDevice: async request => {
    delivered.push(route.routeId);
    return { result: { version: 1, revocationId: request.statement.revocationId, routeId: route.routeId, complete: true } };
  } });
  await createRetentionRevocationPump({ auth, brokerForRoute }).drain();
  assert.equal(delivered.length, 0);
  const restarted = createMobileDeviceAuth(options);
  await createRetentionRevocationPump({ auth: restarted, brokerForRoute }).drain();
  assert.equal(new Set(delivered).size, 3);
  assert.equal((await restarted.pendingRetentionRevocations()).length, 32);
});

test('exact completion compacts route capacity while preserving revoked-device same-ID readback', async t => {
  const { auth, options, directory } = await fixture(t);
  const device = await auth.pair();
  await auth.registerRetentionRoute({ deviceId: device.deviceId, authorizationGeneration: device.authorizationGeneration, route: route('/owned/completed') });
  const statement = await auth.revokeAndReadProof(device.deviceId);
  const [job] = await auth.pendingRetentionRevocations();
  const progress = { version: 1, revocationId: statement.revocationId, routeId: job.route.routeId, complete: true };
  await auth.confirmRetentionRevocation(progress);
  const restarted = createMobileDeviceAuth(options);
  await restarted.confirmRetentionRevocation(progress);
  assert.deepEqual(await restarted.revokeAndReadProof(device.deviceId), statement);
  await assert.rejects(restarted.refresh(device.refreshToken, 'completion-replay-0001'));
  const stored = JSON.parse(await readFile(join(directory, 'mobile-device-auth/devices.json')));
  assert.equal(stored.retentionRoutes.length, 0);
  assert.equal(stored.revocations.length, 0);
  await restarted.pair('replacement');
  assert.equal((await restarted.pendingRetentionRevocations()).length, 0);
  assert.equal(await restarted.revokeAndReadProof(device.deviceId), null);
});

test('expiry alone produces no revoke fact; explicit revoke still finds registered old authority', async t => {
  const { directory, options } = await fixture(t);
  let clock = 1000;
  const auth = createMobileDeviceAuth({ ...options, now: () => clock, accessTtlMs: 100, idleTtlMs: 200 });
  const device = await auth.pair();
  await auth.registerRetentionRoute({ deviceId: device.deviceId, authorizationGeneration: device.authorizationGeneration, route: route('/owned/expired') });
  clock += 300;
  await auth.pair('later');
  assert.equal((await auth.pendingRetentionRevocations()).length, 0);
  const proof = await auth.revokeAndReadProof(device.deviceId);
  assert.equal(proof.authorizationGeneration, device.authorizationGeneration);
  assert.equal((await auth.pendingRetentionRevocations()).length, 1);
  assert.equal(JSON.parse(await readFile(join(directory, 'mobile-device-auth/devices.json'))).revocations.length, 1);
});

function brokerFixture(t, options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const frames = []; let buffered = '';
  child.stdin.on('data', chunk => {
    buffered += chunk.toString();
    for (let end; (end = buffered.indexOf('\n')) >= 0;) {
      frames.push(JSON.parse(buffered.slice(0, end))); buffered = buffered.slice(end + 1);
    }
  });
  const broker = new WorkspaceAppServerBroker({ child, serverId: 'local', retentionParentV1: true, retentionRevocationTrusted: true,
    maxMessageBytes: 4 * 1024 * 1024, residentThreads: true, adapter: { rawPassthrough: true,
      fromUpstream: message => ({ upstream: [], client: [message] }) }, ...options });
  t.after(() => { broker.clearTransientState(); child.emit('close', 0, null); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const client = { channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  return { broker, frames, client, reply: message => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('private cleanup initializes once, joins a simultaneous browser initialize and rejects public forgery', async t => {
  const { broker, frames, client, reply } = brokerFixture(t);
  const delivery = broker.revokeRetainedDevice({ owned: 'statement' });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].method, 'initialize');
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize',
    params: { protocolVersion: '2026-07-27', clientInfo: { name: 'retention-review', version: '1' } } }));
  assert.equal(frames.length, 1, 'client joins the private initialize in flight');
  reply({ id: frames[0].id, result: { capabilities: { experimental: { residentThreads: true } } } });
  await tick();
  assert.equal(client.initialized, true);
  assert.equal(frames[1].method, 'attachment/retention/deviceRevoked');
  reply({ id: frames[1].id, result: { version: 1, complete: true } });
  assert.equal((await delivery).result.complete, true);
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'attachment/retention/deviceRevoked', params: { owned: 'forged' } }));
  assert.equal(frames.length, 2);
  assert.equal(client.messages.at(-1).error.code, -32001);
  assert.equal(broker.pending.size, 0);
});

test('held durable route registration fences revocation before allocation bytes, without legacy fallback', async t => {
  let resolveRegistration; let current = true; let registered = 0;
  const authority = { gatewayNamespaceId: 'namespace', deviceId: 'device', authorizationGeneration: '1', targetFingerprint: 'target', principal: { kind: 'localOs' },
    workspacePath: '/owned/workspace', workspaceTargetId: 'local' };
  const { broker, frames, client } = brokerFixture(t, { registerRetentionRoute: async captured => {
    assert.deepEqual(captured, authority); registered++;
    await new Promise(resolve => { resolveRegistration = resolve; });
  } });
  client.initialized = true;
  client.retentionAuthority = () => { if (!current) throw new RetentionAuthorityError(); return authority; };
  broker.initializeResponse = { result: { capabilities: { experimental: { stagedAttachmentRetentionReceiptsV1: true } } } };
  const params = { clientRequestId: 'r1.namespace.1.0123456789abcdef0123456789abcdef', threadId: 'thread',
    stageRefs: [{ rootNamespace: 'namespace', epoch: 1, ownerId: 'owner', entryId: 'entry', revision: 1 }] };
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'attachment/retention/reserve', params }));
  await tick();
  assert.equal(registered, 1); assert.equal(frames.length, 0);
  current = false; resolveRegistration(); await tick();
  assert.equal(frames.length, 0);
  assert.equal(client.messages.at(-1).error.code, -32001);
  assert.equal(broker.pending.size, 0);
  assert.equal(broker.threadClaims.size, 0);
  current = true;
  broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'attachment/retention/reserve', params }));
  await tick(); resolveRegistration(); await tick();
  assert.equal(frames.length, 1, 'same fixture with current owner reaches the upstream exactly once');
  assert.equal(frames[0].method, 'attachment/retention/reserve');
});


test('custom child cannot claim internal cleanup capability or fabricate completion', async t => {
  const { broker, frames } = brokerFixture(t, { retentionRevocationTrusted: false });
  broker.initializeResponse = { result: { capabilities: { experimental: { stagedAttachmentRetentionReceiptsV1: true } } } };
  await assert.rejects(broker.revokeRetainedDevice({ owned: 'statement' }), RetentionAuthorityError);
  assert.equal(frames.length, 0);
  assert.equal(broker.pending.size, 0);
});
