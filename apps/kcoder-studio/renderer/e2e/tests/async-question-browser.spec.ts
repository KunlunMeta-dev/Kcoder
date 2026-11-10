import { expect, test } from '@playwright/test'

for (const field of ['accepted', 'duplicate']) {
  test(`malformed ${field} receipt keeps the original answer editable (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/e2e/fixtures/async-question-browser.html?freeform=1&malformedAnswerEnvelope=${field}`)
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('保留原任务普通输入')
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('保留原问题回答')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('async-question-submit-error')).toBeVisible()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
    await expect(draft).toHaveValue('保留原问题回答')
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    await page.getByTestId('async-question-refresh').click()
    await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    await expect(draft).toHaveValue('保留原问题回答')
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    await expect(composer).toHaveText('保留原任务普通输入')
    await expect(composer).toBeEditable()
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('malformed-answer-envelope.png'), animations: 'disabled' })
  })
}

test('mismatched accepted answer preserves the original draft (model-independent)', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/e2e/fixtures/async-question-browser.html?answerReceiptMismatch=1&freeform=1')
  const composer = page.getByTestId('chat-message-input')
  await composer.fill('普通对话草稿仍可编辑')
  await page.getByTestId('async-question-toggle').click()
  const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
  await draft.fill('保留原问题回答')
  await page.getByTestId('request-user-input-submit-button').click()
  await expect(page.getByTestId('async-question-submit-error')).toBeVisible()
  await expect(draft).toHaveValue('保留原问题回答')
  await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
  await page.getByTestId('async-question-refresh').click()
  await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
  await expect(draft).toHaveValue('保留原问题回答')
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
  await expect(composer).toHaveText('普通对话草稿仍可编辑')
  await expect(composer).toBeEditable()
  expect(errors).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('mismatched-answer-receipt.png'), animations: 'disabled' })
})

