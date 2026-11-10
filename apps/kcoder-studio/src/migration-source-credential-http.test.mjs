import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMigrationSourceOperationHttp } from './migration-source-operation-http.js';
import { MigrationSourceBridgeError } from './migration-source-private.js';

const examples = JSON.parse(readFileSync(new URL('../shared/generated/examples.migration-source-credentials.json', import.meta.url)));
const sample = name => structuredClone(examples[name][0].value);
function fixture(operation = 'read') {
  const calls = [], payload = sample(operation === 'candidates' ? 'MigrationSourceCredentialCandidatesParams' : 'MigrationSourceCredentialLocator');
  const result = sample(operation === 'candidates' ? 'MigrationSourceCredentialCandidatesResult' : 'MigrationSourceCredentialResult');
  return { calls, payload, result,
    request: { pathname: '/api/migration/source-transfer/private/' + operation, request: { method: 'POST' }, response: {}, authSession: {} },
    options: { service: { privateRead: async () => { calls.push('read'); return result; }, privateCandidates: async () => { calls.push('candidates'); return result; } },
      requestBody: async (_request, limit) => { assert.equal(limit, 256 * 1024); calls.push('body'); return JSON.stringify(payload); },
      requireSameOriginMutation: () => true, jsonResponse: (_response, status, body) => calls.push({ status, body }),
      resolveSelection: ({ selection }) => ({ target: { id: selection.targetId }, workspacePath: selection.workspacePath, captureCurrent: () => ({}) }) } };
}

test('all private HTTP endpoints retain authentication, same-origin and POST checks before reading the body', async () => {
  for (const operation of ['candidates', 'run', 'read', 'source-read', 'cancel', 'resume', 'prepare', 'release']) {
    for (const gate of ['auth', 'method', 'origin']) {
      const f = fixture(operation);
      if (gate === 'auth') f.request.authSession = null;
      if (gate === 'method') f.request.request.method = 'GET';
      if (gate === 'origin') f.options.requireSameOriginMutation = () => false;
      assert.equal(await createMigrationSourceOperationHttp(f.options)(f.request), true);
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0].status, { auth: 401, method: 405, origin: 403 }[gate]);
    }
  }
});

test('private HTTP publishes only a validated original metadata observation', async () => {
  for (const operation of ['read', 'candidates']) {
    const f = fixture(operation); await createMigrationSourceOperationHttp(f.options)(f.request);
    assert.deepEqual(f.calls, ['body', operation, { status: 200, body: f.result }]);
  }
  const f = fixture(); f.result.targetWorkerRunning = true;
  await createMigrationSourceOperationHttp(f.options)(f.request);
  assert.deepEqual(f.calls.at(-1), { status: 409, body: { error: 'private_credentials_invalid_response' } });
});

test('private errors use a closed diagnostic set and never echo backend text or retry', async () => {
  for (const reason of ['private_credentials_keyring_unavailable', 'private_credentials_SYNTHETIC_SECRET', 'SYNTHETIC_PRIVATE_VALUE']) {
    const f = fixture(); f.options.service.privateRead = async () => { f.calls.push('read'); throw new MigrationSourceBridgeError(reason); };
    await createMigrationSourceOperationHttp(f.options)(f.request);
    assert.equal(f.calls.filter(call => call === 'read').length, 1);
    assert.deepEqual(f.calls.at(-1), { status: 409, body: { error: reason === 'private_credentials_keyring_unavailable' ? reason : 'private_credentials_outcome_unknown' } });
  }
});

test('private ciphertext, plaintext and authorities never become public request fields', async () => {
  for (const key of ['ciphertext', 'publicKey', 'authority', 'value']) {
    const f = fixture(); f.payload[key] = 'SYNTHETIC_PRIVATE_VALUE';
    await createMigrationSourceOperationHttp(f.options)(f.request);
    assert.deepEqual(f.calls.at(-1), { status: 400, body: { error: 'private_credentials_invalid_request' } });
    assert.equal(f.calls.includes('read'), false);
  }
});
