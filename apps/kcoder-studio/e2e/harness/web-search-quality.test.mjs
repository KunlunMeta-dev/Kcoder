import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchQualityOptions, loadSearchCorpus, searchQualitySettings, analyzeResearchTurn, publicResearchFrames, manualReviewTemplate, researchUsageDelta, writeResearchCaseIndex, retainResearchFramesOnCleanup, runResearchTurn } from './web-search-quality.mjs';
import { RunContext } from './run-context.mjs';
const consent = { KCODER_E2E_REAL_MODEL: '1', KCODER_TEST_SEARCH_EXTERNAL: '1' };
const receipt = JSON.parse(await readFile(new URL('../../shared/generated/examples.web-sources.json', import.meta.url))).WebSourcesToolResultV1.find(row => row.name === 'native-summary').value.webSources;
const task = { id: 'metadata-only', query: 'Original public task text', expected_entry: 'WebSearch', require_page_read: true, valid_empty_allowed: false, allowed_source_domains: ['example.com'] };
const frame = (method, item) => ({ atMs: 1, message: { method, params: { threadId: 'thread-1', turnId: 'turn-1', attemptId: 'attempt-1', ...(method === 'turn/completed' ? { turn: { id: 'turn-1', status: 'completed' } } : { item }) } } });
function frames(native = true) {
  const search = { id: 'search-1', type: 'toolCall', name: 'WebSearch', status: 'completed', output: 'Public search result text', ...(native ? { webSources: receipt } : {}) };
  const read = { id: 'fetch-1', type: 'toolCall', name: 'WebFetch', status: 'completed', output: 'Public original page extraction', ...(native ? { webSources: { ...receipt, operation: 'fetch', toolCallId: 'fetch-1', sources: receipt.sources.map(source => ({ ...source, readStatus: 'read' })) } } : {}) };
  return [frame('item/started', { ...search, input: { query: 'Public query' } }), frame('item/completed', search), frame('item/started', read), frame('item/completed', read), { atMs: 3, message: { method: 'item/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: { text: 'An answer requiring independent human verification.' } } } }, frame('turn/completed')];
}
test('live quality requires both explicit gates and selects a bounded one-case smoke by default', async () => {
  assert.throws(() => searchQualityOptions({}), /consent/);
  assert.throws(() => searchQualityOptions({ KCODER_E2E_REAL_MODEL: '1' }), /consent/);
  const options = searchQualityOptions(consent);
  assert.equal(options.caseWallMs, 4 * 120_000);
  assert.equal(options.outputTokens, 4 * 2048);
  assert.equal(options.maxResponses, 4 * 6);
  assert.equal(options.maxSearchCalls, 4 * 6);
  assert.equal(options.maxFetchCalls, 4 * 6);
  const selected = await loadSearchCorpus(new URL('../../../../tests/fixtures/web-search-quality/corpus.json', import.meta.url), options);
  assert.equal(selected.corpus.tasks.length, 40); assert.equal(selected.selected.length, 1);
  assert.deepEqual(options.ids, ['official_technical-01']);
});
test('owned model settings disable private extensions without declaring web/mcp or changing the approved model', () => {
  const model = { provider: 'approved', model: 'Approved-M3', providerConfig: { endpoint: 'https://example.invalid/anthropic', api_format: 'anthropic_messages', default_model: 'Approved-M3', context_window_tokens: 128000 } };
  const settings = searchQualitySettings(model, searchQualityOptions(consent), '/owned/disabled-memory');
  assert.equal('web' in settings, false); assert.equal('mcp_servers' in settings, false);
  assert.equal(settings.memory.structured_enabled, false); assert.equal(settings.knowledge.retrieval_enabled, false); assert.equal(settings.plugins.runtime.enabled, false); assert.deepEqual(settings.hooks, {});
  assert.deepEqual(settings.allowed_tools, ['WebSearch', 'WebFetch']); assert.equal(settings.providers.approved.default_model, 'Approved-M3');
});
test('synthetic native metadata parser tests do not become model quality scores', () => {
  const result = analyzeResearchTurn(task, 'thread-1', 'turn-1', frames(), 20);
  assert.equal(result.mechanicalPassed, true); assert.equal(result.receipts.length, 2); assert.equal(result.sourceDates[0].publishedAt, '2026-10-30');
  assert.equal(result.qualityAcceptance, 'pending_two_independent_human_reviews');
  const review = manualReviewTemplate(task, { rubric: { citation_support: { min: 0, max: 4 } } }, 'owned');
  assert.equal(review.reviewers.length, 2); assert.equal(review.reviewers[0].scores.citation_support.score, null);
});
test('legacy baseline execution is not failed only because newer native metadata is absent', () => {
  const legacy = analyzeResearchTurn(task, 'thread-1', 'turn-1', frames(false), 20, false);
  assert.equal(legacy.mechanicalPassed, true); assert.equal(legacy.receipts.length, 0); assert.equal(legacy.legacySourceMaterials.length, 2);
  assert.equal(analyzeResearchTurn(task, 'thread-1', 'turn-1', frames(false), 20, true).mechanicalPassed, false);
});
test('public evidence excludes model thinking and arbitrary configuration events', () => {
  const raw = [...frames(), { atMs: 2, message: { method: 'item/event', params: { event: { type: 'assistant_thinking_delta', text: 'not retained' } } } }, { atMs: 2, message: { method: 'provider/private', params: { hidden: 'not retained' } } }];
  assert.equal(JSON.stringify(publicResearchFrames(raw)).includes('not retained'), false);
});

test('a direct native official-page read is distinct from a full search chain and manual quality', () => {
  const direct = frames().filter(row => row.message.params?.item?.name !== 'WebSearch');
  const result = analyzeResearchTurn(task, 'thread-1', 'turn-1', direct, 20, true);
  assert.equal(result.mechanicalPassed, true);
  assert.equal(result.materialReadObserved, true); assert.equal(result.finalAnswerCompleted, true);
  assert.equal(result.searchChainObserved, false); assert.equal(result.preferredEntryObserved, false);
  assert.equal(result.qualityAcceptance, 'pending_two_independent_human_reviews');
});


test('native final max_tokens is retained as output-limit evidence despite turn completed', () => {
  const raw = frames();
  raw.splice(4, 0, frame('item/started', { id: 'answer-1', type: 'agentMessage' }));
  raw.splice(-1, 0, { atMs: 4, message: { method: 'item/event', params: { threadId: 'thread-1', turnId: 'turn-1', event: { type: 'assistant_stop_reason', reason: 'max_tokens', privateExtra: 'must-not-retain' } } } });
  const result = analyzeResearchTurn(task, 'thread-1', 'turn-1', raw, 20);
  assert.equal(result.terminal, 'completed'); assert.equal(result.finalResponseStopReason, 'max_tokens');
  assert.equal(result.finalAnswerCompleted, false); assert.equal(result.mechanicalPassed, false);
  assert.ok(result.mechanicalReasons.includes('final_response_output_limit'));
  const projected = publicResearchFrames(raw);
  assert.ok(projected.some(row => row.message.params.event?.reason === 'max_tokens'));
  assert.ok(!JSON.stringify(projected).includes('must-not-retain'));
});

test('tool-use stop does not replace the separately bound final end_turn and peer stop is ignored', () => {
  const raw = frames();
  raw.unshift(frame('item/started', { id: 'research-1', type: 'agentMessage' }), { message: { method: 'item/event', params: { threadId: 'thread-1', turnId: 'turn-1', event: { type: 'assistant_stop_reason', reason: 'tool_use' } } } });
  raw.splice(-2, 0, frame('item/started', { id: 'answer-1', type: 'agentMessage' }));
  raw.splice(-1, 0, { message: { method: 'item/event', params: { threadId: 'thread-1', turnId: 'turn-1', event: { type: 'assistant_stop_reason', reason: 'end_turn' } } } }, { message: { method: 'item/event', params: { threadId: 'peer-thread', turnId: 'turn-1', event: { type: 'assistant_stop_reason', reason: 'max_tokens' } } } });
  const result = analyzeResearchTurn(task, 'thread-1', 'turn-1', raw, 20);
  assert.deepEqual(result.modelStopReasons.map(row => row.reason), ['tool_use', 'end_turn']);
  assert.equal(result.finalResponseStopReason, 'end_turn'); assert.equal(result.finalAnswerCompleted, true);
  assert.equal(result.mechanicalPassed, true);
  assert.equal(analyzeResearchTurn(task, 'thread-1', 'turn-1', frames(false), 20, false).stopEvidence, 'unavailable_not_inferred');
});

test('native owned-profile usage retains reported and unreported counters without prices or guessed usage', () => {
  const counters = { requests: 2, unreportedRequests: 1, estimatedTotalRequests: 0, inputTokens: 100, outputTokens: 12, cacheReadTokens: 5, cacheCreationTokens: 0, totalTokens: 117 };
  const before = { available: true, history: null };
  const after = { available: true, history: { days: { '2026-10-31': { 'approved-model': counters } } } };
  const result = researchUsageDelta(before, after);
  assert.deepEqual(result.delta, counters); assert.equal(result.pricing, 'not_inferred');
  assert.equal(researchUsageDelta({ available: false }, after).delta, null);
  assert.equal(researchUsageDelta(after, before).delta, null);
});

test('multiple research samples retain immutable progress snapshots and publish one complete index', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'research-index-multiple-samples', tier: 'model-independent', modelPolicy: 'immutable evidence-writer fixture, no model/provider requests' });
  let error;
  try {
    const cases = [{ taskId: 'first', runtimeGroup: 'current' }];
    await writeResearchCaseIndex(context, cases);
    cases.push({ taskId: 'first', runtimeGroup: 'baseline' });
    await writeResearchCaseIndex(context, cases);
    await writeResearchCaseIndex(context, cases, { final: true });
    const initial = JSON.parse(await readFile(`${context.artifactsDir}/case-index/progress-0001.json`));
    const final = JSON.parse(await readFile(`${context.artifactsDir}/case-index.json`));
    assert.equal(initial.cases.length, 1); assert.equal(final.cases.length, 2);
    await assert.rejects(writeResearchCaseIndex(context, cases, { final: true }), { code: 'EEXIST' });
  } catch (failure) { error = failure; throw failure; }
  finally { await context.finish(error ? 'failed' : 'passed', {}, error); }
});


