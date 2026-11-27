import { expect, test } from '@playwright/test'

for (const binding of ['threadId', 'turnId', 'appServerEpoch']) {
  test(`a settled question cannot hide a reused ${binding} card (model-independent)`, async ({ page }) => {
    await page.goto(`/e2e/fixtures/question-lifetime.html?binding=${binding}&settle`)
    const composer = page.getByRole('textbox', { name: '普通对话草稿' })
    await composer.fill('Keep composing')
    await page.getByTestId('request-user-input-custom-choice').fill('Original answer')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('request-user-input-card')).toHaveCount(0)
    await page.getByTestId('replace-owner').click()
    await expect(page.getByTestId('request-user-input-custom-choice')).toHaveValue('')
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    await expect(composer).toHaveValue('Keep composing')
    await page.getByTestId('request-user-input-custom-choice').fill('New answer')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('request-user-input-card')).toHaveCount(0)
    expect(JSON.parse(await page.getByTestId('answers').innerText())).toHaveLength(2)
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const binding of ['requestId', 'itemId', 'threadId', 'turnId', 'appServerEpoch',
    'sourceAgent.backgroundRun.parentSessionId', 'sourceAgent.backgroundRun.agentId']) {
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
      expect(answers[1]).toHaveProperty(binding, 'replacement')
      expect(answers[1]).toMatchObject({
        answers: { choice: { answers: ['Replacement task only'] } } })
      await expect(composer).toBeEditable()
      await expect(composer).toHaveValue('普通对话仍可继续')
      expect(errors).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('replacement-question.png'), fullPage: true })
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const binding of ['threadId', 'turnId', 'appServerEpoch'] as const) {
    test(`an ended ${binding} cannot discard a restored answer draft (${theme}, model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/e2e/fixtures/question-lifetime.html?binding=${binding}&restoreAlias`)
      const composer = page.getByRole('textbox', { name: '普通对话草稿' })
      const draft = page.getByTestId('request-user-input-custom-choice')
      await composer.fill('普通对话继续编辑')
      await draft.fill('Keep the current task answer')
      await page.getByTestId('replace-owner').click()
      await expect(draft).toHaveValue('Keep the current task answer')
      await expect(page.getByTestId('answers')).toHaveText('[]')
      await expect(composer).toBeEditable()
      await expect(composer).toHaveValue('普通对话继续编辑')
      await page.screenshot({ path: testInfo.outputPath('restored-answer-draft.png'), fullPage: true })
      await page.getByTestId('request-user-input-submit-button').click()
      const answers = JSON.parse(await page.getByTestId('answers').innerText())
      expect(answers).toEqual([expect.objectContaining({
        requestId: 7, itemId: 'question',
        threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch',
        answers: { choice: { answers: ['Keep the current task answer'] } },
      })])
      expect(errors).toEqual([])
    })
  }
}
