import { expect, test } from '@playwright/test'

for (const invalid of ['item ID', 'prompt', 'option ID', 'option label', 'questionId', 'requestId', 'sourceTurnId', 'toolCallId', 'saved answer at revision one'] as const) {
  test(`an invalid initial snapshot with ${invalid} stays hidden until a valid task read (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/fixtures/async-question-browser.html?freeform&answerRace')
    await expect(page.getByTestId('async-question-toggle')).toBeVisible()
    await page.evaluate(async invalid => {
      const transportPath = '/src/lib/runtime-transport.ts'
      const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
      const transport = runtimeTransport()
      const original = transport.handler
      window.__restorePromptValidationProbe = () => { transport.handler = original }
      transport.handler = async (command: string, raw: unknown) => {
        const result = await original(command, raw)
        const args = raw as { method: string; params: { method: string } }
        if (command !== 'local_executor_request' || args.method !== 'runtime.asyncQuestion.request' ||
            args.params.method !== 'asyncQuestion/list') return result
        return { ...result, questions: result.questions.map(question => ({ ...question,
          ...(invalid === 'saved answer at revision one' ? {
            revision: 1, status: 'queued', answer: {
              submissionId: 'unconfirmed-submission', acceptedAtMs: 2,
              answers: Object.fromEntries(question.questions.map(item => [item.id, { text: 'Unconfirmed answer' }])),
            },
          } : {}),
          ...(['questionId', 'requestId', 'sourceTurnId', 'toolCallId'].includes(invalid) ? { [invalid]: ' \t ' } : {}),
          questions: question.questions.map(item => ({ ...item,
            ...(invalid === 'item ID' ? { id: '   ' } : {}),
            ...(invalid === 'prompt' ? { question: '   ' } : {}),
            ...(invalid.startsWith('option') ? { options: [{
              id: invalid === 'option ID' ? '   ' : 'fast',
              label: invalid === 'option label' ? '   ' : 'Fast', description: '',
            }] } : {}),
          })),
        })) }
      }
    }, invalid)
    try {
      // The first read on a fresh task cannot rely on a previous prompt fingerprint.
      const completedReads = await page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())
      await page.getByTestId('fixture-task-b').click()
      await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls()))
        .toBeGreaterThan(completedReads)
      await expect(page.getByTestId('async-question-toggle')).toHaveCount(0)
      await expect(page.getByTestId('request-user-input-submit-button')).toHaveCount(0)
      await expect(page.getByText('Unconfirmed answer', { exact: true })).toHaveCount(0)
      await page.getByTestId('chat-message-input').fill('继续普通任务输入')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
      await page.screenshot({ path: testInfo.outputPath('invalid-prompt-recovery.png'), animations: 'disabled' })
    } finally {
      await page.evaluate(() => window.__restorePromptValidationProbe())
    }
    // Invalid first reads cannot invent a question status entry. A later task
    // visit retries the authoritative list without replaying an answer.
    await page.getByTestId('fixture-task-a').click()
    await expect(page.getByTestId('async-question-toggle')).toBeVisible()
    await page.getByTestId('fixture-task-b').click()
    await page.getByTestId('async-question-toggle').click()
    await expect(page.getByTestId('request-user-input-custom-e2e-item-a')).toBeEnabled()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
    expect(errors).toEqual([])
  })
}

declare global {
  interface Window {
    __restorePromptValidationProbe: () => void
  }
}
