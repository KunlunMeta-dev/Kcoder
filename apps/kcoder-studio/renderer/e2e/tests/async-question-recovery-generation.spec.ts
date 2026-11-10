import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __recoveryGenerationProbe: { finish(): void; restore(): void; answers: number }
  }
}

for (const saved of [false, true]) {
  test(`${saved ? 'saved delivery' : 'new answer'} discards a previous connection receipt after recovery (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/fixtures/async-question-browser.html?freeform')
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('恢复后保留原问题草稿')
    const submit = page.getByTestId('request-user-input-submit-button')
    if (saved) {
      await submit.click()
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
    }
    await page.evaluate(async () => {
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
      let finish!: () => void
      const held = new Promise<void>(resolve => { finish = resolve })
      window.__recoveryGenerationProbe = { finish, answers: 0, restore: () => { transport.handler = original } }
      transport.handler = async (command: string, raw: unknown) => {
        const args = raw as { method: string; params: { method: string; params: { submissionId: string; answers: unknown } } }
        if (command !== 'local_executor_request' || args.method !== 'runtime.asyncQuestion.request' ||
            args.params.method !== 'asyncQuestion/answer') return original(command, raw)
        window.__recoveryGenerationProbe.answers++
        await held
        // Fault injection at the transport boundary: the old socket returns a
        // valid receipt after the recovered connection has read its own state.
        return { threadId: list.threadId, accepted: true, duplicate: false,
          question: { ...list.questions[0], revision: list.questions[0].revision + 1,
            status: 'context_applied', answer: { submissionId: args.params.params.submissionId,
              answers: args.params.params.answers, acceptedAtMs: 3 } } }
      }
    })
    try {
      const action = saved ? page.getByTestId('async-question-continue-delivery-e2e-question-a') : submit
      await action.click()
      await expect.poll(() => page.evaluate(() => window.__recoveryGenerationProbe.answers)).toBe(1)
      const lists = await page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())
      await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitRecovery(true))
      await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())).toBeGreaterThan(lists)
      await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
      await page.evaluate(() => window.__recoveryGenerationProbe.finish())
      await expect(action).toBeEnabled()
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', saved ? 'answer_saved' : 'pending')
      if (!saved) await expect(draft).toHaveValue('恢复后保留原问题草稿')
      expect(await page.evaluate(() => window.__recoveryGenerationProbe.answers)).toBe(1)
      await page.getByTestId('chat-message-input').fill('恢复后继续普通输入')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      expect(errors).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('recovered-question.png'), animations: 'disabled' })
    } finally {
      await page.evaluate(() => { window.__recoveryGenerationProbe.finish(); window.__recoveryGenerationProbe.restore() })
    }
  })
}
