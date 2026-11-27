import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __answerRecoveryProbe: {
      requests: Array<Record<string, unknown>>
      finishAnswer(): void
      finishSupport(): void
      restore(): void
    }
    __deliveryRetryProbe: {
      requests: Array<Record<string, unknown>>
      reject(): void
      restore(): void
    }
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const status of ['queued', 'answer_saved'] as const) {
    test(`${status} saved delivery stays singly pending in ${theme} (model-independent)`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 420, height: 900 })
      await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}`)
      await page.getByTestId('async-question-toggle').click()
      await page.getByTestId('request-user-input-option-e2e-item-a-1').click()
      await page.getByTestId('request-user-input-submit-button').click()
      const card = page.getByTestId('async-question-card-e2e-question-a')
      await expect(card).toHaveAttribute('data-status', 'answer_saved')

      // Keep the real card and original saved payload. Only delay the retry's
      // transport receipt; this fixture never connects to a model or Gateway.
      await page.evaluate(async status => {
        const localPath = '/src/host/localExecutor.ts'
        const bridgePath = '/src/kcoder/gatewayServiceBridge.ts'
        const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
        const { registerGatewayCommandTransport } = await import(/* @vite-ignore */ bridgePath)
        const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
          taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
          params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
        })
        // Status changes are new durable revisions, not conflicting snapshots.
        if (list.questions[0].status !== status) list.questions[0].revision += 1
        list.questions[0].status = status
        const requests: Array<Record<string, unknown>> = []
        let reject: ((error: Error) => void) | undefined
        const restore = registerGatewayCommandTransport((command: string, raw: unknown) => {
          const args = raw as { method: string; params: { method: string; params: Record<string, unknown> } }
          if (command !== 'local_executor_request' || args.method !== 'runtime.asyncQuestion.request')
            throw new Error('Unexpected delivery probe command')
          if (args.params.method === 'asyncQuestion/list') return structuredClone(list)
          if (args.params.method !== 'asyncQuestion/answer') throw new Error('Unexpected delivery probe method')
          requests.push(structuredClone(args.params.params))
          return new Promise((_resolve, fail) => { reject = fail })
        })
        window.__deliveryRetryProbe = { requests, restore, reject: () => {
          if (!reject) throw new Error('No pending delivery retry')
          reject(new Error('Controlled delivery receipt unavailable'))
          reject = undefined
        } }
      }, status)
      try {
        await page.getByTestId('async-question-refresh').click()
        await expect(card).toHaveAttribute('data-status', status)
        const retry = page.getByTestId('async-question-continue-delivery-e2e-question-a')
        const composer = page.getByTestId('chat-message-input')
        await composer.fill('投递等待期间继续原任务')
        await retry.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
        await expect(retry).toBeDisabled()
        expect(await page.evaluate(() => window.__deliveryRetryProbe.requests.length)).toBe(1)
        await page.getByTestId('send-message-button').click()
        await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
        await composer.fill('保留新的普通输入草稿')
        await expect(composer).toBeEditable()
        await page.screenshot({ path: testInfo.outputPath('saved-delivery-pending.png'), animations: 'disabled' })

        await page.evaluate(() => window.__deliveryRetryProbe.reject())
        await expect(retry).toBeEnabled()
        await expect(page.getByTestId('async-question-submit-error')).toBeVisible()
        await expect(composer).toHaveText('保留新的普通输入草稿')
        await retry.click()
        await expect(retry).toBeDisabled()
        const requests = await page.evaluate(() => window.__deliveryRetryProbe.requests)
        expect(requests).toHaveLength(2)
        expect(requests[1]).toEqual(requests[0])
        await page.evaluate(() => window.__deliveryRetryProbe.reject())
        await expect(retry).toBeEnabled()
      } finally {
        await page.evaluate(() => window.__deliveryRetryProbe.restore())
      }
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`answer receipt during recovery releases the retained draft in ${theme} (model-independent)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&freeform`)
    await page.getByTestId('async-question-toggle').click()
    await page.evaluate(async () => {
      const localPath = '/src/host/localExecutor.ts'
      const transportPath = '/src/lib/runtime-transport.ts'
      const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
      const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
      const transport = runtimeTransport()
      const originalHandler = transport.handler
      const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
        taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
        params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
      })
      const requests: Array<Record<string, unknown>> = []
      let finishAnswer: (() => void) | undefined
      let finishSupport: (() => void) | undefined
      // Keep the mounted panel's original event subscription while delaying commands.
      transport.handler = (command: string, raw: unknown) => {
        const args = raw as { method: string; params: { method: string; params: Record<string, unknown> } }
        if (command !== 'local_executor_request') throw new Error('Unexpected recovery probe command')
        if (args.method === 'runtime.asyncQuestion.supports') return new Promise(resolve => {
          finishSupport = () => resolve({ supported: true, threadId: list.threadId })
        })
        if (args.method !== 'runtime.asyncQuestion.request') throw new Error('Unexpected recovery probe operation')
        if (args.params.method === 'asyncQuestion/list') return structuredClone(list)
        if (args.params.method !== 'asyncQuestion/answer') throw new Error('Unexpected recovery probe method')
        const input = structuredClone(args.params.params)
        requests.push(input)
        return new Promise(resolve => {
          finishAnswer = () => resolve({ threadId: list.threadId, accepted: true, duplicate: false,
            question: { ...list.questions[0], revision: 2, status: 'answer_saved', answer: {
              submissionId: input.submissionId, answers: input.answers, acceptedAtMs: 2,
            } } })
        })
      }
      window.__answerRecoveryProbe = { requests, restore: () => { transport.handler = originalHandler },
        finishAnswer: () => {
          if (!finishSupport) throw new Error('Capability recovery must precede the old receipt')
          if (!finishAnswer) throw new Error('No pending answer receipt')
          finishAnswer()
        },
        finishSupport: () => {
          if (!finishSupport) throw new Error('No pending capability read')
          finishSupport()
        },
      }
    })
    try {
      const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
      const submit = page.getByTestId('request-user-input-submit-button')
      const composer = page.getByTestId('chat-message-input')
      await draft.fill('恢复期间保留原问题答案')
      await composer.fill('普通输入仍然可用')
      await submit.click()
      await expect(draft).toBeDisabled()
      await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitRecovery(true))
      await page.evaluate(() => window.__answerRecoveryProbe.finishAnswer())
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
      await expect(submit).toBeDisabled()
      await expect(composer).toBeEditable()
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      await page.evaluate(() => window.__answerRecoveryProbe.finishSupport())
      await expect(submit).toBeEnabled()
      await expect(draft).toBeEditable()
      await expect(draft).toHaveValue('恢复期间保留原问题答案')
      expect(await page.evaluate(() => window.__answerRecoveryProbe.requests.length)).toBe(1)
      await page.screenshot({ path: testInfo.outputPath('answer-recovery-draft.png'), animations: 'disabled' })
    } finally {
      await page.evaluate(() => window.__answerRecoveryProbe.restore())
    }
  })
}
