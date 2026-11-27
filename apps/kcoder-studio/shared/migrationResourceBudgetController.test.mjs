import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceBudgetController } from './migrationResourceBudgetController.mjs';
const limits = { maxTotalBytes: 1024, maxPayloadFiles: 1, minFreeBytes: 1048576, minFreeFileNodes: 0 };
const raised = { ...limits, maxTotalBytes: 2048, maxPayloadFiles: 2 };
const active = (revision = 0, chosen = limits, requestedReceipt) => ({ jobId: 'job-owned', phase: 'active', limits: chosen, policyRevision: revision,
  usage: { reservedBytes: 512, committedBytes: 256, reservedFiles: 1, committedFiles: 1 }, ...(requestedReceipt ? { requestedReceipt } : {}) });
const receiptFor = intent => ({ jobId: intent.jobId, requestId: intent.requestId, previousRevision: intent.expectedPolicyRevision,
  revision: intent.expectedPolicyRevision + 1, limits: intent.limits });
const validIntent = value => value && value.confirm === true && typeof value.planId === 'string'
  && typeof value.requestId === 'string' && Number.isSafeInteger(value.expectedPolicyRevision)
  && ['maxTotalBytes', 'maxPayloadFiles', 'minFreeBytes', 'minFreeFileNodes'].every(key => Number.isSafeInteger(value.limits?.[key]));
