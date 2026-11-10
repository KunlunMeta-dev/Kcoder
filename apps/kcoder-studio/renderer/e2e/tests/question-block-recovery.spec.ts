import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`block recovery retains the original draft and pending send (${theme}, model-independent)`, async ({
    page,
  }, testInfo) => {
    await page.goto('/e2e/fixtures/question-block-recovery.html')
    await page.evaluate(value => {
      document.documentElement.classList.toggle('dark', value === 'dark')
    }, theme)
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
