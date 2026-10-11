import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// F06 is a transport/credential/persistence test, not a model-quality test.
await runE2E(import.meta.url, {
  testId: 'failed-turn-current-credentials-without-tool-replay', tier: 'full-integration',
  modelPolicy: 'model-independent loopback fixture; actual HTTP authentication, tool and continuation',
}, async context => {
  const results = [];
  for (const mode of ['rotate', 'revoke']) {
    const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: mode });
    const prompt = `F06_CREDENTIAL_${mode}`;
    const fixture = await startApprovalModelFixture(context, {
      sessionApprovalPrompt: prompt, sessionApprovalCount: 1,
      sessionApprovalCommand: 'printf x >> credential-tool-count.txt',
      sessionApprovalFinalText: 'F06_FINISHED',
      httpErrorPrompt: prompt, httpErrorAfterToolResults: 1, httpErrorMatchLimit: 1,
      httpErrorStatus: 503,
    });
    const oldKey = `fixture-${randomBytes(16).toString('hex')}`;
    const newKey = `fixture-${randomBytes(16).toString('hex')}`;
    context.registerSecret(oldKey); context.registerSecret(newKey);
    // Never retain raw headers or keys in evidence; classify in memory only.
    const authStates = [];
    const active = new Set();
    const proxy = createServer((request, response) => {
      const handler = (async () => {
        authStates.push(request.headers.authorization === `Bearer ${oldKey}` ? 'old'
          : request.headers.authorization === `Bearer ${newKey}` ? 'new' : 'unexpected');
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) throw new Error('fixture body exceeds bound');
          chunks.push(chunk);
        }
        const upstream = await fetch(new URL(request.url, fixture.baseUrl), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: Buffer.concat(chunks), signal: AbortSignal.timeout(15000),
        });
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') });
        response.end(await upstream.text());
      })().catch(() => { response.destroy(); });
      active.add(handler); void handler.finally(() => active.delete(handler));
    });
    await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen));
    context.registerPort(`f06-auth-${mode}`, proxy.address().port);
    context.addCleanup(`close F06 authentication proxy ${mode}`, async () => {
      const stopped = new Promise(resolveClose => proxy.close(resolveClose));
      proxy.closeAllConnections(); await Promise.allSettled([...active]); await stopped;
    });
    const home = context.pathInState(`${mode}-config`);
    await context.writeStateJson(`${mode}-config/settings.json`, {
      active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0,
      providers: { fixture: { api_format: 'openai_chat_completions',
        endpoint: `http://127.0.0.1:${proxy.address().port}/v1`, default_model: 'fixture-model',
        context_window_tokens: 64000, max_output_tokens: 1024, no_proxy: true,
        models: { 'fixture-model': { context_window_tokens: 64000, output_headroom_tokens: 1024,
          max_output_tokens: 1024, extra_body: { temperature: 0.2 } } } } },
    });
    await context.writeStateJson(`${mode}-config/credentials.json`, { fixture: { type: 'api', key: oldKey } });
    const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
    const serversFile = await context.writeStateJson(`${mode}-servers.json`, [{ id: 'fixture', label: 'F06 fixture',
      transport: 'local', command: binary, workspace }]);
    const gateway = await startGateway(context, { label: `gateway-${mode}`, workspace, serversFile, kcoderBin: binary,
      env: { KCODER_CONFIG_DIR: home, KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '30' } });
    const token = await waitForGatewayRpcToken(context, gateway);
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'fixture', token));
    context.addCleanup(`close F06 RPC ${mode}`, () => rpc.close());
    await initializeRpc(rpc, 'failed-turn-credentials');
    const { thread } = await rpc.request('thread/start', {});
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
    const failed = await rpc.waitFor(m => m.method === 'turn/completed' && m.params?.turnId === turn.id, 30000, 'initial F06 failure');
    assert.equal(failed.params.turn.status, 'failed');
    assert.deepEqual(authStates, ['old', 'old']);
    const updatedCredentials = await context.writeStateJson(`${mode}-config/credentials-next.json`, {
      fixture: mode === 'rotate' ? { type: 'api', key: newKey } : { type: 'revoked' },
    });
    await rename(updatedCredentials, resolve(home, 'credentials.json'));
    const editedSettings = JSON.parse(await readFile(resolve(home, 'settings.json'), 'utf8'));
    editedSettings.providers.fixture.models['fixture-model'].extra_body.temperature = 0.9;
    const updatedSettings = await context.writeStateJson(`${mode}-config/settings-next.json`, editedSettings);
    await rename(updatedSettings, resolve(home, 'settings.json'));
    let retryStatus;
    const retryParams = { threadId: thread.id, retryFromTurnId: turn.id,
      retryOperationId: `f06-${mode}`, input: [] };
    if (mode === 'revoke') {
      // Revocation is rejected before a new attempt is admitted. There is no
      // accepted turn/completed pair to wait for, and the old key must not be used.
      await assert.rejects(rpc.request('turn/start', retryParams), /credential.*(?:removed|revoked|source changed)/i);
      retryStatus = 'rejected';
    } else {
      const retry = await rpc.request('turn/start', retryParams);
      assert.equal(retry.turn.id, turn.id);
      const done = await rpc.waitFor(m => m !== failed && m.method === 'turn/completed' && m.params?.turnId === turn.id, 30000, 'F06 retry outcome');
      assert.equal(done.params.turn.status, 'completed');
      retryStatus = done.params.turn.status;
    }
    assert.deepEqual(authStates, mode === 'rotate' ? ['old', 'old', 'new'] : ['old', 'old']);
    assert.equal(await readFile(resolve(workspace, 'credential-tool-count.txt'), 'utf8'), 'x');
    if (mode === 'rotate') {
      assert.equal(fixture.requests.at(-1).temperature, 0.2);
      assert.equal(fixture.requests.at(-1).messages.filter(m => m.role === 'tool').length, 1);
    }
    await rpc.request('thread/delete', { threadId: thread.id });
    rpc.close();
    results.push({ mode, authentication: authStates, toolExecutions: 1, status: retryStatus });
  }
  return { results };
});
