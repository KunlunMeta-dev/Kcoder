import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { runE2E, requireExecutable, waitFor, repoRoot } from '../../harness/run-context.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { createOwnedDesktopModel, verifyOwnedDesktopRecovery, verifyOwnedDesktopClearRevokeTail } from '../../../renderer/e2e/desktop/scenarios/computer-use-recovery.scenario.mjs';
import { requestOwnedPageRpc } from '../../harness/owned-page-rpc.mjs';
import { waitOwnedDesktopControllersStopped } from '../../harness/owned-desktop-cleanup.mjs';

// Model-independent Windows UI contract: native input stays inside an owned
// opaque full-view fixture. Worker exit, observation-only recovery and host
// revocation use the actual packaged channel; model_probe.py covers reasoning.
// The explicit locked mode validates installed readiness/approval refusal only;
// it never creates a desktop fixture or asks the model to operate the desktop.
const tailOnly = process.env.KCODER_E2E_DESKTOP_TAIL_ONLY === '1';
const expectLocked = process.env.KCODER_E2E_DESKTOP_EXPECT_LOCKED === '1';
await runE2E(import.meta.url, {
  testId: tailOnly ? 'windows-computer-use-clear-revoke-tail' : expectLocked ? 'windows-computer-use-locked-approval' : 'windows-computer-use-approval-preview-recovery-revoke', tier: 'manual-live',
  modelPolicy: 'owned loopback provider; real packaged Electron/Gateway/CLI/native desktop; UI contract only',
  inputDiagnostics: process.env.KCODER_E2E_DESKTOP_INPUT_DIAGNOSTICS === '1',
}, async context => {
  assert.equal(process.platform, 'win32', 'Windows interactive session required');
  assert.ok(process.env.KCODER_E2E_PACKAGED_DIR, 'explicit owned package required');
  const root = resolve(process.env.KCODER_E2E_PACKAGED_DIR);
  const verification = join(root, 'kcoder-studio-cu-verification.exe');
  const hasVerification = await access(verification).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  const executable = await requireExecutable(hasVerification ? verification : join(root, 'kcoder-studio.exe'), 'Studio');
  const cli = await requireExecutable(join(root, 'resources/bin/kcoder.exe'), 'CLI');
  const workspace = context.pathInState('workspace');
  const fixtureOutput = context.pathInState('desktop-fixture');
  await mkdir(workspace, { recursive: true });
  await mkdir(fixtureOutput, { recursive: true });
  for (const directory of ['temp', 'appdata', 'localappdata']) await mkdir(context.pathInState(directory), { recursive: true });
  const settingsPath = context.pathInState('home/settings.json');
  let desktop;
  let powershell;
  let sawImage = false;
  const nativeModel = createOwnedDesktopModel(() => desktop, { tailOnly });
  const model = await startApprovalModelFixture(context, { responseSteps: input => {
    sawImage ||= input.body.messages?.some(message => message.role === 'user' && Array.isArray(message.content)
      && message.content.some(part => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')));
    return nativeModel.respond(input);
  } });
  await context.writeStateJson('home/settings.json', {
    permission_mode: 'yolo', active_provider: 'fixture', plugins: { runtime: { enabled: true } },
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'fixture', context_window_tokens: 128000,
      max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true,
      capabilities: { text: true, tools: true, vision: true } } },
  });
  await context.writeStateJson('home/credentials.json', {});
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Desktop UI fixture',
    transport: 'local', command: cli, workspace }]);
  const env = context.isolatedEnvironment({ KCODER_CONFIG_DIR: join(settingsPath, '..'),
    TEMP: context.pathInState('temp'), TMP: context.pathInState('temp'),
    APPDATA: context.pathInState('appdata'), LOCALAPPDATA: context.pathInState('localappdata'),
    KCODER_STUDIO_SERVERS_FILE: servers, KCODER_STUDIO_WORKSPACE: workspace,
    KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState('desktop-profile'),
    KCODER_STUDIO_WEB_ROOT: process.env.KCODER_E2E_RENDERER_ROOT,
  });
  const child = context.spawnOwned('studio', executable,
    ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { cwd: root, env });
  let output = '';
  const collect = data => { output = (output + data).slice(-16000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const endpoint = await waitFor(() => output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1], 90000, 'packaged CDP');
  context.registerPort('studio-cdp', Number(new URL(endpoint).port));
  const browser = await chromium.connectOverCDP(endpoint);
  context.addCleanup('disconnect Studio CDP', () => browser.close().catch(() => {}));
  const page = await waitFor(() => browser.contexts().flatMap(value => value.pages())
    .find(value => value.url().startsWith('http://127.0.0.1:')), 60000, 'Studio page');
  const wire = [];
  const lifecycle = [];
  const desktopRequests = new Map();
  const network = await page.context().newCDPSession(page);
  await network.send('Network.enable');
  const captureFrame = (direction, event) => {
    try {
      const frame = JSON.parse(event.response.payloadData);
      const method = [frame.method, frame.params?.method].filter(value => typeof value === 'string').join('/');
      const key = `${event.requestId}:${frame.id}`;
      if (direction === 'received' && frame.method === 'computerUse/stateChanged') {
        const facts = frame.params?.diagnostic ?? {};
        lifecycle.push({ state: frame.params?.state, threadId: frame.params?.threadId, turnId: frame.params?.turnId,
          authorization: facts.authorization, cleanup: facts.cleanup,
          hostPid: facts.hostPid, workerPid: facts.workerPid });
      }
      if (direction === 'sent' && method) wire.push({ direction, method, id: frame.id, at: Date.now() });
      if (method.includes('computerUse') && frame.id !== undefined) desktopRequests.set(key, method);
      if (direction === 'received' && desktopRequests.has(key))
        wire.push({ direction, method: desktopRequests.get(key), id: frame.id, result: frame.result, error: frame.error, at: Date.now() });
      if (direction === 'received' && frame.method === 'turn/completed')
        wire.push({ direction, method: frame.method, threadId: frame.params?.threadId,
          turnId: frame.params?.turnId, status: frame.params?.status, at: Date.now() });
    } catch { /* Non-JSON frames are unrelated to this RPC diagnostic. */ }
  };
  network.on('Network.webSocketFrameSent', event => captureFrame('sent', event));
  network.on('Network.webSocketFrameReceived', event => captureFrame('received', event));
  try {
    await page.getByTestId('chat-message-input').waitFor({ timeout: 60000 });
    if (!expectLocked) {
      // A fresh isolated profile must explicitly install the bundled guidance.
      // Bootstrap app-servers do not initialize a resident thread as a side effect.
      const [installed] = await requestOwnedPageRpc(page, { workspace, requests: [{ method: 'plugin/install',
        params: { marketplaceName: 'kcoder-bundled', pluginName: 'kcoder-windows-computer-use' } }] });
      assert.equal(installed.error, undefined, 'owned bundled plugin install must succeed');
      assert.equal(installed.result.plugin.id, 'kcoder-windows-computer-use@kcoder-bundled');
      await context.writeArtifactJson('desktop-plugin-prerequisite.json', { explicitBundledInstall: true, profileIsolated: true });
    }
    if (expectLocked) {
      await page.getByTestId('chat-message-input').fill('OWNED_DESKTOP_UI: locked readiness check');
      const originalSettings = await readFile(settingsPath, 'utf8');
      const duplicateSettings = JSON.parse(originalSettings);
      // Add after startup: this is a configuration-policy test, not an attempt
      // to launch another Windows-MCP process or send it any tool calls.
      duplicateSettings.mcp_servers = [{ name: 'existing-desktop', transport: 'stdio', command: 'windows-mcp.exe', args: [] }];
      await writeFile(settingsPath, JSON.stringify(duplicateSettings));
      await page.getByTestId('computer-use-submit').click();
      await waitFor(() => wire.some(frame => JSON.stringify(frame.result ?? {}).includes('existing_windows_mcp_requires_choice')),
        60000, 'real existing Windows-MCP response');
      await page.getByTestId('computer-use-checking').waitFor({ state: 'hidden' });
      assert.equal(await page.getByTestId('computer-use-confirm').isEnabled(), false);
      assert.match(await page.getByTestId('computer-use-approval').getByRole('status').innerText(),
        /Windows-MCP is already configured|已配置 Windows-MCP/);
      await page.getByTestId('computer-use-cancel').click();
      await page.getByTestId('computer-use-approval').waitFor({ state: 'hidden' });
      await writeFile(settingsPath, originalSettings);
      await page.getByTestId('computer-use-submit').click();
      await waitFor(() => wire.some(frame => JSON.stringify(frame.result ?? {}).includes('interactive_desktop_required')),
        60000, 'real locked desktop response');
      await page.getByTestId('computer-use-checking').waitFor({ state: 'hidden' });
      assert.equal(await page.getByTestId('computer-use-confirm').isEnabled(), false);
      const message = await page.getByTestId('computer-use-approval').getByRole('status').innerText();
      assert.match(message, /Unlock the target desktop|请解锁目标桌面/);
      await page.getByTestId('computer-use-cancel').click();
      await page.getByTestId('computer-use-approval').waitFor({ state: 'hidden' });
      await page.getByTestId('chat-message-input').click();
      assert.equal(await page.getByTestId('chat-message-input').evaluate(element => element === document.activeElement), true);
      assert.equal(model.requests.filter(body => JSON.stringify(body.messages).includes('OWNED_DESKTOP_UI')).length, 0);
      await context.writeArtifactJson('assertions.json', { lockedDesktopRejected: true,
        existingMcpExplained: true, configurationRecheckedWithoutRestart: true,
        confirmationDisabled: true, explainsUnlock: true, inputFocusRestored: true, desktopModelRequests: 0 });
      return { lockedDesktopRejected: true, modelQualityTest: false };
    }
    powershell = await requireExecutable(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'PowerShell');
    context.spawnOwned('desktop-fixture', powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(repoRoot, 'scripts/computer-use/live/fixture.ps1'), '-OutputDirectory', fixtureOutput,
      '-LifetimeSeconds', '600', '-FullViewIsolation',
      ...(process.env.KCODER_E2E_DESKTOP_INPUT_DIAGNOSTICS === '1' ? ['-InputDiagnostics'] : [])], { env });
    context.addCleanup('close owned desktop fixture', () => writeFile(join(fixtureOutput, 'close.fixture'), ''));
    desktop = await waitFor(async () => {
      try { return JSON.parse((await readFile(join(fixtureOutput, 'fixture-ready.json'), 'utf8')).replace(/^\uFEFF/, '')); }
      catch { return null; }
    }, 20000, 'owned fixture');
    assert.equal(desktop.fullViewIsolated, true, 'full-view capture cannot include private desktop backgrounds');
    await page.getByTestId('chat-message-input').fill('OWNED_DESKTOP_UI: inspect only the owned desktop test window');
    if (!tailOnly) {
    await page.getByTestId('computer-use-submit').click();
    await page.getByTestId('computer-use-checking').waitFor({ timeout: 5000 });
    assert.ok(await page.getByTestId('computer-use-cancel').isEnabled(), 'pending preflight must remain cancellable');
    await page.getByTestId('computer-use-cancel').click();
    await page.getByTestId('computer-use-approval').waitFor({ state: 'hidden' });
    assert.equal(model.requests.filter(body => JSON.stringify(body.messages).includes('OWNED_DESKTOP_UI')).length, 0);
    }
    await page.getByTestId('computer-use-submit').click();
    await waitFor(() => page.getByTestId('computer-use-confirm').isEnabled(), 60000, 'desktop approval');
    await page.getByTestId('computer-use-confirm').click();
    const status = page.getByTestId('computer-use-status');
    await status.waitFor({ timeout: 90000 });
    if (!tailOnly) assert.equal(await status.getAttribute('data-state'), 'active');
    await page.getByTestId('desktop-chat-scroll-content').getByText('DESKTOP_IMAGE_RECEIVED P11_INPUT_CONFIRMED', { exact: true }).waitFor({ timeout: 90000 });
    assert.ok(sawImage, 'actual screenshot must reach provider as an image');
    if (tailOnly) {
      const tail = await verifyOwnedDesktopClearRevokeTail({ context, page, model: nativeModel, fixtureOutput });
      await context.writeArtifactJson('assertions.json', { ...tail, modelQualityTest: false });
      return { ...tail, modelQualityTest: false };
    }
    for (const id of ['final-processing-toggle', 'processing-summary-toggle']) {
      const toggle = page.getByTestId(id);
      if (await toggle.count() && await toggle.first().getAttribute('aria-expanded') !== 'true') await toggle.first().click();
    }
    const details = page.locator('[data-tool-detail-toggle]');
    if (await details.count() && await details.first().getAttribute('aria-expanded') !== 'true') await details.first().click();
    await page.getByTestId('tool-image-observations').first().getByRole('button').first().click();
    await page.getByTestId('tool-image-preview').waitFor();
    assert.match(await page.getByTestId('tool-image-preview').locator('img').getAttribute('src'), /^data:image\/png;base64,/);
    await page.getByTestId('tool-image-preview').getByRole('button').click();
    const recovery = await verifyOwnedDesktopRecovery({ context, page, status, lifecycle,
      model: nativeModel, packageRoot: root, fixtureOutput, powershell, env, workspace });
    assert.match(await page.getByTestId('computer-use-cleanup').innerText(), /旧控制已释放|Old control released/);
    assert.match(await page.getByTestId('computer-use-channel').innerText(), /控制通道不可用|Control channel unavailable/);
    await context.writeArtifactJson('assertions.json', { cancelledApprovalDoesNotSend: true,
      pendingPreflightCancellable: true,
      activeStatus: true, nativeScreenshotToModel: sawImage, livePreview: true,
      stoppedStatus: true, ...recovery,
      screenshotRetainedReason: 'owned Windows full-view fixture approval, recovery and revoke integration evidence',
    });
    await page.screenshot({ path: context.pathInArtifacts('windows-desktop-stopped.png') });
    return { approval: true, preview: true, ...recovery, modelQualityTest: false };
  } catch (error) {
    await context.writeArtifactJson('desktop-rpc-timing.json', wire.filter(value => value.method?.includes('computerUse') || value.method?.startsWith('turn/')).slice(-100));
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    throw error;
  } finally {
    await context.writeArtifactJson('desktop-lifecycle.json', lifecycle).catch(() => {});
    await context.writeArtifactJson('native-model-call-boundaries.json', { calls: nativeModel.calls, nativeScreenshotObservedAtProvider: sawImage, modelQualityTest: false }).catch(() => {});
    await context.writeArtifactJson('desktop-rpc-timing.json', wire.filter(value => value.method?.includes('computerUse') || value.method?.startsWith('turn/')).slice(-100)).catch(() => {});
    if (process.env.KCODER_E2E_DESKTOP_INPUT_DIAGNOSTICS === '1') {
      const eventPath = join(fixtureOutput, 'input-events.jsonl');
      const events = await readFile(eventPath, 'utf8').catch(() => '');
      await context.writeArtifactJson('owned-input-events.json', events.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(() => {});
      const receipt = await readFile(join(fixtureOutput, 'input-result.json'), 'utf8').catch(() => '');
      if (receipt) await context.writeArtifactJson('owned-input-receipt.json', JSON.parse(receipt.replace(/^\uFEFF/, ''))).catch(() => {});
    }
    await context.stopOwned('studio');
    if (desktop && powershell) {
      await waitOwnedDesktopControllersStopped({ context, packageRoot: root, powershell, env });
      await context.writeArtifactJson('desktop-controller-cleanup.json', { ownedControllersExitedBeforeFixtureClosed: true });
    }
    await writeFile(join(fixtureOutput, 'close.fixture'), '').catch(() => {});
    await browser.close().catch(() => {});
  }
});
