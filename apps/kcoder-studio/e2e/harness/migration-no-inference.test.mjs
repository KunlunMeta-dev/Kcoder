import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoMigrationInference, migrationRequestAudit } from './migration-no-inference.mjs';
test('only the exact HEAD connectivity route is exempt from migration inference assertions', () => {
  assert.deepEqual(assertNoMigrationInference([{ method: 'HEAD', path: '/v1/chat/completions' }]), {
    totalRequests: 1, connectivityRequests: 1, inferenceRequests: 0, unexpectedRequests: [],
  });
  for (const request of [{ method: 'HEAD', path: '/other' }, { method: 'GET', path: '/v1/models' },
    { method: 'POST', path: '/v1/chat/completions' }, { method: 'POST', path: '/other' }])
    assert.throws(() => assertNoMigrationInference([request]));
  assert.equal(migrationRequestAudit([{ method: 'POST', path: '/v1/chat/completions' }]).inferenceRequests, 1);
});
