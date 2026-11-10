import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { exportMobileWeb } from '../../harness/mobile-web-export.mjs';
import { buildCurrentFixture } from '../../mobile-design-atlas/current-fixture/build.mjs';
import { startRecoveryFixture } from '../../fixtures/mobile-send-recovery/server.mjs';

process.umask(0o077);
await runE2E(import.meta.url, { testId: 'mobile-v3-goal-summary', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'Model-independent V3 Goal summary and local disclosure/editor presentation; real Mobile components, frozen mutation callbacks, no backend, personal session, model or native-device claim',
}, async run => {
  if (process.argv.includes('--build-only')) {
    await exportMobileWeb(run, { label: 'v3-goal-platform-build' });
    return { platformBuildOnly: true, browserCases: false };
  }
  const built = await buildCurrentFixture(run);
  const base = await startRecoveryFixture(run, built.output);
  const browser = await startChromium(run, { label: 'v3-goal-browser', noSandbox: true });
  const diagnostics = [], cases = [];
  for (const variant of [
    { width: 390, language: 'zh-CN', theme: 'light' },
    { width: 320, language: 'zh-CN', theme: 'dark' },
    { width: 390, language: 'en', theme: 'dark' },
    { width: 320, language: 'en', theme: 'light' },
  ]) {
    const name = `${variant.width}-${variant.language}-${variant.theme}`;
    const page = await browser.newPage({ viewport: { width: variant.width, height: 844 } });
    page.on('pageerror', error => diagnostics.push({ name, type: 'exception', text: error.message }));
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) diagnostics.push({ name, type: message.type(), text: message.text() }); });
    const enter = async state => {
      await page.goto(`${base}?${new URLSearchParams({ state, ...variant })}`, { waitUntil: 'load' });
      await page.getByTestId('task-goal-status').waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}/${state} page overflow`);
    };
    try {
      await enter('goal-active');
      const card = page.getByTestId('task-goal-controls');
      const box = await card.boundingBox(), inputBox = await page.getByTestId('message-input').boundingBox();
      assert.ok(box.x >= 11 && box.x <= 13, 'the Goal card owns one 12px outer gutter');
      assert.ok(box.y + box.height <= inputBox.y, 'Goal summary stays above the composer');
      for (const action of ['edit', 'pause', 'clear', 'expand']) {
        const target = await page.getByTestId(`task-goal-${action}`).boundingBox();
        assert.ok(target.width >= 44 && target.height >= 44, `${name} ${action} touch target`);
        assert.ok(target.x >= box.x && target.x + target.width <= box.x + box.width, `${name} ${action} fits the card`);
      }
      assert.match(await page.getByTestId('task-goal-usage').innerText(), /2400 \/ 12000 tokens · 96s/);
      assert.equal(await page.getByTestId('task-goal-objective').count(), 0, 'objective is disclosed on request');
      assert.equal(await page.getByTestId('task-goal-queue').count(), 0, 'no invented Goal task queue');
      await page.screenshot({ path: run.pathInArtifacts(`${name}-summary.png`) });
      await page.getByTestId('task-goal-expand').click();
      await page.getByTestId('task-goal-objective').waitFor();
      await page.screenshot({ path: run.pathInArtifacts(`${name}-details.png`) });
      await page.getByTestId('task-goal-expand').click();
      await page.getByTestId('task-goal-edit').click();
      await page.getByTestId('task-goal-edit-input').fill('Edited locally in the isolated fixture');
      await page.screenshot({ path: run.pathInArtifacts(`${name}-editor.png`) });
      await page.getByTestId('task-goal-edit-close').click();
      assert.equal(await page.getByTestId('task-goal-edit-input').count(), 0);
      for (const state of ['paused', 'blocked', 'complete', 'budgetLimited', 'usageLimited', 'cancelled', 'pro', 'offline', 'unknown']) {
        await enter(`goal-${state}`);
        const resume = ['paused', 'blocked'].includes(state), terminal = ['complete', 'budgetLimited', 'usageLimited', 'cancelled'].includes(state);
        assert.equal(await page.getByTestId('task-goal-resume').count(), Number(resume));
        assert.equal(await page.getByTestId('task-goal-edit').count(), Number(!terminal));
        if (state === 'offline' || state === 'unknown') {
          for (const action of ['edit', 'pause', 'clear']) assert.equal(await page.getByTestId(`task-goal-${action}`).isDisabled(), true);
          await page.getByTestId('task-goal-expand').click();
          await page.getByTestId('task-goal-objective').waitFor();
        }
        if (state === 'blocked') {
          await page.getByTestId('task-goal-expand').click();
          await page.getByText('需要用户确认目标目录后才能继续。', { exact: true }).waitFor();
        }
        if (['paused', 'complete', 'offline'].includes(state)) await page.screenshot({ path: run.pathInArtifacts(`${name}-${state}.png`) });
      }
      cases.push({ ...variant, goalModesAndStates: true, editorAndDetails: true, goalQueueOmitted: true });
    } catch (error) {
      await page.screenshot({ path: run.pathInArtifacts(`${name}-failure.png`) });
      throw error;
    } finally { await page.close(); }
  }
  await run.writeArtifactJson('console.json', diagnostics);
  assert.deepEqual(diagnostics, []);
  return { cases, diagnostics };
});
