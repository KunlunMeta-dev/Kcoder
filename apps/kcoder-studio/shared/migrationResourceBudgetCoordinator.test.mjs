import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceBudgetController } from './migrationResourceBudgetCoordinator.mjs';
const limits = { maxTotalBytes: 8388608, maxPayloadFiles: 6, minFreeBytes: 1048576, minFreeFileNodes: 0 };
const snapshot = revision => ({ phase: 'active', jobId: 'mig-owned', policyRevision: revision, limits: { ...limits, maxPayloadFiles: revision ? 8 : 6 }, usage: { committedBytes: 1000, reservedBytes: 0, committedFiles: 5, reservedFiles: 0 } });
const validIntent = value => value?.jobId === 'mig-owned' && value.confirm === true && value.requestId && Number.isSafeInteger(value.expectedPolicyRevision) && !!value.limits;
function fixture() {
  let view = snapshot(0), count = 0, held = false, tail = Promise.resolve();
  const data = new Map(), calls = [], storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const withLock = (_key, operation) => { const next = tail.then(() => { held = true; try { return operation(); } finally { held = false; } }); tail = next.catch(() => {}); return next; };
  const api = { read: async () => structuredClone(view), increase: async intent => { assert.equal(held, false, 'a Native call is never awaited under the local metadata lock'); calls.push(structuredClone(intent)); throw Error('original response lost'); } };
  storage.refresh = async () => {}; storage.withTransaction = (key, operation) => withLock(key, () => operation(storage));
  const options = { api, storage, scope: 'same-target-account', jobId: 'mig-owned', planId: 'plan-owned', isCurrent: () => true, validIntent, validView: (_q, v) => !!v?.usage && v.jobId === 'mig-owned', createRequestId: () => `request-${++count}` };
  return { options, data, calls, storage, api, view(value) { view = value; } };
}
test('same-CAS missing receipt stays unknown; a different accepted intent advances policy before explicit local archival', async () => {
  const f = fixture(), model = createResourceBudgetController(f.options);
  await model.read(); await model.increase({ ...limits, maxPayloadFiles: 12 }, 0, true); const original = structuredClone(model.getSnapshot().pending);
  await model.read(); await model.archiveExpired(true); assert.equal(model.getSnapshot().expiredObservation, null); assert.deepEqual(model.getSnapshot().pending, original); assert.equal(f.calls.length, 1);
  f.view(snapshot(1)); await model.read(); assert.equal(model.getSnapshot().expiredObservation.view.policyRevision, 1);
  await model.archiveExpired(false); assert.deepEqual(model.getSnapshot().pending, original);
  await model.resubmit(true); assert.equal(f.calls.length, 1, 'proved-expired CAS is not resubmitted');
  await model.archiveExpired(true); assert.equal(f.calls.length, 1); assert.equal(model.getSnapshot().pending, null);
  const row = model.getSnapshot().historyRows[0]; assert.deepEqual(row.intent, original); assert.equal(row.observation.view.policyRevision, 1); assert.equal(row.observation.query.requestId, original.requestId);
  assert.equal(model.getSnapshot().view.policyRevision, 1);
  await model.increase({ ...limits, maxPayloadFiles: 16 }, 1, false); assert.equal(f.calls.length, 1);
  await model.increase({ ...limits, maxPayloadFiles: 16 }, 1, true); assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[1].requestId, original.requestId); assert.equal(f.calls[1].expectedPolicyRevision, 1);
  assert.deepEqual(model.getSnapshot().historyRows[0].intent, original);
});
test('two pre-mounted clients preserve the original peer intent and keep all Native calls outside the short local lock', async () => {
  const f = fixture(), first = createResourceBudgetController(f.options), second = createResourceBudgetController(f.options);
  await Promise.all([first.read(), second.read()]); await Promise.all([first.increase({ ...limits, maxPayloadFiles: 12 }, 0, true), second.increase({ ...limits, maxPayloadFiles: 16 }, 0, true)]);
  assert.equal(f.calls.length, 1); assert.equal(first.getSnapshot().pending.requestId, f.calls[0].requestId);
  assert.equal(second.getSnapshot().pending.requestId, f.calls[0].requestId); assert.equal(second.getSnapshot().error, 'selectorChanged');
  assert.equal(JSON.parse([...f.data.values()][0]).pending.requestId, f.calls[0].requestId);
});
test('legacy cache loads without writing, missing coordination rejects new writes, and queued invalidation cannot persist a selector', async () => {
  const f = fixture(); f.data.set('kcoder.migration.resource-budget.v1:same-target-account:mig-owned', JSON.stringify({ version: 1, pending: null, history: ['accepted-old'] }));
  const before = [...f.data.values()][0], model = createResourceBudgetController({ ...f.options, storage: { ...f.storage, withTransaction: undefined } });
  assert.equal([...f.data.values()][0], before); assert.deepEqual(model.getSnapshot().history, ['accepted-old']);
  await model.read(); await model.increase({ ...limits, maxPayloadFiles: 12 }, 0, true); assert.equal(f.calls.length, 0); assert.equal(model.getSnapshot().recoveryBlocked, true);
  let acquire;
  const g = fixture(); g.storage.withTransaction = (_key, operation) => new Promise((resolve, reject) => { acquire = () => { try { resolve(operation(g.storage)); } catch (error) { reject(error); } }; }); const queued = createResourceBudgetController(g.options);
  await queued.read(); const request = queued.increase({ ...limits, maxPayloadFiles: 12 }, 0, true);
  queued.dispose(); queued.activate(); acquire(); await request;
  assert.equal(g.calls.length, 0); assert.equal(g.data.size, 0);
});
test('failure to save the complete old intent keeps the pending request and never authorizes a replacement', async () => {
  const f = fixture(), model = createResourceBudgetController(f.options);
  await model.read(); await model.increase({ ...limits, maxPayloadFiles: 12 }, 0, true); const pending = structuredClone(model.getSnapshot().pending);
  f.view(snapshot(1)); await model.read(); f.storage.setItem = () => { throw Error('local quota'); };
  await model.archiveExpired(true); assert.deepEqual(model.getSnapshot().pending, pending); assert.equal(model.getSnapshot().recoveryBlocked, true); assert.equal(f.calls.length, 1);
});
