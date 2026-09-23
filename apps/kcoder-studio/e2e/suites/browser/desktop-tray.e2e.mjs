import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium, expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { openRpc } from '../../harness/rpc.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'electron-local-and-remote-tray-lifecycle', tier: 'full-integration',
  modelPolicy: 'model-independent native Electron window, trusted preload IPC, client preferences and process cleanup; no model turns',
}, async context => {
  // QA: both hosts preserve a hidden window, restore it, open settings and exit explicitly.
  // Invalid IPC is rejected; remote exit must not stop the independently owned Gateway.
  if (process.platform !== 'linux') throw new Error('UNMET_PREREQUISITE: real Electron tray test requires Linux Xvfb');
  if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== '1') throw new Error('UNMET_PREREQUISITE: isolated VM no-sandbox opt-in required');
  const xvfb = await requireExecutable('/usr/bin/xvfb-run', 'Xvfb runner');
  const electron = await requireExecutable(resolve(appRoot, 'node_modules/electron/dist/electron'), 'Electron');
  const binary = await requireExecutable(resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'desktop-tray' });
  const profile = context.pathInState('runtime-profile');
  await context.writeStateJson('runtime-profile/settings.json', {});
  await context.writeStateJson('runtime-profile/credentials.json', {});
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Tray fixture', transport: 'local', command: binary, workspace: workspace.path },
  ]);
  const gateway = await startGateway(context, {
    label: 'remote-tray-gateway', auth: true, serversFile, workspace: workspace.path,
    env: { KCODER_CONFIG_DIR: profile },
  });
  const checks = [];
  for (const mode of ['local', 'remote']) {
    let output = '';
    const child = context.spawnOwned(`electron-tray-${mode}`, xvfb,
      ['-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', electron, '--no-sandbox', '--disable-gpu',
        '--inspect=127.0.0.1:0', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        resolve(appRoot, `desktop/${mode === 'local' ? 'main' : 'remote-main'}.mjs`)],
      { cwd: appRoot, env: context.isolatedEnvironment({
        KCODER_CONFIG_DIR: profile, KCODER_STUDIO_SERVERS_FILE: serversFile,
        KCODER_STUDIO_WORKSPACE: workspace.path, KCODER_STUDIO_KCODER_BIN: binary,
        KCODER_STUDIO_WEB_ROOT: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist'),
        KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState(`electron-${mode}`),
        KCODER_STUDIO_TEST_WINDOWS_MENU: '1',
        KCODER_STUDIO_REMOTE_URL: gateway.baseUrl, KCODER_STUDIO_REMOTE_TOKEN: gateway.authToken,
      }) });
    const capture = chunk => { output = `${output}${chunk}`.slice(-16000); };
    child.stderr.on('data', capture);
    child.stdout.on('data', capture);
    const cdpUrl = await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`Electron ${mode} exited (${child.exitCode})`);
      return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
    }, 30000, `${mode} Electron CDP`, 100, context.abortSignal);
    context.registerPort(`${mode}-electron-cdp`, Number(new URL(cdpUrl).port));
    const browser = await chromium.connectOverCDP(cdpUrl);
    context.addCleanup(`close ${mode} Electron CDP`, () => browser.close());
    const page = await waitFor(() => browser.contexts().flatMap(item => item.pages())
      .find(item => item.url().startsWith('http://127.0.0.1:')), 30000, `${mode} desktop window`, 100, context.abortSignal);
    const inspectorUrl = await waitFor(() => output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],
      10000, `${mode} main inspector`, 100, context.abortSignal);
    context.registerPort(`${mode}-main-inspector`, Number(new URL(inspectorUrl).port));
    const inspector = await openRpc(inspectorUrl);
    context.addCleanup(`close ${mode} main inspector`, () => inspector.close());
    let sequence = 0;
    const evaluateMain = async expression => {
      const id = ++sequence;
      inspector.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      const response = await inspector.waitFor(message => message.id === id, 5000, 'Electron main evaluation');
      if (response.error || response.result?.exceptionDetails) throw new Error('Electron main evaluation failed');
      return response.result.result.value;
    };
    const electronModule = "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')";
    const windowExpression = `${electronModule}.BrowserWindow.getAllWindows()[0]`;
    try {
      await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
      await page.getByTestId('desktop-menu-bar').waitFor({ timeout: 30000 });
      assert.deepEqual(await page.evaluate(async () => (await window.kcoderDesktopMenu.list()).map(item => item.label)), ['文件', '编辑', '视图']);
      await page.getByTestId('settings-button').click();
      await expect(page.getByTestId('quit-app-menu-button')).toBeVisible();
      await expect(page.getByTestId('logout-menu-button')).toHaveCount(mode === 'remote' ? 1 : 0);
      await page.getByTestId('settings-button').click();
      const bridge = await page.evaluate(async () => {
        const host = window.kcoderDesktopHost;
        const status = await host.setPreferences({ closeToTrayEnabled: true, language: 'en' });
        const rejected = await Promise.all([
          () => host.windowAction('delete'),
          () => host.setPreferences({ closeToTrayEnabled: 'true', language: 'en' }),
          () => host.setTrayState({ language: 'en', activeTaskIds: [], command: 'quit' }),
        ].map(async invoke => { try { await invoke(); return false; } catch { return true; } }));
        return { available: status.available, rejected, keys: Object.keys(host).sort() };
      });
      assert.equal(bridge.available, true, 'real Electron Tray must be created');
      assert.ok(bridge.rejected.every(Boolean));
      assert.deepEqual(bridge.keys, ['hideToTray', 'onMenuCommand', 'onSettings', ...(mode === 'local' ? ['pickWorkspacePaths'] : []), 'setPreferences', 'setTaskActivity', 'setTrayState', 'windowAction']);
      const windowId = await evaluateMain(`${windowExpression}.id`);
      await evaluateMain(`${windowExpression}.webContents.send('kcoder:tray:settings'); true`);
      await page.getByTestId('general-settings-page').waitFor({ timeout: 15000 });
      const toggle = page.getByTestId('general-close-to-tray-toggle');
      await toggle.waitFor();
      if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('general-close-to-tray-toggle').waitFor({ timeout: 30000 });
      await expect(page.getByTestId('general-close-to-tray-toggle')).toHaveAttribute('aria-checked', 'true');
      await page.evaluate(() => window.kcoderDesktopHost.setTaskActivity(1));
      await evaluateMain(`${windowExpression}.close(); true`);
      await waitFor(async () => !(await evaluateMain(`${windowExpression}.isVisible()`)), 5000, 'window hidden in tray');
      assert.equal(child.exitCode, null);
      assert.equal(await evaluateMain(`${windowExpression}.id`), windowId);
      assert.equal(await page.evaluate(async () => (await fetch('/api/servers/status')).ok), true);
      // Native activation is covered by the controller unit test; second-instance uses the
      // same restore semantics here without claiming an Xvfb panel or Windows taskbar click.
      await evaluateMain(`${electronModule}.app.emit('second-instance'); true`);
      await waitFor(() => evaluateMain(`${windowExpression}.isVisible()`), 5000, 'window restored');
      assert.equal(await evaluateMain(`${windowExpression}.id`), windowId);
      await page.screenshot({ path: context.pathInArtifacts(`${mode}-tray-restored.png`) });
      await evaluateMain(`setTimeout(() => ${electronModule}.app.quit(), 100); true`);
      inspector.close();
      await browser.close();
      await waitFor(() => child.exitCode !== null, 15000, `${mode} explicit quit`, 100, context.abortSignal);
      assert.equal(child.exitCode, 0);
      assert.equal(gateway.child.exitCode, null, 'desktop exit must not stop the separately owned remote Gateway');
      checks.push({ mode, nativeTrayCreated: true, invalidIpcRejected: true, preferencePersisted: true,
        hiddenWindowPreserved: true, restoredSameWindow: true, explicitQuit: true });
    } catch (error) {
      if (!page.isClosed()) await page.screenshot({ path: context.pathInArtifacts(`${mode}-failure.png`) }).catch(() => {});
      throw error;
    }
  }
  await context.writeArtifactJson('checks.json', checks);
  return { passed: true, host: process.platform, windowsNativeExecution: false, modelTurns: 0 };
});
