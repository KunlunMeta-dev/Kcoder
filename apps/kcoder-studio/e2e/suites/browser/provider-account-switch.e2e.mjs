import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'provider-account-switch-draft-isolation', tier: 'full-integration',
  modelPolicy: 'synthetic account-entry authentication; real SSH/Gateway/CLI/HTTP/UI routing, not OS UID isolation',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'account-switch' });
  let releaseAliceProbe = false;
  const model = await startApprovalModelFixture(context, {
    responseSteps: ({ body }) => [
      { ready: () => body.model !== 'alice-model' || releaseAliceProbe, delta: { role: 'assistant', content: 'OK' } },
      { delta: {}, finishReason: 'stop' },
    ],
  });
  const accounts = [];
  for (const [index, username] of ['alice', 'bob'].entries()) {
    const password = `synthetic-${username}`;
    const key = `${username}-fixture-key`;
    context.registerSecret(password); context.registerSecret(key);
    const configDir = context.pathInState(username);
    await context.writeStateJson(`${username}/settings.json`, { active_provider: username,
      providers: { [username]: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
        default_model: `${username}-model`, no_proxy: true, context_window_tokens: 128000,
        max_output_tokens: 1024, output_headroom_tokens: 1024 } } });
    await context.writeStateJson(`${username}/credentials.json`, { [username]: { type: 'api', key } });
    accounts.push({ username, password, configDir, fixtureUid: 2000 + index,
      principalId: `0b6cfba4-5f61-4d17-9d92-3d60a1ef2f0${index}` });
  }
  const config = await context.writeStateJson('entry.json', { workspace, accounts, binary: resolve(repoRoot, 'target/debug/kcoder') });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = context.pathInState('account-launcher');
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/account-entry-fixture.mjs'))} ${quote(config)}\n`, { mode: 0o700 });
  const ssh = await startSshFixture(context, { forcedCommand: launcher });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'account', label: 'Account fixture',
    transport: 'ssh', host: '127.0.0.1', port: ssh.port, user: ssh.user, workspace,
    security: { identity: { mode: 'kcoder-account' } } }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true,
    env: { ...ssh.gatewayEnv, KCODER_CONFIG_DIR: context.pathInState('gateway-profile') } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const accountRequest = (method, body = {}) => page.evaluate(async ({ method, body }) => {
    const response = await fetch('/api/servers/account/account', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Account request failed: ${response.status}`);
    return result;
  }, { method, body });
  try {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    const alice = await accountRequest('POST', { username: 'alice', password: accounts[0].password });
    assert.equal(alice.authenticated, true);
    await page.goto(`${gateway.baseUrl}/settings/personal/models`);
    await page.getByTestId('provider-edit-alice::alice-model').click();
    assert.match(await page.getByTestId('provider-identity').innerText(), /alice/);
    const aliceBefore = await readFile(context.pathInState('alice/settings.json'), 'utf8');
    const draftKey = 'old-account-unsaved-fixture'; context.registerSecret(draftKey);
    await page.getByTestId('provider-apiKey').fill(draftKey);
    await page.getByTestId('provider-save').click();
    await waitFor(() => model.requests.some(request => request.model === 'alice-model'), 15000, 'Alice probe reaches real HTTP fixture before account changes');
    await accountRequest('DELETE');
    const bob = await accountRequest('POST', { username: 'bob', password: accounts[1].password });
    assert.equal(bob.authenticated, true);
    assert.notEqual(alice.identity.principalId, bob.identity.principalId);
    await page.evaluate(() => window.dispatchEvent(new Event('kcoder:servers-changed')));
    await page.getByTestId('provider-edit-bob::bob-model').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('[data-testid^="provider-edit-alice"]').count(), 0);
    assert.match(await page.getByTestId('provider-identity').innerText(), /bob/);
    assert.doesNotMatch(await page.getByTestId('provider-identity').innerText(), /alice/);
    assert.equal(await page.getByTestId('provider-apiKey').inputValue(), '');
    releaseAliceProbe = true;
    await waitFor(() => model.requestOutcomes[0]?.closed, 15000, 'old account probe is cancelled or finishes');
    // A late old-scope probe must neither submit its settings nor restore its editor.
    assert.equal(await readFile(context.pathInState('alice/settings.json'), 'utf8'), aliceBefore);
    assert.equal(await page.locator('[data-testid^="provider-edit-alice"]').count(), 0);
    assert.equal(await page.getByTestId('provider-apiKey').inputValue(), '');
    await page.getByTestId('provider-edit-bob::bob-model').click();
    await page.getByTestId('provider-extra-body').fill('{"temperature":0.7}');
    await page.getByTestId('provider-save').click();
    await waitFor(async () => (await page.locator('[role="status"]').allTextContents()).some(text => text.includes('下一轮')), 30000, 'Bob configuration save');
    assert.equal(await readFile(context.pathInState('alice/settings.json'), 'utf8'), aliceBefore);
    const saved = JSON.parse(await readFile(context.pathInState('bob/settings.json'), 'utf8'));
    assert.equal(saved.providers.bob.models['bob-model'].extra_body.temperature, 0.7);
    const credentials = JSON.parse(await readFile(context.pathInState('bob/credentials.json'), 'utf8'));
    assert.ok(credentials.bob.key === 'bob-fixture-key');
    assert.deepEqual(model.requests.map(request => request.model), ['alice-model', 'bob-model']);
    await accountRequest('DELETE');
    await assert.rejects(accountRequest('POST', { username: 'alice', password: 'invalid-fixture-password' }), /Account request failed/);
    await page.evaluate(() => window.dispatchEvent(new Event('kcoder:servers-changed')));
    await waitFor(async () => await page.getByTestId('provider-save').isDisabled() &&
      await page.locator('[data-testid^="provider-edit-bob"]').count() === 0, 15000, 'unauthenticated scope blocks model writes');
    assert.equal(await page.getByTestId('provider-apiKey').inputValue(), '');
    assert.match(await page.getByTestId('provider-identity').innerText(), /尚未登录此目标/);
    assert.equal(model.requests.length, 2, 'failed authentication must not fall back to another model scope');
    return { accountSwitch: true, lateProbeCannotSubmitOldDraft: true, oldDraftCleared: true, savedOnlyToBob: true, failedLoginBlocksWrites: true, hostAccountsUnchanged: true };
  } catch (error) {
    // Do not retain a screenshot with an uncommitted secret visible.
    await page.getByTestId('provider-apiKey').fill('').catch(() => {});
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    throw error;
  } finally { await page.close(); }
});
