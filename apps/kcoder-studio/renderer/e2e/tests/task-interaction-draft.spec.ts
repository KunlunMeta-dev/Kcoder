import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    taskInteractionDraftProbe: {
      nextRead: 'ready' | 'hold' | 'fail'
      readCalls: number
      heldReadCount: number
      responses: unknown[]
      rejectResponse(): void
      setWorkspacePath(workspacePath: string): void
      release(): void
    }
  }
}

for (const theme of ['light', 'dark']) {
  test(`a rejected original answer reopens only after receipt readback (${theme}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/servers', route => route.fulfill({ json: { servers: [{
      id: 'fixture-target', transport: 'local', runtime: 'kcoder', workspacePath: '/owned',
    }] } }))
    await page.goto(`/e2e/fixtures/task-interaction-draft.html?theme=${theme}`)
    const card = page.getByTestId('request-user-input-card')
    const refresh = page.getByRole('button', { name: 'Read current receipts', exact: true })
    await page.getByTestId('request-user-input-custom-choice').fill('Keep the rejected original draft')
    await page.getByTestId('request-user-input-option-choice-1').click()
    await page.getByTestId('request-user-input-submit-button').click()
    await expect(card).toBeHidden()
    const reads = await page.evaluate(() => window.taskInteractionDraftProbe.readCalls)
    await refresh.click()
    await expect.poll(() => page.evaluate(() => window.taskInteractionDraftProbe.readCalls)).toBeGreaterThan(reads)
    await expect(card).toBeHidden()
    await page.evaluate(() => window.taskInteractionDraftProbe.rejectResponse())
    await refresh.click()
    await expect(card).toBeVisible()
    await expect(page.getByTestId('request-user-input-option-choice-1')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep the rejected original draft')
    expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(1)
    await page.screenshot({ path: testInfo.outputPath(`rejected-answer-recovered-${theme}.png`), fullPage: true })
    await page.getByTestId('request-user-input-submit-button').click()
    await expect.poll(() => page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(2)
    expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses[1])).toMatchObject({
      reference: { selector: { threadId: 'thread', turnId: 'turn', questionId: 'question' } },
      answers: { choice: { answers: ['Second source', 'Keep the rejected original draft'] } },
    })
    expect(errors).toEqual([])
  })

  test(`dismissed original question reopens with its draft on refresh (${theme}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/servers', route => route.fulfill({ json: { servers: [{
      id: 'fixture-target', transport: 'local', runtime: 'kcoder', workspacePath: '/owned',
    }] } }))
    await page.goto(`/e2e/fixtures/task-interaction-draft.html?theme=${theme}`)
    const card = page.getByTestId('request-user-input-card')
    const text = page.getByTestId('request-user-input-custom-choice')
    await text.fill('Keep this dismissed original draft')
    await page.getByTestId('request-user-input-option-choice-1').click()
    await page.getByTestId('request-user-input-ignore-button').click()
    await expect(card).toBeHidden()
    await expect(page.getByTestId('request-user-input-summary')).toBeVisible()
    const reads = await page.evaluate(() => window.taskInteractionDraftProbe.readCalls)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(() => page.evaluate(() => window.taskInteractionDraftProbe.readCalls)).toBeGreaterThan(reads)
    await expect(card).toBeHidden()
    await page.getByRole('button', { name: 'Read current receipts', exact: true }).click()
    await expect(card).toBeVisible()
    await expect(text).toHaveValue('Keep this dismissed original draft')
    await expect(page.getByTestId('request-user-input-option-choice-1')).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath(`dismissed-draft-recovered-${theme}.png`), fullPage: true })
    await page.getByTestId('request-user-input-submit-button').click()
    await expect.poll(() => page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(1)
    expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses[0])).toMatchObject({
      reference: { selector: { threadId: 'thread', turnId: 'turn', questionId: 'question' } },
      answers: { choice: { answers: ['Second source', 'Keep this dismissed original draft'] } },
    })
    expect(errors).toEqual([])
  })

  for (const id of ['implement', 'strategy']) {
    test(`original plan-like choice ${id} preserves every question (${theme}, model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/api/servers', route => route.fulfill({ json: { servers: [{
        id: 'fixture-target', transport: 'local', runtime: 'kcoder', workspacePath: '/owned',
      }] } }))
      await page.goto(`/e2e/fixtures/task-interaction-draft.html?theme=${theme}&planChoiceId=${id}`)
      await page.getByText('执行此计划', { exact: true }).click()
      expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(0)
      await page.getByText('Selected module', { exact: true }).click()
      expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(0)
      await page.screenshot({ path: testInfo.outputPath(`original-plan-choice-${id}-${theme}.png`), fullPage: true })
      await page.getByTestId('request-user-input-submit-button').click()
      await expect.poll(() => page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(1)
      expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses[0])).toEqual({
        reference: { attemptId: 'attempt', selector: {
          serverId: 'process', threadId: 'thread', turnId: 'turn', requestId: 2000001,
          appServerEpoch: 'epoch', kind: 'question', questionId: 'question',
        } },
        answers: { [id]: { answers: ['执行此计划'] }, scope: { answers: ['Selected module'] } },
      })
      expect(errors).toEqual([])
    })
  }

  test(`original item identities keep independent answers (${theme}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/servers', route => route.fulfill({ json: { servers: [{
      id: 'fixture-target', transport: 'local', runtime: 'kcoder', workspacePath: '/owned',
    }] } }))
    await page.goto(`/e2e/fixtures/task-interaction-draft.html?theme=${theme}&exactItemIds`)
    const first = page.getByTestId('request-user-input-custom-choice')
    const second = page.getByTestId('request-user-input-custom- choice\u00a0')
    await first.fill('Answer for the first original item')
    await expect(second).toHaveValue('')
    // Ordinary parent questions allow partial answers, without auto-submission.
    await expect(page.getByTestId('request-user-input-submit-button')).toBeEnabled()
    expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(0)
    await second.fill('Answer for the second original item')
    await expect(first).toHaveValue('Answer for the first original item')
    await page.screenshot({ path: testInfo.outputPath(`exact-original-items-${theme}.png`), fullPage: true })
    await page.getByTestId('request-user-input-submit-button').click()
    await expect.poll(() => page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(1)
    expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses[0])).toMatchObject({
      reference: { selector: { threadId: 'thread', turnId: 'turn', questionId: 'question' } },
      answers: {
        choice: { answers: ['Answer for the first original item'] },
        ' choice\u00a0': { answers: ['Answer for the second original item'] },
      },
    })
    expect(errors).toEqual([])
  })

  test(`original question draft survives receipt refresh and failure (${theme}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/servers', route => route.fulfill({ json: { servers: [{
      id: 'fixture-target', transport: 'local', runtime: 'kcoder', workspacePath: '/owned',
    }] } }))
    await page.goto(`/e2e/fixtures/task-interaction-draft.html?theme=${theme}`)
    const card = page.getByTestId('request-user-input-card')
    await expect(card).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.getByTestId('request-user-input-option-choice-1').click()
    const text = page.getByTestId('request-user-input-custom-choice')
    await text.fill('Keep this unsent original draft')
    await page.evaluate(() => window.taskInteractionDraftProbe.setWorkspacePath('/owned/'))
    await expect(text).toHaveValue('Keep this unsent original draft')
    await expect(page.getByTestId('request-user-input-option-choice-1')).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => { window.taskInteractionDraftProbe.nextRead = 'hold' })
    await page.getByRole('button', { name: 'Read current receipts', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.taskInteractionDraftProbe.heldReadCount)).toBeGreaterThan(0)
    await expect(text).toHaveValue('Keep this unsent original draft')
    await expect(page.getByTestId('request-user-input-option-choice-1')).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => window.taskInteractionDraftProbe.release())
    await page.evaluate(() => {
      window.taskInteractionDraftProbe.nextRead = 'fail'
      window.dispatchEvent(new Event('online'))
    })
    await expect(page.getByText('The original interaction connection is unavailable. Open the original task to inspect it.')).toBeVisible()
    await expect(text).toHaveValue('Keep this unsent original draft')
    await expect(text).toBeDisabled()
    await expect(page.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath(`draft-retained-after-read-failure-${theme}.png`), fullPage: true })
    await page.evaluate(() => { window.taskInteractionDraftProbe.nextRead = 'ready' })
    await page.getByRole('button', { name: 'Read current receipts', exact: true }).click()
    await expect(text).toBeEnabled()
    await expect(text).toHaveValue('Keep this unsent original draft')
    await page.getByTestId('request-user-input-submit-button').click()
    await expect.poll(() => page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(1)
    expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses[0])).toMatchObject({
      reference: { attemptId: 'attempt', selector: { threadId: 'thread', turnId: 'turn',
        requestId: 2000001, appServerEpoch: 'epoch', questionId: 'question' } },
      answers: { choice: { answers: ['Second source', 'Keep this unsent original draft'] } },
    })
    expect(errors).toEqual([])
  })
}

for (const theme of ['light', 'dark']) {
  test(`original option labels remain distinct through task-space answers (${theme}, model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/servers', route => route.fulfill({ json: { servers: [{
      id: 'fixture-target', transport: 'local', runtime: 'kcoder', workspacePath: '/owned',
    }] } }))
    await page.goto(`/e2e/fixtures/task-interaction-draft.html?theme=${theme}&exactLabels`)
    const first = page.getByTestId('request-user-input-option-choice-0')
    const second = page.getByTestId('request-user-input-option-choice-1')
    await first.click()
    await expect(second).toHaveAttribute('aria-pressed', 'false')
    await second.click()
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: testInfo.outputPath(`exact-original-choices-${theme}.png`), fullPage: true })
    await page.getByTestId('request-user-input-submit-button').click()
    await expect.poll(() => page.evaluate(() => window.taskInteractionDraftProbe.responses.length)).toBe(1)
    expect(await page.evaluate(() => window.taskInteractionDraftProbe.responses[0])).toMatchObject({
      reference: { attemptId: 'attempt', selector: { threadId: 'thread', turnId: 'turn',
        requestId: 2000001, appServerEpoch: 'epoch', questionId: 'question' } },
      answers: { choice: { answers: ['First source', '\t First source \u00a0'] } },
    })
    expect(errors).toEqual([])
  })
}
