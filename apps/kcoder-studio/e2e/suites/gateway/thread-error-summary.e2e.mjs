import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await runE2E(import.meta.url, { testId: 'safe-thread-error-summary-persists-and-respects-client-capability', tier: 'full-integration',
  modelPolicy: 'model-independent real provider failure, persisted attempt projection, capability routing and restart' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'error-summary' });
  const secret = 'synthetic-private-provider-detail'; context.registerSecret(secret);
  const fixture = await startApprovalModelFixture(context, { textOnly: true,
    httpErrorPrompt: 'FAIL_SUMMARY', httpErrorMatchLimit: 1, httpErrorStatus: 503, httpErrorMessage: secret });
  const home = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0, providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: fixture.baseUrl, default_model: 'fixture',
    context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024, no_proxy: true,
  } } });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const gateway = await startGateway(context, { workspace, kcoderBin: binary, env: { KCODER_CONFIG_DIR: home } });
  const url = gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway));
  const old = await openRpc(url); context.addCleanup('close legacy observer', () => old.close()); await initializeRpc(old, 'legacy-first');
  const connect = async () => {
    const rpc = await openRpc(url); context.addCleanup('close modern observer', () => rpc.close());
    await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'error-summary', version: '1' },
      capabilities: { experimental: { threadRunSummaryV1: true } } }); return rpc;
  };
  let rpc = await connect();
  const run = async prompt => {
    const { thread } = await rpc.request('thread/start');
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
    await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 15000, 'summary fixture terminal');
    return thread.id;
  };
  const failed = await run('FAIL_SUMMARY');
  const ordinary = await rpc.request('thread/read', { threadId: failed });
  const summary = ordinary.thread.runSummary;
  assert.equal(summary.recentError.kind, 'failed'); assert.equal(summary.recentError.source, 'provider');
  assert.equal(summary.recentError.category, 'provider'); assert.equal(summary.recentError.turnId, 'turn-1');
  assert.ok(!JSON.stringify(summary).includes(secret));
  assert.deepEqual(Object.keys(summary.recentError).sort(), ['atMs','attemptId','category','kind','source','turnId']);
  const indexed = await rpc.request('thread/read/indexed', { threadId: failed });
  assert.deepEqual(indexed.thread.runSummary.recentError, summary.recentError);
  const listed = await rpc.request('thread/list');
  assert.deepEqual(listed.threads.find(thread => thread.id === failed).runSummary.recentError, summary.recentError);
  const legacy = await old.request('thread/read', { threadId: failed });
  assert.equal(legacy.thread.runSummary, undefined); assert.equal(legacy.thread.status, 'idle');
  const successful = await run('SUCCESS_SUMMARY');
  assert.equal((await rpc.request('thread/read', { threadId: successful })).thread.runSummary.recentError, null);
  old.close();
  await rpc.request('gateway/app-server/restart', { confirm: true });
  rpc = await connect();
  const restored = await rpc.request('thread/read', { threadId: failed });
  assert.deepEqual(restored.thread.runSummary.recentError, summary.recentError);
  assert.equal(fixture.requests.length, 2, 'metadata reads never execute the model');
  return { safeMetadataOnly: true, ordinaryAndIndexedAgree: true, persistedAcrossRestart: true, legacyProjectionPreserved: true };
});
