import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { gatewayRpcUrl, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

if (process.getuid?.() !== 0 || process.env.KCODER_TEST_SYSTEM_USERS !== '1' ||
    !process.env.KCODER_E2E_OIDC_PYTHON || !process.env.KCODER_ORGANIZATION_LEGACY_FIXTURE)
  throw new Error('UNMET_PREREQUISITE: explicit owned system users, pinned Python and native Wiki seed required');
await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: 'organization-knowledge-native-owner-adoption-and-revocation-ui', tier: 'full-integration',
  modelPolicy: 'No model calls; real authenticated account, distinct restricted UIDs, SSH, Gateway, native publication and browser UI',
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState('workspace'); await mkdir(workspace, { mode: 0o700 });
  const source = await context.createOwnedScratchDirectory('organization-knowledge-source', {
    baseDirectory: '/usr/local/lib', requiredBytes: 64n * 1024n * 1024n,
    requiredMemoryBytes: 0n, requireCleanupConfirmation: true,
  });
  const staged = resolve(source.path, 'source');
  const snapshot = context.spawnOwned('organization-knowledge-source-snapshot', process.env.KCODER_E2E_OIDC_PYTHON,
    ['-I', resolve(repoRoot, 'scripts/install/tests/stage_organization_fixture.py'), '--source',
      resolve(repoRoot, 'scripts/install'), '--destination', staged], { env: context.isolatedEnvironment({}) });
  await new Promise((done, reject) => {
    snapshot.once('error', reject); snapshot.once('exit', code => code === 0 ? done() : reject(new Error('Trusted knowledge source snapshot failed')));
  });
  await context.writeArtifactJson('organization-knowledge-source.json', JSON.parse(await readFile(resolve(staged, 'source-manifest.json'), 'utf8')));
  const fixture = context.spawnOwned('organization-knowledge-account-fixture', process.env.KCODER_E2E_OIDC_PYTHON,
    ['-I', resolve(staged, 'tests/organization_knowledge_browser_fixture.py')], { stdin: 'pipe',
      env: context.isolatedEnvironment({ KCODER_TEST_SYSTEM_USERS: '1',
        KCODER_ORGANIZATION_APP_SERVER: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
        KCODER_ORGANIZATION_LEGACY_FIXTURE: process.env.KCODER_ORGANIZATION_LEGACY_FIXTURE }) });
  let ready, cleanupComplete = false, sequence = 0;
  const replies = new Map();
  createInterface({ input: fixture.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.ready) ready = message;
    if (message.cleanupComplete === true) cleanupComplete = true;
    if (message.id !== undefined) replies.set(message.id, message);
  });
  context.addCleanup('confirm exact knowledge fixture account cleanup', async () => {
    if (fixture.exitCode === null) fixture.stdin.write('{"operation":"stop"}\n');
    await waitFor(() => cleanupComplete || fixture.exitCode !== null, 30000, 'knowledge fixture account cleanup');
    assert.equal(cleanupComplete, true);
    await context.confirmOwnedScratchCleanup(source);
  });
  const control = async operation => {
    const id = ++sequence; fixture.stdin.write(JSON.stringify({ id, operation }) + '\n');
    await waitFor(() => replies.has(id) || (fixture.exitCode !== null ? Promise.reject(new Error('Owned knowledge fixture exited')) : false),
      30000, `knowledge fixture ${operation}`);
    const reply = replies.get(id); replies.delete(id); return reply;
  };
  await waitFor(() => ready || (fixture.exitCode !== null ? Promise.reject(new Error('Owned knowledge fixture failed')) : false),
    60000, 'owned knowledge fixture ready');
  if (process.env.KCODER_E2E_KCODER_BIN_SHA256) assert.equal(ready.runtimeSha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  assert.notEqual(ready.readerUid, ready.publisherUid);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const entry = context.pathInState('account-entry');
  await writeFile(entry, `#!/bin/sh\nexec /usr/bin/python3 -I ${quote(ready.entry)} --state-directory ${quote(ready.state)} --homes-directory ${quote(ready.homes)} --runtime ${quote(ready.runtime)}\n`, { mode: 0o700 });
  await chmod(entry, 0o700);
  const ssh = await startSshFixture(context, { forcedCommand: entry, user: 'root' });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'account', label: 'Owned organization knowledge', transport: 'ssh',
    host: '127.0.0.1', port: ssh.port, user: ssh.user, workspace: ready.workspace,
    security: { identity: { mode: 'kcoder-account', username: 'reader' } } }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, kcoderBin: ready.runtime, env: ssh.gatewayEnv });
  const chromium = await startChromium(context, { label: 'organization-knowledge-browser' });
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  context.addCleanup('close organization knowledge page', () => page.close());
  let completed = false;
  const failureScreenshot = context.pathInArtifacts('organization-knowledge-failure.png');
  const failureUi = context.pathInArtifacts('organization-knowledge-failure-ui.json');
  context.addCleanup('capture failed organization knowledge UI', async () => {
    if (!completed) {
      await page.screenshot({ path: failureScreenshot });
      await writeFile(failureUi, JSON.stringify({
        url: page.url(), text: context.redactText(await page.locator('body').innerText()),
      }));
    }
  });
  const password = 'synthetic-reader-password'; context.registerSecret(password);
  await page.goto(gateway.baseUrl);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  await page.goto(`${gateway.baseUrl}/settings/kcoder-servers`);
  await page.getByTestId('kcoder-account-username').fill('reader');
  await page.getByTestId('kcoder-account-password').fill(password);
  await page.getByTestId('kcoder-account-submit').click();
  await page.getByTestId('kcoder-account-logout').waitFor({ timeout: 30000 });
  const cookies = (await page.context().cookies()).map(item => `${item.name}=${item.value}`).join('; ');
  context.registerSecret(cookies);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'account', 'cookie-auth'), { headers: { Cookie: cookies, Origin: gateway.baseUrl } });
  context.addCleanup('close organization knowledge diagnostic RPC', () => rpc.close());
  await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-organization-knowledge', version: '1' },
    capabilities: { experimental: { integrationScopeV1: true, knowledgePublicationsV1: true } } });
  const actualScope = await rpc.request('integrations/scope/read', {});
  const directory = await rpc.request('integrations/knowledge/listPublications', {
    contractVersion: 'parallel-v1', requestId: 'owned-browser-directory-read', scope: actualScope, timeoutMs: 10000, payload: {},
  });
  await context.writeArtifactJson('organization-knowledge-wire.json', { scope: actualScope, status: directory.status,
    error: directory.error, count: directory.result?.page?.items?.length });
  assert.equal(directory.status, 'completed', JSON.stringify(directory.error));
  assert.equal(directory.result.page.items.length, 2);
  await page.goto(`${gateway.baseUrl}/context`);
  await page.getByTestId('knowledge-section-knowledge').click();
  const rows = page.getByTestId('knowledge-publication-row');
  await rows.filter({ hasText: ready.originalTitle }).waitFor({ timeout: 30000 });
  await rows.filter({ hasText: ready.otherTitle }).waitFor({ timeout: 30000 });
  assert.equal(await rows.count(), 2);
  await page.getByTestId('knowledge-adoptions-toggle').click();
  const adoption = page.getByTestId('knowledge-adoption-row');
  await adoption.filter({ hasText: ready.originalTitle }).waitFor();
  assert.equal(await adoption.filter({ hasText: ready.otherTitle }).count(), 0);
  await adoption.getByRole('button', { name: /在当前组织采用|Use in this organization/ }).click();
  await adoption.getByRole('button', { name: /停用|Disable/ }).waitFor({ timeout: 30000 });
  let actual = await control('inspect');
  assert.equal(actual.originalSourceUnchanged, true);
  assert.equal(actual.records.length, 1); assert.deepEqual(actual.records[0].owner, ready.currentOwner);
  assert.deepEqual(actual.records[0].publicationOwner, ready.reference.owner);
  assert.equal(actual.records[0].publicationVersion, 1); assert.equal(actual.records[0].enabled, true);
  await adoption.getByTestId('knowledge-adoption-toggle').click();
  await adoption.getByRole('button', { name: /启用|Enable/ }).waitFor({ timeout: 30000 });
  actual = await control('inspect'); assert.equal(actual.records.length, 1); assert.equal(actual.records[0].enabled, false);
  await page.reload();
  await page.getByTestId('knowledge-section-knowledge').click();
  await page.getByTestId('knowledge-adoptions-toggle').click();
  await adoption.getByRole('button', { name: /启用|Enable/ }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: context.pathInArtifacts('organization-knowledge-current-disabled.png') });
  const originalRow = rows.filter({ hasText: ready.originalTitle });
  await control('revoke');
  await originalRow.getByTestId('publication-load-version').click();
  await originalRow.waitFor({ state: 'detached', timeout: 30000 });
  // A policy update may renew the whole target scope. Reopen the knowledge
  // section as well, so a remount alone cannot satisfy content withdrawal.
  await page.getByTestId('knowledge-section-knowledge').click();
  await rows.filter({ hasText: ready.otherTitle }).waitFor({ timeout: 30000 });
  assert.equal(await rows.count(), 1);
  assert.equal(await page.getByText(ready.originalTitle, { exact: true }).count(), 0);
  const adoptedToggle = page.getByTestId('knowledge-adoptions-toggle');
  if (!await adoptedToggle.evaluate(element => element.parentElement.open)) await adoptedToggle.click();
  await adoption.waitFor({ state: 'detached', timeout: 30000 });
  await page.setViewportSize({ width: 480, height: 760 });
  await page.getByTestId('knowledge-section-knowledge').click();
  await rows.filter({ hasText: ready.otherTitle }).waitFor({ timeout: 30000 });
  assert.equal(await rows.count(), 1);
  assert.equal(await page.getByText(ready.originalTitle, { exact: true }).count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2));
  await page.screenshot({ path: context.pathInArtifacts('organization-knowledge-revoked-narrow.png') });
  actual = await control('inspect'); assert.equal(actual.originalSourceUnchanged, true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${gateway.baseUrl}/settings/kcoder-servers`);
  await page.getByTestId('kcoder-account-switch').click();
  await page.getByTestId('kcoder-account-confirm-logout').click();
  const administratorPassword = 'synthetic-administrator-password'; context.registerSecret(administratorPassword);
  await page.getByTestId('kcoder-account-username').fill('administrator');
  await page.getByTestId('kcoder-account-password').fill(administratorPassword);
  await page.getByTestId('kcoder-account-submit').click();
  const management = page.getByTestId('kcoder-account-management');
  await management.getByRole('button', { name: /管理账号|Manage accounts/ }).click();
  await management.getByRole('button', { name: /组织治理|Organization governance/ }).click();
  const execution = page.getByTestId('organization-execution-settings');
  await execution.locator('summary').click();
  await execution.getByRole('button', { name: /添加模型规则|Add model rule/ }).click();
  const rule = execution.getByTestId('organization-model-rule-0');
  await rule.getByLabel(/策略标识 1|Policy identifier 1/).fill('owned-ui-model-route');
  await rule.getByLabel(/提供方标识 1|Provider identifier 1/).fill('fixture');
  await rule.getByLabel(/精确模型名称 1|Exact model name 1/).fill('owned-ui-model');
  await rule.getByLabel(/端点源地址 1|Endpoint origin 1/).fill('https://models.example');
  await rule.getByLabel('reader', { exact: true }).check();
  await rule.getByLabel(ready.workspaceResourceId, { exact: true }).check();
  await execution.getByRole('button', { name: /添加额度|Add budget/ }).click();
  const budget = execution.getByTestId('organization-budget-policy-0');
  await budget.getByLabel(/额度标识 1|Budget identifier 1/).fill('owned-ui-budget');
  await budget.getByLabel(/时段标识 1|Window identifier 1/).fill('owned-ui-window');
  await execution.getByTestId('organization-execution-save').click();
  await execution.getByRole('button', { name: /载入当前策略|Reload current policy/ }).waitFor({ timeout: 30000 });
  const configured = await control('execution-inspect');
  assert.equal(configured.executionPolicy.modelRules.length, 1);
  assert.deepEqual(configured.executionPolicy.modelRules[0].members, [ready.readerPrincipalId]);
  assert.deepEqual(configured.executionPolicy.modelRules[0].workspaceResourceIds, [ready.workspaceResourceId]);
  assert.equal(configured.executionPolicy.modelRules[0].endpointOrigin, 'https://models.example');
  assert.equal(configured.executionPolicy.budgetPolicies[0].limits.tokens, 1_000_000);
  assert.equal(configured.originalSourceUnchanged, true);
  await execution.getByRole('button', { name: /载入当前策略|Reload current policy/ }).click();
  await budget.getByLabel(/Token 上限 1|Token limit 1/).fill('1200000');
  await execution.getByTestId('organization-execution-save').click();
  await execution.getByRole('button', { name: /载入当前策略|Reload current policy/ }).waitFor({ timeout: 30000 });
  const adjusted = await control('execution-inspect');
  assert.equal(adjusted.executionPolicy.budgetPolicies[0].limits.tokens, 1_200_000);
  assert.equal(adjusted.executionPolicy.budgetPolicies[0].id, 'owned-ui-budget');
  assert.equal(adjusted.originalSourceUnchanged, true);
  await page.screenshot({ path: context.pathInArtifacts('organization-execution-admin-policy.png') });
  const organization = page.getByTestId('kcoder-organization-management');
  await organization.locator('summary').filter({ hasText: /^(资源策略|Resource policy)$/ }).click();
  const resources = organization.getByTestId('organization-resource-editor');
  await resources.getByLabel(/^(资源策略|Resource policy)$/).selectOption(ready.sourceResourceId);
  const sourceEditor = resources.getByTestId('organization-knowledge-source-editor');
  await sourceEditor.locator('summary').click();
  await sourceEditor.getByLabel(/声明原生发布来源|Declare a native publication source/).check();
  await sourceEditor.getByLabel(/实际发布者账户|Actual publisher account/).selectOption(ready.readerPrincipalId);
  await sourceEditor.getByLabel(/原始发布引用（JSON）|Original publication reference \(JSON\)/).fill(JSON.stringify(ready.reference));
  await resources.getByRole('button', { name: /保存资源策略|Save resource policy/ }).click();
  await resources.getByRole('button', { name: /重新载入当前策略|Reload current policy/ }).waitFor({ timeout: 30000 });
  const declared = await control('source-inspect');
  assert.deepEqual(declared.resource.nativeKnowledgeSource, { version: 1,
    publisherPrincipalId: ready.readerPrincipalId, publicationOwner: ready.reference.owner,
    publicationId: ready.reference.publicationId });
  assert.notEqual(declared.resource.owner, ready.readerPrincipalId);
  assert.equal(declared.managementOwnerCanRead, false);
  assert.equal(declared.originalSourceUnchanged, true);
  await resources.getByRole('button', { name: /重新载入当前策略|Reload current policy/ }).click();
  assert.equal(await sourceEditor.getByLabel(/声明原生发布来源|Declare a native publication source/).isDisabled(), true);
  assert.equal(await sourceEditor.getByLabel(/实际发布者账户|Actual publisher account/).isDisabled(), true);
  await page.screenshot({ path: context.pathInArtifacts('organization-knowledge-source-policy.png') });
  const nativeBudget = organization.getByTestId('organization-budget-status');
  await nativeBudget.locator('summary').click();
  const refreshBudget = nativeBudget.getByRole('button', { name: /刷新预算状态|Refresh budget status/ });
  await refreshBudget.click();
  await nativeBudget.getByText(/已配置额度，但尚未初始化原生预算服务|Budgets are configured, but the native service/).waitFor({ timeout: 30000 });
  await nativeBudget.getByRole('button', { name: /初始化已配置的预算服务|Initialize configured budget service/ }).click();
  await nativeBudget.getByText(/原始预算服务可用|The original budget service is available/).waitFor({ timeout: 30000 });
  const budgetBeforeRead = await control('budget-inspect');
  assert.equal(budgetBeforeRead.report.status, 'ready');
  assert.equal(budgetBeforeRead.report.items[0].current, true);
  assert.equal(budgetBeforeRead.report.items[0].configured.limits.tokens, 1_200_000);
  await refreshBudget.click();
  await waitFor(() => refreshBudget.isEnabled(), 30000, 'original budget observation settled');
  const budgetAfterRead = await control('budget-inspect');
  assert.equal(budgetAfterRead.ledgerSha256, budgetBeforeRead.ledgerSha256);
  assert.equal(budgetAfterRead.report.items[0].observation.charged.tokens, 0);
  await nativeBudget.scrollIntoViewIfNeeded();
  await page.screenshot({ path: context.pathInArtifacts('organization-native-budget-status.png') });
  const restored = await control('policy-backup-restore');
  assert.equal(restored.installedOperatorBackupRestore, true);
  assert.equal(restored.portableMetadataOnly, true);
  assert.equal(restored.originalWorkerBindingsUnchanged, true);
  assert.equal(restored.originalBudgetJournalUnchanged, true);
  assert.equal(restored.originalSourceUnchanged, true);
  const result = { realBrowser: true, realSshAndAuthenticatedAccounts: true, readerUid: ready.readerUid,
    publisherUid: ready.publisherUid, sameIdDifferentOwners: true, explicitCurrentAdoption: true,
    originalSourceUnchanged: true, currentDisabledAfterReload: true, revocationWithdrawsBody: true,
    narrowContainment: true, actualAdministratorExecutionPolicy: true, explicitBudgetAdjustment: true,
    nativeSourceMetadataSaved: true, managementOwnerIsNotImplicitReader: true, savedSourceImmutable: true,
    actualAdministratorBudgetInitialization: true, nativeBudgetReadPreservesOriginalJournal: true,
    actualOperatorPolicyRestorePreservesWorkersBudgetAndKnowledge: true,
    modelCalls: 0, binarySha256: ready.runtimeSha256 };
  await context.writeArtifactJson('organization-knowledge-native-result.json', result);
  completed = true;
  return result;
});
