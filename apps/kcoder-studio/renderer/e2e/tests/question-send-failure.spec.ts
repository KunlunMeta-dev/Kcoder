import { expect, test } from '@playwright/test'

for (const binding of ['threadId', 'serverId', 'workspacePath', 'turnId', 'original']) {
  test(`ignoring a retained question respects its ${binding} address (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/e2e/fixtures/question-send-failure.html?cancelBinding=${binding}`)
    const composer = page.getByRole('textbox', { name: '普通对话草稿' })
    await composer.fill('普通对话仍可继续')
    const draft = page.getByTestId('request-user-input-custom-choice')
    await draft.fill('保留原问题草稿')
    await page.getByTestId('request-user-input-ignore-button').click()
    await expect(page.getByTestId('cancel-attempts')).toHaveText('1')
    await expect(page.getByTestId('cancel-wire-count')).toHaveText(binding === 'original' ? '1' : '0')
    if (binding === 'original') await expect(page.getByTestId('question-confirmed')).toBeVisible()
    else {
      await expect(draft).toBeVisible()
      await expect(draft).toHaveValue('保留原问题草稿')
      await expect(page.getByTestId('answered-count')).toHaveText('0')
    }
    await expect(composer).toBeEditable()
    await expect(composer).toHaveValue('普通对话仍可继续')
    await expect(page.getByTestId('send-attempts')).toHaveText('0')
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`cancel-binding-${binding}.png`), fullPage: true })
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const cancelled of [true, false]) {
    test(`cancellation receipt reconciles a restored question only on success (${theme}, ${cancelled}, model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.emulateMedia({ colorScheme: theme })
      await page.goto('/e2e/fixtures/question-send-failure.html?ignoreRecovery')
      const composer = page.getByRole('textbox', { name: '普通对话草稿' })
      await composer.fill('普通对话仍可继续')
      const draft = page.getByTestId('request-user-input-custom-choice')
      await draft.fill('保留原问题草稿')
      await page.getByTestId('request-user-input-ignore-button').click()
      await expect(page.getByTestId('cancel-attempts')).toHaveText('1')
      await page.getByTestId('restore-in-flight').click()
      await expect(draft).toHaveValue('保留原问题草稿')
      await expect(page.getByTestId('answered-count')).toHaveText('0')
      await expect(composer).toBeEditable()
      await page.getByTestId(cancelled ? 'accept-next-send' : 'reject-cancellation').click()
      if (cancelled) {
        await expect(page.getByTestId('request-user-input-card')).toHaveCount(0)
        await expect(page.getByTestId('answered-count')).toHaveText('3')
      } else {
        await expect(draft).toBeVisible()
        await expect(draft).toHaveValue('保留原问题草稿')
        await expect(page.getByTestId('answered-count')).toHaveText('0')
      }
      await expect(page.getByTestId('send-attempts')).toHaveText('0')
      await expect(page.getByTestId('cancel-attempts')).toHaveText('1')
      await expect(composer).toHaveValue('普通对话仍可继续')
      expect(errors).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`ignore-recovery-${theme}-${cancelled}.png`), fullPage: true })
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`an answer receipt settles a question restored during its wait (${theme}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/e2e/fixtures/question-send-failure.html?answerRecovery')
    const composer = page.getByRole('textbox', { name: '普通对话草稿' })
    await composer.fill('普通对话仍可继续')
    const draft = page.getByTestId('request-user-input-custom-choice')
    await draft.fill('只回答原问题一次')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('send-attempts')).toHaveText('1')
    await page.getByTestId('restore-in-flight').click()
    await expect(draft).toHaveValue('只回答原问题一次')
    await expect(page.getByTestId('answered-count')).toHaveText('0')
    await expect(composer).toBeEditable()
    await page.getByTestId('accept-next-send').click()
    await expect(page.getByTestId('question-confirmed')).toBeVisible()
    await expect(page.getByTestId('request-user-input-card')).toHaveCount(0)
    await expect(page.getByTestId('answered-count')).toHaveText('3')
    await expect(page.getByTestId('send-attempts')).toHaveText('1')
    await expect(page.getByTestId('submitted-response')).toContainText('"itemId":"question-41"')
    await expect(composer).toHaveValue('普通对话仍可继续')
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`answer-recovery-${theme}.png`), fullPage: true })
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`partial question recovery preserves unconfirmed siblings and drafts (${theme}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/e2e/fixtures/question-send-failure.html?restoration=partial')
    const first = page.getByTestId('restored-a')
    const second = page.getByTestId('restored-b')
    const firstDraft = first.getByTestId('request-user-input-custom-choice')
    const secondDraft = second.getByTestId('request-user-input-custom-choice')
    await firstDraft.fill('保留第一题原草稿')
    await secondDraft.fill('保留第二题原草稿')
    const composer = page.getByRole('textbox', { name: '普通对话草稿' })
    await composer.fill('普通对话仍可继续')
    await page.getByTestId('confirm-second-question').click()
    await expect(first).toBeVisible()
    await expect(second).toBeVisible()
    await expect(firstDraft).toHaveValue('保留第一题原草稿')
    await expect(secondDraft).toHaveValue('保留第二题原草稿')
    await expect(composer).toBeEditable()
    await expect(composer).toHaveValue('普通对话仍可继续')
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`partial-recovery-${theme}.png`), fullPage: true })
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const id of ['implement', 'strategy']) {
    test(`ordinary question keeps all drafts and answers when a choice mentions a plan (${id}, ${theme}, model-independent)`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/e2e/fixtures/question-send-failure.html?nativePlanId=${id}`)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      const composer = page.getByRole('textbox', { name: '普通对话草稿' })
      await composer.fill('普通对话仍可继续')
      const draft = page.getByTestId('request-user-input-custom-scope')
      await draft.fill('Keep the original task and selected module')
      await page.getByTestId(`request-user-input-option-${id}-0`).click()
      await expect(page.getByTestId('send-attempts')).toHaveText('0')
      await expect(draft).toHaveValue('Keep the original task and selected module')
      await expect(composer).toBeEditable()
      await page.screenshot({ path: testInfo.outputPath('original-plan-like-question.png'), fullPage: true })
      await page.getByTestId('accept-next-send').click()
      await page.getByTestId('request-user-input-submit-button').click()
      await expect(page.getByTestId('question-confirmed')).toBeVisible()
      await expect(page.getByTestId('send-attempts')).toHaveText('1')
      await expect(page.getByTestId('submitted-response')).toHaveText(JSON.stringify({
        requestId: 41, itemId: 'question-41', answers: {
          [id]: { answers: ['执行此计划'] },
          scope: { answers: ['Keep the original task and selected module'] },
        },
      }))
      await expect(composer).toHaveValue('普通对话仍可继续')
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const difference of ['option', 'freeform']) {
    test(`reordered question recovery keeps the unanswered original draft (${difference}, ${theme}, model-independent)`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/e2e/fixtures/question-send-failure.html?restoration=${difference}`)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      const first = page.getByTestId('restored-a')
      const second = page.getByTestId('restored-b')
      await expect(second).toBeVisible()
      const draft = first.getByTestId('request-user-input-custom-choice')
      await draft.fill('保留第一题原草稿')
      const composer = page.getByRole('textbox', { name: '普通对话草稿' })
      await composer.fill('普通对话仍可继续')
      await page.getByTestId('confirm-second-question').click()
      await expect(second).toHaveCount(0)
      await expect(first).toBeVisible()
      await expect(draft).toHaveValue('保留第一题原草稿')
      await expect(composer).toBeEditable()
      await expect(composer).toHaveValue('普通对话仍可继续')
      await page.screenshot({ path: testInfo.outputPath('original-question-draft-retained.png'), fullPage: true })
    })
  }
}

test('a failed question send preserves its card and draft until a confirmed manual retry', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/question-send-failure.html')
  await expect(page.getByTestId('fixture-boundary')).toContainText('不连接 Gateway、Native 或模型')
  const composer = page.getByRole('textbox', { name: '普通对话草稿' })
  await composer.fill('普通输入保持可用')
  const answer = page.getByTestId('request-user-input-custom-choice')
  await answer.fill('请先检查资料，再整理草稿。')
  const submit = page.getByTestId('request-user-input-submit-button')
  await submit.click()
  await expect(page.getByTestId('send-attempts')).toHaveText('1')
  await expect(page.getByTestId('answered-count')).toHaveText('0')
  await expect(submit).toBeEnabled()
  await expect(answer).toHaveValue('请先检查资料，再整理草稿。')
  await expect(composer).toBeEditable()
  await expect(composer).toHaveValue('普通输入保持可用')
  await page.screenshot({ path: testInfo.outputPath('failed-question-still-answerable.png'), fullPage: true })
  await page.getByTestId('accept-next-send').click()
  await submit.click()
  await expect(page.getByTestId('question-confirmed')).toBeVisible()
  await expect(page.getByTestId('answered-count')).toHaveText('2')
  await expect(page.getByTestId('send-attempts')).toHaveText('2')
  await expect(composer).toHaveValue('普通输入保持可用')
})

for (const theme of ['light', 'dark'] as const) {
  for (const reused of ['request', 'item']) {
    test(`restoration aliases preserve drafts after ${reused} identity reuse (${theme}, model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/e2e/fixtures/question-send-failure.html?aliasReuse=${reused}`)
      const first = page.getByTestId('reused-question-0')
      const second = page.getByTestId('reused-question-1')
      const draft = first.getByTestId('request-user-input-custom-choice')
      await draft.fill('保留原问题草稿')
      const composer = page.getByRole('textbox', { name: '普通对话草稿' })
      await composer.fill('普通对话仍可继续')
      await page.getByTestId('confirm-partial').click()
      await expect(first).toBeVisible()
      await expect(second).toBeVisible()
      await expect(draft).toHaveValue('保留原问题草稿')
      await page.getByTestId('confirm-sibling').click()
      await expect(second).toHaveCount(0)
      await expect(first).toBeVisible()
      await expect(draft).toHaveValue('保留原问题草稿')
      await expect(composer).toBeEditable()
      await expect(composer).toHaveValue('普通对话仍可继续')
      await expect(page.getByTestId('send-attempts')).toHaveText('0')
      expect(errors).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`reused-${reused}-${theme}.png`), fullPage: true })
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`a stale parent card cannot answer its child's reused IDs (${theme}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/e2e/fixtures/question-send-failure.html?sourceRequired')
    const stale = page.getByTestId('stale-parent-question')
    const child = page.getByTestId('original-child-question')
    const composer = page.getByRole('textbox', { name: '普通对话草稿' })
    await composer.fill('普通对话仍可继续')
    const draft = stale.getByTestId('request-user-input-custom-choice')
    await draft.fill('Keep the old parent answer draft')
    await stale.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('source-answer-code')).toHaveText('source_agent_conflict')
    await expect(page.getByTestId('source-wire-count')).toHaveText('0')
    await expect(stale.getByTestId('request-user-input-submit-button')).toBeEnabled()
    await expect(draft).toHaveValue('Keep the old parent answer draft')
    await expect(child.getByTestId('request-user-input-submit-button')).toBeEnabled()
    await expect(composer).toBeEditable()
    await page.screenshot({ path: testInfo.outputPath(`source-conflict-draft-${theme}.png`), fullPage: true })
    await child.getByTestId('request-user-input-custom-choice').fill('Answer for the original child')
    await child.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('source-answer-code')).toHaveText('accepted')
    await expect(page.getByTestId('source-wire-count')).toHaveText('1')
    await expect(draft).toHaveValue('Keep the old parent answer draft')
    await expect(composer).toHaveValue('普通对话仍可继续')
    expect(errors).toEqual([])
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const kind of ['question', 'approval']) {
    test(`a peer's resolved ${kind} closes viewer input (${theme}, model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/e2e/fixtures/question-send-failure.html?peerResolved=${kind}`)
      await expect(page.getByTestId('request-user-input-card')).toBeVisible()
      const composer = page.getByRole('textbox', { name: '普通对话草稿' })
      await composer.fill('保留普通输入草稿')
      await page.getByTestId('peer-resolution').click()
      await expect(page.getByTestId('viewer-overlay-pending')).toHaveText('false')
      await expect(page.getByTestId('request-user-input-card')).toHaveCount(0)
      await expect(page.getByTestId('request-user-input-summary')).toBeVisible()
      await expect(composer).toHaveValue('保留普通输入草稿')
      await expect(composer).toBeEditable()
      await expect(page.getByTestId('viewer-wire-count')).toHaveText('0')
      expect(errors).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`viewer-${kind}-${theme}.png`), fullPage: true })
    })
  }
}
