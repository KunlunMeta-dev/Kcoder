import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayRequestOutcome, gatewayRequestTimeoutMs } from '../shared/gatewayRequestDeadline.js';

test('Wiki verification lists are read-only; decisions and pending organization stay unknown', () => {
  for (const method of ['knowledge/findings/list', 'knowledge/pending/list']) {
    assert.equal(gatewayRequestOutcome(method), 'readOnly', method);
    assert.equal(gatewayRequestTimeoutMs(method), 30000, method);
  }
  // A lost receipt for a decision or a new organization job is never a safe resend.
  for (const method of ['knowledge/findings/decide', 'knowledge/pending/organize', 'knowledge/job/resume']) {
    assert.equal(gatewayRequestOutcome(method), 'unknown', method);
    assert.equal(gatewayRequestTimeoutMs(method), 120000, method);
  }
});
