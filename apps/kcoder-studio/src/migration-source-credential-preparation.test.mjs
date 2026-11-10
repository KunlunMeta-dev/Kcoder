import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMigrationSourceOperationHttp } from './migration-source-operation-http.js';
import { MigrationSourceTransferService } from './migration-source-transfer-service.js';
import { captureMigrationSourceEndpoint } from './migration-source-bridge.js';
import { validPrivatePreparationResult } from './migration-source-credential-preparation.js';

const fixtures = JSON.parse(readFileSync(new URL('../../../scripts/contracts/fixtures.migration-source-credentials.json', import.meta.url)));
const params = () => structuredClone(fixtures.MigrationSourceCredentialPreparationReadParams.valid[0].value);
const proof = () => structuredClone(fixtures.MigrationSourceCredentialPreparationResult.valid.find(row => row.value.phase === 'prepared').value);

function fixture(mode = 'normal') {
  const payload = params(), calls = [], replies = [], native = proof();
  const endpoint = captureMigrationSourceEndpoint({ captureCurrent: () => ({ ownerId: 'owned-login', generation: 1,
    targetFingerprint: 'a'.repeat(64), principal: { kind: 'localOs' } }), broker: { closed: false,
    initializeResponse: { result: { capabilities: { experimental: { migrationSourceTransferPrivateCredentialsV1: true,
      migrationSourceTransferPrivateCredentialPreparationsV1: mode !== 'old-target', migrationSourceTransferTargetRecoveryV1: true } } } },
    async sendMigrationSourceRequest(method, value) {
      const operation = method.slice('migration/sourceTransfer/internal/'.length);
      calls.push({ operation, value: structuredClone(value) });
      if (operation === 'peer/recover-target') return { result: { peerRef: 'original-grant-peer', targetAuthority: {
        instanceId: '55555555-5555-4555-8555-555555555555', accountId: 'b'.repeat(64) } } };
      assert.equal(operation, 'target/private/prepare-status');
      assert.equal(value.jobId, payload.jobId);
      if (mode === 'lost-reply') throw new Error('SYNTHETIC_NEVER_PUBLIC_BACKEND');
      if (mode === 'partial-proof') native.consent = null;
      if (mode === 'wrong-job') native.jobId = 'mig-' + 'f'.repeat(32);
      return { result: native };
    } } });
  const owner = { async existingLease(options) {
    assert.equal(options.purpose, 'target-recovery');
    return { endpoint, assertCurrent() {}, async release() {} };
  }, open() { assert.fail('a read cannot create any child'); } };
  const service = new MigrationSourceTransferService({ owner });
  const handler = createMigrationSourceOperationHttp({ service, requireSameOriginMutation: () => true,
    requestBody: async () => JSON.stringify(payload), jsonResponse: (_, status, body) => replies.push({ status, body }),
    resolveSelection: ({ selection }) => ({ target: { id: selection.targetId }, captureCurrent: () => ({ ownerId: 'owned-login' }) }),
  });
  return { payload, calls, replies, service,
    request: () => handler({ pathname: '/api/migration/source-transfer/private/prepare-status',
      request: { method: 'POST' }, response: {}, authSession: { owned: true } }) };
}

test('HTTP prepare-status recovers the complete original intent using only the existing target lease', async () => {
  const f = fixture();
  try {
    assert.equal(await f.request(), true);
    assert.equal(f.replies.at(-1).status, 200);
    assert.deepEqual(f.replies.at(-1).body, proof());
    assert.deepEqual(f.calls.map(row => row.operation), ['peer/recover-target', 'target/private/prepare-status']);
    await f.request();
    assert.equal(f.calls.filter(row => row.operation === 'target/private/prepare-status').length, 2);
    assert.ok(f.calls.every(row => !['identity', 'peer/accept', 'target/private/offer', 'target/private/prepare'].includes(row.operation)));
  } finally { await f.service.close(); }
});

test('prepare-status rejects partial proofs, wrong jobs and old capabilities without replaying preparation', async () => {
  for (const mode of ['old-target', 'partial-proof', 'wrong-job', 'lost-reply']) {
    const f = fixture(mode);
    try {
      await f.request();
      assert.equal(f.replies.at(-1).status, 409);
      assert.equal(f.replies.at(-1).body.error, mode === 'old-target' ? 'private_credentials_update_required'
        : mode === 'lost-reply' ? 'private_credentials_outcome_unknown' : 'private_credentials_invalid_response');
      if (mode === 'old-target') assert.equal(f.calls.length, 0);
      assert.equal(JSON.stringify(f.replies).includes('SYNTHETIC_NEVER_PUBLIC_BACKEND'), false);
    } finally { await f.service.close(); }
  }
});

test('status phases preserve absence, incomplete proof and the original sequence instead of rebasing', () => {
  for (const row of fixtures.MigrationSourceCredentialPreparationResult.valid) {
    assert.equal(validPrivatePreparationResult(params(), row.value), true, row.name);
  }
  for (const change of [value => { value.offerIds.reverse(); }, value => { value.offerIds[1] = value.offerIds[0]; },
    value => { value.expectedSequence = value.sequence; }, value => { value.originalPlanId = value.planId; },
    value => { value.consent = null; }]) {
    const value = proof(); change(value);
    assert.equal(validPrivatePreparationResult(params(), value), false);
  }
});
