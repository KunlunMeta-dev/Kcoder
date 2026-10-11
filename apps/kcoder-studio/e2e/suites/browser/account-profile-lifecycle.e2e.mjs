import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'account-profile-tabs-invalidate-together-without-cross-profile-logout', tier: 'full-integration',
  modelPolicy: 'synthetic account authority; real SSH/Gateway/CLI and independent browser storage profiles',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'profile-tabs' });
  const model = await startApprovalModelFixture(context, { textOnly: true });
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
    security: { identity: { mode: 'kcoder-account' } } }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, kcoderBin: binary,
    env: { ...ssh.gatewayEnv, KCODER_CONFIG_DIR: context.pathInState('gateway-profile') } });
  const browser = await startChromium(context);
  const profile = await browser.browser.newContext();
  const independent = await browser.browser.newContext();
  const control = await profile.newPage();
  const observer = await profile.newPage();
  const automations = await profile.newPage();
  const other = await independent.newPage();
  const gatewayLogin = async page => {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.goto(`${gateway.baseUrl}/settings/kcoder-servers`);
  };
  const login = async (page, username, password) => {
    await page.getByTestId('kcoder-account-username').fill(username);
    await page.getByTestId('kcoder-account-password').fill(password);
    await page.getByTestId('kcoder-account-submit').click();
  };
  const logout = async page => {
    await page.getByTestId('kcoder-account-logout').click();
    await page.getByTestId('kcoder-account-confirm-logout').click();
    await page.getByTestId('kcoder-account-username').waitFor({ timeout: 15000 });
  };
  const draft = 'synthetic-unsaved-other-tab'; context.registerSecret(draft);
  try {
    await gatewayLogin(control);
    await login(control, 'alice', accounts[0].password);
    await control.getByTestId('kcoder-account-logout').waitFor({ timeout: 20000 });
    await observer.goto(`${gateway.baseUrl}/settings/personal/models`);
    await observer.getByTestId('provider-edit-alice::alice-model').click();
    await observer.getByTestId('provider-apiKey').fill(draft);
    await automations.goto(gateway.baseUrl);
    await automations.getByTestId('automations-button').click();
    await waitFor(async () => (await automations.getByTestId('automation-identity').innerText()).includes('alice'),
      15000, 'automation account metadata');
    await automations.getByTestId('automation-prompt').fill('ALICE_UNSAVED_AUTOMATION');
    await automations.getByTestId('automation-at').fill('2030-01-01T09:00');
    await automations.getByTestId('automation-confirm').check();
    await gatewayLogin(other);
    await login(other, 'alice', accounts[0].password);
    await other.getByTestId('kcoder-account-logout').waitFor({ timeout: 20000 });
    await other.goto(`${gateway.baseUrl}/settings/personal/models`);
    await other.getByTestId('provider-edit-alice::alice-model').waitFor({ timeout: 20000 });
    await logout(control);
    await waitFor(async () => !(await observer.getByTestId('provider-identity').innerText()).includes('alice') &&
      await observer.getByTestId('provider-save').isDisabled(), 12000, 'same-profile observer invalidation without manual event');
    assert.equal(await observer.getByTestId('provider-apiKey').inputValue(), '');
    await waitFor(() => automations.getByTestId('automation-create').isDisabled(), 10000, 'automation consent invalidation');
    assert.equal(await automations.getByTestId('automation-prompt').inputValue(), '');
    assert.equal(await automations.getByTestId('automation-confirm').isChecked(), false);
    assert.ok((await other.getByTestId('provider-identity').innerText()).includes('alice'));
    await login(control, 'bob', accounts[1].password);
    await control.getByTestId('kcoder-account-logout').waitFor({ timeout: 20000 });
    await observer.getByTestId('provider-edit-bob::bob-model').waitFor({ timeout: 20000 });
    await waitFor(async () => (await automations.getByTestId('automation-identity').innerText()).includes('bob'),
      15000, 'automation new account metadata');
    assert.equal(await automations.getByTestId('automation-create').isDisabled(), true);
    assert.equal(await automations.getByTestId('automation-prompt').inputValue(), '');
    assert.equal(await observer.getByTestId('provider-apiKey').inputValue(), '');
    assert.equal(await observer.locator('[data-testid^="provider-edit-alice"]').count(), 0);
    assert.equal(await other.getByTestId('provider-edit-alice::alice-model').count(), 1);
    await logout(control);
    await login(control, 'alice', 'invalid-fixture-password');
    await control.getByTestId('kcoder-account-login').getByRole('alert').waitFor({ timeout: 20000 });
    await waitFor(() => observer.getByTestId('provider-save').isDisabled(), 10000, 'failed login remains unauthenticated');
    assert.equal(await observer.locator('[data-testid^="provider-edit-"]').count(), 0);
    assert.ok((await other.getByTestId('provider-identity').innerText()).includes('alice'));
    assert.equal(model.requests.length, 0);
    await observer.bringToFront();
    await observer.screenshot({ path: context.pathInArtifacts('profile-logged-out.png') });
    return { sameProfileTabsInvalidated: true, otherProfileUnchanged: true, oldDraftCleared: true, failedLoginNoFallback: true, automationConsentAndDraftInvalidated: true };
  } catch (error) {
    await observer.getByTestId('provider-apiKey').fill('').catch(() => {});
    await observer.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    throw error;
  } finally { await profile.close(); await independent.close(); }
});
