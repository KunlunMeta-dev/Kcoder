import { expect, test, type Page } from '@playwright/test'

async function send(page: Page) {
  await page.getByTestId('chat-message-input').fill('Synthetic message')
  await page.getByTestId('chat-message-input').press('Enter')
}

for (const theme of ['light', 'dark']) {
  for (const variant of ['desktop', 'compact']) {
    test(`fast ${variant} dispatch never flashes a queue panel (${theme})`, async ({ page }) => {
      await page.goto(`/e2e/fixtures/composer-queue.html?theme=${theme}&variant=${variant}`)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.getByTestId('chat-message-input')).toBeVisible()
      await page.evaluate(() => {
        const observed = window as typeof window & { queuePanelMounts: number }
        observed.queuePanelMounts = 0
        new MutationObserver(records => {
          for (const record of records)
            for (const node of record.addedNodes) {
              if (
                node instanceof Element &&
                (node.matches('[data-testid="conversation-queue-panel"]') ||
                  node.querySelector('[data-testid="conversation-queue-panel"]'))
              )
                observed.queuePanelMounts++
            }
        }).observe(document.body, { childList: true, subtree: true })
      })
      await send(page)
      await expect(page.getByTestId('fixture-dispatch-phase')).toHaveText('acknowledged')
      expect(
        await page.evaluate(
          () => (window as typeof window & { queuePanelMounts: number }).queuePanelMounts
        )
      ).toBe(0)
      await expect(page.getByTestId('conversation-queue-panel')).toHaveCount(0)
    })
  }
}

test('slow dispatch, real backlog and failure remain visible and actionable', async ({
  page,
}, testInfo) => {
  await page.goto('/e2e/fixtures/composer-queue.html?theme=dark')
  await page.getByTestId('fixture-fast-dispatch').uncheck()
  await send(page)
  await expect(page.locator('[data-status-item="queue"] button')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('conversation-queue-panel')).toBeVisible()
  await page.getByTestId('fixture-enqueue').click()
  await expect(page.getByTestId('conversation-queue-row-waiting')).toBeVisible()
  await page.getByTestId('queue-cancel-button-waiting').click()
  await expect(page.getByTestId('conversation-queue-row-waiting')).toHaveCount(0)
  await page.getByTestId('fixture-fail').click()
  await expect(page.getByText('Synthetic dispatch failure')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('queue-failure-controls.png') })
  await page.getByTestId('queue-cancel-button-dispatch').click()
  await expect(page.getByTestId('conversation-queue-panel')).toHaveCount(0)
})

for (const theme of ['light', 'dark']) {
  for (const width of [320, 390]) {
    test(`a folded queue exposes unknown delivery and retires on execution in ${theme} at ${width}px (model-independent)`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`/e2e/fixtures/composer-queue.html?theme=${theme}`)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page.getByTestId('fixture-fast-dispatch').uncheck()
      await page.getByTestId('fixture-enqueue').click()
      const trigger = page.getByTestId('composer-status-trigger-queue')
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      await trigger.click()
      await page.getByTestId('chat-message-input').fill('Keep this ordinary draft')
      await page.getByTestId('fixture-unknown').click()
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      await expect(trigger).toContainText('Send results to check: 1')
      await expect(trigger).toHaveClass(/text-warning/)
      await expect(page.getByTestId('conversation-queue-panel')).toBeHidden()
      await page.screenshot({ path: testInfo.outputPath('folded-unknown-queue.png') })
      await page.getByTestId('fixture-executing').click()
      await expect(trigger).toHaveCount(0)
      await expect(page.getByTestId('composer-status-region')).toHaveCount(0)
      await expect(page.getByTestId('chat-message-input')).toHaveText('Keep this ordinary draft')
    })
  }
}


for (const width of [390, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`image-only pending input remains recognizable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/e2e/fixtures/composer-queue.html?image=1&theme=${theme}`)
      const row = page.getByTestId('conversation-queue-row-image-only')
      await expect(row).toContainText('queue-image.png')
      await expect(row).toHaveAttribute('data-status', 'unknown')
      await page.getByTestId('fixture-fail').click()
      await expect(row).toContainText('queue-image.png')
      await expect(row).toHaveAttribute('data-status', 'failed')
      const composer = await page.getByTestId('fixture-composer').boundingBox()
      const bounds = await row.boundingBox()
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(composer!.x + composer!.width + 1)
    })
  }
}

for (const width of [390, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`submitted guidance explains unavailable withdrawal at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/e2e/fixtures/composer-queue.html?image=1&steer=1&theme=${theme}`)
      const cancel = page.getByTestId('queue-cancel-button-image-only')
      await expect(cancel).toBeDisabled()
      await expect(cancel).toHaveAttribute('title', 'This guidance has been submitted and cannot be withdrawn individually.')
      await expect(page.getByTestId('conversation-queue-row-image-only')).not.toContainText('Cancelling')
      await page.screenshot({ path: testInfo.outputPath('guidance-withdrawal-unavailable.png') })
      await page.getByTestId('fixture-executing').click()
      await expect(page.getByTestId('conversation-queue-panel')).toHaveCount(0)
    })
  }
}
