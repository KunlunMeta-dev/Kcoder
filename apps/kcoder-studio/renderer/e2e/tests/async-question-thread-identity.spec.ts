import { expect, test } from '@playwright/test'

for (const [theme, threadId] of [['light', ' original-thread '], ['dark', '\uFEFF原任务\uFEFF']]) {
  test(`${theme}: opaque task identity preserves question drafts across recovery (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const query = new URLSearchParams({ theme, threadId, freeform: '1' })
    await page.goto(`/e2e/fixtures/async-question-browser.html?${query}`)
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('保留原问题回答')
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('保留原任务普通草稿')
    const before = await page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())
    await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitRecovery(true))
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())).toBeGreaterThan(before)
    await expect(draft).toHaveValue('保留原问题回答')
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    await expect(page.getByTestId('async-question-retry')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('recovered-original-question.png') })
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
    const requests = await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)
    expect(requests).toHaveLength(1)
    expect(requests[0].threadId).toBe(threadId)
    expect(requests[0].answers).toEqual({ 'e2e-item-a': { selectedOptionIds: [], text: '保留原问题回答' } })
    await expect(composer).toHaveText('保留原任务普通草稿')
    await expect(composer).toBeEditable()
    expect(errors).toEqual([])
  })
}
