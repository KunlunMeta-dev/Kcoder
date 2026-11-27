import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  for (const scenario of ['list delivery error', 'competing answer delivery error', 'list premature terminal', 'list missing delivery diagnostic'] as const) {
    test(`${theme}: ${scenario} retains the draft during recovery (model-independent)`, async ({ page }, testInfo) => {
      const isList = scenario !== 'competing answer delivery error'
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width: 420, height: 900 })
      await page.goto(`/e2e/fixtures/async-question-browser.html?freeform&theme=${theme}`)
      await page.getByTestId('async-question-toggle').click()
      const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
      await draft.fill('保留原问题草稿')
      const restoreKey = '__restoreDeliveryStateProbe'
      await page.evaluate(async ({ scenario, isList, restoreKey }) => {
        const localPath = '/src/host/localExecutor.ts'
        const transportPath = '/src/lib/runtime-transport.ts'
        const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
        const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
        const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
          taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
          params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
        })
        const question = { ...list.questions[0], revision: 2,
          ...(scenario === 'list premature terminal' ? { status: 'stale' } :
            scenario === 'list missing delivery diagnostic' ? { status: 'delivery_failed', revision: 3 } :
            { status: 'queued', deliveryError: 'Stale delivery failure' }),
          answer: {
            submissionId: 'other-device', acceptedAtMs: 2,
            answers: { 'e2e-item-a': { text: 'Unconfirmed answer' } },
          } }
        const transport = runtimeTransport(), original = transport.handler
        Object.assign(window, { [restoreKey]: () => { transport.handler = original } })
        transport.handler = (command: string, raw: unknown) => {
          const args = raw as { method: string; params: { method: string } }
          if (command === 'local_executor_request' && args.method === 'runtime.asyncQuestion.request') {
            if (isList && args.params.method === 'asyncQuestion/list')
              return { ...list, questions: [question] }
            if (!isList && args.params.method === 'asyncQuestion/answer')
              return { threadId: list.threadId, accepted: false, duplicate: false, question }
          }
          return original(command, raw)
        }
      }, { scenario, isList, restoreKey })
      try {
        await page.getByTestId(isList ? 'async-question-refresh' : 'request-user-input-submit-button').click()
        await expect(page.getByTestId(isList ? 'async-question-retry' : 'async-question-submit-error')).toBeVisible()
        await expect(draft).toHaveValue('保留原问题草稿')
        await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
        await expect(page.getByText('Unconfirmed answer', { exact: true })).toHaveCount(0)
        await page.getByTestId('chat-message-input').fill('继续普通任务输入')
        await page.getByTestId('send-message-button').click()
        await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
        expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
        await page.screenshot({ path: testInfo.outputPath('delivery-state-draft-preserved.png'), animations: 'disabled' })
      } finally {
        await page.evaluate(key => (window as unknown as Record<string, () => void>)[key](), restoreKey)
      }
      await page.getByTestId(isList ? 'async-question-retry' : 'async-question-refresh').click()
      const submit = page.getByTestId('request-user-input-submit-button')
      await expect(submit).toBeEnabled()
      await expect(draft).toHaveValue('保留原问题草稿')
      await submit.click()
      await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
      expect(errors).toEqual([])
    })
  }
}
