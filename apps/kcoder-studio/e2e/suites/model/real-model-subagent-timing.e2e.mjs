import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLiveModelObserver } from '../../harness/live-model-observer.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { prepareIsolatedRealModelConfig, realModelPreflight } from '../../harness/real-model.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

function capOutput(config, maxTokens) {
  const bounded = { ...config, max_output_tokens: maxTokens };
  if (config.extra_body) {
    bounded.extra_body = { ...config.extra_body };
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) delete bounded.extra_body[key];
  }
  return bounded;
}

// Existing authenticated profiles use the approved store. An explicit anonymous deployment
// is confined to this RunContext and still passes the ordinary loader and consent preflight.
async function timingProfile(context) {
  const profile = process.env.KCODER_E2E_MODEL_PROFILE;
  if (process.env.KCODER_E2E_SUBAGENT_TIMING_NO_AUTH !== '1') {
    const model = await realModelPreflight(profile);
    return { model, configDir: (await prepareIsolatedRealModelConfig(context, model)).configDir };
  }
  assert.equal(process.env.KCODER_E2E_REAL_MODEL, '1', 'real model consent is required');
  const endpoint = process.env.KCODER_E2E_MODEL_ENDPOINT, name = process.env.KCODER_E2E_MODEL_NAME;
  assert.ok(profile && endpoint && name, 'declare the anonymous model, deployment and endpoint');
  const configDir = context.pathInState('real-model-config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, '.env'), '# Isolated anonymous model profile.\n', { mode: 0o600, flag: 'wx' });
  await context.writeStateJson('real-model-config/settings.json', { active_provider: profile,
    providers: { [profile]: { endpoint, default_model: name, authentication: { mode: 'none' },
      api_format: 'openai_chat_completions', chat_protocol: 'standard', no_proxy: true,
      context_window_tokens: 32768, output_headroom_tokens: 1024, max_output_tokens: 1024 } } }, 0o400);
  const env = context.isolatedEnvironment({ KCODER_CONFIG_DIR: configDir, KCODER_HOME: configDir,
    KCODER_E2E_REAL_MODEL: '1', KCODER_E2E_MODEL_PROFILE: profile, KCODER_E2E_MODEL_NAME: name,
    KCODER_E2E_MODEL_ENDPOINT: endpoint, KCODER_E2E_MODEL_API_FORMAT: 'openai_chat_completions',
    KCODER_E2E_KCODER_BIN: process.env.KCODER_E2E_KCODER_BIN,
    KCODER_E2E_ALLOW_INSECURE_REMOTE: process.env.KCODER_E2E_ALLOW_INSECURE_REMOTE });
  return { model: await realModelPreflight(profile, { env }), configDir };
}

async function timings(dir, model) {
  const files = await readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const facts = [];
  for (const file of files.filter(entry => entry.isFile() && entry.name.endsWith('.json'))) {
    const exchange = JSON.parse(await readFile(join(dir, file.name), 'utf8'));
    if (exchange.request?.model !== model || exchange.response?.error) continue;
    const t = exchange.timing, usage = exchange.response?.usage;
    if (!Number.isSafeInteger(t?.first_model_output_ms) || !Number.isSafeInteger(t.last_model_output_ms) || !usage) continue;
    facts.push({ firstOutputMs: t.first_model_output_ms, lastOutputMs: t.last_model_output_ms,
      streamMs: t.last_model_output_ms - t.first_model_output_ms, inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens, reasoningEffort: exchange.request_metadata?.reasoning_effort ?? null });
  }
  return facts;
}

await runE2E(import.meta.url, {
  testId: 'real-model-main-and-subagent-output-timing', tier: 'manual-live',
  modelPolicy: 'One real direct turn and one single foreground delegation using the same configured model. Capped output, no retry, test-owned history and numeric timing only.',
}, async context => {
  const { model, configDir } = await timingProfile(context);
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const maxTokens = 1024, maxRequests = 4;
  const provider = { ...capOutput(model.providerConfig, maxTokens), discover_models: false, request_timeout_secs: 45, max_retries: 0 };
  // A legacy single-model profile inherits all limits from the provider. Adding a
  // partial model record would give it a zero context window and mask the valid limits.
  if (provider.models?.[model.model]) {
    provider.models = { [model.model]: capOutput(provider.models[model.model], maxTokens) };
  }
  const observer = await startLiveModelObserver(context, provider.endpoint, maxRequests, {
    requestTimeoutMs: 45000,
    beforeForward({ model: requested, outputTokenLimit }) {
      assert.equal(requested, model.model);
      assert.ok(Number.isSafeInteger(outputTokenLimit) && outputTokenLimit > 0 && outputTokenLimit <= maxTokens);
    },
  });
  const settingsFile = await context.writeStateJson('real-model-config/rate-settings.json', {
    active_provider: model.provider, providers: { [model.provider]: { ...provider, endpoint: observer.endpoint, no_proxy: true } },
    permission_mode: 'yolo', max_retries: 0, max_tokens: maxTokens, max_duration_secs: 60,
    default_subagent_max_turns: 1, tools: { profile: 'full', studio: { kcoder: ['spawn_agent'] } },
    allowed_tools: ['spawn_agent'], auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
  }, 0o400);
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'timing', label: 'Owned timing run',
    command: model.kcoderBin, runtime: 'kcoder', transport: 'local', workspace, settingsFile }]);
  const credentials = Object.fromEntries(model.credentialEnv.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: model.kcoderBin, env: {
    ...credentials, KCODER_HOME: configDir, KCODER_CONFIG_DIR: configDir, KCODER_TRAINING_MODE: 'true',
    KCODER_MAX_TOKENS: String(maxTokens), KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '60',
  } });
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'timing', await waitForGatewayRpcToken(context, gateway)));
  context.addCleanup('close timing client', () => closeRpcAndWait(rpc, 'owned timing client'));
  await initializeRpc(rpc, 'real-model-timing');
  const marker = `RATE_${randomBytes(5).toString('hex')}`;
  const assignment = `Reply with the marker ${marker}, then list the numbers 1 to 30. Do not use tools.`;
  const run = async (stage, prompt) => {
    const threadId = (await rpc.request('thread/start', { cwd: workspace })).thread.id;
    const turnId = (await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })).turn.id;
    const done = await rpc.waitFor(frame => frame.method === 'turn/completed' && frame.params?.threadId === threadId &&
      frame.params?.turnId === turnId, 65000, 'capped real turn');
    if (done.params.turn.status !== 'completed') {
      const details = JSON.stringify(done.params.error ?? done.params.turn.error ?? {});
      const classification = details.match(/(?:HTTP\s+\d{3}|credential|connect|authentication|context.window|rate.limit|timed?.out|budget|token.limit|socket)/ig) ?? [];
      const requests = observer.observations.map(row => ({ status: row.status, model: row.model, outputLimit: row.outputTokenLimit }));
      await context.writeArtifactJson('real-model-timing-failure.json', {
        stage, provider: model.provider, model: model.model, status: done.params.turn.status, classification, requests,
      });
      throw new Error(`Real ${stage} ${model.model} turn ${done.params.turn.status} (${[...new Set(classification)].join(', ') || 'no classified cause'}; HTTP ${requests.map(row => row.status).join('/') || 'no response'})`);
    }
    return threadId;
  };
  const mainId = await run('direct', assignment);
  const delegatedId = await run('delegation', `Call spawn_agent once, with agent_type "general", context_mode "none" and run_in_background false. Pass exactly this task in message: "${assignment}" Wait for its foreground result, then return the marker from it.`);
  const children = (await rpc.request('agent/list', { threadId: delegatedId })).agents;
  assert.equal(children.length, 1);
  assert.equal(children[0].status, 'completed');
  const childId = children[0].agentId;
  const output = await rpc.request('agent/artifact/read', { threadId: delegatedId, agentId: childId, kind: 'output', limit: 8192 });
  assert.ok(output.content.includes(marker), 'the real child independently completed the marker task');
  assert.ok(rpc.messages().filter(f => f.method === 'item/delta' && f.params.threadId === mainId)
    .map(f => f.params.delta?.text ?? '').join('').includes(marker), 'the direct model completed the same marker task');
  const projects = join(configDir, 'projects');
  const paired = await waitFor(async () => {
    for (const project of await readdir(projects, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const root = join(projects, project.name);
      const direct = await timings(join(root, mainId, 'llm-requests'), model.model);
      const child = await timings(join(root, delegatedId, 'subagents', childId, 'llm-requests'), model.model);
      if (direct.length && child.length) return { direct, child };
    }
    return null;
  }, 5000, 'both completed real exchanges written by the Engine');
  assert.equal(paired.direct.length, 1);
  assert.equal(paired.child.length, 1);
  assert.equal(paired.direct[0].reasoningEffort, paired.child[0].reasoningEffort);
  const completedRequests = observer.observations.filter(row => row.status === 200);
  const facts = { provider: model.provider, model: model.model, limits: { outputTokens: maxTokens, requests: maxRequests },
    providerRequests: completedRequests.length,
    usage: { outputTokens: completedRequests.every(row => Number.isSafeInteger(row.outputUsage))
      ? completedRequests.reduce((sum, row) => sum + row.outputUsage, 0) : null },
    direct: paired.direct[0], child: paired.child[0], samplePairs: 1 };
  await context.writeArtifactJson('real-model-timing.json', facts);
  return facts;
});
