import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { initializeRpc, gatewayRpcUrl, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

if (process.getuid?.() !== 0 || process.env.KCODER_TEST_SYSTEM_USERS !== '1' || !process.env.KCODER_E2E_OIDC_PYTHON)
  throw new Error('UNMET_PREREQUISITE: root, KCODER_TEST_SYSTEM_USERS=1 and pinned KCODER_E2E_OIDC_PYTHON required');
await assertRendererBuildFresh();
const resourceUi = process.env.KCODER_E2E_ORGANIZATION_RESOURCE_UI === '1';

await runE2E(import.meta.url, { testId: resourceUi ? 'organization-resource-policy-and-scoped-audit-real-ui' : 'organization-oidc-real-uid-browser-login-and-resume', tier: 'full-integration',
  modelPolicy: 'no model calls; owned HTTPS IdP with real Authlib/PKCE/signatures, real SSH/root account entry/UID/app-server and browser UI',
  retainSuccessLogs: true }, async context => {
  const workspace = context.pathInState('workspace'); await mkdir(workspace, { mode: 0o700 });
  const installation = await context.createOwnedScratchDirectory('oidc-account-install', {
    baseDirectory: '/usr/local/lib', requiredBytes: 1024n * 1024n * 1024n, requiredMemoryBytes: 0n, requireCleanupConfirmation: true,
  });
  const stagedSource = resolve(installation.path, 'source');
  const stage = context.spawnOwned('oidc-source-snapshot', process.env.KCODER_E2E_OIDC_PYTHON, ['-I',
    resolve(repoRoot, 'scripts/install/tests/stage_organization_fixture.py'), '--source', resolve(repoRoot, 'scripts/install'),
    '--destination', stagedSource], { env: context.isolatedEnvironment({}) });
  await new Promise((resolveStage, reject) => {
    stage.once('error', reject);
    stage.once('exit', code => code === 0 ? resolveStage() : reject(new Error('Trusted OIDC source staging failed')));
  });
  const sourceManifest = JSON.parse(await readFile(resolve(stagedSource, 'source-manifest.json'), 'utf8'));
  await context.writeArtifactJson('oidc-trusted-source-manifest.json', sourceManifest);
  const fixture = context.spawnOwned('oidc-native-fixture', process.env.KCODER_E2E_OIDC_PYTHON, ['-I',
    resolve(stagedSource, 'tests/oidc_gateway_fixture.py'), '--state', resolve(installation.path, 'authority'),
    '--prefix', resolve(installation.path, 'installation'), '--runtime', process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    ...(resourceUi ? ['--administrator'] : [])], {
    stdin: 'pipe', env: context.isolatedEnvironment({ KCODER_TEST_SYSTEM_USERS: '1' }),
  });
  const responses = new Map(); let ready, cleanupComplete = false, sequence = 0;
  createInterface({ input: fixture.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.ready) ready = message;
      if (message.cleanupComplete === true) cleanupComplete = true;
      if (message.id !== undefined) { responses.get(message.id)?.(message); responses.delete(message.id); }
    } catch { /* Python warning lines never contain credentials. */ }
  });
  const control = request => new Promise((resolveControl, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { responses.delete(id); reject(new Error('Owned OIDC fixture control timed out')); }, 30000);
    responses.set(id, value => { clearTimeout(timer); resolveControl(value); });
    fixture.stdin.write(JSON.stringify({ ...request, id }) + '\n');
  });
  context.addCleanup('settle exact OIDC UID and installer owner', async () => {
    if (fixture.exitCode === null) fixture.stdin.write('{"operation":"stop"}\n');
    await waitFor(() => cleanupComplete || fixture.exitCode !== null, 30000, 'OIDC fixture exact cleanup receipt');
    assert.equal(cleanupComplete, true, 'OIDC account cleanup must be confirmed before deleting installation evidence');
    await context.confirmOwnedScratchCleanup(installation);
  });
  await waitFor(() => ready || (fixture.exitCode !== null ? Promise.reject(new Error('Owned OIDC fixture failed')) : false), 45000, 'owned OIDC fixture ready');
  if (process.env.KCODER_E2E_KCODER_BIN_SHA256) assert.equal(ready.runtimeSha256, process.env.KCODER_E2E_KCODER_BIN_SHA256, 'Owned runtime must match the requested artifact identity');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const forced = context.pathInState('account-entry');
  await writeFile(forced, `#!/bin/sh\nexec /usr/bin/python3 -I ${quote(ready.entry)} --state-directory ${quote(ready.state)} --homes-directory ${quote(ready.homes)} --runtime ${quote(ready.runtime)}\n`, { mode: 0o700 });
  await chmod(forced, 0o700);
  const ssh = await startSshFixture(context, { forcedCommand: forced, user: 'root' });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'account', label: 'Organization account', transport: 'ssh',
    host: '127.0.0.1', port: ssh.port, user: ssh.user, workspace: ready.workspace, security: { identity: { mode: 'kcoder-account', username: 'alice' } } }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true,
    kcoderBin: ready.runtime, env: ssh.gatewayEnv });
  await control({ operation: 'gateway', origin: gateway.baseUrl });
  const chromium = await startChromium(context, { label: 'oidc-browser' });
  const browser = await chromium.browser.newContext({ ignoreHTTPSErrors: true });
  context.addCleanup('close OIDC browser context', () => browser.close());
  const peerBrowser = await chromium.browser.newContext({ ignoreHTTPSErrors: true });
  context.addCleanup('close peer OIDC browser context', () => peerBrowser.close());
  const page = await browser.newPage(), peer = await peerBrowser.newPage();
  const signInGateway = async target => {
    await target.goto(gateway.baseUrl);
    await target.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([target.waitForURL(url => !url.pathname.startsWith('/login')), target.locator('button[type="submit"]').click()]);
  };
  await signInGateway(page); await signInGateway(peer);
  await page.goto(`${gateway.baseUrl}/settings/kcoder-servers`);
  await page.getByTestId('kcoder-account-username').fill('alice');
  const forged = await browser.request.post(`${gateway.baseUrl}/api/servers/account/account/oidc`, { headers: { Origin: gateway.baseUrl },
    data: { username: 'alice', clientRequestId: '31234567-89ab-4cde-8fab-0123456789ab', origin: 'https://forged.test', nonce: 'caller-nonce' } });
  assert.equal(forged.status(), 400);
  let requestId;
  page.on('request', request => {
    if (request.url().endsWith('/api/servers/account/account/oidc') && request.method() === 'POST') requestId = request.postDataJSON().clientRequestId;
  });
  const opened = browser.waitForEvent('page', { timeout: 15000 });
  await page.getByTestId('kcoder-account-sso-start').click();
  const popup = await opened;
  await popup.getByRole('button', { name: 'Continue as fixture member' }).waitFor({ timeout: 20000 });
  let releaseCallback, callbackUrl;
  const held = new Promise(resolveHold => { releaseCallback = resolveHold; });
  await popup.route('**/authorize', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const authorized = await route.fetch({ maxRedirects: 0 });
    callbackUrl = authorized.headers().location;
    const parsed = new URL(callbackUrl);
    context.registerSecret(parsed.searchParams.get('code')); context.registerSecret(parsed.searchParams.get('state'));
    await held; await route.fulfill({ response: authorized });
  });
  await popup.getByRole('button', { name: 'Continue as fixture member' }).click({ noWaitAfter: true });
  await waitFor(() => callbackUrl, 10000, 'owned IdP callback');
  const wrongPage = await peerBrowser.request.get(callbackUrl);
  const receipt = (await wrongPage.text()).match(/receipt:"([A-Za-z0-9_-]+)"/)[1];
  const wrongOwner = await peerBrowser.request.post(`${gateway.baseUrl}/api/account/oidc/callback`, {
    headers: { Origin: gateway.baseUrl }, data: { receipt },
  });
  assert.equal(wrongOwner.status(), 403);
  assert.equal((await control({ operation: 'snapshot' })).exchanges, 0);
  assert.equal((await peerBrowser.request.get(`${gateway.baseUrl}/api/servers/account/account/oidc?clientRequestId=${requestId}`)).status(), 404);
  releaseCallback();
  await page.getByTestId('kcoder-account-logout').waitFor({ timeout: 60000 });
  const publicInventory = await (await browser.request.get(`${gateway.baseUrl}/api/servers`)).json();
  assert.equal(publicInventory.servers[0].accountIdentity.principalId, ready.principalId);
  assert.equal(publicInventory.servers[0].accountIdentity.role, resourceUi ? 'admin' : 'user');
  if (resourceUi) {
    await page.getByTestId('kcoder-account-management').getByRole('button').first().click();
    const governance = page.getByTestId('kcoder-organization-management');
    await governance.getByRole('button', { name: /组织治理|Organization governance/ }).click();
    await governance.locator('summary').filter({ hasText: /^(资源策略|Resource policy)$/ }).click();
    const editor = page.getByTestId('organization-resource-editor');
    await editor.getByLabel(/原始资源引用|Original resource reference/).fill('knowledge:managed-ui');
    await editor.getByLabel(/资源拥有者|Resource owner/).selectOption(ready.principalId);
    await editor.getByLabel(/访问边界|Access boundary/).selectOption('organization');
    await editor.getByLabel(/选择成员或角色|Choose a member or role/).selectOption('role:knowledgePublisher');
    await editor.getByRole('button', { name: /添加授权|Add grant/ }).click();
    await editor.getByLabel(/读取|^Read$/).check();
    await editor.getByRole('button', { name: /保存资源策略|Save resource policy/ }).click();
    await editor.getByRole('button', { name: /重新载入当前策略|Reload current policy/ }).waitFor();
    await editor.getByRole('button', { name: /重新载入当前策略|Reload current policy/ }).click();
    await editor.getByLabel(/原始资源引用|Original resource reference/).fill('audit:managed-ui');
    await editor.getByLabel(/资源类型|Resource kind/).selectOption('audit');
    await editor.getByLabel(/访问边界|Access boundary/).selectOption('organization');
    await editor.getByLabel(/选择成员或角色|Choose a member or role/).selectOption('role:auditor');
    await editor.getByRole('button', { name: /添加授权|Add grant/ }).click();
    await editor.getByLabel(/导出|^Export$/).check();
    await editor.getByLabel('knowledge:managed-ui', { exact: true }).check();
    await editor.getByRole('button', { name: /保存资源策略|Save resource policy/ }).click();
    const download = page.waitForEvent('download');
    await governance.getByRole('button', { name: /导出获准范围的审计|Export approved audit scope/ }).click();
    const saved = context.pathInCase('system-chromium', 'organization-resource-policy', 'scoped-audit.json');
    await (await download).saveAs(saved);
    const audit = JSON.parse(await readFile(saved, 'utf8'));
    assert.deepEqual(audit.scope, { resourceIds: ['knowledge:managed-ui'] });
    assert.ok(audit.events.length > 0);
    assert.ok(audit.events.every(event => event.resource === 'knowledge:managed-ui'));
    assert.ok(!/resumeAuthority|access_token|scrypt|password|HOME/.test(JSON.stringify(audit)));
    const current = await browser.request.post(`${gateway.baseUrl}/api/servers/account/accounts`, {
      headers: { Origin: gateway.baseUrl }, data: { operation: 'organization.inspect' },
    });
    const policy = (await current.json()).result;
    assert.deepEqual(policy.resources.find(resource => resource.id === 'knowledge:managed-ui').grants,
      [{ subject: 'role:knowledgePublisher', actions: ['read'] }]);
    if (process.env.KCODER_E2E_ORGANIZATION_SCREENSHOTS === '1') {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await governance.scrollIntoViewIfNeeded();
      const capture = await browser.newCDPSession(page);
      const viewportImage = async filename => {
        // The peer-login context can leave this page backgrounded. Activate
        // its actual owned compositor before asking for a viewport frame.
        await page.bringToFront();
        let timer;
        const shot = await Promise.race([
          capture.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned resource viewport capture timed out')), 10000); }),
        ]).finally(() => clearTimeout(timer));
        await writeFile(context.pathInArtifacts(filename), Buffer.from(shot.data, 'base64'));
      };
      await viewportImage('organization-resource-management-wide.png');
      await page.setViewportSize({ width: 480, height: 960 });
      await governance.scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Resource editor must remain contained at narrow widths');
      const bounds = await governance.boundingBox();
      assert.ok(bounds && bounds.width >= 320, 'Account resource forms must use the available target-card width instead of sharing a narrow column with row actions');
      await viewportImage('organization-resource-management-narrow.png');
      await capture.detach();
    }
  }
  const cookies = (await browser.cookies()).map(item => `${item.name}=${item.value}`).join('; '); context.registerSecret(cookies);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'account', 'cookie-auth'), { headers: { Cookie: cookies, Origin: gateway.baseUrl } });
  context.addCleanup('close original OIDC RPC', () => rpc.close()); await initializeRpc(rpc, 'oidc-original');
  const originalPid = (await rpc.request('server/resources/read')).processId;
  const alternate = new URL(gatewayRpcUrl(gateway, 'account', 'cookie-auth')); alternate.searchParams.set('workspace', ready.alternateWorkspace);
  const resumed = await openRpc(alternate.href, { headers: { Cookie: cookies, Origin: gateway.baseUrl } });
  context.addCleanup('close resumed OIDC RPC', () => resumed.close()); await initializeRpc(resumed, 'oidc-resumed-workspace');
  const resumedPid = (await resumed.request('server/resources/read')).processId;
  assert.notEqual(originalPid, resumedPid);
  for (const pid of [originalPid, resumedPid]) {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    assert.match(status, new RegExp(`Uid:\\s+${ready.uid}\\s+${ready.uid}`));
    assert.match(status, /NoNewPrivs:\s+1/);
  }
  assert.equal((await control({ operation: 'snapshot' })).exchanges, 1, 'new workspace must resume the original native authority without replaying code');
  const invalidLogout = await control({ operation: 'deliverLogout', endpoint: `${gateway.baseUrl}/api/servers/account/account/oidc/logout`, corrupt: true });
  assert.equal(invalidLogout.status, 400);
  const accepted = await control({ operation: 'deliverLogout', endpoint: `${gateway.baseUrl}/api/servers/account/account/oidc/logout` });
  assert.equal(accepted.status, 200); assert.equal(accepted.processed, true);
  await waitFor(async () => {
    const inventory = await (await browser.request.get(`${gateway.baseUrl}/api/servers`)).json();
    return !inventory.servers[0].accountIdentity;
  }, 10000, 'signed OIDC logout current Gateway identity withdrawal');
  await context.writeArtifactJson('organization-oidc-browser-result.json', { browserLogin: true, fixedIssuer: true,
    uid: ready.uid, originalPid, resumedPid, wrongOwnerDenied: true, callerOriginNonceDenied: true,
    codeExchanges: 1, nativeResume: true, signedLogout: true, resourceManagement: resourceUi, binarySha256: ready.runtimeSha256 });
  return { realBrowser: true, realSsh: true, realUid: true, realOidcSignaturesAndPkce: true, nativeResume: true, signedLogout: true };
});
