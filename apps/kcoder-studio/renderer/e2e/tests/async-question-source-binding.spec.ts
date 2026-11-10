import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __sourceQuestionProbe: { finish(): void; restore(): void }
  }
}

for (const saved of [false, true]) {
  for (const accepted of [false, true]) {
    for (const conflict of ['source turn', 'prompt', 'selection mode'] as const) {
      test(`${saved ? 'saved delivery' : 'new answer'} rejects a wrong ${conflict} (accepted=${accepted}, model-independent)`, async ({ page }, testInfo) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto('/e2e/fixtures/async-question-browser.html?freeform')
        await page.getByTestId('async-question-toggle').click()
        const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
        await draft.fill('保留原问题回答')
        const submit = page.getByTestId('request-user-input-submit-button')
        if (saved) {
          await submit.click()
          await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
        }
        await page.evaluate(async ({ accepted, conflict }) => {
          const transportPath = '/src/lib/runtime-transport.ts'
          const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
          const transport = runtimeTransport()
          const original = transport.handler
          let finish!: () => void
          const readback = new Promise<void>(resolve => { finish = resolve })
          window.__sourceQuestionProbe = { finish, restore: () => { transport.handler = original } }
          transport.handler = async (command: string, raw: unknown) => {
            const args = raw as { method: string; params: { method: string } }
            const result = await original(command, raw)
            if (command !== 'local_executor_request' || args.method !== 'runtime.asyncQuestion.request') return result
            if (args.params.method === 'asyncQuestion/list') await readback
            if (args.params.method !== 'asyncQuestion/answer') return result
            const question = structuredClone(result.question)
            if (conflict === 'source turn') question.sourceTurnId = 'unrelated-source-turn'
            else if (conflict === 'prompt') question.questions[0].question = 'Unrelated prompt'
            else question.questions[0].multiSelect = !question.questions[0].multiSelect
            return { ...result, accepted, question }
          }
        }, { accepted, conflict })
        try {
          const action = saved ? page.getByTestId('async-question-continue-delivery-e2e-question-a') : submit
          await action.click()
          await expect(page.getByTestId('async-question-submit-error')).toBeVisible()
          await expect(action).toBeDisabled()
          await expect(page.getByText('Unrelated prompt', { exact: true })).toHaveCount(0)
          if (!saved) await expect(draft).toHaveValue('保留原问题回答')
          await page.evaluate(() => window.__sourceQuestionProbe.finish())
          // The fixture really saved this answer, so readback recovers the original
          // question even though the direct receipt claimed an unrelated source.
          await expect(page.getByTestId('async-question-continue-delivery-e2e-question-a')).toBeEnabled()
          const card = page.getByTestId('async-question-card-e2e-question-a')
          await expect(card).toHaveAttribute('data-status', 'answer_saved')
          await expect(card).toContainText('保留原问题回答')
          expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(saved ? 2 : 1)
          await page.getByTestId('chat-message-input').fill('继续原任务的普通输入')
          await page.getByTestId('send-message-button').click()
          await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
          expect(errors).toEqual([])
          await page.screenshot({ path: testInfo.outputPath('source-mismatch-readback.png'), animations: 'disabled' })
        } finally {
          await page.evaluate(() => { window.__sourceQuestionProbe.finish(); window.__sourceQuestionProbe.restore() })
        }
      })
    }
  }
}
