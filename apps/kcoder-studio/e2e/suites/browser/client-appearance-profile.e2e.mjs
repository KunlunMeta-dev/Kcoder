import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium, expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'electron-client-appearance-and-avatar-persistence', tier: 'full-integration',
  modelPolicy: 'model-independent real Electron image decoding, appearance and client preference persistence; no model turns',
}, async context => {
  // QA: select a real raster file, exercise actual style consumers, reload, separate themes,
  // remove/reset and recover from invalid input. All processes and preferences are run-owned.
  if (process.platform !== 'linux' || process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== '1')
    throw new Error('UNMET_PREREQUISITE: Linux isolated Xvfb and explicit no-sandbox opt-in required');
  const xvfb = await requireExecutable('/usr/bin/xvfb-run', 'Xvfb runner');
  const electron = await requireExecutable(resolve(appRoot, 'node_modules/electron/dist/electron'), 'Electron');
  const binary = await requireExecutable(resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'appearance' });
  await context.writeStateJson('profile/settings.json', {});
  await context.writeStateJson('profile/credentials.json', {});
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Appearance fixture', transport: 'local', command: binary, workspace: workspace.path },
  ]);
  let output = '';
  const child = context.spawnOwned('electron-appearance', xvfb,
    ['-a', '-s', '-screen 0 1440x1000x24 -nolisten tcp', electron, '--no-sandbox', '--disable-gpu',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', resolve(appRoot, 'desktop/main.mjs')],
    { cwd: appRoot, env: context.isolatedEnvironment({
      KCODER_CONFIG_DIR: context.pathInState('profile'), KCODER_STUDIO_SERVERS_FILE: serversFile,
      KCODER_STUDIO_KCODER_BIN: binary, KCODER_STUDIO_WORKSPACE: workspace.path,
      KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState('electron-profile'),
      KCODER_STUDIO_WEB_ROOT: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist'),
    }) });
  const capture = chunk => { output = `${output}${chunk}`.slice(-16000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const cdp = await waitFor(() => output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],
    30000, 'Electron appearance CDP', 100, context.abortSignal);
  context.registerPort('electron-appearance-cdp', Number(new URL(cdp).port));
  const browser = await chromium.connectOverCDP(cdp);
  context.addCleanup('close appearance CDP', () => browser.close());
  const page = await waitFor(() => browser.contexts().flatMap(item => item.pages()).find(item => item.url().startsWith('http://127.0.0.1:')),
    30000, 'Electron appearance page', 100, context.abortSignal);
  const base = new URL(page.url()).origin;
  const select = async (id, file = resolve(repoRoot, 'logo/logo.png')) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId(id).click();
    await (await chooser).setFiles(file);
    await expect(page.getByTestId(id)).toBeEnabled();
  };
  const open = async section => {
    await page.goto(`${base}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId(`settings-nav-${section}`).click();
    await page.getByTestId(`${section}-settings-page`).waitFor({ timeout: 60000 });
  };
  const palette = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-border'));
  try {
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
    // Disable only the modern API; the fallback must still reach the real Xvfb clipboard.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      const button = document.createElement('button');
      button.dataset.testid = 'clipboard-fallback-probe'; button.textContent = 'Copy fixture';
      button.style.cssText = 'position:fixed;top:50px;left:300px;z-index:2147483647';
      button.onclick = async () => {
        try {
          await window.__TAURI_INTERNALS__.invoke('local_executor_copy_debug_info', { text: 'KCODER_OWNED_CLIPBOARD_PROBE' });
          button.dataset.status = 'copied';
        } catch { button.dataset.status = 'failed'; }
      };
      const input = document.createElement('textarea'); input.dataset.testid = 'clipboard-paste-probe';
      input.style.cssText = 'position:fixed;top:90px;left:300px;z-index:2147483647';
      document.body.append(button, input);
    });
    await page.getByTestId('clipboard-fallback-probe').click();
    await expect(page.getByTestId('clipboard-fallback-probe')).toHaveAttribute('data-status', 'copied');
    await page.getByTestId('clipboard-paste-probe').focus();
    await page.keyboard.press('Control+V');
    await expect(page.getByTestId('clipboard-paste-probe')).toHaveValue('KCODER_OWNED_CLIPBOARD_PROBE');
    await open('appearance');
    await page.getByTestId('appearance-mode-light').click();
    await select('appearance-background-select-button');
    await expect(page.getByTestId('appearance-background-preview').locator('img')).toHaveAttribute('src', /^data:image\/webp;base64,/);
    await page.getByTestId('appearance-background-visibility-slider').focus();
    await page.keyboard.press('End');
    await page.getByTestId('appearance-background-blur-slider').focus();
    await page.keyboard.press('End');
    await expect(page.getByTestId('workbench-background').locator('img')).toHaveCSS('filter', 'blur(20px)');
    await expect(page.getByTestId('workbench-background-overlay')).toHaveCSS('opacity', '0');
    const normalBorder = await palette();
    await page.getByTestId('appearance-contrast-slider').focus();
    await page.keyboard.press('End');
    await expect.poll(palette).not.toBe(normalBorder);
    await page.reload();
    await expect(page.getByTestId('appearance-background-blur-slider')).toHaveValue('20');
    await expect(page.getByTestId('appearance-background-visibility-slider')).toHaveValue('100');
    await expect.poll(() => page.getByTestId('appearance-background-preview').locator('img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await page.getByTestId('appearance-background-separate-toggle').click();
    await page.getByTestId('appearance-background-remove-button-dark').click();
    await page.getByTestId('appearance-mode-dark').click();
    await expect(page.getByTestId('workbench-background')).toHaveCount(0);
    await page.getByTestId('appearance-mode-light').click();
    await expect(page.getByTestId('workbench-background')).toHaveCount(1);
    await page.screenshot({ path: context.pathInArtifacts('appearance-light.png') });
    await page.getByTestId('appearance-reset-button').click();
    await expect(page.getByTestId('workbench-background')).toHaveCount(0);
    await open('general');
    await select('client-avatar-select');
    await expect(page.getByTestId('client-avatar-settings').getByTestId('client-avatar-image')).toBeVisible();
    await page.goto(base);
    await expect(page.getByTestId('sidebar-account-avatar').locator('img')).toHaveAttribute('src', /^data:image\/webp;base64,/);
    await page.reload();
    await expect(page.getByTestId('sidebar-account-avatar').locator('img')).toBeVisible();
    // Exercise the same installed renderer at a narrow viewport, not a separate mobile mock.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await page.getByTestId('open-mobile-drawer-button').click();
    await expect(page.getByTestId('mobile-settings-button').locator('img')).toBeVisible();
    await page.getByTestId('mobile-settings-button').click();
    await page.getByTestId('mobile-settings-personal-button').click();
    await page.getByTestId('mobile-settings-model-settings-button').click();
    await expect(page.getByTestId('provider-form')).toBeVisible();
    await page.getByTestId('mobile-model-settings-back-button').click();
    await page.getByTestId('mobile-settings-usage-button').click();
    await expect(page.getByTestId('usage-coverage')).toBeVisible();
    await expect(page.getByTestId('usage-refresh')).toHaveCSS('min-height', '44px');
    await page.getByTestId('mobile-usage-back-button').click();
    await page.getByTestId('mobile-settings-appearance-button').click();
    await page.getByTestId('appearance-mode-dark').click();
    await select('appearance-background-select-button');
    await page.getByTestId('appearance-background-area-sidebar').check();
    await page.getByTestId('mobile-appearance-back-button').click();
    await page.getByTestId('mobile-personal-back-button').click();
    await page.getByTestId('mobile-settings-back-button').click();
    await page.getByTestId('open-mobile-drawer-button').click();
    await expect(page.getByTestId('mobile-drawer').getByTestId('workbench-background')).toHaveCount(1);
    const drawerTheme = await page.getByTestId('mobile-drawer').evaluate(element => ({
      actual: getComputedStyle(element).backgroundColor,
      expected: getComputedStyle(document.documentElement).getPropertyValue('--color-mobile-drawer').trim(),
    }));
    assert.equal(drawerTheme.actual, `rgb(${drawerTheme.expected.split(/\s+/).join(', ')})`);
    await page.screenshot({ path: context.pathInArtifacts('mobile-dark-avatar.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await open('general');
    await select('client-avatar-select', { name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('not a raster image') });
    await expect(page.getByTestId('client-avatar-settings').getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('client-avatar-settings').locator('img')).toBeVisible();
    await page.getByTestId('client-avatar-remove').click();
    await expect(page.getByTestId('client-avatar-settings').locator('img')).toHaveCount(0);
    await page.getByTestId('settings-nav-browser').click();
    await expect(page.getByTestId('browser-downloads-unavailable')).toBeVisible();
    await expect(page.getByTestId('browser-download-location-change')).toHaveCount(0);
    await page.getByTestId('settings-nav-appshots').click();
    await expect(page.getByTestId('appshots-play-sound-toggle')).toBeDisabled();
    await expect(page.getByTestId('appshots-open-accessibility-settings-button')).toHaveCount(0);
    await page.goto(base);
    await expect(page.getByTestId('sidebar-account-avatar').locator('img')).toHaveCount(0);
    assert.equal(child.exitCode, null);
    return { passed: true, actualElectron: true, realRasterDecode: true, refreshPersisted: true,
      themeRemoval: true, contrastApplied: true, avatarReplacementAndReset: true, invalidImagePreservedAvatar: true };
  } catch (error) {
    if (!page.isClosed()) await page.screenshot({ path: context.pathInArtifacts('appearance-failed.png') }).catch(() => {});
    throw error;
  }
});
