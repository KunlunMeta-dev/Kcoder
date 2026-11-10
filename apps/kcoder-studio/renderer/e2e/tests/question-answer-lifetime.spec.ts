import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  for (const binding of ['threadId', 'turnId', 'appServerEpoch']) {
    test(`stale ${binding} answer preserves the current question (${theme}, model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/e2e/fixtures/question-answer-lifetime.html?binding=${binding}`)
      const composer = page.getByRole('textbox', { name: '普通对话草稿' })
      const draft = page.getByTestId('request-user-input-custom-choice')
      await composer.fill('普通对话继续编辑')
      await draft.fill('Keep the current answer')
      await page.getByTestId('read-stale-answer').click()
      await expect(draft).toHaveValue('Keep the current answer')
      await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
      await expect(composer).toBeEditable()
      await expect(composer).toHaveValue('普通对话继续编辑')
      await page.screenshot({ path: testInfo.outputPath('stale-answer-preserved.png'), fullPage: true })
      await page.getByTestId('read-current-answer').click()
      await expect(page.getByTestId('request-user-input-card')).toHaveCount(0)
      await expect(composer).toHaveValue('普通对话继续编辑')
      expect(errors).toEqual([])
    })
  }
}
