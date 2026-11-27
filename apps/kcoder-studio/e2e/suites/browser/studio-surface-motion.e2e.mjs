import assert from 'node:assert/strict';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startSourceDesktop } from '../../harness/source-desktop.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'studio-page-card-and-dialog-motion', tier: 'full-integration',
  modelPolicy: 'Actual local Studio renderer and Gateway. No model turns or external requests.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'motion' });
  await context.writeStateJson('config/settings.json', {});
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Local', transport: 'local', command: binary, workspace }]);
  const desktop = Boolean(process.env.KCODER_E2E_ELECTRON_BIN);
  let page, origin;
  if (desktop) {
    ({ page } = await startSourceDesktop(context, { label: 'studio-motion-desktop', profile: context.pathInState('config'),
      servers: serversFile, workspace, kcoderBin: binary, rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT }));
    await expect(page.getByTestId('desktop-sidebar')).toBeVisible({ timeout: 60000 });
    origin = new URL(page.url()).origin;
  } else {
    const gateway = await startGateway(context, { workspace, kcoderBin: binary, serversFile,
      serversStore: context.pathInState('servers-store.json'), env: { KCODER_CONFIG_DIR: context.pathInState('config') } });
    const browser = await startChromium(context, { label: 'studio-motion' });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    origin = gateway.baseUrl;
  }
  await page.goto(origin + '/settings/tools');
  const search = page.getByTestId('tool-selections-search');
  await expect(page.getByTestId('tool-selections-target')).toHaveValue('local');
  await search.fill('ListSessions');
  await expect(page.getByTestId('tool-selection-ListSessions')).toBeVisible();
  const tabs = page.getByTestId('tool-selections-mode-kworker');
  // The Web Animations API exposes only actual running effects. Observe the commit
  // in a microtask, before paint, without extending or pausing the production motion.
  const animation = page.evaluate(() => new Promise((resolve, reject) => {
    const panel = document.querySelector('#tool-selection-panel');
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Tab selection did not commit')); }, 5000);
    const observer = new MutationObserver(() => {
      if (!panel.getAttribute('aria-labelledby')?.endsWith('kworker')) return;
      observer.disconnect(); clearTimeout(timer);
      const owned = panel.getAnimations().find(effect => effect.id === 'studio-page-enter');
      resolve({ duration: owned?.effect.getTiming().duration,
        frames: owned?.effect.getKeyframes().map(frame => frame.opacity),
        sidebarAnimated: document.querySelector('[data-testid="settings-sidebar"]').getAnimations().length > 0 });
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['aria-labelledby'] });
  }));
  await tabs.click();
  const observed = await animation;
  assert.ok(observed.duration > 0 && observed.duration <= 240);
  assert.equal(observed.frames.at(-1), '1');
  assert.equal(observed.sidebarAnimated, false);
  await expect(tabs).toBeFocused();
  await expect(search).toHaveValue('ListSessions');
  await page.getByTestId('settings-nav-model-settings').click();
  const card = page.getByTestId('provider-configured-models');
  const summary = card.locator('summary').first();
  await expect(card).toHaveAttribute('open', '');
  await summary.focus();
  // Capture both intrinsic height transitions on the native summary's keyboard path.
  const toggleAndObserve = async open => {
    const result = card.evaluate((node, intended) => new Promise((resolve, reject) => {
      const before = node.getBoundingClientRect().height, samples = [before];
      const deadline = performance.now() + 4000;
      const frame = () => {
        const height = node.getBoundingClientRect().height;
        samples.push(height);
        const recent = samples.slice(-3);
        if (node.open === intended && Math.abs(height - before) > 1 &&
            recent.length === 3 && recent.every(value => value === height))
          resolve({ from: before, to: height, intermediate: samples.some(value =>
            value > Math.min(before, height) + 0.5 && value < Math.max(before, height) - 0.5) });
        else if (performance.now() > deadline) reject(new Error('Card geometry did not settle'));
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }), open);
    const [observation] = await Promise.all([result, summary.press('Enter')]);
    return observation;
  };
  const closed = await toggleAndObserve(false);
  const opened = await toggleAndObserve(true);
  assert.ok(closed.intermediate && opened.intermediate && opened.to > closed.to);
  await expect(summary).toBeFocused();

  await page.getByTestId('settings-nav-general').click();
  const trigger = page.getByTestId('general-external-content-import-button');
  await trigger.click();
  const dialog = page.getByTestId('migration-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('animation-name', 'studio-overlay-enter');
  assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  return { host: desktop ? 'electron' : 'browser', page: observed, collapsed: closed, expanded: opened, dialogReturnedFocus: true };
});
