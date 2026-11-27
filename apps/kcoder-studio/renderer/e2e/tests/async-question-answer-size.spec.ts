import { expect, test } from '@playwright/test'

for (const [name, draft] of [['Unicode', '中文'.repeat(3000)], ['surrounding whitespace', ' '.repeat(16 * 1024) + '原文']]) {
  test(`an oversized ${name} async answer keeps its draft and accepts a shorter answer in the same task (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 420, height: 900 })
    await page.goto('/e2e/fixtures/async-question-browser.html?freeform')
    await page.getByTestId('async-question-toggle').click()
    const input = page.getByTestId('request-user-input-custom-e2e-item-a')
    await input.fill(draft)
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('async-question-answer-too-long')).toBeVisible()
    await expect(input).toHaveValue(draft)
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')

    // The question remains non-blocking while the user edits its oversized draft.
    await page.getByTestId('chat-message-input').fill('继续原任务')
    await page.getByTestId('send-message-button').click()
    await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
    await page.screenshot({ path: testInfo.outputPath('oversized-answer-keeps-draft.png'), animations: 'disabled' })
    await input.fill('缩短后的回答')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
    await expect(page.getByTestId('async-question-answer-too-long')).toHaveCount(0)
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    expect(errors).toEqual([])
  })
}
