import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`restored value-only choices preserve the original answer (${theme}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/fixtures/question-block-recovery.html?valueOnly=1')
    await page.evaluate(value => {
      document.documentElement.dataset.theme = value
      document.documentElement.classList.toggle('dark', value === 'dark')
    }, theme)
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme)
    await page.getByTestId('ordinary-composer').fill('普通对话仍可编辑')
    const original = page.getByTestId('request-user-input-option-choice-0')
    await expect(original).toContainText('保留原文件')
    await expect(page.getByTestId('request-user-input-option-choice-1')).toContainText('Other file')
    await page.getByTestId('rebuild-blocks').click()
    await original.click()
    await expect(page.getByTestId('send-attempts')).toHaveText('1')
    const response = JSON.parse(await page.getByTestId('submitted-response').innerText())
    expect(response).toMatchObject({ requestId: 41, itemId: 'original-question',
      threadId: 'original-thread', turnId: 'original-turn', appServerEpoch: 'original-epoch',
      answers: { choice: { answers: [' 保留原文件 \n'] } } })
    await page.getByTestId('rebuild-blocks').click()
    await expect(page.getByTestId('send-attempts')).toHaveText('1')
    await expect(page.getByTestId('ordinary-composer')).toBeEditable()
    await expect(page.getByTestId('ordinary-composer')).toHaveValue('普通对话仍可编辑')
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('restored-value-only-question.png'), fullPage: true })
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`block recovery retains the original draft and pending send (${theme}, model-independent)`, async ({
    page,
  }, testInfo) => {
    await page.goto('/e2e/fixtures/question-block-recovery.html')
    await page.evaluate(value => {
      document.documentElement.dataset.theme = value
      document.documentElement.classList.toggle('dark', value === 'dark')
    }, theme)
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme)
    const draft = page.getByTestId('request-user-input-custom-choice')
    await draft.fill('只回答原任务一次')
    await page.getByTestId('rebuild-blocks').click()
    await expect(draft).toHaveValue('只回答原任务一次')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('send-attempts')).toHaveText('1')
    await page.getByTestId('rebuild-blocks').click()
    await expect(page.getByTestId('request-user-input-submit-button')).toBeDisabled()
    await expect(draft).toHaveValue('只回答原任务一次')
    await page.getByTestId('ordinary-composer').fill('普通对话仍可编辑')
    await expect(page.getByTestId('ordinary-composer')).toHaveValue('普通对话仍可编辑')
    await expect(page.getByTestId('send-attempts')).toHaveText('1')
    await page.getByTestId('reject-send').click()
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    await expect(draft).toHaveValue('只回答原任务一次')
    await expect(page.getByTestId('submitted-response')).toContainText(
      '"itemId":"original-question"'
    )
    await page.screenshot({
      path: testInfo.outputPath('original-question-recovered.png'),
      fullPage: true,
    })
  })
}
