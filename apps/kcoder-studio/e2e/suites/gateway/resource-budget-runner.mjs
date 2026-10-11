import assert from 'node:assert/strict';
import { mkdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';

export async function verifyResourceBudget(context, { memoryOnly = false, churn = false, ssh = false } = {}) {
  if (ssh && process.platform !== 'linux') {
    throw new Error('UNMET_PREREQUISITE: SSH budget PID attribution requires Linux /proc');
  }
  const kcoderBin = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const a = await materializeWorkspace(context, 'minimal', { instanceId: 'budget-a' });
  const b = await materializeWorkspace(context, 'minimal', { instanceId: 'budget-b' });
  const configDir = context.pathInState('config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson('config/settings.jsonc', {});
  const policy = await context.writeStateJson('resource_policy.jsonc', { resources: { idle_budget: {
    ...(memoryOnly ? { max_resident_bytes: 1 } : { max_processes: 1 }), sweep_interval_ms: 1000,
  } } });
  const fixture = ssh ? await startSshFixture(context, { user: userInfo().username }) : null;
  const remoteProcessIds = new Set();
  if (fixture) {
    // Registered before Gateway creation so its cleanup runs after Gateway shutdown.
    context.addCleanup('verify remote app-server exits', () => waitFor(() =>
      [...remoteProcessIds].every(pid => !alive(pid)), 10000, 'remote process cleanup'));
  }
  let command = kcoderBin;
  if (fixture) {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    command = context.pathInState('remote-kcoder');
    // SSH does not inherit the Gateway environment; never read the login user's configuration.
    await writeFile(command, ['#!/bin/sh',
      `export HOME=${quote(configDir)}`, `export XDG_CONFIG_HOME=${quote(configDir)}`,
      `export KCODER_CONFIG_DIR=${quote(configDir)}`,
      `exec ${quote(kcoderBin)} "$@"`, ''].join('\n'), { mode: 0o700, flag: 'wx' });
  }
  const target = fixture ? 'ssh-loopback' : 'local';
  const serversFile = await context.writeStateJson('servers.jsonc', [{ id: target, label: target,
    transport: fixture ? 'ssh' : 'local', command, workspace: a.path,
    ...(fixture ? { host: '127.0.0.1', user: fixture.user, port: fixture.port } : {}),
  }]);
  const gateway = await startGateway(context, { kcoderBin, workspace: a.path, serversFile, env: {
    ...fixture?.gatewayEnv,
    KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_SCENARIO: 'markdown-showcase',
    KCODER_STUDIO_APP_SERVER_IDLE_MS: '60000', KCODER_STUDIO_RESOURCE_POLICY_FILE: policy,
  } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const connect = async (workspace, label) => {
    const url = new URL(gatewayRpcUrl(gateway, target, token));
    url.searchParams.set('workspace', workspace);
    const rpc = await openRpc(url.toString());
    context.addCleanup(`close ${label}`, () => rpc.close());
    await initializeRpc(rpc, label);
    return rpc;
  };
  function alive(pid) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  if (churn) return verifyBudgetChurn(context, { connect, alive, initialWorkspaces: [a.path, b.path] });
  const first = await connect(a.path, 'budget-first');
  const second = await connect(b.path, 'budget-second');
  const started = await first.request('thread/start');
  const turn = await first.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'fixture' }] });
  await first.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.turn.id, 20000, 'fixture completion');
  const history = await first.request('thread/read', { threadId: started.thread.id });
  assert.ok(Array.isArray(history.messages) && history.messages.length > 0);
  const firstProcess = await first.request('server/resources/read');
  const secondProcess = await second.request('server/resources/read');
  if (fixture) {
    for (const resource of [firstProcess, secondProcess]) {
      remoteProcessIds.add(resource.processId);
      assert.equal(await readlink(`/proc/${resource.processId}/exe`), await realpath(kcoderBin),
        'reported target PID must be the engine executable, not SSH or Gateway');
    }
  }
  assert.notEqual(firstProcess.processId, secondProcess.processId);
  if (memoryOnly) {
    assert.ok(firstProcess.residentBytes > 1 && secondProcess.residentBytes > 1, 'target RSS must be measured');
    assert.equal(firstProcess.includesChildren, false);
    assert.equal(secondProcess.includesChildren, false);
  }
  first.close();
  await waitFor(() => first.socket.readyState === 3, 5000, 'first detach');
  if (!memoryOnly) second.close();
  await waitFor(() => !alive(firstProcess.processId), 10000, 'LRU budget eviction', 50, context.abortSignal);
  assert.ok(alive(secondProcess.processId), memoryOnly ? 'connected workspace must remain protected' : 'newest idle workspace must remain');
  if (memoryOnly) {
    second.close();
    await waitFor(() => !alive(secondProcess.processId), 10000, 'memory budget second eviction', 50, context.abortSignal);
  }
  const restored = await connect(a.path, 'budget-restored');
  assert.equal((await restored.request('thread/resume', { threadId: started.thread.id })).thread.id, started.thread.id);
  assert.deepEqual((await restored.request('thread/read', { threadId: started.thread.id })).messages, history.messages);
  const restoredProcess = await restored.request('server/resources/read');
  if (fixture) remoteProcessIds.add(restoredProcess.processId);
  assert.notEqual(restoredProcess.instanceId, firstProcess.instanceId, 'evicted target must be rebuilt');
  restored.close();
  if (memoryOnly) {
    await waitFor(() => !alive(restoredProcess.processId), 10000, 'memory budget restored eviction', 50, context.abortSignal);
  } else {
    await waitFor(() => !alive(secondProcess.processId), 10000, 'next LRU budget eviction', 50, context.abortSignal);
    assert.ok(alive(restoredProcess.processId), 'restored workspace is the newest retained candidate');
  }
  return { transport: fixture ? 'loopback-ssh' : 'local', countBudget: memoryOnly ? null : 1, memoryBudgetBytes: memoryOnly ? 1 : null,
    budgetEvictions: memoryOnly ? 3 : 2, persistedHistoryRestored: true, idleGraceMs: 60000 };
}

