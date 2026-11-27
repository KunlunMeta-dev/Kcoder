import assert from 'node:assert/strict';

export const BUSINESS_LIMITS = Object.freeze({ outputTokens: 1024, runTokens: 20_000,
  runSeconds: 90, runs: 6, requestsPerRun: 4, requests: 24, suiteTokensUpper: 120_000,
  suiteSeconds: 600, retries: 0 });
export const businessCases = Object.freeze([
  { id: 'weekly-report', pages: ['worklog'], requirements: 'Compute completed_units as the sum of completed task units and pending_units as the pending task units. Include separate findings completed_units=<number> and pending_units=<number>. Preserve the pending approval risk and task identifiers. Present a concise work report; do not discuss envelope metadata or table structure. Keep opaque revision identifiers in sourceRefs. Distinguish report completion from completion of its underlying tasks; record actual evidence gaps without inventing required inputs.' },
  { id: 'report-reconciliation', pages: ['report-baseline', 'report-current'], requirements: 'Compare both complete tables. Include findings changed_R2=<old amount>-><new amount>; duplicate_ids=<IDs>; missing_amount_ids=<IDs>; currency_changed_ids=<IDs>. Do not fill missing values or infer an exchange rate.' },
  { id: 'source-digest', pages: ['worklog', 'deadlines'], requirements: 'Group the supplied source claims and independently checked arithmetic. Include findings completed_units=<number>; pending_units=<number>; overdue_ids=<open item IDs strictly before asOfDate>. Do not infer completion or new dates.' },
  { id: 'deadline-reminder', pages: ['deadlines'], requirements: 'Include findings overdue_ids=<open item IDs strictly before asOfDate>; upcoming_ids=<open item IDs from asOfDate through seven days later>; overdue_days_D1=<integer number of days from the supplied due date to asOfDate for D-1>. Include the supplied owners and due dates. Omit completed items from these two lists.' },
  { id: 'policy-update', pages: ['policy-baseline', 'policy-current'], requirements: 'Distinguish a source document version from its fixed publication revision. Include findings meal_cap=<approved amount>-><proposed amount>; approvers=<approved number>-><proposed number>; proposed_policy_currently_applicable=<yes/no/unknown>. Explain unresolved approval in missingInputs; publication is not policy approval.' },
  { id: 'new-materials', pages: ['material-a', 'material-a-duplicate', 'material-missing'], requirements: 'Compare complete markdown content for exact duplicates, while retaining all original source references. Include findings unique_materials=<number>; duplicate_group=<material IDs>; missing_author_ids=<material IDs>; missing_date_ids=<material IDs>. Report missing metadata in missingInputs; do not delete or modify originals.' },
]);
const refKey = reference => JSON.stringify([reference.kind, reference.id, reference.revision]);
const findings = output => output.findings.map(value => value.replace(/[`*]/g, '')).join('\n');
function number(output, field, expected) {
  const match = findings(output).match(new RegExp(`\\b${field}\\s*[:=]\\s*(\\d+)\\b`, 'i'));
  assert.ok(match, `missing factual field ${field}`); assert.equal(Number(match[1]), expected, field);
}
function ids(output, field, expected) {
  const match = findings(output).match(new RegExp(`\\b${field}\\s*[:=]([^;\\n]*)`, 'i'));
  assert.ok(match, `missing factual field ${field}`);
  assert.deepEqual([...new Set(match[1].match(/\b[A-Z]-\d{1,3}\b/g) ?? [])].sort(), [...expected].sort(), field);
}
function transition(output, field, before, after, expectedCurrency = null, perPerson = false) {
  const dimension = perPerson ? '(?:\\s+per\\s+person)?' : '';
  const value = findings(output);
  const match = value.match(new RegExp(`\\b${field}\\s*[:=]\\s*(\\d+(?:\\.\\d+)?)(?:\\s*([A-Z]{3})\\b)?${dimension}\\s*(?:->|→|to)\\s*(\\d+(?:\\.\\d+)?)(?:\\s*([A-Z]{3})\\b)?${dimension}`, 'i'));
  assert.ok(match, field);
  assert.equal(Number(match[1]), before, `${field} original value`);
  assert.equal(Number(match[3]), after, `${field} new value`);
  for (const currency of [match[2], match[4]].filter(Boolean))
    assert.equal(currency.toUpperCase(), expectedCurrency, `${field} source currency`);
  assert.doesNotMatch(value.slice(match.index + match[0].length), /^\s+per\b/i, `${field} source dimension`);
}
export function businessResult(run, id) {
  assert.equal(run.status, 'completed', 'only actual canonical completion has a result');
  const value = JSON.parse(run.output);
  assert.equal(value.workflowId, `builtin-office-${id}`); assert.equal(value.version, 1);
  assert.ok(Array.isArray(value.outputs));
  const stages = value.outputs.map(node => node.nodeId);
  assert.ok(JSON.stringify(stages) === JSON.stringify(['produce']) || JSON.stringify(stages) === JSON.stringify(['analyze', 'produce']), 'only the fixed report stages are accepted');
  const result = value.outputs.find(node => node.nodeId === 'produce').output;
  return typeof result === 'string' ? JSON.parse(result) : result;
}
/** Independent corpus checks; schema completion or a model self-report is insufficient. */
export function validateBusinessResult(task, output, references, sourceProofs, pageHashes) {
  assert.deepEqual(Object.keys(output).sort(), ['status', 'title', 'summary', 'findings', 'sourceRefs', 'missingInputs'].sort());
  assert.ok(['complete', 'needs_input'].includes(output.status));
  assert.ok(typeof output.title === 'string' && output.title.trim()); assert.ok(typeof output.summary === 'string' && output.summary.trim());
  assert.ok(Array.isArray(output.findings) && output.findings.length > 0 && output.findings.every(value => typeof value === 'string'));
  assert.ok(Array.isArray(output.missingInputs) && output.missingInputs.every(value => typeof value === 'string'));
  assert.deepEqual(output.sourceRefs.map(refKey).sort(), references.map(refKey).sort(), 'all and only selected fixed source revisions must be cited');
  for (const [index, reference] of references.entries()) {
    const proof = sourceProofs.find(value => value.index === index && refKey(value.reference) === refKey(reference));
    assert.ok(proof, 'the actual next Provider request must contain a complete native source-tool result');
    assert.ok(proof.pageHashes.length > 0);
    for (const page of proof.pageHashes) {
      const expected = pageHashes.get(JSON.stringify([page.libraryId, page.pageId, page.pageRevision]));
      assert.equal(page.markdownSha256, expected, 'actual source body must match its immutable native corpus revision');
    }
  }
  const combined = `${output.summary}\n${findings(output)}`;
  if (task.id === 'weekly-report' || task.id === 'source-digest') {
    number(output, 'completed_units', 20); number(output, 'pending_units', 5);
  }
  if (task.id === 'weekly-report') {
    assert.match(combined, /T-103/);
    const numbers = new Map([['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9]]);
    for (const match of combined.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|\d+)\s+(?:table\s+)?columns?\b/gi))
      assert.equal(numbers.get(match[1].toLowerCase()) ?? Number(match[1]), 5, 'the actual work-log header has five columns');
  }
  if (task.id === 'report-reconciliation') {
    transition(output, 'changed_R2', 200, 180, 'CNY'); ids(output, 'duplicate_ids', ['R-2']);
    ids(output, 'missing_amount_ids', ['R-3']); ids(output, 'currency_changed_ids', ['R-4']);
    assert.ok(output.missingInputs.length > 0, 'missing report values remain unresolved');
  }
  if (task.id === 'source-digest' || task.id === 'deadline-reminder') ids(output, 'overdue_ids', ['D-1']);
  if (task.id === 'deadline-reminder') {
    ids(output, 'upcoming_ids', ['D-2']); number(output, 'overdue_days_D1', 2); assert.match(combined, /Mira/); assert.match(combined, /Noah/);
    assert.match(combined, /2026-10-22/); assert.match(combined, /2026-10-26/);
  }
  if (task.id === 'policy-update') {
    transition(output, 'meal_cap', 80, 100, 'CNY', true); transition(output, 'approvers', 1, 2);
    assert.match(findings(output), /proposed_policy_currently_applicable\s*[:=]\s*(?:no|false|unknown)\b/i);
    assert.ok(output.missingInputs.length > 0, 'draft approval must remain unresolved');
  }
  if (task.id === 'new-materials') {
    number(output, 'unique_materials', 2); ids(output, 'duplicate_group', ['M-001', 'M-002']);
    ids(output, 'missing_author_ids', ['M-003']); ids(output, 'missing_date_ids', ['M-003']);
    assert.ok(output.missingInputs.length > 0, 'missing author and date cannot be fabricated');
  }
  return { factualChecks: true, fixedSourceCitations: references.length, completeNativeSourceProofs: references.length,
    unresolvedInputs: output.missingInputs.length, outcome: output.status };
}
