import assert from 'node:assert/strict';
import test from 'node:test';
import { foldTaskStateObservation as fold } from './taskStateObservations.mjs';

const scope = { accountId: 'owner', targetId: 'target', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' };
const event = (revision = 1, extra = {}) => ({ scope, operationId: 'original', entityId: 'original',
  sequence: revision, revision, observedAtMs: 1234, snapshot: false,
  reference: { threadId: 'thread', turnId: 'turn' }, state: 'running', ...extra });

test('owner projection accepts a snapshot then drops duplicate and old live revisions', () => {
  const first = event(7, { snapshot: true });
  assert.equal(fold(null, first, scope).observation, first);
  assert.equal(fold(first, event(7), scope).changed, false);
  assert.equal(fold(first, event(6), scope).changed, false);
  assert.equal(fold(first, event(8), scope).changed, true);
});
test('a transport sequence reset cannot regress an existing entity snapshot', () => {
  const current = event(11, { snapshot: true });
  assert.equal(fold(current, event(1), scope).observation, current);
});
test('a missing initial revision or live gap asks for an original snapshot without applying it', () => {
  assert.deepEqual(fold(null, event(3), scope), { observation: null, changed: false, needsSnapshot: true });
  const current = event(3, { snapshot: true });
  assert.equal(fold(current, event(5), scope).needsSnapshot, true);
  assert.equal(fold(current, event(5, { snapshot: true }), scope).changed, true);
});
test('late account, target, workspace and permission generations cannot enter another owner', () => {
  for (const key of ['accountId', 'targetId', 'workspaceId', 'identityGeneration', 'targetRevision']) {
    const foreign = event(2, { scope: { ...scope, [key]: 'changed' } });
    assert.equal(fold(event(), foreign, scope).changed, false);
  }
});
test('a higher snapshot cannot reset a terminal task or change its Accepted reference', () => {
  const complete = event(3, { state: 'completed' });
  assert.equal(fold(complete, event(9, { snapshot: true }), scope).observation, complete);
  assert.equal(fold(event(), event(2, { reference: { threadId: 'thread', turnId: 'other' } }), scope).changed, false);
});
test('caller authority, private output and mismatched entity versions are not event data', () => {
  for (const extra of [{ approved: true }, { output: 'private' }, { revision: 2 }, { entityId: 'other' }])
    assert.equal(fold(null, event(1, extra), scope).changed, false);
});
