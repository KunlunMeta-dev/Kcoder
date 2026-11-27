import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [320, 390, 1280, 1440]) {
    test(`context preflight offers only recorded recovery (${theme}, ${width}px, model-independent)`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1440 ? 960 : 800 })
      await page.goto('/e2e/fixtures/context-preflight.html')
      await page.evaluate(
        value => document.documentElement.setAttribute('data-theme', value),
        theme
      )
      const error = page.getByTestId('context-preflight-failure')
      await expect(error).toContainText('48,264')
      await expect(error).toContainText('28,672')
      await expect(page.getByTestId('assistant-error-card')).toContainText('当前模型上下文不足')
      await expect(error).toContainText('已跳过历史压缩')
      await expect(error).toBeHidden()
      await expect(page.getByText('本次模型请求未发送。', { exact: true })).toBeVisible()
      await expect(page.getByText(/没有可用的续接检查点/)).toBeVisible()
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      await expect(page.getByTestId('assistant-error-details')).toHaveCount(0)
      await expect(page.getByTestId('assistant-error-recovery-facts')).toBeHidden()
      await page.screenshot({ path: testInfo.outputPath('error-collapsed.png'), fullPage: true })
      await page.getByTestId('assistant-error-details-toggle').click()
      await expect(page.getByTestId('assistant-error-details')).toBeVisible()
      await expect(page.getByTestId('assistant-error-recovery-facts')).toBeVisible()
      await expect(error).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('error-expanded.png'), fullPage: true })
      await expect(page.getByTestId('assistant-error-recovery-facts')).toContainText(
        '发送前的上下文检查'
      )
      await page.getByTestId('assistant-error-details-toggle').click()
      await expect(page.getByTestId('assistant-error-details')).toHaveCount(0)
      await expect(page.getByTestId('assistant-error-switch-model-retry')).toHaveCount(0)
      await expect(page.getByTestId('assistant-error-retry')).toHaveCount(0)
      await expect(page.getByTestId('context-submissions')).toHaveText('0')
      await page.getByTestId('assistant-error-switch-model').click()
      await expect(page.getByTestId('context-model-selections')).toHaveText('1')
      await expect(page.getByTestId('context-submissions')).toHaveText('0')
      await page.screenshot({
        path: testInfo.outputPath('small-model-guidance.png'),
        fullPage: true,
      })
      await page.getByRole('button', { name: '读取已保存的检查点' }).click()
      await page.getByTestId('assistant-error-switch-model-retry').click()
      await expect(page.getByTestId('context-submissions')).toHaveText('1')
      await expect(page.getByTestId('assistant-error-continued')).toBeVisible()
      await expect(page.getByTestId('assistant-error-switch-model-retry')).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('context-preflight.png'), fullPage: true })
    })
  }
}
