import assert from 'node:assert/strict';
import test from 'node:test';
import { threadOwnershipErrorData } from '../shared/threadOwnership.mjs';

test('a Native ownership refusal remains bound to its original request and carries no private data', () => {
  const value = { version: 1, reason: 'ownedElsewhere', threadId: 'original_1' };
  assert.deepEqual(threadOwnershipErrorData(value, 'original_1'), value);
  assert.equal(Object.isFrozen(threadOwnershipErrorData(value, 'original_1')), true);
  for (const input of [{ ...value, version: 2 }, { ...value, reason: 'permissionDenied' },
    { ...value, path: 'PRIVATE_PATH_TOKEN' }, { ...value, threadId: 'other' }, undefined, null])
    assert.equal(threadOwnershipErrorData(input, 'original_1'), undefined);
});
