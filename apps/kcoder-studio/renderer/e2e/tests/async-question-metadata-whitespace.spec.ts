import { expect, test } from '@playwright/test'

test('original question metadata and answer identity survive refresh (model-independent)', async ({ page }, testInfo) => {
  const header = '\uFEFF原始标题\uFEFF'
  const description = '\uFEFF原始选项说明\uFEFF'
  await page.goto(`/e2e/fixtures/async-question-browser.html?${new URLSearchParams({ header, optionDescription: description })}`)
  await page.getByTestId('async-question-toggle').click()
  expect(await page.getByText('原始标题', { exact: true }).textContent()).toBe(header)
  expect(await page.getByText('原始选项说明', { exact: true }).textContent()).toBe(description)
  await page.getByTestId('request-user-input-option-e2e-item-a-0').click()
  await page.getByTestId('chat-message-input').fill('保留原任务草稿')
  await page.screenshot({ path: testInfo.outputPath('original-metadata.png'), animations: 'disabled' })
  await page.getByTestId('request-user-input-submit-button').click()
  await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
  await page.getByTestId('async-question-refresh').click()
  await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
  const requests = await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ threadId: 'e2e-async-question-thread', questionId: 'e2e-question-a',
    answers: { 'e2e-item-a': { selectedOptionIds: ['e2e-option-a'] } } })
  await expect(page.getByTestId('chat-message-input')).toHaveText('保留原任务草稿')
})
