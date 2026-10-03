import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { runE2E, requireExecutable, waitFor, repoRoot } from '../../harness/run-context.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';

// Model-independent Windows UI contract: a controlled provider requests an actual
// cropped native screenshot, then holds its stream so the real Stop UI can be
// exercised deterministically. Real model reasoning is covered by model_probe.py.
// The explicit locked mode validates installed readiness/approval refusal only;
// it never creates a desktop fixture or asks the model to operate the desktop.
const expectLocked = process.env.KCODER_E2E_DESKTOP_EXPECT_LOCKED === '1';
await runE2E(import.meta.url, {
  testId: expectLocked ? 'windows-computer-use-locked-approval' : 'windows-computer-use-approval-preview-stop', tier: 'manual-live',
  modelPolicy: 'owned loopback provider; real packaged Electron/Gateway/CLI/native desktop; UI contract only',
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
  const settingsPath = context.pathInState('home/settings.json');
  let desktop;
  let sawImage = false;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    if (!JSON.stringify(body.messages).includes('OWNED_DESKTOP_UI'))
      return [{ delta: { content: 'fixture' }, finishReason: 'stop' }];
    if (body.messages.some(message => message.role === 'tool')) {
      sawImage = body.messages.some(message => message.role === 'user' && Array.isArray(message.content)
        && message.content.some(part => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')));
      return [{ delta: { content: 'DESKTOP_IMAGE_RECEIVED' } }, { ready: () => false, finishReason: 'stop' }];
    }
    assert.ok(desktop, 'owned fixture must be ready before desktop request');
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 1, id: 'owned-shot', type: 'function', function: {
      name: 'mcp__kcoder_computer_use__Screenshot', arguments: JSON.stringify({ region: desktop.region }),
    } }] }, finishReason: 'tool_calls' }];
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
  const desktopRequests = new Set();
  const network = await page.context().newCDPSession(page);
  await network.send('Network.enable');
  const captureFrame = (direction, event) => {
    try {
      const frame = JSON.parse(event.response.payloadData);
      const method = [frame.method, frame.params?.method].filter(value => typeof value === 'string').join('/');
      const key = `${event.requestId}:${frame.id}`;
      if (direction === 'sent' && method) wire.push({ direction, method, id: frame.id, at: Date.now() });
      if (method.includes('computerUse')) desktopRequests.add(key);
      if (direction === 'received' && desktopRequests.has(key))
        wire.push({ direction, id: frame.id, result: frame.result, error: frame.error, at: Date.now() });
    } catch { /* Non-JSON frames are unrelated to this RPC diagnostic. */ }
  };
  network.on('Network.webSocketFrameSent', event => captureFrame('sent', event));
  network.on('Network.webSocketFrameReceived', event => captureFrame('received', event));
  try {
    await page.getByTestId('chat-message-input').waitFor({ timeout: 60000 });
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
    const powershell = await requireExecutable(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'PowerShell');
    context.spawnOwned('desktop-fixture', powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(repoRoot, 'scripts/computer-use/live/fixture.ps1'), '-OutputDirectory', fixtureOutput,
      '-LifetimeSeconds', '300'], { env });
    context.addCleanup('close owned desktop fixture', () => writeFile(join(fixtureOutput, 'close.fixture'), ''));
    desktop = await waitFor(async () => {
      try { return JSON.parse((await readFile(join(fixtureOutput, 'fixture-ready.json'), 'utf8')).replace(/^\uFEFF/, '')); }
      catch { return null; }
    }, 20000, 'owned fixture');
    await page.getByTestId('chat-message-input').fill('OWNED_DESKTOP_UI: inspect only the owned desktop test window');
    await page.getByTestId('computer-use-submit').click();
    await page.getByTestId('computer-use-checking').waitFor({ timeout: 5000 });
    assert.ok(await page.getByTestId('computer-use-cancel').isEnabled(), 'pending preflight must remain cancellable');
    await page.getByTestId('computer-use-cancel').click();
    await page.getByTestId('computer-use-approval').waitFor({ state: 'hidden' });
    assert.equal(model.requests.filter(body => JSON.stringify(body.messages).includes('OWNED_DESKTOP_UI')).length, 0);
    await page.getByTestId('computer-use-submit').click();
    await waitFor(() => page.getByTestId('computer-use-confirm').isEnabled(), 60000, 'desktop approval');
    await page.getByTestId('computer-use-confirm').click();
    const status = page.getByTestId('computer-use-status');
    await status.waitFor({ timeout: 90000 });
    assert.equal(await status.getAttribute('data-state'), 'active');
    await page.getByText('DESKTOP_IMAGE_RECEIVED', { exact: true }).waitFor({ timeout: 90000 });
    assert.ok(sawImage, 'actual screenshot must reach provider as an image');
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
    const beforeStop = Date.now();
    await status.getByRole('button').click();
    await status.waitFor({ state: 'hidden', timeout: 20000 });
    await waitFor(() => model.requestOutcomes.some(value => value.aborted), 15000, 'provider stream cancelled');
    // Consent belongs to the accepted task: a normal subsequent send must
    // acquire desktop control without reopening the approval dialog.
    assert.match(await page.getByTestId('computer-use-submit').innerText(), /桌面已授权/);
    await page.getByTestId('chat-message-input').fill('OWNED_DESKTOP_UI follow-up');
    await page.getByTestId('send-message-button').click();
    assert.equal(await page.getByTestId('computer-use-approval').count(), 0);
    await status.waitFor({ timeout: 90000 });
    assert.equal(await status.getAttribute('data-state'), 'active');
    await page.getByTestId('computer-use-submit').click();
    await status.waitFor({ state: 'hidden', timeout: 20000 });
    assert.equal(await page.getByTestId('computer-use-submit').innerText(), '桌面控制');
    await context.writeArtifactJson('assertions.json', { cancelledApprovalDoesNotSend: true,
      pendingPreflightCancellable: true,
      activeStatus: true, nativeScreenshotToModel: sawImage, livePreview: true,
      stoppedStatus: true, stopMillis: Date.now() - beforeStop,
      screenshotRetainedReason: 'first real Windows desktop UI approval and stop integration evidence',
    });
    await page.screenshot({ path: context.pathInArtifacts('windows-desktop-stopped.png') });
    return { approval: true, preview: true, stop: true, modelQualityTest: false };
  } catch (error) {
    await context.writeArtifactJson('desktop-rpc-timing.json', wire.slice(-100));
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    throw error;
  } finally {
    await writeFile(join(fixtureOutput, 'close.fixture'), '').catch(() => {});
    await browser.close().catch(() => {});
    await context.stopOwned('studio');
  }
});
