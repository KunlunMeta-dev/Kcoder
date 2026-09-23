- The plan is machine-parsed and must start with one `# ` title followed, in this exact order, by `## Context`, `## TODOs`, and `## Final Verification Wave`.
- Under `## TODOs`, use contiguous top-level items `- [ ] 1.`, `- [ ] 2.`, and so on. Every TODO must contain all four exact indented metadata keys: `  - artifacts:`, `  - write_scope:`, `  - acceptance:`, and `  - verify:`. Do not rename them to prose variants such as `expected artifacts`, `write scope`, or `verification`.
- Under `## Final Verification Wave`, use contiguous top-level items `- [ ] F1.`, `- [ ] F2.`, and so on. Every final item must have exactly one indented `  - evidence:` line listing one or more comma-separated types from `process_exit, artifact, citation, manual, schema, visual, not_applicable`. No other checkbox style.
- The Final Verification Wave is how the plan is proven done: binary-observable checks (test suite, build exit code, lsp, curl/CLI assertion).

Minimal valid shape:
```markdown
# Title

## Context
Grounded context.

## TODOs
- [ ] 1. One atomic action.
  - artifacts: path or result
  - write_scope: exact paths, or none
  - acceptance: observable condition
  - verify: exact command or manual check

## Final Verification Wave
- [ ] F1. Run the final check.
  - evidence: process_exit, artifact
```
