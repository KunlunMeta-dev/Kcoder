import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'account-switch-clears-loaded-conversation-and-sensitive-cache', tier: 'full-integration',
  modelPolicy: 'synthetic account authority; real SSH/Gateway/CLI and independent browser storage profiles',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'profile-tabs' });
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => [{ delta: { role: 'assistant', content: JSON.stringify(body.messages).includes('OTHER_TARGET_PRIVATE_PROMPT') ? 'OTHER_TARGET_HISTORY' : 'PRIVATE_ALICE_HISTORY' }, finishReason: 'stop' }] });
  const accounts = [];
  for (const [index, username] of ['alice', 'bob'].entries()) {
    const password = `synthetic-${username}`;
    const key = `synthetic-${username}-api-key`;
    context.registerSecret(key);
    await context.writeStateJson(`${username}/credentials.json`, { [username]: { type: 'api', key } });
    context.registerSecret(password);
    await context.writeStateJson(`${username}/settings.json`, { active_provider: username,
      providers: { [username]: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
        default_model: `${username}-model`, authentication: { mode: 'api_key' }, no_proxy: true,
        context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024 } } });
    accounts.push({ username, password, configDir: context.pathInState(username), fixtureUid: 2000 + index,
      principalId: `0b6cfba4-5f61-4d17-9d92-3d60a1ef2f0${index}` });
  }
  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'));
  const config = await context.writeStateJson('entry.json', { workspace, accounts, binary });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = context.pathInState('account-launcher');
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/account-entry-fixture.mjs'))} ${quote(config)}\n`, { mode: 0o700 });
  const ssh = await startSshFixture(context, { forcedCommand: launcher });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'account', label: 'Account fixture',
    transport: 'ssh', host: '127.0.0.1', port: ssh.port, user: ssh.user, workspace,
    security: { identity: { mode: 'kcoder-account' } } }, { id: 'other', label: 'Other account target',
    transport: 'ssh', host: '127.0.0.1', port: ssh.port, user: ssh.user, workspace,
    security: { identity: { mode: 'kcoder-account' } } }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, kcoderBin: binary,
    env: { ...ssh.gatewayEnv, KCODER_CONFIG_DIR: context.pathInState('gateway-profile') } });
  const browser = await startChromium(context);
  const profile = await browser.browser.newContext();
  const control = await profile.newPage();
  const conversation = await profile.newPage();
  const otherView = await profile.newPage();
  const signIn = async username => {
    await control.goto(`${gateway.baseUrl}/settings/kcoder-servers`);
    await control.getByTestId('kcoder-account-username').first().fill(username);
    await control.getByTestId('kcoder-account-password').first().fill(accounts.find(account => account.username === username).password);
    await control.getByTestId('kcoder-account-submit').first().click();
    await control.getByTestId('kcoder-account-logout').first().waitFor({ timeout: 20000 });
  };
  try {
    await control.goto(gateway.baseUrl);
    await control.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([control.waitForURL(url => !url.pathname.startsWith('/login')), control.locator('button[type="submit"]').click()]);
    await signIn('alice');
    const cookie = (await profile.cookies()).map(item => `${item.name}=${item.value}`).join('; '); context.registerSecret(cookie);
    const otherLogin = await profile.request.post(`${gateway.baseUrl}/api/servers/other/account`, {
      headers: { Origin: gateway.baseUrl }, data: { username: 'bob', password: accounts[1].password },
    });
    assert.equal(otherLogin.status(), 200);
    const other = await openRpc(gatewayRpcUrl(gateway, 'other', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close owned unaffected target', () => other.close()); await initializeRpc(other, 'unaffected-target');
    const otherPid = (await other.request('server/resources/read')).processId;
    const { thread: otherThread } = await other.request('thread/start');
    const { turn: otherTurn } = await other.request('turn/start', { threadId: otherThread.id, input: [{ type: 'text', text: 'OTHER_TARGET_PRIVATE_PROMPT' }] });
    await other.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === otherTurn.id, 15000, 'other target history');
    await otherView.goto(`${gateway.baseUrl}/runtime-tasks?deviceId=other&taskId=${encodeURIComponent(`kcoder:other:${otherThread.id}`)}`);
    await otherView.getByText('OTHER_TARGET_PRIVATE_PROMPT', { exact: true }).waitFor({ timeout: 30000 });
    await otherView.getByTestId('chat-message-input').fill('OTHER_TARGET_UNSENT_DRAFT');
    const seed = await openRpc(gatewayRpcUrl(gateway, 'account', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close owned conversation seed', () => seed.close()); await initializeRpc(seed, 'conversation-scope-seed');
    const { thread } = await seed.request('thread/start');
    const { turn } = await seed.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'ALICE_PRIVATE_PROMPT' }] });
    await seed.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 15000, 'private seeded history');
    seed.close();
    await conversation.goto(`${gateway.baseUrl}/runtime-tasks?deviceId=account&taskId=${encodeURIComponent(`kcoder:account:${thread.id}`)}`);
    await conversation.getByText('PRIVATE_ALICE_HISTORY', { exact: true }).waitFor({ timeout: 30000 });
    await control.getByTestId('kcoder-account-logout').first().click();
    await control.getByTestId('kcoder-account-confirm-logout').first().click();
    await control.getByTestId('kcoder-account-username').first().waitFor({ timeout: 15000 });
    await waitFor(async () => !(await conversation.locator('body').innerText()).includes('PRIVATE_ALICE_HISTORY'), 10000, 'logout immediately clears old conversation view');
    await signIn('bob');
    await waitFor(async () => !(await conversation.locator('body').innerText()).includes('ALICE_PRIVATE_PROMPT'), 10000, 'new account never restores old conversation cache');
    assert.equal((await other.request('server/resources/read')).processId, otherPid);
    await otherView.getByText('OTHER_TARGET_PRIVATE_PROMPT', { exact: true }).waitFor({ timeout: 10000 });
    assert.match(await otherView.getByTestId('chat-message-input').innerText(), /OTHER_TARGET_UNSENT_DRAFT/);
    await conversation.screenshot({ path: context.pathInArtifacts('account-history-cleared.png') });
    await otherView.screenshot({ path: context.pathInArtifacts('other-target-preserved.png') });
    assert.equal(model.requests.length, 2);
    return { logoutClearsHistory: true, accountSwitchDoesNotRestoreOldCache: true, otherTargetHistoryAndDraftPreserved: true, otherTargetPidPreserved: true };
  } catch (error) {
    await context.writeArtifactJson('conversation-scope-diagnostic.json', { error: String(error), text: await conversation.locator('body').innerText(), otherText: await otherView.locator('body').innerText() });
    await conversation.screenshot({ path: context.pathInArtifacts('conversation-scope-failure.png'), timeout: 5000 }).catch(() => {}); throw error;
  } finally { await profile.close(); }
});
