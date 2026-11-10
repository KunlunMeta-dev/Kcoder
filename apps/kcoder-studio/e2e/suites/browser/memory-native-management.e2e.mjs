import { openWorkflowTaskCreator, openWikiMemory, openWikiSharedKnowledge, openWikiLibrary } from '../../harness/automation-navigation.mjs';
import assert from 'node:assert/strict';
import { isIntegrationReply, isKnowledgeAdoptionListResult, isKnowledgeAdoptionResult } from '../../../shared/generated/contractGuards.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { openPageGatewayRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareNativeFileEventFiles, exerciseNativeFileEventSubscription } from './memory-native-file-events.mjs';
import { startNativeTemplateProtocolFixture, exerciseNativeAgentTemplate } from './memory-native-agent-template.mjs';
import { exerciseNativeTaskModelSelection } from './memory-native-task-models.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { runE2E, repoRoot, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'native-memory-review-through-authenticated-studio', tier: 'full-integration',
  modelPolicy: 'model-independent browser/native storage/Code plus one explicit built-in Agent using a bounded local Provider protocol fixture; no live-model quality claim',
}, async context => {
  const memoryOnly = process.env.KCODER_E2E_NATIVE_MEMORY_ONLY === '1';
  const memoryPublicationOnly = process.env.KCODER_E2E_NATIVE_MEMORY_PUBLICATION_ONLY === '1' || memoryOnly;
  assert.ok(!memoryPublicationOnly || !['KCODER_E2E_NATIVE_AUTOMATION_MODEL_PICKER_ONLY', 'KCODER_E2E_NATIVE_TASK_STATE_ONLY', 'KCODER_E2E_AUTOMATION_QUARANTINE_ONLY', 'KCODER_E2E_AUTOMATION_CONNECTION_SOURCES_ONLY', 'KCODER_E2E_NATIVE_AGENT_TEMPLATE_ONLY'].some(name => process.env[name] === '1'), 'memory/publication focus cannot combine with automation modes');
  const taskModelsOnly = process.env.KCODER_E2E_NATIVE_AUTOMATION_MODEL_PICKER_ONLY === '1';
  const taskStateOnly = process.env.KCODER_E2E_NATIVE_TASK_STATE_ONLY === '1';
  const quarantineOnly = process.env.KCODER_E2E_AUTOMATION_QUARANTINE_ONLY === '1' || taskStateOnly;
  const connectionSourcesOnly = process.env.KCODER_E2E_AUTOMATION_CONNECTION_SOURCES_ONLY === '1';
  assert.ok(!connectionSourcesOnly || (!taskModelsOnly && !quarantineOnly && process.env.KCODER_E2E_NATIVE_AGENT_TEMPLATE_ONLY !== '1'));
  assert.ok(!taskModelsOnly || process.env.KCODER_E2E_NATIVE_AGENT_TEMPLATE_ONLY !== '1');
  assert.ok(!quarantineOnly || (!taskModelsOnly && process.env.KCODER_E2E_NATIVE_AGENT_TEMPLATE_ONLY !== '1'));
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  await context.writeStateJson('profile/settings.json', { providers: {}, knowledge: { enabled: true }, integrations: { knowledge: {
    memory_center_enabled: true, publications_enabled: true, business_automation_enabled: true,
  } } });
  await prepareNativeFileEventFiles(workspace);
  const profile = context.pathInState('profile');
  const wikiFixture = process.env.KCODER_E2E_KNOWLEDGE_FIXTURE_BIN || resolve(repoRoot,
    'target/debug/examples/native_wiki_publication_fixture');
  const fixtureProcess = context.spawnOwned('native-wiki-publication-fixture', wikiFixture,
    ['--run-root', context.runRoot]);
  const [fixtureCode] = await once(fixtureProcess, 'exit', { signal: AbortSignal.timeout(20_000) });
  assert.equal(fixtureCode, 0, 'owned native Wiki fixture must commit its real source and page');
  const templateModel = memoryPublicationOnly ? null : await startNativeTemplateProtocolFixture(context);
  // The Wiki fixture retains its strict no-provider precondition; the later
  // actual Code-only phase receives this isolated unreachable model config.
  if (!memoryPublicationOnly) await writeFile(context.pathInState('profile/settings.json'), JSON.stringify({ active_provider: 'owned-code-only', permission_mode: 'ask', allowed_tools: ['read'], max_retries: 0, session_memory: { enabled: false },
    providers: { 'owned-code-only': { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: templateModel.baseUrl, default_model: 'code-only', context_window_tokens: 128000, max_output_tokens: 4096, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } }, knowledge: { enabled: true }, integrations: { ...(taskModelsOnly ? { core: { modelPolicies: [{ id: 'owned-task-models', title: 'Owned task model pool', candidates: [{ provider: 'owned-code-only', model: 'code-only' }] }] } } : {}), knowledge: {
    memory_center_enabled: true, publications_enabled: true, business_automation_enabled: true,
  } } }));
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.jsonc', [{
    id: 'local', label: 'Memory fixture', transport: 'local', command: binary, workspace,
  }]);
  const gateway = await startGateway(context, { ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}), workspace, serversFile, kcoderBin: binary, auth: true,
    env: { KCODER_CONFIG_DIR: profile } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const observationWrites = [], detachObservers = [];
  let observationIndex = 0;
  if (memoryPublicationOnly) {
    const observeSocket = socket => {
      const pending = new Map();
      const parse = payload => { try { return JSON.parse(String(payload)); } catch { return null; } };
      const sent = ({ payload }) => {
        const value = parse(payload);
        if (['integrations/knowledge/adoptPublication', 'integrations/knowledge/listAdoptions'].includes(value?.method))
          pending.set(value.id, value.method);
      };
      const received = ({ payload }) => {
        const value = parse(payload), method = pending.get(value?.id);
        if (!method) return;
        pending.delete(value.id);
        const reply = value.result;
        const candidateCode = reply?.error?.code ?? value.error?.message;
        const fixedCode = typeof candidateCode === 'string' && /^(?:KNOWLEDGE|INTEGRATION|CONNECTIVITY|NATIVE)_[A-Z0-9_]+$/.test(candidateCode) ? candidateCode : null;
        const row = { method, status: ['completed', 'accepted', 'rejected', 'unknown', 'unavailable', 'cancelled'].includes(reply?.status) ? reply.status : null,
          fixedCode, rpcErrorCode: Number.isInteger(value.error?.code) ? value.error.code : null,
          integrationReplyValid: isIntegrationReply(reply),
          resultGuardValid: method.endsWith('/listAdoptions') ? isKnowledgeAdoptionListResult(reply?.result) : isKnowledgeAdoptionResult(reply?.result),
          pageItemCount: Array.isArray(reply?.result?.page?.items) ? reply.result.page.items.length : null,
          bodySha256: createHash('sha256').update(String(payload)).digest('hex') };
        const write = context.writeArtifactJson(`knowledge-wire-${String(++observationIndex).padStart(3, '0')}.json`, row);
        observationWrites.push(write);
        // Observe failures now; finally still awaits the original promises and surfaces any artifact failure.
        void write.catch(() => {});
      };
      socket.on('framesent', sent); socket.on('framereceived', received);
      detachObservers.push(() => { socket.off('framesent', sent); socket.off('framereceived', received); });
    };
    page.on('websocket', observeSocket);
    detachObservers.push(() => page.off('websocket', observeSocket));
  }

  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')),
      page.locator('button[type="submit"]').click()]);
    await openWikiMemory(page);
    await page.getByTestId('memory-center').waitFor({ timeout: 30_000 });
    if (connectionSourcesOnly) {
      await openWorkflowTaskCreator(page);
      await page.getByTestId('subscription-schedule-mode').selectOption('connection');
      await page.getByTestId('automation-connection-source-empty').waitFor({ timeout: 15_000 });
      assert.equal(await page.getByTestId('subscription-preview').isDisabled(), true);
      assert.equal(await page.getByTestId('subscription-save').isDisabled(), true);
      assert.equal(await page.getByTestId('automation-connection-source-select').count(), 0);
      assert.equal(await page.getByTestId('subscription-row').count(), 0);
      assert.equal(await page.getByTestId('automation-run-row').count(), 0);
      assert.equal(await page.getByTestId('knowledge-operation-error').count(), 0);
      assert.equal(templateModel.requests.length, 0);
      await page.screenshot({ path: context.pathInArtifacts('native-connection-source-selection.png'), fullPage: true });
      return { focusedNativeConnectionSourcesOnly: true, actualNativeEmptySourceProjection: true, noSubscriptionOrRunCreated: true, modelRequests: 0, fixtureOnly: true };
    }
    if (quarantineOnly) {
      const result = await exerciseNativeFileEventSubscription({ context, page, gateway, workspace });
      assert.equal(templateModel.requests.length, 0, 'quarantine inspection must create no model request');
      return { ...result, focusedAutomationQuarantineOnly: !taskStateOnly, focusedTaskStateOnly: taskStateOnly, modelRequests: 0, fixtureOnly: true };
    }
    if (taskModelsOnly) return { ...await exerciseNativeTaskModelSelection({ context, page, gateway, model: templateModel }), focusedTaskModelsOnly: true };
    if (process.env.KCODER_E2E_NATIVE_AGENT_TEMPLATE_ONLY === '1') {
      return { ...await exerciseNativeAgentTemplate({ context, page, gateway, model: templateModel }),
        focusedAgentTemplateOnly: true, fixtureOnly: true };
    }
    await page.getByTestId('memory-new-title').fill('Native memory acceptance fixture');
    await page.getByTestId('memory-new-content').fill('Lead with findings and include the source table.');
    await page.getByTestId('memory-propose').click();
    const row = page.getByTestId('reviewed-memory-row').filter({ hasText: 'Native memory acceptance fixture' });
    await row.waitFor({ timeout: 15_000 });
    await row.getByTestId('memory-toggle').waitFor({ timeout: 15_000 });
    assert.equal(await row.getByTestId('memory-accept').count(), 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openWikiMemory(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="reviewed-memory-row"]').length === 1);
    await row.getByTestId('memory-toggle').waitFor({ timeout: 30_000 });
    assert.equal(await page.getByTestId('reviewed-memory-row').count(), 1);
    await page.screenshot({ path: context.pathInArtifacts('reviewed-memory-desktop.png') });
    if (memoryPublicationOnly) {
      const rpc = await openPageGatewayRpc(context, page, gateway, 'close focused memory authority read');
      try {
        await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-memory-authority-read', version: '1' }, capabilities: { experimental: { integrationScopeV1: true, memoryReviewV1: true, integrationOperationReceiptsV1: true } } });
        const readMemory = async () => {
          const scope = await rpc.request('integrations/scope/read');
          const reply = await rpc.request('integrations/memory/list', { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 10_000, payload: { includeCandidates: true } });
          assert.equal(reply.status, 'completed', `authoritative memory list: ${reply.error?.code}`);
          const items = reply.result.page.items;
          assert.equal(items.length, 1);
          assert.equal(items[0].proposal.title, 'Native memory acceptance fixture');
          return items[0];
        };
        const original = await readMemory();
        assert.equal(original.enabled, true);
        let previousRevision = original.revision;
        for (const enabled of [false, true]) {
          await row.getByTestId('memory-toggle').click();
          // Poll only the authoritative read, never replay the toggle mutation.
          await waitFor(async () => (await readMemory()).enabled === enabled, 15_000, 'authoritative memory enabled state');
          await page.reload({ waitUntil: 'domcontentloaded' });
          await openWikiMemory(page);
          await row.getByTestId('memory-toggle').waitFor({ timeout: 30_000 });
          const stored = await readMemory();
          assert.equal(stored.id, original.id);
          assert.equal(stored.enabled, enabled);
          assert.ok(stored.revision > previousRevision);
          previousRevision = stored.revision;
        }
      } finally { await closeRpcAndWait(rpc, 'focused memory authority read'); }
    }

    await page.evaluate(() => { history.pushState({}, '', '/settings/appearance'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByTestId('appearance-mode-dark').click();
    await page.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'dark');
    await page.evaluate(() => { history.pushState({}, '', '/context'); dispatchEvent(new PopStateEvent('popstate')); });
    await row.getByTestId('memory-toggle').waitFor({ timeout: 15_000 });
    await page.screenshot({ path: context.pathInArtifacts('reviewed-memory-dark.png') });
    await page.evaluate(() => { history.pushState({}, '', '/settings/appearance'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByTestId('appearance-mode-light').click();
    await page.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'light');
    await page.evaluate(() => { history.pushState({}, '', '/context'); dispatchEvent(new PopStateEvent('popstate')); });
    await row.getByTestId('memory-toggle').waitFor({ timeout: 15_000 });
    assert.equal(new URL(page.url()).pathname, '/context');
    if (memoryOnly) {
      assert.equal(templateModel, null, 'memory-only must not start a model service');
      assert.equal(await page.getByTestId('wiki-workspace-tab-shared').count(), 0);
      return { focusedMemoryOnly: true, actualMemorySaved: true, authoritativeDisableEnableRetainedAfterReload: true, modelRequests: 0, schedules: 0, fixtureOnly: true };
    }
    await openWikiSharedKnowledge(page);
    const knowledge = page.getByTestId('knowledge-publications');
    await knowledge.locator('[aria-busy="false"]').first().waitFor({ timeout: 15_000 });
    assert.equal(await knowledge.getByRole('alert').count(), 0);
    await page.screenshot({ path: context.pathInArtifacts('native-knowledge-publications.png') });
    await openWikiLibrary(page);
    for (let index = 1; index <= 10; index += 1) {
      await page.getByTestId('knowledge-create').click();
      await page.getByTestId('wiki-create-input').fill(`Native source ${String(index).padStart(2, '0')}`);
      await page.getByTestId('wiki-create-confirm').click();
      await page.getByTestId('wiki-create-dialog').waitFor({ state: 'hidden', timeout: 15_000 });
    }
    await openWikiMemory(page);
    await openWikiSharedKnowledge(page);
    await page.getByTestId('publication-create-toggle').click();
    const nativeInputs = page.getByTestId('native-wiki-publication-inputs');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="publication-library-choice"]').length === 10);
    await nativeInputs.getByTestId('knowledge-page-next').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="publication-library-choice"]').length === 1);
    let fixtureLibrary = nativeInputs.getByTestId('publication-library-choice').filter({ hasText: 'Native publication fixture' });
    if (await fixtureLibrary.count() === 0) {
      await nativeInputs.getByTestId('knowledge-page-previous').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="publication-library-choice"]').length === 10);
      fixtureLibrary = nativeInputs.getByTestId('publication-library-choice').filter({ hasText: 'Native publication fixture' });
    }
    await fixtureLibrary.click();
    const sourceCheckbox = page.getByTestId('publication-library-pages').getByTestId('publication-source-checkbox');
    await sourceCheckbox.waitFor();
    assert.equal(await nativeInputs.getByRole('alert').count(), 0);
    await page.screenshot({ path: context.pathInArtifacts('native-wiki-source-picker.png'), fullPage: true });
    await sourceCheckbox.check();
    await page.getByTestId('publication-title').fill('Native fixed publication acceptance');
    await page.getByTestId('publication-purpose').fill('Explicit model-independent fixed source acceptance.');
    await page.getByTestId('knowledge-publish').click();
    let publication = page.getByTestId('knowledge-publication-row').filter({ hasText: 'Native fixed publication acceptance' });
    await publication.waitFor({ timeout: 15_000 });
    await publication.getByTestId('knowledge-query').fill('Deterministic');
    await publication.getByTestId('knowledge-search').click();
    await publication.getByRole('blockquote').getByText('Deterministic Wiki page fixture. No model generated this material.', { exact: true }).waitFor({ timeout: 15_000 });
    await publication.getByTestId('publication-adopt').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="publication-adopt"]')?.disabled === true);
    await page.getByTestId('knowledge-adoptions-toggle').click();
    await page.getByTestId('knowledge-adoption-toggle').waitFor();
    await page.screenshot({ path: context.pathInArtifacts('native-publication-adopted.png'), fullPage: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openWikiSharedKnowledge(page);
    publication = page.getByTestId('knowledge-publication-row').filter({ hasText: 'Native fixed publication acceptance' });
    await publication.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="publication-adopt"]')?.disabled === true);
    await publication.getByTestId('publication-source-status-toggle').click();
    await publication.getByTestId('publication-source-observation').waitFor({ timeout: 15_000 });
    assert.equal(await publication.getByRole('alert').count(), 0);
    await publication.getByTestId('knowledge-revoke').click();
    await publication.waitFor({ state: 'detached', timeout: 15_000 });
    assert.equal(await page.getByText('Deterministic Wiki page fixture. No model generated this material.', { exact: true }).count(), 0);
    await page.getByTestId('publication-history-toggle').click();
    await page.getByTestId('publication-owner-history').getByText('Native fixed publication acceptance', { exact: false }).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId('publication-history-revoke').count(), 0);
    await page.screenshot({ path: context.pathInArtifacts('native-publication-revoked.png'), fullPage: true });
    if (memoryPublicationOnly) {
      assert.equal(templateModel, null, 'focused memory/publication must not start a model service');
      return { focusedMemoryPublicationOnly: true, actualMemorySaved: true, authoritativeDisableEnableRetainedAfterReload: true, actualPublicationPublished: true, fixedVersionAdoptedAfterReload: true, actualPublicationRevoked: true, modelRequests: 0, fixtureOnly: true };
    }
    await openWorkflowTaskCreator(page);
    const automation = page.getByTestId('business-subscriptions');
    await automation.locator('[aria-busy="false"]').first().waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="subscription-template"]')?.querySelectorAll('option').length === 8);
    assert.equal(await automation.getByRole('alert').count(), 0);
    assert.equal(await page.getByTestId('native-template-failure').count(), 0);
    await page.screenshot({ path: context.pathInArtifacts('native-business-templates.png') });
    const fileEvents = await exerciseNativeFileEventSubscription({ context, page, gateway, workspace });
    const agentTemplate = await exerciseNativeAgentTemplate({ context, page, gateway, model: templateModel });
    await openWikiMemory(page);
    await page.setViewportSize({ width: 480, height: 760 });
    await page.getByTestId('memory-center').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2));
    await page.screenshot({ path: context.pathInArtifacts('reviewed-memory-narrow.png') });
    return { realNativeReview: true, reloadRetained: true, cookieAuthenticated: true,
      nativeKnowledgeReads: true, nativeBusinessTemplateCount: 6, actualWikiLibraryPaging: [10, 1],
      fixtureSourcePage: true, actualPublicationPublished: true, fixedVersionAdoptedAfterReload: true,
      actualPublicationRevoked: true, ...fileEvents, ...agentTemplate,
      responsive: true, fixtureOnly: true, modelTurnSubmitted: false };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png'), timeout: 5000 }).catch(() => {});
    const selectedTabs = await page.locator('[data-testid^="wiki-workspace-tab-"][aria-selected="true"]')
      .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid'))).catch(() => []);
    await context.writeArtifactJson('failure-navigation.json', {
      pathname: new URL(page.url()).pathname, selectedTabs,
    }).catch(() => {});
    throw error;
  } finally {
    for (const detach of detachObservers) detach();
    try { await Promise.all(observationWrites); } finally { await page.close(); }
  }
});
