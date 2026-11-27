import { openWorkflowTaskCreator, openScheduledTaskRecords } from '../../harness/automation-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openPageGatewayRpc, closeRpcAndWait } from '../../harness/rpc.mjs';

// Actual native UI/consent/persistence only. Its future schedule must never execute.
export async function exerciseNativeTaskModelSelection({ context, page, gateway, model }) {
  const rpc = await openPageGatewayRpc(context, page, gateway, 'close native task-model metadata RPC');
  let original;
  try {
    const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-task-model-ui', version: '1' },
      capabilities: { experimental: { integrationScopeV1: true, automationTemplatesV1: true, automationTaskModelsV1: true, modelPoliciesV1: true } } });
    assert.equal(initialized.capabilities.experimental.automationTaskModelsV1, true);
    const scope = await rpc.request('integrations/scope/read');
    const call = async (method, payload = {}, mutation = false, revision) => {
      const reply = await rpc.request(method, { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 10_000,
        payload, ...(mutation ? { operationId: randomUUID() } : {}), ...(revision === undefined ? {} : { expectedRevision: String(revision) }) });
      assert.equal(reply.status, 'completed', `${method}: ${reply.error?.code}`); return reply.result;
    };
    const policies = (await call('integrations/models/readPolicies')).policies;
    assert.equal(policies.length, 1);
    const expected = { kind: 'auto_policy', ...policies[0].reference };
    let draft = await rpc.request('workflow/create', { title: 'Native future task-model workflow', description: 'Owned UI-only future subscription; no model or execution.' });
    draft = await rpc.request('workflow/upsertNode', { id: draft.id, expectedRevision: draft.revision,
      node: { id: 'report', title: 'No model needed', kind: 'code', config: { code: { source: 'return {futureOnly:true};', timeoutMs: 100 } } } });
    const saved = await rpc.request('workflow/save', { id: draft.id, expectedRevision: draft.revision });
    await openWorkflowTaskCreator(page);
    const choice = page.getByTestId('subscription-workflow').locator(`option[value="${saved.id}@1"]`);
    await choice.waitFor({ state: 'attached', timeout: 15_000 });
    await page.getByTestId('subscription-title').fill('Native fixed Auto subscription');
    await page.getByTestId('subscription-workflow').selectOption(`${saved.id}@1`);
    await page.getByTestId('subscription-schedule-mode').selectOption('once');
    await page.locator('input[type="datetime-local"]').fill('2099-01-01T09:00');
    await page.getByTestId('subscription-preview').click();
    await page.getByTestId('subscription-consent').check();
    await page.getByTestId('subscription-model-policy-toggle').click();
    const policy = page.getByTestId('native-model-policies');
    await policy.getByRole('combobox').selectOption(JSON.stringify([expected.id, expected.version]));
    await policy.getByRole('button', { name: /Preview candidate|预检候选模型/ }).click();
    await policy.getByRole('button', { name: /Use this policy|使用此策略/ }).click();
    assert.equal(await page.getByTestId('subscription-consent').isChecked(), false);
    assert.equal(await page.getByTestId('subscription-save').isDisabled(), true);
    assert.equal(model.requests.length, 0);
    await page.getByTestId('subscription-preview').click();
    await page.getByTestId('subscription-consent').check();
    await page.getByTestId('subscription-save').click();
    await page.getByTestId('subscription-row').filter({ hasText: 'Native fixed Auto subscription' }).waitFor({ timeout: 15_000 });
    const rows = (await call('integrations/automation/listSubscriptions')).page.items;
    assert.equal(rows.length, 1); original = rows[0];
    assert.deepEqual(original.draft.modelSelection, expected);
    assert.equal(original.draft.workflowId, saved.id);
    assert.equal(original.revision, 1);
    assert.equal((await call('integrations/automation/listAutomationRuns')).page.items.length, 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openScheduledTaskRecords(page);
    await page.getByTestId('subscription-row').filter({ hasText: 'Native fixed Auto subscription' }).waitFor({ timeout: 30_000 });
    const reopened = (await call('integrations/automation/listSubscriptions')).page.items[0];
    assert.equal(reopened.draft.id, original.draft.id); assert.equal(reopened.revision, original.revision);
    assert.deepEqual(reopened.draft.modelSelection, expected);
    assert.equal(model.requests.length, 0, 'catalog, preview, save and cold reopen cannot call a Provider');
    await context.writeArtifactJson('native-task-model-selection.json', { subscriptionId: original.draft.id, revision: original.revision,
      workflowId: saved.id, modelSelection: expected, coldReopenMatched: true, previousConsentInvalidated: true,
      providerRequests: 0, runs: 0, boundary: 'Native UI/explicit consent/persistence only; future schedule not executed.' });
    await call('integrations/automation/setSubscriptionEnabled', { subscriptionId: original.draft.id, enabled: false }, true, original.revision);
    original = undefined;
    return { actualNativeTaskModelUi: true, futureOnly: true, providerRequests: 0, runs: 0 };
  } finally {
    if (original) {
      const scope = await rpc.request('integrations/scope/read');
      await rpc.request('integrations/automation/setSubscriptionEnabled', { contractVersion: 'parallel-v1', requestId: randomUUID(), scope,
        timeoutMs: 10_000, operationId: randomUUID(), expectedRevision: String(original.revision),
        payload: { subscriptionId: original.draft.id, enabled: false } });
    }
    await closeRpcAndWait(rpc);
  }
}
