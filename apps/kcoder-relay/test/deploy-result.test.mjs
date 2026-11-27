import test from 'node:test';
import assert from 'node:assert/strict';
import { combineRelayLifecycleResults } from '../deploy/cli-contract.mjs';

test('a failed requested purge cannot claim registration data was deleted', () => {
  const result = combineRelayLifecycleResults({ action: 'cleanup', purgeData: true, remoteStatus: 3,
    stun: { component: 'stun', state: 'conflict' }, relay: { component: 'relay', state: 'not-run' } });
  assert.equal(result.success, false);
  assert.deepEqual(result.registrationStore, { state: 'unknown', retained: false, purged: false });
});

test('registration data outcomes follow the Relay receipt independently of STUN failure', () => {
  for (const remoteStatus of [0, 4]) {
    const result = combineRelayLifecycleResults({ action: 'cleanup', purgeData: true, remoteStatus,
      stun: { component: 'stun', state: remoteStatus === 0 ? 'resources-removed' : 'conflict' },
      relay: { component: 'relay', state: 'resources-removed', registrationStore: { state: 'purged' } } });
    assert.equal(result.success, remoteStatus === 0);
    assert.deepEqual(result.registrationStore, { state: 'purged', retained: false, purged: true });
  }
  const retained = combineRelayLifecycleResults({ action: 'cleanup', remoteStatus: 0,
    stun: { component: 'stun', state: 'resources-removed' },
    relay: { component: 'relay', state: 'resources-removed', registrationStore: { state: 'present' } } });
  assert.deepEqual(retained.registrationStore, { state: 'present', retained: true, purged: false });
});

test('active status requires an explicit healthy acknowledgement from both components', () => {
  for (const healthy of [undefined, false, 'true']) {
    const result = combineRelayLifecycleResults({ action: 'status',
      stun: { component: 'stun', state: 'active', healthy: true },
      relay: { component: 'relay', state: 'active', healthy } });
    assert.equal(result.success, false);
  }
  assert.equal(combineRelayLifecycleResults({ action: 'status',
    stun: { component: 'stun', state: 'absent' }, relay: { component: 'relay', state: 'absent' } }).success, true);
});
