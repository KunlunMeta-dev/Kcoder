import { expect, test } from '@playwright/test'

for (const [operation, invalidAnswer] of [
  ['list', 'foreign option'], ['competing answer', 'foreign option'],
  ['list', 'missing answer'], ['competing answer', 'missing answer'],
  ['list', 'answered pending'], ['competing answer', 'answered pending'],
  ['list', 'same revision prompt'], ['list', 'same revision status'],
  ['competing answer', 'same revision answer'],
  ['competing answer', 'unanswered pending'], ['competing answer', 'unanswered cancelled'],
  ['competing answer', 'unanswered stale'],
  ['list', 'zero revision'], ['competing answer', 'zero revision'],
] as const) {
  test(`${operation}: ${invalidAnswer} preserves the original draft (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 420, height: 900 })
    await page.goto('/e2e/fixtures/async-question-browser.html?freeform')
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('保留原问题的回答')
    await page.evaluate(async ({ operation, invalidAnswer }) => {
      const localPath = '/src/host/localExecutor.ts'
      const transportPath = '/src/lib/runtime-transport.ts'
      const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
      const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
      const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
        taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
        params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
      })
      let question = { ...list.questions[0], revision: 2, status: invalidAnswer === 'answered pending' ? 'pending' : 'queued', answer: invalidAnswer === 'missing answer' ? null : {
        submissionId: 'other-device', acceptedAtMs: 2,
        answers: { 'e2e-item-a': invalidAnswer === 'answered pending' ? { text: 'Valid saved answer' } : { selectedOptionIds: ['foreign-option'] } },
      } }
      if (invalidAnswer === 'same revision prompt') question = { ...list.questions[0],
        questions: list.questions[0].questions.map(item => ({ ...item, question: 'Changed prompt without a revision' })) }
      if (invalidAnswer === 'same revision status') question = { ...list.questions[0], status: 'cancelled' }
      if (invalidAnswer === 'same revision answer') question = { ...list.questions[0], status: 'queued', answer: {
        submissionId: 'other-device', acceptedAtMs: 2,
        answers: { 'e2e-item-a': { text: 'Foreign answer without a revision' } },
      } }
      if (invalidAnswer.startsWith('unanswered ')) question = { ...list.questions[0],
        revision: invalidAnswer === 'unanswered pending' ? 1 : 2,
        status: invalidAnswer.slice('unanswered '.length), answer: null }
      if (invalidAnswer === 'zero revision') question = { ...list.questions[0], revision: 0,
        ...(operation === 'competing answer' ? { status: 'queued', answer: {
          submissionId: 'other-device', acceptedAtMs: 2,
          answers: { 'e2e-item-a': { text: 'Saved on the other device' } },
        } } : {}) }
      const transport = runtimeTransport()
      const original = transport.handler
      window.__restoreSavedAnswerProbe = () => { transport.handler = original }
      transport.handler = (command: string, raw: unknown) => {
        const args = raw as { method: string; params: { method: string } }
        if (command === 'local_executor_request' && args.method === 'runtime.asyncQuestion.request') {
          if (operation === 'list' && args.params.method === 'asyncQuestion/list')
            return { ...list, questions: [question] }
          if (operation === 'competing answer' && args.params.method === 'asyncQuestion/answer')
            return { threadId: list.threadId, accepted: false, duplicate: false, question }
        }
        return original(command, raw)
      }
    }, { operation, invalidAnswer })
    try {
      await page.getByTestId(operation === 'list' ? 'async-question-refresh' : 'request-user-input-submit-button').click()
      await expect(page.getByTestId(operation === 'list' ? 'async-question-retry' : 'async-question-submit-error')).toBeVisible()
      await expect(draft).toHaveValue('保留原问题的回答')
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
      await expect(page.getByTestId('async-question-continue-delivery-e2e-question-a')).toHaveCount(0)
      await page.getByTestId('chat-message-input').fill('继续普通任务输入')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
      await page.screenshot({ path: testInfo.outputPath('invalid-saved-answer-preserved-draft.png'), animations: 'disabled' })
    } finally {
      await page.evaluate(() => window.__restoreSavedAnswerProbe())
    }
    await page.getByTestId(operation === 'list' ? 'async-question-retry' : 'async-question-refresh').click()
    const submit = page.getByTestId('request-user-input-submit-button')
    await expect(submit).toBeEnabled()
    await expect(draft).toHaveValue('保留原问题的回答')
    await submit.click()
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
    expect(errors).toEqual([])
  })
}

for (const status of ['cancelled', 'stale', 'context_applied', 'delivery_failed', 'delivery_unknown'] as const) {
  test(`a newer list cannot reopen ${status} input or delivery (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/fixtures/async-question-browser.html?freeform')
    await page.getByTestId('async-question-toggle').click()
    await page.evaluate(async status => {
      const localPath = '/src/host/localExecutor.ts'
      const transportPath = '/src/lib/runtime-transport.ts'
      const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
      const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
      const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
        taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
        params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
      })
      let question = { ...list.questions[0], revision: 2, status,
        ...(['context_applied', 'delivery_failed', 'delivery_unknown'].includes(status) ? { answer: { submissionId: 'winner', acceptedAtMs: 2,
          answers: { 'e2e-item-a': { text: 'Saved answer' } } } } : {}),
      }
      const transport = runtimeTransport()
      const original = transport.handler
      window.__restoreSavedAnswerProbe = () => { transport.handler = original }
      window.__reopenTerminalProbe = () => {
        question = { ...question, revision: 3, status: question.answer ? 'queued' : 'pending' }
      }
      transport.handler = (command: string, raw: unknown) => {
        const args = raw as { method: string; params: { method: string } }
        return command === 'local_executor_request' && args.method === 'runtime.asyncQuestion.request' &&
          args.params.method === 'asyncQuestion/list' ? { ...list, questions: [question] } : original(command, raw)
      }
    }, status)
    const card = page.getByTestId('async-question-card-e2e-question-a')
    try {
      await page.getByTestId('async-question-refresh').click()
      await expect(card).toHaveAttribute('data-status', status)
      await page.evaluate(() => window.__reopenTerminalProbe())
      await page.getByTestId('async-question-refresh').click()
      await expect(page.getByTestId('async-question-retry')).toBeVisible()
      await expect(card).toHaveAttribute('data-status', status)
      await expect(page.getByTestId('request-user-input-submit-button')).toHaveCount(0)
      await expect(page.getByTestId('async-question-continue-delivery-e2e-question-a')).toHaveCount(0)
      await page.getByTestId('chat-message-input').fill('继续普通任务输入')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      await page.screenshot({ path: testInfo.outputPath('terminal-question-retained.png'), animations: 'disabled' })
    } finally {
      await page.evaluate(() => window.__restoreSavedAnswerProbe())
    }
    // An older pre-terminal read is compatible, but cannot undo the known end.
    await page.getByTestId('async-question-retry').click()
    await expect(page.getByTestId('async-question-retry')).toHaveCount(0)
    await expect(card).toHaveAttribute('data-status', status)
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
    expect(errors).toEqual([])
  })
}

declare global {
  interface Window {
    __restoreSavedAnswerProbe: () => void
    __reopenTerminalProbe: () => void
  }
}
