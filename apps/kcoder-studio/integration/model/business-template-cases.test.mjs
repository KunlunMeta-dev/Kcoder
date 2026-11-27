import test from 'node:test';
import assert from 'node:assert/strict';
import { businessCases, businessResult, validateBusinessResult, BUSINESS_LIMITS } from './business-template-cases.mjs';

const facts = {
  'weekly-report': ['completed_units=20', 'pending_units=5', 'T-103 awaits approval'],
  'report-reconciliation': ['changed_R2=200->180', 'duplicate_ids=R-2', 'missing_amount_ids=R-3', 'currency_changed_ids=R-4'],
  'source-digest': ['completed_units=20', 'pending_units=5', 'overdue_ids=D-1'],
  'deadline-reminder': ['overdue_ids=D-1', 'upcoming_ids=D-2', 'overdue_days_D1=2', 'Mira: 2026-10-22; Noah: 2026-10-26'],
  'policy-update': ['meal_cap=80->100', 'approvers=1->2', 'proposed_policy_currently_applicable=no'],
  'new-materials': ['unique_materials=2', 'duplicate_group=M-001,M-002', 'missing_author_ids=M-003', 'missing_date_ids=M-003'],
};
function input(task) {
  const references = task.pages.map(id => ({ kind: 'publication', id, revision: '1' }));
  const pageHashes = new Map(), proofs = references.map((reference, index) => {
    const page = { libraryId: 'owned', pageId: `page-${index}`, pageRevision: 'r1', markdownSha256: 'a'.repeat(64) };
    pageHashes.set(JSON.stringify([page.libraryId, page.pageId, page.pageRevision]), page.markdownSha256);
    return { index, reference, sha256: 'b'.repeat(64), pageHashes: [page] };
  });
  return { references, proofs, pageHashes, output: { status: 'needs_input', title: 'Synthetic validator example', summary: 'Supplied source findings',
    findings: facts[task.id], sourceRefs: references, missingInputs: ['Only supplied evidence is accepted.'] } };
}
for (const task of businessCases) test(`independent ${task.id} validator requires exact source versions and corpus facts`, () => {
  const value = input(task);
  assert.equal(validateBusinessResult(task, value.output, value.references, value.proofs, value.pageHashes).factualChecks, true);
  const wrong = structuredClone(value.output); wrong.sourceRefs[0].revision = '2';
  assert.throws(() => validateBusinessResult(task, wrong, value.references, value.proofs, value.pageHashes));
  assert.throws(() => validateBusinessResult(task, value.output, value.references, [], value.pageHashes));
  const missing = structuredClone(value.output); missing.findings = ['The model says it completed everything.'];
  assert.throws(() => validateBusinessResult(task, missing, value.references, value.proofs, value.pageHashes));
});
test('canonical output reader requires the original completed fixed node and bounded test intent', () => {
  const output = input(businessCases[0]).output;
  const run = { status: 'completed', output: JSON.stringify({ workflowId: 'builtin-office-weekly-report', version: 1,
    outputs: [{ nodeId: 'produce', output }] }) };
  assert.deepEqual(businessResult(run, 'weekly-report'), output);
  assert.throws(() => businessResult({ ...run, status: 'running' }, 'weekly-report'));
  assert.throws(() => businessResult(run, 'source-digest'));
  assert.equal(BUSINESS_LIMITS.outputTokens, 1024); assert.equal(BUSINESS_LIMITS.runTokens, 20_000);
  assert.equal(BUSINESS_LIMITS.suiteTokensUpper, 120_000); assert.equal(BUSINESS_LIMITS.retries, 0);
});
test('a completed report may document pending work, but unsupported column counts still fail', () => {
  const task = businessCases[0], value = input(task);
  value.output.status = 'complete';
  assert.equal(validateBusinessResult(task, value.output, value.references, value.proofs, value.pageHashes).factualChecks, true);
  value.output.findings = [...value.output.findings, 'The source has four table columns.'];
  assert.throws(() => validateBusinessResult(task, value.output, value.references, value.proofs, value.pageHashes));
});
test('reconciliation accepts explicit matching source currency while rejecting wrong values and conversions', () => {
  const task = businessCases.find(value => value.id === 'report-reconciliation');
  const value = input(task);
  value.output.findings = ['changed_R2=200 CNY->180 CNY (old and new source rows)', ...facts[task.id].slice(1)];
  assert.equal(validateBusinessResult(task, value.output, value.references, value.proofs, value.pageHashes).factualChecks, true);
  for (const transition of ['180 CNY->200 CNY', '200 USD->180 USD', '200 CNY->180 USD', '2000 CNY->180 CNY']) {
    value.output.findings = [`changed_R2=${transition}`, ...facts[task.id].slice(1)];
    assert.throws(() => validateBusinessResult(task, value.output, value.references, value.proofs, value.pageHashes));
  }
});
test('report reader selects the deterministic final stage and rejects duplicate or foreign stages', () => {
  const proposal = input(businessCases[0]).output;
  const report = { ...proposal, status: 'needs_input' };
  const outputs = [{ nodeId: 'analyze', output: proposal }, { nodeId: 'produce', output: report }];
  const run = values => ({ status: 'completed', output: JSON.stringify({ workflowId: 'builtin-office-weekly-report', version: 1, outputs: values }) });
  assert.deepEqual(businessResult(run(outputs), 'weekly-report'), report);
  assert.throws(() => businessResult(run([...outputs, outputs[1]]), 'weekly-report'));
  assert.throws(() => businessResult(run([{ nodeId: 'foreign', output: report }, outputs[1]]), 'weekly-report'));
});
test('policy comparisons preserve the supplied per-person unit and reject changed dimensions', () => {
  const task = businessCases.find(value => value.id === 'policy-update'), value = input(task);
  value.output.findings = ['meal_cap=80 CNY per person->100 CNY per person', ...facts[task.id].slice(1)];
  assert.equal(validateBusinessResult(task, value.output, value.references, value.proofs, value.pageHashes).factualChecks, true);
  for (const change of ['80 CNY per day->100 CNY per person', '80 CNY per person->100 CNY per team', '80 USD per person->100 USD per person']) {
    value.output.findings = [`meal_cap=${change}`, ...facts[task.id].slice(1)];
    assert.throws(() => validateBusinessResult(task, value.output, value.references, value.proofs, value.pageHashes));
  }
});
test('an explicitly unresolved policy may remain unknown with evidence gaps, never approved', () => {
  const task = businessCases.find(value => value.id === 'policy-update'), value = input(task);
  value.output.findings = [...facts[task.id].slice(0, 2), 'proposed_policy_currently_applicable=unknown'];
  assert.equal(validateBusinessResult(task, value.output, value.references, value.proofs, value.pageHashes).factualChecks, true);
  const noGaps = { ...value.output, missingInputs: [] };
  assert.throws(() => validateBusinessResult(task, noGaps, value.references, value.proofs, value.pageHashes));
  value.output.findings = [...facts[task.id].slice(0, 2), 'proposed_policy_currently_applicable=yes'];
  assert.throws(() => validateBusinessResult(task, value.output, value.references, value.proofs, value.pageHashes));
});
