import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { openRpc } from '../../harness/rpc.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'electron-native-project-directory-selection', tier: 'full-integration',
  modelPolicy: 'model-independent native directory dialog, project roots and Gateway target routing; no model turns',
}, async context => {
  // QA: a real OS picker selects a fixture directory, cancellation preserves roots, and
  // manual server-side browsing remains available. Only the isolated Xvfb receives input.
  if (process.platform !== 'linux' || process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== '1')
    throw new Error('UNMET_PREREQUISITE: Linux isolated Xvfb and explicit no-sandbox opt-in required');
  const xvfb = await requireExecutable('/usr/bin/xvfb-run', 'Xvfb runner');
  const xdotool = await requireExecutable('/usr/bin/xdotool', 'native dialog keyboard automation');
  const electron = await requireExecutable(resolve(appRoot, 'node_modules/electron/dist/electron'), 'Electron');
  const binary = await requireExecutable(resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'picker-workspace' });
  const chosen = await materializeWorkspace(context, 'minimal', { instanceId: 'picked-project' });
  const selectedPath = resolve(chosen.path, 'native-root');
  await mkdir(selectedPath);
  await context.writeStateJson('profile/settings.json', {});
  await context.writeStateJson('profile/credentials.json', {});
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Picker fixture', transport: 'local', command: binary, workspace: workspace.path },
  ]);
  let output = '';
  const child = context.spawnOwned('electron-directory-picker', xvfb,
    ['-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', electron, '--no-sandbox', '--disable-gpu',
      '--inspect=127.0.0.1:0', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      resolve(appRoot, 'desktop/main.mjs')],
    { cwd: appRoot, env: context.isolatedEnvironment({
      KCODER_CONFIG_DIR: context.pathInState('profile'), KCODER_STUDIO_SERVERS_FILE: serversFile,
      KCODER_STUDIO_KCODER_BIN: binary, KCODER_STUDIO_WORKSPACE: workspace.path,
      KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState('electron-profile'),
      KCODER_STUDIO_WEB_ROOT: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist'),
    }) });
  const capture = chunk => { output = `${output}${chunk}`.slice(-16000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const cdp = await waitFor(() => output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],
    30000, 'Electron CDP', 100, context.abortSignal);
  context.registerPort('electron-directory-cdp', Number(new URL(cdp).port));
  const browser = await chromium.connectOverCDP(cdp);
  context.addCleanup('close directory-picker CDP', () => browser.close());
  const page = await waitFor(() => browser.contexts().flatMap(item => item.pages()).find(item => item.url().startsWith('http://127.0.0.1:')),
    30000, 'Electron application page', 100, context.abortSignal);
  const inspectorUrl = await waitFor(() => output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],
    10000, 'Electron main inspector', 100, context.abortSignal);
  context.registerPort('electron-directory-main-inspector', Number(new URL(inspectorUrl).port));
  const inspector = await openRpc(inspectorUrl);
  context.addCleanup('close directory-picker main inspector', () => inspector.close());
  let sequence = 0;
  const evaluateMain = async expression => {
    const id = ++sequence;
    inspector.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    const response = await inspector.waitFor(message => message.id === id, 5000, 'native dialog main evaluation');
    if (response.error || response.result?.exceptionDetails) throw new Error('Native dialog inspection failed');
    return response.result.result.value;
  };
  const electronModule = "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')";
  const display = await evaluateMain('process.env.DISPLAY');
  assert.match(display, /^:\d+(?:\.\d+)?$/);
  const xauthority = await evaluateMain('process.env.XAUTHORITY');
  assert.equal(typeof xauthority, 'string');
  let inputSequence = 0;
  const nativeInput = async args => {
    const input = context.spawnOwned(`directory-native-input-${++inputSequence}`, xdotool, args,
      { env: context.isolatedEnvironment({ DISPLAY: display, XAUTHORITY: xauthority }) });
    await waitFor(() => input.exitCode !== null, 5000, 'isolated native keyboard input', 50, context.abortSignal);
    assert.equal(input.exitCode, 0);
  };
  try {
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
    // Instrument invocation only: the original Electron method still creates and resolves
    // the real OS dialog; no native selection or cancellation result is mocked.
    await evaluateMain(`(() => {
      const { app, dialog } = ${electronModule}; app.setPath('home', ${JSON.stringify(selectedPath)});
      const original = dialog.showOpenDialog; globalThis.__directoryCalls = [];
      dialog.showOpenDialog = (...args) => { globalThis.__directoryCalls.push(args[1]); return original(args[0], { ...args[1], title: 'KCoder directory fixture' }); };
      return true;
    })()`);
    const rejected = await page.evaluate(async () => {
      try { await window.kcoderDesktopHost.pickWorkspacePaths({ serverId: 'foreign-target', initialDirectory: null, multiple: true }); return false; }
      catch { return true; }
    });
    assert.equal(rejected, true);
    await page.getByTestId('projects-create-button').click();
    await page.getByTestId('project-create-local-option').click();
    await waitFor(async () => await evaluateMain('globalThis.__directoryCalls.length') === 1,
      10000, 'native folder dialog invoked from project creation', 50, context.abortSignal);
    await nativeInput(['search', '--sync', '--onlyvisible', '--name', '^KCoder directory fixture$']);
    await nativeInput(['key', '--clearmodifiers', 'ctrl+l']);
    await nativeInput(['type', '--clearmodifiers', '--delay', '0', selectedPath]);
    await nativeInput(['key', '--clearmodifiers', 'Return']);
    await nativeInput(['key', '--clearmodifiers', 'alt+o']);
    await page.getByTestId('local-project-create-dialog').waitFor({ timeout: 10000 });
    await expect(page.getByTestId('local-project-create-root-0').locator('span[title]')).toHaveAttribute('title', selectedPath);
    const options = await evaluateMain('globalThis.__directoryCalls[0]');
    assert.deepEqual(options.properties, ['openDirectory', 'multiSelections']);
    await page.getByTestId('add-local-project-create-folders').click();
    await waitFor(async () => await evaluateMain('globalThis.__directoryCalls.length') === 2,
      10000, 'native folder add dialog', 50, context.abortSignal);
    await nativeInput(['search', '--sync', '--onlyvisible', '--name', '^KCoder directory fixture$']);
    await nativeInput(['key', '--clearmodifiers', 'Escape']);
    await expect(page.getByTestId('add-local-project-create-folders')).toBeEnabled();
    await expect(page.getByTestId('local-project-create-root-0').locator('span[title]')).toHaveAttribute('title', selectedPath);
    await expect(page.getByTestId('local-project-create-root-1')).toHaveCount(0);
    await page.getByTestId('local-project-create-enter-path').click();
    await expect(page.getByTestId('device-folder-path-input')).toBeVisible();
    await page.getByTestId('cancel-device-folder-picker-button').click();
    await page.getByTestId('local-project-create-name-input').fill('Native picker project');
    await page.getByTestId('confirm-local-project-create-button').click();
    await page.getByTestId('local-project-create-dialog').waitFor({ state: 'hidden', timeout: 30000 });
    await expect(page.getByTestId('desktop-sidebar').getByText('Native picker project', { exact: true })).toBeVisible();
    await page.screenshot({ path: context.pathInArtifacts('native-directory-project-created.png') });
    await context.writeArtifactJson('checks.json', { nativeDirectoryDialog: true, nativeSelection: true,
      cancellationPreservedRoots: true, manualPathAvailable: true, targetRegistration: true,
      windowsNativeExecution: false, multiSelectionNativeKeyboardNotExercised: true });
    await evaluateMain(`setTimeout(() => ${electronModule}.app.quit(), 100); true`);
    inspector.close(); await browser.close();
    await waitFor(() => child.exitCode !== null, 15000, 'directory-picker desktop cleanup', 100, context.abortSignal);
    assert.equal(child.exitCode, 0);
    return { passed: true, host: process.platform, nativeSelectionExercised: true, windowsNativeExecution: false };
  } catch (error) {
    if (!page.isClosed()) await page.screenshot({ path: context.pathInArtifacts('native-directory-failed.png') }).catch(() => {});
    throw error;
  }
});
