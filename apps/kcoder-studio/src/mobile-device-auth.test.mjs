import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMobileDeviceAuth } from './mobile-device-auth.js';
import { localRetentionRoute } from './retention-device-revocation.js';

const fixture = async (t, maximumDevices, extra = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-mobile-device-fifo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, identity: 'fifo-test-identity', maximumDevices, ...extra };
  return { directory, options, auth: createMobileDeviceAuth(options) };
};

test('public policy stops legacy native refresh but preserves its authorization and scoped Web refresh', async t => {
  const { auth, options } = await fixture(t, 4);
  const { token, webToken } = await auth.getPairingCredential();
  assert.notEqual(token, webToken);
  assert.equal(await auth.matchesPairingCredential(token, 'mobileWeb'), false);
  assert.equal(await auth.matchesPairingCredential(webToken, 'mobileWeb'), true);
  const native = await auth.pair('legacy');
  const { grant: web } = await auth.pairWithEviction('browser', 'mobileWeb');
  const restarted = createMobileDeviceAuth(options);
  const allowWeb = surface => surface === 'mobileWeb';
  await assert.rejects(restarted.refresh(native.refreshToken, 'native-refresh-blocked-01', allowWeb), { status: 403 });
  assert.equal((await restarted.refresh(web.refreshToken, 'web-refresh-allowed-01', allowWeb)).surface, 'mobileWeb');
  assert.equal((await restarted.refresh(native.refreshToken, 'native-refresh-allowed-01')).surface, 'mobileApp');
});

