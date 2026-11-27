import assert from 'node:assert/strict';
import test from 'node:test';
import { accountLogoutCleanupPlan, runAccountLogoutCleanup } from '../account-logout.js';

function createStore({ identityFails = false, deviceFails = false } = {}) {
  const calls = [];
  return {
    calls,
    async forgetIdentity(identity, target) {
      calls.push(stepCall('identity', identity, target));
      if (identityFails) throw new Error('identity cleanup failed');
    },
    async forgetDevice(deviceId, target) {
      calls.push(stepCall('device', { deviceId }, target));
      if (deviceFails) throw new Error('device cleanup failed');
    },
  };
}

function stepCall(kind, value, target) {
  return { kind, value, targetId: target.id };
}

test('cleans the remembered credential for the device profile and target', () => {
  const plan = accountLogoutCleanupPlan({
    principal: { username: 'alice' },
    deviceId: 'device-12345678',
  });
  assert.deepEqual(plan.steps, [
    { kind: 'identity', deviceId: 'device-12345678', username: 'alice' },
    { kind: 'device', deviceId: 'device-12345678' },
  ]);
});

test('falls back to the device scope when the account identity is unknown', () => {
  assert.deepEqual(
    accountLogoutCleanupPlan({ principal: null, deviceId: 'device-12345678' }).steps,
    [{ kind: 'device', deviceId: 'device-12345678' }]
  );
  // Without a device profile there is nothing this connection may forget.
  assert.deepEqual(accountLogoutCleanupPlan({ principal: { username: 'alice' } }).steps, []);
  assert.deepEqual(
    accountLogoutCleanupPlan({ principal: null, deviceId: '' }).steps,
    []
  );
});

test('a successful identity removal ends the cleanup', async () => {
  const store = createStore();
  const target = { id: 'local' };
  const failure = await runAccountLogoutCleanup(
    accountLogoutCleanupPlan({ principal: { username: 'alice' }, deviceId: 'device-12345678' }),
    store,
    target
  );
  assert.equal(failure, null);
  assert.deepEqual(store.calls, [
    { kind: 'identity', value: { deviceId: 'device-12345678', username: 'alice' }, targetId: 'local' },
  ]);
});

test('a failed identity removal still forgets the device profile', async () => {
  const store = createStore({ identityFails: true });
  const failure = await runAccountLogoutCleanup(
    accountLogoutCleanupPlan({ principal: { username: 'alice' }, deviceId: 'device-12345678' }),
    store,
    { id: 'local' }
  );
  // The coarser removal succeeded, so no remembered credential survives and the
  // caller must not treat the logout as failed.
  assert.equal(failure, null);
  assert.deepEqual(
    store.calls.map(call => call.kind),
    ['identity', 'device']
  );
});

test('reports a failure only when no removal succeeded', async () => {
  const store = createStore({ identityFails: true, deviceFails: true });
  const failure = await runAccountLogoutCleanup(
    accountLogoutCleanupPlan({ principal: { username: 'alice' }, deviceId: 'device-12345678' }),
    store,
    { id: 'local' }
  );
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /device cleanup failed/);

  // Nothing to clean up is not a failure.
  const empty = createStore();
  assert.equal(
    await runAccountLogoutCleanup(accountLogoutCleanupPlan({ principal: null }), empty, { id: 'local' }),
    null
  );
  assert.deepEqual(empty.calls, []);
});