const clone = value => structuredClone(value);
function fixture() {
  const data = new Map(), calls = { read: [], increase: [] };
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  let current = true, response = active(), receipt = null, create = 0;
  const api = { async read(input) { calls.read.push(clone(input)); return clone(input.requestId && receipt ? { ...response, requestedReceipt: receipt } : response); },
    async increase(intent) { calls.increase.push(clone(intent)); receipt = receiptFor(intent); response = active(receipt.revision, intent.limits); return clone(receipt); } };
  let metadataTail = Promise.resolve();
  storage.refresh = async () => {}; storage.withTransaction = (_key, operation) => { const next = metadataTail.then(() => operation(storage)); metadataTail = next.catch(() => {}); return next; };
  const options = { api, storage, scope: 'account-target-workspace', jobId: 'job-owned', planId: 'plan-owned',
    isCurrent: () => current, createRequestId: () => `request-${++create}`, validIntent, validView: (query, result) => result?.jobId === query.jobId };
  return { api, options, storage, calls, data, setCurrent(value) { current = value; }, response(value) { response = value; }, receipt(value) { receipt = value; } };
}
test('persists the complete original intent before dispatch and distinguishes an old receipt from current policy', async () => {
  const f = fixture(), model = createResourceBudgetController(f.options);
  await model.read(); assert.equal(f.calls.increase.length, 0);
  const original = f.api.increase;
  f.api.increase = async intent => { const cached = [...f.data.values()].map(JSON.parse)[0]; assert.deepEqual(cached.pending, intent); return original(intent); };
  await model.increase(raised, 0, true);
  assert.equal(model.getSnapshot().receipt.revision, 1);
  f.response(active(3, { ...raised, maxTotalBytes: 8192 })); await model.read();
  assert.equal(model.getSnapshot().view.policyRevision, 3); assert.equal(model.getSnapshot().receipt.revision, 1);
  assert.equal(f.calls.increase.length, 1); assert.equal(f.calls.read.at(-1).requestId, 'request-1');
  await model.acknowledge(); assert.equal(model.getSnapshot().pending, null); assert.deepEqual(model.getSnapshot().history, ['request-1']);
});
test('a lost reply survives reopen; None stays unknown and only an explicit same-intent resubmit runs', async () => {
  const f = fixture(), model = createResourceBudgetController(f.options);
  f.api.increase = async intent => { f.calls.increase.push(clone(intent)); throw new Error('reply lost while Native remains in flight'); };
  await model.read(); await model.increase(raised, 0, true); const pending = clone(model.getSnapshot().pending);
  model.dispose(); const reopened = createResourceBudgetController(f.options);
  assert.deepEqual(reopened.getSnapshot().pending, pending); assert.equal(f.calls.increase.length, 1);
  await reopened.resubmit(true); assert.equal(f.calls.increase.length, 1, 'a read is required first');
  await reopened.read(); assert.equal(reopened.getSnapshot().checked, true); assert.equal(reopened.getSnapshot().receipt, null);
  await reopened.resubmit(false); assert.equal(f.calls.increase.length, 1);
  f.response(active(3, { ...raised, maxTotalBytes: 8192 })); f.receipt(receiptFor(pending));
  f.api.increase = async intent => { f.calls.increase.push(clone(intent)); return receiptFor(intent); };
  await reopened.resubmit(true);
  assert.deepEqual(f.calls.increase, [pending, pending]); assert.equal(reopened.getSnapshot().receipt.revision, 1);
  assert.equal(reopened.getSnapshot().view.policyRevision, 3, 'resubmit never silently substitutes a newer CAS revision');
});
test('target changes before dispatch or after an accepted call never retarget a durable selector', async () => {
  const f = fixture(), model = createResourceBudgetController(f.options);
  await model.read(); const save = f.storage.setItem;
  f.storage.setItem = (key, value) => { save(key, value); f.setCurrent(false); };
  await model.increase(raised, 0, true); assert.equal(f.calls.increase.length, 0);
  f.setCurrent(true); const restored = createResourceBudgetController(f.options); assert.equal(restored.getSnapshot().pending.requestId, 'request-1');
  await restored.read(); f.setCurrent(false); await restored.resubmit(true); assert.equal(f.calls.increase.length, 0);
  const other = createResourceBudgetController({ ...f.options, scope: 'different-target', isCurrent: () => true });
  assert.equal(other.getSnapshot().pending, null); assert.equal(f.calls.increase.length, 0);
});
test('a known receipt is not erased by a missing, foreign or older observation', async () => {
  const f = fixture(), model = createResourceBudgetController(f.options);
  await model.read(); await model.increase(raised, 0, true); const known = clone(model.getSnapshot().receipt);
  f.receipt(null); await model.read(); assert.equal(model.getSnapshot().error, 'readFailed'); assert.deepEqual(model.getSnapshot().receipt, known);
  f.receipt({ ...known, requestId: 'peer-request' }); await model.read(); assert.deepEqual(model.getSnapshot().receipt, known);
  f.receipt(known); f.response(active(0)); await model.read(); assert.deepEqual(model.getSnapshot().receipt, known);
  await model.resubmit(true); assert.equal(f.calls.increase.length, 1);
});
test('planned/legacy observations and failed local persistence cannot allocate or change a budget', async () => {
  for (const response of [{ jobId: 'job-owned', phase: 'planned', limits }, { jobId: 'job-owned', phase: 'legacy_untracked' }]) {
    const f = fixture(), model = createResourceBudgetController(f.options); f.response(response);
    await model.read(); await model.increase(raised, 0, true); assert.equal(f.calls.increase.length, 0);
  }
  const f = fixture(), model = createResourceBudgetController(f.options); await model.read();
  f.storage.setItem = () => { throw new Error('browser storage unavailable'); };
  await model.increase(raised, 0, true); assert.equal(f.calls.increase.length, 0); assert.equal(model.getSnapshot().recoveryBlocked, true);
});
test('a still-running Native request is deduplicated by its original identity after an explicit resubmit', async () => {
  const f = fixture(), first = createResourceBudgetController(f.options); let finish;
  const settled = new Promise(resolve => { finish = resolve; });
  f.api.increase = async intent => { f.calls.increase.push(clone(intent)); if (f.calls.increase.length === 1) throw new Error('transport lost'); return settled; };
  await first.read(); await first.increase(raised, 0, true); await first.read();
  const pending = clone(first.getSnapshot().pending), resubmitting = first.resubmit(true);
  for (let i = 0; i < 12 && f.calls.increase.length < 2; i++) await Promise.resolve(); assert.deepEqual(f.calls.increase, [pending, pending]);
  f.receipt(receiptFor(pending)); f.response(active(1, raised)); finish(receiptFor(pending)); await resubmitting;
  assert.equal(first.getSnapshot().receipt.revision, 1);
});
test('a born group is not permission to raise a terminal or newly cancelled batch; old receipts remain readable', async () => {
  const f = fixture(); let mutable = false;
  const model = createResourceBudgetController({ ...f.options, canIncrease: () => mutable });
  await model.read(); await model.increase(raised, 0, true);
  assert.equal(f.calls.increase.length, 0); assert.equal(model.getSnapshot().error, 'jobNotMutable');
  mutable = true; const save = f.storage.setItem;
  f.storage.setItem = (key, value) => { save(key, value); mutable = false; };
  await model.increase(raised, 0, true); assert.equal(f.calls.increase.length, 0);
  const pending = model.getSnapshot().pending; assert.ok(pending);
  f.receipt(receiptFor(pending)); f.response(active(1, raised)); await model.read();
  assert.equal(model.getSnapshot().receipt.revision, 1); assert.equal(f.calls.increase.length, 0);
});
test('an accepted late reply is ignored after account scope changes, retaining only the original local selector', async () => {
  const f = fixture(), model = createResourceBudgetController(f.options); let finish;
  f.api.increase = intent => { f.calls.increase.push(clone(intent)); return new Promise(resolve => { finish = resolve; }); };
  await model.read(); const operation = model.increase(raised, 0, true); for (let i = 0; i < 12 && !finish; i++) await Promise.resolve();
  const pending = clone(model.getSnapshot().pending); f.setCurrent(false); finish(receiptFor(pending)); await operation;
  assert.equal(model.getSnapshot().receipt, null); assert.equal(f.calls.read.length, 1);
  f.setCurrent(true); const reopened = createResourceBudgetController(f.options);
  assert.deepEqual(reopened.getSnapshot().pending, pending); assert.equal(f.calls.increase.length, 1);
});
test('an accepted receipt stays known if its separate current-policy observation fails', async () => {
  const f = fixture(), model = createResourceBudgetController(f.options);
  await model.read(); f.api.read = async () => { throw new Error('observation transport lost'); };
  await model.increase(raised, 0, true);
  assert.equal(model.getSnapshot().receipt.revision, 1); assert.equal(model.getSnapshot().error, 'readFailed');
  await model.resubmit(true); assert.equal(f.calls.increase.length, 1);
});
