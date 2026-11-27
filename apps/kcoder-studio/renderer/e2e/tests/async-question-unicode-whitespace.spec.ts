import { expect, test } from '@playwright/test'

test('the original Unicode prompt survives answering and refresh (model-independent)', async ({ page }, testInfo) => {
  const prompt = '\uFEFF原题：请保留当前任务并检查结果。\uFEFF'
  await page.goto(`/e2e/fixtures/async-question-browser.html?freeform=1&prompt=${encodeURIComponent(prompt)}`)
  await page.getByTestId('async-question-toggle').click()
  const heading = page.getByText('原题：请保留当前任务并检查结果。', { exact: true })
  expect(await heading.textContent()).toBe(prompt)
  await page.getByTestId('request-user-input-custom-e2e-item-a').fill('先检查当前结果。')
  const composer = page.getByTestId('chat-message-input')
  await composer.fill('原任务草稿继续保留')
  await page.screenshot({ path: testInfo.outputPath('original-prompt.png'), animations: 'disabled' })
  await page.getByTestId('request-user-input-submit-button').click()
  await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
  await page.getByTestId('async-question-refresh').click()
  await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
  const requests = await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ threadId: 'e2e-async-question-thread', questionId: 'e2e-question-a',
    answers: { 'e2e-item-a': { selectedOptionIds: [], text: '先检查当前结果。' } } })
  await expect(composer).toHaveText('原任务草稿继续保留')
})

for (const width of [320, 390]) {
  test(`Unicode whitespace preserves the original async answer at ${width}px (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/e2e/fixtures/async-question-browser.html?freeform=1')
    await page.getByTestId('async-question-toggle').click()
    const input = page.getByTestId('request-user-input-custom-e2e-item-a')
    const submit = page.getByTestId('request-user-input-submit-button')
    await input.fill('\u0085')
    await expect(submit).toBeDisabled()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('原任务的普通输入仍可编辑')
    await expect(composer).toBeEditable()
    await input.fill(' \uFEFF ')
    await expect(submit).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('unicode-answer-ready.png'), animations: 'disabled' })
    await submit.click()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
    const requests = await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ threadId: 'e2e-async-question-thread', questionId: 'e2e-question-a',
      answers: { 'e2e-item-a': { selectedOptionIds: [], text: ' \uFEFF ' } } })
    await page.getByTestId('async-question-refresh').click()
    await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    await expect(composer).toHaveText('原任务的普通输入仍可编辑')
    expect(errors).toEqual([])
  })
}

for (const width of [320, 390]) {
  test(`Unicode option labels keep the original async choice at ${width}px (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/e2e/fixtures/async-question-browser.html?optionLabel=${encodeURIComponent('\uFEFF')}`)
    await page.getByTestId('async-question-toggle').click()
    const choice = page.getByTestId('request-user-input-option-e2e-item-a-0')
    await expect(choice).toContainText('继续前归纳当前事实')
    await choice.click()
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('普通输入仍可编辑')
    await page.screenshot({ path: testInfo.outputPath('unicode-option-selected.png'), animations: 'disabled' })
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
    const requests = await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ threadId: 'e2e-async-question-thread', questionId: 'e2e-question-a',
      answers: { 'e2e-item-a': { selectedOptionIds: ['e2e-option-a'] } } })
    await page.getByTestId('async-question-refresh').click()
    await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    await expect(composer).toHaveText('普通输入仍可编辑')
    expect(errors).toEqual([])
  })
}
