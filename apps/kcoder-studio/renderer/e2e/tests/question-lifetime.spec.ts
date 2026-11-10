import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  for (const binding of ['requestId', 'itemId', 'threadId', 'turnId', 'appServerEpoch']) {
    test(`question state belongs to its ${binding} (${theme}, model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/e2e/fixtures/question-lifetime.html?binding=${binding}`)
      const composer = page.getByRole('textbox', { name: '普通对话草稿' })
      await composer.fill('普通对话仍可继续')
      const draft = page.getByTestId('request-user-input-custom-choice')
      const submit = page.getByTestId('request-user-input-submit-button')
      await draft.fill('Original task only')
      await submit.click()
      await expect(submit).toBeDisabled()
      await page.getByTestId('replace-owner').click()
      await expect(draft).toHaveValue('')
      await expect(submit).toBeEnabled()
      await draft.fill('Replacement task only')
      await submit.click()
      await page.getByTestId('reject-old-answer').click()
      await expect(submit).toBeDisabled()
      const answers = JSON.parse(await page.getByTestId('answers').innerText())
      expect(answers).toHaveLength(2)
      expect(answers[1]).toMatchObject({ [binding]: 'replacement',
        answers: { choice: { answers: ['Replacement task only'] } } })
      await expect(composer).toBeEditable()
      await expect(composer).toHaveValue('普通对话仍可继续')
      expect(errors).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('replacement-question.png'), fullPage: true })
    })
  }
}
