import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  test(`task evidence and feedback use the real conversation and buffered composer (${theme})`, async ({
    page,
  }, testInfo) => {
    let bootstrapNetworkChanged = false
    page.on('requestfailed', request => {
      if (request.failure()?.errorText === 'net::ERR_NETWORK_CHANGED')
        bootstrapNetworkChanged = true
    })
    await page.goto(`/e2e/fixtures/task-review-preview.html?theme=${theme}`)
    try {
      await expect(page.getByTestId('preview-boundary')).toContainText('示例数据')
    } catch (error) {
      if (!bootstrapNetworkChanged) throw error
      // Only inert fixture bootstrap may reload; no user or Native action has run.
      await page.reload()
      await expect(page.getByTestId('preview-boundary')).toContainText('示例数据')
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe(theme)
    await expect(page.getByTestId('task-review-failed')).toContainText('1 项命令执行失败')
    await expect(page.getByTestId('native-review-outcome')).toContainText('退出码 1')
    await expect(page.getByTestId('native-review-failures')).toContainText('1 项')
    await page.getByTestId('task-review-open-file').click()
    await expect(page.getByTestId('preview-opened-file')).toHaveText('report-thread-A.md')
    await expect(page.getByTestId('preview-send-count')).toHaveText('0')
    await expect(page.getByTestId('task-capture-state')).toHaveAttribute('data-capture-state', 'failed')
    await expect(page.getByTestId('task-capture-state')).toContainText('捕获失败')
    const evidence = page.getByTestId('task-review-evidence')
    await expect(evidence.locator('[data-processing-block-id]')).toHaveCount(0)
    await evidence.locator('summary').click()
    await evidence.getByRole('button', { name: /pnpm test report-validation$/ }).click()
    await expect(evidence).toContainText('REPORT_ASSERTION_FAILED')
    await page.getByTestId('chat-message-input').fill('请保留我的原草稿')
    await page.getByTestId('task-review-feedback').click()
    await expect(page.getByTestId('chat-message-input')).toContainText('请保留我的原草稿')
    await expect(page.getByTestId('chat-message-input')).toContainText('turn-thread-A')
    await expect(page.getByTestId('preview-send-count')).toHaveText('0')
    await page.screenshot({ path: testInfo.outputPath('task-review-feedback.png'), fullPage: true })
    await page.getByTestId('preview-switch-thread').click()
    await expect(page.getByTestId('preview-current-thread')).toHaveText('thread-B')
    await expect(page.getByTestId('chat-message-input')).toBeEmpty()
    await page.getByTestId('preview-late-reference').click()
    await expect(page.getByTestId('chat-message-input')).toBeEmpty()
    await page.getByTestId('task-review-feedback').click()
    await expect(page.getByTestId('chat-message-input')).toContainText('turn-thread-B')
    await expect(page.getByTestId('chat-message-input')).not.toContainText('turn-thread-A')
    await expect(page.getByTestId('preview-send-count')).toHaveText('0')
    await page.setViewportSize({ width: 420, height: 800 })
    expect(
      (await page.getByTestId('task-review-feedback').boundingBox())!.height
    ).toBeGreaterThanOrEqual(44)
    expect((await evidence.locator('summary').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath('task-review-narrow.png'), fullPage: true })
  })

  test(`partial and legacy captures preserve their evidence boundary (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/e2e/fixtures/task-review-preview.html?theme=${theme}&capture=partial`)
    const observation = page.getByTestId('task-capture-observation')
    await expect(page.getByTestId('task-capture-state')).toHaveAttribute('data-capture-state', 'partial')
    await expect(observation).toContainText('未纳入')
    await page.getByTestId('task-capture-windows').click()
    await expect(observation.locator('time')).toHaveCount(4)
    await page.setViewportSize({ width: 420, height: 800 })
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath('task-capture-partial.png'), fullPage: true })
    await page.goto(`/e2e/fixtures/task-review-preview.html?theme=${theme}&capture=legacy`)
    await expect(page.getByTestId('task-review-failed')).toContainText('1 项命令执行失败')
    await expect(page.getByTestId('task-capture-observation')).toHaveCount(0)
  })
}
