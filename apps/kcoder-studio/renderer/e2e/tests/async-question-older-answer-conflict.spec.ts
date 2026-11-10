import { expect, test } from '@playwright/test'

test('an older conflicting saved answer requires readback and keeps ordinary input usable (model-independent)', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 420, height: 900 })
  await page.goto('/e2e/fixtures/async-question-browser.html?freeform')
  await page.getByTestId('async-question-toggle').click()
  await page.evaluate(async () => {
    const localPath = '/src/host/localExecutor.ts'
    const transportPath = '/src/lib/runtime-transport.ts'
    const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
    const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
    const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
      taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
      params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
    })
    const winner = { ...list.questions[0], revision: 3, status: 'queued', answer: {
      submissionId: 'winner', acceptedAtMs: 2,
      answers: { 'e2e-item-a': { text: 'Confirmed answer' } },
    } }
    let question = winner
    const transport = runtimeTransport()
    const original = transport.handler
    window.__olderAnswerConflictProbe = {
      conflict: () => { question = { ...winner, revision: 2, answer: { ...winner.answer,
        answers: { 'e2e-item-a': { text: 'Foreign older answer' } },
      } } },
      recover: () => { question = { ...winner, revision: 2 } },
      restore: () => { transport.handler = original },
    }
    transport.handler = (command: string, raw: unknown) => {
      const args = raw as { method: string; params: { method: string } }
      return command === 'local_executor_request' && args.method === 'runtime.asyncQuestion.request' &&
        args.params.method === 'asyncQuestion/list' ? { ...list, questions: [question] } : original(command, raw)
    }
  })
  try {
    await page.getByTestId('async-question-refresh').click()
    await expect(page.getByText('Confirmed answer')).toBeVisible()
    await page.evaluate(() => window.__olderAnswerConflictProbe.conflict())
    await page.getByTestId('async-question-refresh').click()
    await expect(page.getByTestId('async-question-retry')).toBeEnabled()
    await expect(page.getByText('Confirmed answer')).toBeVisible()
    await expect(page.getByText('Foreign older answer')).toHaveCount(0)
    await expect(page.getByTestId('async-question-continue-delivery-e2e-question-a')).toBeDisabled()
    await page.getByTestId('chat-message-input').fill('继续普通任务输入')
    await page.getByTestId('send-message-button').click()
    await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
    await page.screenshot({ path: testInfo.outputPath('older-conflicting-answer.png'), animations: 'disabled' })
    await page.evaluate(() => window.__olderAnswerConflictProbe.recover())
    await page.getByTestId('async-question-retry').click()
    await expect(page.getByTestId('async-question-retry')).toHaveCount(0)
    await expect(page.getByTestId('async-question-continue-delivery-e2e-question-a')).toBeEnabled()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await page.evaluate(() => window.__olderAnswerConflictProbe.restore())
  }
})

declare global {
  interface Window {
    __olderAnswerConflictProbe: { conflict(): void; recover(): void; restore(): void }
  }
}
