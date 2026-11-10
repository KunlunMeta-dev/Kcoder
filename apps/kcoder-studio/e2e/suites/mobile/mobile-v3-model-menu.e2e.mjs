import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { buildCurrentFixture } from '../../mobile-design-atlas/current-fixture/build.mjs';
import { startRecoveryFixture } from '../../fixtures/mobile-send-recovery/server.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'mobile-v3-model-menu', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'Model-independent actual Mobile list/detail and menu components with synthetic preference/rename state; no Gateway, real model, external mutation or native-device acceptance',
}, async run => {
  const built = await buildCurrentFixture(run);
  const base = await startRecoveryFixture(run, built.output);
  const browser = await startChromium(run, { label: 'v3-model-menu-browser', noSandbox: true });
  const cases = [], diagnostics = [];
  for (const variant of [
    { width: 390, height: 844, language: 'zh-CN', theme: 'light' },
    { width: 320, height: 568, language: 'zh-CN', theme: 'dark' },
    { width: 390, height: 844, language: 'en', theme: 'dark' },
    { width: 320, height: 568, language: 'en', theme: 'light' },
  ]) {
    const label = `${variant.width}-${variant.language}-${variant.theme}`;
    const page = await browser.newPage({ viewport: { width: variant.width, height: variant.height }, isMobile: true, hasTouch: true });
    page.on('pageerror', error => diagnostics.push({ label, type: 'exception', text: error.message }));
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) diagnostics.push({ label, type: message.type(), text: message.text() }); });
    const ui = id => page.getByTestId(id);
    const capture = async name => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}/${name} horizontal overflow`);
      await page.screenshot({ path: run.pathInArtifacts(`${label}-${name}.png`) });
    };
    try {
      await page.goto(`${base}?${new URLSearchParams({ state: 'model-picker', ...variant })}`, { waitUntil: 'load' });
      await ui('conversation-model-list').waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      let initial = await ui('conversation-model-sheet').boundingBox();
      const sameGeometry = async () => {
        const current = await ui('conversation-model-sheet').boundingBox();
        assert.ok(Math.abs(initial.y - current.y) <= 1 && Math.abs(initial.height - current.height) <= 1, 'list/detail navigation has stable sheet geometry');
      };
      assert.equal(await ui('conversation-model-efforts').count(), 0);
      await capture('model-list');
      for (const [id, efforts] of [['layout-model', 3], ['compact-model', 1], ['plain-model', 0]]) {
        const selection = ui(`conversation-model-${id}`);
        const disclosure = ui(`conversation-model-details-${id}`);
        const selectionBox = await selection.boundingBox(), disclosureBox = await disclosure.boundingBox();
        assert.ok(selectionBox.x + selectionBox.width <= disclosureBox.x + 1 && disclosureBox.width === 44, 'selection and detail navigation have separate non-overlapping hit areas');
        await selection.click();
        await ui('conversation-model-sheet').waitFor({ state: 'detached' });
        await ui('fixture-model-selector').waitFor();
        await capture(`model-selected-${id}`);
        await ui('fixture-model-selector').click();
        await ui('conversation-model-list').waitFor();
        initial = await ui('conversation-model-sheet').boundingBox();
        assert.equal(await selection.getAttribute('aria-checked'), 'true');
        assert.equal(await ui('conversation-model-details').count(), 0, 'reopening the selector starts at the list');
        assert.equal((await ui('conversation-model-list').innerText()).includes('✓'), false, 'selection does not add a checkmark');
        await disclosure.click();
        await ui('conversation-model-details').waitFor();
        assert.equal(await page.locator('[data-testid^="conversation-model-effort-"]').count(), efforts);
        if (efforts) {
          await ui(`conversation-model-effort-${id === 'layout-model' ? 'high' : 'low'}`).click();
          assert.equal(await ui(`conversation-model-effort-${id === 'layout-model' ? 'high' : 'low'}`).getAttribute('aria-checked'), 'true');
        } else await ui('conversation-model-no-efforts').waitFor();
        await sameGeometry(); await capture(`model-detail-${id}`);
        await ui('conversation-model-back').click(); await ui('conversation-model-list').waitFor();
        assert.equal(await ui(`conversation-model-${id}`).getAttribute('aria-checked'), 'true');
        assert.equal(await ui('conversation-model-efforts').count(), 0);
        await sameGeometry();
      }
      await ui('conversation-model-details-plain-model').click();
      await page.keyboard.press('Escape');
      await ui('conversation-model-list').waitFor();
      await ui('conversation-model-close').click();
      await ui('conversation-model-sheet').waitFor({ state: 'detached' });
      await ui('task-more').click(); await ui('task-menu-sheet').waitFor();
      assert.equal(await ui('task-rename-input').count(), 0, 'main menu does not contain the rename form');
      const items = ['v3-menu-permissions', 'task-menu-search', 'task-menu-workspace', 'task-quick-phrases', 'mobile-subagents-open', 'task-menu-management'];
      const iconGeometry = [];
      for (const id of items) {
        const row = ui(id); assert.equal(await row.count(), 1);
        iconGeometry.push(await row.locator('svg').first().boundingBox());
        assert.ok((await row.boundingBox()).height >= 52);
      }
      assert.ok(iconGeometry.every(box => box.width === 20 && box.height === 20 && Math.abs(box.x - iconGeometry[0].x) <= 1), 'action icons have a shared size and alignment');
      await capture('task-menu');
      assert.equal(await ui('delete-task').count(), 0, 'management actions live in their submenu');
      await ui('task-menu-management').click(); await ui('rename-task').waitFor();
      for (const id of ['rename-task', 'compact-task', 'archive-task-menu', 'delete-task']) {
        const glyph = await ui(id).locator('svg').first().boundingBox();
        assert.ok(glyph.width === 20 && glyph.height === 20 && Math.abs(glyph.x - iconGeometry[0].x) <= 1, 'management rows use the same action recipe');
      }
      await capture('management-menu');
      await ui('rename-task').click(); await ui('task-rename-input').waitFor();
      await ui('task-rename-input').fill('discard this title'); await ui('cancel-task-rename').click();
      await ui('rename-task').waitFor();
      assert.equal(await ui('task-header-title').innerText(), '移动端布局检查');
      await ui('rename-task').click(); await ui('task-rename-input').fill('local rename check');
      await capture('rename-details');
      await ui('save-task-title').click(); await ui('rename-task').waitFor();
      assert.equal(await ui('task-header-title').innerText(), 'local rename check');
      await ui('delete-task').scrollIntoViewIfNeeded();
      const content = await ui('task-menu-content').boundingBox(), last = await ui('delete-task').boundingBox();
      assert.ok(last.y >= content.y && last.y + last.height <= content.y + content.height + 1, 'the final action is reachable inside the scroll area');
      page.once('dialog', dialog => dialog.dismiss()); await ui('delete-task').click();
      await ui('task-menu-sheet').waitFor();
      await page.keyboard.press('Escape'); await ui('task-menu-management').waitFor();
      await ui('task-menu-close').click(); await ui('task-menu-sheet').waitFor({ state: 'hidden' });
      cases.push({ ...variant, modelChoices: 3, selectionClosesPicker: true, reasoningOnlyInDetails: true, stableModelSheet: true, uniformMenu: true, renameCancelAndSave: true, finalActionReachable: true, destructiveConfirmationRetained: true });
    } catch (error) { await capture('failure').catch(() => {}); throw error; }
    finally { await page.close(); }
  }
  await run.writeArtifactJson('results.json', { cases, diagnostics });
  assert.deepEqual(diagnostics, [], 'browser diagnostics');
  return { cases: cases.length, diagnostics: diagnostics.length };
});
