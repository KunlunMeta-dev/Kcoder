import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startCredentialObserver } from '../../harness/credential-observer.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'failed-turn-model-snapshot-across-process-restart', tier: 'full-integration',
  modelPolicy: 'model-independent actual HTTP credentials, frozen semantics and tool effects; no paid model',
}, async context => {
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
  await context.writeArtifactJson('binary.json', { path: binary, sha256: createHash('sha256').update(await readFile(binary)).digest('hex') });
  const results = [];
  for (const mode of ['rotate', 'revoke', 'current']) {
    const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: mode });
    const prompt = `SNAPSHOT_${mode}`;
    const fixture = await startApprovalModelFixture(context, {
      sessionApprovalPrompt: prompt, sessionApprovalCount: 1,
      sessionApprovalCommand: 'printf x >> snapshot-tool-count.txt', sessionApprovalFinalText: 'SNAPSHOT_FINISHED',
      httpErrorPrompt: prompt, httpErrorAfterToolResults: 1, httpErrorMatchLimit: 1, httpErrorStatus: 503,
    });
    const oldKey = randomBytes(24).toString('hex'); const newKey = randomBytes(24).toString('hex');
    context.registerSecret(oldKey); context.registerSecret(newKey);
    const observer = await startCredentialObserver(context, fixture.baseUrl, { label: `auth-${mode}`, oldKey, newKey });
    const home = context.pathInState(`${mode}-config`);
    const limits = { context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024 };
    const settings = { active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0,
      providers: { fixture: { api_format: 'openai_chat_completions', endpoint: observer.endpoint,
        default_model: 'original-model', no_proxy: true, ...limits,
        models: { 'original-model': { ...limits, extra_body: { temperature: 0.2 } } } } } };
    settings.providers.replacement = { api_format: 'openai_chat_completions', endpoint: observer.endpoint,
      default_model: 'replacement-model', no_proxy: true, ...limits, extra_body: { temperature: 0.7 } };
    settings.providers.incompatible = { ...settings.providers.replacement, default_model: 'text-only', capabilities: { text: true, tools: false, vision: false, reasoning: false } };
    await context.writeStateJson(`${mode}-config/settings.json`, settings);
    await context.writeStateJson(`${mode}-config/credentials.json`, {
      fixture: { type: 'api', key: oldKey }, replacement: { type: 'api', key: newKey },
    });
    const serversFile = await context.writeStateJson(`${mode}-servers.json`, [{ id: 'fixture', label: 'Snapshot fixture', transport: 'local', command: binary, workspace }]);
    const gateway = await startGateway(context, { label: `gateway-${mode}`, workspace, serversFile, kcoderBin: binary,
      env: { KCODER_CONFIG_DIR: home, KCODER_MAX_RETRIES: '0' } });
    const token = await waitForGatewayRpcToken(context, gateway);
    const connect = async () => {
      const client = await openRpc(gatewayRpcUrl(gateway, 'fixture', token));
      context.addCleanup(`close snapshot ${mode} RPC`, () => client.close());
      await initializeRpc(client, 'model-snapshot-restart'); return client;
    };
    let rpc = await connect();
    const { thread } = await rpc.request('thread/start');
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
    const failed = await rpc.waitFor(m => m.method === 'turn/completed' && m.params?.threadId === thread.id && m.params?.turnId === turn.id, 30000, 'initial snapshot failure');
    assert.equal(failed.params.turn.status, 'failed');
    const started = await rpc.waitFor(m => m.method === 'turn/started' && m.params?.threadId === thread.id && m.params?.turn?.id === turn.id, 1000, 'initial attempt identity');
    assert.equal(typeof started.params.attemptId, 'string');
    assert.deepEqual(observer.authentication, ['old', 'old']);
    settings.providers.fixture.endpoint = fixture.baseUrl;
    settings.providers.fixture.default_model = 'new-default';
    settings.providers.fixture.models['original-model'].extra_body.temperature = 0.9;
    settings.providers.fixture.models['new-default'] = { ...limits, extra_body: { temperature: 0.8 } };
    const nextSettings = await context.writeStateJson(`${mode}-config/next-settings.json`, settings);
    await rename(nextSettings, resolve(home, 'settings.json'));
    const nextCredentials = await context.writeStateJson(`${mode}-config/next-credentials.json`, {
      fixture: mode !== 'revoke' ? { type: 'api', key: newKey } : { type: 'revoked' },
      replacement: { type: 'api', key: newKey },
    });
    await rename(nextCredentials, resolve(home, 'credentials.json'));
    assert.equal((await rpc.request('gateway/app-server/restart', { confirm: true })).stopped, true);
    rpc.close(); rpc = await connect();
    await rpc.request('thread/resume', { threadId: thread.id });
    const params = { threadId: thread.id, retryFromTurnId: turn.id, retryFromAttemptId: started.params.attemptId,
      retryOperationId: `snapshot-${mode}`, input: [] };
    if (mode === 'revoke') {
      await assert.rejects(rpc.request('turn/start', params));
      assert.deepEqual(observer.authentication, ['old', 'old']);
      assert.equal(fixture.requests.length, 2);
      const incompatible = { ...params, retryModelConfiguration: 'current', model: 'incompatible::text-only' };
      await assert.rejects(rpc.request('turn/start', incompatible), /retry_model_incompatible: tools/);
      assert.equal(fixture.requests.length, 2, 'rejected current attempt must not send HTTP');
      const replacementParams = { ...params, retryModelConfiguration: 'current', model: 'replacement::replacement-model' };
      const replacement = await rpc.request('turn/start', replacementParams);
      const done = await rpc.waitFor(m => m.method === 'turn/completed' && m.params?.threadId === thread.id && m.params?.turnId === replacement.turn.id, 30000, 'explicit replacement after revocation');
      assert.equal(done.params.turn.status, 'completed');
      assert.deepEqual(observer.authentication, ['old', 'old', 'new']);
      assert.equal(fixture.requests.at(-1).model, 'replacement-model');
      assert.equal(fixture.requests.at(-1).temperature, 0.7);
      const receipt = await rpc.request('turn/start', replacementParams);
      assert.equal(receipt.turn.attemptId, replacement.turn.attemptId);
      assert.equal(fixture.requests.length, 3, 'receipt replay must not run model again');
      await assert.rejects(rpc.request('turn/start', { ...replacementParams, retryModelConfiguration: 'snapshot' }), /conflicts/);
    } else {
      const retry = await rpc.request('turn/start', mode === 'current' ? { ...params, model: 'fixture::original-model', retryModelConfiguration: 'current' } : params);
      const done = await rpc.waitFor(m => m.method === 'turn/completed' && m.params?.threadId === thread.id && m.params?.turnId === retry.turn.id, 30000, 'restored frozen model completion');
      await context.writeArtifactJson(`${mode}-observations.json`, { authentication: observer.authentication,
        requests: fixture.requests.map(request => ({ model: request.model, temperature: request.temperature })) });
      assert.equal(done.params.turn.status, 'completed');
      assert.deepEqual(observer.authentication, mode === 'current' ? ['old', 'old'] : ['old', 'old', 'new']);
      assert.equal(fixture.requests.at(-1).model, 'original-model');
      assert.equal(fixture.requests.at(-1).temperature, mode === 'current' ? 0.9 : 0.2);
      assert.equal(fixture.requests.at(-1).messages.filter(message => message.role === 'tool').length, 1);
    }
    assert.equal(await readFile(resolve(workspace, 'snapshot-tool-count.txt'), 'utf8'), 'x');
    const snapshots = (await readdir(home, { recursive: true })).filter(name => name.endsWith('.model.json'));
    assert.equal(snapshots.length, 2);
    for (const name of snapshots) {
      const contents = await readFile(resolve(home, name), 'utf8');
      assert.ok(!contents.includes(oldKey) && !contents.includes(newKey), 'durable model snapshots must not contain API keys');
    }
    results.push({ mode, authentication: observer.authentication, modelRequests: fixture.requests.length, toolExecutions: 1 });
    await rpc.request('thread/delete', { threadId: thread.id }); rpc.close();
  }
  return { results };
});
