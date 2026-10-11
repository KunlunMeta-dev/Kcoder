import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { realModelPreflight, prepareIsolatedRealModelConfig } from '../../harness/real-model.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// Real Provider calls only. This relay observes public quota fields and stage
// boundaries in memory; it never persists request bodies or authorization.
await runE2E(import.meta.url, {
  testId: 'real-model-wiki-stage-cache-citations-and-finite-wire-budget', tier: 'nightly-credentialed',
  modelPolicy: 'approved real provider; at most 6 upstream calls, 6144 output tokens each, 64 KiB request each, 240 seconds total; retries disabled',
  retainSuccessLogs: true,
}, async context => {
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  const isolated = await prepareIsolatedRealModelConfig(context, model);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'real-wiki' });
  const sourcePath = 'docs/kcoder-wiki-validation-2026-09-29.md';
  const wholeSource = await readFile(resolve(repoRoot, sourcePath), 'utf8');
  const source = wholeSource.slice(0, wholeSource.indexOf('- 导出原先'));
  assert.ok(Buffer.byteLength(source) > 400 && Buffer.byteLength(source) < 6000);
  const started = Date.now(), wallLimitMs = 240000;
  const upstream = new URL(model.providerConfig.endpoint);
  let calls = 0, heldGeneration = false, releaseGeneration = false, lastGeneratedProposal = null;
  const stages = [], quotas = [], relayFailures = [], aborts = new Set(), handlers = new Set();
  let lastJob = null, receivedRequests = 0;
  const quotaEvidencePath = context.pathInArtifacts('real-model-quota-facts.json');
  context.addCleanup('retain safe real-model quota facts', () => writeFile(quotaEvidencePath, JSON.stringify({
    upstreamCalls: calls, receivedRequests, stages, quotas, relayFailures,
    jobStatus: lastJob?.status, jobErrorCode: lastJob?.errorCode, progress: lastJob?.progress,
  }), { mode: 0o600 }));
  const relay = createServer((request, response) => {
    if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    const controller = new AbortController();
    aborts.add(controller);
    response.once('close', () => controller.abort());
    const handler = (async () => {
      receivedRequests++;
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw Error('Finite real-model request byte budget exceeded'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const requested = body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens;
      assert.ok(Number.isInteger(requested) && requested > 0 && requested <= 6144, 'actual wire output budget');
      const messages = body.messages ?? body.input ?? [];
      const user = messages.findLast(item => item.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : user?.content?.map(item => item.text || '').join('');
      let stage = 'format_repair';
      let originalInput;
      try { const value = JSON.parse(text); originalInput = value.originalInput ?? value;
        stage = value.previousResponse !== undefined ? 'format_repair'
          : value.validationErrors !== undefined ? 'citation_repair' : value.analysis ? 'generation' : 'analysis';
      } catch { /* Repair prompts are bounded plain text. */ }
      if (stage === 'generation' && !releaseGeneration) {
        heldGeneration = true;
        await new Promise(done => controller.signal.addEventListener('abort', done, { once: true }));
        return;
      }
      if (++calls > 6 || Date.now() - started >= wallLimitMs) throw Error('Finite real-model call/wall budget exceeded');
      const target = new URL(upstream);
      const base = upstream.pathname.replace(/\/$/, '');
      const suffix = model.providerConfig.api_format === 'anthropic_messages' ? '/v1/messages'
        : model.providerConfig.api_format === 'openai_responses' ? '/responses' : '/chat/completions';
      target.pathname = base.endsWith(suffix) ? base : base + suffix;
      const headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
      stages.push(stage); quotas.push({ stage, maxOutputTokens: requested, requestBytes: bytes });
      const result = await fetch(target, { method: request.method, headers, body: Buffer.concat(chunks), redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(60000, wallLimitMs - (Date.now() - started)))]) });
      quotas.at(-1).httpStatus = result.status;
      response.writeHead(result.status, { 'content-type': result.headers.get('content-type') || 'text/event-stream' });
      const responseChunks = [];
      const rememberBounds = () => {
        let generated = '';
        for (const line of Buffer.concat(responseChunks).toString('utf8').split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try { const event = JSON.parse(line.slice(6)); generated += event.delta?.text ?? event.content_block?.text ?? event.choices?.[0]?.delta?.content ?? ''; } catch { /* SSE terminal marker. */ }
        }
        try {
          const value = JSON.parse(generated.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
          delete quotas.at(-1).analysisJsonParsed;
          if (!Array.isArray(value.pages)) quotas.at(-1).analysisBounds = { summaryBytes: Buffer.byteLength(value.summary || ''), queryCount: value.queries?.length,
            maxQueryBytes: Math.max(0, ...(value.queries || []).map(item => Buffer.byteLength(item))), conflictCount: value.conflicts?.length,
            maxConflictBytes: Math.max(0, ...(value.conflicts || []).map(item => Buffer.byteLength(item))) };
          else {
            lastGeneratedProposal = value;
            const pages = value.pages || [], offered = new Set(originalInput.newPageIds || []);
            const existing = new Set((originalInput.existingPages || []).map(item=>item.draft?.pageId));
            quotas.at(-1).generationBounds = { pageCount:pages.length,
              duplicateIdentities:pages.length-new Set(pages.map(page=>page.pageId)).size,
              unallocatedIdentities:pages.filter(page=>!offered.has(page.pageId)&&!existing.has(page.pageId)).length,
              unreservedOverview:pages.filter(page=>(page.kind==='overview')!==(page.pageId===originalInput.overviewPageId)).length,
              invalidNewBaseRevision:pages.filter(page=>offered.has(page.pageId)&&page.expectedRevision!==null).length,
              oversizedPages:pages.filter(page=>Buffer.byteLength(page.title||'')>1024||Buffer.byteLength(page.markdown||'')>1048576||(page.citations||[]).length>128||(page.relatedPageIds||[]).length>64).length,
              reviewNotesCount:value.reviewNotes?.length };
          }
        } catch { quotas.at(-1).analysisJsonParsed = false; }
      };
      for await (const chunk of result.body) {
        if (response.destroyed) return;
        responseChunks.push(Buffer.from(chunk));
        // Capture only aggregate bounds before forwarding a completed JSON
        // delta: the real client may close immediately after message_stop.
        rememberBounds(); response.write(chunk);
      }
      response.end();
    })().catch(error => { relayFailures.push({ type: error.name, code: error.cause?.code }); if (!response.destroyed) { if (!response.headersSent) response.writeHead(502); response.end('Real-model quota/transport failed'); } })
      .finally(() => aborts.delete(controller));
    handlers.add(handler); void handler.finally(() => handlers.delete(handler));
  });
  await new Promise(done => relay.listen(0, '127.0.0.1', done));
  const port = relay.address().port;
  context.registerPort('bounded-real-model-relay', port);
  context.addCleanup('close bounded real-model relay', async () => {
    for (const controller of aborts) controller.abort();
    const closing = new Promise(done => relay.close(done)); relay.closeAllConnections();
    await Promise.allSettled([...handlers]); await closing;
  });
  const provider = { ...model.providerConfig, endpoint: `http://127.0.0.1:${port}${model.providerConfig.api_format === 'anthropic_messages' ? '' : '/v1'}`, no_proxy: true,
    max_output_tokens: 6144, output_headroom_tokens: 8192, request_timeout_secs: 65 };
  // The owned public overlay fixes the test quota; the approved profile is never
  // edited and credentials remain resolved through the read-only owned symlink.
  delete provider.extra_body;
  const settingsFile = await context.writeStateJson('real-model-config/bounded-wiki.json', {
    active_provider: model.provider, providers: { [model.provider]: provider }, max_retries: 0, max_tokens: 6144,
    tools: { disabled: ['*'] }, knowledge: { enabled: true,
      organization_model: `${model.provider}::${model.model}`, organization_reasoning_effort: 'none' },
  }, 0o400);
  await context.writeStateJson('real-model-config/settings.json', { knowledge: { enabled: true,
    organization_model: `${model.provider}::${model.model}`, organization_reasoning_effort: 'none' } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Bounded real Wiki', transport: 'local',
    command: model.kcoderBin, workspace, settingsFile }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: model.kcoderBin,
    env: { KCODER_CONFIG_DIR: isolated.configDir }, passEnv: model.credentialEnv });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
  context.addCleanup('close bounded real Wiki RPC', () => rpc.close());
  await initializeRpc(rpc, 'real-model-wiki-stage-budget');
  const library = await rpc.request('knowledge/create', { idempotencyKey: 'real-corpus-library', name: 'Real Wiki audit corpus', purpose: 'Use the source as evidence for one concise concept page and a short navigation overview. Avoid repetitive pages; preserve exact source citations.' });
  const imported = await rpc.request('knowledge/source/importText', { libraryId: library.id, idempotencyKey: 'real-document', title: sourcePath, text: source });
  const job = await rpc.request('knowledge/job/start', { libraryId: library.id, sourceId: imported.sourceId,
    revisionId: imported.revisionId, idempotencyKey: 'finite-real-organization', language: 'zh-CN' });
  const identity = { libraryId: library.id, jobId: job.id };
  await waitFor(async () => {
    lastJob = await rpc.request('knowledge/job/get', identity);
    if (['failed','paused','awaiting_review'].includes(lastJob.status)) throw Error(`Real analysis stopped: ${lastJob.status}/${lastJob.errorCode}`);
    return heldGeneration;
  }, Math.max(1000, wallLimitMs - (Date.now() - started)), 'real analysis completed before held generation', 200, context.abortSignal);
  assert.equal(stages.filter(stage=>stage==='analysis').length,1);
  assert.ok(stages.every(stage=>stage==='analysis'||stage==='format_repair'), 'only bounded analysis/format repair precedes held generation');
  await rpc.request('knowledge/job/pause', identity);
  assert.equal((await rpc.request('knowledge/job/get', identity)).status, 'paused');
  releaseGeneration = true;
  await rpc.request('knowledge/job/resume', identity);
  const finished = await waitFor(async () => {
    const current = await rpc.request('knowledge/job/get', identity);
    lastJob = current;
    if (current.status === 'failed') throw Error(`Real Wiki failed: ${current.errorCode}`);
    return ['completed', 'awaiting_review'].includes(current.status) ? current : null;
  }, Math.max(1000, wallLimitMs - (Date.now() - started)), 'bounded real Wiki terminal status', 200, context.abortSignal);
  assert.equal(stages.filter(stage => stage === 'analysis').length, 1, 'persisted analysis cache must prevent another real analysis request');
  const budget = await rpc.request('knowledge/job/budget', identity);
  assert.ok(budget.reservedCalls >= calls && calls <= 6);
  assert.ok(budget.outputTokens <= calls * 6144);
  const pages = await rpc.request('knowledge/page/list', { libraryId: library.id });
  const reviewRequired = finished.status === 'awaiting_review';
  let reviewPageCount = 0;
  if (reviewRequired) {
    assert.equal(finished.errorCode,'review_required');
    assert.equal(pages.items.length,0,'review must block automatic publication');
    const review = await rpc.request('knowledge/review/read',identity);
    context.registerSecret(review.token);
    assert.ok(review.notes.length > 0 && review.pages.length > 0);
    reviewPageCount = review.pages.length;
    assert.ok(lastGeneratedProposal?.pages?.length > 0,'real staged candidate was observed without persisting its contents');
    assert.ok(lastGeneratedProposal.pages.every(page=>review.pages.some(item=>item.pageId===page.pageId)));
  } else assert.ok(pages.items.length > 0, 'real model organization publishes grounded pages');
  let citations = 0;
  const drafts = reviewRequired ? lastGeneratedProposal.pages : await Promise.all(pages.items.map(async page =>
    (await rpc.request('knowledge/page/read',{libraryId:library.id,pageId:page.pageId})).draft));
  for (const draft of drafts) {
    for (const citation of draft.citations ?? []) {
      const resolved = await rpc.request('knowledge/citation/resolve', { libraryId: library.id, sourceId: citation.sourceId,
        revisionId: citation.revisionId, chunkId: citation.chunkId });
      assert.ok(resolved.chunk.text.includes(citation.quote), 'actual source revision must contain every retained quote');
      assert.ok(source.includes(citation.quote)); citations++;
    }
  }
  assert.ok(citations > 0);
  await context.writeArtifactJson('real-wiki-evidence.json', { profile: model.profile, model: model.model, apiFormat: model.providerConfig.api_format,
    sourcePath, sourceSha256: createHash('sha256').update(source).digest('hex'), sourceBytes: Buffer.byteLength(source),
    durationMs: Date.now() - started, upstreamCalls: calls, finiteBudget: { calls: 6, completionAllowance: 6144, unit: 'tokens', requestBytesPerCall: 65536, wallMs: wallLimitMs },
    stages, quotas: quotas.map(({maxOutputTokens, ...facts})=>({...facts,completionAllowance:maxOutputTokens,unit:'tokens'})),
    usage: { reservedCalls:budget.reservedCalls,completedCalls:budget.completedCalls,usageReportedCalls:budget.usageReportedCalls,
      inputUnits:budget.inputTokens,outputUnits:budget.outputTokens,unit:'tokens' },
    pageCount: pages.items.length, reviewPageCount, reviewRequired, publicationPassed: !reviewRequired, resolvedCitations: citations,
    stageCacheReusedAfterPause: true, terminalStatus: finished.status,
    evidenceScope: 'one fixed repository document slice and actual real Provider; review_required is verified without approval/publication; no independent human quality score or before/after baseline latency claim' });
  return { passed: true, realProvider: true, stageCacheReused: true, reviewRequired, publicationPassed: !reviewRequired, resolvedCitations: citations };
});