for (const [id, mode] of [
  ['__proto__', 'single'], ['constructor', 'single'],
  ['__proto__', 'multiple'], ['toString', 'text'],
] as const) {
  test(`prototype-named item ${id} remains answerable as ${mode} (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const query = new URLSearchParams({ itemId: id, multiSelect: mode === 'multiple' ? '1' : '0' })
    await page.goto(`/e2e/fixtures/async-question-browser.html?${query}`)
    const card = page.getByTestId('async-question-card-e2e-question-a')
    await expect(card).toHaveAttribute('data-status', 'pending')
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('问题出现后保留普通输入草稿')
    await page.getByTestId('async-question-toggle').click()
    await expect(page.getByTestId('request-user-input-submit-button')).toBeDisabled()
    if (mode === 'text')
      await page.getByTestId(`request-user-input-custom-${id}`).fill('原问题回答')
    else
      await page.getByTestId(`request-user-input-option-${id}-0`).click()
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(card).toHaveAttribute('data-status', 'answer_saved')
    // Keep arbitrary JSON keys intact across Playwright's object serializer.
    const requests = JSON.parse(await page.evaluate(() =>
      JSON.stringify(window.__asyncQuestionBrowserFixture.answerRequests))) as Array<Record<string, unknown>>
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      threadId: 'e2e-async-question-thread', questionId: 'e2e-question-a',
      answers: { [id]: mode === 'text'
        ? { selectedOptionIds: [], text: '原问题回答' }
        : { selectedOptionIds: ['e2e-option-a'] } },
    })
    await page.getByTestId('async-question-refresh').click()
    await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    await expect(card).toHaveAttribute('data-status', 'answer_saved')
    await expect(composer).toHaveText('问题出现后保留普通输入草稿')
    await expect(composer).toBeEditable()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('prototype-named-question.png'), animations: 'disabled' })
  })
}

declare global {
  interface Window {
    __asyncQuestionBrowserFixture: {
      answerRequests: Array<Record<string, unknown>>
      emitRecovery: (capability: boolean | 'error') => Promise<void>
      emitChanged: (revision?: number) => Promise<void>
      appendQuestion: () => Promise<void>
      listCalls: () => number
      completedListCalls: () => number
      capabilityCalls: () => number
      holdNextList: () => void
      releaseHeldList: () => void
      releaseCapabilityRetry: () => void
      rejectHeldAnswer: () => void
    }
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`authoritative saved answer replaces a lost receipt warning in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&lostAnswerReceipt=1`)
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('保留原任务普通输入草稿')
    await page.getByTestId('async-question-toggle').click()
    await page.getByTestId('request-user-input-option-e2e-item-a-1').click()
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute(
      'data-status',
      'answer_saved'
    )
    await expect(
      page.getByTestId('async-question-authoritative-answer-e2e-question-a')
    ).toContainText('直接生成草稿')
    await expect(page.getByTestId('async-question-submit-error')).toHaveCount(0)
    await expect(page.getByTestId('async-question-panel')).not.toContainText('回答尚未确认')
    await expect
      .poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls()))
      .toBe(2)
    expect(
      await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)
    ).toBe(1)
    await expect(composer).toHaveText('保留原任务普通输入草稿')
    await expect(composer).toBeEditable()
    await page.screenshot({
      path: testInfo.outputPath(`saved-answer-reconciled-${theme}.png`),
      animations: 'disabled',
    })
    await page.getByTestId('send-message-button').click()
    await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const initialList of ['empty', 'questions'] as const) {
    test(`initial ${initialList} question read has no empty panel in ${theme}`, async ({ page }) => {
      await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&initialList=${initialList}`)
      await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(1)
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())).toBe(0)

      const panel = page.getByTestId('async-question-panel')
      await expect(panel).toHaveCount(0)
      const composer = page.getByTestId('chat-message-input')
      await composer.fill('加载期间保留普通对话草稿')
      const before = await composer.boundingBox()
      expect(before).not.toBeNull()
      await page.evaluate(() => window.__asyncQuestionBrowserFixture.releaseHeldList())
      await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())).toBe(1)

      if (initialList === 'empty') {
        await expect(panel).toHaveCount(0)
        const after = await composer.boundingBox()
        expect(after).not.toBeNull()
        expect(Math.abs(after!.y - before!.y)).toBeLessThan(1)
      } else {
        await expect(panel).toBeVisible()
        await expect(page.getByTestId('async-question-toggle')).toHaveAttribute('aria-expanded', 'false')
      }
      await expect(composer).toHaveText('加载期间保留普通对话草稿')
      await expect(composer).toBeFocused()
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`async question card interaction remains nonblocking in ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}`)

    await expect(page.getByTestId('fixture-boundary')).toContainText(
      '受控 runtime fixture · 不连接 Gateway、Native 或模型'
    )
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute(
      'data-status',
      'pending'
    )
    await expect(page.getByTestId('fixture-turn-state')).toHaveText('idle')
    await expect(page.getByTestId('chat-message-input')).toBeEditable()
    await expect
      .poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls()))
      .toBe(1)

    const composer = page.getByTestId('chat-message-input')
    await composer.fill('普通对话草稿')
    await expect(page.getByTestId('async-question-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await page.getByTestId('async-question-toggle').click()
    const option = page.getByTestId('request-user-input-option-e2e-item-a-1')
    await option.click()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute(
      'data-status',
      'pending'
    )
    await expect(composer).toHaveText('普通对话草稿')

    await page.getByTestId('request-user-input-submit-button').click()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute(
      'data-status',
      'answer_saved'
    )
    const savedAnswer = page.getByTestId('async-question-authoritative-answer-e2e-question-a')
    await expect(savedAnswer).toContainText('直接生成草稿')
    await expect(page.getByTestId('fixture-turn-state')).toHaveText('idle')
    await expect(composer).toBeEditable()
    await expect(composer).toHaveText('普通对话草稿')

    const answerRequest = await page.evaluate(
      () => window.__asyncQuestionBrowserFixture.answerRequests[0]
    )
    expect(answerRequest).toMatchObject({
      questionId: 'e2e-question-a',
      expectedRevision: 1,
      answers: { 'e2e-item-a': { selectedOptionIds: ['e2e-option-b'] } },
    })
    expect(answerRequest.submissionId).toEqual(expect.any(String))

    await page.getByTestId('send-message-button').click()
    await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
    await expect(page.getByTestId('fixture-turn-state')).toHaveText('idle')
    await composer.fill('回答问题后仍能继续发送普通消息')
    await expect(composer).toBeEditable()
    await expect(composer).toHaveText('回答问题后仍能继续发送普通消息')

    await page.getByTestId('fixture-emit-changed').click()
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute(
      'data-status',
      'queued'
    )
    await expect(savedAnswer).toContainText('直接生成草稿')
    await expect
      .poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls()))
      .toBe(2)
    await expect(page.getByTestId('fixture-turn-state')).toHaveText('idle')

    await page.getByTestId('fixture-pane-width-normal').click()
    const pane = page.getByTestId('async-question-browser-pane')
    await expect(pane).toHaveAttribute('data-pane-width', '920')
    await page.screenshot({
      path: testInfo.outputPath(`async-question-${theme}-normal-pane.png`),
      fullPage: true,
      animations: 'disabled',
    })

    await page.getByTestId('fixture-pane-width-narrow').click()
    await expect(pane).toHaveAttribute('data-pane-width', '420')
    await expect
      .poll(() => pane.evaluate(element => element.scrollWidth <= element.clientWidth))
      .toBe(true)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`async-question-${theme}-narrow-pane.png`),
      fullPage: true,
      animations: 'disabled',
    })
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [
    { width: 1060, height: 912 },
    { width: 420, height: 800 },
  ]) {
    test(`long async questions preserve conversation space in ${theme} at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport)
      await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&long=1`)
      const panel = page.getByTestId('async-question-panel')
      const toggle = page.getByTestId('async-question-toggle')
      const body = page.getByTestId('async-question-content')
      const composer = page.getByTestId('chat-message-input')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(body).not.toBeVisible()
      expect((await panel.boundingBox())!.height).toBeLessThan(76)
      await composer.fill('先继续已经明确的工作')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      expect(
        await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)
      ).toBe(0)
      await page.screenshot({
        path: testInfo.outputPath('questions-collapsed.png'),
        animations: 'disabled',
      })

      await toggle.click()
      await expect(body).toBeVisible()
      expect((await body.boundingBox())!.height).toBeLessThanOrEqual(viewport.height * 0.32 + 1)
      expect(
        (await page.getByTestId('fixture-transcript').boundingBox())!.height
      ).toBeGreaterThanOrEqual(48)
      await expect(page.getByTestId('request-user-input-questions')).toHaveCSS(
        'overflow-y',
        'visible'
      )
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight))
        .toBe(true)
      await page.screenshot({
        path: testInfo.outputPath('questions-expanded.png'),
        animations: 'disabled',
      })

      const custom = page.getByTestId('request-user-input-custom-e2e-long-item-0')
      await custom.fill('稍后再决定的回答草稿')
      await page.getByTestId('request-user-input-ignore-button').click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle).toBeFocused()
      await toggle.click()
      await expect(custom).toHaveValue('稍后再决定的回答草稿')
      await custom.focus()
      await page.keyboard.press('Escape')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await composer.fill('问题还没回答，我仍然可以继续发消息')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('2')
      expect(
        await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)
      ).toBe(0)
    })
  }
}

