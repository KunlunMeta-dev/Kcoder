import { expect, test } from '@playwright/test'

for (const field of ['requestId', 'sourceTurnId', 'toolCallId'] as const) {
  test(`${field}: a higher revision from another source rejects the snapshot and preserve the draft (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 420, height: 900 })
    await page.goto(`/e2e/fixtures/async-question-browser.html?freeform`)
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('保留唯一原问题的草稿')
    // A reused ID and higher revision cannot replace the original source.
    await page.evaluate(async field => {
      const localPath = '/src/host/localExecutor.ts'
      const transportPath = '/src/lib/runtime-transport.ts'
      const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
      const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
      const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
        taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
        params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
      })
      const transport = runtimeTransport()
      const original = transport.handler
      window.__restoreQuestionListSourceProbe = () => { transport.handler = original }
      transport.handler = (command: string, raw: unknown) => {
        const args = raw as { method: string; params: { method: string } }
        if (command === 'local_executor_request' && args.method === 'runtime.asyncQuestion.request' &&
            args.params.method === 'asyncQuestion/list') return {
          ...list, questions: [{ ...list.questions[0], [field]: 'conflicting-source', revision: 9,
            questions: [{ ...list.questions[0].questions[0], question: '不应替换原卡片的问题' }] }],
        }
        return original(command, raw)
      }
    }, field)
    try {
      await page.getByTestId('async-question-refresh').click()
      await expect(page.getByTestId('async-question-retry')).toBeEnabled()
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveCount(1)
      await expect(draft).toHaveValue('保留唯一原问题的草稿')
      await expect(page.getByText('不应替换原卡片的问题')).toHaveCount(0)
      await expect(page.getByTestId('request-user-input-submit-button')).toBeDisabled()
      await page.getByTestId('chat-message-input').fill('读取失败期间继续普通工作')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
      await page.screenshot({ path: testInfo.outputPath('question-list-source-preserved-draft.png'), animations: 'disabled' })
    } finally {
      await page.evaluate(() => window.__restoreQuestionListSourceProbe())
    }
    await page.getByTestId('async-question-retry').click()
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    await expect(draft).toHaveValue('保留唯一原问题的草稿')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    expect(errors).toEqual([])
  })
}

declare global {
  interface Window {
    __restoreQuestionListSourceProbe: () => void
  }
}
