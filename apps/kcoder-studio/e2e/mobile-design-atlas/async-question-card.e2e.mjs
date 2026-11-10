import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { runE2E } from '../harness/run-context.mjs';
import { startChromium } from '../harness/chromium.mjs';
import { buildCurrentFixture } from './current-fixture/build.mjs';
import { startRecoveryFixture } from '../fixtures/mobile-send-recovery/server.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'mobile-async-question-card-browser-fixture',
  tier: 'manual-live',
  retainSuccessLogs: true,
  modelPolicy: 'Actual Mobile AsyncQuestionCard rendered in an isolated React Native Web fixture; synthetic local answer receipt; no Gateway, model, external mutation or native-device acceptance',
}, async run => {
  const built = await buildCurrentFixture(run);
  const base = await startRecoveryFixture(run, built.output);
  const browser = await startChromium(run, { label: 'async-question-card-browser-fixture', noSandbox: true });
  await mkdir(run.pathInArtifacts('async-question-card'), { recursive: true });
  const cases = [], diagnostics = [], external = [];
  const variants = [
    ...['en', 'zh-CN'].flatMap(language => ['light', 'dark'].map(theme => ({ width: 320, height: 568, language, theme }))),
    ...['en', 'zh-CN'].flatMap(language => ['light', 'dark'].map(theme => ({ width: 390, height: 844, language, theme }))),
  ];
  for (const variant of variants) {
    const label = `${variant.width}-${variant.language}-${variant.theme}`;
    const page = await browser.newPage({ viewport: { width: variant.width, height: variant.height }, isMobile: true, hasTouch: true });
    page.on('pageerror', error => diagnostics.push({ label, type: 'exception', text: error.message }));
    page.on('console', message => {
      if (['warning', 'error'].includes(message.type())) diagnostics.push({ label, type: message.type(), text: message.text() });
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (/^https?:$/.test(url.protocol) && url.origin !== new URL(base).origin) external.push({ label, origin: url.origin, path: url.pathname });
    });
    const ui = id => page.getByTestId(id);
    const capture = async state => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}/${state}: horizontal overflow`);
      await page.screenshot({ path: run.pathInArtifacts(`async-question-card/${label}-${state}.png`) });
    };
    try {
      await page.goto(`${base}?${new URLSearchParams({ state: 'async-question', ...variant })}`, { waitUntil: 'load' });
      await ui('async-question-card-fixture-async-question-1').waitFor();
      await page.evaluate(async () => { await document.fonts.ready; });
      assert.equal(await ui('async-question-fixture-context').innerText(), '有一个可稍后回答的问题。');
      assert.equal(await ui('async-question-title').innerText(), variant.language === 'en' ? 'KCoder has a question' : 'KCoder 有个问题');
      assert.match(await ui('async-question-answer-later-hint').innerText(), variant.language === 'en' ? /answer later/ : /可以稍后回答/);
      assert.equal(await ui('async-question-status').innerText(), variant.language === 'en' ? 'Waiting for your answer' : '等待你的回答');
      const option = ui('async-question-fixture-async-question-1-option-delivery-mode-review');
      const options = page.locator('[data-testid^="async-question-fixture-async-question-1-option-"]');
      assert.equal(await options.count(), 2, `${label}: both choices should be rendered`);
      for (const choice of await options.all()) assert.equal(await choice.getAttribute('aria-checked'), 'false', `${label}: no answer may be preselected`);
      await capture('pending');
      cases.push({ ...variant, pendingScreenshot: `async-question-card/${label}-pending.png`, noPreselection: true });

      if (variant.width === 390 && variant.language === 'zh-CN' && variant.theme === 'light') {
        await option.click();
        assert.equal(await option.getAttribute('aria-checked'), 'true');
        await ui('async-question-submit-fixture-async-question-1').click();
        await ui('async-question-authoritative-answer').waitFor();
        assert.equal(await ui('async-question-status').innerText(), '回答已保存，等待投递');
        assert.match(await ui('async-question-authoritative-answer').innerText(), /先创建草稿供我审阅/);
        assert.equal(await ui('async-question-submit-fixture-async-question-1').count(), 0);
        await capture('answer-saved');
        cases[cases.length - 1].answerScreenshot = `async-question-card/${label}-answer-saved.png`;
        cases[cases.length - 1].answerReceipt = 'synthetic local fixture callback';
      }
      await page.goto(`${base}?${new URLSearchParams({ state: 'async-question-lost-receipt', ...variant })}`, { waitUntil: 'load' });
      await ui('async-question-card-fixture-async-question-1').waitFor();
      await ui('message-input').fill('保留普通消息草稿');
      await ui('async-question-fixture-async-question-1-option-delivery-mode-review').click();
      await ui('async-question-submit-fixture-async-question-1').click();
      await ui('async-question-authoritative-answer').waitFor();
      assert.equal(await ui('async-question-status').innerText(), variant.language === 'en'
        ? 'Answer saved, waiting for delivery' : '回答已保存，等待投递');
      await capture('lost-receipt');
      assert.equal(await ui('async-question-response-error').count(), 0,
        `${label}: the newer saved answer must supersede the lost transport receipt`);
      assert.equal(await ui('message-input').inputValue(), '保留普通消息草稿');
      assert.match(await ui('async-question-authoritative-answer').innerText(), /先创建草稿供我审阅/);
      cases[cases.length - 1].lostReceiptScreenshot = `async-question-card/${label}-lost-receipt.png`;
      cases[cases.length - 1].draftPreserved = true;
      for (const questionItemId of ['__proto__', 'constructor', 'toString']) {
        await page.goto(`${base}?${new URLSearchParams({ state: 'async-question-answer-keys', questionItemId, ...variant })}`, { waitUntil: 'load' });
        const card = ui('async-question-card-fixture-async-question-1');
        await card.waitFor();
        const submit = ui('async-question-submit-fixture-async-question-1');
        assert.equal(await submit.isDisabled(), true, `${label}/${questionItemId}: inherited fields are not answers`);
        const choice = ui(`async-question-fixture-async-question-1-option-${questionItemId}-review`);
        assert.equal(await choice.getAttribute('aria-checked'), 'false');
        await choice.click();
        const freeformText = '  补充说明  ';
        await card.locator('input').fill(freeformText);
        await submit.click();
        const summary = ui('async-question-authoritative-answer');
        await summary.waitFor();
        assert.match(await summary.innerText(), /先创建草稿供我审阅/);
        assert.ok((await summary.textContent()).includes(freeformText), `${label}/${questionItemId}: saved free text must retain every whitespace byte`);
        await capture(`answer-key-${questionItemId}`);
      }
      cases[cases.length - 1].reservedAnswerKeys = ['__proto__', 'constructor', 'toString'];
      await page.goto(`${base}?${new URLSearchParams({ state: 'async-question-owner-switch', ...variant })}`, { waitUntil: 'load' });
      const card = ui('async-question-card-fixture-async-question-1');
      await card.waitFor();
      const answer = ui('async-question-submit-fixture-async-question-1');
      const choice = ui('async-question-fixture-async-question-1-option-delivery-mode-review');
      await choice.click();
      await card.locator('input').fill('原任务草稿');
      await answer.click();
      assert.equal(await answer.isDisabled(), true, `${label}: original receipt stays pending`);
      await ui('async-question-switch-owner').click();
      assert.equal(await card.locator('input').inputValue(), '', `${label}: replacement task has no original draft`);
      assert.equal(await choice.getAttribute('aria-checked'), 'false');
      await choice.click();
      await card.locator('input').fill('新任务草稿');
      assert.equal(await answer.isEnabled(), true, `${label}: original request cannot block the replacement task`);
      await answer.click();
      await ui('async-question-response-error').waitFor();
      await ui('async-question-finish-original').click();
      assert.equal(await card.locator('input').inputValue(), '新任务草稿', `${label}: late receipt cannot clear the replacement draft`);
      assert.equal(await choice.getAttribute('aria-checked'), 'true');
      assert.match(await ui('async-question-response-error').innerText(), /Synthetic current task receipt unknown/);
      assert.equal(await answer.isEnabled(), true);
      await capture('owner-switch');
      cases[cases.length - 1].ownerSwitch = 'same question ID; pending old receipt cannot block, clear or settle replacement task';
      await page.goto(`${base}?${new URLSearchParams({ state: 'async-question-connection', ...variant })}`, { waitUntil: 'load' });
      await card.waitFor();
      await choice.click();
      await card.locator('input').fill('断线时保留回答草稿');
      await ui('message-input').fill('普通消息草稿');
      await ui('async-question-toggle-connection').click();
      assert.equal(await answer.isDisabled(), true);
      assert.equal(await ui('async-question-cancel-fixture-async-question-1').isDisabled(), true);
      assert.equal(await card.locator('input').isEditable(), false);
      assert.equal(await choice.getAttribute('aria-disabled'), 'true');
      assert.equal(await ui('async-question-response-error').count(), 0);
      await capture('disconnected');
      await ui('async-question-toggle-connection').click();
      assert.equal(await answer.isDisabled(), true, `${label}: connection recovery alone cannot confirm retained questions`);
      assert.equal(await ui('async-question-cancel-fixture-async-question-1').isDisabled(), true);
      assert.equal(await card.locator('input').isEditable(), false);
      assert.equal(await ui('message-input').isEditable(), true, `${label}: question readback cannot block the composer`);
      assert.equal(await card.locator('input').inputValue(), '断线时保留回答草稿');
      await capture('readback-pending');
      await ui('async-question-confirm-readback').click();
      assert.equal(await answer.isEnabled(), true);
      assert.equal(await card.locator('input').inputValue(), '断线时保留回答草稿');
      assert.equal(await choice.getAttribute('aria-checked'), 'true');
      assert.equal(await ui('message-input').inputValue(), '普通消息草稿');
      await answer.click();
      await ui('async-question-authoritative-answer').waitFor();
      assert.match(await ui('async-question-authoritative-answer').innerText(), /断线时保留回答草稿/);
      await capture('reconnected-answer');
      cases[cases.length - 1].connectionRecovery = 'disabled during disconnection and replacement readback; draft retained; explicit answer after confirmed snapshot';

      if (variant.width === 390 && variant.language === 'zh-CN' && variant.theme === 'light') {
        for (const receipt of ['success', 'failure']) {
          await page.goto(`${base}?${new URLSearchParams({ state: 'async-question-reconnect', receipt, ...variant })}`, { waitUntil: 'load' });
          await card.waitFor();
          await choice.click();
          await answer.click();
          assert.equal(await answer.isDisabled(), true);
          await ui('async-question-toggle-connection').click();
          await ui('async-question-toggle-connection').click();
          await card.locator('input').fill('恢复后的新草稿');
          assert.equal(await answer.isEnabled(), true, 'old submission must not block the recovered card');
          await answer.click();
          await ui('async-question-response-error').waitFor();
          await ui('async-question-finish-original').click();
          assert.equal(await card.locator('input').inputValue(), '恢复后的新草稿');
          assert.equal(await choice.getAttribute('aria-checked'), 'true');
          assert.match(await ui('async-question-response-error').innerText(), /Synthetic current task receipt unknown/);
          assert.equal(await answer.isEnabled(), true);
          await capture(`reconnect-late-${receipt}`);
        }
        cases[cases.length - 1].pendingConnectionRecovery = ['late success', 'late failure'];
      }

    } catch (error) {
      await capture('failure').catch(() => {});
      throw error;
    } finally {
      await page.close();
    }
  }
  await run.writeArtifactJson('async-question-card-browser-results.json', { cases, diagnostics, externalRequests: external });
  assert.deepEqual(external, [], 'fixture must not contact external origins');
  assert.deepEqual(diagnostics, [], 'browser warnings/errors');
  assert.equal(cases.length, 8);
  return { cases: cases.length, diagnostics: diagnostics.length, externalRequests: external.length, interaction: 'selected option and rendered accepted synthetic answer' };
});
