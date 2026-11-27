import { expect, test } from '@playwright/test'

for (const [operation, invalidAnswer] of [
  ['list', 'oversized source'], ['competing answer', 'oversized saved answer'],
  ['list', 'foreign option'], ['competing answer', 'foreign option'],
  ['list', 'missing answer'], ['competing answer', 'missing answer'],
  ['list', 'answered pending'], ['competing answer', 'answered pending'],
  ['list', 'same revision prompt'], ['list', 'same revision status'],
  ['competing answer', 'same revision answer'],
  ['competing answer', 'unanswered pending'], ['competing answer', 'unanswered cancelled'],
  ['competing answer', 'unanswered stale'],
  ['list', 'zero revision'], ['competing answer', 'zero revision'],
  ['list', 'blank header'], ['competing answer', 'blank header'],
  ['list', 'blank submission'], ['competing answer', 'blank submission'],
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
      if (invalidAnswer === 'blank submission') question = { ...list.questions[0], revision: 2, status: 'queued', answer: {
        submissionId: ' \t\n ', acceptedAtMs: 2,
        answers: { 'e2e-item-a': { text: 'Unconfirmed winner' } },
      } }
      if (invalidAnswer === 'blank header') question = { ...list.questions[0],
        questions: list.questions[0].questions.map(item => ({ ...item, header: ' \t ' })),
        ...(operation === 'competing answer' ? { status: 'queued', revision: 2, answer: {
          submissionId: 'other-device', acceptedAtMs: 2,
          answers: { 'e2e-item-a': { text: 'Saved on the other device' } },
        } } : {}) }
      if (invalidAnswer === 'oversized source') question = { ...list.questions[0], sourceTurnId: '界'.repeat(86) }
      if (invalidAnswer === 'oversized saved answer') question = { ...list.questions[0], status: 'queued', revision: 2, answer: {
        submissionId: 'other-device', acceptedAtMs: 2,
        answers: { 'e2e-item-a': { text: '界'.repeat(5500) } },
      } }
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

for (const [status, change] of [
  ['cancelled', 'reopen'], ['stale', 'reopen'], ['context_applied', 'reopen'],
  ['delivery_failed', 'reopen'], ['delivery_unknown', 'reopen'],
  ['cancelled', 'add answer'], ['stale', 'add answer'],
] as const) {
  test(`a newer list cannot ${change} for a ${status} question (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/fixtures/async-question-browser.html?freeform')
    await page.getByTestId('async-question-toggle').click()
    await page.evaluate(async ({ status, change }) => {
      const localPath = '/src/host/localExecutor.ts'
      const transportPath = '/src/lib/runtime-transport.ts'
      const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
      const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
      const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
        taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
        params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
      })
      let question = { ...list.questions[0], revision: status === 'cancelled' || status === 'stale' ? 2 : 3, status,
        ...(['context_applied', 'delivery_failed', 'delivery_unknown'].includes(status) ? { answer: { submissionId: 'winner', acceptedAtMs: 2,
          answers: { 'e2e-item-a': { text: 'Saved answer' } } } } : {}),
      }
      const transport = runtimeTransport()
      const original = transport.handler
      window.__restoreSavedAnswerProbe = () => { transport.handler = original }
      window.__reopenTerminalProbe = () => {
        question = change === 'reopen'
          ? { ...question, revision: question.revision + 1, status: question.answer ? 'queued' : 'pending' }
          : { ...question, revision: 3, answer: { submissionId: 'late-answer', acceptedAtMs: 3,
              answers: { 'e2e-item-a': { text: 'Answer added after settlement' } } } }
      }
      transport.handler = (command: string, raw: unknown) => {
        const args = raw as { method: string; params: { method: string } }
        return command === 'local_executor_request' && args.method === 'runtime.asyncQuestion.request' &&
          args.params.method === 'asyncQuestion/list' ? { ...list, questions: [question] } : original(command, raw)
      }
    }, { status, change })
    const card = page.getByTestId('async-question-card-e2e-question-a')
    const hidden = ['context_applied', 'cancelled', 'stale'].includes(status)
    try {
      await page.getByTestId('async-question-refresh').click()
      if (hidden) {
        // Settled questions remain in the revision ledger after their card closes.
        await expect(card).toHaveCount(0)
        await expect(page.getByTestId('async-question-toggle')).toHaveCount(0)
      } else await expect(card).toHaveAttribute('data-status', status)
      await page.evaluate(() => window.__reopenTerminalProbe())
      if (hidden)
        await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitRecovery(true))
      else await page.getByTestId('async-question-refresh').click()
      await expect(page.getByTestId('async-question-retry')).toBeVisible()
      if (hidden) await expect(card).toHaveCount(0)
      else await expect(card).toHaveAttribute('data-status', status)
      await expect(page.getByText('Answer added after settlement', { exact: true })).toHaveCount(0)
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
    if (hidden) await expect(card).toHaveCount(0)
    else await expect(card).toHaveAttribute('data-status', status)
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
    expect(errors).toEqual([])
  })
}

for (const field of ['id', 'attemptId'] as const) {
  for (const [identity, valid] of [['\u0085', false], ['\uFEFF', true]] as const) {
    test(`started turn ${field}: Rust whitespace valid=${valid} (model-independent)`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 420, height: 900 })
      await page.goto('/e2e/fixtures/async-question-browser.html?freeform')
      await page.getByTestId('async-question-toggle').click()
      const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
      await draft.fill('保留原问题的回答')
      await page.evaluate(async ({ field, identity }) => {
        const localPath = '/src/host/localExecutor.ts'
        const transportPath = '/src/lib/runtime-transport.ts'
        const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
        const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
        const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
          taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
          params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
        })
        const transport = runtimeTransport(), original = transport.handler
        window.__restoreSavedAnswerProbe = () => { transport.handler = original }
        transport.handler = (command: string, raw: unknown) => {
          const args = raw as { method: string; params: { method: string; params: {
            submissionId: string; answers: Record<string, unknown>
          } } }
          if (command === 'local_executor_request' && args.method === 'runtime.asyncQuestion.request' &&
              args.params.method === 'asyncQuestion/answer') return {
            threadId: list.threadId, accepted: true, duplicate: false,
            startedTurn: { id: 'answer-turn', status: 'running', [field]: identity },
            question: { ...list.questions[0], revision: 2, status: 'queued', answer: {
              submissionId: args.params.params.submissionId, answers: args.params.params.answers, acceptedAtMs: 2,
            } },
          }
          return original(command, raw)
        }
      }, { field, identity })
      try {
        await page.getByTestId('request-user-input-submit-button').click()
        if (valid) {
          await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'queued')
          await expect(page.getByTestId('async-question-authoritative-answer-e2e-question-a')).toContainText('保留原问题的回答')
          await expect(page.getByTestId('async-question-submit-error')).toHaveCount(0)
        } else {
          await expect(page.getByTestId('async-question-submit-error')).toBeVisible()
          await expect(draft).toHaveValue('保留原问题的回答')
          await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
        }
        await page.getByTestId('chat-message-input').fill('继续普通任务输入')
        await page.getByTestId('send-message-button').click()
        await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
        expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
        await page.screenshot({ path: testInfo.outputPath('started-turn-unicode.png'), animations: 'disabled' })
      } finally {
        await page.evaluate(() => window.__restoreSavedAnswerProbe())
      }
    })
  }
}

declare global {
  interface Window {
    __restoreSavedAnswerProbe: () => void
    __reopenTerminalProbe: () => void
  }
}
