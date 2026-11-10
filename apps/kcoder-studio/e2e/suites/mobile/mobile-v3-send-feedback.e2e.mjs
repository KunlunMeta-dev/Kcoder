import assert from 'node:assert/strict';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { resolve } from 'node:path';
import { captureMobileExportSourceSnapshot } from '../../harness/mobile-export-source-snapshot.mjs';
import { materializeOwnedDependencies } from '../../harness/owned-dependencies.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { exportMobileWeb } from '../../harness/mobile-web-export.mjs';
import { buildCurrentFixture } from '../../mobile-design-atlas/current-fixture/build.mjs';
import { startRecoveryFixture } from '../../fixtures/mobile-send-recovery/server.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'mobile-v3-send-feedback', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'Model-independent V3 submission and model retry/failure presentation with real Mobile components, synthetic phase changes and frozen side effects; no Gateway, personal session, provider or native-device acceptance',
}, async run => {
  if (process.argv.includes('--build-only')) {
    const snapshotRoot = run.pathInState('source');
    const snapshot = await captureMobileExportSourceSnapshot({ snapshotRoot, layout: 'preflight-source-root', sourceRoots: [
      { name: 'mobile', path: resolve(repoRoot, 'apps/kcoder-studio/mobile'), destination: 'apps/kcoder-studio/mobile' },
      { name: 'studio-shared', path: resolve(repoRoot, 'apps/kcoder-studio/shared'), destination: 'apps/kcoder-studio/shared' },
    ] });
    await run.writeArtifactJson('source.json', snapshot);
    const dependencies = await materializeOwnedDependencies(run, {
      sourceRoot: resolve(repoRoot, 'apps/kcoder-studio/mobile/node_modules'),
      destination: run.pathInState('dependencies'), label: 'v3-send-build-dependencies',
    });
    await exportMobileWeb(run, { label: 'v3-send-platform-build', mobileRoot: resolve(snapshotRoot, 'apps/kcoder-studio/mobile'), dependencyRoot: dependencies.root });
    return { platformBuildOnly: true };
  }
  const built = await buildCurrentFixture(run);
  const base = await startRecoveryFixture(run, built.output);
  const browser = await startChromium(run, { label: 'v3-send-feedback-browser', noSandbox: true });
  const diagnostics = [], cases = [];
  for (const variant of [
    { width: 390, language: 'zh-CN', theme: 'light' },
    { width: 320, language: 'zh-CN', theme: 'dark' },
    { width: 390, language: 'en', theme: 'dark' },
    { width: 320, language: 'en', theme: 'light' },
  ]) {
    const name = `${variant.width}-${variant.language}-${variant.theme}`;
    const page = await browser.newPage({ viewport: { width: variant.width, height: 844 }, hasTouch: true, isMobile: true });
    page.on('pageerror', error => diagnostics.push({ name, type: 'exception', text: error.message }));
    page.on('console', message => {
      if (['warning', 'error'].includes(message.type())) diagnostics.push({ name, type: message.type(), text: message.text() });
    });
    try {
      await page.goto(`${base}?${new URLSearchParams({ state: 'reply', ...variant })}`, { waitUntil: 'load' });
      await page.getByTestId('current-v3-fixture').waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      const input = page.getByTestId('message-input');
      const changeScenario = async state => {
        await page.evaluate(state => {
          const url = new URL(location.href);
          url.searchParams.set('state', state);
          history.replaceState(null, '', url);
          dispatchEvent(new PopStateEvent('popstate'));
        }, state);
        await page.waitForFunction(scenario => document.querySelector('[data-testid="current-v3-fixture"]')?.dataset.scenario === scenario, state);
      };
      for (const state of ['provider-retry', 'provider-failed', 'provider-continued', 'provider-completed']) {
        await changeScenario(state);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}/${state} overflow`);
        const text = await page.locator('body').innerText();
        assert.ok(!text.includes('Provider main request failed'), 'raw retries stay behind details');
        assert.ok(!text.includes('运行失败'), 'the duplicate failure activity is absent');
        if (state === 'provider-retry' || state === 'provider-completed') {
          assert.equal(await page.getByTestId('provider-retry-notice').count(), 1);
          assert.equal(await page.getByTestId('provider-retry-details').count(), 0);
          const summary = await page.getByTestId('provider-retry-toggle').innerText();
          assert.ok(!summary.includes('完成') && !summary.includes('Completed'), 'retry progress is not success');
          await page.getByTestId('provider-retry-toggle').click();
          assert.equal(await page.getByTestId('provider-retry-details').getByText(/Provider main request failed/).count(), 3);
          await page.getByTestId('provider-retry-toggle').click();
        } else if (state === 'provider-failed') {
          assert.equal(await page.getByTestId('failure-summary').count(), 1);
          assert.equal(await page.getByTestId('provider-retry-notice').count(), 0);
          assert.equal(await page.getByTestId('failure-recovery-facts').count(), 0);
          assert.ok((await page.getByTestId('failure-retry-count').innerText()).includes('3'));
          await page.screenshot({ path: run.pathInArtifacts(`${name}-provider-failed.png`) });
          await page.getByTestId('failure-technical-details').click();
          assert.ok((await page.getByTestId('failure-recovery-facts').innerText()).includes('HTTP 503'));
          assert.equal(await page.getByTestId('message-continue-failure').isEnabled(), true);
          await page.getByTestId('message-continue-failure').click();
          await page.getByTestId('continued-failure-toggle').waitFor();
          assert.equal(await page.getByTestId('failure-summary').count(), 0);
          assert.equal(await page.getByTestId('failure-recovery-facts').count(), 0, 'continuing collapses previously expanded diagnostics');
        } else {
          assert.equal(await page.getByTestId('failure-summary').count(), 0);
          assert.equal(await page.getByTestId('failure-recovery-facts').count(), 0);
          await page.getByTestId('continued-failure-toggle').click();
          await page.getByTestId('failure-recovery-facts').waitFor();
          await page.getByTestId('continued-failure-toggle').click();
        }
        await page.screenshot({ path: run.pathInArtifacts(`${name}-${state === "provider-failed" ? "provider-failed-after-continue" : state}.png`) });
        cases.push({ ...variant, state, compactProviderFeedback: true, diagnosticsCollapsed: true });
      }
      await changeScenario('reply');
      await input.fill('保留这条断线前的草稿。');
      await input.blur();
      for (const phase of ['reconnecting', 'failed', 'reauthorization-required', 'unknown']) {
        await changeScenario(`connection-${phase}`);
        await page.getByTestId('task-connection-notice').waitFor();
        assert.equal(await page.getByTestId('task-connection-notice').count(), 1, 'one page-owned connection notice');
        assert.equal(await page.getByTestId('runtime-error-banner').count(), phase === 'unknown' ? 1 : 0, 'the transcript retains only an independent unknown-send result');
        assert.equal(await page.getByTestId('connection-recovering').count(), ['reconnecting', 'unknown'].includes(phase) ? 1 : 0);
        if (phase === 'reconnecting') {
          assert.equal(await page.getByTestId('task-connection-notice').getAttribute('role'), null, 'automatic recovery is not an assertive error');
          const textColor = await page.getByTestId('connection-notice-text').evaluate(node => getComputedStyle(node).color);
          assert.ok(!['rgb(255, 0, 0)', 'rgb(198, 79, 67)'].includes(textColor), 'automatic recovery uses neutral text');
        }
        await page.getByTestId('connection-notice-details').click();
        await page.getByTestId('connection-notice-technical-details').waitFor();
        await page.getByTestId('connection-notice-details').click();
        await page.getByTestId('connection-notice-technical-details').waitFor({ state: 'detached' });
        if (phase === 'reauthorization-required') assert.equal(await page.getByTestId('connection-reauthorize').isEnabled(), true);
        if (phase === 'unknown') assert.equal(await page.getByTestId('runtime-reconcile-send').isEnabled(), true);
        assert.equal(await input.inputValue(), '保留这条断线前的草稿。');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        const noticeBox = await page.getByTestId('task-connection-notice').boundingBox();
        const dockBox = await page.getByTestId('fixture-composer-dock').boundingBox();
        assert.ok(noticeBox.y + noticeBox.height <= dockBox.y, 'one connection notice stays above the composer');
        await page.screenshot({ path: run.pathInArtifacts(`${name}-connection-${phase}.png`) });
        if (phase === 'failed') {
          assert.equal(await page.getByTestId('connection-retry').innerText(), variant.language === 'en' ? 'Retry' : '重试');
          await page.getByTestId('connection-retry').click();
          await page.getByTestId('task-connection-notice').waitFor({ state: 'detached' });
          assert.equal(await input.inputValue(), '保留这条断线前的草稿。');
        }
        cases.push({ ...variant, state: `connection-${phase}`, singleConnectionNotice: true, draftPreserved: true });
      }
      await changeScenario('connection-restored');
      assert.equal(await page.getByTestId('task-connection-notice').count(), 0);
      assert.equal(await page.getByTestId('runtime-error-banner').count(), 0);
      await changeScenario('reply');
      const longDraft = '请检查这个项目的会话布局。保持草稿和光标。'.repeat(30);
      await input.fill(longDraft);
      await page.waitForFunction(() => document.querySelector('[data-testid="message-input"]').clientHeight === 105);
      const inputInstance = await input.elementHandle();
      await input.evaluate(node => node.setSelectionRange(24, 24));
      await page.screenshot({ path: run.pathInArtifacts(`${name}-long-draft-editing.png`) });
      await page.getByText('项目检查结果', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="message-input"]').clientHeight === 42);
      assert.equal(await input.inputValue(), longDraft);
      assert.equal(await input.evaluate((node, original) => node === original, inputInstance), true);
      assert.equal(await input.evaluate(node => node.selectionStart), 24, 'collapsing preserves the caret');
      await page.screenshot({ path: run.pathInArtifacts(`${name}-long-draft-preview.png`) });
      await input.focus();
      await page.waitForFunction(() => document.querySelector('[data-testid="message-input"]').clientHeight === 105);
      assert.equal(await input.evaluate(node => node.selectionStart), 24, 'focusing restores the same caret');
      await page.setViewportSize({ width: variant.width, height: 420 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.setViewportSize({ width: variant.width, height: 844 });
      await page.waitForFunction(() => document.querySelector('[data-testid="message-input"]').clientHeight === 42);
      assert.equal(await input.evaluate(node => document.activeElement === node), true, 'a viewport restore may leave the input focused');
      await input.click();
      await page.waitForFunction(() => document.querySelector('[data-testid="message-input"]').clientHeight === 105);
      assert.equal(await input.inputValue(), longDraft);
      assert.equal(await input.evaluate((node, original) => node === original, inputInstance), true);
      await changeScenario('jump-long-draft');
      await page.getByTestId('jump-to-latest').click();
      await page.getByTestId('jump-to-latest').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('[data-testid="message-input"]').clientHeight === 42);
      assert.equal(await input.inputValue(), longDraft);
      await changeScenario('send-failed');
      await input.focus();
      await page.waitForFunction(() => document.querySelector('[data-testid="message-input"]').clientHeight === 105);
      await page.getByTestId('dismiss-failed-submission').click();
      await page.getByTestId('submission-recovery-overlay').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('[data-testid="message-input"]').clientHeight === 42);
      assert.equal(await input.inputValue(), longDraft);
      cases.push({ ...variant, state: 'long-draft-preview', fullDraftAndCaretRetained: true, syntheticTouchViewportRestore: true, floatingActionsRemainClickable: true, collapsedLines: 2, maximumEditingLines: 5 });
      await changeScenario('reply');
      await input.fill('Keep this newer draft.');
      await input.blur();
      const viewport = page.getByTestId('fixture-transcript');
      const composer = page.getByTestId('message-input-root');
      const before = { composer: await composer.boundingBox(), transcript: await viewport.boundingBox() };
      const assertStable = async (state, baseline = before) => {
        const after = { composer: await composer.boundingBox(), transcript: await viewport.boundingBox() };
        for (const region of ['composer', 'transcript']) {
          for (const dimension of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(baseline[region][dimension] - after[region][dimension]) <= 1, `${name}/${state} ${region}.${dimension} stays stable`);
          }
        }
        assert.equal(await input.inputValue(), 'Keep this newer draft.');
        assert.equal(await page.evaluate(() => window.fixtureInputBefore === document.querySelector('[data-testid="message-input"]')), true, 'the input instance is retained');
        return after;
      };
      await page.evaluate(() => {
        window.fixtureInputBefore = document.querySelector('[data-testid="message-input"]');
        const transcript = document.querySelector('[data-testid="fixture-transcript"]');
        transcript.scrollTop = Math.min(100, transcript.scrollHeight - transcript.clientHeight);
      });
      const scrollBefore = await viewport.evaluate(node => node.scrollTop);
      for (const phase of ['preparing', 'retaining', 'sending']) {
        await page.evaluate(state => {
          const url = new URL(location.href);
          url.searchParams.set('state', state);
          history.replaceState(null, '', url);
          dispatchEvent(new PopStateEvent('popstate'));
        }, `send-${phase}`);
        await page.waitForFunction(state => document.querySelector('[data-testid="current-v3-fixture"]')?.dataset.scenario === state, `send-${phase}`);
        assert.equal(await page.getByTestId('failed-submissions').count(), 0, `${name}/${phase} has no recovery container or gap`);
        assert.equal(await input.inputValue(), 'Keep this newer draft.', 'phase changes preserve the newer draft');
        assert.equal(await page.evaluate(() => window.fixtureInputBefore === document.querySelector('[data-testid="message-input"]')), true, 'the input instance is retained');
        const after = { composer: await composer.boundingBox(), transcript: await viewport.boundingBox() };
        for (const region of ['composer', 'transcript']) {
          for (const dimension of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(before[region][dimension] - after[region][dimension]) <= 1, `${name}/${phase} ${region}.${dimension} stays stable`);
          }
        }
        assert.ok(Math.abs(scrollBefore - await viewport.evaluate(node => node.scrollTop)) <= 1, 'normal submission phases retain transcript scroll');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no page overflow');
        if (phase === 'preparing') await page.screenshot({ path: run.pathInArtifacts(`${name}-silent-preparing.png`) });
        cases.push({ ...variant, phase, before, after, normalRecoveryCardHidden: true, draftAndScrollPreserved: true });
      }
      for (const state of ['failed', 'unknown', 'accepted']) {
        await changeScenario(`send-${state}`);
        await page.getByTestId('failed-submission').waitFor();
        const action = page.getByTestId(state === 'failed' ? 'retry-failed-submission' : 'verify-failed-submission');
        assert.equal(await action.isEnabled(), true, `${name}/${state} recovery action remains available`);
        assert.equal(await page.getByTestId('dismiss-failed-submission').isEnabled(), true);
        const after = await assertStable(state);
        const overlay = page.getByTestId('submission-recovery-overlay');
        const box = await overlay.boundingBox(), header = await page.getByTestId('task-header').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= variant.width, 'floating recovery fits horizontally');
        assert.ok(box.y >= header.y + header.height && box.y + box.height <= after.composer.y, 'floating recovery stays between header and composer');
        assert.ok(Math.abs(scrollBefore - await viewport.evaluate(node => node.scrollTop)) <= 1, 'recovery appearance retains transcript scroll');
        await page.screenshot({ path: run.pathInArtifacts(`${name}-${state}.png`) });
        await page.getByTestId('dismiss-failed-submission').click();
        await page.getByTestId('submission-recovery-overlay').waitFor({ state: 'detached' });
        await assertStable(`${state}-dismissed`);
        assert.ok(Math.abs(scrollBefore - await viewport.evaluate(node => node.scrollTop)) <= 1, 'recovery dismissal retains transcript scroll');
        cases.push({ ...variant, state, before, after, recoveryActionAvailable: true, overlayOnly: true, dismissalStable: true });
      }
      for (const state of ['jump-latest', 'send-failed-jump']) {
        await changeScenario(state);
        await assertStable(state);
        const jump = page.getByTestId('jump-to-latest'), box = await jump.boundingBox();
        assert.equal(await jump.innerText(), '', 'latest uses only an arrow');
        assert.equal(box.width, 36); assert.equal(box.height, 36);
        assert.ok(Math.abs(box.x + box.width / 2 - variant.width / 2) <= 1, 'latest arrow is centered');
        assert.ok(box.y + box.height <= before.composer.y, 'latest arrow is above the composer');
        assert.equal(await jump.locator('svg').getAttribute('width'), '20');
        assert.ok(await jump.getAttribute('aria-label'), 'latest retains an accessible name');
        if (state === 'send-failed-jump') {
          const recovery = await page.getByTestId('submission-recovery-overlay').boundingBox();
          assert.ok(box.y + box.height <= recovery.y, 'arrow and recovery controls do not overlap');
        }
        await page.screenshot({ path: run.pathInArtifacts(`${name}-${state}.png`) });
        await jump.click();
        await jump.waitFor({ state: 'detached' });
        await assertStable(`${state}-follow`);
        cases.push({ ...variant, state, centeredArrowOnly: true, largerArrow: true, inputPreserved: true });
      }
      await changeScenario('reply');
      for (const action of ['like', 'dislike', 'copy', 'share']) {
        const button = page.getByTestId(`assistant-response-${action}`), icon = button.locator('svg');
        const box = await button.boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44, `${action} keeps its touch area`);
        assert.equal(await icon.getAttribute('width'), '14');
        const opacity = await icon.evaluate(node => {
          let value = 1;
          for (let parent = node; parent; parent = parent.parentElement) value *= Number(getComputedStyle(parent).opacity);
          return value;
        });
        assert.equal(opacity, 1, `${action} is opaque`);
        assert.equal(await button.isDisabled(), ['like', 'dislike'].includes(action));
      }
      await page.getByTestId('assistant-response-more').click();
      await page.getByTestId('assistant-response-menu').waitFor();
      await page.getByTestId('assistant-response-menu-close').click();
      cases.push({ ...variant, state: 'response-actions', smallerOpaqueIcons: true, ratingsDisabled: true, moreMenuAvailable: true });
      for (const height of [844, 420]) {
        await changeScenario('reply');
        await page.setViewportSize({ width: variant.width, height });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const baseline = { composer: await composer.boundingBox(), transcript: await viewport.boundingBox() };
        await changeScenario('send-failed-many');
        const after = await assertStable(`multiple-${height}`, baseline);
        const overlay = page.getByTestId('submission-recovery-overlay');
        const box = await overlay.boundingBox(), header = await page.getByTestId('task-header').boundingBox();
        assert.ok(box.height <= Math.max(80, Math.min(240, height * 0.3)) + 1, 'multiple recovery records have bounded height');
        assert.ok(box.y >= header.y + header.height && box.y + box.height <= after.composer.y, 'multiple recovery records fit the reduced viewport');
        const scroll = await overlay.evaluate(node => {
          const previous = node.scrollTop;
          node.scrollTop = node.scrollHeight;
          return { previous, current: node.scrollTop, overflow: node.scrollHeight - node.clientHeight };
        });
        assert.ok(scroll.overflow > 0 && scroll.current > scroll.previous, 'long recovery content scrolls inside the floating panel');
        assert.equal(await page.getByTestId('retry-failed-submission').last().isEnabled(), true);
        await page.screenshot({ path: run.pathInArtifacts(`${name}-multiple-${height}.png`) });
        cases.push({ ...variant, height, state: 'multiple-failures', overlayOnly: true, internalScrollAvailable: true });
      }
      await page.getByTestId('v3-conversation-menu').click();
      await page.getByTestId('v3-conversation-selection-header').waitFor();
      assert.equal(await page.getByTestId('v3-conversation-menu-sheet').count(), 0, 'left action opens selection directly');
      for (const id of ['home-search', 'interaction-inbox', 'home-settings']) await page.getByTestId(id).waitFor();
      cases.push({ ...variant, state: 'direct-selection', oneClickNavigation: true });
    } catch (error) {
      await page.screenshot({ path: run.pathInArtifacts(`${name}-failure.png`) });
      throw error;
    } finally { await page.close(); }
  }
  await run.writeArtifactJson('browser-results.json', { cases, diagnostics });
  assert.deepEqual(diagnostics, [], 'no browser exceptions or warnings');
  return { cases, diagnostics };
});
