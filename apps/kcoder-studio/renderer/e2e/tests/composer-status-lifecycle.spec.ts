import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`blocking model questions preserve queue controls and editor state in ${theme} at ${width}px (model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/e2e/fixtures/composer-question.html?theme=${theme}`)
      const editor = page.getByTestId('chat-message-input')
      await editor.fill('保留普通消息草稿')
      await editor.evaluate(element => element.setAttribute('data-lifetime-probe', 'original'))
      await page.getByTestId('fixture-ask').click()
      await expect(editor).toBeHidden()
      await expect(page.getByTestId('request-user-input-card')).toBeVisible()
      await expect(page.getByTestId('conversation-queue-row-first')).toBeVisible()
      await page.getByTestId('queue-cancel-button-first').click()
      await expect(page.getByTestId('conversation-queue-row-first')).toHaveCount(0)
      await expect(page.getByTestId('conversation-queue-row-second')).toBeVisible()
      const queue = page.getByTestId('composer-status-trigger-queue')
      await queue.click()
      await expect(queue).toHaveAttribute('aria-expanded', 'false')
      await page.getByTestId('request-user-input-custom-choice').fill('先保留队列')
      await page.getByTestId('request-user-input-submit-button').click()
      await expect(page.getByTestId('request-user-input-card')).toHaveCount(0)
      await expect(editor).toBeVisible()
      await expect(editor).toHaveText('保留普通消息草稿')
      await expect(editor).toHaveAttribute('data-lifetime-probe', 'original')
      await expect(queue).toHaveAttribute('aria-expanded', 'false')
      await queue.click()
      await expect(page.getByTestId('conversation-queue-row-second')).toBeVisible()
      expect(errors).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('queue-after-model-question.png'), fullPage: true })
    })

    test(`settled statuses leave the composer and preserve peers in ${theme} at ${width}px (model-independent)`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/e2e/fixtures/async-question-browser.html?statusRegion=1&scene=lifecycle&theme=${theme}`)
      const composer = page.getByTestId('chat-message-input')
      await composer.fill('状态退出时保留这份草稿')
      for (const id of ['questions', 'plan', 'computer-use', 'goal', 'queue']) {
        await expect(page.getByTestId(`composer-status-trigger-${id}`)).toBeVisible()
      }

      await page.getByTestId('fixture-plan-complete').click()
      await expect(page.getByTestId('composer-status-trigger-plan')).toHaveCount(0)
      await page.getByTestId('fixture-desktop-unknown').click()
      await expect(page.getByTestId('computer-use-status')).toHaveAttribute('data-state', 'unknown')
      await expect(page.getByTestId('composer-status-trigger-computer-use')).toBeVisible()
      await page.getByTestId('fixture-desktop-failed').click()
      await expect(page.getByTestId('computer-use-status')).toHaveAttribute('data-state', 'stop_failed')
      await expect(page.getByTestId('computer-use-cleanup')).toContainText('清理')
      await page.getByTestId('fixture-desktop-stopped').click()
      await expect(page.getByTestId('composer-status-trigger-computer-use')).toHaveCount(0)

      await page.evaluate(status => window.__asyncQuestionBrowserFixture.settleQuestion(status),
        theme === 'light' ? 'cancelled' : 'stale')
      await expect(page.getByTestId('composer-status-trigger-questions')).toHaveCount(0)
      await expect(page.getByTestId('composer-status-trigger-goal')).toBeVisible()
      await expect(page.getByTestId('composer-status-trigger-queue')).toBeVisible()
      await expect(composer).toHaveText('状态退出时保留这份草稿')

      await page.getByTestId('queue-cancel-button-e2e-status-queue').click()
      await page.getByTestId('clear-goal-button').click()
      await expect(page.getByTestId('composer-status-region')).toHaveCount(0)
      await expect(composer).toHaveText('状态退出时保留这份草稿')
      await page.getByTestId('fixture-plan-next').click()
      await expect(page.getByTestId('composer-status-trigger-plan')).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByText('下一轮计划', { exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('new-plan-after-settlement.png'), fullPage: true })
      await page.getByTestId('fixture-plan-complete').click()
      await expect(page.getByTestId('composer-status-region')).toHaveCount(0)
      await expect(composer).toHaveText('状态退出时保留这份草稿')
      expect(errors).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('all-statuses-settled.png'), fullPage: true })
    })
  }
}
