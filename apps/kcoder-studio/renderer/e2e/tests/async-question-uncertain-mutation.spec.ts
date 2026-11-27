import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __uncertainQuestionProbe: { finish(): void; restore(): void; answers: number }
  }
}

for (const [scenario, saved, receipt] of [
  ['new answer with lost receipt', false, null],
  ['saved delivery with lost receipt', true, null],
  ['refused answer matching the saved submission', false, 'refused'],
  ['answer receipt claims the source turn started', false, 'source'],
  ['cancelled answer receipt claims a new turn', false, 'cancelled'],
] as const) {
  test(`${scenario} waits for original-task readback (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/fixtures/async-question-browser.html?freeform')
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('保留原回答草稿')
    const submit = page.getByTestId('request-user-input-submit-button')
    if (saved) {
      await submit.click()
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
    }
    await page.evaluate(async receiptScenario => {
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
      const readback = new Promise(resolve => { finish = () => resolve(list) })
      window.__uncertainQuestionProbe = { finish, restore: () => { transport.handler = original }, answers: 0 }
      transport.handler = (command: string, raw: unknown) => {
        const args = raw as { method: string; params: { method: string;
          params: { submissionId: string; answers: Record<string, unknown> } } }
        if (command !== 'local_executor_request' || args.method !== 'runtime.asyncQuestion.request')
          return original(command, raw)
        if (args.params.method === 'asyncQuestion/list') return readback
        if (args.params.method !== 'asyncQuestion/answer') throw new Error('Unexpected probe operation')
        window.__uncertainQuestionProbe.answers++
        if (receiptScenario) {
          const { submissionId, answers } = args.params.params
          const question = list.questions[0]
          const cancelled = receiptScenario === 'cancelled'
          const startedTurn = receiptScenario === 'refused' ? undefined : {
            id: cancelled ? 'answer-turn' : question.sourceTurnId, status: 'running',
          }
          return { threadId: list.threadId, accepted: receiptScenario !== 'refused', duplicate: false,
            question: { ...question, revision: question.revision + 1, status: cancelled ? 'cancelled' : 'answer_saved',
              answer: { submissionId, answers, acceptedAtMs: 2 } }, startedTurn }
        }
        throw new Error('Original answer outcome unknown')
      }
    }, receipt)
    try {
      const action = saved ? page.getByTestId('async-question-continue-delivery-e2e-question-a') : submit
      await action.click()
      await expect(page.getByTestId('async-question-submit-error')).toBeVisible()
      await expect(action).toBeDisabled()
      if (!saved) await expect(draft).toHaveValue('保留原回答草稿')
      const composer = page.getByTestId('chat-message-input')
      await composer.fill('回读期间继续普通工作')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      expect(await page.evaluate(() => window.__uncertainQuestionProbe.answers)).toBe(1)
      await page.screenshot({ path: testInfo.outputPath('uncertain-action-readback.png'), animations: 'disabled' })
      await page.evaluate(() => window.__uncertainQuestionProbe.finish())
      await expect(action).toBeEnabled()
      expect(await page.evaluate(() => window.__uncertainQuestionProbe.answers)).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await page.evaluate(() => { window.__uncertainQuestionProbe.finish(); window.__uncertainQuestionProbe.restore() })
    }
  })
}
