import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startPeerUidNamespace } from '../../harness/peer-uid-container/runtime.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

const required = name => {
  const value = process.env[name];
  assert.ok(typeof value === 'string' && value.length > 0, `Explicit ${name} required`);
  return value;
};

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'actual-ssh-peer-enrollment-settings-review-discard-revoke',
  tier: 'platform', retainSuccessLogs: true, cleanupTimeoutMs: 30000,
  modelPolicy: 'Actual browser, authenticated Gateway and owned Linux SSH account; no model requests or claims about model behavior.',
}, async context => {
  const rendererRoot = required('KCODER_E2E_RENDERER_ROOT');
  const expectedIndex = required('KCODER_E2E_RENDERER_INDEX_SHA256');
  const actualIndex = createHash('sha256').update(await readFile(resolve(rendererRoot, 'index.html'))).digest('hex');
  assert.equal(actualIndex, expectedIndex);
  const product = { binary: required('KCODER_E2E_KCODER_BIN'), binarySha256: required('KCODER_E2E_KCODER_BIN_SHA256'),
    supervisor: required('KCODER_E2E_PEER_UID_SUPERVISOR_BIN'), supervisorSha256: required('KCODER_E2E_PEER_UID_SUPERVISOR_SHA256') };
  const gatewayRoot = required('KCODER_E2E_PEER_UID_GATEWAY_ROOT');
  const fixture = await startPeerUidNamespace(context, { product });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'peer-ssh-settings-control' });
  const user = fixture.users[0];
  const target = { id: 'owned-peer', label: 'Owned peer', runtime: 'kcoder', transport: 'ssh', host: '127.0.0.1',
    user: user.name, port: fixture.port, acceptNewHostKey: false, command: '/runtime/kcoder',
    workspace: `${user.home}/workspace`, settingsFile: `${user.home}/.config/kcoder/settings.json` };
  const serversFile = await context.writeStateJson('peer-ssh-settings-targets.json', [target]);
  await context.writeStateJson('gateway-profile/settings.json', { providers: {}, credential_store: 'file' });
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: product.binary, gatewayRoot,
    env: { ...fixture.sshEnvironment, KCODER_CONFIG_DIR: context.pathInState('gateway-profile'), KCODER_HOME: context.pathInState('gateway-profile') } });
  const chromium = await startChromium(context, { label: 'peer-ssh-settings-browser' });
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const observations = [];
  let stage = 'browser-login';
  page.on('pageerror', error => errors.push(error.name));
  page.on('response', response => {
    const match = new URL(response.url()).pathname.match(/\/peer-ssh\/(status|prepare|apply|discard|reconcile|revoke)$/);
    if (match) observations.push({ action: match[1], httpStatus: response.status() });
  });

  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 20000 }),
      page.locator('button[type="submit"]').click(),
    ]);
    await page.goto(`${gateway.baseUrl}/settings/kcoder-servers`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('peer-ssh-open-owned-peer').click({ timeout: 30000 });
    assert.equal(await page.getByTestId('peer-ssh-workspace').inputValue(), target.workspace);
    await page.getByTestId('peer-ssh-read').click();
    await page.getByTestId('peer-ssh-current-status').filter({ hasText: '尚未设置授权' }).waitFor();

    stage = 'review-and-discard';
    await page.getByTestId('peer-ssh-prepare').click();
    assert.equal(await page.getByTestId('peer-ssh-preview-uid').innerText(), String(user.uid));
    assert.equal(await page.getByTestId('peer-ssh-preview-user').innerText(), user.name);
    assert.match(await page.getByTestId('peer-ssh-preview-host-key').innerText(), /SHA256:/);
    await page.screenshot({ path: context.pathInCase('system-chromium', 'peer-ssh-enrollment', 'identity-review.png') });
    await page.getByTestId('peer-ssh-preview-cancel').click();
    const discard = page.locator('[data-testid^="peer-ssh-discard-"]');
    assert.equal(await discard.count(), 1);
    await discard.click();
    await page.getByRole('status').filter({ hasText: '本次操作已记录' }).waitFor();
    stage = 'status-after-discard';
    await page.getByTestId('peer-ssh-read').click();
    await page.getByTestId('peer-ssh-current-status').filter({ hasText: '尚未设置授权' }).waitFor();

    stage = 'authorize-and-revoke';
    await page.getByTestId('peer-ssh-prepare').click();
    await page.getByTestId('peer-ssh-preview-uid').waitFor();
    await page.getByTestId('peer-ssh-apply').click();
    await page.getByRole('status').filter({ hasText: '本次操作已记录' }).waitFor();
    await page.getByTestId('peer-ssh-read').click();
    await page.getByTestId('peer-ssh-current-status').filter({ hasText: '已记录授权' }).waitFor();
    await page.getByTestId('peer-ssh-revoke').click();
    await page.getByTestId('peer-ssh-revoke-confirm').click();
    await page.getByRole('status').filter({ hasText: '本次操作已记录' }).waitFor();
    await page.getByTestId('peer-ssh-read').click();
    await page.getByTestId('peer-ssh-current-status').filter({ hasText: '授权已撤销' }).waitFor();
    assert.deepEqual(errors, []);
    assert.equal((await fixture.snapshot([])).modelRequests.length, 0);
    await context.writeArtifactJson('peer-ssh-settings-proof.json', { rendererIndexSha256: actualIndex, nativeUid: user.uid,
      reviewedRealSshIdentity: true, discardedUndispatchedProposal: true, authorized: true, revoked: true,
      deterministicModelRequests: 0, browserConsolePageErrors: errors.length, observations });
    return { reviewedRealSshIdentity: true, discardedUndispatchedProposal: true, authorized: true, revoked: true, modelRequests: 0 };
  } catch (error) {
    await page.screenshot({ path: context.pathInCase('system-chromium', 'peer-ssh-enrollment', 'failure.png') }).catch(() => {});
    await context.writeArtifactJson('peer-ssh-settings-failure.json', { stage, observations, browserPageErrors: errors.length });
    throw error;
  }
});
