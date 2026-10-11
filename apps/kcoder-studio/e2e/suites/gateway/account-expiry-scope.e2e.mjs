import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { login, fetchJson } from '../../harness/http.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await runE2E(import.meta.url, { testId: 'remote-account-expiry-invalidates-only-its-target-and-can-relogin', tier: 'full-integration',
  modelPolicy: 'synthetic authority expiry; real SSH, target login contexts, Gateway and app-server recovery, not Unix isolation proof' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'account-expiry' });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const accounts = [];
  for (const [index, username] of ['alice','bob'].entries()) {
    const password = `owned-expiry-${username}`; context.registerSecret(password);
    await context.writeStateJson(`${username}/settings.json`, { active_provider: 'fixture', providers: { fixture: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', context_window_tokens: 64000, output_headroom_tokens: 1024, max_output_tokens: 1024, no_proxy: true,
    } } });
    accounts.push({ username, password, configDir: context.pathInState(username), fixtureUid: 3000 + index, principalId: `0b6cfba4-5f61-4d17-9d92-3d60a1ef2f0${index}` });
  }
  const config = await context.writeStateJson('entry.json', { workspace, accounts, binary });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = context.pathInState('account-launcher');
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/account-entry-fixture.mjs'))} ${quote(config)}\n`, { mode: 0o700 });
  const ssh = await startSshFixture(context, { forcedCommand: launcher });
  const serversFile = await context.writeStateJson('servers.json', accounts.map(account => ({ id: account.username, label: account.username,
    transport: 'ssh', host: '127.0.0.1', port: ssh.port, user: ssh.user, workspace, security: { identity: { mode: 'kcoder-account' } } })));
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, kcoderBin: binary,
    env: { ...ssh.gatewayEnv, KCODER_CONFIG_DIR: context.pathInState('gateway') } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const headers = { cookie, Origin: gateway.baseUrl, 'content-type': 'application/json' };
  const accountStatus = async name => (await fetchJson(`${gateway.baseUrl}/api/servers/${name}/account`, { headers })).body;
  const signIn = async account => {
    const result = await fetchJson(`${gateway.baseUrl}/api/servers/${account.username}/account`, { method: 'POST', headers,
      body: JSON.stringify({ username: account.username, password: account.password }) });
    assert.equal(result.response.status, 200); assert.equal(result.body.authenticated, true);
  };
  await signIn(accounts[0]); await signIn(accounts[1]);
  const connect = async name => {
    const client = await openRpc(gatewayRpcUrl(gateway, name, 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close ${name} RPC`, () => client.close()); await initializeRpc(client, `expiry-${name}`); return client;
  };
  const alice = await connect('alice'); const bob = await connect('bob');
  const bobPid = (await bob.request('server/resources/read')).processId;
  const newPassword = 'owned-expiry-alice-rotated'; context.registerSecret(newPassword);
  accounts[0].password = newPassword; await writeFile(config, JSON.stringify({ workspace, accounts, binary }), { mode: 0o600 });
  await alice.request('gateway/app-server/restart', { confirm: true });
  await assert.rejects(connect('alice'), /auth|account|closed|socket|initializ/i);
  await waitFor(async () => (await accountStatus('alice')).authenticated === false, 15000, 'expired target login invalidation');
  assert.equal((await accountStatus('bob')).authenticated, true, 'unrelated target stays authenticated');
  assert.equal((await bob.request('server/resources/read')).processId, bobPid, 'unrelated runtime is not restarted');
  assert.equal((await fetch(gateway.baseUrl + '/api/servers', { headers })).status, 200, 'remote account expiry is not Gateway logout');
  await signIn(accounts[0]);
  const recovered = await connect('alice');
  const { thread } = await recovered.request('thread/start');
  const { turn } = await recovered.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Recovered target account' }] });
  const done = await recovered.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 15000, 'reauthenticated remote turn');
  assert.equal(done.params.turn.status, 'completed');
  assert.equal((await accountStatus('bob')).authenticated, true);
  assert.equal(model.requests.length, 1);
  return { expiredTargetRequiresLogin: true, otherTargetPreserved: true, gatewaySessionPreserved: true, reloginRecoveredWithoutApplicationRestart: true };
});