async function verifyBudgetChurn(context, { connect, alive, initialWorkspaces }) {
  const workspaces = [...initialWorkspaces];
  for (let index = 2; index < 8; index++) {
    workspaces.push((await materializeWorkspace(context, 'minimal', { instanceId: `budget-churn-${index}` })).path);
  }
  const histories = [];
  let previous = [];
  const rounds = 8;
  const observations = [];
  let verifiedEvictions = 0;
  let restoredHistories = 0;
  let verifiedInstanceRebuilds = 0;
  const startedAt = Date.now();
  for (let round = 0; round < rounds; round++) {
    const clients = [], processes = [];
    for (let index = 0; index < workspaces.length; index++) {
      const rpc = await connect(workspaces[index], `churn-${round}-${index}`);
      clients.push(rpc);
      if (round === 0) {
        const started = await rpc.request('thread/start');
        const threadId = started.thread.id;
        const turn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'bounded lifecycle fixture' }] });
        await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.turn.id, 20000, 'churn fixture completion');
        const history = await rpc.request('thread/read', { threadId });
        assert.ok(Array.isArray(history.messages) && history.messages.length > 0);
        histories.push({ threadId, messages: history.messages });
      } else {
        const { threadId, messages } = histories[index];
        assert.equal((await rpc.request('thread/resume', { threadId })).thread.id, threadId);
        assert.deepEqual((await rpc.request('thread/read', { threadId })).messages, messages);
        restoredHistories++;
      }
      processes.push(await rpc.request('server/resources/read'));
      assert.ok(typeof processes[index].instanceId === 'string' && processes[index].instanceId.length > 0);
      if (round > 0 && index < 7) {
        assert.notEqual(processes[index].instanceId, previous[index].instanceId);
        verifiedInstanceRebuilds++;
      }
    }
    assert.equal(new Set(processes.map(item => item.processId)).size, 8);
    assert.equal(new Set(processes.map(item => item.instanceId)).size, 8);
    for (let index = 0; index < 7; index++) {
      clients[index].close();
      await waitFor(() => clients[index].socket.readyState === 3, 5000, 'churn detach');
    }
    await waitFor(() => processes.slice(0, 6).every(item => !alive(item.processId)), 15000, 'bounded churn eviction', 50, context.abortSignal);
    assert.ok(alive(processes[6].processId), 'newest idle candidate remains');
    assert.ok(alive(processes[7].processId), 'connected candidate remains protected');
    const protectedProcess = await clients[7].request('server/resources/read');
    assert.equal(protectedProcess.instanceId, processes[7].instanceId);
    assert.equal(protectedProcess.processId, processes[7].processId);
    clients[7].close();
    await waitFor(() => clients[7].socket.readyState === 3, 5000, 'protected churn detach');
    await waitFor(() => !alive(processes[6].processId), 10000, 'final churn LRU eviction', 50, context.abortSignal);
    assert.ok(processes.slice(0, 7).every(item => !alive(item.processId)), 'all seven detached candidates exited');
    assert.ok(alive(processes[7].processId), 'only the newest idle process remains');
    verifiedEvictions += 7;
    observations.push({ round: round + 1, verifiedEvictions: 7,
      restoredHistories: round === 0 ? 0 : histories.length,
      verifiedInstanceRebuilds: round === 0 ? 0 : 7,
      residentBytes: processes.map(item => item.residentBytes ?? null),
      protectedResidentBytes: protectedProcess.residentBytes ?? null,
      elapsedMs: Date.now() - startedAt });
    // Preserve completed-round evidence even if a later round fails.
    await context.writeArtifactJson(`churn-round-${round + 1}.json`, observations.at(-1));
    previous = processes;
  }
  assert.equal(verifiedEvictions, rounds * 7);
  assert.equal(restoredHistories, (rounds - 1) * histories.length);
  assert.equal(verifiedInstanceRebuilds, (rounds - 1) * 7);
  return { workspaces: workspaces.length, rounds, verifiedEvictions, restoredHistories,
    uniqueHistories: histories.length, verifiedInstanceRebuilds, countBudget: 1,
    elapsedMs: Date.now() - startedAt, observations,
    scope: 'bounded eight-round lifecycle recovery; RSS observations are not a long-duration leak verdict' };
}
