import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'original-native-remote-operation-user-controls', tier: 'full-integration',
  modelPolicy: 'Bounded deterministic protocol fixture selects fixed Native remote tools. Real ordinary Engine permissions, actual independent Native receiver/ledger and existing UI read/list/cancel are verified; no paid provider, autonomous selection quality or business content claim.', retainSuccessEvidence: true }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit current Native with remote controls');
  const binaryBefore = await stat(binary);
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(binaryBefore.nlink, 1, 'the actual receiver installation must have one fixed owned link');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256, 'explicit current normal Native SHA is required');
  context.addCleanup('verify original Native installation content and identity', async () => {
    const after = await stat(binary);
    assert.deepEqual([after.dev, after.ino, after.size, after.nlink], [binaryBefore.dev, binaryBefore.ino, binaryBefore.size, 1]);
    assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), binarySha256);
  });
  await context.writeArtifactJson('normal-native-installation.json', { binary, sha256: binarySha256,
    bytes: binaryBefore.size, device: binaryBefore.dev, inode: binaryBefore.ino, links: binaryBefore.nlink });
  let releaseReceiver = false;
  const receiver = await startApprovalModelFixture(context, { responseSteps: () => [
    { ready: () => releaseReceiver, delta: { role: 'assistant', content: 'Actual owned receiver result for original-operation UI.' } }, { finishReason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  let sourcePosts = 0;
  const source = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    assert.ok(++sourcePosts <= 3, 'one bounded original source turn only');
    const lastUser = body.messages.findLast(message => message.role === 'user');
    const cancelled = String(lastUser?.content).includes('REMOTE_UI_CANCEL_CASE');
    const suffix = cancelled ? 'cancel' : 'success';
    const results = body.messages.filter(message => message.role === 'tool');
    const catalog = results.findLast(message => message.tool_call_id === `catalog-${suffix}`);
    const delegated = results.findLast(message => message.tool_call_id === `delegate-${suffix}`);
    const call = (id, name, input) => [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }, { finishReason: 'tool_calls' }];
    if (!catalog) return call(`catalog-${suffix}`, 'RemoteCatalog', {});
    if (!delegated) {
      const observed = JSON.parse(catalog.content);
      return call(`delegate-${suffix}`, 'RemoteDelegate', { peerId: 'owned-native', peerRevision: observed.revision,
        prompt: 'Return the explicit bounded owned Native result.', maximumSeconds: 300 });
    }
    return [{ delta: { role: 'assistant', content: `REMOTE_UI_${suffix.toUpperCase()}_REPORTED` } }, { finishReason: 'stop' }];
  } });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'original-remote-controls' });
  const senderProfile = context.pathInState('sender'), receiverProfile = context.pathInState('receiver');
  const provider = (endpoint, model) => ({ api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint,
    default_model: model, context_window_tokens: 128000, max_output_tokens: 256, output_headroom_tokens: 8192, no_proxy: true, discover_models: false });
  const receiverSettings = { active_provider: 'OwnedReceiver', model: 'owned-receiver', max_tokens: 64, max_retries: 0,
    tools: { profile: 'none' }, session_memory: { enabled: false }, mcp_servers: [], plugins: { runtime: { enabled: false } }, skills: { auto_curator_enabled: false, auto_skill_review_enabled: false },
    providers: { OwnedReceiver: provider(receiver.baseUrl, 'owned-receiver') }, integrations: { remotes: { receiver: { enabled: false, allowedSenderAccounts: [], maximumTotalTokens: 100000, maximumModelCalls: 1, maximumDurationSeconds: 300 } } } };
  const receiverSettingsFile = await context.writeStateJson('receiver/settings.json', receiverSettings);
  const settingsFile = await context.writeStateJson('sender/settings.json', { active_provider: 'OwnedSource', model: 'owned-source', permission_mode: 'ask', max_tokens: 256, max_retries: 0, session_memory: { enabled: false },
    providers: { OwnedSource: provider(source.baseUrl, 'owned-source') }, integrations: { office: { enabled: true }, remotes: { enabled: true,
      outbound: { enabled: true, maximumTotalTokens: 200000, maximumModelCalls: 1, maximumDurationSeconds: 300 },
      nativeAcpPeers: [{ id: 'owned-native', enabled: true, profileDirectory: receiverProfile, maximumDurationSeconds: 300 }] } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned original-operation Native', transport: 'local', command: binary, workspace, settingsFile }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}), env: { KCODER_CONFIG_DIR: senderProfile } });
  const browser = await startChromium(context), page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [], methods = [];
  page.on('pageerror', error => errors.push(context.redactText(error.message)));
  page.on('websocket', socket => socket.on('framesent', event => { try { const frame = JSON.parse(String(event.payload)); if (frame.method) methods.push(frame.method); } catch {} }));
  const invoke = (method, params) => page.evaluate(async ({ method, params }) => window.__ELECTRON_INTERNALS__.invoke('local_executor_request', { method, params }), { method, params });
  const settings = async () => {
    await page.getByTestId('settings-button').click(); await page.getByTestId('settings-menu-button').click();
    const link = page.locator('a[href="/settings/kcoder-servers"]');
    if (await link.count()) await link.click();
    else await page.getByRole('button', { name: '运行目标', exact: true }).click();
    await page.getByTestId('native-remote-operation').waitFor({ timeout: 30000 });
  };
  const send = async marker => {
    await page.getByTestId('chat-message-input').fill(marker); await page.getByTestId('send-message-button').click();
    for (const tool of ['RemoteCatalog', 'RemoteDelegate']) {
      const approval = page.getByTestId('request-user-input-card').filter({ hasText: tool });
      await approval.waitFor({ timeout: 30000 });
      const choice = approval.locator('[data-testid^="request-user-input-option-"]').first();
      assert.match(await choice.innerText(), /仅允许这一次/, 'each actual tool receives its own one-operation permission');
      await choice.click();
    }
  };
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.waitForFunction(() => typeof window.__ELECTRON_INTERNALS__?.invoke === 'function', { timeout: 60000 });
    const scope = await invoke('runtime.integrations.request', { serverId: 'local', workspacePath: workspace, method: 'integrations/scope/read', params: {} });
    await context.writeArtifactJson('source-native-scope.json', scope);
    receiverSettings.integrations.remotes.receiver.enabled = true;
    receiverSettings.integrations.remotes.receiver.allowedSenderAccounts = [scope.accountId];
    await writeFile(receiverSettingsFile, `${JSON.stringify(receiverSettings, null, 2)}\n`, { mode: 0o600 });
    await send('REMOTE_UI_CANCEL_CASE: delegate the explicit owned Native request once.');
    await waitFor(() => receiver.requests.length === 1, 90000, 'actual receiver request before original cancellation');
    await settings();
    const panel = page.getByTestId('native-remote-operation');
    await panel.getByRole('button', { name: '读取最近十条原操作', exact: true }).click();
    const originalRow = panel.locator('[data-remote-operation-id]'); await originalRow.waitFor({ timeout: 30000 });
    const originalId = await originalRow.getAttribute('data-remote-operation-id'); assert.ok(originalId);
    await originalRow.click(); await panel.getByTestId('remote-operation-observation').waitFor();
    await panel.getByRole('button', { name: '请求取消', exact: true }).click();
    await page.getByTestId('remote-operation-cancel-confirm').getByRole('button', { name: '请求取消', exact: true }).click();
    await waitFor(async () => { await panel.getByRole('button', { name: '读取原操作', exact: true }).click(); return (await panel.innerText()).includes('已中断') && (await panel.innerText()).includes('已确认'); }, 30000, 'actual Native Interrupted plus confirmed original cleanup', 300);
    assert.equal(receiver.requests.length, 1, 'reading/cancelling cannot repeat the model or prompt');
    const before = source.requests.length;
    await page.screenshot({ path: context.pathInArtifacts('original-operation-native-interrupted.png'), fullPage: true });
    await page.setViewportSize({ width: 480, height: 900 });
    assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), 'narrow original control stays contained');
    await page.screenshot({ path: context.pathInArtifacts('original-operation-native-narrow.png'), fullPage: true });
    assert.ok(!methods.includes('integrations/remotes/delegate'), 'no direct delegate control route exists');
    assert.equal(errors.length, 0);
    await context.writeArtifactJson('original-operation-native-controls.json', { operationId: originalId, receiverPosts: receiver.requests.length,
      sourcePosts: before, nativeRead: true, actualInterrupted: true, cleanupConfirmed: true, businessCompleted: false,
      methods: methods.filter(method => method.startsWith('integrations/remotes/')), nativePermissionPath: true });
    return { originalId, receiverPosts: 1, actualNativeInterrupted: true, cleanupConfirmed: true, narrow: true, businessCompleted: false };
  } catch (error) {
    await context.writeArtifactJson('original-operation-failure-shape.json', { pathname: new URL(page.url()).pathname, sourcePosts: source.requests.length, receiverPosts: receiver.requests.length, methods: methods.filter(method => method.startsWith('integrations/remotes/')) });
    await page.screenshot({ path: context.pathInArtifacts('original-operation-control-failure.png'), fullPage: true, mask: [page.locator('input[name="token"]'), page.locator('input[type="password"]')] }).catch(() => {}); throw error; }
});
