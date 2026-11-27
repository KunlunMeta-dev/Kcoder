import { expect, test } from '@playwright/test'

for (const multiSelect of [false, true]) {
  test(`clearing a replacement answer cannot restore a discarded single choice (multiSelect=${multiSelect}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/e2e/fixtures/async-question-browser.html?multiSelect=${multiSelect ? 1 : 0}`)
    await page.getByTestId('async-question-toggle').click()
    const option = page.getByTestId('request-user-input-option-e2e-item-a-1')
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    const submit = page.getByTestId('request-user-input-submit-button')
    await option.click()
    await draft.fill('改用其他方案')
    await draft.fill('')
    if (!multiSelect) await expect(submit).toBeDisabled()
    else await expect(submit).toBeEnabled()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
    await page.getByTestId('chat-message-input').fill('问题未回答时继续普通任务')
    await page.getByTestId('send-message-button').click()
    await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
    await page.screenshot({ path: testInfo.outputPath('cleared-replacement-answer.png'), animations: 'disabled' })
    if (!multiSelect) await option.click()
    await submit.click()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
    const requests = await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      threadId: 'e2e-async-question-thread', questionId: 'e2e-question-a', expectedRevision: 1,
      answers: { 'e2e-item-a': { selectedOptionIds: ['e2e-option-b'] } },
    })
    await page.getByTestId('async-question-refresh').click()
    await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    expect(errors).toEqual([])
  })
}

for (const theme of ['light', 'dark']) {
  for (const width of [320, 390, 1280]) {
    test(`freeform question keeps its prompt and original answer binding in ${theme} at ${width}px (model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width, height: 800 })
      await page.goto(`/e2e/fixtures/async-question-browser.html?freeform=1&theme=${theme}`)
      const composer = page.getByTestId('chat-message-input')
      await composer.fill('保留原任务普通对话草稿')
      await page.getByTestId('async-question-toggle').click()
      const card = page.getByTestId('async-question-card-e2e-question-a')
      await expect(card.getByText('处理方式', { exact: true })).toBeVisible()
      await expect(card.getByText('这项任务应如何继续？', { exact: true })).toBeVisible()
      await expect(card.getByTestId('request-user-input-submit-button')).toBeDisabled()
      const answer = '  先检查原任务历史  \n\n'
      const draft = card.getByTestId('request-user-input-custom-e2e-item-a')
      await draft.fill(answer)
      for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
        const accepted = await draft.evaluate((node, flags) => node.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...flags })
        ), ime)
        expect(accepted).toBe(true)
        await expect(card).toBeVisible()
        await expect(draft).toBeFocused()
        await draft.dispatchEvent('keydown', { key: 'Enter', ...ime })
        expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
      }
      await draft.press('Escape')
      await expect(page.getByTestId('async-question-content')).toBeHidden()
      await expect(page.getByTestId('async-question-toggle')).toBeFocused()
      await page.getByTestId('async-question-toggle').click()
      await expect(draft).toHaveValue(answer)
      await page.screenshot({ path: testInfo.outputPath('freeform-prompt.png'), animations: 'disabled' })
      await card.getByTestId('request-user-input-submit-button').click()
      await expect(card).toHaveAttribute('data-status', 'answer_saved')
      await expect(page.getByTestId('async-question-authoritative-answer-e2e-question-a'))
        .toContainText('先检查原任务历史')
      expect(await page.getByTestId('async-question-authoritative-answer-e2e-question-a').textContent())
        .toContain(answer)
      const requests = await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        threadId: 'e2e-async-question-thread', questionId: 'e2e-question-a', expectedRevision: 1,
        answers: { 'e2e-item-a': { selectedOptionIds: [], text: answer } },
      })
      await page.getByTestId('async-question-refresh').click()
      await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
      await expect(card).toHaveAttribute('data-status', 'answer_saved')
      expect(await page.getByTestId('async-question-authoritative-answer-e2e-question-a').textContent())
        .toContain(answer)
      await expect(composer).toHaveText('保留原任务普通对话草稿')
      await expect(composer).toBeEditable()
      await page.screenshot({ path: testInfo.outputPath('saved-answer.png'), animations: 'disabled' })
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
      expect(errors).toEqual([])
    })
  }
}

for (const lock of ['recovery', 'submission']) {
  test(`IME Escape preserves a locked async panel during ${lock} (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/e2e/fixtures/async-question-browser.html?freeform=1${lock === 'submission' ? '&answerRace=1' : ''}`)
    const toggle = page.getByTestId('async-question-toggle')
    await toggle.click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('保留原问题的输入法草稿')
    if (lock === 'submission') await page.getByTestId('request-user-input-submit-button').click()
    else await page.evaluate(async () => {
      window.__asyncQuestionBrowserFixture.holdNextList()
      await window.__asyncQuestionBrowserFixture.emitRecovery(true)
    })
    try {
      await expect(page.getByTestId('request-user-input-submit-button')).toBeDisabled()
      for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
        // Deliver the key queued before recovery or submission disabled the input.
        const accepted = await draft.evaluate((node, flags) => node.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...flags })
        ), ime)
        expect(accepted).toBe(true)
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
        await expect(draft).toBeVisible()
        await expect(draft).toHaveValue('保留原问题的输入法草稿')
      }
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length))
        .toBe(lock === 'submission' ? 1 : 0)
      const composer = page.getByTestId('chat-message-input')
      await composer.fill('等待期间继续普通对话')
      await expect(composer).toBeEditable()
      await page.screenshot({ path: testInfo.outputPath('locked-ime-card.png'), animations: 'disabled' })
    } finally {
      await page.evaluate(kind => {
        if (kind === 'submission') window.__asyncQuestionBrowserFixture.rejectHeldAnswer()
        else window.__asyncQuestionBrowserFixture.releaseHeldList()
      }, lock)
    }
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    expect(errors).toEqual([])
  })
}
