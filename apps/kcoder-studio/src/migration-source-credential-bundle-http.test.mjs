// Actual HTTP routing/service/Bridge modules with a synthetic Native endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMigrationSourceOperationHttp } from './migration-source-operation-http.js';
import { MigrationSourceTransferService } from './migration-source-transfer-service.js';
import { captureMigrationSourceEndpoint } from './migration-source-bridge.js';
const examples = JSON.parse(readFileSync(new URL('../shared/generated/examples.migration-source-credentials.json', import.meta.url)));
const sample = name => structuredClone(examples[name][0].value);
function fixture(mode = 'normal') {
  const payload = sample('MigrationSourceCredentialPrepareParams'), native = sample('MigrationSourceCredentialPrepareResult');
  payload.jobId = native.job.job.jobId;
  payload.additionalOffers = ['44444444-4444-4444-8444-444444444444'];
  const complete = [payload.locator.offerId, ...payload.additionalOffers].sort();
  const calls = [], replies = [];
  const endpoint = captureMigrationSourceEndpoint({ captureCurrent: () => ({ ownerId: 'owned-login', generation: 1,
    targetFingerprint: 'a'.repeat(64), principal: { kind: 'localOs' } }), broker: { closed: false,
    initializeResponse: { result: { capabilities: { experimental: { migrationSourceTransferPrivateCredentialsV1: true,
      migrationSourceTransferPrivateCredentialBundlesV1: mode !== 'old-target', migrationSourceTransferTargetRecoveryV1: true } } } },
    async sendMigrationSourceRequest(method, params) {
      const operation = method.slice('migration/sourceTransfer/internal/'.length);
      calls.push({ operation, params: structuredClone(params) });
      if (operation === 'peer/recover-target') return { result: { peerRef: 'owned-original-peer', targetAuthority: {
        instanceId: '55555555-5555-4555-8555-555555555555', accountId: 'b'.repeat(64) } } };
      assert.equal(operation, 'target/private/prepare');
      assert.deepEqual(params.additionalOffers, payload.additionalOffers);
      const result = { job: native.job, offerIds: complete };
      if (mode === 'missing-set') delete result.offerIds;
      if (mode === 'subset') result.offerIds = [payload.locator.offerId];
      if (mode === 'wrong-set') result.offerIds = [payload.locator.offerId, '66666666-6666-4666-8666-666666666666'].sort();
      if (mode === 'lost-reply') throw new Error('SYNTHETIC_PRIVATE_NATIVE_TEXT');
      return { result };
    } } });
  let released = 0;
  const lease = { endpoint, assertCurrent() {}, async release() { released++; } };
  const owner = { async existingLease(options) { assert.equal(options.purpose, 'target-recovery'); return lease; },
    open() { assert.fail('prepare must never open a new child'); } };
  const service = new MigrationSourceTransferService({ owner });
  const handler = createMigrationSourceOperationHttp({ service,
    requireSameOriginMutation: () => true, requestBody: async () => JSON.stringify(payload),
    jsonResponse: (_, status, body) => replies.push({ status, body }),
    resolveSelection: ({ selection }) => ({ target: { id: selection.targetId }, workspacePath: selection.workspacePath,
      captureCurrent: () => ({ ownerId: 'owned-login' }) }),
  });
  return { calls, replies, payload, complete, service, released: () => released,
    request: () => handler({ pathname: '/api/migration/source-transfer/private/prepare',
      request: { method: 'POST' }, response: {}, authSession: { owned: true } }) };
}
test('HTTP to route to service to private Bridge forwards the complete original bundle and its receipt', async () => {
  const f = fixture();
  try {
    assert.equal(await f.request(), true);
    assert.equal(f.replies.at(-1).status, 200);
    assert.deepEqual(f.replies.at(-1).body.offerIds, f.complete);
    assert.deepEqual(f.calls.map(call => call.operation), ['peer/recover-target', 'target/private/prepare']);
    assert.deepEqual(f.calls.at(-1).params.additionalOffers, f.payload.additionalOffers);
  } finally { await f.service.close(); }
  assert.equal(f.released(), 1);
});
test('HTTP bundle cannot silently downgrade or replay missing receipts and old targets receive no Native frame', async () => {
  for (const mode of ['old-target', 'missing-set', 'subset', 'wrong-set', 'lost-reply']) {
    const f = fixture(mode);
    try {
      await f.request();
      assert.equal(f.replies.at(-1).status, 409);
      assert.equal(f.replies.at(-1).body.error, mode === 'old-target' ? 'private_credentials_update_required'
        : mode === 'lost-reply' ? 'private_credentials_outcome_unknown' : 'private_credentials_invalid_response');
      assert.equal(f.calls.filter(call => call.operation === 'target/private/prepare').length, mode === 'old-target' ? 0 : 1);
      if (mode === 'old-target') assert.equal(f.calls.length, 0);
      assert.equal(JSON.stringify(f.replies).includes('SYNTHETIC_PRIVATE_NATIVE_TEXT'), false);
    } finally { await f.service.close(); }
  }
});