for (const version of [0, 2]) test(`unsupported device authorization format ${version} is never reset`, async t => {
  const { directory, auth, options } = await fixture(t, 2);
  await auth.pair('retained');
  const path = join(directory, 'mobile-device-auth', 'devices.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  original.version = version;
  const bytes = JSON.stringify(original);
  await writeFile(path, bytes);
  await assert.rejects(createMobileDeviceAuth(options).list(), /Invalid mobile authorization store/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('maximumDevices must be a positive safe integer', () => {
  for (const maximumDevices of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createMobileDeviceAuth({ directory: tmpdir(), identity: 'invalid-capacity', maximumDevices }), /device capacity/i);
  }
});

test('unchanged queries preserve the ledger inode while real rotation remains durable', async t => {
  const { directory, auth, options } = await fixture(t, 2);
  await auth.pair('reader');
  const path = join(directory, 'mobile-device-auth', 'devices.json');
  const before = await stat(path, { bigint: true });
  const bytes = await readFile(path);
  const pairing = await auth.getPairingCredential();
  await auth.list();
  await auth.matchesPairingCredential(pairing.token);
  const after = await stat(path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(await readFile(path), bytes);
  const rotated = await auth.rotatePairingCredential();
  assert.notEqual(rotated.token, pairing.token);
  assert.equal(await createMobileDeviceAuth(options).matchesPairingCredential(rotated.token), true);
});

test('pair remains strict while pairWithEviction removes the FIFO device and persists the replacement', async t => {
  let currentTime = 1_000_000;
  const { directory, options, auth } = await fixture(t, 2, { now: () => currentTime });
  const oldest = await auth.pair('oldest');
  currentTime += 10;
  const newer = await auth.pair('newer');

  await assert.rejects(auth.pair('strict'), error => error.status === 429 && error.message === 'Device limit reached');
  assert.ok(await auth.inspectAccessAuthorization(oldest.accessToken));

  currentTime += 10;
  const result = await auth.pairWithEviction('replacement');
  assert.deepEqual(result.evictedDeviceIds, [oldest.deviceId]);
  assert.equal(Object.hasOwn(result.grant, 'evictedDeviceIds'), false);
  assert.equal(await auth.inspectAccessAuthorization(oldest.accessToken), undefined);
  await assert.rejects(auth.refresh(oldest.refreshToken, 'fifo-eviction-refresh-0001'));
  assert.ok(await auth.inspectAccessAuthorization(newer.accessToken));
  assert.ok(await auth.inspectAccessAuthorization(result.grant.accessToken));

  const stored = JSON.parse(await readFile(join(directory, 'mobile-device-auth', 'devices.json'), 'utf8'));
  assert.deepEqual(stored.devices.map(device => device.id), [newer.deviceId, result.grant.deviceId]);
  const restarted = createMobileDeviceAuth(options);
  assert.deepEqual((await restarted.list()).map(device => device.id), [newer.deviceId, result.grant.deviceId]);
  assert.equal(await restarted.inspectAccessAuthorization(oldest.accessToken), undefined);
  assert.ok(await restarted.inspectAccessAuthorization(result.grant.accessToken));
});

test('equal creation times keep the original stored order for FIFO eviction', async t => {
  const { auth } = await fixture(t, 2, { now: () => 1_000_000 });
  const first = await auth.pair('first');
  const second = await auth.pair('second');
  const { grant, evictedDeviceIds } = await auth.pairWithEviction('third');
  assert.deepEqual(evictedDeviceIds, [first.deviceId]);
  assert.equal(await auth.inspectAccessAuthorization(first.accessToken), undefined);
  assert.ok(await auth.inspectAccessAuthorization(second.accessToken));
  assert.ok(await auth.inspectAccessAuthorization(grant.accessToken));
});

test('clock rollback between registrations does not change FIFO eviction order', async t => {
  let currentTime = 1_000_000;
  const { auth } = await fixture(t, 2, { now: () => currentTime });
  const first = await auth.pair('first');
  currentTime -= 100;
  const second = await auth.pair('second');
  const createdAt = new Map((await auth.list()).map(device => [device.id, device.createdAt]));
  assert.ok(createdAt.get(second.deviceId) < createdAt.get(first.deviceId), 'test setup moves the clock backwards');

  const { grant, evictedDeviceIds } = await auth.pairWithEviction('third');
  assert.deepEqual(evictedDeviceIds, [first.deviceId]);
  assert.equal(await auth.inspectAccessAuthorization(first.accessToken), undefined);
  assert.ok(await auth.inspectAccessAuthorization(second.accessToken));
  assert.ok(await auth.inspectAccessAuthorization(grant.accessToken));
});

test('eviction preserves pending retention revocation through restart and cleanup', async t => {
  const { directory, options, auth } = await fixture(t, 1);
  const original = await auth.pair('retained device');
  const route = localRetentionRoute({
    targetId: 'local-target',
    targetFingerprint: 'a'.repeat(64),
    workspacePath: '/tmp/retained-workspace',
  });
  await auth.registerRetentionRoute({ deviceId: original.deviceId,
    authorizationGeneration: original.authorizationGeneration, route });

  const replacement = await auth.pairWithEviction('replacement');
  assert.deepEqual(replacement.evictedDeviceIds, [original.deviceId]);
  const [pending] = await auth.pendingRetentionRevocations();
  assert.equal(pending.statement.deviceId, original.deviceId);
  assert.equal(await auth.revokeAndReadProof(original.deviceId).then(value => value.revocationId), pending.statement.revocationId);
  await assert.rejects(auth.refresh(original.refreshToken, 'retained-eviction-refresh-01'));
  assert.equal(await auth.inspectAccessAuthorization(original.accessToken), undefined);

  const restarted = createMobileDeviceAuth(options);
  const [afterRestart] = await restarted.pendingRetentionRevocations();
  assert.deepEqual(afterRestart, pending);
  assert.equal((await restarted.list()).length, 1);
  await restarted.confirmRetentionRevocation({ version: 1, revocationId: pending.statement.revocationId,
    routeId: pending.route.routeId, complete: true });
  assert.deepEqual(await restarted.pendingRetentionRevocations(), []);
  assert.ok(await restarted.inspectAccessAuthorization(replacement.grant.accessToken));
});

test('FIFO pairing revokes expired devices before pruning their pending retention routes', async t => {
  let currentTime = 1_000;
  const { options, auth } = await fixture(t, 1, { now: () => currentTime, accessTtlMs: 100, idleTtlMs: 200 });
  const expired = await auth.pair('expired retained device');
  const route = localRetentionRoute({ targetId: 'local-target', targetFingerprint: 'b'.repeat(64),
    workspacePath: '/tmp/expired-retained-workspace' });
  await auth.registerRetentionRoute({ deviceId: expired.deviceId,
    authorizationGeneration: expired.authorizationGeneration, route });
  currentTime += 300;

  const replacement = await auth.pairWithEviction('replacement');
  assert.deepEqual(replacement.evictedDeviceIds, [expired.deviceId]);
  const [pending] = await auth.pendingRetentionRevocations();
  assert.equal(pending.statement.deviceId, expired.deviceId);
  assert.equal(await auth.revokeAndReadProof(expired.deviceId).then(value => value.revocationId), pending.statement.revocationId);
  await assert.rejects(auth.refresh(expired.refreshToken, 'expired-eviction-refresh-0001'));

  const restarted = createMobileDeviceAuth(options);
  const [afterRestart] = await restarted.pendingRetentionRevocations();
  assert.deepEqual(afterRestart, pending);
  await restarted.confirmRetentionRevocation({ version: 1, revocationId: pending.statement.revocationId,
    routeId: pending.route.routeId, complete: true });
  assert.deepEqual(await restarted.pendingRetentionRevocations(), []);
  assert.ok(await restarted.inspectAccessAuthorization(replacement.grant.accessToken));
});

test('failed FIFO allocation at lifecycle capacity leaves the durable store unchanged', async t => {
  const { directory, auth } = await fixture(t, 1);
  const device = await auth.pair('retained device');
  const route = localRetentionRoute({ targetId: 'local-target', targetFingerprint: 'c'.repeat(64),
    workspacePath: '/tmp/capacity-retained-workspace' });
  await auth.registerRetentionRoute({ deviceId: device.deviceId,
    authorizationGeneration: device.authorizationGeneration, route });

  const storePath = join(directory, 'mobile-device-auth', 'devices.json');
  const data = JSON.parse(await readFile(storePath, 'utf8'));
  const verifier = await auth.privateRetentionVerifier();
  data.revocations = Array.from({ length: 511 }, () => ({ statement: {
    version: 1,
    gatewayNamespaceId: verifier.gatewayNamespaceId,
    deviceId: randomUUID(),
    authorizationGeneration: randomUUID(),
    revocationId: randomUUID(),
    revokedAt: 1,
  }, routes: [] }));
  const before = JSON.stringify(data);
  await writeFile(storePath, before);

  await assert.rejects(auth.pairWithEviction('cannot fit'), error => error.status === 429 && /capacity/i.test(error.message));
  assert.equal(await readFile(storePath, 'utf8'), before);
});

test('concurrent registrations across store instances never exceed the configured capacity', async t => {
  const { directory, options } = await fixture(t, 3);
  const clients = Array.from({ length: 10 }, () => createMobileDeviceAuth(options));
  const results = await Promise.all(clients.map((auth, index) => auth.pairWithEviction(`concurrent-${index}`)));
  const finalAuth = createMobileDeviceAuth(options);
  const devices = await finalAuth.list();
  const stored = JSON.parse(await readFile(join(directory, 'mobile-device-auth', 'devices.json'), 'utf8'));

  assert.equal(new Set(results.map(result => result.grant.deviceId)).size, results.length);
  assert.equal(devices.length, options.maximumDevices);
  assert.equal(stored.devices.length, options.maximumDevices);
  assert.equal(new Set(stored.devices.map(device => device.id)).size, stored.devices.length);
});
