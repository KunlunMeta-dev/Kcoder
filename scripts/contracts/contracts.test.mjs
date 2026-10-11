import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isContract, allowedFields, knownValues, errorCodes } from '../../apps/kcoder-studio/shared/generated/validator.mjs';

// These same versioned cases are decoded by the Rust exporter before generation.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)));
for (const [name, cases] of Object.entries(fixtures)) {
  test(`${name}: Rust-compatible legacy/current values and invalid wire rejection`, () => {
    for (const example of cases.valid) assert.equal(isContract(name, example.value), true, example.name);
    for (const example of cases.invalid) assert.equal(isContract(name, example.value), false, example.name);
    if (allowedFields[name]) for (const example of cases.valid) {
      for (const field of Object.keys(example.value)) assert.ok(allowedFields[name].includes(field), field);
    }
  });
}
test('wire validation rejects non-JSON object inheritance and unsafe integer precision', () => {
  const summary = fixtures.ModelConfigurationSummary.valid[0].value;
  assert.equal(isContract('ModelConfigurationSummary', Object.assign(Object.create({ apiKey: 'secret' }), summary)), false);
  assert.equal(isContract('ModelConfigurationSummary', { ...summary, contextWindowTokens: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(isContract('ModelConfigurationSummary', { ...summary, contextWindowTokens: Infinity }), false);
  assert.equal(isContract('UnregisteredPrivateContract', summary), false);
});


for (const name of ['TaskStatus', 'TurnAttemptStatus', 'WikiJobStatus', 'WikiJobPhase']) {
  test(`${name} metadata describes known facts while preserving unknown UTF-8 labels`, () => {
    assert.ok(knownValues[name].includes(name === 'WikiJobPhase' ? 'source_support' : 'completed'));
    assert.equal(knownValues[name].includes('future_review'), false);
    assert.equal(isContract(name, 'future_review'), true);
    assert.equal(isContract(name, '汉'.repeat(85) + 'a'), true);
    assert.equal(isContract(name, '汉'.repeat(85) + 'ab'), false);
    assert.equal(isContract(name, '\ud800'), false);
  });
}
test('MCP reason/error labels and omitted legacy facts come from the actual serde contract', () => {
  assert.deepEqual(Object.keys(errorCodes.McpFailureReason).sort(), [...knownValues.McpFailureReason].sort());
  assert.equal(errorCodes.McpFailureReason.protocolFailed, 'mcp_protocol_failed');
  assert.equal(errorCodes.McpFailureReason.authorizationRequired, 'mcp_authorization_required');
  const examples = JSON.parse(readFileSync(new URL('../../apps/kcoder-studio/shared/generated/examples.json', import.meta.url)));
  const oldAttempt = examples.McpConnectionAttempt.find(example => example.name === 'legacy_missing_reason');
  assert.deepEqual(oldAttempt.decoded, { status: 'unavailable' });
  const oldServer = examples.McpServerSummary.find(example => example.name === 'legacy_without_failure_fields');
  assert.equal(Object.hasOwn(oldServer.decoded, 'lastConnectionFailure'), false);
  const extended = { ...oldServer.value, futureDetail: 'fixture-sensitive-field' };
  assert.equal(isContract('McpServerSummary', extended), true);
  const projection = Object.fromEntries(Object.entries(extended).filter(([key]) => allowedFields.McpServerSummary.includes(key)));
  assert.equal(Object.hasOwn(projection, 'futureDetail'), false);
});
