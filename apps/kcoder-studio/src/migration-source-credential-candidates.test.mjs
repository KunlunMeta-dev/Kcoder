import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validPrivateCandidatePlanInput, validPrivateCandidateResult } from './migration-source-credential-candidates.js';

const examples = JSON.parse(readFileSync(new URL('../../../scripts/contracts/fixtures.migration-source-credentials.json', import.meta.url)));
function fixture() {
  return { params: structuredClone(examples.MigrationSourceCredentialCandidatesParams.valid.find(row => row.name === 'original_saved_plan_selector').value),
    result: structuredClone(examples.MigrationSourceCredentialCandidatesResult.valid.find(row => row.name === 'saved_plan_exact_entry_mapping').value) };
}

test('only a complete bounded saved job and plan selector can request a destination projection', () => {
  assert.equal(validPrivateCandidatePlanInput({}), true);
  assert.equal(validPrivateCandidatePlanInput({ jobId: null, expectedPlanId: null }), true);
  assert.equal(validPrivateCandidatePlanInput(fixture().params), true);
  for (const value of [{ jobId: 'owned' }, { expectedPlanId: 'owned' }, { jobId: '', expectedPlanId: 'owned' },
    { jobId: 'a'.repeat(257), expectedPlanId: 'owned' }, { jobId: 'owned', expectedPlanId: 'line\nbreak' }]) {
    assert.equal(validPrivateCandidatePlanInput(value), false);
  }
});

test('candidate results bind the original receipt entry, saved job and exact plan without selecting a foreign target', () => {
  const { params, result } = fixture();
  assert.equal(validPrivateCandidateResult(params, result), true);
  for (const change of [value => { value.plan.jobId = 'mig-' + 'e'.repeat(32); }, value => { value.plan.planId = 'plan-' + 'e'.repeat(32); },
    value => { value.entryId = 'e0001-0000'; }, value => { value.items[0].sourceVerificationRequired = false; },
    value => { value.items[0].targets[0].kind = 'provider'; }, value => { value.plan.sequence = Number.MAX_SAFE_INTEGER + 1; }]) {
    const changed = structuredClone(result); change(changed); assert.equal(validPrivateCandidateResult(params, changed), false);
  }
  const plain = { ...params }; delete plain.jobId; delete plain.expectedPlanId;
  assert.equal(validPrivateCandidateResult(plain, result), false);
});

test('candidate pagination and target identities cannot duplicate or hide rows behind a success shape', () => {
  const { params, result } = fixture();
  for (const change of [value => { value.items.push(structuredClone(value.items[0])); value.totalItems = 2; },
    value => { const second = structuredClone(value.items[0]); second.itemId = 'distinct-original-item'; value.items.push(second); value.totalItems = 2; },
    value => { value.nextPage = 1; }, value => { value.totalItems = 11; }]) {
    const changed = structuredClone(result); change(changed); assert.equal(validPrivateCandidateResult(params, changed), false);
  }
  const last = structuredClone(result); last.totalItems = 11;
  assert.equal(validPrivateCandidateResult({ ...params, pageIndex: 1 }, last), true);
});
