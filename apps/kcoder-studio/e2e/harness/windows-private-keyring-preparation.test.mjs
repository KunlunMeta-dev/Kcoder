import assert from 'node:assert/strict';
import test from 'node:test';
import { assertKeyringSamePreparation } from './windows-private-keyring-state.mjs';

const original = { requestId: 'original-request', jobId: 'original-job', sequence: 3, phase: 'prepared',
  originalPlanId: 'original-plan', planId: 'credential-plan', offerIds: ['offer-a', 'offer-b'],
  expectedSequence: 2, consent: { apiKeys: true, mcpPrivateFields: true } };
test('publication advances the observed sequence without changing the original prepare intent or CAS', () => {
  const current = { ...structuredClone(original), sequence: 7 };
  assertKeyringSamePreparation(current, original);
  assert.equal(original.sequence, 3); assert.equal(current.expectedSequence, 2);
});
test('changing original plan, set, consent or original CAS still blocks cleanup before any mutation', () => {
  for (const delta of [{ expectedSequence: 7 }, { planId: 'peer' }, { offerIds: ['offer-a'] },
    { consent: { apiKeys: false, mcpPrivateFields: true } }, { sequence: 2 }, { sequence: NaN }, { ciphertext: 'rejected' }]) {
    assert.throws(() => assertKeyringSamePreparation({ ...structuredClone(original), sequence: 7, ...delta }, original));
  }
});
