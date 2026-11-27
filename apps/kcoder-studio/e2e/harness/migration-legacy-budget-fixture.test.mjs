import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyBudgetDocuments } from './migration-legacy-budget-fixture.mjs';
const id = '11111111-1111-4111-8111-111111111111', parent = 'mig-' + 'a'.repeat(32);
function fixture() {
  const reference = { group: 'owned', owner: parent, scope: 's', binding: 'b' };
  return { parent: { jobId: parent, status: 'completed', batch: { planId: 'original', resourceLimits: {}, actions: [{ status: 'committed', action: { kind: 'history', plan: { historyJobId: id } } }] } },
    children: [{ version: 4, view: { jobId: id, stage: 'normalized', cancelRequested: false }, resourceBudget: { reference, owner: parent, member: id, members: [id] } }],
    ledger: { resource_groups: { owned: { reference, members: [id] }, peer: { unchanged: true } }, archives: { owned: { resource_budget: reference, body: 'original' }, peer: { resource_budget: { group: 'peer' } } } } };
}
test('only converts the exact stopped parent and complete child set, keeping every peer byte fact', () => {
  const input = fixture(), result = legacyBudgetDocuments(input);
  assert.equal(result.children[0].version, 3); assert.equal(result.children[0].resourceBudget, undefined); assert.equal(result.parent.batch.resourceLimits, undefined);
  assert.equal(result.ledger.archives.owned.body, 'original'); assert.deepEqual(result.ledger.archives.peer, input.ledger.archives.peer); assert.deepEqual(result.ledger.resource_groups.peer, input.ledger.resource_groups.peer);
  assert.equal(input.children[0].version, 4);
});
test('unknown execution, partial membership, peer group and duplicate child fail before a fixture mutation', () => {
  const variants = [value => value.parent.status = 'running', value => value.children[0].view.stage = 'capturing', value => value.children[0].resourceBudget.owner = 'peer', value => value.ledger.resource_groups.owned.members = [id, 'peer'], value => value.children.push(value.children[0])];
  for (const mutate of variants) { const input = fixture(); mutate(input); assert.throws(() => legacyBudgetDocuments(input)); }
});
