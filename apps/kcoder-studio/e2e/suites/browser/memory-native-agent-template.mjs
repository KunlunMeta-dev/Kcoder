import { openWorkflowTaskCreator, openWikiSharedKnowledge } from '../../harness/automation-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { openPageGatewayRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { waitFor } from '../../harness/run-context.mjs';

// Deterministic Provider protocol exercises the actual Agent/source/budget path;
// its response is not evidence of live-model business quality.
export async function startNativeTemplateProtocolFixture(context) {
  const observations = [], protocolFailures = [];
  const model = await startApprovalModelFixture(context, {
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    responseSteps({ body, requestNumber }) {
      let stage = 'bounded_request_count';
      try {
      assert.ok(requestNumber <= 2, 'one explicit native Agent run must stay within two fixture calls');
      stage = 'actual_output_limit';
      assert.ok(body.max_tokens > 0 && body.max_tokens <= 4096, 'actual task request must preserve its narrowed model output limit');
      const tools = body.tools ?? [];
      stage = 'actual_source_tool_registry';
      assert.ok(tools.some(tool => tool.function?.name === 'AutomationSourceRead'), 'actual Agent registry must expose its real approved source reader');
      const results = (body.messages ?? []).filter(message => message.role === 'tool');
      if (!results.length) return [
        { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'actual-native-template-source-read', type: 'function',
          function: { name: 'AutomationSourceRead', arguments: '{"index":0,"offset":0,"limit":16384}' } }] } },
        { delta: {}, finishReason: 'tool_calls' },
      ];
      const raw = results.at(-1).content;
      const text = typeof raw === 'string' ? raw : raw.map(block => block.text ?? '').join('');
      stage = 'source_tool_result_json';
      const source = JSON.parse(text);
      stage = 'source_read_complete';
      assert.equal(source.complete, true);
      stage = 'source_identity_sha256';
      assert.match(source.sha256, /^[a-f0-9]{64}$/);
      stage = 'source_material_json';
      const material = JSON.parse(source.text);
      stage = 'source_material_kind';
      assert.equal(material.kind, 'publication');
      stage = 'actual_fixed_wiki_marker';
      assert.match(material.publication.pages[0].markdown, /Deterministic Wiki page fixture/);
      const fixed = { kind: 'publication', id: material.publication.draft.publicationId, revision: String(material.publication.version) };
      observations.push({ reference: fixed, sha256: source.sha256, totalBytes: source.totalBytes });
      return [{ delta: { role: 'assistant', content: JSON.stringify({ status: 'complete', title: 'Actual native source digest',
        summary: material.publication.pages[0].markdown, findings: ['The original fixed publication was read by the actual source tool.'],
        sourceRefs: [fixed], missingInputs: [] }) } }, { delta: {}, finishReason: 'stop' }];
      } catch (error) {
        protocolFailures.push({ requestNumber, stage, code: error.code ?? error.name });
        throw error;
      }
    },
  });
  return { ...model, observations, protocolFailures };
}

