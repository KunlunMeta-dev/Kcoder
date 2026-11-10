import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { requireExecutable } from './run-context.mjs';
import { protectedModelForward } from './protected-model-forward.mjs';
import { octopResearchIdentity } from './research-identities.mjs';

const adapter = fileURLToPath(new URL('./octop-search-baseline.py', import.meta.url));
export const OCTOP_TOOLS = Object.freeze(['searchfree_search', 'web_fetch']);

export function octopEnvironment(context, state, network = {}) {
  if (Object.keys(network).some(name => !['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].includes(name)))
    throw Error('Only explicit network proxy variables may enter the Octop process');
  const env = context.isolatedEnvironment({ HOME: resolve(state, 'home'), USERPROFILE: resolve(state, 'home'),
    OCTOP_HOME: resolve(state, 'octop'), XDG_CONFIG_HOME: resolve(state, 'config'), XDG_CACHE_HOME: resolve(state, 'cache'),
    XDG_DATA_HOME: resolve(state, 'data'), XDG_RUNTIME_DIR: resolve(state, 'runtime'), TMPDIR: resolve(state, 'tmp'),
    PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8', ...network });
  // No credential/provider/search variables, desktop access or host runtime directories.
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS']) delete env[name];
  return env;
}

export function analyzeOctopResearch(task, frames, repeat = 0) {
  const sample = frames.filter(frame => frame.repeat === repeat);
  const calls = new Map(), indexes = new Map(), seenResults = new Set(), tools = [], errors = [];
  let answer = '', finalAnswer = '', terminal = null;
  for (const frame of sample) {
    if (frame.type === 'token') { answer += frame.text; finalAnswer += frame.text; }
    if (['tool_call_chunk', 'tool_start'].includes(frame.type)) {
      const index = frame.index ?? 0;
      const key = frame.id || frame.call_id || indexes.get(index) || `index-${index}`;
      if (frame.id || frame.call_id) indexes.set(index, key);
      const call = calls.get(key) ?? { id: key, name: '', args: '' };
      call.name ||= frame.name ?? ''; call.args += typeof frame.args === 'string' ? frame.args : frame.args ? JSON.stringify(frame.args) : '';
      calls.set(key, call);
    }
    if (frame.type === 'tool_result') {
      for (const message of frame.messages ?? []) {
        const call = calls.get(message.tool_call_id);
        const output = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        const identity = JSON.stringify([message.tool_call_id, message.name, output, message.status]);
        if (seenResults.has(identity)) continue;
        seenResults.add(identity); finalAnswer = '';
        tools.push({ toolCallId: message.tool_call_id, name: message.name || call?.name || null, inputText: call?.args ?? '', output,
          status: message.status === 'error' || /^Error:/.test(output) ? 'failed' : /^No results found\./.test(output) ? 'empty' : 'completed', sourceMetadata: 'legacy_text_not_inferred' });
      }
    }
    if (frame.type === 'error') errors.push(frame.message);
    if (frame.type === 'done') terminal = 'completed';
    if (frame.type === 'sample_end' && frame.interrupted) terminal = 'interrupted';
  }
  const end = sample.findLast(frame => frame.type === 'sample_end');
  const search = tools.some(tool => tool.name === 'searchfree_search' && tool.status === 'completed');
  const read = tools.some(tool => tool.name === 'web_fetch' && tool.status === 'completed');
  const empty = task.valid_empty_allowed && tools.some(tool => tool.name === 'searchfree_search' && tool.status === 'empty');
  const reasons = [];
  if (terminal !== 'completed') reasons.push(`terminal_${terminal ?? 'missing'}`);
  if (!tools.some(tool => tool.status === 'completed') && !empty) reasons.push('missing_successful_legacy_research_tool');
  if (task.require_page_read && !empty && !read) reasons.push('missing_successful_legacy_read');
  if (!finalAnswer.trim()) reasons.push('missing_final_assistant_answer_after_tools');
  if (errors.length) reasons.push('octop_error_frame');
  if (tools.some(tool => !OCTOP_TOOLS.includes(tool.name))) reasons.push('unexpected_research_tool');
  return { schemaVersion: 1, runtimeGroup: 'octop', taskId: task.id, repeat, threadId: end?.threadId ?? null,
    elapsedMs: end?.elapsedMs ?? null, appServerTemperature: end?.temperature ?? null, terminal, answer, finalAnswer,
    mechanicalPassed: reasons.length === 0, mechanicalReasons: reasons, searchChainObserved: null, legacySearchFetchObserved: search && read,
    materialReadObserved: read, finalAnswerCompleted: terminal === 'completed' && Boolean(finalAnswer.trim()),
    preferredEntryObserved: task.expected_entry === 'WebSearch' ? search : read,
    sourceMetadataContract: 'legacy_text_compatible', legacySourceMaterials: tools, errors,
    qualityAcceptance: 'pending_two_independent_human_reviews' };
}

export function withOctopProviderStops(record, observations) {
  const modelStopReasons = observations.map(row => ({ request: row.request, status: row.status, reason: row.stopReason ?? null,
    reportedInputUnits: row.inputUsage, reportedOutputUnits: row.outputUsage }));
  const finalResponseStopReason = modelStopReasons.at(-1)?.reason ?? null;
  if (['max_tokens', 'length', 'max_output_tokens', 'refusal', 'pause_turn', 'tool_use', 'tool_calls'].includes(finalResponseStopReason) && record.finalAnswer) {
    record = { ...record, finalAnswerCompleted: false, mechanicalPassed: false,
      mechanicalReasons: [...record.mechanicalReasons, 'final_response_incomplete_provider_stop'] };
  }
  return { ...record, modelStopReasons, finalResponseStopReason, stopEvidence: finalResponseStopReason === null ? 'unavailable_not_inferred' : 'protected_provider_reported' };
}

/** Public model metadata and an observer lease are the only connection inputs to Octop. */
export async function runOctopProcess(context, root, task, model, budget, observer, options = {}) {
  const checkout = await realpath(root);
  const sourceIdentity = await octopResearchIdentity(context, checkout);
  const python = await requireExecutable(resolve(checkout, '.venv/bin/python'), 'installed Octop Python');
  const label = `octop-${options.mode ?? 'research'}-${task.id}`;
  const state = context.pathInState(label);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await Promise.all(['home', 'octop', 'config', 'cache', 'data', 'runtime', 'tmp'].map(name => mkdir(resolve(state, name), { mode: 0o700 })));
  const selected = model.providerConfig.models?.[model.model] ?? {};
  const job = { mode: options.mode ?? 'research', stateRoot: state, octopRoot: checkout, taskId: task.id, query: task.query,
    provider: model.provider, model: model.model, protocol: model.providerConfig.api_format === 'anthropic_messages' ? 'anthropic' : 'openai',
    endpoint: observer.endpoint, forwardToken: observer.forwardToken,
    contextWindow: selected.context_window_tokens ?? model.providerConfig.context_window_tokens ?? 16384, budget,
    sourceIdentity, expectedRuntimeFingerprint: options.runtimeFingerprint ?? null };
  assert.match(job.forwardToken, /^[a-f0-9]{64}$/);
  context.registerSecret(job.forwardToken);
  const jobPath = await context.writeStateJson(`${label}/job.json`, job, 0o600);
  const child = context.spawnOwned(label, python, ['-B', '-I', adapter, jobPath], { cwd: state, env: octopEnvironment(context, state, options.network) });
  const frames = []; let pending = '', malformed = false;
  let complete = false;
  context.addCleanup(`retain Octop receipt ${task.id}`, async () => {
    if (!complete) await context.writeArtifactJsonInternal(`octop/${task.id}/cancelled-partial-public-frames.json`, {
      coverage: 'observed public frames only; no replay or upstream withdrawal claimed', frames,
    });
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending += chunk.toString('utf8');
    if (pending.length > 16 * 1024 * 1024) { malformed = true; child.kill('SIGTERM'); return; }
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('OCTOP_RESEARCH ')) continue;
      try { const frame = JSON.parse(line.slice(15)); frames.push(frame); options.onFrame?.(frame); }
      catch { malformed = true; child.kill('SIGTERM'); }
    }
  });
  const abort = () => child.kill('SIGTERM');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, budget.caseWallMs * budget.repeats + 90_000);
  const hardTimer = setTimeout(() => { context.stopOwned(label).catch(() => {}); }, budget.caseWallMs * budget.repeats + 100_000);
  let code;
  try { code = await new Promise((yes, no) => { child.once('error', () => no(Error('Owned Octop process failed to start'))); child.once('exit', yes); }); }
  finally { clearTimeout(timer); clearTimeout(hardTimer); options.signal?.removeEventListener('abort', abort); await context.stopOwned(label); }
  const ready = frames.find(frame => frame.type === 'ready');
  if (!ready || malformed || code !== 0) {
    await context.writeArtifactJson(`octop/${task.id}/partial-public-frames.json`, frames);
    throw Error('Octop adapter failed or did not settle; retained public partial evidence, no replay');
  }
  await context.writeArtifactJson(`octop/${task.id}/public-frames.json`, frames);
  complete = true;
  return { frames, ready, state };
}

export async function runOctopBaseline(context, model, task, budget, signal, root, options = {}) {
  if (budget.browser) throw Error('UNMET_PREREQUISITE: comparative research ceiling is native search/fetch only');
  let admitted = 0;
  const samples = new Map();
  const observer = await protectedModelForward(context, model, budget, { env: options.env,
    beforeForward() { if (++admitted > budget.maxResponses) throw Error('Per-sample model response budget exceeded'); } });
  let observationsSaved = false;
  context.addCleanup(`retain Octop model receipt ${task.id}`, async () => {
    await observer.stop();
    if (!observationsSaved) await context.writeArtifactJsonInternal(`octop/${task.id}/cancelled-model-observations.json`, observer.observations);
  });
  const network = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  // The owned lease uses loopback. Never let the child's provider connection use a host proxy.
  network.NO_PROXY = [network.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
  network.no_proxy = network.NO_PROXY;
  for (const [name, value] of Object.entries(network)) if (/proxy/i.test(name) && !/^no_proxy$/i.test(name)) context.registerSecret(value);
  let collected;
  try { collected = await runOctopProcess(context, root, task, model, budget, observer, { network, signal, runtimeFingerprint: options.runtimeFingerprint,
    onFrame(frame) {
      if (frame.type === 'sample_begin') { admitted = 0; samples.set(frame.repeat, { start: observer.observations.length }); }
      if (frame.type === 'sample_end') { const sample = samples.get(frame.repeat); if (sample) sample.end = observer.observations.length; }
    } }); }
  finally {
    await observer.stop();
    await context.writeArtifactJson(`octop/${task.id}/model-observations.json`, observer.observations);
    observationsSaved = true;
  }
  await context.writeArtifactJson(`octop/${task.id}/runtime-contract.json`, { ...collected.ready, stateRoot: 'owned_run_state_removed_on_cleanup',
    sourceRoot: await realpath(root), authentication: 'protected host API header; child gets per-run lease only', commonToolCeiling: 'search and fetch only',
    budget, initialization: 'owned marker fixture; no onboarding model request', retryPolicy: 'provider requests bounded by protected observer; product adapter retry behavior retained',
    prompt: 'exact frozen task text; default Octop research prompt and auto SearchFree routing', factualAcceptance: 'pending_two_independent_human_reviews' });
  return Array.from({ length: budget.repeats }, (_, repeat) => {
    const sample = samples.get(repeat);
    return withOctopProviderStops(analyzeOctopResearch(task, collected.frames, repeat),
      sample ? observer.observations.slice(sample.start, sample.end) : []);
  });
}

/** Resolve the selected API credential and installed embedded prerequisites before any paid group starts. */
export async function preflightOctopBaseline(context, model, budget, root, signal) {
  await octopResearchIdentity(context, root);
  const observer = await protectedModelForward(context, model, budget);
  try {
    const result = await runOctopProcess(context, root, { id: 'baseline-preflight', query: '' }, model, { ...budget, repeats: 1 }, observer, { mode: 'probe', signal });
    assert.equal(observer.observations.length, 0, 'Octop preflight must not invoke a model');
    return { octopVersion: result.ready.octopVersion, harnessVersion: result.ready.harnessVersion, searchPolicy: result.ready.searchPolicy,
      sourceIdentity: result.ready.sourceIdentity, runtimeFingerprint: result.ready.runtimeFingerprint, modelRequests: 0 };
  } finally { await observer.stop(); }
}

export async function probeOctopIsolation(context, root, endpoint = 'http://127.0.0.1:1') {
  const token = randomBytes(32).toString('hex');
  const model = { provider: 'owned-fixture', model: 'fixture-model', providerConfig: { api_format: 'anthropic_messages', context_window_tokens: 16384 } };
  return runOctopProcess(context, root, { id: 'owned-home-probe', query: '' }, model,
    { outputTokens: 512, repeats: 1, maxSearchCalls: 1, maxFetchCalls: 1, caseWallMs: 10_000, maxResponses: 1 },
    { endpoint, forwardToken: token }, { mode: 'probe' });
}
