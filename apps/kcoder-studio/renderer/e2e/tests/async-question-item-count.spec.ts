import { expect, test } from '@playwright/test'

for (const count of [0, 9]) {
  test(`initial question with ${count} items exposes recovery (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/fixtures/async-question-browser.html?freeform&answerRace')
    await expect(page.getByTestId('async-question-toggle')).toBeVisible()
    await page.evaluate(async count => {
      const transportPath = '/src/lib/runtime-transport.ts'
      const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
      const transport = runtimeTransport()
      const original = transport.handler
      window.__restoreItemCountProbe = () => { transport.handler = original }
      transport.handler = async (command: string, raw: unknown) => {
        const result = await original(command, raw)
        const args = raw as { method: string; params: { method: string } }
        if (command !== 'local_executor_request' || args.method !== 'runtime.asyncQuestion.request' ||
            args.params.method !== 'asyncQuestion/list') return result
        return { ...result, questions: result.questions.map(question => ({ ...question,
          questions: Array.from({ length: count }, (_, index) => ({ ...question.questions[0], id: `item-${index}` })),
        })) }
      }
    }, count)
    try {
      // The second task has no prior question projection: this is its first read.
      await page.getByTestId('fixture-task-b').click()
      await page.getByTestId('async-question-toggle').click()
      await expect(page.getByTestId('async-question-retry')).toBeVisible()
      await expect(page.getByTestId('request-user-input-submit-button')).toHaveCount(0)
      await page.getByTestId('chat-message-input').fill('继续普通任务输入')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
      await page.screenshot({ path: testInfo.outputPath('invalid-item-count-recovery.png'), animations: 'disabled' })
    } finally {
      await page.evaluate(() => window.__restoreItemCountProbe())
    }
    await page.getByTestId('async-question-retry').click()
    await expect(page.getByTestId('request-user-input-custom-e2e-item-a')).toBeEnabled()
    expect(errors).toEqual([])
  })
}

declare global {
  interface Window {
    __restoreItemCountProbe: () => void
  }
}
