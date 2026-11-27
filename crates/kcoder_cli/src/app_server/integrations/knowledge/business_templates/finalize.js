// This function body runs in the existing isolated Workflow Code runtime.
const report = JSON.parse(JSON.stringify(nodes.analyze));
const requiredFields = new Set();
for (const match of input.requirements.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*<[^>\n]{1,160}>/g)) {
  requiredFields.add(match[1]);
}
for (const field of requiredFields) {
  const label = new RegExp('(?:^|;)\\s*' + field + '\\s*=');
  if (!report.findings.some(finding => label.test(finding))) {
    throw new Error('BUSINESS_REPORT_REQUIRED_FIELD_MISSING:' + field);
  }
}
const identity = reference => JSON.stringify([reference.kind, reference.id, reference.revision]);
const selected = input.sourceRefs.map(identity).sort();
const cited = report.sourceRefs.map(identity).sort();
if (JSON.stringify(selected) !== JSON.stringify(cited)) {
  throw new Error('BUSINESS_REPORT_FIXED_REFERENCES_CHANGED');
}
if (report.missingInputs.length > 0) report.status = 'needs_input';
return report;
