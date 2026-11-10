import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayRequestOutcome, gatewayRequestTimeoutMs } from '../shared/gatewayRequestDeadline.js';
test('budget read is exact read-only; increases and invented variants keep unknown outcomes', () => {
  assert.equal(gatewayRequestOutcome('migration/batch/resources/read'), 'readOnly');
  assert.equal(gatewayRequestTimeoutMs('migration/batch/resources/read'), 30000);
  for (const method of ['migration/batch/resources/increase', 'migration/batch/resources/read/all', 'migration/batch/resources/read-unsafe']) {
    assert.equal(gatewayRequestOutcome(method), 'unknown'); assert.equal(gatewayRequestTimeoutMs(method), 120000);
  }
});
