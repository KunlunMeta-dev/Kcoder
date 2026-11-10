import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { realModelPreflight, prepareIsolatedRealModelConfig } from '../../harness/real-model.mjs';
import { startLiveModelObserver } from '../../harness/live-model-observer.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { openRpc, gatewayRpcUrl, closeRpcAndWait } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, requireExecutable } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { BUSINESS_LIMITS as limits, businessCases, businessResult, validateBusinessResult } from './business-template-cases.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
await runE2E(import.meta.url, { testId: 'native-six-business-templates-live-model-current-sources',
  tier: 'real-model-credentialed', modelPolicy: 'real-model-required', retainSuccessLogs: true }, async context => {
  const requestCeiling = Number(process.env.KCODER_E2E_NATIVE_BUSINESS_REQUEST_CAP ?? limits.requests);
  assert.ok(Number.isSafeInteger(requestCeiling) && requestCeiling > 0 && requestCeiling <= limits.requests, 'a campaign may only narrow the original suite request budget');
  const selectedIds = process.env.KCODER_E2E_NATIVE_BUSINESS_CASES?.split(',');
  if (selectedIds) assert.ok(selectedIds.length > 0 && new Set(selectedIds).size === selectedIds.length
    && selectedIds.every(id => businessCases.some(task => task.id === id)), 'only explicit named quality cases may be selected');
  const selectedCases = selectedIds ? businessCases.filter(task => selectedIds.includes(task.id)) : businessCases;
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  // The canonical URL retains its slash: an upstream loopback origin must not
  // redact a different run-owned Gateway port and break readiness discovery.
  context.registerSecret(new URL(model.providerConfig.endpoint).href);
  const { path: workspace } = await materializeWorkspace(context, 'native-business', { instanceId: 'native-business-quality' });
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  await context.writeStateJson('real-model-config/settings.json', { providers: {}, knowledge: { enabled: true },
    integrations: { knowledge: { publications_enabled: true, business_automation_enabled: true } } });
  const fixtureBin = await requireExecutable(process.env.KCODER_E2E_KNOWLEDGE_FIXTURE_BIN
    || resolve(repoRoot, 'target/debug/examples/native_wiki_publication_fixture'), 'current owned business Wiki fixture');
  const fixture = context.spawnOwned('native-business-wiki-corpus', fixtureBin, ['--run-root', context.runRoot]);
  let fixtureText = '';
  fixture.stdout.on('data', data => { fixtureText += data.toString('utf8'); });
  const [fixtureCode] = await once(fixture, 'exit', { signal: AbortSignal.timeout(20_000) });
  assert.equal(fixtureCode, 0, 'the owned native corpus must commit before any model request');
  assert.ok(Buffer.byteLength(fixtureText) <= 64 * 1024);
  const committed = JSON.parse(fixtureText);
  assert.equal(committed.fixtureOnly, true); assert.equal(committed.modelCalls, 0);
  const corpusPath = resolve(repoRoot, 'crates/kcoder_knowledge/examples/fixtures/business-template-corpus.json');
  const corpusBytes = await readFile(corpusPath), corpus = JSON.parse(corpusBytes);
  await context.writeArtifactJson('native-business-quality-limits.json', { limits, selectedCases: selectedCases.map(task => task.id), provider: model.provider, model: model.model,
    credentialStatusChecked: true, corpusSha256: sha(corpusBytes), requestCeiling, originalCredentialsCopied: false });
  assert.equal(committed.corpusVersion, corpus.version); assert.equal(committed.pages.length, corpus.pages.length);
  const pages = new Map(), pageHashes = new Map();
  for (const page of committed.pages) {
    const original = corpus.pages.find(value => value.id === page.id);
    assert.ok(original); assert.equal(page.markdownSha256, sha(original.markdown));
    pages.set(page.id, page);
    pageHashes.set(JSON.stringify([committed.libraryId, page.pageId, page.pageRevision]), page.markdownSha256);
  }

  let active, requests = 0;
  const results = [];
  const observer = await startLiveModelObserver(context, model.providerConfig.endpoint, requestCeiling, {
    requestTimeoutMs: limits.runSeconds * 1000, nativeSourceReadEvidence: true,
    nativeTaskInputBinding: () => active?.inputs,
    beforeForward(metadata) {
      assert.ok(active && Date.now() < active.deadline, 'actual request must belong to its bounded active native run');
      assert.ok(active.requests < limits.requestsPerRun && requests < requestCeiling, 'no implicit paid retries or auxiliary calls');
      const binding = metadata.taskInputBinding;
      const syntaxRepair = binding?.exactMatchCount !== 1;
      if (syntaxRepair) {
        assert.equal(binding?.contextCount, 0);
        assert.equal(binding?.syntaxRepairMessageCount, 1, 'only the explicit native syntax-only repair may omit a repeated task input');
        assert.ok(active.inputSha256 && active.requests >= 2 && active.syntaxRepairs === 0);
        assert.ok(active.inputs.sourceRefs.every((_, index) => [...active.proofs.values()].some(proof => proof.index === index)), 'repair follows complete original source reads');
        assert.equal(metadata.exposedToolNames.length, 0, 'syntax repair cannot expose or repeat any tools');
        active.syntaxRepairs++;
      } else {
        active.inputSha256 ??= binding.inputSha256;
        assert.equal(binding.inputSha256, active.inputSha256, 'each normal request retains the exact original task input');
        assert.ok(metadata.exposedToolNames.includes('AutomationSourceRead'));
      }
      assert.equal(metadata.model, model.model); assert.ok(metadata.bodyBytes <= 96 * 1024);
      assert.ok(Number.isSafeInteger(metadata.outputTokenLimit) && metadata.outputTokenLimit > 0 && metadata.outputTokenLimit <= limits.outputTokens);
      assert.ok(metadata.exposedToolNames.every(name => ['AutomationSourceRead', 'Workflow'].includes(name)), 'only the original finite native automation tools may be exposed');
      for (const proof of metadata.sourceReads ?? []) active.proofs.set(JSON.stringify([proof.index, proof.sha256]), proof);
      active.requests++; requests++;
      return { caseId: active.id, request: requests, runRequest: active.requests, sourceProofCount: active.proofs.size, phase: syntaxRepair ? 'syntax_only_repair' : 'original_input', originalInputSha256: active.inputSha256 };
    },
  });
  const settingsFile = await context.writeStateJson('real-model-config/settings_business_quality.jsonc', {
    active_provider: model.provider,
    providers: { [model.provider]: { ...model.providerConfig, endpoint: observer.endpoint, no_proxy: true } },
    permission_mode: 'ask', allowed_tools: ['read'], tools: { disabled: [] },
    max_tokens: limits.outputTokens, max_retries: limits.retries, max_duration_secs: limits.runSeconds,
    memory: { observer_mode: 'disabled', structured_enabled: false, legacy_prompt_enabled: false },
    session_memory: { enabled: false },
    skills: { auto_skill_review_enabled: false, auto_curator_enabled: false, auto_lessons_learned: false },
    knowledge: { enabled: true }, integrations: { knowledge: { publications_enabled: true, business_automation_enabled: true } },
  }, 0o400);
  const credentials = Object.fromEntries(model.credentialEnv.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const serversFile = await context.writeStateJson('business-servers.json', [{ id: 'business', label: 'Owned native business quality',
    transport: 'local', command: model.kcoderBin, workspace, settingsFile, profile: model.profile }]);
  const gateway = await startGateway(context, { ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}),
    workspace, serversFile, kcoderBin: model.kcoderBin, env: { KCODER_CONFIG_DIR: isolated.configDir,
      // The original scheduler is exercised explicitly. Other automatic model paths stay disabled above.
      KCODER_TRAINING_MODE: 'false', KCODER_MAX_TOKENS: String(limits.outputTokens), KCODER_MAX_RETRIES: '0',
      KCODER_MAX_DURATION_SECS: String(limits.runSeconds), ...credentials } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'business', token));
  context.addCleanup('close native business quality RPC', () => closeRpcAndWait(rpc));
  await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-native-business-quality', version: '1' },
    capabilities: { experimental: { integrationScopeV1: true, knowledgePublicationsV1: true,
      automationTemplatesV1: true, integrationOperationReceiptsV1: true } } });
  const scope = await rpc.request('integrations/scope/read');
  let controlSequence = 0;
  const call = async (domain, method, payload = {}, mutation = false, revision) => {
    const request = { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 15_000, payload,
      ...(mutation ? { operationId: randomUUID() } : {}), ...(revision === undefined ? {} : { expectedRevision: String(revision) }) };
    const reply = await rpc.request(`integrations/${domain}/${method}`, request, 20_000);
    await context.writeArtifactJson(`business-control-${++controlSequence}-${method}.json`, {
      domain, method, requestId: request.requestId, operationId: request.operationId ?? null,
      status: reply.status, errorCode: reply.error?.code ?? null, recovery: reply.error?.recovery ?? null,
      entityRevision: reply.entityRevision ?? null,
      referenceId: payload.publicationId ?? payload.draft?.publicationId ?? payload.runId ?? payload.subscriptionId ?? null,
    });
    assert.equal(reply.requestId, request.requestId);
    assert.ok(reply.status === 'completed' || (method === 'cancelAutomationRun' && reply.status === 'accepted'),
      `${domain}/${method}: ${reply.error?.code ?? 'invalid_reply'}`);
    assert.equal(reply.operationId, mutation ? request.operationId : null);
    assert.equal(reply.error, null); return reply.result;
  };
  // Read the actual fixed definitions before preparing their required source corpus.
  const templates = (await call('automation', 'listTemplates', { locale: 'en' })).templates;
  assert.equal(templates.length, 6);
  const publications = new Map();
  for (const [id, page] of pages) {
    const publication = (await call('knowledge', 'publishKnowledge', { draft: { publicationId: randomUUID(), title: page.title,
      purpose: 'Synthetic immutable source for the protected native business quality suite.', reviewConclusion: null,
      visibility: 'personal', audienceId: null, sources: [{ libraryId: committed.libraryId, pageId: page.pageId, pageRevision: page.pageRevision }],
      validFromMs: null, validUntilMs: null, unresolved: [] } }, true, 0)).publication;
    assert.equal(publication.pages[0].source.pageRevision, page.pageRevision);
    assert.equal(sha(publication.pages[0].markdown), page.markdownSha256);
    await call('knowledge', 'adoptPublication', { owner: publication.owner, publicationId: publication.draft.publicationId, version: publication.version }, true, 0);
    publications.set(id, publication);
  }
  assert.equal(observer.observations.length, 0, 'source creation/publication/adoption cannot call a model');
  const started = Date.now();
  const timer = setTimeout(() => { void context.requestAbort(new Error('Native business suite wall budget exceeded')); rpc.close(); }, limits.suiteSeconds * 1000);
  try {
    for (const task of selectedCases) {
      const template = templates.find(value => value.id === task.id); assert.ok(template);
      assert.equal(template.workflowVersion, 1);
      const sourceRefs = task.pages.map(id => { const value = publications.get(id); return { kind: 'publication', id: value.draft.publicationId, revision: String(value.version) }; });
      active = { id: task.id, deadline: Date.now() + limits.runSeconds * 1000, requests: 0, syntaxRepairs: 0, proofs: new Map(), run: undefined };
      const draft = { id: randomUUID(), title: `Actual live ${task.id}`, workflowId: template.workflowId, workflowVersion: 1,
        inputs: { period: '2026-W43', asOfDate: '2026-10-24', sourceRefs, outputLanguage: 'en',
          requirements: `${task.requirements} Return only one compact JSON object matching the workflow schema, without a preamble or Markdown fences. Keep title under 80 characters, summary under 160 characters, at most eight findings under 160 characters each, and at most three missingInputs under 120 characters each. Retain every required fact. Put opaque identifiers only in sourceRefs; omit envelope metadata and repeated source descriptions from prose.` },
        schedule: { kind: 'at', at: new Date(Date.now() + 3000).toISOString() }, eventSource: null,
        maximumTokens: limits.runTokens, maximumRuntimeSeconds: limits.runSeconds, delivery: { kind: 'studio' } };
      active.inputs = draft.inputs;
      await call('automation', 'previewSubscription', { draft, consentRef: 'explicit-owned-real-model-six-template-quality' });
      const subscription = (await call('automation', 'saveSubscription', { draft, consentRef: 'explicit-owned-real-model-six-template-quality' }, true, 0)).subscription;
      assert.equal(subscription.draft.maximumTokens, limits.runTokens); assert.equal(subscription.enabled, true);
      active.subscription = subscription;
      while (Date.now() < active.deadline) {
        const rows = (await call('automation', 'listAutomationRuns')).page.items.filter(value => value.subscriptionId === subscription.draft.id);
        assert.ok(rows.length <= 1, 'the original explicitly saved one-shot cannot be replayed');
        if (rows.length) {
          active.run = rows[0];
          if (['failed', 'cancelled'].includes(active.run.status)) {
            const operation = await rpc.request('integrations/operation/read', { contractVersion: 'parallel-v1', requestId: randomUUID(), scope,
              timeoutMs: 10_000, payload: { operationId: active.run.nativeOperationId } }).catch(() => undefined);
            const receipt = operation?.result?.receipt, acceptance = receipt?.runtimeAcceptance;
            const workflow = acceptance?.taskId ? await rpc.request('workflow/runs/read', { runId: acceptance.taskId }).catch(() => undefined) : undefined;
            const codes = text => [...new Set(String(text ?? '').match(/\b(?:NATIVE|AUTOMATION|RUNTIME|BUDGET|MODEL)_[A-Z0-9_]{1,100}\b/g) ?? [])].slice(0, 8);
            await context.writeArtifactJson(`business-native-failure-${task.id}.json`, { runId: active.run.id, operationId: active.run.nativeOperationId,
              domainStatus: active.run.status, domainCode: active.run.errorCode, providerRequests: active.requests,
              receiptPhase: receipt?.phase ?? null, acceptance: acceptance ?? null,
              workflow: workflow ? { status: workflow.status, codes: codes(workflow.error),
                errorSummary: context.redactText(String(workflow.error ?? '')).slice(0, 1600),
                nodes: workflow.nodeStates?.map(node => ({ id: node.nodeId, status: node.status, agentId: node.agentId,
                  codes: codes(node.error), errorSummary: context.redactText(String(node.error ?? '')).slice(0, 1600),
                  outputPreview: context.redactText(String(node.outputPreview ?? '')).slice(0, 1600) })) } : null });
            assert.fail(`actual native ${task.id}: ${active.run.status}; code=${active.run.errorCode ?? 'unavailable'}; requests=${active.requests}`);
          }
          if (active.run.status === 'completed') break;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.equal(active.run?.status, 'completed', 'the original native task must actually complete within its time budget');
      const output = businessResult(active.run, task.id);
      let verdict = null, qualityFailure = null;
      try { verdict = validateBusinessResult(task, output, sourceRefs, [...active.proofs.values()], pageHashes); }
      catch (error) { qualityFailure = context.redactText(String(error.message)).slice(0, 1500); }
      // Completed-report factual failures stay failures, while the remaining
      // independent cases still run inside this same original suite budget.
      for (const id of task.pages) {
        const original = publications.get(id), current = (await call('knowledge', 'resolvePublication', {
          owner: original.owner, publicationId: original.draft.publicationId, version: original.version })).publication;
        assert.deepEqual(current.pages.map(page => sha(page.markdown)), original.pages.map(page => sha(page.markdown)), 'original fixed source bodies remain unchanged and currently readable');
      }
      const before = requests;
      const recovered = (await call('automation', 'readAutomationRun', { runId: active.run.id })).run;
      assert.equal(recovered.id, active.run.id); assert.equal(recovered.nativeOperationId, active.run.nativeOperationId);
      assert.equal(recovered.status, 'completed'); assert.equal(requests, before, 'reading the authoritative result cannot restart a model');
      const result = { id: task.id, runId: active.run.id, operationId: active.run.nativeOperationId, nativeThreadId: active.run.nativeThreadId,
        sourceRefs, sourceProofs: [...active.proofs.values()], output, verdict, qualityPassed: qualityFailure === null, qualityFailure, requests: active.requests, elapsedMs: limits.runSeconds * 1000 - (active.deadline - Date.now()) };
      results.push(result); await context.writeArtifactJson(`business-case-${task.id}.json`, result);
      active = undefined;
    }
    assert.equal(results.length, selectedCases.length); assert.ok(requests > 0 && observer.observations.length > 0);
    assert.ok(observer.observations.every(value => value.status === 200 && !value.error));
    assert.ok(results.every(value => value.qualityPassed), `business quality failures: ${results.filter(value => !value.qualityPassed).map(value => value.id).join(', ')}`);
    return { provider: model.provider, model: model.model, limits, corpusSha256: sha(corpusBytes),
      requests, requestCeiling, durationMs: Date.now() - started, cases: results, selectedCasesQualityVerified: true,
      realModelQualityVerified: results.length === 6,
      boundary: 'Owned synthetic personal publications and actual fixed native templates only; no organization, platform delivery, Office bytes or installed-host claim.' };
  } finally {
    clearTimeout(timer);
    const cleanup = { subscriptionDisabled: null, cancelRequested: null, terminalObserved: null };
    if (active?.subscription && active.run?.status !== 'completed') {
      const subscription = active.subscription;
      cleanup.subscriptionDisabled = await call('automation', 'setSubscriptionEnabled',
        { subscriptionId: subscription.draft.id, enabled: false }, true, subscription.revision).then(() => true, () => false);
      if (!active.run) {
        const rows = await call('automation', 'listAutomationRuns').catch(() => undefined);
        const matches = rows?.page?.items?.filter(value => value.subscriptionId === subscription.draft.id) ?? [];
        if (matches.length === 1) active.run = matches[0];
      }
    }
    if (active?.run && !['completed', 'failed', 'cancelled'].includes(active.run.status)) {
      cleanup.cancelRequested = await call('automation', 'cancelAutomationRun', { runId: active.run.id }, true).then(() => true, () => false);
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        const value = await call('automation', 'readAutomationRun', { runId: active.run.id }).catch(() => undefined);
        if (value?.run && ['completed', 'failed', 'cancelled'].includes(value.run.status)) {
          active.run = value.run; cleanup.terminalObserved = value.run.status; break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await context.writeArtifactJson('native-business-live-observations.json', { provider: model.provider, model: model.model,
      limits, corpusSha256: sha(corpusBytes), cases: results, activeCase: active ? { id: active.id, run: active.run, requests: active.requests } : null,
      cleanup, observations: observer.observations, requests, requestCeiling, durationMs: Date.now() - started,
      costKnown: false, usageBoundary: 'Observer reports actual provided usage fields only; the original native budget journal owns reservations and unknown-cost reconciliation.' });
  }
});
