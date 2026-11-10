import { expect, test } from '@playwright/test'

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
