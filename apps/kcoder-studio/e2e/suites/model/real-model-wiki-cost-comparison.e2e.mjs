import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { realModelPreflight, prepareIsolatedRealModelConfig } from '../../harness/real-model.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { prepareWikiCostCorpus, sha256 } from './wiki-cost-corpus.mjs';
import { assertWikiBinaryIdentity, assertWikiWireControls, finiteWikiCaseQueue, finiteWikiWallBudget, pairedWikiProvider, privateWikiReviewCheckpoint, privateWikiReviewNotes, wikiCandidateGates, wikiFactCoverage, wikiOrganizationDiagnostics, wikiOrganizationMetadata, wikiOriginalInput, wikiOwnedSourceBinding, wikiPacketRepairKind, wikiReviewDiagnostics, wikiSupportBindingFacts, wikiWireStage, WIKI_COST_COMPARISON_SPEC as SPEC } from './wiki-cost-budget.mjs';

await runE2E(import.meta.url, {
  testId: 'real-wiki-four-corpus-fixed-model-before-after-cost-quality', tier: 'nightly-credentialed',
  modelPolicy: 'unique FINAL v20 actual old/new Wiki workers; same frozen MiniMax-M3 Anthropic corpus/profiles, explicit 12288 root ceiling and 16384 headroom; 24 upstream calls, 480 seconds including preparation, 10 seconds cleanup reserve, zero provider retries, one sample per arm; stable before/after queue with four case workers; no cross-round wall-throughput comparison; new four-case gate, baseline observations and legacy all-eight gate separate from manual quality',
}, async context => {
  const wallBudget = finiteWikiWallBudget(context.startedAt.getTime(), Date.now, SPEC.wallMs, SPEC.cleanupReserveMs);
  const sourceSnapshots = Object.fromEntries(await Promise.all([
    ['suite', import.meta.url], ['budget', new URL('./wiki-cost-budget.mjs', import.meta.url)],
    ['corpus', new URL('./wiki-cost-corpus.mjs', import.meta.url)],
  ].map(async ([name, url]) => [name, sha256(await readFile(new URL(url)))])));
  const model = await realModelPreflight(SPEC.profile);
  assert.equal(model.model, SPEC.model);
  assert.equal(model.providerConfig.api_format, SPEC.apiFormat);
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const corpus = await prepareWikiCostCorpus(context);
  const sources = corpus.map(({ input, facts, focus, ...sample }) => ({ ...sample, expectedFacts: facts.map(([name]) => name), focus }));
  await context.writeArtifactJson('frozen-corpus.json', sources);
  if (process.env.KCODER_E2E_WIKI_PREPARE_ONLY === '1') return { preparationOnly: true, sources };
  const baselineBin = process.env.KCODER_E2E_WIKI_BASELINE_BIN;
  assert.ok(baselineBin, 'actual compiled old worker is required');
  const versions = [
    { id: 'before', binary: baselineBin, revision: SPEC.beforeRevision },
    { id: 'after', binary: model.kcoderBin, revision: SPEC.afterRevision },
  ];
  for (const version of versions) {
    version.binarySha256 = sha256(await readFile(version.binary));
    assertWikiBinaryIdentity(version.id, version.binarySha256);
  }
  const rows = [], wire = [], failures = [], controllers = new Set(), handlers = new Set();
  const sourceOwners = new Map();
  let upstreamCalls = 0, started = null;
  const wallMs = SPEC.wallMs;
  const remaining = wallBudget.remaining;
  const evidencePath = context.pathInArtifacts('comparison-evidence.json');
  const partialPath = context.pathInArtifacts('partial-comparison.json');
  context.addCleanup('retain all bounded comparison attempts', () => writeFile(evidencePath, JSON.stringify(context.redactValue({
    auditId: SPEC.auditId, sourceSnapshots, profile: model.profile, model: model.model, apiFormat: model.providerConfig.api_format,
    versions: versions.map(({ id, revision, binarySha256 }) => ({ id, revision, binarySha256 })), sources,
    fixedControls: { reasoningEffort: 'none', contextWindow: model.providerConfig.context_window_tokens,
      outputCeiling: SPEC.outputCeiling, outputHeadroom: SPEC.outputHeadroom,
      providerRetries: SPEC.providerRetries, callCeiling: SPEC.callCeiling, wallCeilingMs: wallMs,
      cleanupReserveMs: wallBudget.cleanupReserveMs,
      scheduling: 'stable paper-before/paper-after/chinese-before/chinese-after/table-before/table-after/html-before/html-after queue; at most four concurrent case workers, two independent versions; changed from prior one-pair scheduling, no cross-round wall-throughput comparison', sampleCountPerArm: 1 },
    upstreamCalls, wallMs: wallBudget.elapsed(), modelWindowMs: started === null ? 0 : Date.now() - started,
    rows, wire, relayFailures: failures,
  }), null, 2), { mode: 0o600 }));
  const relay = createServer((request, response) => {
    if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    response.once('close', () => controller.abort());
    const handler = (async () => {
      let bytes = 0; const pieces = [];
      for await (const piece of request) { bytes += piece.length; assert.ok(bytes <= 196608, 'finite input wire bytes'); pieces.push(piece); }
      const bodyBytes = Buffer.concat(pieces), body = JSON.parse(bodyBytes);
      const user = body.messages.findLast(item => item.role === 'user');
      const text = typeof user.content === 'string' ? user.content : user.content.map(item => item.text || '').join('');
      const value = JSON.parse(text), original = wikiOriginalInput(value);
      const stage = wikiWireStage(value);
      const arm = request.url.split('/')[1];
      const binding=wikiOwnedSourceBinding(value),packetKind=wikiPacketRepairKind(value);
      const owner = sourceOwners.get(`${arm}/${binding.sourceId}`);
      assert.ok(owner, 'every real call belongs to a frozen case');
      if(binding.libraryId!==null) assert.equal(binding.libraryId,owner.library.id,'actual packet binds owned library');
      if(binding.revisionId!==null) assert.equal(binding.revisionId,owner.imported.revisionId,'actual packet binds immutable owned revision');
      assertWikiWireControls(body);
      assert.ok(remaining() > 0 && upstreamCalls < SPEC.callCeiling, 'total actual upstream budget');
      upstreamCalls++;
      const entry = { arm, corpus: owner.sample.id, index: upstreamCalls, stage, completionAllowance: body.max_tokens, unit: 'tokens', requestBytes: bytes, startedMs: Date.now() - started };
      const offeredInventory=original.sourceInventory ?? original.organizationInventory ?? owner.offeredOrganizationInventory;
      if (offeredInventory) owner.offeredOrganizationInventory=offeredInventory;
      entry.offeredOrganizationInventory=wikiOrganizationDiagnostics({},offeredInventory).offeredInventory;
      if (stage === 'source_support') {
        entry.supportBindings = wikiSupportBindingFacts(original);
        entry.canonicalOrganizationDiagnosis=wikiOrganizationDiagnostics(original.candidate ?? {},offeredInventory,'actual_support_request');
        owner.supportCandidate = original.candidate;
      }
      if (stage === 'generation' || stage === 'organization_repair') {
        entry.organizationInput = wikiOrganizationMetadata(original.analysis ?? original);
        entry.citationSpanCount = Array.isArray(original.citationSpans) ? original.citationSpans.length : null;
      }
      const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map(item => item.text ?? '').join('');
      if(packetKind) entry.repairKind=packetKind;
      else if (stage === 'format_repair') entry.repairKind = system.includes('Repair only Wiki analysis queries.') ? 'analysis_queries' : 'format_or_candidate';
      if(packetKind==='organization_proof') entry.proofRepairInputDiagnosis=wikiOrganizationDiagnostics({organizationProof:original.previousProof},offeredInventory,'actual_support_request',original.pageLineBindings);
      if (stage === 'generation' && owner.analysisIdentity) entry.analysisRetained = {
        summary: sha256(original.analysis.summary) === owner.analysisIdentity.summary,
        conflicts: sha256(JSON.stringify(original.analysis.conflicts ?? [])) === owner.analysisIdentity.conflicts,
        organizationPlanWireExactlyMatches:isDeepStrictEqual(original.analysis.organizationPlan ?? null,owner.analysisIdentity.organizationPlan ?? null),
        organizationPlanUnitDecisionsRetained:isDeepStrictEqual(original.analysis.organizationPlan?.units ?? null,owner.analysisIdentity.organizationPlan?.units ?? null),
        modelSuppliedInverseAspects:!!owner.analysisIdentity.organizationPlan&&Object.hasOwn(owner.analysisIdentity.organizationPlan,'aspects'),
        canonicalInverseAspectCount:original.analysis.organizationPlan?.aspects?.length ?? null,
      };
      entry.thinkingMode = body.thinking?.type ?? 'omitted';
      entry.thinkingAllowance = body.thinking?.budget_tokens ?? 0;
      wire.push(entry);
      const target = new URL(model.providerConfig.endpoint);
      target.pathname = target.pathname.replace(/\/$/, '').replace(/\/v1\/messages$/, '') + '/v1/messages';
      const headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
      const begin = Date.now();
      const upstream = await fetch(target, { method: 'POST', headers, body: bodyBytes, redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(90000, remaining()))]) });
      entry.httpStatus = upstream.status;
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream' });
      let pending = '', generated = ''; const decoder = new StringDecoder('utf8');
      const consume = line => {
        if (!line.startsWith('data: ')) return;
        let event; try { event = JSON.parse(line.slice(6)); } catch { return; }
        const usage = event.message?.usage ?? event.usage;
        if (event.type === 'message_delta' && event.usage) entry.finalUsageReported = true;
        if (usage) {
          entry.usage ??= {};
          for (const [key, field] of [['inputUnits','input_tokens'],['outputUnits','output_tokens'],['cacheReadUnits','cache_read_input_tokens'],['cacheWriteUnits','cache_creation_input_tokens']]) {
            if (typeof usage[field] === 'number') entry.usage[key] = usage[field];
          }
        }
        if (event.delta?.type === 'text_delta' || event.content_block?.type === 'text') {
          const delta = event.delta?.text ?? event.content_block?.text ?? '';
          if (delta && entry.firstTextMs === undefined) entry.firstTextMs = Date.now() - begin;
          generated += delta;
        }
        if (event.delta?.stop_reason) entry.stopReason = event.delta.stop_reason;
        // Observe candidate in memory before message_stop is forwarded: client EOF
        // must not discard either final usage or the candidate awaiting review.
        if (event.type === 'message_stop') {
          try { const proposal = JSON.parse(generated.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
            if (stage === 'source_support') {
              const counts = { supported:0, unsupported:0, uncertain:0 };
              for (const unit of proposal.units ?? []) if (Object.hasOwn(counts,unit.verdict)) counts[unit.verdict]++;
              entry.supportAssessment = { sourceCoverage: ['complete','incomplete','uncertain'].includes(proposal.sourceCoverage) ? proposal.sourceCoverage : 'invalid',
                unitCount: proposal.units?.length, verdictCounts: counts,
                organizationUnitCount:proposal.organizationUnits?.length,
                organizationVerdicts: (proposal.organizationUnits ?? []).reduce((total,unit) => { if(Object.hasOwn(total,unit.verdict)) total[unit.verdict]++; return total; },{supported:0,unsupported:0,uncertain:0}) };
            } else if(packetKind==='organization_plan'||packetKind==='organization_proof') {
              entry.metadataOnlyResponse=true;
              entry.organizationDiagnosis=wikiOrganizationDiagnostics(proposal,owner.offeredOrganizationInventory,'model_response',packetKind==='organization_proof'?original.pageLineBindings:null);
              entry.organizationOutput=wikiOrganizationMetadata(proposal);
              if(packetKind==='organization_plan'&&owner.analysisIdentity) owner.analysisIdentity.organizationPlan=proposal.organizationPlan;
            } else if (Array.isArray(proposal.pages)) {
              owner.proposal = proposal;
              entry.organizationDiagnosis=wikiOrganizationDiagnostics(proposal,owner.offeredOrganizationInventory,'model_response');
              entry.organizationOutput = wikiOrganizationMetadata(proposal);
              entry.candidateBounds = { pageCount: proposal.pages.length,
                markdownCharacters: proposal.pages.map(page => typeof page.markdown === 'string' ? [...page.markdown].length : null),
                totalCitations: proposal.pages.reduce((sum, page) => sum + (page.citations?.length ?? 0), 0) };
            } else {
              entry.organizationDiagnosis=wikiOrganizationDiagnostics(proposal,owner.offeredOrganizationInventory,'model_response');
              entry.analysisBounds = { summaryBytes: Buffer.byteLength(proposal.summary ?? ''), queryCount: proposal.queries?.length,
                maxQueryBytes: Math.max(0, ...(proposal.queries ?? []).map(query => Buffer.byteLength(query))), conflictCount: proposal.conflicts?.length,
                queriesOnly: Object.keys(proposal).length === 1 && Array.isArray(proposal.queries) };
              entry.organizationOutput = wikiOrganizationMetadata(proposal);
              if (typeof proposal.summary === 'string' && (stage === 'analysis'
                || (stage === 'format_repair' && !['analysis_queries','organization_plan'].includes(entry.repairKind) && !original.analysis))) owner.analysisIdentity = {
                summary: sha256(proposal.summary), conflicts: sha256(JSON.stringify(proposal.conflicts ?? [])), organizationPlan:proposal.organizationPlan,
              };
            }
          } catch { entry.candidateParsed = false; }
        }
      };
      try {
        for await (const chunk of upstream.body) {
          pending += decoder.write(Buffer.from(chunk));
          const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(consume);
          if (!response.destroyed) response.write(chunk);
        }
        pending += decoder.end(); if (pending) consume(pending);
        if (!response.destroyed) response.end();
      } finally {
        entry.durationMs = Date.now() - begin;
        if (!entry.finalUsageReported && entry.usage) {
          delete entry.usage.inputUnits; delete entry.usage.outputUnits;
        }
      }
    })().catch(error => {
      failures.push({ arm: request.url.split('/')[1], type: error.name, code: error.cause?.code });
      if (!response.destroyed) { if (!response.headersSent) response.writeHead(502); response.end('Finite real-model comparison failed'); }
    }).finally(() => controllers.delete(controller));
    handlers.add(handler); void handler.finally(() => handlers.delete(handler));
  });
  await new Promise(done => relay.listen(0, '127.0.0.1', done));
  const port = relay.address().port; context.registerPort('bounded-paired-model-relay', port);
  context.addCleanup('close paired relay and in-flight upstream calls', async () => {
    for (const controller of controllers) controller.abort();
    const close = new Promise(done => relay.close(done)); relay.closeAllConnections();
    await Promise.allSettled([...handlers]); await close;
  });
  const serverConfigs = [];
  await context.writeStateJson('real-model-config/settings.json', { knowledge: { enabled: true } });
  for (const version of versions) {
    if (version.id === 'before') await mkdir(context.pathInState('before-isolation'), { mode: 0o700 });
    const armIsolation = version.id === 'after' ? isolated : await prepareIsolatedRealModelConfig({
      pathInState: (...parts) => context.pathInState('before-isolation', ...parts),
      writeStateJson: (name, ...args) => context.writeStateJson(`before-isolation/${name}`, ...args),
      registerSecret: secret => context.registerSecret(secret),
    }, model);
    if (version.id === 'before') await context.writeStateJson('before-isolation/real-model-config/settings.json', { knowledge: { enabled: true } });
    version.configDir = armIsolation.configDir;
    const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: `paired-wiki-${version.id}` });
    const provider = pairedWikiProvider(model.providerConfig, `http://127.0.0.1:${port}/${version.id}`);
    const settingsFile = await context.writeStateJson(`real-model-config/paired-${version.id}.json`, {
      active_provider: model.provider, providers: { [model.provider]: provider },
      max_retries: SPEC.providerRetries, max_tokens: SPEC.outputCeiling,
      model_reasoning_effort: SPEC.reasoningEffort, tools: { disabled: ['*'] }, knowledge: { enabled: true },
    }, 0o400);
    serverConfigs.push({ id: version.id, label: `Frozen ${version.id} worker`, transport: 'local', command: version.binary, workspace, settingsFile });
  }
  for (const version of versions) {
    const serverConfig = serverConfigs.find(server => server.id === version.id);
    const serversFile = await context.writeStateJson(`servers-${version.id}.json`, [serverConfig]);
    const gateway = await startGateway(context, { label: `gateway-${version.id}`, workspace: serverConfig.workspace, serversFile, kcoderBin: version.binary,
      env: { KCODER_CONFIG_DIR: version.configDir }, passEnv: model.credentialEnv });
    const access = await waitForGatewayRpcToken(context, gateway);
    version.rpc = await openRpc(gatewayRpcUrl(gateway, version.id, access));
    context.addCleanup(`close ${version.id} comparison RPC`, () => version.rpc.close());
    await initializeRpc(version.rpc, `wiki-paired-${version.id}`);
  }
  const prepared = new Map();
  for (const sample of corpus) for (const version of versions) {
    const rpc = version.rpc;
    const purpose = `根据当前来源整理一篇简洁事实主题页和来源摘要及短导航，避免重复，不补充外部知识。${sample.focus}`;
    const library = await rpc.request('knowledge/create', { idempotencyKey: `${sample.id}-library`, name: `Frozen ${sample.id}`, purpose });
    let imported;
    if (sample.id === 'html') {
      const upload = await rpc.request('attachment/upload/start', { filename: 'iana-example-domains.html', size: sample.input.length });
      await rpc.request('attachment/upload/chunk', { upload_id: upload.upload_id, index: 0, content_base64: sample.input.toString('base64') });
      const attachment = await rpc.request('attachment/upload/finish', { upload_id: upload.upload_id });
      imported = await rpc.request('knowledge/source/importAttachment', { libraryId: library.id, idempotencyKey: 'frozen-source', title: 'IANA Example Domains.html', attachmentPath: attachment.path });
    } else imported = await rpc.request('knowledge/source/importText', { libraryId: library.id, idempotencyKey: 'frozen-source', title: `Frozen ${sample.format}`, text: sample.input.toString('utf8') });
    const chunks = await rpc.request('knowledge/source/read', { libraryId: library.id, sourceId: imported.sourceId, revisionId: imported.revisionId, limit: 16 });
    const sourceText = chunks.items.map(chunk => chunk.text).join('\n');
    const owner = { sample, sourceText, library, imported, version };
    prepared.set(`${version.id}/${sample.id}`, owner);
    sourceOwners.set(`${version.id}/${imported.sourceId}`, owner);
  }
  for (const sample of corpus) {
    const sourceText=prepared.get(`before/${sample.id}`).sourceText;
    assert.equal(sha256(sourceText), sha256(prepared.get(`after/${sample.id}`).sourceText), 'actual extracted source input is paired exactly');
    assert.ok(Buffer.byteLength(sourceText)<=24000,'bounded frozen public extracted source');
    const exactPublic={
      corpus:sample.id,origin:sample.origin,selection:sample.selection,originalSha256:sample.originalSha256,
      selectedInputSha256:sample.inputSha256,extractedTextSha256:sha256(sourceText),extractedTextBytes:Buffer.byteLength(sourceText),
      focus:sample.focus,expectedFacts:sample.facts.map(([name])=>name),extractedText:sourceText,shaVerified:true,
    };
    // Public fixed corpus is explicitly authorized. Avoid auth-log regexes
    // rewriting ordinary Basic-language fragments in an exact source artifact.
    await writeFile(context.pathInArtifacts(`public-exact-extracted-${sample.id}.json`),JSON.stringify(exactPublic,null,2),{flag:'wx',mode:0o600});
  }
  started = Date.now();
  const execute = async (owner) => {
    const { version, sample, library, imported, sourceText } = owner, rpc = version.rpc;
    const begin = Date.now();
    const row = { arm: version.id, corpus: sample.id, sourceTextSha256: sha256(sourceText), sourceTextBytes: Buffer.byteLength(sourceText), terminalStatus: null };
    rows.push(row);
    try {
      if(remaining()<=0) {row.terminalStatus='wall_budget_not_dispatched';return;}
      const job = await rpc.request('knowledge/job/start', { libraryId: library.id, sourceId: imported.sourceId, revisionId: imported.revisionId, idempotencyKey: 'only-fixed-attempt', language: 'zh-CN' });
      row.recipeKey = job.recipeKey;
      const identity = { libraryId: library.id, jobId: job.id };
      while (remaining() > 0) {
        const current = await rpc.request('knowledge/job/get', identity, Math.min(30000, Math.max(1000, remaining())));
        if (current.progress && row.firstStageFeedbackMs === undefined) row.firstStageFeedbackMs = Date.now() - begin;
        if (current.progress) {
          row.lastObservedPhase = current.progress.phase;
          row.reasoningBytesObserved = Math.max(row.reasoningBytesObserved ?? 0, current.progress.reasoningBytes ?? 0);
        }
        if (['completed','awaiting_review','failed','paused','cancelled'].includes(current.status)) {
          row.terminalStatus = current.status; row.errorCode = current.errorCode ?? null;
          try {
            const diagnostic = JSON.parse(current.errorDetail);
            if (['candidate_validation','analysis_validation','support_validation','organization_validation','organization_repair','source_support','analysis','generation','format_repair','citation_repair'].includes(diagnostic.stage)
              && /^wiki_(?:candidate|analysis|json|support|evidence|organization)_[a-z_]+$/.test(diagnostic.errorType)
              && typeof diagnostic.field === 'string' && diagnostic.field.startsWith('/') && diagnostic.field.length <= 256) {
              row.validationDiagnostic = { stage: diagnostic.stage, errorType: diagnostic.errorType, field: diagnostic.field };
            }
          } catch { /* Only typed, domain-authored field metadata is retained. */ }
          break;
        }
        await new Promise(done => setTimeout(done, 200));
      }
      if (row.terminalStatus === null) { await rpc.request('knowledge/job/pause', identity); row.terminalStatus = 'wall_budget_paused'; }
      const budget = await rpc.request('knowledge/job/budget', identity);
      row.domainUsage = { reservedCalls: budget.reservedCalls, completedCalls: budget.completedCalls, usageReportedCalls: budget.usageReportedCalls, inputUnits: budget.inputTokens, outputUnits: budget.outputTokens, unit: 'tokens' };
      const pages = await rpc.request('knowledge/page/list', { libraryId: library.id }); row.publishedPages = pages.items.length;
      let drafts = [], actualReviewNotes = null;
      if (row.terminalStatus === 'awaiting_review') {
        const review = await rpc.request('knowledge/review/read', identity); context.registerSecret(review.token);
        row.reviewPages = review.pages.length; row.reviewNotes = review.notes.length;
        row.reviewDiagnostics = wikiReviewDiagnostics(review.notes);
        row.reviewDiagnosticOrigin = 'literal static code/field in actual private review notes';
        row.reviewReasons = { support:review.notes.filter(note => note.startsWith('Source support requires review:')).length,
          coverage:review.notes.filter(note => note.startsWith('Source coverage requires review:')).length,
          organization:review.notes.filter(note => note.startsWith('Organization requires review:')).length,
          other:review.notes.filter(note => !note.startsWith('Source support requires review:') && !note.startsWith('Source coverage requires review:') && !note.startsWith('Organization requires review:')).length };
        assert.equal(pages.items.length, 0, 'review-required candidate remains unpublished');
        const database = new DatabaseSync(resolve(version.configDir,'knowledge/state.sqlite'), { readOnly:true });
        try { const retained=privateWikiReviewCheckpoint(database,library.id,job.id).proposal;
          actualReviewNotes=privateWikiReviewNotes(retained,review.notes);
          drafts=retained.pages; row.organizationMetadata=wikiOrganizationMetadata(retained); row.organizationMetadataOrigin='actual private checkpoint';
          row.organizationDiagnosis=wikiOrganizationDiagnostics(retained,owner.offeredOrganizationInventory,'private_checkpoint'); }
        finally { database.close(); }
        row.reviewCheckpointRead = true;
        assert.equal(drafts.length,review.pages.length,'all retained candidate pages are evaluated');
        for (const draft of drafts) {
          assert.ok(review.pages.some(page => page.pageId === draft.pageId), 'observed candidate belongs to retained review');
          const excerpt = await rpc.request('knowledge/review/page', { ...identity, token: review.token, pageId: draft.pageId, offset: 0 });
          assert.equal(excerpt.proposed, [...draft.markdown].slice(0, 16384).join(''), 'quality prose is retained in exact unapproved checkpoint');
        }
        row.privateReviewArtifact=`private-review-${version.id}-${sample.id}.json`;
        const privateReview={
          arm:version.id,corpus:sample.id,recipeKey:row.recipeKey,sourceTextSha256:row.sourceTextSha256,
          origin:'actual owned awaiting_review checkpoint, RPC notes and page bodies verified',status:'awaiting_review',
          actualReviewNotes,topicPages:drafts.filter(page=>['concept','entity','synthesis','query'].includes(page.kind))
            .map(page=>({kind:page.kind,title:page.title,prose:page.markdown})),
        };
        // Exact bounded notes/prose from the owned checkpoint; no credentials,
        // headers, token or raw provider response is included in this private file.
        await writeFile(context.pathInArtifacts(row.privateReviewArtifact),JSON.stringify(privateReview,null,2),{flag:'wx',mode:0o600});
      } else if (row.terminalStatus === 'completed') drafts = await Promise.all(pages.items.map(async page => (await rpc.request('knowledge/page/read', { libraryId: library.id, pageId: page.pageId })).draft));
      if (!row.organizationMetadata && drafts.length) {
        row.organizationMetadata=wikiOrganizationMetadata(owner.supportCandidate ?? owner.proposal ?? {});
        row.organizationMetadataOrigin=owner.supportCandidate ? 'actual source_support request candidate' : 'observed model proposal; no host validation inferred';
        row.organizationDiagnosis=wikiOrganizationDiagnostics(owner.supportCandidate ?? owner.proposal ?? {},owner.offeredOrganizationInventory,
          owner.supportCandidate ? 'actual_support_request' : 'observed_model_proposal');
      }
      row.validCandidate = drafts.length > 0 && ['completed','awaiting_review'].includes(row.terminalStatus);
      row.exactCitations = 0; row.invalidCitations = 0;
      for (const draft of drafts) for (const citation of draft.citations ?? []) {
        try {
          const resolved = await rpc.request('knowledge/citation/resolve', { libraryId: library.id, sourceId: citation.sourceId, revisionId: citation.revisionId, chunkId: citation.chunkId });
          if (resolved.chunk.text.includes(citation.quote) && sourceText.includes(citation.quote)) row.exactCitations++;
          else row.invalidCitations++;
        } catch { row.invalidCitations++; }
      }
      row.factCoverage = wikiFactCoverage(drafts,sample.facts);
      row.topicFactCoverage = wikiFactCoverage(drafts,sample.facts,true);
      row.topicPageCount = drafts.filter(page => ['concept','entity','synthesis','query'].includes(page.kind)).length;
      row.extractiveSourcePages = drafts.filter(page => page.kind === 'source' && page.markdown === sourceText).length;
      // Public corpus only. Retain candidate prose, remove runtime identities and
      // citations; no complete provider response, raw source, headers or review token.
      row.safeCandidateSummaries = drafts.map(page => page.kind === 'source' && page.markdown === sourceText
        ? { kind:page.kind, title:page.title, extractiveSource:true, sourceBodySha256:sha256(page.markdown), sourceBytes:Buffer.byteLength(page.markdown) }
        : { kind: page.kind, title: page.title, prose: page.markdown.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, '[page]').slice(0, 24000) });
    } catch (error) { row.failureType = error.name; row.terminalStatus ??= 'execution_failed'; }
    finally {
      row.durationMs = Date.now() - begin;
      const calls = wire.filter(item => item.arm === version.id && item.corpus === sample.id);
      row.upstreamCalls = calls.length;
      row.repairs = calls.filter(item => item.stage.endsWith('repair')).length;
      row.sourceSupportChecks = calls.filter(item => item.stage === 'source_support').length;
      row.organizationComplements = calls.filter(item => item.stage === 'organization_repair').length;
      row.organizationPlanRepairs=calls.filter(item=>item.repairKind==='organization_plan').length;
      row.organizationProofRepairs=calls.filter(item=>item.repairKind==='organization_proof').length;
      row.truncationStops = calls.filter(item => item.stopReason === 'max_tokens').length;
      row.firstProviderTextMs = calls.length && calls[0].firstTextMs !== undefined ? calls[0].startedMs - (begin - started) + calls[0].firstTextMs : null;
      await writeFile(partialPath, JSON.stringify(context.redactValue({ rows, wire, upstreamCalls }), null, 2), { mode: 0o600 });
    }
  };
  await finiteWikiCaseQueue(corpus.flatMap(sample=>versions.map(version=>prepared.get(`${version.id}/${sample.id}`))),execute,4);
  assert.equal(rows.length, 8, 'all four frozen samples retained in both arms');
  assert.ok(upstreamCalls <= SPEC.callCeiling);
  assert.ok(wallBudget.elapsed() <= wallMs - wallBudget.cleanupReserveMs + 2000, 'whole run clock reserves bounded cleanup');
  // Product failure is evidence, never silently converted into a passed quality gate.
  return { comparisonExecuted: true, ...wikiCandidateGates(rows), upstreamCalls, samples: rows.length,
    published: rows.filter(row => row.terminalStatus === 'completed').length, awaitingReview: rows.filter(row => row.terminalStatus === 'awaiting_review').length,
    qualityAcceptanceRequiresRecordedFactAndEntailmentReview: true };
});