test('an older list response cannot reopen the answered card', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 420, height: 800 })
  await page.goto('/e2e/fixtures/async-question-browser.html?theme=light')
  const card = page.getByTestId('async-question-card-e2e-question-a')
  await expect(card).toHaveAttribute('data-status', 'pending')
  const composer = page.getByTestId('chat-message-input')
  await composer.fill('刷新期间保留普通输入草稿')
  await page.getByTestId('async-question-toggle').click()
  await page.evaluate(() => window.__asyncQuestionBrowserFixture.holdNextList())
  await page.getByTestId('async-question-refresh').click()
  await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(2)
  await page.getByTestId('request-user-input-option-e2e-item-a-1').click()
  await page.getByTestId('request-user-input-submit-button').click()
  await expect(card).toHaveAttribute('data-status', 'answer_saved')
  await page.evaluate(() => window.__asyncQuestionBrowserFixture.releaseHeldList())
  await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
  await expect(card).toHaveAttribute('data-status', 'answer_saved')
  await expect(page.getByTestId('request-user-input-submit-button')).toHaveCount(0)
  await expect(composer).toBeEditable()
  await expect(composer).toHaveText('刷新期间保留普通输入草稿')
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('answer-survives-late-list.png'), fullPage: true })
})

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1100, 420]) {
    test(`unified composer preserves drafts and question scrolling in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 960 })
      await page.goto(`/e2e/fixtures/async-question-browser.html?statusRegion=1&long=1&theme=${theme}`)
      const region = page.getByTestId('composer-status-region')
      const questions = page.locator('[data-status-item="questions"] button')
      const plan = page.locator('[data-status-item="plan"] button')
      const goal = page.locator('[data-status-item="goal"] button')
      const queue = page.locator('[data-status-item="queue"] button')
      const composer = page.getByTestId('chat-message-input')
      await expect(region).toHaveCount(1)
      await expect(questions).toHaveAttribute('aria-expanded', 'false')
      await expect(plan).toHaveAttribute('aria-expanded', 'false')
      await expect(goal).toBeVisible()
      await expect(goal).toContainText('修复会话恢复并补充回归测试')
      await expect(queue).toBeVisible()
      expect(await composer.evaluate(element => Boolean(element.closest('[data-testid="composer-status-region"]')))).toBe(false)
      await composer.fill('展开任务状态时保留普通草稿')
      await page.screenshot({ path: testInfo.outputPath('status-summary.png'), animations: 'disabled' })

      await questions.click()
      const body = page.getByTestId('composer-status-content-questions')
      const draft = page.getByTestId('request-user-input-custom-e2e-long-item-0')
      await expect(body).toBeVisible()
      await draft.fill('第一批问题的未提交答案')
      await expect(page.getByTestId('request-user-input-questions')).toHaveCSS('overflow-y', 'visible')
      await expect.poll(() => body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
      expect((await body.boundingBox())!.height).toBeLessThanOrEqual(960 * 0.32 + 1)
      const savedScroll = await body.evaluate(element => {
        element.scrollTop = 180
        element.setAttribute('data-fixture-retained', 'true')
        return element.scrollTop
      })
      expect(savedScroll).toBeGreaterThan(0)
      const actionBounds = (await page.getByTestId('request-user-input-actions').boundingBox())!
      const bodyBounds = (await body.boundingBox())!
      expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(bodyBounds.y + bodyBounds.height + 1)
      expect(actionBounds.y).toBeGreaterThanOrEqual(bodyBounds.y)
      await page.screenshot({ path: testInfo.outputPath('status-questions.png'), animations: 'disabled' })
      await plan.click()
      await expect(body).not.toBeVisible()
      await expect(page.getByTestId('runtime-plan-detail')).toBeVisible()
      await expect(composer).toHaveText('展开任务状态时保留普通草稿')
      await questions.click()
      await expect(draft).toHaveValue('第一批问题的未提交答案')
      await expect(body).toHaveAttribute('data-fixture-retained', 'true')
      expect(await body.evaluate(element => element.scrollTop)).toBe(savedScroll)

      await page.evaluate(() => window.__asyncQuestionBrowserFixture.appendQuestion())
      await expect(page.getByTestId('async-question-card-e2e-question-next-1')).toHaveCount(1)
      await expect(questions).toHaveAttribute('aria-expanded', 'true')
      await expect(draft).toHaveValue('第一批问题的未提交答案')
      expect(await body.evaluate(element => element.scrollTop)).toBe(savedScroll)
      await expect(composer).toHaveText('展开任务状态时保留普通草稿')
      await body.press('Escape')
      await expect(questions).toHaveAttribute('aria-expanded', 'false')
      await expect(questions).toBeFocused()

      await region.getByRole('button', { name: '收起状态行', exact: true }).click()
      await expect(region).toContainText('待回答问题')
      await expect(region).toContainText('待发送队列')
      await expect(body).not.toBeVisible()
      await region.getByRole('button', { name: /^展开状态详情/ }).click()
      await questions.click()
      await expect(draft).toHaveValue('第一批问题的未提交答案')
      await goal.click()
      await page.getByTestId('pause-goal-button').click()
      await expect(goal).toContainText('已暂停')
      await expect(page.getByTestId('resume-goal-button')).toBeVisible()
      await queue.click()
      await page.getByTestId('queue-cancel-button-e2e-status-queue').click()
      await expect(queue).toHaveCount(0)
      await expect(composer).toHaveText('展开任务状态时保留普通草稿')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await page.getByTestId('fixture-transcript').boundingBox())!.height).toBeGreaterThanOrEqual(48)
    })
  }
}

test('ordinary tasks show no unified status placeholder and errors stay outside folding', async ({ page }) => {
  await page.goto('/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=normal')
  await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())).toBe(1)
  await expect(page.getByTestId('composer-status-region')).toHaveCount(0)
  await page.getByTestId('chat-message-input').fill('普通会话可以直接输入')
  await page.getByTestId('send-message-button').click()
  await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')

  await page.goto('/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=error')
  const error = page.getByTestId('chat-input-error')
  await expect(error).toContainText('草稿已保留')
  await expect(page.getByTestId('composer-status-region')).toHaveCount(1)
  await page.getByRole('button', { name: '收起状态行', exact: true }).click()
  await expect(error).toBeVisible()
  expect(await error.evaluate(element => Boolean(element.closest('[data-testid="composer-status-region"]')))).toBe(false)
})

test('new question batches retain the answered receipt and route a second explicit answer', async ({ page }) => {
  await page.goto('/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=questions')
  const trigger = page.locator('[data-status-item="questions"] button')
  await trigger.click()
  await page.getByTestId('request-user-input-option-e2e-item-a-1').click()
  await page.getByTestId('request-user-input-submit-button').click()
  await expect(page.getByTestId('async-question-authoritative-answer-e2e-question-a')).toContainText('直接生成草稿')
  await trigger.click()
  await page.evaluate(() => window.__asyncQuestionBrowserFixture.appendQuestion())
  await expect(page.getByTestId('async-question-card-e2e-question-next-1')).toHaveCount(1)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  await expect(page.getByTestId('async-question-authoritative-answer-e2e-question-a')).toContainText('直接生成草稿')
  await page.getByTestId('request-user-input-option-e2e-next-item-1-1').click()
  await page.getByTestId('request-user-input-submit-button').click()
  await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(2)
  const answers = await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)
  expect(answers[0].questionId).toBe('e2e-question-a')
  expect(answers[1]).toMatchObject({ questionId: 'e2e-question-next-1', expectedRevision: 1,
    answers: { 'e2e-next-item-1': { selectedOptionIds: ['e2e-next-dark-1'] } } })
  expect(answers[0].submissionId).not.toBe(answers[1].submissionId)
})

test('synchronous permission cards remain visible while unified status is collapsed', async ({ page }) => {
  await page.goto('/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=approval')
  const card = page.getByTestId('request-user-input-card').filter({ hasText: '允许本次执行测试命令' })
  await expect(card).toBeVisible()
  await expect(page.getByTestId('chat-message-input')).toHaveCount(0)
  await page.getByRole('button', { name: '收起状态行', exact: true }).click()
  await expect(card).toBeVisible()
  await card.getByTestId('request-user-input-option-approval-choice-1').click()
  await card.getByTestId('request-user-input-submit-button').click()
  await expect(page.getByTestId('chat-message-input')).toBeEditable()
})

test('creating tasks defer question reads until task registration completes', async ({ page }) => {
  await page.goto('/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=creating')
  const composer = page.getByTestId('chat-message-input')
  await composer.fill('新建期间保留草稿')
  await expect(page.getByTestId('composer-status-region')).toHaveCount(0)
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.capabilityCalls())).toBe(0)
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(0)
  await page.getByTestId('fixture-complete-creation').click()
  await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())).toBe(1)
  await expect(page.getByTestId('composer-status-region')).toHaveCount(0)
  await expect(composer).toHaveText('新建期间保留草稿')
})

test('an unsupported question capability needs no thread identity or error placeholder', async ({ page }) => {
  await page.goto('/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=unsupported')
  await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.capabilityCalls())).toBe(1)
  await page.getByTestId('chat-message-input').fill('旧目标正常输入')
  await expect(page.getByTestId('composer-status-region')).toHaveCount(0)
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(0)
})

for (const phase of ['initial-error', 'list-error']) {
  test(`a first ${phase} does not claim that unanswered questions exist`, async ({ page }) => {
    await page.goto(`/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=${phase}`)
    const trigger = page.locator('[data-status-item="questions"] button')
    await expect(trigger).toBeVisible()
    await expect(trigger).not.toContainText('待回答问题')
    await expect(trigger).not.toContainText('刷新失败')
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('读取失败也不能丢掉草稿')
    await trigger.click()
    await page.getByTestId('async-question-refresh').click()
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())).toBe(1)
    await expect(page.getByTestId('composer-status-region')).toHaveCount(0)
    await expect(composer).toHaveText('读取失败也不能丢掉草稿')
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
  })
}

for (const revisit of [false, true]) {
  test(`delayed capability retry preserves ${revisit ? 'revisited' : 'different'} task cards (model-independent)`, async ({ page }, testInfo) => {
    await page.goto('/e2e/fixtures/async-question-browser.html?retryRace=1')
    await expect(page.getByTestId('async-question-summary')).toContainText('暂无法读取提问状态')
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('切换任务时保留普通草稿')
    await page.getByTestId('async-question-refresh').click()
    await expect(page.getByTestId('async-question-panel')).toHaveCount(0)
    await page.getByTestId('fixture-task-b').click()
    await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    if (revisit) {
      await page.getByTestId('fixture-task-a').click()
      await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    }
    await page.evaluate(() => window.__asyncQuestionBrowserFixture.releaseCapabilityRetry())
    const panel = page.getByTestId('async-question-panel')
    await expect(panel).toHaveAttribute('data-task-id', `e2e-async-question:task-${revisit ? 'a' : 'b'}`)
    await expect(page.getByTestId('async-question-summary')).not.toContainText(/刷新失败|暂无法读取提问状态/)
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
    const reads = await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())
    await page.getByTestId('async-question-refresh').click()
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(reads + 1)
    await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    await expect(composer).toBeEditable()
    await expect(composer).toHaveText('切换任务时保留普通草稿')
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('retry-owner-restored.png'), animations: 'disabled' })
  })
}

test('a delayed answer failure after task unmount cannot refresh the old task', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/async-question-browser.html?answerRace=1')
  await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
  const composer = page.getByTestId('chat-message-input')
  await composer.fill('原任务答题请求断线后保留普通草稿')
  await page.getByTestId('async-question-toggle').click()
  await page.getByTestId('request-user-input-option-e2e-item-a-1').click()
  await page.getByTestId('request-user-input-submit-button').click()
  await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
  await page.getByTestId('fixture-task-b').click()
  await expect(page.getByTestId('async-question-panel')).toHaveAttribute('data-task-id', 'e2e-async-question:task-b')
  await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(2)
  await page.evaluate(() => window.__asyncQuestionBrowserFixture.rejectHeldAnswer())
  await composer.fill('断线后仍能继续普通输入')
  await expect(composer).toHaveText('断线后仍能继续普通输入')
  await expect(page.getByTestId('async-question-summary')).not.toContainText('刷新失败')
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(2)
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
  await page.getByTestId('async-question-refresh').click()
  await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(3)
  await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('old-answer-failure-after-unmount.png'), animations: 'disabled' })
})

test('notification bursts keep one list read in flight and leave ordinary input usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 420, height: 800 })
  await page.goto('/e2e/fixtures/async-question-browser.html?theme=light')
  const card = page.getByTestId('async-question-card-e2e-question-a')
  await expect(card).toHaveAttribute('data-status', 'pending')
  await page.getByTestId('async-question-toggle').click()
  const answerDraft = page.getByTestId('request-user-input-custom-e2e-item-a')
  await answerDraft.fill('保留问题草稿')
  await page.evaluate(() => window.__asyncQuestionBrowserFixture.holdNextList())
  await page.getByTestId('async-question-refresh').click()
  await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(2)
  await page.evaluate(async () => {
    const bridgePath = '/src/kcoder/gatewayServiceBridge.ts'
    const { emitRuntimeEvent } = await import(/* @vite-ignore */ bridgePath)
    await Promise.all(Array.from({ length: 130 }, () => emitRuntimeEvent('local-executor:event', {
      event: 'async-question:changed', payload: {
        taskId: 'e2e-async-question:task-a', serverId: 'e2e-async-question-target',
        threadId: 'e2e-async-question-thread', questionId: 'e2e-question-a', revision: 1,
      },
    })))
  })
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(2)
  const composer = page.getByTestId('chat-message-input')
  await composer.fill('刷新期间正常发送')
  await page.getByTestId('send-message-button').click()
  await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
  await expect(answerDraft).toHaveValue('保留问题草稿')
  await page.evaluate(() => window.__asyncQuestionBrowserFixture.releaseHeldList())
  await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.completedListCalls())).toBe(3)
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(3)
  await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
  await expect(card).toHaveAttribute('data-status', 'pending')
  await expect(answerDraft).toHaveValue('保留问题草稿')
  expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('question-burst-preserves-input.png'), fullPage: true })
})

for (const theme of ['light', 'dark'] as const) {
  test(`older question notifications preserve the current draft and refresh state in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&olderNotifications=1`)
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'pending')
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('保留当前问题的回答草稿')
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('普通输入仍可发送')
    const before = await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())
    await page.evaluate(async () => {
      for (let index = 0; index < 20; index += 1)
        await window.__asyncQuestionBrowserFixture.emitChanged(1)
    })
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(before)
    await expect(draft).toHaveValue('保留当前问题的回答草稿')
    await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
    await page.getByTestId('send-message-button').click()
    await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath(`older-notification-${theme}.png`), animations: 'disabled' })
    await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitChanged())
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(before + 1)
    await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveAttribute('data-status', 'queued')
  })
}

test('free text equal to an option ID stays text (model-independent)', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/async-question-browser.html')
  const card = page.getByTestId('async-question-card-e2e-question-a')
  await expect(card).toHaveAttribute('data-status', 'pending')
  await page.getByTestId('async-question-toggle').click()
  await page.getByTestId('request-user-input-custom-e2e-item-a').fill('e2e-option-a')
  await page.getByTestId('request-user-input-submit-button').click()
  await expect(card).toHaveAttribute('data-status', 'answer_saved')
  const answers = await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)
  expect(answers).toHaveLength(1)
  expect(answers[0].answers).toEqual({ 'e2e-item-a': {
    selectedOptionIds: [], text: 'e2e-option-a',
  } })
  await expect(page.getByTestId('async-question-authoritative-answer-e2e-question-a'))
    .toContainText('e2e-option-a')
  await page.getByTestId('async-question-refresh').click()
  await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
  await expect(card).toHaveAttribute('data-status', 'answer_saved')
  await expect(page.getByTestId('async-question-authoritative-answer-e2e-question-a'))
    .toContainText('e2e-option-a')
  const composer = page.getByTestId('chat-message-input')
  await composer.fill('普通输入仍然可用')
  await expect(composer).toHaveText('普通输入仍然可用')
  await page.screenshot({ path: testInfo.outputPath('free-text-option-id.png'), animations: 'disabled' })
})

for (const theme of ['light', 'dark'] as const) {
  test(`recovery renegotiates questions and preserves drafts in ${theme} (model-independent)`, async ({ page }, testInfo) => {
    await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}`)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('保留原任务输入')
    await page.getByTestId('async-question-toggle').click()
    const answer = page.getByTestId('request-user-input-custom-e2e-item-a')
    await answer.fill('保留未发送的回答')
    const initialLists = await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())
    await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitRecovery('error'))
    await expect(page.getByTestId('async-question-retry')).toBeEnabled()
    await expect(answer).toHaveValue('保留未发送的回答')
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(initialLists)
    await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitRecovery(true))
    await expect(page.getByTestId('async-question-retry')).toHaveCount(0)
    await expect(answer).toHaveValue('保留未发送的回答')
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(initialLists + 1)
    await page.screenshot({ path: testInfo.outputPath(`recovered-draft-${theme}.png`), animations: 'disabled' })
    await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitRecovery(false))
    await expect(page.getByTestId('async-question-panel')).toHaveCount(0)
    await page.evaluate(() => window.__asyncQuestionBrowserFixture.emitChanged(2))
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.listCalls())).toBe(initialLists + 1)
    await expect(composer).toHaveText('保留原任务输入')
    await expect(composer).toBeEditable()
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.capabilityCalls())).toBe(4)
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests)).toEqual([])
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`recovery-capability-${theme}.png`), animations: 'disabled' })
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: duplicate question identities reject the snapshot and preserve the draft (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 420, height: 900 })
    await page.goto(`/e2e/fixtures/async-question-browser.html?theme=${theme}&freeform`)
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('保留唯一原问题的草稿')
    // Exercise the common Native/legacy-Gateway presentation boundary: both
    // records satisfy the wire schema but cannot own the same question card.
    await page.evaluate(async () => {
      const localPath = '/src/host/localExecutor.ts'
      const transportPath = '/src/lib/runtime-transport.ts'
      const { requestLocalExecutor } = await import(/* @vite-ignore */ localPath)
      const { runtimeTransport } = await import(/* @vite-ignore */ transportPath)
      const list = await requestLocalExecutor('runtime.asyncQuestion.request', {
        taskId: 'e2e-async-question:task-a', method: 'asyncQuestion/list',
        params: { threadId: 'e2e-async-question-thread', includeTerminal: true },
      })
      const transport = runtimeTransport()
      const original = transport.handler
      window.__restoreDuplicateQuestionProbe = () => { transport.handler = original }
      transport.handler = (command: string, raw: unknown) => {
        const args = raw as { method: string; params: { method: string } }
        if (command === 'local_executor_request' && args.method === 'runtime.asyncQuestion.request' &&
            args.params.method === 'asyncQuestion/list') return {
          ...list, questions: [list.questions[0], { ...list.questions[0], requestId: 'conflicting-request',
            questions: [{ ...list.questions[0].questions[0], question: '不应替换原卡片的问题' }] }],
        }
        return original(command, raw)
      }
    })
    try {
      await page.getByTestId('async-question-refresh').click()
      await expect(page.getByTestId('async-question-retry')).toBeEnabled()
      await expect(page.getByTestId('async-question-card-e2e-question-a')).toHaveCount(1)
      await expect(draft).toHaveValue('保留唯一原问题的草稿')
      await expect(page.getByTestId('request-user-input-submit-button')).toBeDisabled()
      await page.getByTestId('chat-message-input').fill('读取失败期间继续普通工作')
      await page.getByTestId('send-message-button').click()
      await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
      expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(0)
      await page.screenshot({ path: testInfo.outputPath('duplicate-question-preserved-draft.png'), animations: 'disabled' })
    } finally {
      await page.evaluate(() => window.__restoreDuplicateQuestionProbe())
    }
    await page.getByTestId('async-question-retry').click()
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    await expect(draft).toHaveValue('保留唯一原问题的草稿')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect.poll(() => page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    expect(errors).toEqual([])
  })
}

