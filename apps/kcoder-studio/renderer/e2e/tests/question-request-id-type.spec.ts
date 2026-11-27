import { expect, test } from '@playwright/test'

for (const answeredIndex of [0, 1]) {
  test(`a ${answeredIndex === 0 ? 'numeric' : 'string'} request settles only its original card (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/fixtures/question-request-id-type.html')
    const probe = page.getByTestId('typed-request-probe')
    const drafts = probe.getByTestId('request-user-input-custom-typed-choice')
    await expect(drafts).toHaveCount(2)
    const retained = drafts.nth(1 - answeredIndex)
    await retained.fill('Keep the other request draft')
    await probe.getByTestId('typed-composer').fill('Ordinary conversation continues')
    await probe.getByTestId('request-user-input-option-typed-choice-0').nth(answeredIndex).click()
    await expect(drafts).toHaveCount(1)
    await expect(drafts).toHaveValue('Keep the other request draft')
    const sent = JSON.parse(await probe.getByTestId('typed-sent').innerText())
    expect(sent).toHaveLength(1)
    expect(sent[0].requestId).toBe(answeredIndex === 0 ? 1 : '1')
    await expect(probe.getByTestId('typed-composer')).toBeEditable()
    await expect(probe.getByTestId('typed-composer')).toHaveValue('Ordinary conversation continues')
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('typed-original-question.png'), fullPage: true })
  })
}
