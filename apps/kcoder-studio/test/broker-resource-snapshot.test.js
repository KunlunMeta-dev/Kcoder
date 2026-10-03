import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrokerResourceSnapshot as normalize } from '../src/broker-resource-snapshot.js';

const sample = { processId: 42, instanceId: 'target-instance', residentBytes: 1024,
  memorySource: 'linux-vmrss', includesChildren: false, sampledAtMs: -9000 };

test('resource normalization preserves target identity and local monotonic receipt time only', () => {
  const result = normalize({ ...sample, prompt: 'discard', activity: { unknown: 'discard' } }, 123);
  assert.deepEqual(result, { processId: 42, instanceId: 'target-instance', residentBytes: 1024,
    memorySource: 'linux-vmrss', receivedAt: 123 });
  assert.equal(Object.isFrozen(result), true);
});

test('unknown memory is not zero and malformed identities are rejected', () => {
  for (const change of [{ residentBytes: -1 }, { residentBytes: Number.MAX_SAFE_INTEGER + 1 },
    { includesChildren: true }, { memorySource: 'ssh-wrapper' }, { residentBytes: null }]) {
    assert.equal(normalize({ ...sample, ...change }, 1).residentBytes, null);
  }
  for (const change of [{ processId: 0 }, { processId: 1.1 }, { instanceId: '' }, { instanceId: 'x'.repeat(129) }]) {
    assert.equal(normalize({ ...sample, ...change }, 1), null);
  }
  assert.equal(normalize(sample, NaN), null);
});
