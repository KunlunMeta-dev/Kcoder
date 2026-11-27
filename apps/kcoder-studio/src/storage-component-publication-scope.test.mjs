import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { activeComponentDirectoryScopes } from './storage-component-publication-scope.mjs';

function fixture(container = false) {
  const destination = resolve('scope-fixture/target/component'), source = resolve('scope-fixture/source');
  const intent = { version: container ? 2 : 1, operationId: 'scope-fixture', domain: 'native',
    sourceIdentity: 'unix:1:11', destination, operationDirectoryIdentity: 'unix:1:12',
    targetParentIdentity: 'unix:1:13', stagingName: container ? '' : '.kcoder-storage-scope-fixture-native',
    stagingIdentity: 'unix:1:14' };
  if (container) intent.container = { fences: [{ name: 'kcoder-storage.writers.lock', identity:
    JSON.stringify({ version: 1, kind: 'regularFile', native: { platform: 'linux', device: 1, inode: 15 } }) }] };
  return { disposition: 'active', phase: 'copying', plan: { version: 1, operationId: 'scope-fixture',
    target: { dataRoot: destination }, components: [{ domain: 'native', source, destination, sourceIdentity: 'unix:1:11' }],
    targetBindings: [{ path: destination, existingAncestor: container ? destination : resolve('scope-fixture/target'),
      ancestorIdentity: container ? intent.stagingIdentity : intent.targetParentIdentity }] },
  ownerReceipts: { 'publish-native': intent } };
}

test('v1 refusal scopes bind staging and final paths to the original native identity in every active phase', () => {
  const receipt = fixture(), intent = receipt.ownerReceipts['publish-native'];
  const before = structuredClone(receipt);
  const stage = join(resolve('scope-fixture/target'), intent.stagingName);
  for (const phase of ['planned', 'stopping', 'stopped', 'copying', 'verifying', 'prepared', 'committed']) {
    const active = { ...receipt, phase };
    assert.deepEqual(activeComponentDirectoryScopes(active), new Map([
      [intent.destination, intent.stagingIdentity], [stage, intent.stagingIdentity],
    ]));
  }
  assert.deepEqual(receipt, before);
});

test('an existing container is a refusal scope before confirmation and after a copy checkpoint', () => {
  const receipt = fixture(true), intent = receipt.ownerReceipts['publish-native'];
  const expected = new Map([[intent.destination, intent.stagingIdentity]]);
  assert.deepEqual(activeComponentDirectoryScopes(receipt), expected);
  intent.container.publishedCopy = { version: 2, scope: { operationId: intent.operationId, domain: intent.domain,
    operationDirectoryIdentity: intent.operationDirectoryIdentity, sourceRootIdentity: intent.sourceIdentity,
    stagingRootIdentity: intent.stagingIdentity, inventorySha256: 'a'.repeat(64) },
  authorizedVersions: [{ identity: 'original-manifest-file-id', sha256: 'b'.repeat(64), sizeBytes: 1000 }] };
  assert.deepEqual(activeComponentDirectoryScopes(receipt), expected);
  intent.container.publishedCopy.scope.sourceRootIdentity = 'unix:1:99';
  assert.throws(() => activeComponentDirectoryScopes(receipt), { code: 'STORAGE_COMPONENT_RECEIPT_CONFLICT' });
});

test('temporary-name collision checks use only ASCII case equivalence like the native publisher', () => {
  for (const [name, suffix] of [['.KCODER-STORAGE-SCOPE-FIXTURE-NATIVE', '.staging'],
    ['.\u212aCODER-STORAGE-SCOPE-FIXTURE-NATIVE', '']]) {
    const receipt = fixture(), intent = receipt.ownerReceipts['publish-native'];
    const destination = resolve('scope-fixture/target', name);
    intent.destination = destination;
    intent.stagingName = `.kcoder-storage-scope-fixture-native${suffix}`;
    receipt.plan.components[0].destination = destination;
    receipt.plan.target.dataRoot = destination;
    receipt.plan.targetBindings[0].path = destination;
    assert.equal(activeComponentDirectoryScopes(receipt).get(destination), intent.stagingIdentity);
  }
});

test('future, unknown, corrupt and conflicting publication records fail closed', () => {
  const receipt = fixture();
  for (const [field, value] of [['version', 3], ['operationId', 'other-operation'], ['domain', 'unknown'],
    ['sourceIdentity', 'unix:1:99'], ['destination', resolve('scope-fixture/other')], ['stagingName', '../other'],
    ['stagingIdentity', 'invented-directory-id'], ['unexpected', true]]) {
    const damaged = structuredClone(receipt);
    damaged.ownerReceipts['publish-native'][field] = value;
    assert.throws(() => activeComponentDirectoryScopes(damaged), error => error.code?.startsWith('STORAGE_COMPONENT_'), field);
  }
  const unknown = structuredClone(receipt);
  unknown.ownerReceipts['publish-unknown'] = unknown.ownerReceipts['publish-native'];
  assert.throws(() => activeComponentDirectoryScopes(unknown), { code: 'STORAGE_COMPONENT_RECEIPT_CONFLICT' });
  const duplicate = structuredClone(receipt);
  duplicate.plan.components.push(duplicate.plan.components[0]);
  assert.throws(() => activeComponentDirectoryScopes(duplicate), { code: 'STORAGE_COMPONENT_RECEIPT_CONFLICT' });
  const container = fixture(true);
  container.plan.targetBindings[0].ancestorIdentity = 'unix:1:99';
  assert.throws(() => activeComponentDirectoryScopes(container), { code: 'STORAGE_COMPONENT_RECEIPT_CONFLICT' });
});

test('unpublished components have no inferred scope and oversized owner metadata has an explicit error', () => {
  const receipt = fixture();
  delete receipt.ownerReceipts['publish-native'];
  assert.deepEqual(activeComponentDirectoryScopes(receipt), new Map());
  receipt.ownerReceipts = fixture().ownerReceipts;
  receipt.ownerReceipts['publish-native'].sourceIdentity = 'a'.repeat(256 * 1024);
  assert.throws(() => activeComponentDirectoryScopes(receipt), { code: 'STORAGE_COMPONENT_RECEIPT_BUDGET_EXCEEDED' });
});
