import { expect, test, type Page } from '@playwright/test'

async function rowOrder(page: Page) {
  return page.getByTestId('composer-status-row').locator('[data-status-item]')
    .evaluateAll(items => items.map(item => (item as HTMLElement).dataset.statusItem))
}

async function panelOrder(page: Page) {
  return page.getByTestId('composer-status-details').locator('[data-status-panel]:visible')
    .evaluateAll(items => items.map(item => (item as HTMLElement).dataset.statusPanel))
}

for (const theme of ['light', 'dark']) {
  test(`status cards follow opening order and retain arrival order across updates (${theme}, model-independent)`, async ({ page }) => {
    await page.goto(`/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=lifecycle&theme=${theme}`)
    const ids = ['questions', 'plan', 'computer-use', 'goal', 'queue']
    for (const id of ids) await expect(page.getByTestId(`composer-status-trigger-${id}`)).toBeVisible()
    const arrivals = await rowOrder(page)
    for (const id of arrivals) {
      const trigger = page.getByTestId(`composer-status-trigger-${id}`)
      if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
    }
    const opened: string[] = []
    for (const id of ['queue', 'questions', 'goal', 'plan', 'computer-use']) {
      await page.getByTestId(`composer-status-trigger-${id}`).click()
      opened.push(id)
      await expect.poll(() => panelOrder(page)).toEqual([...opened].reverse())
      expect(await rowOrder(page)).toEqual(arrivals)
      const tops = await page.locator('[data-status-panel]:visible').evaluateAll(items =>
        items.map(item => item.getBoundingClientRect().top))
      expect(tops).toEqual([...tops].sort((left, right) => left - right))
    }
    await page.getByTestId('fixture-desktop-unknown').click()
    await expect(page.getByTestId('computer-use-status')).toHaveAttribute('data-state', 'unknown')
    expect(await rowOrder(page)).toEqual(arrivals)
    expect(await panelOrder(page)).toEqual([...opened].reverse())
    const details = page.getByTestId('composer-status-details')
    const readingPosition = await details.evaluate(element => {
      element.scrollTop = 90
      return element.scrollTop
    })
    expect(readingPosition).toBeGreaterThan(0)
    await page.getByTestId('fixture-desktop-failed').evaluate(element => (element as HTMLButtonElement).click())
    await expect(page.getByTestId('computer-use-status')).toHaveAttribute('data-state', 'stop_failed')
    expect(await details.evaluate(element => element.scrollTop)).toBe(readingPosition)
    await page.getByTestId('composer-status-trigger-questions').click()
    await page.getByTestId('composer-status-trigger-questions').click()
    await expect.poll(() => panelOrder(page)).toEqual(['questions', 'computer-use', 'plan', 'goal', 'queue'])
    expect(await rowOrder(page)).toEqual(arrivals)
    await page.getByTestId('fixture-plan-complete').click()
    await expect(page.getByTestId('composer-status-trigger-plan')).toHaveCount(0)
    await page.getByTestId('fixture-plan-next').click()
    await expect.poll(() => rowOrder(page)).toEqual([...arrivals.filter(id => id !== 'plan'), 'plan'])
    await expect.poll(() => panelOrder(page)).toEqual(['plan', 'questions', 'computer-use', 'goal', 'queue'])
    await expect.poll(() => details.evaluate(element => element.scrollTop)).toBe(0)
  })

  test(`new cards preserve the focused answer and reveal their top edge (${theme}, model-independent)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 700 })
    await page.goto(`/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=lifecycle&theme=${theme}`)
    await expect(page.getByTestId('composer-status-trigger-questions')).toBeVisible()
    await page.getByTestId('fixture-plan-complete').click()
    await expect(page.getByTestId('composer-status-trigger-plan')).toHaveCount(0)
    const answer = page.getByTestId('request-user-input-card').locator('textarea').last()
    await answer.fill('Keep the answer and its selection')
    await answer.evaluate(element => {
      element.setAttribute('data-order-lifetime', 'original')
      const input = element as HTMLTextAreaElement
      input.setSelectionRange(5, 11)
    })
    await expect(answer).toBeFocused()
    // Trigger a real domain update without moving browser focus to the fixture controls.
    await page.getByTestId('fixture-plan-next').evaluate(element => (element as HTMLButtonElement).click())
    await expect(page.getByTestId('composer-status-trigger-plan')).toBeVisible()
    await expect(answer).toHaveAttribute('data-order-lifetime', 'original')
    await expect(answer).toHaveValue('Keep the answer and its selection')
    await expect(answer).toBeFocused()
    expect(await answer.evaluate(element => {
      const input = element as HTMLTextAreaElement
      return [input.selectionStart, input.selectionEnd]
    })).toEqual([5, 11])
    await expect.poll(() => panelOrder(page)).toEqual(expect.arrayContaining(['questions', 'plan']))
    expect((await panelOrder(page))[0]).toBe('plan')
    await expect.poll(() => page.getByTestId('composer-status-details').evaluate(element => element.scrollTop)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('new-plan-with-answer-focus.png'), fullPage: true })
  })
}
