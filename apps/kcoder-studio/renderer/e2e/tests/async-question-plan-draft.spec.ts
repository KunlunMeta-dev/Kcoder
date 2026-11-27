import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`async plan wording preserves unrelated answer drafts in ${theme}`, async ({ page }, testInfo) => {
    await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}`)
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toBeAttached()
    // Replace only the existing model-independent fixture transport. The panel,
    // card, answer conversion and ordinary composer remain real components.
    await page.evaluate(async () => {
      const modulePath = '/src/kcoder/gatewayServiceBridge.ts'
      const { registerGatewayCommandTransport } = await import(modulePath)
      let question = {
        questionId: 'draft-question', requestId: 'draft-request',
        threadId: 'e2e-async-question-thread', sourceTurnId: 'draft-turn',
        toolCallId: 'draft-call', revision: 1, createdAtMs: 2, status: 'pending',
        questions: [
          { id: 'notes', header: '资料', question: '还需要哪些资料？', multiSelect: false, options: [] },
          { id: 'delivery', header: '交付', question: '如何交付？', multiSelect: false, options: [
            { id: 'draft', label: '执行此计划并生成草稿', description: '' },
            { id: 'review', label: '先审核', description: '' },
          ] },
        ],
      }
      registerGatewayCommandTransport(async (_command: string, args: { params: {
        method: string; params: Record<string, unknown>
      } }) => {
        const request = args.params
        if (request.method === 'asyncQuestion/list')
          return { threadId: question.threadId, questions: [question] }
        if (request.method !== 'asyncQuestion/answer') throw new Error('Unexpected fixture request')
        question = { ...question, revision: 2, status: 'answer_saved', ...{
          answer: { submissionId: request.params.submissionId, answers: request.params.answers,
            acceptedAtMs: 3 },
        } }
        return { threadId: question.threadId, question, accepted: true, duplicate: false }
      })
    })
    await page.getByTestId('async-question-refresh').click()
    const card = page.getByTestId('async-question-card-draft-question')
    await expect(card).toHaveAttribute('data-status', 'pending')
    await page.getByTestId('async-question-toggle').click()
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('继续原任务')
    const notes = page.getByTestId('request-user-input-custom-notes')
    await notes.fill('预算需财务确认，保留原任务。')
    await page.getByTestId('request-user-input-option-delivery-1').click()
    await expect(notes).toHaveValue('预算需财务确认，保留原任务。')
    await expect(card).toHaveAttribute('data-status', 'pending')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(card).toHaveAttribute('data-status', 'answer_saved')
    const answer = page.getByTestId('async-question-authoritative-answer-draft-question')
    await expect(answer).toContainText('预算需财务确认，保留原任务。')
    await expect(answer).toContainText('先审核')
    await expect(composer).toHaveText('继续原任务')
    await page.screenshot({ path: testInfo.outputPath(`plan-draft-${theme}.png`), animations: 'disabled' })
  })
}
