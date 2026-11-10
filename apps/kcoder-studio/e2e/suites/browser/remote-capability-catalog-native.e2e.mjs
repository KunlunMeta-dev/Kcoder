import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, openRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { requireExecutable, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { startLocalRelay } from '../../harness/local-relay.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'remote-capability-existing-authenticated-connections', tier: 'full-integration',
  modelPolicy: 'Model-independent actual authenticated local and owned loopback SSH initialize/scope/readonly catalog. Zero model generation and zero thread/turn creation. ACP outbound and Relay business availability remain unverified, not passed.',
  retainSuccessEvidence: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current native app-server');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'UNEXPECTED_REMOTE_CATALOG_GENERATION' });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'remote-catalog-native' });
  const { path: remoteWorkspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'remote-catalog-ssh' });
  const settings = { active_provider: 'Configured', model: 'unused', max_retries: 0, session_memory: { enabled: false },
    providers: { Configured: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'unused', context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } } };
  const settingsFile = await context.writeStateJson('profile/settings.json', settings);
  const remoteSettingsFile = await context.writeStateJson('ssh-profile/settings.json', settings);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = context.pathInState('ssh-native');
  await writeFile(launcher, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(context.pathInState('ssh-profile'))}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
  const ssh = await startSshFixture(context);
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Catalog local target', transport: 'local', command: binary, workspace, settingsFile },
    { id: 'ssh-owned', label: 'Catalog SSH target', transport: 'ssh', host: '127.0.0.1', user: ssh.user,
      port: ssh.port, command: launcher, workspace: remoteWorkspace, settingsFile: remoteSettingsFile, acceptNewHostKey: true },
  ]);
  const relay = await startLocalRelay(context, { label: 'capability-relay' });
  const relaySource = relay.registrationObservationSource();
  const relaySecret = randomBytes(32).toString('base64url'); context.registerSecret(relaySecret);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}),
    env: { ...ssh.gatewayEnv, KCODER_CONFIG_DIR: context.pathInState('profile'), KCODER_STUDIO_RELAY_SECRET: relaySecret,
      KCODER_STUDIO_RELAY_IDENTITY_FILE: relaySource.identityFile, KCODER_STUDIO_RELAY_ORIGIN: relaySource.relayOrigin } });
  const relayConnection = await relay.connectGateway(gateway, { gatewaySecret: relaySecret });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1400, height: 1000 } });
  const methods = [], wireRecords = [], ownedRoutes = new Set(), errors = [];
  let lastWireAt = Date.now();
  await page.routeWebSocket('**/rpc?**', route => {
    const upstream = route.connectToServer(); ownedRoutes.add(route);
    route.onMessage(message => { try { const frame = JSON.parse(String(message)); if (frame.method) { methods.push(frame.method); wireRecords.push({ method: frame.method, commandKey: typeof frame.params?.command_key === 'string' ? frame.params.command_key.slice(0, 80) : null }); lastWireAt = Date.now(); } } catch {} upstream.send(message); });
    upstream.onMessage(message => route.send(message));
  });
  context.addCleanup('close owned remote catalog socket routes', () => { for (const route of ownedRoutes) { try { route.close(); } catch {} } ownedRoutes.clear(); });
  page.on('pageerror', error => errors.push(context.redactText(error.message).slice(0, 1000)));
  const rpcReaders = [];
  const invoke = (method, params = {}) => page.evaluate(async ({ method, params }) => {
    const ipc = window.__ELECTRON_INTERNALS__?.invoke;
    if (typeof ipc !== 'function') throw new Error('Actual LocalExecutor IPC is unavailable');
    return ipc('local_executor_request', { method, params });
  }, { method, params });
  const readAll = async () => {
    let page = await invoke('runtime.remotes.readCatalog'); const snapshotId = page.snapshotId;
    const entries = [...page.entries]; let pages = 1;
    while (page.nextCursor) {
      assert.ok(pages++ < 100, 'bounded remote directory pagination');
      page = await invoke('runtime.remotes.readCatalog', { cursor: page.nextCursor });
      assert.equal(page.snapshotId, snapshotId); assert.ok(page.entries.length <= 10); entries.push(...page.entries);
    }
    assert.equal(entries.length, page.total);
    return { entries, snapshotId, pages };
  };
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.waitForFunction(() => Boolean(document.getElementById('root')?.childElementCount), { timeout: 60000 });
    const csrf = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content'); assert.ok(csrf); context.registerSecret(csrf);
    const cookie = (await page.context().cookies(gateway.baseUrl)).map(item => `${item.name}=${item.value}`).join('; '); context.registerSecret(cookie);

    // Setup obtains native identities through the normal public integration path.
    // The catalog itself must never create these connections or send another RPC.
    const scopes = new Map();
    for (const [serverId, workspacePath] of [['local', workspace], ['ssh-owned', remoteWorkspace]]) {
      const scope = await invoke('runtime.integrations.request', { serverId, workspacePath, method: 'integrations/scope/read', params: {} });
      assert.ok(scope.accountId); assert.ok(scope.targetId); scopes.set(serverId, scope);
    }
    assert.notEqual(scopes.get('local').accountId, scopes.get('ssh-owned').accountId, 'Actual independent native profiles must not share an inferred owner');
    await waitFor(() => Date.now() - lastWireAt > 300, 5000, 'initial metadata requests settled');
    const before = methods.length;
    const directory = await readAll();
    const afterCatalog = methods.length;
    await context.writeArtifactJson('readonly-rpc-observations.json', { before, after: afterCatalog, during: methods.slice(before, afterCatalog), prior: methods.slice(0, before) });
    const concurrentReads = wireRecords.slice(before, afterCatalog);
    // The existing workbench can finish its independent repository metadata read
    // while this local projection paginates. Preserve those exact native commands;
    // they do not establish catalog business execution or authorize another call.
    const backgroundReadonlyKeys = new Set(['git_branch', 'git_branch_diff_shortstat', 'git_status_porcelain', 'git_remote_url']);
    assert.ok(concurrentReads.every(frame => frame.method === 'device/execute' && backgroundReadonlyKeys.has(frame.commandKey)), 'Directory pagination must not create a connection or issue an unrecognized native request');
    await context.writeArtifactJson('readonly-rpc-attribution.json', { wholePageBefore: before, wholePageAfter: afterCatalog, existingWorkbenchReadonlyCommands: concurrentReads });
    assert.ok(directory.pages > 1);
    for (const serverId of scopes.keys()) {
      const rows = directory.entries.filter(entry => entry.targetId === serverId);
      const native = rows.find(entry => entry.capability === 'native.protocol'
        && entry.nativeOwner?.accountId === scopes.get(serverId).accountId
        && entry.nativeOwner?.targetId === scopes.get(serverId).targetId); assert.ok(native);
      assert.equal(native.state, 'observed'); assert.equal(native.protocolVersion, '2026-07-27');
      assert.equal(native.transport, serverId === 'local' ? 'local' : 'ssh');
      assert.equal(native.identityState, 'observed'); assert.equal(native.nativeOwner.accountId, scopes.get(serverId).accountId);
      assert.equal(native.nativeOwner.targetId, scopes.get(serverId).targetId);
      assert.equal(native.businessState, 'unknown');
      assert.equal(rows.find(entry => entry.capability === 'acp.outbound').state, 'unavailable');
      const inbound = rows.find(entry => entry.capability === 'acp.inbound'); assert.ok(inbound);
      if (process.env.KCODER_E2E_REQUIRE_ACP_INBOUND === '1') { assert.equal(inbound.state, 'advertised'); assert.equal(inbound.protocolVersion, '1'); }
      for (const entry of rows) for (const schema of entry.schemas) assert.equal(schema.producerRevision, null);
    }
    const registration = directory.entries.find(entry => entry.capability === 'relay.registration'); assert.ok(registration);
    assert.equal(registration.state, 'observed'); assert.equal(registration.identityState, 'observed');
    assert.equal(registration.boundary.resource.id, relayConnection.gatewayId);
    assert.equal(registration.nativeOwner, null); assert.equal(registration.businessState, 'unknown');
    const publicText = JSON.stringify(directory);
    for (const privateValue of [workspace, remoteWorkspace, binary, launcher, settingsFile, remoteSettingsFile, gateway.authToken, relaySecret, relaySource.identityFile])
      assert.ok(!publicText.includes(privateValue), 'Directory must not expose private paths or credentials');

    await page.goto(`${gateway.baseUrl}/settings/kcoder-servers`, { waitUntil: 'domcontentloaded' });
    const panel = page.getByTestId('native-remote-capabilities'); await panel.waitFor({ timeout: 30000 });
    // A browser navigation destroys its runtime and its actual live observations.
    // Re-establish only the explicit metadata connection, then observe it in this page.
    await invoke('runtime.integrations.request', { serverId: 'local', workspacePath: workspace, method: 'integrations/scope/read', params: {} });
    const refresh = panel.getByTestId('remote-catalog-refresh');
    await waitFor(() => Date.now() - lastWireAt > 300, 5000, 'settings metadata requests settled');
    const uiBefore = methods.length; await refresh.click();
    await panel.getByTestId('remote-capability-entry').first().waitFor({ timeout: 30000 });
    const uiDuring = wireRecords.slice(uiBefore);
    assert.ok(uiDuring.every(frame => frame.method === 'device/execute' && backgroundReadonlyKeys.has(frame.commandKey)), 'UI refresh must not create a connection or issue an unrecognized native request');
    assert.ok(await panel.locator('[data-state="advertised"]').count() > 0);
    await page.emulateMedia({ colorScheme: 'light' }); await panel.screenshot({ path: context.pathInArtifacts('remote-capability-catalog-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' }); await panel.screenshot({ path: context.pathInArtifacts('remote-capability-catalog-dark.png') });
    await page.setViewportSize({ width: 480, height: 900 }); await page.emulateMedia({ colorScheme: 'light' });
    await panel.scrollIntoViewIfNeeded(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.screenshot({ path: context.pathInArtifacts('remote-capability-catalog-narrow.png') });
    for (const serverId of scopes.keys()) {
      const rpc = await openRpc(gatewayRpcUrl(gateway, serverId, csrf), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
      rpcReaders.push(rpc);
      await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'remote-directory-no-history-reader', version: '1' }, capabilities: {} });
      assert.equal((await rpc.request('thread/list', { limit: 10 })).threads.length, 0, 'Directory does not create conversations');
    }
    assert.equal(model.requests.length, 0);
    assert.ok(!methods.some(method => ['thread/start', 'thread/resume', 'turn/start'].includes(method)));
    assert.deepEqual(errors, []);
    const cases = [
      { id: 'actual-local-and-loopback-ssh-identity-schema-observation', status: 'passed', targets: ['local', 'ssh-owned'], pages: directory.pages, businessState: 'unknown' },
      { id: 'actual-relay-registration-metadata', status: 'passed', durableRegistrationObserved: true, onlineStatusClaimed: false, nativeOwner: null },
      { id: 'actual-readonly-native-rpc-and-model-zero-effects', status: 'passed', modelRequests: 0, conversations: 0, unexpectedNativeRpcs: 0, existingWorkbenchReadonlyCommands: concurrentReads },
      { id: 'actual-settings-directory-light-dark-narrow', status: 'passed', themes: ['light', 'dark'], narrow: 480 },
    ];
    await context.writeArtifactJson('cases.json', { cases, limitations: ['No paid model quality assertion', 'No outbound ACP runner', 'Relay registration is read, but no business execution is validated', 'Browser and Linux loopback SSH do not prove Windows/Electron installation behavior'] });
    return { cases: cases.length, modelRequests: 0, conversations: 0, loopbackSshMetadata: true };
  } finally { for (const rpc of rpcReaders) await closeRpcAndWait(rpc); await page.close(); }
});
