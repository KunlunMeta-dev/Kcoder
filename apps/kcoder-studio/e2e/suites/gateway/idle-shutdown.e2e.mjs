import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'gateway-idle-shutdown-and-resume', tier: 'full-integration',
  modelPolicy: 'model-independent deterministic lifecycle and persisted-history check',
}, async context => {
  const kcoderBin = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'idle-shutdown' });
  const configDir = context.pathInState('config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson('config/settings.jsonc', {});
  const serversFile = await context.writeStateJson('servers.jsonc', [{ id: 'local', label: 'Local', transport: 'local', command: kcoderBin, workspace }]);
  const gateway = await startGateway(context, { kcoderBin, workspace, serversFile, env: {
    KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_SCENARIO: 'full-turn', KCODER_STUDIO_APP_SERVER_IDLE_MS: '250',
  } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const connect = async label => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
    context.addCleanup(`close ${label} RPC`, () => rpc.close());
    await initializeRpc(rpc, label);
    return rpc;
  };
  const alive = pid => {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const first = await connect('idle-owner');
  const started = await first.request('thread/start', {});
  const threadId = started.thread.id;
  const turn = await first.request('turn/start', { threadId, input: [{ type: 'text', text: 'deterministic lifecycle fixture' }] });
  await first.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.turn.id, 20_000, 'fixture turn completion');
  const before = await first.request('server/resources/read');
  const history = await first.request('thread/read', { threadId });
  assert.ok(Array.isArray(history.messages) && history.messages.length > 0, 'fixture must have visible history');
  const scheduled = await first.request('cron/create', { prompt: 'future lifecycle fixture', confirmed: true,
    schedule: { kind: 'every', every_seconds: 3600 }, jitterSeconds: 0 });
  await assert.rejects(first.request('server/shutdown/idle', { instanceId: before.instanceId }), /lifecycle owner/);
  first.close();
  await waitFor(() => first.socket.readyState === 3, 5_000, 'owner socket closed');
  const protectedUntil = Date.now() + 900;
  await waitFor(() => { assert.ok(alive(before.processId), 'scheduled work must protect process'); return Date.now() >= protectedUntil; }, 2_000, 'protected idle grace');
  const second = await connect('idle-cleaner');
  assert.equal((await second.request('server/resources/read')).instanceId, before.instanceId);
  await second.request('cron/delete', { jobId: scheduled.job.id });
  await context.writeArtifactJson('before-idle.json', await second.request('server/resources/read'));
  second.close();
  await waitFor(() => second.socket.readyState === 3, 5_000, 'cleaner socket closed');
  await waitFor(() => !alive(before.processId), 15_000, 'actual app-server exit', 50, context.abortSignal);
  const third = await connect('idle-resumer');
  const after = await third.request('server/resources/read');
  assert.notEqual(after.instanceId, before.instanceId);
  assert.equal((await third.request('thread/resume', { threadId })).thread.id, threadId);
  const restored = await third.request('thread/read', { threadId });
  assert.deepEqual(restored.messages, history.messages);
  third.close();
  await waitFor(() => !alive(after.processId), 15_000, 'resumed backend idle exit', 50, context.abortSignal);
  return { protectedScheduledWork: true, oldProcessExited: true, newInstance: true, historyPreserved: true };
});
