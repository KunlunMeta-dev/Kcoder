import { openWorkflowTaskCreator, openWikiMemory } from '../../harness/automation-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { openPageGatewayRpc, closeRpcAndWait } from '../../harness/rpc.mjs';

// Fixture contents and a real public saved Code graph; no model supplies output.
export async function prepareNativeFileEventFiles(workspace) {
  const folder = join(workspace, 'automation-selected');
  await mkdir(folder);
  for (let index = 1; index <= 11; index += 1)
    await writeFile(join(folder, `event-${String(index).padStart(2, '0')}.txt`), `Owned untrusted source revision ${index}.`);
}

export async function exerciseNativeFileEventSubscription({ context, page, gateway, workspace }) {
  const taskStateProof = process.env.KCODER_E2E_NATIVE_TASK_STATE_ONLY === '1';
  const rpc = await openPageGatewayRpc(context, page, gateway, 'close native file-event metadata RPC');
  try {
    const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-file-event-browser', version: '1' },
      capabilities: { experimental: { integrationScopeV1: true, automationTemplatesV1: true, integrationOperationReceiptsV1: true,
        ...(taskStateProof ? { integrationTaskStateV1: true } : {}) } } });
    if (taskStateProof) assert.equal(initialized.capabilities?.experimental?.integrationTaskStateV1, true);
    let definition = await rpc.request('workflow/create', { title: 'Actual selected-file Code', description: 'Owned model-independent native workflow acceptance.' });
    definition = await rpc.request('workflow/upsertNode', { id: definition.id, expectedRevision: definition.revision,
      node: { id: 'verify', title: 'Verify original file-event input', kind: 'code', config: { code: {
        source: "if(input.value !== 7) throw new Error('original input changed'); return {marker:'ACTUAL_FILE_EVENT_CODE',verified:input.value*2};", timeoutMs: 1000 } } } });
    const saved = await rpc.request('workflow/save', { id: definition.id, expectedRevision: definition.revision });
    assert.equal(saved.savedVersion, 1);
    const scope = await rpc.request('integrations/scope/read');
    const nativeRead = async method => {
      const reply = await rpc.request(`integrations/automation/${method}`, { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 10_000, payload: {} });
      assert.equal(reply.status, 'completed', `${method}: ${reply.error?.code}`);
      return reply.result.page.items;
    };
    // Reopening the tab re-reads actual saved versions through the production adapter.
    await openWikiMemory(page);
    await openWorkflowTaskCreator(page);
    const formToggle = page.getByTestId('subscription-form-toggle');
    assert.equal(await formToggle.evaluate(element => element.parentElement.open), true);
    await page.getByTestId('subscription-workflow').locator(`option[value="${saved.id}@1"]`).waitFor({ state: 'attached', timeout: 15_000 });
    await page.getByTestId('subscription-title').fill('Actual file-event subscription');
    await page.getByTestId('subscription-workflow').selectOption(`${saved.id}@1`);
    await page.getByTestId('subscription-schedule-mode').selectOption('files');
    const picker = page.getByTestId('automation-file-picker');
    await picker.getByTestId('automation-file-directory').filter({ hasText: 'automation-selected' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="automation-file-row"]').length === 10);
    await assert.rejects(access(join(workspace, 'automation-selected', '.kcoder')), { code: 'ENOENT' });
    await picker.getByRole('checkbox', { name: 'event-01.txt', exact: true }).check();
    await picker.getByTestId('knowledge-page-next').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="automation-file-row"]').length === 1);
    // Only one file is selected: the second page proves navigation preserves it,
    // without asking the original scheduler to create two different event runs.
    await picker.getByTestId('automation-file-confirm').click();
    await picker.getByTestId('automation-file-ready').waitFor({ timeout: 15_000 });
    assert.equal((await nativeRead('listAutomationRuns')).length, 0, 'selection alone must not create a run');
    await page.getByTestId('subscription-inputs-toggle').click();
    await page.getByTestId('subscription-inputs').fill('{"value":7}');
    await page.getByTestId('subscription-preview').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="subscription-consent"]')?.disabled === false);
    assert.equal((await nativeRead('listAutomationRuns')).length, 0, 'preview must not execute a workflow');
    await page.getByTestId('subscription-consent').check();
    await page.screenshot({ path: context.pathInArtifacts('native-file-event-confirmation.png'), fullPage: true });
    await writeFile(join(workspace, 'automation-selected', 'event-01.txt'), 'Fresh owned revision before explicit subscription save.');
    await page.getByTestId('subscription-save').click();
    const subscription = page.getByTestId('subscription-row').filter({ hasText: 'Actual file-event subscription' });
    await subscription.waitFor({ timeout: 15_000 });
    const deadline = Date.now() + 25_000;
    let actual;
    while (Date.now() < deadline) {
      const runs = await nativeRead('listAutomationRuns');
      assert.ok(runs.length <= 1, 'original cursor must not duplicate a selected revision');
      if (runs.length) {
        assert.ok(!['failed', 'cancelled'].includes(runs[0].status), `actual Code outcome: ${runs[0].status}`);
        if (runs[0].status === 'completed') { actual = runs[0]; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(actual, 'actual native selected-file workflow must complete');
    assert.ok(actual.nativeThreadId && actual.nativeOperationId);
    assert.equal(actual.nativeTurnId ?? null, null);
    assert.match(actual.output, /ACTUAL_FILE_EVENT_CODE/);
    assert.match(actual.output, /14/);
    if (taskStateProof) {
      const messages = rpc.messages().filter(message => message.method === 'integrations/runtime/taskStateChanged'
        && message.params?.operationId === actual.nativeOperationId).map(message => message.params);
      assert.ok(messages.length > 0, 'The real Native Code task must publish versioned state over its actual Gateway');
      const terminal = messages.findLast(message => message.state === 'completed');
      assert.ok(terminal, 'An actual terminal observation must be published before retiring its owner');
      let previous = 0;
      for (const value of messages) {
        assert.deepEqual(value.scope, scope);
        assert.equal(value.entityId, actual.nativeOperationId);
        assert.equal(value.sequence, value.revision);
        assert.ok(value.revision > previous && value.observedAtMs > 0);
        assert.equal(value.reference.threadId, actual.nativeThreadId);
        assert.equal(value.snapshot, false);
        assert.equal(Object.hasOwn(value, 'output'), false);
        previous = value.revision;
      }
      const snapshot = await rpc.request('integrations/runtime/readTaskState', { requestId: randomUUID(), scope,
        reference: terminal.reference });
      assert.equal(snapshot.snapshot, true);
      assert.equal(snapshot.state, 'completed');
      assert.equal(snapshot.operationId, terminal.operationId);
      assert.ok(snapshot.revision >= terminal.revision);
      await context.writeArtifactJson('native-task-state-version-proof.json', { operationId: actual.nativeOperationId,
        actualCodeOutputVerified: true, live: messages, snapshot, modelRequests: 0,
        newAdmissionForRead: false, privateBodyInEvent: false });
    }
    const subscriptions = await nativeRead('listSubscriptions');
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].draft.schedule, null);
    assert.ok(subscriptions[0].draft.eventSource);
    await page.getByTestId('business-subscriptions').getByTestId('knowledge-refresh').last().click();
    const row = page.getByTestId('automation-run');
    await row.waitFor({ timeout: 15_000 });
    await row.locator('summary').click();
    await row.getByText(/ACTUAL_FILE_EVENT_CODE/).waitFor();
    await page.screenshot({ path: context.pathInArtifacts('native-file-event-completed.png'), fullPage: true });
    await subscription.getByTestId('subscription-toggle').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="subscription-row"] [data-testid="subscription-toggle"]')?.textContent?.match(/启用|Enable/), { timeout: 10_000 }).catch(async error => {
      await context.writeArtifactJson('file-event-disable-observation.json', {
        subscriptions: await nativeRead('listSubscriptions'),
        toggleText: await subscription.getByTestId('subscription-toggle').textContent(),
        errors: await page.getByTestId('knowledge-operation-error').allTextContents(),
      });
      throw error;
    });
    await writeFile(join(workspace, 'automation-selected', 'event-01.txt'), 'Changed after the original subscription was explicitly disabled.');
    for (let poll = 0; poll < 5; poll += 1) {
      const runs = await nativeRead('listAutomationRuns');
      assert.equal(runs.length, 1); assert.equal(runs[0].id, actual.id);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const oldEventTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(workspace, 'automation-selected', 'event-01.txt'), oldEventTime, oldEventTime);
    const originalTimestamp = Number((await stat(join(workspace, 'automation-selected', 'event-01.txt'), { bigint: true })).mtimeNs / 1_000_000n);
    await subscription.getByTestId('subscription-toggle').click();
    let quarantined;
    const quarantineDeadline = Date.now() + 10_000;
    while (Date.now() < quarantineDeadline) {
      const facts = await nativeRead('listQuarantinedEvents');
      if (facts.length) { quarantined = facts[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(quarantined, 'the original native file tick must retain an actual stale event');
    assert.equal(quarantined.reasonCode, 'AUTOMATION_EVENT_STALE_QUARANTINED');
    assert.equal(quarantined.occurredAtMs, originalTimestamp);
    await page.getByTestId('automation-quarantine-toggle').click();
    const isolated = page.getByTestId('automation-quarantined-event');
    await isolated.waitFor();
    await isolated.getByText(/事件过旧|too old/).waitFor();
    const unchanged = await nativeRead('listAutomationRuns');
    assert.equal(unchanged.length, 1); assert.equal(unchanged[0].id, actual.id);
    await page.screenshot({ path: context.pathInArtifacts('native-file-event-quarantined.png'), fullPage: true });
    await subscription.getByTestId('subscription-toggle').click();
    await context.writeArtifactJson('native-file-event-results.json', { sourceRef: subscriptions[0].draft.eventSource,
      workflowId: saved.id, workflowVersion: 1, runId: actual.id, operationId: actual.nativeOperationId,
      nativeThreadId: actual.nativeThreadId, nativeTurnId: actual.nativeTurnId ?? null,
      status: actual.status, disabledAfterCompletion: true, unchangedRunAfterDisabledFileChange: true });
    return { actualSelectedFilePaging: [10, 1], actualFileCodeCompleted: true, selectionAndPreviewCreateNoRun: true, disabledFileChangeCreatesNoRun: true,
      originalStaleEventQuarantined: true, quarantineReasonVisible: true, quarantineReadCreatesNoRun: true };
  } finally { await closeRpcAndWait(rpc); }
}
