import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isWebSourcesToolResultV1 } from '../../shared/generated/contractGuards.mjs';
import { isTurnCompletion } from './rpc.mjs';

export const SEARCH_PRESENTATION = Object.freeze({ version: 1, studioWorkMode: 'kcoder', inlineWidgets: false });
const integer = (value, fallback, min, max, name) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw Error(`UNMET_PREREQUISITE: invalid search quality ${name}`);
  return parsed;
};
export function searchQualityOptions(env = process.env) {
  if (env.KCODER_E2E_REAL_MODEL !== '1' || env.KCODER_TEST_SEARCH_EXTERNAL !== '1')
    throw Error('UNMET_PREREQUISITE: real-model and public-search consent flags must both equal 1; no fixture fallback');
  const all = env.KCODER_E2E_SEARCH_ALL === '1';
  const ids = env.KCODER_E2E_SEARCH_CASE_IDS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  if (all && ids.length) throw Error('UNMET_PREREQUISITE: select the full corpus or explicit case IDs');
  return Object.freeze({ all, ids: all ? [] : ids.length ? ids : ['official_technical-01'],
    repeats: integer(env.KCODER_E2E_SEARCH_REPEATS, 1, 1, 2, 'repeats'),
    outputTokens: integer(env.KCODER_E2E_MODEL_MAX_TOKENS, 8192, 512, 32768, 'output token limit'),
    caseWallMs: integer(env.KCODER_E2E_MODEL_TIMEOUT_SECS, 480, 30, 1200, 'case seconds') * 1000,
    suiteWallMs: integer(env.KCODER_E2E_SEARCH_SUITE_SECONDS, all ? 14400 : 1200, 60, 57600, 'suite seconds') * 1000,
    maxResponses: integer(env.KCODER_E2E_SEARCH_MAX_RESPONSES, 24, 3, 48, 'observed model response limit'),
    maxSearchCalls: integer(env.KCODER_E2E_SEARCH_MAX_QUERIES, 24, 1, 48, 'search call limit'),
    maxFetchCalls: integer(env.KCODER_E2E_SEARCH_MAX_FETCHES, 24, 1, 48, 'fetch call limit'),
    cancel: env.KCODER_E2E_SEARCH_CANCEL === '1',
    browser: env.KCODER_E2E_SEARCH_ENABLE_BROWSER === '1',
  });
}
export async function loadSearchCorpus(path, options) {
  const bytes = await readFile(path);
  const corpus = JSON.parse(bytes);
  if (corpus.schema_version !== 1 || corpus.tasks?.length !== 40 || new Set(corpus.tasks.map(task => task.id)).size !== 40)
    throw Error('UNMET_PREREQUISITE: expected the frozen, unique 40-case search corpus');
  const selected = options.all ? corpus.tasks : options.ids.map(id => corpus.tasks.find(task => task.id === id));
  if (!selected.length || selected.some(task => !task || typeof task.query !== 'string' || !Array.isArray(task.allowed_source_domains)))
    throw Error('UNMET_PREREQUISITE: unknown or invalid selected search corpus case');
  return { corpus, selected, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function searchQualitySettings(model, budget, memoryDirectory) {
  const selected = model.providerConfig.models?.[model.model] ?? {};
  if (model.providerConfig.capabilities?.tools === false || selected.capabilities?.tools === false)
    throw Error('UNMET_PREREQUISITE: selected model declares native tool use unavailable');
  for (const extra of [model.providerConfig.extra_body, selected.extra_body]) {
    if (extra && ['tools', 'functions', 'web_search_options', 'enable_search', 'search_options'].some(key => extra[key]))
      throw Error('UNMET_PREREQUISITE: model-native search or tool overrides cannot substitute for native KCoder search');
  }
  const contextWindow = selected.context_window_tokens ?? model.providerConfig.context_window_tokens;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 8192) throw Error('UNMET_PREREQUISITE: selected public model context window is unavailable');
  const allowed = ['WebSearch', 'WebFetch', ...(budget.browser ? ['WebBrowser'] : [])];
  const result = {
    active_provider: model.provider,
    providers: { [model.provider]: { ...model.providerConfig, max_output_tokens: budget.outputTokens,
      output_headroom_tokens: budget.outputTokens, max_retries: 0,
      request_timeout_secs: Math.min(model.providerConfig.request_timeout_secs ?? 90, budget.caseWallMs / 1000),
      models: { ...model.providerConfig.models, [model.model]: { ...selected, context_window_tokens: contextWindow, max_output_tokens: budget.outputTokens, output_headroom_tokens: budget.outputTokens } } } },
    tools: { profile: 'core', disabled: [], studio: { kcoder: allowed, kworker: allowed } },
    permission_mode: 'auto', allowed_tools: allowed,
    max_tokens: budget.outputTokens, max_retries: 0, max_duration_secs: budget.caseWallMs / 1000,
    auto_memory_enabled: false, auto_tool_memory_enabled: false, goal_enabled: false,
    memory_directory: memoryDirectory,
    memory: { structured_enabled: false, legacy_prompt_enabled: false, observer_mode: 'disabled' },
    session_memory: { enabled: false, update_enabled: false, compact_enabled: false },
    knowledge: { enabled: false, retrieval_enabled: false, organization_enabled: false },
    plugins: { runtime: { enabled: false, project_policy: 'disabled' }, installed: {}, marketplaces: {} },
    skills: { auto_curator_enabled: false, auto_skill_review_enabled: false, auto_lessons_learned: false, trust_external: false, external_dirs: [] },
    hooks: {}, recovery: { provider: { total_timeout_ms: budget.caseWallMs } },
  };
  if ('web' in result || 'mcp_servers' in result) throw Error('Search defaults must remain undeclared');
  return result;
}
function allowedDomain(url, domains) {
  try { const host = new URL(url).hostname.toLowerCase(); return domains.some(domain => host === domain || host.endsWith(`.${domain}`)); }
  catch { return false; }
}
export function analyzeResearchTurn(task, threadId, turnId, frames, elapsedMs, nativeRequired = true) {
  const items = new Map(), assistant = [], notices = [], modelResponses = new Set(), answerByItem = new Map(), modelStopReasons = [];
  let currentAssistantId = null, lastToolIndex = -1, frameIndex = 0;
  let terminal = null;
  for (const row of frames) {
    frameIndex++;
    const message = row.message ?? row;
    const params = message.params;
    if (params?.threadId !== threadId || params?.turnId !== turnId) continue;
    if (message.method === 'turn/completed') terminal = params.turn?.status;
    if (message.method === 'item/delta' && typeof params.delta?.text === 'string') {
      assistant.push(params.delta.text);
      const id = params.itemId ?? currentAssistantId ?? 'legacy-assistant';
      const entry = answerByItem.get(id) ?? { text: '', firstIndex: frameIndex };
      entry.text += params.delta.text; answerByItem.set(id, entry);
    }
    const item = params.item;
    if (message.method === 'item/started' && item?.type === 'agentMessage') { modelResponses.add(item.id); currentAssistantId = item.id; }
    if (message.method === 'item/event' && params.event?.type === 'assistant_stop_reason' && typeof params.event.reason === 'string')
      modelStopReasons.push({ itemId: currentAssistantId, attemptId: params.attemptId ?? null, reason: params.event.reason, atMs: row.atMs ?? null });
    if (item?.type === 'toolCall') {
      if (message.method === 'item/completed') lastToolIndex = frameIndex;
      const previous = items.get(item.id) ?? { id: item.id, name: item.name };
      items.set(item.id, { ...previous, ...item, startedAtMs: previous.startedAtMs ?? row.atMs ?? null,
        completedAtMs: message.method === 'item/completed' ? row.atMs ?? null : previous.completedAtMs,
        attemptId: params.attemptId ?? previous.attemptId });
    }
    if (message.method === 'item/event' && ['error', 'system_notice'].includes(params.event?.type)) notices.push({ type: params.event.type, text: params.event.error ?? params.event.text ?? null });
  }
  const tools = [...items.values()];
  const receipts = [], invalidReceipts = [];
  for (const item of tools) {
    if (!item.webSources) continue;
    const source = item.webSources;
    if (!isWebSourcesToolResultV1({ webSources: source }) || source.identity?.threadId !== threadId || source.identity?.turnId !== turnId || source.toolCallId !== item.id || (item.attemptId && source.identity.attemptId !== item.attemptId)) {
      invalidReceipts.push(item.id); continue;
    }
    receipts.push({ ...source, toolName: item.name, output: item.output ?? '',
      outputTruncated: item.outputTruncated === true, outputOriginalBytes: item.outputOriginalBytes ?? null,
      observedToolMs: typeof item.completedAtMs === 'number' && typeof item.startedAtMs === 'number' ? item.completedAtMs - item.startedAtMs : null });
  }
  const searches = receipts.filter(receipt => receipt.operation === 'search');
  const reads = receipts.filter(receipt => receipt.operation === 'fetch');
  const validEmpty = task.valid_empty_allowed && searches.length > 0 && searches.every(receipt => receipt.status === 'empty');
  const successfulSearch = searches.some(receipt => ['success', 'partial'].includes(receipt.status) && receipt.sources.length > 0);
  const successfulRead = reads.some(receipt => receipt.sources.some(source => ['read', 'partial'].includes(source.readStatus)) && ['success', 'partial'].includes(receipt.status));
  const reasons = [];
  if (terminal !== 'completed') reasons.push(`terminal_${terminal ?? 'missing'}`);
  if (nativeRequired) {
    if (task.require_page_read && !validEmpty && !successfulRead) reasons.push('missing_successful_native_read');
    if (task.expected_entry === 'WebFetch' && !successfulRead) reasons.push('missing_native_fetch_entry');
  } else {
    // Legacy tool completion is executable evidence, not trusted source/date metadata.
    if (!tools.some(item => ['WebSearch', 'WebFetch', 'WebBrowser'].includes(item.name) && item.status === 'completed')) reasons.push('missing_successful_legacy_research_tool');
    if (task.require_page_read && !task.valid_empty_allowed && !tools.some(item => item.name === 'WebFetch' && item.status === 'completed')) reasons.push('missing_successful_legacy_read');
  }
  if (invalidReceipts.length) reasons.push('native_receipt_identity_invalid');
  const answer = assistant.join('');
  const finalEntry = [...answerByItem.entries()].filter(([, value]) => value.firstIndex > lastToolIndex).at(-1);
  const finalAnswer = finalEntry?.[1].text ?? '';
  const finalResponseStopReason = modelStopReasons.findLast(stop => stop.itemId === finalEntry?.[0])?.reason ?? null;
  const incompleteStop = ['max_tokens', 'refusal', 'pause_turn', 'tool_use'].includes(finalResponseStopReason);
  if (!finalAnswer.trim()) reasons.push('missing_final_assistant_answer_after_tools');
  if (incompleteStop) reasons.push(finalResponseStopReason === 'max_tokens' ? 'final_response_output_limit' : `final_response_${finalResponseStopReason}`);
  const expectedDomainExceptions = receipts.flatMap(receipt => receipt.sources.filter(source => !allowedDomain(source.url, task.allowed_source_domains)).map(source => ({ operation: receipt.operation, url: source.url })));
  const explicitFilterViolations = [];
  for (const item of tools) {
    if (!Array.isArray(item.input?.allowed_domains) || !item.input.allowed_domains.length) continue;
    const receipt = receipts.find(value => value.toolCallId === item.id);
    for (const source of receipt?.sources ?? []) if (!allowedDomain(source.url, item.input.allowed_domains)) explicitFilterViolations.push({ toolCallId: item.id, url: source.url });
  }
  if (explicitFilterViolations.length) reasons.push('native_tool_domain_filter_violated');
  const legacySearch = tools.some(item => item.name === 'WebSearch' && item.status === 'completed');
  const legacyRead = tools.some(item => ['WebFetch', 'WebBrowser'].includes(item.name) && item.status === 'completed');
  const preferredEntryObserved = tools.some(item => item.name === task.expected_entry && item.status === 'completed');
  return { schemaVersion: 1, taskId: task.id, threadId, turnId, terminal, elapsedMs, answer, finalAnswer,
    mechanicalPassed: reasons.length === 0, mechanicalReasons: reasons,
    searchChainObserved: nativeRequired ? successfulSearch && successfulRead : null, legacySearchFetchObserved: !nativeRequired ? legacySearch && legacyRead : null,
    materialReadObserved: nativeRequired ? successfulRead : legacyRead, finalAnswerCompleted: terminal === 'completed' && Boolean(finalAnswer.trim()) && !incompleteStop,
    modelStopReasons, finalResponseStopReason, stopEvidence: finalResponseStopReason === null ? 'unavailable_not_inferred' : 'native_reported',
    preferredEntryObserved, expectationGaps: preferredEntryObserved ? [] : ['frozen_expected_entry_not_observed_not_a_factual_failure'],
    sourceMetadataContract: nativeRequired ? 'native_v1_required' : 'legacy_text_compatible',
    legacySourceMaterials: tools.filter(item => !item.webSources).map(item => ({ toolCallId: item.id, name: item.name, status: item.status, output: item.output ?? '', outputTruncated: item.outputTruncated === true, sourceMetadata: 'unavailable_not_inferred' })),
    qualityAcceptance: 'pending_two_independent_human_reviews', modelResponsesObserved: modelResponses.size,
    tools, receipts, notices, invalidReceipts, expectedDomainExceptions, explicitFilterViolations,
    nativeFailures: receipts.filter(receipt => ['failed', 'cancelled'].includes(receipt.status)).map(receipt => ({ operation: receipt.operation, status: receipt.status, failure: receipt.failure ?? null, attempts: receipt.attempts })),
    sourceDates: receipts.flatMap(receipt => receipt.sources.map(source => ({ url: source.url, publishedAt: source.publishedAt ?? null, retrievedAt: source.retrievedAt, readStatus: source.readStatus, cacheHit: source.cacheHit, cacheAgeMs: source.cacheAgeMs }))),
  };
}
export function manualReviewTemplate(task, corpus, evidencePath) {
  const scores = () => Object.fromEntries(Object.keys(corpus.rubric).map(name => [name, { score: null, rationale: null, evidence: [] }]));
  return { schemaVersion: 1, taskId: task.id, query: task.query, evidencePath,
    acceptance: 'pending_two_independent_human_reviews',
    reviewers: [{ reviewerId: null, completedAt: null, scores: scores() }, { reviewerId: null, completedAt: null, scores: scores() }],
    reconciliation: { completedAt: null, disagreements: [], finalDecision: null },
    notes: ['Mechanical native-tool execution is not factual/citation correctness.', 'Publication dates must not be inferred from retrieval dates.', 'Expected-domain exceptions require human review; an actual tool input allowlist violation is a separate runtime failure.'] };
}
/** Immutable progress checkpoints; the complete index is published once. */
export async function writeResearchCaseIndex(context, cases, options = {}) {
  const { final = false, ...facts } = options;
  const path = final ? 'case-index.json' : `case-index/progress-${String(cases.length).padStart(4, '0')}.json`;
  return context.writeArtifactJson(path, { schemaVersion: 1, cases, qualityAcceptance: 'pending_two_independent_human_reviews', ...facts });
}
/** Cleanup may run after RunContext has revoked new actions; keep observed public facts then. */
export function retainResearchFramesOnCleanup(context, evidencePath) {
  let frames = [], complete = false;
  context.addCleanup(`retain research receipt ${evidencePath}`, async () => {
    if (!complete) await context.writeArtifactJsonInternal(`${evidencePath}/cancelled-partial-public-frames.json`, {
      coverage: 'observed public frames only; missing receipt is unknown, never replayed', frames: publicResearchFrames(frames),
    });
  });
  return { observe: value => { frames = value; }, complete: () => { complete = true; } };
}
export async function runResearchTurn(rpc, task, threadId, budget, signal, nativeRequired = true) {
  const started = Date.now(), offset = rpc.messages().length;
  const exhausted = () => signal?.aborted || Date.now() - started >= budget.caseWallMs;
  const notStarted = () => {
    const result = analyzeResearchTurn(task, threadId, 'not-started', [], Date.now() - started, nativeRequired);
    return { result: { ...result, terminal: 'not_started', mechanicalPassed: false, mechanicalReasons: ['case_budget_or_cancel_before_model'], modelDispatch: 'not_started' }, frames: [] };
  };
  if (exhausted()) return notStarted();
  const usageBefore = await readResearchUsage(rpc);
  if (exhausted()) return notStarted();
  const frames = [];
  let turnId, cursor = offset, interrupted = null;
  try {
    const { turn } = await rpc.request('turn/start', { threadId, clientPresentation: SEARCH_PRESENTATION, ...(budget.submissionIdentity ? { clientMessageId: `search-quality-${task.id}-${crypto.randomUUID()}` } : {}), input: [{ type: 'text', text: task.query }] }, 30_000);
    turnId = turn.id;
  } catch (error) {
    const partial = rpc.messages().slice(offset).filter(message => message.params?.threadId === threadId);
    budget.onFrames?.(partial.map(message => ({ atMs: Date.now() - started, message })));
    turnId = partial.map(message => message.params?.turnId).find(value => typeof value === 'string') ?? 'unknown-start-receipt';
    await rpc.request('turn/interrupt', { threadId, ...(turnId === 'unknown-start-receipt' ? {} : { turnId }) }).catch(() => {});
    const result = analyzeResearchTurn(task, threadId, turnId, partial, Date.now() - started, nativeRequired);
    result.mechanicalPassed = false; result.mechanicalReasons.push('start_receipt_unknown_no_replay');
    result.transportError = error.message;
    result.usage = researchUsageDelta(usageBefore, await readResearchUsage(rpc));
    return { result, frames: partial.map(message => ({ atMs: Date.now() - started, message })) };
  }
  try {
    while (true) {
      const fresh = rpc.messages().slice(cursor); cursor += fresh.length;
      for (const message of fresh) if (message.params?.threadId === threadId && message.params?.turnId === turnId) frames.push({ atMs: Date.now() - started, message });
      if (fresh.length) budget.onFrames?.(frames);
      const relevant = frames.map(row => row.message);
      const responses = relevant.filter(message => message.method === 'item/started' && message.params.item?.type === 'agentMessage').length;
      const calls = relevant.filter(message => message.method === 'item/started' && message.params.item?.type === 'toolCall');
      const complete = relevant.find(message => isTurnCompletion(message, threadId, turnId));
      if (complete) break;
      if (!interrupted && (signal?.aborted || Date.now() - started > budget.caseWallMs || responses > budget.maxResponses || calls.filter(message => message.params.item.name === 'WebSearch').length > budget.maxSearchCalls || calls.filter(message => ['WebFetch', 'WebBrowser'].includes(message.params.item.name)).length > budget.maxFetchCalls)) {
        interrupted = signal?.aborted ? 'suite_aborted' : 'observed_case_budget_exceeded';
        await rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
      if (Date.now() - started > budget.caseWallMs + 20_000) throw Error('Native owned research turn did not settle after interruption');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } catch (error) {
    await rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    const result = analyzeResearchTurn(task, threadId, turnId, frames, Date.now() - started, nativeRequired);
    result.mechanicalPassed = false; result.mechanicalReasons.push('transport_or_terminal_receipt_unknown'); result.transportError = error.message;
    result.usage = researchUsageDelta(usageBefore, await readResearchUsage(rpc));
    return { result, frames };
  }
  const result = analyzeResearchTurn(task, threadId, turnId, frames, Date.now() - started, nativeRequired);
  result.startedAtUtc = new Date(started).toISOString();
  result.completedAtUtc = new Date().toISOString();
  if (interrupted) { result.mechanicalPassed = false; result.mechanicalReasons.push(interrupted); }
  result.usage = researchUsageDelta(usageBefore, await readResearchUsage(rpc));
  return { result, frames };
}

const USAGE_COUNTERS = ['requests', 'unreportedRequests', 'estimatedTotalRequests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens'];
async function readResearchUsage(rpc) {
  try {
    const result = await rpc.request('usage/stats', {}, 10000);
    if (!result || !('history' in result)) return { available: false };
    return { available: true, windowDays: result.windowDays, timeZone: result.timeZone, generatedAtMs: result.generatedAtMs, history: result.history };
  } catch { return { available: false }; }
}
export function researchUsageDelta(before, after) {
  const totals = snapshot => {
    const result = Object.fromEntries(USAGE_COUNTERS.map(key => [key, 0]));
    for (const models of Object.values(snapshot.history?.days ?? {})) for (const row of Object.values(models)) {
      for (const key of USAGE_COUNTERS) {
        if (!Number.isSafeInteger(row[key]) || row[key] < 0) return null;
        result[key] += row[key];
      }
    }
    return result;
  };
  const a = before.available ? totals(before) : null, b = after.available ? totals(after) : null;
  const monotonic = a && b && USAGE_COUNTERS.every(key => Number.isSafeInteger(b[key]) && b[key] >= a[key]);
  return { scope: 'native usage/stats on this run-owned isolated profile; aggregate before/after counters', before, after,
    delta: monotonic ? Object.fromEntries(USAGE_COUNTERS.map(key => [key, b[key] - a[key]])) : null,
    availability: monotonic ? 'native_reported' : 'unavailable_or_nonmonotonic_not_inferred', pricing: 'not_inferred' };
}


/** Retain only public task/output/tool facts; model thinking and configuration events are excluded. */
export function publicResearchFrames(frames) {
  return frames.flatMap(row => {
    const { message } = row;
    const p = message.params ?? {};
    const params = { threadId: p.threadId, turnId: p.turnId, attemptId: p.attemptId, ...(typeof p.itemId === 'string' ? { itemId: p.itemId } : {}) };
    if (['item/started', 'item/completed'].includes(message.method) && ['toolCall', 'agentMessage'].includes(p.item?.type)) {
      const item = Object.fromEntries(['id', 'type', 'name', 'status', 'input', 'inputTruncated', 'output', 'outputTruncated', 'outputOriginalBytes', 'webSources'].filter(key => key in p.item).map(key => [key, p.item[key]]));
      return [{ atMs: row.atMs, message: { method: message.method, params: { ...params, item } } }];
    }
    if (message.method === 'item/delta' && typeof p.delta?.text === 'string') return [{ atMs: row.atMs, message: { method: message.method, params: { ...params, delta: { text: p.delta.text } } } }];
    if (message.method === 'turn/completed') return [{ atMs: row.atMs, message: { method: message.method, params: { ...params, turn: { id: p.turn?.id, status: p.turn?.status } } } }];
    if (message.method === 'item/event' && p.event?.type === 'assistant_stop_reason' && typeof p.event.reason === 'string')
      return [{ atMs: row.atMs, message: { method: message.method, params: { ...params, event: { type: p.event.type, reason: p.event.reason } } } }];
    if (message.method === 'item/event' && ['error', 'system_notice'].includes(p.event?.type)) return [{ atMs: row.atMs, message: { method: message.method, params: { ...params, event: { type: p.event.type, text: p.event.error ?? p.event.text ?? null } } } }];
    return [];
  });
}