test('pre-cancelled or expired research never submits a model turn or reads usage', async () => {
  const rpc = { messages: () => [], request: async () => assert.fail('pre-cancel must not perform RPC I/O') };
  const result = await runResearchTurn(rpc, task, 'thread-1', { caseWallMs: 0 }, new AbortController().signal);
  assert.equal(result.result.modelDispatch, 'not_started'); assert.equal(result.result.mechanicalPassed, false);
});

test('aborting retains only observed public frames after new actions are revoked', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'research-cancel-receipt', tier: 'model-independent', modelPolicy: 'cleanup receipt fixture; no provider request' });
  const capture = retainResearchFramesOnCleanup(context, 'owned-case');
  capture.observe([...frames(), { message: { method: 'item/event', params: { event: { type: 'assistant_thinking_delta', text: 'private-not-retained' } } } }]);
  await context.requestAbort(Error('owned fixture cancellation'));
  await assert.rejects(context.finish('failed', {}, Error('owned fixture cancellation')), /owned fixture cancellation/);
  const receipt = JSON.parse(await readFile(`${context.artifactsDir}/owned-case/cancelled-partial-public-frames.json`));
  assert.ok(receipt.frames.length > 0); assert.ok(!JSON.stringify(receipt).includes('private-not-retained'));
});
