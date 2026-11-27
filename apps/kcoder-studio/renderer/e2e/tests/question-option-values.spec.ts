import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
  test(`original question retains distinct option values at ${width}px (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/e2e/fixtures/question-send-failure.html?optionValues=1')
    await page.getByTestId('accept-next-send').click()
    await page.getByTestId('request-user-input-option-choice-0').click()
    await page.getByTestId('request-user-input-option-choice-1').click()
    await expect(page.getByTestId('request-user-input-option-choice-0')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('request-user-input-option-choice-1')).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: testInfo.outputPath('selected-original-values.png') })
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('send-attempts')).toHaveText('1')
    const response = JSON.parse(await page.getByTestId('submitted-response').textContent() ?? '{}')
    expect(response.answers).toEqual({ choice: { answers: ['first', ' second '] } })
    await expect(page.getByTestId('question-confirmed')).toBeVisible()
    expect(errors).toEqual([])
  })
}
