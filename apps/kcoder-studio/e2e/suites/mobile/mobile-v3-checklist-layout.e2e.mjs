import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { buildCurrentFixture } from '../../mobile-design-atlas/current-fixture/build.mjs';
import { startRecoveryFixture } from '../../fixtures/mobile-send-recovery/server.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'mobile-v3-checklist-layout', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'Model-independent checklist presentation with real Mobile components and synthetic plans; no Gateway, model calls or native-device acceptance',
}, async run => {
  const before = process.argv.includes('--capture-before');
  const built = await buildCurrentFixture(run);
  const base = await startRecoveryFixture(run, built.output);
  const browser = await startChromium(run, { label: 'checklist-layout-browser', noSandbox: true });
  const errors = [], consoleMessages = [], cases = [];
  for (const variant of [
    { width: 390, language: 'zh-CN', theme: 'light' }, { width: 320, language: 'zh-CN', theme: 'dark' },
    { width: 390, language: 'en', theme: 'dark' }, { width: 320, language: 'en', theme: 'light' },
  ]) {
    const label = `${variant.width}-${variant.language}-${variant.theme}`;
    const page = await browser.newPage({ viewport: { width: variant.width, height: 844 }, hasTouch: true, isMobile: true });
    page.on('pageerror', error => errors.push({ label, message: error.message }));
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ label, type: message.type(), message: message.text() }); });
    await page.goto(`${base}?${new URLSearchParams({ state: 'plan', ...variant })}`, { waitUntil: 'load' });
    await page.getByTestId('current-v3-fixture').waitFor();
    await page.evaluate(async () => { await document.fonts.ready; });
    const screenshot = state => page.screenshot({ path: run.pathInArtifacts(`${label}-${state}.png`) });
    if (before) { await screenshot('before'); cases.push({ ...variant, captureOnly: true }); await page.close(); continue; }
    const byId = id => page.getByTestId(id);
    const transcript = byId('fixture-transcript'), input = byId('message-input'), composer = byId('message-input-root');
    const pinned = byId('task-plan-pinned'), sheet = byId('task-plan-sheet');
    const changeScenario = async state => {
      await page.evaluate(state => { const url = new URL(location.href); url.searchParams.set('state', state);
        history.replaceState(null, '', url); dispatchEvent(new PopStateEvent('popstate')); }, state);
      await page.waitForFunction(state => document.querySelector('[data-testid="current-v3-fixture"]')?.dataset.scenario === state, state);
    };
    const geometry = async () => ({ messages: await transcript.boundingBox(), input: await composer.boundingBox() });
    const close = (a, b, message) => assert.ok(Math.abs(a - b) <= 1, `${label}: ${message} (${a}, ${b})`);
    const openPlan = async () => { await byId('task-more').click(); await byId('task-menu-plan').click(); await sheet.waitFor();
      await byId('task-menu-plan').waitFor({ state: 'detached' }); };
    const closePlan = async () => { await byId('task-plan-sheet-close').click(); await sheet.waitFor({ state: 'detached' }); };
    const pin = async () => { await byId('task-plan-pin-toggle').click(); await sheet.waitFor({ state: 'detached' }); };
    try {
      const draft = 'Draft kept while viewing the checklist';
      await input.fill(draft); await input.blur();
      const initial = await geometry();
      assert.equal(await pinned.count(), 0, 'no default pinned footer');
      assert.equal(await byId('task-goal-controls').count(), 0, 'a plan does not create a Goal footer');
      assert.equal(await transcript.getByTestId('todo-card').count(), 1, 'the current plan stays with its message');
      await screenshot('default');
      await byId('task-more').click();
      assert.match(await byId('task-menu-plan').innerText(), /1\/3/);
      await screenshot('menu');
      await byId('task-menu-plan').click(); await sheet.waitFor();
      await byId('task-menu-plan').waitFor({ state: 'detached' });
      assert.equal(await byId('task-menu-plan').count(), 0, 'menu closes before details');
      const viewing = await geometry();
      close(viewing.messages.height, initial.messages.height, 'details do not resize transcript');
      close(viewing.input.y, initial.input.y, 'details do not move composer');
      await screenshot('details');
      await pin(); await pinned.waitFor();
      assert.equal(await sheet.count(), 0);
      const pinGeometry = await geometry(), pinBox = await pinned.boundingBox();
      assert.ok(pinBox.height <= 48, 'single compact row');
      assert.ok(initial.messages.height - pinGeometry.messages.height > 0 && initial.messages.height - pinGeometry.messages.height <= 56);
      close(pinGeometry.input.y, initial.input.y, 'pinning does not move composer');
      assert.ok(pinGeometry.messages.y + pinGeometry.messages.height <= pinBox.y + 1, 'summary does not cover messages');
      await screenshot('pinned');
      await input.fill(`${draft}!`); await input.blur();
      assert.equal(await pinned.count(), 1, 'typing retains explicit pin');
      const longDraft = `${draft}! `.repeat(16);
      await input.fill(longDraft);
      await byId('task-plan-summary').click(); await sheet.waitFor(); await closePlan();
      assert.equal(await pinned.count(), 1, 'focused long input does not prevent opening details');
      await input.focus();
      await byId('task-plan-unpin').click();
      assert.equal(await pinned.count(), 0);
      assert.equal(await input.inputValue(), longDraft, 'unpinning from a focused long draft retains all text');
      assert.equal(await input.evaluate(node => node === document.activeElement), true, 'unpinning preserves editing focus');
      await input.fill(`${draft}!`); await input.blur();
      close((await geometry()).messages.height, initial.messages.height, 'unpinning restores reading area');
      await openPlan(); await closePlan();
      assert.equal(await pinned.count(), 0, 'viewing details does not pin');
      await changeScenario('plan-scroll');
      await transcript.evaluate(node => { node.scrollTop = 320; });
      const readTop = await transcript.evaluate(node => node.scrollTop);
      assert.ok(readTop > 100);
      await openPlan(); await closePlan();
      close(await transcript.evaluate(node => node.scrollTop), readTop, 'reading position survives details');
      assert.equal(await pinned.count(), 0);
      await screenshot('reading');
      await changeScenario('plan-cancelled'); await openPlan();
      assert.match(await sheet.innerText(), /1\/4/);
      assert.ok((await sheet.innerText()).includes(variant.language === 'en' ? 'Cancelled' : '已取消'));
      await screenshot('cancelled'); await closePlan();
      await changeScenario('plan-many'); await openPlan();
      assert.ok((await sheet.boundingBox()).height <= 844 * 0.85 + 1, 'detail sheet bounded');
      assert.ok(await sheet.evaluate(node => { const area = [...node.querySelectorAll('div')].find(el => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight);
        if (!area) return false; area.scrollTop = 90; return area.scrollTop > 0; }), 'long details scroll inside sheet');
      await pin(); await changeScenario('plan-idle');
      assert.equal(await pinned.count(), 0, 'ending turn drops pin with unfinished tasks');
      await openPlan(); assert.equal(await byId('task-plan-pin-toggle').count(), 0); await closePlan();
      await changeScenario('plan'); assert.equal(await pinned.count(), 0, 'old pin does not revive');
      await openPlan(); await pin(); await changeScenario('plan-ended');
      assert.equal(await pinned.count(), 0, 'completed turn drops pin');
      await openPlan(); assert.match(await sheet.innerText(), /3\/3/);
      assert.equal(await byId('task-plan-pin-toggle').count(), 0);
      await screenshot('finished'); await closePlan();
      await changeScenario('plan-history');
      assert.equal(await transcript.getByTestId('todo-card').count(), 2, 'current and old plans stay with messages');
      const oldCard = transcript.getByTestId('todo-card').first();
      assert.match(await oldCard.innerText(), /1\/2/); await oldCard.getByRole('button').click();
      assert.ok((await oldCard.innerText()).includes(variant.language === 'en' ? 'Cancelled' : '已取消'));
      await changeScenario('plan-none'); await byId('task-more').click();
      assert.equal(await byId('task-menu-plan').count(), 0, 'no plan menu item without a plan');
      await byId('task-menu-close').click();
      assert.equal(await input.inputValue(), `${draft}!`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal overflow');
      cases.push({ ...variant, noDefaultFooter: true, menuDetails: true, optInCompactPin: true, pinClearedOnEnd: true,
        boundedSheetScroll: true, cancelledExcluded: true, messagePlansRetained: true, draftAndReadPositionRetained: true });
    } catch (error) { await screenshot('failure'); throw error; }
    finally { await page.close(); }
  }
  assert.deepEqual(errors, []); assert.deepEqual(consoleMessages, []);
  await run.writeArtifactJson('checklist-layout.json', { before, cases, errors, consoleMessages });
  return { before, cases: cases.length, errors, consoleMessages };
});
