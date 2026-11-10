import { expect, test, type Page } from '@playwright/test'

const targetId = 'e2e-async-question-target'
async function changeAccount(page: Page, id = targetId) {
  await page.evaluate(async target => {
    const path = '/src/kcoder/accountContextEvents.ts'
    const { notifyAccountContextChange } = await import(/* @vite-ignore */ path)
    notifyAccountContextChange(target)
  }, id)
}

for (const theme of ['light', 'dark']) {
  for (const change of ['account', 'target configuration']) {
    test(`${change} retires an unchanged task address's old answer draft (${theme}, model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width: 420, height: 900 })
      let profile = 'original'
      await page.route('**/api/servers', route => route.fulfill({ json: { servers: [{
        id: targetId, transport: 'local', runtime: 'kcoder', profile,
      }] } }))
      await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}`)
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
      await page.getByTestId('async-question-toggle').click()
      const answer = page.getByTestId('request-user-input-custom-e2e-item-a')
      await answer.fill('原账户的未提交答案')
      const composer = page.getByTestId('chat-message-input')
      await composer.fill('普通输入继续保留')
      const reads = await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())
      await changeAccount(page, 'unrelated-target')
      await expect(answer).toHaveValue('原账户的未提交答案')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(reads)
      const supports = await page.evaluate(() => window.__asyncQuestionBrowserFixture.capabilityCalls())
      if (change === 'account') await changeAccount(page)
      else {
        profile = 'replacement'
        await page.evaluate(target => window.dispatchEvent(new CustomEvent('kcoder:servers-changed', {
          detail: { targetId: target },
        })), targetId)
      }
      await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.capabilityCalls())).toBe(supports + 1)
      await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
      await page.getByTestId('async-question-toggle').click()
      await expect(answer).toHaveValue('')
      await expect(composer).toHaveText('普通输入继续保留')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
      await answer.fill('新账户的明确回答')
      await page.getByTestId('request-user-input-submit-button').click()
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)).toMatchObject([{
        threadId: 'e2e-async-question-thread', answers: { 'e2e-item-a': { text: '新账户的明确回答' } },
      }])
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      await page.screenshot({ path: testInfo.outputPath(`${change}-${theme}.png`), fullPage: true })
      expect(errors).toEqual([])
    })
  }

  test(`a delayed old-account failure preserves the replacement draft (${theme}, model-independent)`, async ({ page }, testInfo) => {
    await page.route('**/api/servers', route => route.fulfill({ json: { servers: [{
      id: targetId, transport: 'local', runtime: 'kcoder', profile: 'original',
    }] } }))
    await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&answerRace=1`)
    await page.getByTestId('async-question-toggle').click()
    await page.getByTestId('request-user-input-custom-e2e-item-a').fill('原账户的回答')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    const supports = await page.evaluate(() => window.__asyncQuestionBrowserFixture.capabilityCalls())
    await changeAccount(page)
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.capabilityCalls())).toBe(supports + 1)
    await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    await page.getByTestId('async-question-toggle').click()
    const answer = page.getByTestId('request-user-input-custom-e2e-item-a')
    await answer.fill('新账户的新草稿')
    const reads = await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())
    await page.evaluate(() => window.__asyncQuestionBrowserFixture.rejectHeldAnswer())
    await expect(answer).toHaveValue('新账户的新草稿')
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    await expect(page.getByTestId('async-question-submit-error')).toHaveCount(0)
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(reads)
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    await page.getByTestId('chat-message-input').fill('迟到错误不阻塞普通输入')
    await page.getByTestId('send-message-button').click()
    await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
    await page.screenshot({ path: testInfo.outputPath(`old-account-failure-${theme}.png`), fullPage: true })
  })
}