export async function exerciseNativeAgentTemplate({ context, page, gateway, model }) {
  const budget = Number(process.env.KCODER_E2E_NATIVE_AGENT_TEMPLATE_BUDGET || 1_000_000);
  assert.ok([5000, 1_000_000].includes(budget), "focused template budget must be the explicit custom case or the current default");
  const adoptionWire = [], pendingAdoptions = new Map();
  const network = await page.context().newCDPSession(page);
  const owner = value => value ? { accountId: value.accountId, targetId: value.targetId,
    workspaceId: value.workspaceId, organizationId: value.organizationId ?? null } : null;
  const adoption = value => value ? { id: value.id, owner: owner(value.owner), publicationOwner: owner(value.publicationOwner),
    publicationId: value.publicationId, publicationVersion: value.publicationVersion,
    enabled: value.enabled, revision: value.revision } : null;
  network.on('Network.webSocketFrameSent', event => {
    try {
      const frame = JSON.parse(event.response.payloadData), method = frame.method;
      if (!['integrations/knowledge/publishKnowledge', 'integrations/knowledge/adoptPublication',
        'integrations/knowledge/listAdoptions', 'integrations/knowledge/listPublications'].includes(method)) return;
      const key = `${event.requestId}:${frame.id}`;
      pendingAdoptions.set(key, method);
      const request = frame.params ?? {}, payload = request.payload ?? {};
      adoptionWire.push({ direction: 'sent', method, id: frame.id, operationId: request.operationId ?? null,
        expectedRevision: request.expectedRevision ?? null, owner: owner(request.scope),
        publicationId: payload.publicationId ?? payload.draft?.publicationId ?? null, version: payload.version ?? null });
    } catch { /* Retain only bounded public adoption metadata, never raw frames. */ }
  });
  network.on('Network.webSocketFrameReceived', event => {
    try {
      const frame = JSON.parse(event.response.payloadData), key = `${event.requestId}:${frame.id}`;
      const method = pendingAdoptions.get(key);
      if (!method) return;
      pendingAdoptions.delete(key);
      const reply = frame.result;
      adoptionWire.push({ direction: 'received', method, id: frame.id, status: reply?.status ?? null,
        code: reply?.error?.code ?? null, rpcErrorCode: frame.error?.code ?? null,
        adoption: adoption(reply?.result?.adoption),
        adoptions: method === 'integrations/knowledge/listAdoptions' ? reply?.result?.page?.items?.map(adoption) : undefined });
    } catch { /* Credentials, bodies, titles and raw error text are excluded. */ }
  });
  await network.send('Network.enable');
  await page.evaluate(() => {
    const events = [];
    const record = event => {
      const element = event.target instanceof Element ? event.target : undefined;
      events.push({ type: event.type, testId: element?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        tag: element?.tagName ?? null, buttonDisabled: element?.closest('button')?.disabled ?? null, trusted: event.isTrusted });
      if (events.length > 64) events.shift();
    };
    for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, record, true);
    window.__nativeTemplateAdoptionEvents = { events,
      dispose: () => { for (const type of ['pointerdown', 'pointerup', 'click']) document.removeEventListener(type, record, true); } };
  });
  const rpc = await openPageGatewayRpc(context, page, gateway, 'close native Agent-template observation RPC');
  try {
    await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-native-agent-template', version: '1' },
      capabilities: { experimental: { integrationScopeV1: true, automationTemplatesV1: true, integrationOperationReceiptsV1: true } } });
    const scope = await rpc.request('integrations/scope/read');
    const nativeRead = async method => {
      const reply = await rpc.request(`integrations/automation/${method}`, { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 10_000, payload: {} });
      assert.equal(reply.status, 'completed', `${method}: ${reply.error?.code}`); return reply.result.page.items;
    };
    await openWikiSharedKnowledge(page);
    await page.getByTestId('publication-create-toggle').click();
    const libraries = page.getByTestId('native-wiki-publication-inputs');
    let library = libraries.getByTestId('publication-library-choice').filter({ hasText: 'Native publication fixture' });
    await libraries.getByTestId('publication-library-choice').first().waitFor();
    if (await library.count() === 0) { await libraries.getByTestId('knowledge-page-next').click(); await library.waitFor(); }
    await library.click();
    await page.getByTestId('publication-library-pages').getByTestId('publication-source-checkbox').check();
    await page.getByTestId('publication-title').fill('Native adopted Agent input');
    await page.getByTestId('publication-purpose').fill('Explicit source for the actual native fixed Agent template.');
    await page.getByTestId('knowledge-publish').click();
    const publication = page.getByTestId('knowledge-publication-row').filter({ hasText: 'Native adopted Agent input' });
    await publication.waitFor({ timeout: 15_000 });
    const publishedId = adoptionWire.findLast(value => value.direction === 'sent'
      && value.method === 'integrations/knowledge/publishKnowledge')?.publicationId;
    assert.ok(publishedId, 'the actual published source must have its original public identity');
    await publication.getByTestId('publication-adopt').click();
    try {
      const accepted = await waitFor(() => adoptionWire.findLast(value => value.direction === 'received'
        && value.method === 'integrations/knowledge/adoptPublication' && value.status === 'completed'
        && value.adoption?.publicationId === publishedId && value.adoption.publicationVersion === 1
        && value.adoption.enabled), 15_000, 'actual original publication adoption acknowledgement');
      await waitFor(() => adoptionWire.some(value => value.direction === 'received'
        && value.method === 'integrations/knowledge/listAdoptions' && value.status === 'completed'
        && value.adoptions?.some(item => item?.id === accepted.adoption.id && item.enabled
          && item.publicationId === publishedId && item.publicationVersion === 1)),
      15_000, 'the same original adoption in the refreshed native directory');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="knowledge-publication-row"]')].some(row => row.textContent.includes('Native adopted Agent input') && row.querySelector('[data-testid="publication-adopt"]')?.disabled));
    } catch (error) {
      const dom = await publication.evaluate(row => ({ connected: row.isConnected,
        adoptDisabled: row.querySelector('[data-testid="publication-adopt"]')?.disabled ?? null,
        version: row.querySelector('[data-testid="publication-version"]')?.value ?? null,
        alerts: row.querySelectorAll('[role="alert"]').length }));
      await context.writeArtifactJson('native-agent-template-adoption-failure.json', { dom, wire: adoptionWire,
        providerRequests: model.requests.length });
      throw error;
    }
    await openWorkflowTaskCreator(page);
    await page.getByTestId('subscription-template').selectOption('source-digest');
    await page.getByTestId('subscription-title').fill('Actual adopted-source Agent subscription');
    await page.getByTestId('subscription-input-period').fill('2026-W43');
    const inputs = page.getByTestId('adopted-template-inputs');
    const input = inputs.getByTestId('adopted-template-input-row').filter({ hasText: 'Native adopted Agent input' });
    await input.getByTestId('subscription-input-source').check();
    await page.getByTestId('subscription-schedule-mode').selectOption('once');
    const at = new Date(Date.now() + 4000);
    const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    await page.getByTestId('subscription-datetime').fill(local);
    // The original user-selected budget is sent exactly; the test never changes
    // profile settings, actual model limits, input estimates or native guard rules.
    await page.getByTestId('subscription-tokens').fill(String(budget));
    await page.getByTestId('subscription-preview').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="subscription-consent"]')?.disabled === false);
    assert.equal(model.requests.length, 0, 'choosing adopted input and previewing must not call a Provider');
    await page.getByTestId('subscription-consent').check();
    await page.screenshot({ path: context.pathInArtifacts('native-agent-template-confirmation.png'), fullPage: true });
    await page.getByTestId('subscription-save').click();
    await page.getByTestId('subscription-row').filter({ hasText: 'Actual adopted-source Agent subscription' }).waitFor({ timeout: 15_000 });
    const subscriptions = await nativeRead('listSubscriptions');
    const original = subscriptions.find(item => item.draft.title === 'Actual adopted-source Agent subscription');
    assert.ok(original);
    assert.equal(original.draft.workflowId, 'builtin-office-source-digest');
    assert.equal(original.draft.workflowVersion, 1);
    assert.equal(original.draft.maximumTokens, budget, 'the actual saved native intent must retain the explicit per-run budget');
    assert.equal(original.draft.inputs.sourceRefs.length, 1);
    const deadline = Date.now() + 30_000;
    let actual;
    while (Date.now() < deadline) {
      const runs = (await nativeRead('listAutomationRuns')).filter(item => item.subscriptionId === original.draft.id);
      assert.ok(runs.length <= 1, 'the original template subscription must not repeat an accepted operation');
      if (runs.length) {
        if (['failed', 'cancelled'].includes(runs[0].status)) {
          const operation = await rpc.request('integrations/operation/read', { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 10_000, payload: { operationId: runs[0].nativeOperationId } });
          const taskId = operation.result?.receipt?.runtimeAcceptance?.taskId;
          const workflow = taskId ? await rpc.request('workflow/runs/read', { runId: taskId }).catch(() => null) : null;
          const models = await rpc.request('runtime.models.list', { threadId: runs[0].nativeThreadId }).catch(() => null);
          // This is the existing public summary. Never persist full profiles,
          // endpoints, keys, arbitrary overrides or request bodies.
          const configuration = models?.activeConfiguration;
          const currentModel = configuration ? { providerId: configuration.providerId, modelId: configuration.modelId,
            apiFormat: configuration.apiFormat, revision: configuration.revision, maxOutput: configuration.maxOutputTokens,
            contextWindow: configuration.contextWindowTokens, outputHeadroom: configuration.outputHeadroomTokens,
            overrideFields: configuration.requestOverrideFields, requestOutputLimits: configuration.requestOutputLimits } : null;
          await context.writeArtifactJson('native-agent-template-failure.json', { run: runs[0], workflow, currentModel,
            providerRequests: model.requests.length, fixtureProtocolFailures: model.protocolFailures });
          if (budget === 5000 && runs[0].status === 'failed') {
            assert.equal(runs[0].errorCode, 'AUTOMATION_BUDGET_EXHAUSTED', 'the actual native budget rejection must remain distinguishable from authority or unknown failures');
            assert.ok(model.requests.length <= 1, 'a refused request must not dispatch another Provider call');
            const before = model.requests.length;
            for (let check = 0; check < 3; check += 1) {
              const observed = (await nativeRead('listAutomationRuns')).filter(item => item.subscriptionId === original.draft.id);
              assert.equal(observed.length, 1); assert.equal(observed[0].id, runs[0].id);
              assert.equal(observed[0].nativeOperationId, runs[0].nativeOperationId);
              assert.equal(observed[0].errorCode, 'AUTOMATION_BUDGET_EXHAUSTED');
            }
            assert.equal(model.requests.length, before);
            await page.getByTestId('business-subscriptions').getByTestId('knowledge-refresh').last().click();
            const detail = page.getByTestId('automation-run').filter({ hasText: 'Actual adopted-source Agent subscription' });
            await detail.waitFor(); await detail.locator('summary').click();
            await detail.getByTestId('automation-budget-exhausted').waitFor();
            await page.screenshot({ path: context.pathInArtifacts('native-agent-template-budget-exhausted.png'), fullPage: true });
            await context.writeArtifactJson('native-agent-template-budget-results.json', { customBudget: budget, actualStatus: runs[0].status,
              errorCode: runs[0].errorCode, providerRequests: before, runId: runs[0].id, operationId: runs[0].nativeOperationId,
              unchangedOriginalRunAfterReads: true, reservationEstimateOrModelLimitsChanged: false });
            return { actualBuiltInAgentTemplate: true, actualAdoptedPublicationInput: true, customBudgetInsufficientConfirmed: true,
              nativeBudgetErrorVisible: true, providerFixtureRequests: before, originalRunNotRepeated: true, liveModelQualityVerified: false };
          }
          assert.fail(`actual native Agent outcome: ${runs[0].status}; Provider calls=${model.requests.length}; workflow=${workflow?.error ?? workflow?.status ?? 'unknown'}`);
        }
        if (runs[0].status === 'completed') { actual = runs[0]; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(actual, `actual native Agent completion is required; Provider calls=${model.requests.length}`);
    assert.equal(model.requests.length, 2);
    assert.equal(model.observations.length, 1);
    assert.deepEqual(model.observations[0].reference, original.draft.inputs.sourceRefs[0]);
    assert.ok(actual.nativeThreadId && actual.nativeOperationId);
    assert.equal(actual.nativeTurnId ?? null, null);
    assert.match(actual.output, /Actual native source digest/);
    await page.getByTestId('business-subscriptions').getByTestId('knowledge-refresh').last().click();
    const run = page.getByTestId('automation-run').filter({ hasText: 'Actual adopted-source Agent subscription' });
    await run.waitFor(); await run.locator('summary').click();
    await run.getByText(/Actual native source digest/).waitFor();
    await page.screenshot({ path: context.pathInArtifacts('native-agent-template-completed.png'), fullPage: true });
    await context.writeArtifactJson('native-agent-template-results.json', { workflowId: original.draft.workflowId, workflowVersion: 1, maximumBudget: budget,
      sourceRefs: original.draft.inputs.sourceRefs, sourceReads: model.observations, providerRequests: model.requests.length,
      declaredUsageTokens: 280, costKnown: false, runId: actual.id, operationId: actual.nativeOperationId, nativeThreadId: actual.nativeThreadId,
      nativeTurnId: actual.nativeTurnId ?? null, status: actual.status, modelIndependentProtocolFixture: true, liveModelQualityVerified: false });
    return { actualBuiltInAgentTemplate: true, actualAdoptedPublicationInput: true, actualNativeSourceTool: true, providerFixtureRequests: 2, liveModelQualityVerified: false };
  } finally {
    const clicks = await page.evaluate(() => {
      const trace = window.__nativeTemplateAdoptionEvents;
      trace?.dispose(); delete window.__nativeTemplateAdoptionEvents;
      return trace?.events ?? [];
    }).catch(() => []);
    await context.writeArtifactJson('native-agent-template-adoption-protocol.json', { wire: adoptionWire,
      pending: pendingAdoptions.size, clicks, fixtureProtocolFailures: model.protocolFailures });
    await network.detach().catch(() => {});
    await closeRpcAndWait(rpc);
  }
}
