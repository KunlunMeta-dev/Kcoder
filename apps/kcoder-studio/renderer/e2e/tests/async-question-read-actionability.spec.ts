import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  for (const saved of [false, true]) {
    test(`${theme}: ${saved ? 'saved delivery' : 'unsent answer'} waits for recovery without blocking conversation (model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}`)
      await page.getByTestId('async-question-toggle').click()
      const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
      await draft.fill('保留原问题回答草稿')
      const submit = page.getByTestId('request-user-input-submit-button')
      if (saved) {
        await submit.click()
        await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'answer_saved')
      }
      const action = saved ? page.getByTestId('async-question-continue-delivery-e2e-question-a') : submit
      await expect(action).toBeEnabled()
      await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitRecovery('error'))
      await expect(page.getByTestId('async-question-retry')).toBeEnabled()
      await expect(action).toBeDisabled()
      if (!saved) await expect(draft).toHaveValue('保留原问题回答草稿')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(saved ? 1 : 0)
      const composer = page.getByTestId('chat-message-input')
      await composer.fill('提问状态恢复期间继续普通工作')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      await page.screenshot({ path: testInfo.outputPath('question-recovery-actions.png'), animations: 'disabled' })
      await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitRecovery(true))
      await expect(action).toBeEnabled()
      if (!saved) await expect(draft).toHaveValue('保留原问题回答草稿')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(saved ? 1 : 0)
      await action.click()
      await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(saved ? 2 : 1)
      expect(errors).toEqual([])
    })
  }
}


declare global {
  interface Window {
    __invalidQuestionProbe: { restore(): void; answers: number }
    __incompleteQuestionProbe: { restore(): void }
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const shape of ['empty', 'partial'] as const) {
    test(`${theme}: ${shape} full list preserves original questions and drafts (model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width: shape === 'empty' ? 320 : 390, height: 900 })
      await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&freeform`)
      await page.getByTestId('async-question-toggle').click()
      await page.evaluate(() => window.__asyncQuestionBrowserFixture.appendQuestion())
      await expect(page.getByTestId('async-question-card-e2e-question-next-1')).toBeVisible()
      const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
      await draft.fill('保留原问题草稿 Keep the original draft')
      await page.evaluate(async shape => {
        const transportPath = '/src/lib/runtime-transport.ts'
        const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
        const transport = runtimeTransport()
        const original = transport.handler
        window.__incompleteQuestionProbe = { restore: () => { transport.handler = original } }
        transport.handler = async (command: string, raw: unknown) => {
          const result = await original(command, raw)
          const args = raw as { method: string; params: { method: string } }
          if (command !== 'local_executor_request' || args.method !== 'runtime.asyncQuestion.request' ||
              args.params.method !== 'asyncQuestion/list') return result
          return { ...result, questions: shape === 'empty' ? [] : result.questions.slice(1) }
        }
      }, shape)
      try {
        await page.getByTestId('async-question-refresh').click()
        await expect(page.getByTestId('async-question-retry')).toBeEnabled()
        await expect(draft).toHaveValue('保留原问题草稿 Keep the original draft')
        const submit = page.getByTestId('async-question-card-e2e-question-a').getByTestId('request-user-input-submit-button')
        await expect(submit).toBeDisabled()
        await page.getByTestId('chat-message-input').fill('继续原任务 Continue the task')
        await page.getByTestId('send-message-button').click()
        await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
        await page.screenshot({ path: testInfo.outputPath('incomplete-list-retained-draft.png'), animations: 'disabled' })
        await page.evaluate(() => window.__incompleteQuestionProbe.restore())
        await page.getByTestId('async-question-retry').click()
        await expect(submit).toBeEnabled()
        await expect(draft).toHaveValue('保留原问题草稿 Keep the original draft')
        expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
        expect(errors).toEqual([])
      } finally {
        await page.evaluate(() => window.__incompleteQuestionProbe.restore())
      }
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const { shape, operation } of ['malformed', 'duplicate item', 'duplicate option'].flatMap(
    shape => (['list', 'answer'] as const).map(operation => ({ shape, operation }))
  )) {
    test(`${theme}: ${shape} ${operation} records retain the question draft and conversation (model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width: 420, height: 900 })
      await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&freeform`)
      await page.getByTestId('async-question-toggle').click()
      const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
      await draft.fill('保留原问题草稿')
      await page.evaluate(async ({ operation, shape }) => {
        const localPath = '/src/host/localExecutor.ts'
        const transportPath = '/src/lib/runtime-transport.ts'
        const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
        const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
        const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
          taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
          params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
        })
        const invalid = structuredClone(list.questions[0])
        if (shape === 'malformed') invalid.questions = null
        else if (shape === 'duplicate item') invalid.questions.push({
          ...invalid.questions[0], question: 'Another prompt with the same item identity?',
        })
        else invalid.questions[0].options = [
          { id: 'duplicate-option', label: 'First choice', description: '' },
          { id: 'duplicate-option', label: 'Different choice', description: '' },
        ]
        const transport = runtimeTransport()
        const original = transport.handler
        window.__invalidQuestionProbe = { answers: 0, restore: () => { transport.handler = original } }
        transport.handler = (command: string, raw: unknown) => {
          const args = raw as { method: string; params: { method: string } }
          if (command !== 'local_executor_request' || args.method !== 'runtime.asyncQuestion.request')
            return original(command, raw)
          if (args.params.method === 'asyncQuestion/list') return {
            ...list, questions: operation === 'list' ? [invalid] : list.questions,
          }
          if (args.params.method !== 'asyncQuestion/answer') throw new Error('Unexpected validation probe operation')
          window.__invalidQuestionProbe.answers++
          return { threadId: list.threadId, accepted: true, duplicate: false,
            question: { ...invalid, revision: 2, status: 'answer_saved' } }
        }
      }, { operation, shape })
      try {
        const submit = page.getByTestId('request-user-input-submit-button')
        if (operation === 'list') {
          await page.getByTestId('async-question-refresh').click()
          await expect(page.getByTestId('async-question-retry')).toBeEnabled()
          await expect(submit).toBeDisabled()
        } else {
          await submit.click()
          await expect(page.getByTestId('async-question-submit-error')).toBeVisible()
          await expect(submit).toBeEnabled()
        }
        await expect(draft).toHaveValue('保留原问题草稿')
        const composer = page.getByTestId('chat-message-input')
        await composer.fill('继续普通任务输入')
        await page.getByTestId('send-message-button').click()
        await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
        expect(await page.evaluate(() => window.__invalidQuestionProbe.answers)).toBe(operation === 'answer' ? 1 : 0)
        await page.screenshot({ path: testInfo.outputPath(`invalid-${operation}-preserved-draft.png`), animations: 'disabled' })
        await page.evaluate(() => window.__invalidQuestionProbe.restore())
        if (operation === 'list') await page.getByTestId('async-question-retry').click()
        await expect(submit).toBeEnabled()
        await expect(draft).toHaveValue('保留原问题草稿')
        expect(errors).toEqual([])
      } finally {
        await page.evaluate(() => window.__invalidQuestionProbe.restore())
      }
    })
  }
}
