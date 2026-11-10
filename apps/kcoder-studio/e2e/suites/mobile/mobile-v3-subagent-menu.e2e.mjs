import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { exportMobileWeb } from '../../harness/mobile-web-export.mjs';
import { materializeOwnedDependencies } from '../../harness/owned-dependencies.mjs';
import { captureMobileExportSourceSnapshot } from '../../harness/mobile-export-source-snapshot.mjs';
import { repoRoot } from '../../harness/run-context.mjs';
import { resolve } from 'node:path';
import { buildCurrentFixture } from '../../mobile-design-atlas/current-fixture/build.mjs';
import { startRecoveryFixture } from '../../fixtures/mobile-send-recovery/server.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'mobile-v3-subagent-menu', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'Model-independent V3 subagent header menu, focus and navigation using real components with frozen synthetic inputs; synthetic structured messages and frozen send callbacks; no Gateway, model or native-device claim',
}, async run => {
  if (process.argv.includes('--build-only')) {
    const snapshotRoot = run.pathInState('subagent-source-snapshot');
    const snapshot = await captureMobileExportSourceSnapshot({ snapshotRoot, layout: 'preflight-source-root', freezeFiles: true,
      sourceRoots: [
        { name: 'mobile', path: resolve(repoRoot, 'apps/kcoder-studio/mobile'), destination: 'apps/kcoder-studio/mobile' },
        { name: 'studio-shared', path: resolve(repoRoot, 'apps/kcoder-studio/shared'), destination: 'apps/kcoder-studio/shared' },
      ] });
    await run.writeArtifactJson('frozen-mobile-source.json', snapshot);
    const dependencies = await materializeOwnedDependencies(run, {
      sourceRoot: resolve(repoRoot, 'apps/kcoder-studio/mobile/node_modules'),
      destination: run.pathInState('subagent-menu-dependencies'), label: 'subagent-menu-dependencies',
    });
    await exportMobileWeb(run, { label: 'subagent-menu-web-build', dependencyRoot: dependencies.root,
      mobileRoot: resolve(snapshotRoot, 'apps/kcoder-studio/mobile') });
    return { platformBuildOnly: true };
  }
  const built = await buildCurrentFixture(run);
  const base = await startRecoveryFixture(run, built.output);
  const browser = await startChromium(run, { label: 'v3-subagent-menu-browser', noSandbox: true });
  const diagnostics = [], cases = [];
  for (const variant of [
    { width: 390, language: 'zh-CN', theme: 'light' },
    { width: 320, language: 'zh-CN', theme: 'dark' },
    { width: 390, language: 'en', theme: 'dark' },
    { width: 320, language: 'en', theme: 'light' },
  ]) {
    const name = `${variant.width}-${variant.language}-${variant.theme}`;
    const page = await browser.newPage({ viewport: { width: variant.width, height: 844 }, hasTouch: true, isMobile: true });
    page.on('pageerror', error => diagnostics.push({ name, level: 'exception', text: error.message }));
    page.on('console', message => {
      if (['warning', 'error'].includes(message.type())) diagnostics.push({ name, level: message.type(), text: message.text() });
    });
    const ui = id => page.getByTestId(id);
    const settle = () => page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    try {
      await page.goto(`${base}?${new URLSearchParams({ state: 'agent-running', ...variant })}`, { waitUntil: 'load' });
      await ui('message-input').fill('Keep the parent draft.');
      await ui('message-input').blur();
      await ui('task-more').click(); await ui('mobile-subagents-open').click();
      await ui('mobile-subagent-list').waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      await settle();
      for (const state of ['list', 'conversation']) {
        if (state === 'conversation') {
          await ui('mobile-subagent-layout-agent').click();
          await ui('mobile-subagent-conversation').waitFor();
          await settle();
          const input = ui('mobile-subagent-draft');
          const longDraft = '请检查这个项目的会话布局，保留输入和光标。'.repeat(36);
          await input.fill(longDraft);
          assert.equal(Math.round(await input.evaluate(element => element.getBoundingClientRect().height)), 105);
          await input.evaluate(element => { element.setSelectionRange(24, 24); window.__subagentInput = element; });
          await ui('mobile-subagent-panel').getByText('布局检查助手', { exact: true }).click();
          assert.equal(Math.round(await input.evaluate(element => element.getBoundingClientRect().height)), 42);
          assert.equal(await input.inputValue(), longDraft);
          assert.equal(await input.evaluate(element => element === window.__subagentInput && element.selectionStart === 24), true);
          const composer = await ui('mobile-subagent-composer').boundingBox();
          assert.ok(composer.y + composer.height <= 845 && composer.y > 600, 'Composer stays at the bottom of the panel');
          assert.equal(await ui('mobile-subagent-panel').getByTestId('composer-attachment').count(), 0, 'text-only capability has no attachment control');
          assert.equal(await ui('mobile-subagent-send').isDisabled(), true, 'synthetic send remains frozen');
          await page.screenshot({ path: run.pathInArtifacts(`${name}-composer-preview.png`) });
          await input.focus();
          assert.equal(Math.round(await input.evaluate(element => element.getBoundingClientRect().height)), 105);
          await page.screenshot({ path: run.pathInArtifacts(`${name}-composer-editing.png`) });
          await input.fill('Keep the child draft.'); await input.blur();
          cases.push({ ...variant, state: 'composer', boundedEditing: true, compactPreview: true, retainedInputAndCaret: true, textOnly: true });

        }
        const more = ui('mobile-subagent-more');
        const box = await more.boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44, `More keeps a touch-sized target: ${JSON.stringify(box)}`);
        assert.equal(await more.getAttribute('aria-label'), variant.language === 'en' ? 'More' : '更多');
        assert.equal(await ui('mobile-subagent-refresh').count(), 0, 'Refresh is not exposed in the header');
        await page.screenshot({ path: run.pathInArtifacts(`${name}-${state}.png`) });
        await more.click(); await ui('mobile-subagent-menu').waitFor();
        await settle();
        assert.equal(await ui('mobile-subagent-refresh').isDisabled(), true, 'the frozen fixture retains the caller refresh gate');
        assert.equal(await more.getAttribute('aria-expanded'), 'true');
        await page.screenshot({ path: run.pathInArtifacts(`${name}-${state}-menu.png`) });
        await page.keyboard.press('Escape');
        await ui('mobile-subagent-menu').waitFor({ state: 'detached' });
        assert.equal(await ui('mobile-subagent-panel').isVisible(), true, 'Escape closes only the menu');
        await more.click();
        if (state === 'list') {
          assert.equal(await ui('mobile-subagent-information-open').count(), 0, 'the list has no selected agent information');
        } else {
          assert.equal(await ui('mobile-subagent-information-open').innerText(), variant.language === 'en' ? 'Task information' : '任务信息');
          await ui('mobile-subagent-information-open').click();
          await ui('mobile-subagent-information').waitFor();
          assert.ok((await ui('mobile-subagent-information').innerText()).includes('/workspace/user-center'));
          assert.equal(await ui('mobile-subagent-refresh').count(), 0, 'information is its own menu view');
          await page.keyboard.press('Tab');
          assert.equal(await ui('mobile-subagent-information').evaluate(element => element.contains(document.activeElement)), true,
            'keyboard focus stays inside information');
          await settle();
          await page.screenshot({ path: run.pathInArtifacts(`${name}-task-information.png`) });
          await page.keyboard.press('Escape');
          await ui('mobile-subagent-information').waitFor({ state: 'detached' });
          assert.equal(await ui('mobile-subagent-conversation').isVisible(), true);
          await more.click();
          await ui('mobile-subagent-information-open').click();
          await ui('mobile-subagent-information-close').click();
          await ui('mobile-subagent-information').waitFor({ state: 'detached' });
          await more.click();
          assert.equal(await ui('mobile-subagent-information-open').isVisible(), true, 'reopening More starts at actions');
          cases.push({ ...variant, state: 'information', fromMore: true, selectableContext: true, escapeAndClose: true });
          await ui('mobile-subagent-history').click();
          assert.equal(await ui('mobile-subagent-draft').count(), 0, 'historical records are read-only');
          await more.click();
          assert.equal(await ui('mobile-subagent-history').innerText(), variant.language === 'en' ? 'Live' : '实时');
          await ui('mobile-subagent-history').click();
          assert.equal(await ui('mobile-subagent-draft').inputValue(), 'Keep the child draft.');
          await more.click();
          cases.push({ ...variant, state: 'history-return', historyFromMore: true, restoredDraft: true });
        }
        await ui('mobile-subagent-menu-close').click();
        assert.equal(await ui('mobile-subagent-conversation').getByText(variant.language === 'en' ? 'View technical details' : '查看技术详情').count(), 0);
        await more.click(); await ui('mobile-subagent-menu-close').click();
        await ui('mobile-subagent-menu').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        cases.push({ ...variant, state, moreMenu: true, disabledRefresh: true, escapeAndClose: true });
      }
      await ui('mobile-subagent-back').click(); await ui('mobile-subagent-list').waitFor();
      await ui('mobile-subagent-layout-agent').click();
      assert.equal(await ui('mobile-subagent-draft').inputValue(), 'Keep the child draft.');
      await ui('mobile-subagent-back').click(); await ui('mobile-subagent-list').waitFor();
      assert.equal(await ui('mobile-subagent-menu').count(), 0, 'returning to the list retires the menu');
      await page.keyboard.press('Escape'); await ui('mobile-subagent-panel').waitFor({ state: 'hidden' });
      assert.equal(await ui('message-input').inputValue(), 'Keep the parent draft.');
    } catch (error) {
      await page.screenshot({ path: run.pathInArtifacts(`${name}-failure.png`) });
      await run.writeArtifactJson('failure-diagnostics.json', diagnostics);
      throw error;
    } finally { await page.close(); }
  }
  await run.writeArtifactJson('browser-results.json', { cases, diagnostics });
  assert.deepEqual(diagnostics, [], 'no browser warnings or errors');
  return { cases, diagnostics };
});
