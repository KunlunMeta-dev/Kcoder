import { expect, test, type Page } from '@playwright/test'

async function send(page: Page) {
  await page.getByTestId('chat-message-input').fill('Synthetic message')
  await page.getByTestId('chat-message-input').press('Enter')
}

for (const theme of ['light', 'dark']) {
  for (const variant of ['desktop', 'compact']) {
    test(`fast ${variant} dispatch never flashes a queue panel (${theme})`, async ({ page }) => {
      await page.goto(`/e2e/fixtures/composer-queue.html?theme=${theme}&variant=${variant}`)
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
