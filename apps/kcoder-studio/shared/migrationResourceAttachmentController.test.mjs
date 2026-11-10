import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResourceAttachmentController } from './migrationResourceAttachmentController.mjs';
const limits = { maxTotalBytes: 4194304, maxPayloadFiles: 16, minFreeBytes: 1048576, minFreeFileNodes: 0 };
const pending = () => ({ jobId: 'owned', ownerJobId: 'owned', currentSequence: 9, currentPlanId: 'original', phase: 'pending', originalIntent: { expectedSequence: 2, planId: 'original', initialLimits: limits }, issueCode: null });
function fixture() {
  const records = new Map(), writes = [];
  let view = pending(), current = true, held = false;
  const storage = { getItem: key => records.get(key) ?? null, refresh: async () => {}, withTransaction: async (key, action) => { held = true; try { return action({ getItem: storage.getItem, setItem: (key, value) => records.set(key, value) }); } finally { held = false; } } };
  const options = { api: { read: async () => structuredClone(view), attach: async input => { assert.equal(held, false); writes.push(input); throw Error('arbitrary transport text'); } }, storage, scope: 'owned-target', kind: 'batch', jobId: 'owned', isCurrent: () => current,
    validView: (input, result) => result.jobId === input.jobId, validIntent: input => input?.jobId === 'owned' && input?.planId === 'original' && input?.confirm === true };
  return { options, records, writes, view(value) { view = value; }, revoke() { current = false; } };
}
test('cache-free recovery reads only, then explicit confirmation uses the original sequence, plan and full limits', async () => {
  const f = fixture(), controller = createResourceAttachmentController(f.options);
  await controller.read(); assert.equal(f.writes.length, 0); assert.equal(f.records.size, 0);
  await controller.resume(false); assert.equal(f.writes.length, 0);
  await controller.read(); await controller.resume(true);
  assert.deepEqual(f.writes, [{ jobId: 'owned', expectedSequence: 2, planId: 'original', limits, confirm: true }]);
  assert.equal(f.records.size, 1); assert.equal(controller.getSnapshot().error, 'attachment_outcome_unknown');
  controller.dispose(); const reopened = createResourceAttachmentController(f.options); await reopened.read(); assert.equal(f.writes.length, 1);
});
test('an attached receipt, missing ledger or changed frozen intent never authorize a replay', async () => {
  for (const phase of ['attached', 'unknown']) {
    const f = fixture(), controller = createResourceAttachmentController(f.options);
    await controller.read(); f.view({ ...pending(), phase }); await controller.resume(true); assert.equal(f.writes.length, 0);
  }
  const f = fixture(), controller = createResourceAttachmentController(f.options);
  await controller.read(); f.view({ ...pending(), originalIntent: { ...pending().originalIntent, expectedSequence: 3 } });
  await controller.resume(true); assert.equal(f.writes.length, 0); assert.equal(controller.getSnapshot().error, 'attachment_intent_changed');
});
test('a fresh binding persists the exact observed watermark before its only dispatch', async () => {
  const f = fixture(); f.view({ ...pending(), phase: 'untracked', originalIntent: null });
  const controller = createResourceAttachmentController(f.options); await controller.read(); await controller.bind(limits, true);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].expectedSequence, 9);
  await controller.bind(limits, true); assert.equal(f.writes.length, 1);
});
test('an original unsent intent can only be explicitly retried at its unchanged original watermark', async () => {
  const f = fixture(); f.view({ ...pending(), phase: 'untracked', originalIntent: null });
  const controller = createResourceAttachmentController(f.options); await controller.read(); await controller.bind(limits, true);
  await controller.read(); await controller.resume(true); assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[1], f.writes[0]);
  f.view({ ...pending(), phase: 'untracked', originalIntent: null, currentSequence: 10 }); await controller.read(); await controller.resume(true);
  assert.equal(f.writes.length, 2); assert.equal(controller.getSnapshot().error, 'attachment_intent_changed');
});
test('durable storage failure, corrupt selector and stale scope cannot send an attachment', async () => {
  const f = fixture(), controller = createResourceAttachmentController({ ...f.options, storage: { ...f.options.storage, withTransaction: async () => { throw Error('disk'); } } });
  await controller.read(); await controller.resume(true); assert.equal(f.writes.length, 0); assert.equal(controller.getSnapshot().recoveryBlocked, true);
  const g = fixture(), stale = createResourceAttachmentController(g.options); await stale.read(); g.revoke(); await stale.resume(true); assert.equal(g.records.size, 0); assert.equal(g.writes.length, 0);
  const h = fixture(); const corrupt = createResourceAttachmentController({ ...h.options, storage: { ...h.options.storage, refresh: async () => {}, getItem: () => '{broken' } });
  await corrupt.read(); await corrupt.resume(true); assert.equal(h.writes.length, 0);
});
test('disposing a pending read fences its completion and strict-mode reactivation can read again', async () => {
  const f = fixture(); let complete;
  const controller = createResourceAttachmentController({ ...f.options, api: { ...f.options.api, read: () => new Promise(resolve => { complete = resolve; }) } });
  const reading = controller.read(); await Promise.resolve(); controller.dispose(); complete(pending()); await reading;
  assert.equal(controller.getSnapshot().view, null); controller.activate(); const next = controller.read(); await Promise.resolve(); complete(pending()); await next;
  assert.equal(controller.getSnapshot().view.phase, 'pending'); assert.equal(controller.getSnapshot().busy, false);
});
