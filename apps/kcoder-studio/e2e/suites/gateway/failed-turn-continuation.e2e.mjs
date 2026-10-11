import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'failed-turn-continues-committed-tools-after-restart', tier: 'full-integration',
  modelPolicy: 'model-independent loopback fixture; real tool, persistence and continuation',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'continue' });
  const prompt = 'CONTINUE_ONCE_FIXTURE';
  const fixture = await startApprovalModelFixture(context, {
    sessionApprovalPrompt: prompt, sessionApprovalCount: 1,
    sessionApprovalCommand: "printf x >> continuation-count.txt",
    sessionApprovalFinalText: 'CONTINUATION_FINISHED',
    httpErrorPrompt: prompt, httpErrorAfterToolResults: 1, httpErrorMatchLimit: 1,
    httpErrorStatus: 503,
  });
  const key = `fixture-${randomBytes(16).toString('hex')}`;
  context.registerSecret(key);
  const home = context.pathInState('config');
  await context.writeStateJson('config/settings.json', {
    active_provider: 'fixture', permission_mode: 'yolo', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: fixture.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 64000,
      max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } },
  });
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const binary = resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'fixture', label: 'Continue fixture',
    transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: home, KCODER_MAX_RETRIES: '0', KCODER_MAX_DURATION_SECS: '30' } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const connect = async () => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'fixture', token));
    context.addCleanup('close continuation RPC', () => rpc.close());
    await initializeRpc(rpc, 'failed-turn-continuation');
    return rpc;
  };
  let rpc = await connect();
  const { thread } = await rpc.request('thread/start', {});
  const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
  const failed = await rpc.waitFor(m => m.method === 'turn/completed' && m.params?.turnId === turn.id, 45000, 'failure after tool');
  assert.equal(failed.params.turn.status, 'failed');
  assert.equal(await readFile(resolve(workspace, 'continuation-count.txt'), 'utf8'), 'x');
  assert.equal(fixture.requests.length, 2);
  await rpc.request('gateway/app-server/restart', { confirm: true });
  rpc.close(); rpc = await connect();
  await rpc.request('thread/resume', { threadId: thread.id });
  await assert.rejects(rpc.request('turn/start', { threadId: thread.id, retryFromTurnId: 'turn-999', input: [] }));
  await assert.rejects(rpc.request('turn/start', { threadId: thread.id, retryFromTurnId: turn.id, input: [{ type: 'text', text: 'do it again' }] }));
  const resumed = await rpc.request('turn/start', { threadId: thread.id, retryFromTurnId: turn.id, input: [] });
  assert.equal(resumed.turn.id, turn.id);
  const done = await rpc.waitFor(m => m.method === 'turn/completed' && m.params?.turnId === turn.id, 45000, 'continued completion');
  assert.equal(done.params.turn.status, 'completed');
  assert.equal(fixture.requests.length, 3);
  const request = fixture.requests.at(-1);
  assert.equal(request.messages.filter(m => m.role === 'user' && JSON.stringify(m.content).includes(prompt)).length, 1);
  assert.equal(request.messages.filter(m => m.role === 'tool').length, 1);
  assert.equal(await readFile(resolve(workspace, 'continuation-count.txt'), 'utf8'), 'x');
  const repeated = await rpc.request('turn/start', { threadId: thread.id, retryFromTurnId: turn.id, input: [] });
  assert.equal(repeated.turn.id, resumed.turn.id, 'duplicate continuation returns the accepted attempt');
  assert.equal(fixture.requests.length, 3, 'replaying the receipt must not issue another model request');
  assert.equal(await readFile(resolve(workspace, 'continuation-count.txt'), 'utf8'), 'x');
  const history = await rpc.request('thread/read', { threadId: thread.id });
  assert.ok(JSON.stringify(history).includes('CONTINUATION_FINISHED'));
  await rpc.request('thread/delete', { threadId: thread.id });
  return { toolExecutions: 1, providerRequests: 3, continuedAfterRestart: true, duplicateUserInputs: 0 };
});
