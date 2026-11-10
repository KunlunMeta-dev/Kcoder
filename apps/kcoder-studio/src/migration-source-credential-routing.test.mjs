import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeMigrationSourceCredential, validMigrationSourceCredentialResult } from './migration-source-credential-routing.js';

const examples = JSON.parse(readFileSync(new URL('../shared/generated/examples.migration-source-credentials.json', import.meta.url)));
const sample = name => structuredClone(examples[name][0].value);
const routes = [
  ['candidates', 'privateCandidates', 'MigrationSourceCredentialCandidatesParams', 'MigrationSourceCredentialCandidatesResult'],
  ['run', 'privateRun', 'MigrationSourceCredentialRunParams', 'MigrationSourceCredentialResult'],
  ['read', 'privateRead', 'MigrationSourceCredentialLocator', 'MigrationSourceCredentialResult'],
  ['cancel', 'privateCancel', 'MigrationSourceCredentialCancelParams', 'MigrationSourceCredentialControlResult'],
  ['resume', 'privateResume', 'MigrationSourceCredentialResumeParams', 'MigrationSourceCredentialControlResult'],
  ['prepare', 'privatePrepare', 'MigrationSourceCredentialPrepareParams', 'MigrationSourceCredentialPrepareResult'],
  ['release', 'privateRelease', 'MigrationSourceCredentialReleaseParams', 'MigrationSourceCredentialResult'],
];
function fixture(method, result) {
  const calls = [], resolved = [];
  return { calls, resolved, service: { [method]: async args => { calls.push(args); return result; } },
    resolveSelection: async selector => { resolved.push(selector); return { target: { id: selector.targetId },
      workspacePath: selector.workspacePath, captureCurrent: () => ({ ownerId: 'current-authenticated-owner' }) }; } };
}

test('private public routes resolve existing selectors and expose metadata only', async () => {
  for (const [operation, method, paramsName, resultName] of routes) {
    const payload = sample(paramsName), result = sample(resultName);
    const locator = ['read', 'candidates'].includes(operation) ? payload : payload.locator;
    result.requestId = locator.requestId;
    if (operation !== 'candidates') result.offerId = locator.offerId;
    if (operation === 'prepare') payload.jobId = result.job.job.jobId;
    if (['cancel', 'resume'].includes(operation)) result.side = payload.side;
    const f = fixture(method, result);
    assert.deepEqual(await routeMigrationSourceCredential(operation, payload, f), result);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].requestId, locator.requestId);
    assert.equal(typeof f.calls[0].target.captureCurrent, 'function');
    assert.equal(f.calls[0].target.target.id, locator.target.targetId);
    assert.equal(f.calls[0].target.purpose, locator.target.purpose.replace('_', '-'));
    assert.equal(f.resolved.length, operation === 'run' || payload.side === 'source' ? 2 : 1);
    for (const key of ['authority', 'peerRef', 'publicKey', 'offer', 'envelope', 'ciphertext']) assert.equal(Object.hasOwn(f.calls[0], key), false);
  }
});

test('private requests reject injected material and role changes before resolving any endpoint', async () => {
  for (const [operation, , paramsName] of routes) {
    for (const key of ['publicKey', 'envelope', 'authority', 'peerRef', 'value']) {
      const payload = sample(paramsName); payload[key] = 'SYNTHETIC_PRIVATE_VALUE';
      await assert.rejects(routeMigrationSourceCredential(operation, payload, { resolveSelection() { assert.fail('must not resolve'); } }),
        { reason: 'private_credentials_invalid_request' });
    }
  }
  for (const change of [payload => { payload.source.purpose = 'target'; }, payload => { payload.locator.target.purpose = 'target_recovery'; }]) {
    const payload = sample('MigrationSourceCredentialRunParams'); change(payload);
    await assert.rejects(routeMigrationSourceCredential('run', payload, { resolveSelection() { assert.fail('must not resolve'); } }),
      { reason: 'source_transfer_role_mismatch' });
  }
});

test('private reads cannot publish another receipt or claim stopped while an observed writer still runs', () => {
  const payload = sample('MigrationSourceCredentialLocator'), result = sample('MigrationSourceCredentialResult');
  assert.equal(validMigrationSourceCredentialResult('read', payload, result), true);
  assert.equal(validMigrationSourceCredentialResult('read', payload, { ...result, offerId: '00000000-0000-4000-8000-000000000000' }), false);
  assert.equal(validMigrationSourceCredentialResult('read', payload, { ...result, targetWorkerRunning: true }), false);
  assert.equal(validMigrationSourceCredentialResult('read', payload, { ...result, received: !result.received }), false);
  const candidates = sample('MigrationSourceCredentialCandidatesResult');
  const request = sample('MigrationSourceCredentialCandidatesParams');
  assert.equal(validMigrationSourceCredentialResult('candidates', request, candidates), true);
  candidates.items[0].sourceVerificationRequired = false;
  assert.equal(validMigrationSourceCredentialResult('candidates', request, candidates), false);
});

test('unknown private mutation results do not replay a write or synthesize an acknowledgement', async () => {
  const payload = sample('MigrationSourceCredentialRunParams'); let calls = 0;
  const f = fixture('privateRun', null); f.service.privateRun = async () => { calls++; throw new Error('lost private acknowledgement'); };
  await assert.rejects(routeMigrationSourceCredential('run', payload, f), /lost private acknowledgement/);
  assert.equal(calls, 1);
});

test('public bundle prepare forwards every explicit member and rejects a missing or partial receipt', async () => {
  const payload = sample('MigrationSourceCredentialPrepareParams'), result = sample('MigrationSourceCredentialPrepareResult');
  payload.jobId = result.job.job.jobId;
  payload.additionalOffers = ['44444444-4444-4444-8444-444444444444'];
  result.offerIds = [payload.locator.offerId, ...payload.additionalOffers].sort();
  const f = fixture('privatePrepare', result);
  await routeMigrationSourceCredential('prepare', payload, f);
  assert.deepEqual(f.calls[0].additionalOffers, payload.additionalOffers);
  for (const wrong of [undefined, [payload.locator.offerId], [payload.additionalOffers[0], '55555555-5555-4555-8555-555555555555']]) {
    const changed = { ...result, offerIds: wrong };
    if (wrong === undefined) delete changed.offerIds;
    assert.equal(validMigrationSourceCredentialResult('prepare', payload, changed), false);
  }
  payload.additionalOffers = [payload.locator.offerId];
  await assert.rejects(routeMigrationSourceCredential('prepare', payload, { resolveSelection() { assert.fail('must not resolve repeated primary'); } }),
    { reason: 'private_credentials_invalid_request' });
});

test('source-read requires an explicit source and accepts only a source-only redacted observation', async () => {
  const payload = sample('MigrationSourceCredentialSourceReadParams');
  const result = { requestId: payload.locator.requestId, offerId: payload.locator.offerId, phase: 'sealed',
    sourceControl: { sequence: 2, cancelWatermark: 0, cancelled: false, ready: true }, targetControl: null,
    sourceObserved: true, targetObserved: false, sourceWorkerRunning: false, targetWorkerRunning: null,
    received: false, keyReleased: false };
  const f = fixture('privateSourceRead', result);
  assert.deepEqual(await routeMigrationSourceCredential('source-read', payload, f), result);
  assert.equal(f.calls[0].source.purpose, 'source');
  for (const bad of [{ ...result, received: true }, { ...result, targetObserved: true }, { ...result, sourceWorkerRunning: true }]) {
    assert.equal(validMigrationSourceCredentialResult('source-read', payload, bad), false);
  }
});
