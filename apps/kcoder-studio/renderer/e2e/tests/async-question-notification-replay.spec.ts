import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __questionReplayProbe: {
      reads: number
      mode: 'normal' | 'failure' | 'conflict' | 'held'
      emit(conflict?: boolean): Promise<void>
      restore(): void
      release(): void
      emitNew(): Promise<void>
    }
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: exact question replays preserve drafts and failed refreshes (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&freeform`)
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    const submit = page.getByTestId('async-question-card-e2e-question-a')
      .getByTestId('request-user-input-submit-button')
    await draft.fill('保留原问题草稿')
    await expect(submit).toBeEnabled()
    await page.evaluate(async () => {
      const localPath = '/src/host/localExecutor.ts'
      const transportPath = '/src/lib/runtime-transport.ts'
      const notificationsPath = '/src/kcoder/gateway/runtime/notifications.ts'
      const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
      const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
      const { forwardAcceptedNotification } = await import(/* @vite-ignore */ notificationsPath)
      const task = { taskId: 'e2e-async-question:task-a', serverId: 'e2e-async-question-target',
        threadId: 'e2e-async-question-thread' }
      const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
        taskId: task.taskId, method: 'asyncQuestion/list', params: { threadId: task.threadId, includeTerminal: true },
      })
      const question = list.questions[0]
      const conflicting = { ...question, questions: [{ ...question.questions[0], question: 'Different prompt?' }] }
      const client = { supportsExperimental: () => true }
      const runtime = {
        disposed: false, appServerDisconnectedClients: new WeakSet(),
        tasks: new Map([[task.taskId, task]]),
        taskByThread: new Map([[`${task.serverId}\0${task.threadId}`, task.taskId]]),
        threadKey: (server: string, thread: string) => `${server}\0${thread}`,
        clientByTask: new Map([[task.taskId, client]]),
      }
      const peers = [1, 2].map(index => ({ ...question, questionId: `new-question-${index}`,
        requestId: `new-request-${index}`, toolCallId: `new-tool-${index}`,
        questions: [{ ...question.questions[0], id: `new-item-${index}` }] }))
      const held: Array<() => void> = []
      const transport = runtimeTransport(), original = transport.handler
      const probe: Window['__questionReplayProbe'] = {
        reads: 0, mode: 'normal', restore: () => {
          transport.handler = original
          held.splice(0).forEach(release => release())
        },
        release: () => {
          const release = held.shift()
          if (!release) throw new Error('No question list read is pending')
          release()
        },
        emitNew: async () => {
          for (let repeat = 0; repeat < 3; repeat++) {
            for (const peer of peers) {
              for (const update of [peer, { ...peer, revision: peer.revision + 1 }])
                await forwardAcceptedNotification.call(runtime, 'asyncQuestion/changed', {
                  threadId: task.threadId, question: structuredClone(update),
                }, task.serverId, client)
            }
          }
        },
        emit: async conflict => forwardAcceptedNotification.call(runtime, 'asyncQuestion/changed', {
          threadId: task.threadId, question: structuredClone(conflict ? conflicting : question),
        }, task.serverId, client),
      }
      transport.handler = (command: string, raw: unknown) => {
        const args = raw as { method: string; params: { method: string } }
        if (command === 'local_executor_request' && args.method === 'runtime.asyncQuestion.request' &&
            args.params.method === 'asyncQuestion/list') {
          probe.reads++
          if (probe.mode === 'held') return new Promise(resolve => {
            held.push(() => resolve({ ...list, questions: [question, ...peers] }))
          })
          if (probe.mode === 'failure') throw new Error('Original question read failed')
          if (probe.mode === 'conflict') return { ...list, questions: [conflicting] }
        }
        return original(command, raw)
      }
      window.__questionReplayProbe = probe
    })
    try {
      await page.evaluate(async () => {
        for (let index = 0; index < 100; index++) await window.__questionReplayProbe.emit()
      })
      expect(await page.evaluate(() => window.__questionReplayProbe.reads)).toBe(0)
      await expect(submit).toBeEnabled()
      await expect(draft).toHaveValue('保留原问题草稿')

      await page.evaluate(() => { window.__questionReplayProbe.mode = 'failure' })
      await page.getByTestId('async-question-refresh').click()
      await expect(page.getByTestId('async-question-retry')).toBeEnabled()
      await page.evaluate(() => window.__questionReplayProbe.emit())
      expect(await page.evaluate(() => window.__questionReplayProbe.reads)).toBe(1)
      await expect(submit).toBeDisabled()
      await expect(page.getByTestId('async-question-retry')).toBeEnabled()
      await page.evaluate(() => { window.__questionReplayProbe.mode = 'normal' })
      await page.getByTestId('async-question-retry').click()
      await expect(submit).toBeEnabled()

      await page.evaluate(async () => {
        window.__questionReplayProbe.mode = 'conflict'
        await window.__questionReplayProbe.emit(true)
      })
      await expect(page.getByTestId('async-question-retry')).toBeEnabled()
      expect(await page.evaluate(() => window.__questionReplayProbe.reads)).toBe(3)
      await expect(submit).toBeDisabled()
      await expect(draft).toHaveValue('保留原问题草稿')
      await page.getByTestId('chat-message-input').fill('继续处理已明确的工作')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      await page.screenshot({ path: testInfo.outputPath('question-conflict-preserved-draft.png'), animations: 'disabled' })
      await page.evaluate(() => { window.__questionReplayProbe.mode = 'normal' })
      await page.getByTestId('async-question-retry').click()
      await expect(submit).toBeEnabled()
      await expect(draft).toHaveValue('保留原问题草稿')
      const readsBefore = await page.evaluate(() => {
        window.__questionReplayProbe.mode = 'held'
        return window.__questionReplayProbe.reads
      })
      await page.getByTestId('async-question-refresh').click()
      await expect.poll(() => page.evaluate(() => window.__questionReplayProbe.reads)).toBe(readsBefore + 1)
      await page.evaluate(async () => {
        await window.__questionReplayProbe.emitNew()
        window.__questionReplayProbe.release()
      })
      await expect.poll(() => page.evaluate(() => window.__questionReplayProbe.reads)).toBe(readsBefore + 2)
      await page.evaluate(async () => {
        await window.__questionReplayProbe.emitNew()
        window.__questionReplayProbe.release()
      })
      await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
      expect(await page.evaluate(() => window.__questionReplayProbe.reads)).toBe(readsBefore + 2)
      for (const index of [1, 2]) await expect(page.getByTestId(`async-question-card-new-question-${index}`)).toBeVisible()
      await expect(draft).toHaveValue('保留原问题草稿')
      await expect(submit).toBeEnabled()
      await page.getByTestId('chat-message-input').fill('重复问题通知后继续工作')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('2')
      await page.screenshot({ path: testInfo.outputPath('unseen-question-replays-reconciled.png'), animations: 'disabled' })
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await page.evaluate(() => window.__questionReplayProbe.restore())
    }
  })
}
