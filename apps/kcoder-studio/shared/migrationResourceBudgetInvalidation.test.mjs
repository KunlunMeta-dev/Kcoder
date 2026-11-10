import test from 'node:test';
import assert from 'node:assert/strict';
import { expiredBudgetObservation, expiredBudgetHistoryRow, normalizeBudgetCache } from './migrationResourceBudgetInvalidation.mjs';
const limits = { maxTotalBytes: 8388608, maxPayloadFiles: 8, minFreeBytes: 1048576, minFreeFileNodes: 0 };
const intent = { jobId: 'mig-owned', planId: 'plan-owned', requestId: 'original', expectedPolicyRevision: 0, confirm: true, limits: { ...limits, maxPayloadFiles: 12 } };
const query = { jobId: intent.jobId, requestId: intent.requestId };
const view = { phase: 'active', jobId: intent.jobId, policyRevision: 1, limits, usage: { committedBytes: 1000, reservedBytes: 0, committedFiles: 5, reservedFiles: 0 } };
const validIntent = value => value?.jobId === intent.jobId && value?.confirm === true && value.limits?.minFreeBytes === 1048576;
const validView = (q, result) => q?.jobId === result?.jobId && Number.isSafeInteger(result?.policyRevision) && !!result?.limits && !!result?.usage;
const options = { jobId: intent.jobId, validIntent, validView };
test('only a greater revision in the exact original query can prove an old CAS is no longer acceptable', () => {
  for (const [q, snapshot] of [[query, { ...view, policyRevision: 0 }], [query, { ...view, phase: 'planned' }], [{ ...query, requestId: 'peer' }, view], [{ ...query, jobId: 'peer' }, view], [query, { ...view, jobId: 'peer' }], [query, { ...view, requestedReceipt: { requestId: intent.requestId } }], [query, { ...view, requestedReceipt: { requestId: 'peer' } }], [query, { ...view, policyRevision: Number.MAX_SAFE_INTEGER + 1 }]]) assert.equal(expiredBudgetObservation(intent, q, snapshot), null);
  assert.ok(expiredBudgetObservation(intent, query, view));
  assert.equal(expiredBudgetObservation(intent, query, { phase: 'legacy_untracked', jobId: intent.jobId }), null);
});
test('an archive retains a complete independent original intent and its exact query/snapshot, never a rewritten CAS', () => {
  const original = structuredClone(intent), observed = structuredClone(view);
  const row = expiredBudgetHistoryRow(original, query, observed, validView);
  original.expectedPolicyRevision = 100; observed.policyRevision = 100; observed.limits.maxPayloadFiles = 100;
  assert.equal(row.intent.expectedPolicyRevision, 0); assert.equal(row.observation.view.policyRevision, 1);
  assert.equal(row.observation.view.limits.maxPayloadFiles, 8); assert.equal(row.intent.limits.maxPayloadFiles, 12);
  assert.equal(expiredBudgetHistoryRow(intent, query, {}, validView), null);
});
test('legacy selectors normalize in memory while bounded full expired history rejects mismatched or fabricated evidence', () => {
  const legacy = { version: 1, pending: intent, history: ['older'] }, before = JSON.stringify(legacy);
  const normalized = normalizeBudgetCache(legacy, options);
  assert.equal(JSON.stringify(legacy), before); assert.deepEqual(normalized.history, [{ kind: 'acknowledged', requestId: 'older' }]);
  const row = expiredBudgetHistoryRow(intent, query, view, validView), cache = { version: 2, pending: null, history: [row] };
  assert.deepEqual(normalizeBudgetCache(cache, options), cache);
  for (const invalid of [
    { ...cache, extra: true }, { ...cache, history: Array(11).fill(row) }, { ...cache, history: [row, row] },
    { ...cache, history: [{ ...row, requestId: 'peer' }] },
    { ...cache, history: [{ ...row, observation: { ...row.observation, view: { ...view, policyRevision: 0 } } }] },
    { ...cache, history: [{ ...row, observation: { ...row.observation, query: { ...query, requestId: 'peer' } } }] },
    { ...cache, history: [{ ...row, observation: { ...row.observation, view: { ...view, requestedReceipt: {} } } }] },
  ]) assert.equal(normalizeBudgetCache(invalid, options), null);
});
