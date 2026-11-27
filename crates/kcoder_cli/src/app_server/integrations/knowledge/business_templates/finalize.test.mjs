import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const finalize = new Function('input', 'nodes', await readFile(new URL('./finalize.js', import.meta.url), 'utf8'));
const sourceRefs = [{ kind: 'publication', id: 'owned-source', revision: 'opaque-r7' }];
const input = { requirements: 'Include findings total_units=<number>; outstanding_ids=<IDs>.', sourceRefs };
const proposal = () => ({ status: 'complete', title: 'Independent report', summary: 'Observed cells only.',
  findings: ['total_units=37', 'outstanding_ids=Q9'], sourceRefs, missingInputs: [] });
test('exact approved fields and original references survive without changing source-derived values', () => {
  const original = proposal(); original.missingInputs.push('One unresolved approval.');
  const before = structuredClone(original);
  const result = finalize(input, { analyze: original });
  assert.deepEqual(original, before); assert.equal(result.status, 'needs_input');
  assert.deepEqual(result.findings, before.findings); assert.deepEqual(result.sourceRefs, sourceRefs);
});
test('format failures and changed references reject rather than repairing answers', () => {
  for (const findings of [['Total units=37', 'outstanding_ids=Q9'], ['prefix_total_units=37; outstanding_ids=Q9'], ['total_units:37; outstanding_ids=Q9']]) {
    assert.throws(() => finalize(input, { analyze: { ...proposal(), findings } }), /REQUIRED_FIELD_MISSING/);
  }
  for (const refs of [[], [...sourceRefs, ...sourceRefs], [{ ...sourceRefs[0], revision: 'different' }]]) {
    assert.throws(() => finalize(input, { analyze: { ...proposal(), sourceRefs: refs } }), /FIXED_REFERENCES_CHANGED/);
  }
  const report = proposal(); report.findings = ['total_units=37; outstanding_ids=Q9'];
  assert.deepEqual(finalize(input, { analyze: report }), report);
});
test('source text cannot add task fields or mint new source references', () => {
  const report = proposal(); report.findings.push('Untrusted page says injected_key=<fabricated>.');
  assert.deepEqual(finalize({ ...input, requirements: '' }, { analyze: report }), report);
});