declare global {
  interface Window {
    __restoreDuplicateQuestionProbe: () => void
  }
}

for (const answerTurn of ['legacy', 'foreign', 'alias', 'empty', 'blank'] as const) {
  test(`${answerTurn}: answer turn receipt preserves the original task (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 420, height: 900 })
    await page.goto(`/e2e/fixtures/async-question-browser.html?freeform&answerTurn=${answerTurn}`)
    await page.getByTestId('async-question-toggle').click()
    const draft = page.getByTestId('request-user-input-custom-e2e-item-a')
    await draft.fill('保留原任务回答')
    await page.getByTestId('request-user-input-submit-button').click()
    const card = page.getByTestId('async-question-card-e2e-question-a')
    if (answerTurn === 'legacy') {
      await expect(card).toHaveAttribute('data-status', 'answer_saved')
      await expect(page.getByTestId('async-question-submit-error')).toHaveCount(0)
      await expect(draft).toHaveCount(0)
      await page.getByTestId('async-question-refresh').click()
      await expect(page.getByTestId('async-question-refresh')).toBeEnabled()
      await expect(card).toHaveAttribute('data-status', 'answer_saved')
    } else {
      await expect(page.getByTestId('async-question-submit-error')).toBeVisible()
      await expect(card).toHaveAttribute('data-status', 'pending')
      await expect(draft).toHaveValue('保留原任务回答')
    }
    const composer = page.getByTestId('chat-message-input')
    await composer.fill('普通任务继续工作')
    await page.getByTestId('send-message-button').click()
    await expect(page.getByTestId('fixture-ordinary-send-count')).toHaveText('1')
    expect(await page.evaluate(() => window.__asyncQuestionBrowserFixture.answerRequests.length)).toBe(1)
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`answer-turn-${answerTurn}.png`), animations: 'disabled' })
  })
}
