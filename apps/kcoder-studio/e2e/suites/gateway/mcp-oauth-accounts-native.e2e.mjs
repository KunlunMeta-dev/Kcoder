import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, openRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { login } from '../../harness/http.mjs';

await runE2E(import.meta.url, {
  testId: 'native-oauth-same-app-two-subject-credential-isolation', tier: 'full-integration',
  retainSuccessEvidence: true,
  modelPolicy: 'Original Native OAuth and tool execution with owned two-subject issuer; controlled protocol Provider only, zero paid models or vendor quality claims.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit frozen Native CLI');
  const binarySha = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binarySha, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const identity = await stat(binary);
  assert.equal(identity.nlink, 1);
  const issuerSource = fileURLToPath(new URL('../../harness/oauth-mcp.mjs', import.meta.url));
  const issuerSourceSha = createHash('sha256').update(await readFile(issuerSource)).digest('hex');
  await context.writeArtifactJson('native-two-account-source-pins.json', { binarySha256: binarySha, issuerSourceSha256: issuerSourceSha, explicitOauthSlots: true });
  context.addCleanup('verify two-account immutable Native binary and issuer source', async () => {
    const after = await stat(binary);
    assert.deepEqual([after.dev, after.ino, after.size, after.nlink], [identity.dev, identity.ino, identity.size, 1]);
    assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), binarySha);
    assert.equal(createHash('sha256').update(await readFile(issuerSource)).digest('hex'), issuerSourceSha);
  });
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const issuer = await startOAuthMcpFixture(context, { manualApproval: true, resourceScopes: ['probe:read'], accountSubjects: ['A', 'B'] });
  let selected = 'A', allowMissing = false, phase = 'setup';
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    assert.ok(model.requests.length <= 40, 'The owned account protocol has a finite HTTP budget');
    if (body.messages.some(message => message.role === 'tool')) return [{ delta: { content: 'OWNED_ACCOUNT_READ_COMPLETE' }, finishReason: 'stop' }];
    const tool = body.tools.find(tool => tool.function?.name.includes(`account_${selected.toLowerCase()}`) && tool.function.name.includes('oauth_probe'));
    if (!tool && allowMissing) return [{ delta: { content: 'OWNED_SELECTED_ACCOUNT_REAUTHORIZATION_REQUIRED' }, finishReason: 'stop' }];
    assert.ok(tool, `Original account ${selected} MCP tool is registered`);
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `read-account-${selected}`, type: 'function', function: { name: tool.function.name, arguments: '{}' } }] }, finishReason: 'tool_calls' }];
  } });
  const settings = {
    active_provider: 'fixture', permission_mode: 'yolo', model: 'owned-account-protocol', credential_store: 'file', max_retries: 0,
    session_memory: { enabled: false }, memory: { observer_mode: 'disabled', structured_enabled: false, legacy_prompt_enabled: false },
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'owned-account-protocol', context_window_tokens: 128000, max_output_tokens: 256, output_headroom_tokens: 256, discover_models: false, no_proxy: true } },
    integrations: { connectivity: { enabled: true } },
    mcp_servers: ['A', 'B'].map(subject => ({ name: `account_${subject.toLowerCase()}`, transport: 'http', url: issuer.root + '/mcp', policy: { oauth_account: `owned-slot-${subject}` } })),
  };
  await context.writeStateJson('profile/settings.json', settings);
  await context.writeStateJson('profile/trusted-folders.json', { trusted: [workspace], never: [] });
  const gateway = await startGateway(context, { auth: true, workspace, kcoderBin: binary, gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT,
    env: { KCODER_CONFIG_DIR: context.pathInState('profile') } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' })), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close two-subject original Native RPC', () => closeRpcAndWait(rpc));
  await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'native-two-subject-account-isolation', version: '1' }, capabilities: { experimental: { integrationScopeV1: true, connectivityV1: true, taskSourcesV1: true } } }, 60000);
  const scope = await rpc.request('integrations/scope/read', {});
  let serial = 0;
  const control = async (method, payload, operationId, expectedRevision) => {
    const reply = await rpc.request(`integrations/connectivity/${method}`, { contractVersion: 'parallel-v1', requestId: `account-${++serial}`, scope, timeoutMs: 30000, payload,
      ...(operationId ? { operationId } : {}), ...(expectedRevision ? { expectedRevision } : {}) }, 35000);
    assert.equal(reply.status, 'completed', reply.error?.code ?? 'Original application control must complete');
    return reply.result;
  };
  const connections = {};
  for (const subject of ['A', 'B']) connections[subject] = await control('prepareConnectionAction', { action: 'save', connectionId: `owned-account-${subject}`, kind: 'tencent_docs', label: `Owned application slot ${subject}`, configuration: { mcpServerName: `account_${subject.toLowerCase()}` }, resourceGrants: [] }, `save-account-${subject}`);
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  context.addCleanup('close two-subject authorization browser page', () => page.close());
  const browserFailures = [];
  page.on('pageerror', () => browserFailures.push('PAGE_SCRIPT_ERROR'));
  await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
  await page.getByTestId('connectivity-button').click();
  await page.getByTestId('native-connectivity-workspace').waitFor({ timeout: 30000 });
  const authorizationApprovals = [];
  const authorize = async (subject, approvedSubject = subject) => {
    phase = `authorize-slot-${subject}-subject-${approvedSubject}`;
    const before = issuer.accountEvents.filter(event => event.type === 'authorize' && event.subject === approvedSubject).length;
    const row = page.locator('article').filter({ has: page.getByRole('heading', { name: `Owned application slot ${subject}`, exact: true }) });
    await row.getByRole('button', { name: /授权或更新私有凭证|Authorize or update private credentials/ }).click();
    const panel = page.getByRole('region', { name: /应用授权|Application authorization/ });
    await panel.getByRole('button', { name: /开始浏览器授权|Start browser authorization/ }).click();
    const link = panel.getByRole('link', { name: /在浏览器授权|Authorize in browser/ });
    await link.waitFor({ timeout: 30000 });
    const url = await link.getAttribute('href'); context.registerSecret(url);
    assert.equal(new URL(new URL(url).searchParams.get('redirect_uri')).origin, gateway.baseUrl);
    const opened = page.waitForEvent('popup'); await link.click(); const popup = await opened;
    await popup.locator(`#approve-${approvedSubject}`).click({ noWaitAfter: true });
    await waitFor(() => issuer.accountEvents.filter(event => event.type === 'authorize' && event.subject === approvedSubject).length === before + 1, 15000, `original ${subject} token exchange`, 50, context.abortSignal);
    await waitFor(async () => (await rpc.request('mcp/list', {})).servers.find(server => server.name === `account_${subject.toLowerCase()}`)?.authorization === 'authorized', 15000, `original ${subject} authorization receipt`, 50, context.abortSignal);
    await panel.getByRole('button', { name: /我已完成，刷新状态|Refresh authorization status/ }).click();
    await panel.waitFor({ state: 'detached', timeout: 15000 });
    if (!popup.isClosed()) await popup.close();
    authorizationApprovals.push({ slot: subject, approvedSubject, completedAtMs: Date.now() });
  };
  const reads = [];
  const read = async (subject, missingAllowed = false) => {
    phase = `read-${subject}${missingAllowed ? '-may-be-unavailable' : ''}`;
    selected = subject;
    allowMissing = missingAllowed;
    const startedAtMs = Date.now();
    const beforeAuthorization = await status(subject);
    const before = model.requests.length;
    const { thread } = await rpc.request('thread/start', {});
    const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: `Read the explicitly selected account ${subject} resource.` }] });
    const done = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 30000, `original ${subject} resource read`);
    const outputs = model.requests.slice(before).flatMap(body => body.messages.filter(message => message.role === 'tool').map(message => String(message.content)));
    const observed = outputs.flatMap(output => [...output.matchAll(/OAUTH_SUBJECT_([AB])_RESOURCE_\1_ONLY/g)].map(match => match[1]));
    reads.push({ requested: subject, observed, startedAtMs, completedAtMs: Date.now(), beforeAuthorization, afterAuthorization: await status(subject), terminal: done.params.turn.status, errorCode: done.params.error?.code ?? null,
      fixedToolCodes: outputs.flatMap(output => output.match(/(?:TASK_SOURCE|NATIVE_SOURCE|NATIVE_MCP|MCP_OAUTH|APPLICATION)_[A-Z0-9_]+/g) ?? []) });
    return observed;
  };
  const status = async subject => (await rpc.request('mcp/list', {})).servers.find(server => server.name === `account_${subject.toLowerCase()}`).authorization;
  const refreshCount = subject => issuer.accountEvents.filter(event => event.type === 'refresh' && event.subject === subject).length;
  const observations = [];
  const observe = async stage => {
    phase = stage;
    const listing = await control('listConnections', { category: 'applications' });
    const snapshot = { stage, atMs: Date.now(), accounts: listing.sources.map(source => ({ source: source.name, authorization: source.authorization, choice: source.taskSourceChoice })), taskSources: listing.taskSources };
    observations.push(snapshot);
    return snapshot;
  };
  try {
    await authorize('A');
    await authorize('B');
    const aAfterB = await read('A');
    const bAfterBoth = await read('B');
    assert.deepEqual(aAfterB, ['A'], 'Authorizing subject B must preserve original subject A credential selection');
    assert.deepEqual(bAfterBoth, ['B']);
    const both = await observe('both-authorized');
    const accountA = both.accounts.find(account => account.source === 'account_a')?.choice?.accountRef;
    const accountB = both.accounts.find(account => account.source === 'account_b')?.choice?.accountRef;
    assert.ok(accountA && accountB && accountA.id !== accountB.id, 'Native account refs come from two actual credential slots');
    // Short-lived access tokens are issued by the original server and expire by the real clock.
    issuer.setNextAccessLifetime('A', 15); await authorize('A');
    const staleA = await observe('a-reauthorized-original-account-choice-stale');
    assert.equal(staleA.accounts.find(account => account.source === 'account_a')?.choice, null, 'Reauthorization cannot transfer the older account/resource epoch');
    assert.deepEqual(await read('A'), ['A']);
    const beforeAExpiry = await observe('a-short-lived-original-authorization');
    await waitFor(async () => await status('A') === 'expired', 20000, 'actual A access expiry', 50, context.abortSignal);
    const bRefreshBeforeA = refreshCount('B'), aRefreshBefore = refreshCount('A');
    assert.deepEqual(await read('A'), ['A']);
    assert.equal(refreshCount('A'), aRefreshBefore + 1); assert.equal(refreshCount('B'), bRefreshBeforeA);
    const afterARefresh = await observe('a-refreshed-with-b-unchanged');
    assert.deepEqual(afterARefresh.accounts.map(account => account.choice), beforeAExpiry.accounts.map(account => account.choice), 'Refresh retains both actual Native account identities and epochs');
    issuer.setNextAccessLifetime('B', 15); await authorize('B');
    assert.deepEqual(await read('B'), ['B']);
    const beforeBExpiry = await observe('b-short-lived-original-authorization');
    await waitFor(async () => await status('B') === 'expired', 20000, 'actual B access expiry', 50, context.abortSignal);
    const aRefreshBeforeB = refreshCount('A'), bRefreshBefore = refreshCount('B');
    assert.deepEqual(await read('B'), ['B']);
    assert.equal(refreshCount('B'), bRefreshBefore + 1); assert.equal(refreshCount('A'), aRefreshBeforeB);
    const afterBRefresh = await observe('b-refreshed-with-a-unchanged');
    assert.deepEqual(afterBRefresh.accounts.map(account => account.choice), beforeBExpiry.accounts.map(account => account.choice));
    connections.A = await control('prepareConnectionAction', { action: 'disconnect', connectionId: connections.A.id }, 'disconnect-only-account-a', connections.A.revision);
    assert.equal(await status('A'), 'notAuthorized'); assert.equal(await status('B'), 'authorized');
    assert.deepEqual(await read('B'), ['B']);
    await observe('a-disconnected-b-still-reads');
    connections.A = await control('prepareConnectionAction', { action: 'enable', connectionId: connections.A.id }, 'explicitly-reenable-only-account-a', connections.A.revision);
    await page.reload({ waitUntil: 'domcontentloaded' });
    if (!await page.getByTestId('native-connectivity-workspace').isVisible()) await page.getByTestId('connectivity-button').click();
    await page.getByTestId('native-connectivity-workspace').waitFor({ timeout: 30000 });
    await authorize('A'); issuer.expireAccess('A');
    assert.deepEqual(await read('A', true), [], 'A real server 401 cannot borrow B or report success');
    assert.equal(refreshCount('A'), aRefreshBeforeB, 'A server 401 does not blindly replay the original request');
    await authorize('A'); assert.deepEqual(await read('A'), ['A']);
    issuer.setNextAccessLifetime('A', 2); await authorize('A'); issuer.loseNextRefreshResponse('A');
    await waitFor(async () => await status('A') === 'expired', 10000, 'actual A expiry before lost refresh receipt', 50, context.abortSignal);
    const beforeUnknown = refreshCount('A');
    assert.deepEqual(await read('A', true), []);
    assert.equal(await status('A'), 'reauthorizationRequired');
    assert.equal(refreshCount('A'), beforeUnknown + 1);
    assert.deepEqual(await read('A', true), []);
    assert.equal(refreshCount('A'), beforeUnknown + 1, 'Unknown refresh outcome is reconciled without reusing the spent refresh token');
    assert.deepEqual(await read('B'), ['B']);
    await observe('a-refresh-unknown-b-still-reads');
    await authorize('A'); assert.deepEqual(await read('A'), ['A']);
    const beforeSubjectChange = await observe('before-actual-subject-change-in-original-slot-a');
    await authorize('A', 'B');
    const changedSubject = await observe('actual-subject-b-in-original-slot-a-old-choice-stale');
    assert.equal(changedSubject.accounts.find(account => account.source === 'account_a')?.choice, null);
    assert.deepEqual(changedSubject.accounts.find(account => account.source === 'account_b')?.choice, beforeSubjectChange.accounts.find(account => account.source === 'account_b')?.choice);
    assert.deepEqual(await read('A'), ['B'], 'The actual issuer subject, not the slot name, determines resource content');
    assert.deepEqual(await read('B'), ['B']);
    assert.deepEqual(browserFailures, []);
    await page.screenshot({ path: context.pathInArtifacts('native-two-application-account-slots.png') });
    await context.writeArtifactJson('same-app-two-native-subject-observation.json', { binarySha256: binarySha, sameIssuerResourceEndpoint: true,
      originalNativeOAuth: true, formalApplicationUi: true, accountEvents: issuer.accountEvents, authorizationApprovals, reads, observations, browserFailures, modelRequests: model.requests.length, paidModels: 0, vendorQualityClaim: false });
    return { twoSubjectsIsolated: true, independentRefresh: true, independentDisconnect: true, explicitReauthorizationRecovery: true, unknownRefreshNotReplayed: true, reads, paidModels: 0 };
  } catch (error) {
    const fixedUiCodes = (await page.locator('details code').allTextContents()).map(code => /^[A-Z0-9_]{1,128}$/.test(code) ? code : 'NON_FIXED_UI_ERROR');
    const currentAuthorizations = (await rpc.request('mcp/list', {}).catch(() => ({ servers: [] }))).servers;
    await context.writeArtifactJson('same-app-two-native-subject-failure.json', { binarySha256: binarySha, phase, accountEvents: issuer.accountEvents, authorizationApprovals, reads, observations, currentAuthorizations, browserFailures, fixedUiCodes, modelRequests: model.requests.length, paidModels: 0 });
    throw error;
  }
});
