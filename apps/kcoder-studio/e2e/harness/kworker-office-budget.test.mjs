import assert from 'node:assert/strict';
import test from 'node:test';
import { officeBudget, officeBudgetMeter } from './kworker-office-budget.mjs';
const env = { KCODER_E2E_OFFICE_INPUT_USD_PER_MILLION: '0.1', KCODER_E2E_OFFICE_OUTPUT_USD_PER_MILLION: '0.2' };
const metadata = { model: 'test-model', bodyBytes: 1000, outputTokenLimit: 4096, exposedToolNames: ['read'] };
test('office paid-call budget requires explicit pricing and rejects invalid or unbounded overrides', () => {
  assert.throws(() => officeBudget({}), /USD-per-million/);
  for (const value of ['0','-1','8193','NaN','Infinity']) assert.throws(() => officeBudget({ ...env, KCODER_E2E_MODEL_MAX_TOKENS: value }), /budget/);
  for (const value of ['0','21','NaN']) assert.throws(() => officeBudget({ ...env, KCODER_E2E_OFFICE_MAX_USD: value }), /cost cap/);
  const budget = officeBudget(env); assert.equal(budget.caseCount, 4); assert.equal(budget.requestsPerCase, 8); assert.equal(budget.providerRetries, 0);
});
test('office meter refuses additional calls before dispatch and retains the last valid reservation', () => {
  const budget = officeBudget(env), meter = officeBudgetMeter(budget, 'test-model');
  assert.throws(() => meter.admit(metadata), /case\/wall/);
  meter.beginCase('documents');
  for (let i = 0; i < 8; i++) meter.admit(metadata);
  assert.throws(() => meter.admit(metadata), /count budget/);
  assert.equal(meter.snapshot().requests, 8);
  meter.beginCase('sheets');
  assert.throws(() => meter.admit({ ...metadata, model: 'unexpected' }), /mismatch/);
  assert.throws(() => meter.admit({ ...metadata, bodyBytes: budget.maxInputBytes + 1 }), /mismatch/);
  assert.throws(() => meter.admit({ ...metadata, outputTokenLimit: budget.outputTokens + 1 }), /mismatch/);
  assert.equal(meter.snapshot().requests, 8);
});
test('office wall and estimated dollar limits stop new external requests without fake success', () => {
  const budget = officeBudget({ ...env, KCODER_E2E_OFFICE_MAX_USD: '0.00001' });
  let now = 0; const meter = officeBudgetMeter(budget, 'test-model', () => now);
  meter.beginCase('documents'); assert.throws(() => meter.admit(metadata), /estimated-cost/); assert.equal(meter.snapshot().requests, 0);
  now = budget.caseWallMs + 1; assert.throws(() => meter.admit(metadata), /wall budget/);
});
