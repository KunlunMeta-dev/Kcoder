import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../harness/real-model.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { createPrefireObserver, diagnoseRecall, diagnoseCompactionMarker } from './prefire-observer.mjs';

await runE2E(import.meta.url, { testId: 'real-model-prefire-reuse-cost',
  tier: 'credentialed-integration', modelPolicy: 'real-model-required' }, async context => {
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || 'kunlunmeta');
  assert.equal(model.model, 'MiniMax-M3', 'this bounded experiment is approved only for MiniMax-M3');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'prefire' });
  const isolated = await prepareIsolatedRealModelConfig(context, model, { summaryMaxTokens: 2048 });
  const settings = JSON.parse(await readFile(isolated.settingsFile, 'utf8'));
  const settingsFile = await context.writeStateJson('real-model-config/settings_prefire.jsonc', {
    ...settings, max_retries: 0, max_tokens: 2048,
    // The explicit CLI profile applies its runtime defaults after the overlay.
    providers: { [model.provider]: { ...model.providerConfig,
      auto_compact_threshold_tokens: 18000, max_output_tokens: 2048, max_retries: 0 } },
    prefire_threshold_tokens: 8000, auto_compact_threshold_tokens: 18000,
    session_memory: { enabled: false, update_enabled: false, compact_enabled: false },
  }, 0o400);
  const configOptions = {
    cwd: workspace, env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: isolated.configDir }), timeout: 15000,
  };
  const configFlags = ['--settings-file', settingsFile, '--profile', model.profile];
  await promisify(execFile)(model.kcoderBin, ['config', 'validate', ...configFlags], configOptions)
    .catch(() => { throw new Error('isolated prefire settings validation failed before provider access'); });
  for (const [field, expected] of [['auto_compact_threshold_tokens', 18000], ['prefire_threshold_tokens', 8000]]) {
    const { stdout } = await promisify(execFile)(model.kcoderBin, ['config', 'get', field, ...configFlags], configOptions)
      .catch(() => { throw new Error('effective prefire threshold inspection failed before provider access'); });
    assert.equal(JSON.parse(stdout), expected, `effective ${field} must match the experiment before provider access`);
  }
  const serversFile = await context.writeStateJson('servers.jsonc', [{ id: 'prefire', label: 'Prefire',
    transport: 'local', command: model.kcoderBin, workspace, settingsFile, profile: model.profile }]);
  const credentialEnv = Object.fromEntries(model.credentialEnv.filter(name => process.env[name])
    .map(name => [name, process.env[name]]));
  const gateway = await startGateway(context, { workspace, serversFile, env: {
    KCODER_CONFIG_DIR: isolated.configDir, KCODER_TRAINING_MODE: 'false',
    KCODER_MAX_TOKENS: '2048', KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '90',
    RUST_LOG: 'warn,kcoder::transport_metrics=debug,kcoder_engine::compaction_runtime=debug',
    ...credentialEnv,
  } });
  const observer = createPrefireObserver();
  const onDiagnostic = chunk => observer.consume(chunk);
  gateway.child.stderr.on('data', onDiagnostic);
  context.addCleanup('detach numeric prefire observer', () => gateway.child.stderr.off('data', onDiagnostic));
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'prefire', await waitForGatewayRpcToken(context, gateway)));
  context.addCleanup('close prefire RPC', () => rpc.close());
  await initializeRpc(rpc, 'prefire-measurement');
  const { thread } = await rpc.request('thread/start');
  const initialRegisteredPrefires = (await rpc.request('server/resources/read')).activity?.registeredPrefires ?? null;
  const startedAt = Date.now(), deadline = startedAt + 300000;
  const remaining = () => { assert.ok(Date.now() < deadline, 'model-stage budget exhausted'); return Math.min(120000, deadline - Date.now()); };
  const observations = [], durations = [];
  let quality = null;
  const metrics = () => observer.snapshot().attempts;
  const firstDeltaAt = new Map();
  const onDelta = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'item/delta' && typeof message.params?.turnId === 'string'
      && !firstDeltaAt.has(message.params.turnId)) firstDeltaAt.set(message.params.turnId, Date.now());
  };
  rpc.socket.addEventListener('message', onDelta);
  context.addCleanup('detach prefire first-delta observer', () => rpc.socket.removeEventListener('message', onDelta));
  async function turn(prompt) {
    const start = Date.now();
    const response = await rpc.request('turn/start', { threadId: thread.id,
      input: [{ type: 'text', text: prompt }] }, remaining());
    const id = response.turn.id;
    const completed = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === id,
      remaining(), 'prefire foreground completion');
    assert.equal(completed.params?.turn?.status, 'completed');
    const messages = rpc.messages().filter(message => message.params?.turnId === id);
    assert.ok(!messages.some(message => message.method === 'item/started' && message.params?.item?.type === 'toolCall'),
      'fixture must not invoke business tools or subagents');
    assert.ok(firstDeltaAt.has(id), 'completed foreground must expose a visible response delta');
    durations.push({ totalMs: Date.now() - start, firstDeltaMs: firstDeltaAt.get(id) - start });
    const text = messages.filter(message => message.method === 'item/delta').map(message => message.params?.delta?.text || '').join('');
    return { text, messages };
  }
  const marker = `FILE_${randomBytes(6).toString('hex')}.db`;
  async function boundaryEvidence(directory) {
    const records = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) records.push(...await boundaryEvidence(path));
      else if (entry.isFile() && entry.name === `${thread.id}.jsonl`) {
        records.push(...(await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line)));
      }
    }
    return records;
  }
  try {
    for (const prompt of [
      `不要调用工具。请记住禁止删除 ${marker}。只回复ACK，不复述文件名或操作约束。下文是无用填充：\n${'filler '.repeat(6000)}`,
      '不要调用工具，不复述之前的信息，只回复ACK。',
      '不要调用工具，不复述之前的信息，继续只回复ACK。',
    ]) {
      assert.ok((await turn(prompt)).text.trim() === 'ACK', 'fixture_contamination: retained answers must contain no fact or permission');
    }
    await waitFor(async () => {
      const state = observer.snapshot();
      assert.ok(!state.failed, 'background prefire failed; no silent full-pass fallback');
      return state.completed && state.covered > 0;
    }, remaining(), 'real background prefire completion', 100, context.abortSignal);
    const before = await metrics();
    observations.push({ phase: 'prefire-ready', attempts: before });
    const prefireAttempts = before.length - 3;
    assert.ok(prefireAttempts >= 1 && prefireAttempts <= 3,
      'prefire must use one initial attempt and at most two protocol repairs');
    const result = await turn(`不要调用工具。以下新填充同样无需保留：\n${'filler '.repeat(6000)}\n根据最初记录，返回该文件的文件名及是否允许删除。只输出JSON对象，字段filename为字符串、can_delete为布尔值；信息缺失时对应字段填null，不要猜测。`);
    const notice = result.messages.find(message => message.method === 'item/event'
      && message.params?.event?.type === 'system_notice'
      && message.params?.event?.text?.includes('background prefire reused'));
    const count = notice?.params.event.text.match(/(\d+) -> (\d+)/);
    const contextBefore = count ? Number(count[1]) : null, contextAfter = count ? Number(count[2]) : null;
    quality = { reused: Boolean(notice), ...diagnoseRecall(result.text, marker),
      contextBefore, contextAfter,
      ...diagnoseCompactionMarker(await boundaryEvidence(join(isolated.configDir, 'projects')), marker) };
    assert.ok(quality.reused, 'automatic compaction must explicitly report reusing prefire, not merely completing it');
    assert.ok(quality.summaryMarker === true && quality.tailMarker === false, 'recall marker must exist in summary, not retained tail');
    assert.ok(quality.schemaValid, 'malformed_output: neutral recall response does not match the JSON schema');
    assert.ok(quality.filenameExactMatch, 'filename_lost: neutral recall does not match the original file');
    assert.ok(quality.canDeleteIsFalse, 'permission_lost: neutral recall does not retain the original restriction');
    const final = await metrics();
    observations.push({ phase: 'automatic-compaction-and-recall', attempts: final });
    // This is an observation gate, not a provider-side hard request quota.
    // The single synchronous compactor owns PTL (3), transport (2), protocol (2)
    // retries and at most one schema fallback; these counters add, not multiply.
    assert.ok(final.length <= before.length + 10,
      'automatic compaction exceeded one foreground plus nine summary attempts');
    assert.ok(final.every(item => item.status === 200 && item.input !== null && item.output !== null), 'real successful usage must be observable');
    assert.ok(Number.isSafeInteger(contextBefore) && Number.isSafeInteger(contextAfter)
      && contextAfter > 0 && contextAfter < contextBefore, 'automatic compaction must report a real context reduction');
    return { providerProfile: model.profile, model: model.model, reused: true, constraintRetained: true,
      foregroundTurns: 4, observedTransportAttempts: final.length, additionalAttempts: final.length - 4,
      prefireAttempts, prefireCoveredMessages: observer.snapshot().covered,
      measurementBudget: { foregroundTurns: 4, prefireMaxAttempts: 3, synchronousSummaryMaxAttempts: 9,
        perRequestOutputLimit: 2048, modelStageWallMs: 300000 },
      contextBefore, contextAfter, durations, attempts: final,
      durationMs: Date.now() - startedAt,
      scope: 'single warmed-prefix automatic-compaction run; attempt checks are post-run observations, not a hard request quota; no baseline speedup, long-run hit rate, currency cost or all-background-domain claim; transport observations exclude uninstrumented count/calibration endpoints' };
  } finally {
    const registeredPrefiresBeforeShutdown = await rpc.request('server/resources/read', {}, 5000)
      .then(value => value.activity?.registeredPrefires ?? null).catch(() => null);
    const beforeShutdown = observer.snapshot();
    rpc.close();
    try { await context.stopOwned('gateway'); }
    finally {
      gateway.child.stderr.off('data', onDiagnostic);
      await context.writeArtifactJson('phase-metrics.json', { observations, durations, quality,
        initialRegisteredPrefires, registeredPrefiresBeforeShutdown,
        knownAttemptsBeforeShutdown: beforeShutdown.attempts.length,
        httpRequestsStarted: null,
        shutdownScope: 'observed completions/drops through owned process shutdown; no start-counter instrumentation, so missing or killed attempts remain unknown',
        ...observer.snapshot() });
    }
  }
});
