import { expect, test } from '@playwright/test'

test('saved task capability scope opens its preview without horizontal overflow', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.goto('/e2e/fixtures/task-capability-scope-preview.html')
  const scopeRegions = page.getByRole('region', { name: '任务工具与资源范围', exact: true })
  await expect(scopeRegions).toHaveCount(1)
  await page.getByRole('button', { name: /季度资料整理/ }).click()
  await expect(scopeRegions).toHaveCount(2)
  await expect(scopeRegions.nth(1).getByRole('button', { name: '保存任务工具与资源范围' })).toBeDisabled()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(pageErrors).toEqual([])
})
