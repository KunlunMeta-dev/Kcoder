import { expect, test } from '@playwright/test'
// Deterministic layout evidence, not Native/backend/model/platform acceptance.
test('knowledge and business subscription preview screenshots use real components', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  let networkChanged = false
  page.on('requestfailed', request => {
    if (request.failure()?.errorText === 'net::ERR_NETWORK_CHANGED') networkChanged = true
  })
  await page.goto('/e2e/fixtures/knowledge-integration-preview.html')
  try {
    await expect(page.getByTestId('preview-boundary')).toHaveText('界面预览 · 示例数据')
  } catch (error) {
    if (!networkChanged) throw error
    // Only untouched fixture bootstrap may reload; no user or native action has run yet.
    await page.reload()
    await expect(page.getByTestId('preview-boundary')).toHaveText('界面预览 · 示例数据')
  }
  await page.getByTestId('knowledge-section-knowledge').click()
  await expect(page.getByTestId('knowledge-publication-row')).toHaveCount(2)
  await page.screenshot({
    path: testInfo.outputPath('shared-knowledge-preview.png'),
    fullPage: true,
  })
  const firstPublication = page.getByTestId('knowledge-publication-row').first()
  await firstPublication.getByTestId('publication-source-status-toggle').click()
  await expect(firstPublication.getByTestId('publication-source-observation')).toHaveCount(1)
  await expect(firstPublication).toContainText('原始资料已标记移除。')
  await expect(firstPublication).toContainText('原始知识库已归档。')
  await expect(firstPublication).toContainText('原始固定修订可读。')
  const secondPublication = page.getByTestId('knowledge-publication-row').nth(1)
  await secondPublication.getByTestId('publication-source-status-toggle').click()
  await expect(secondPublication).toContainText('原始固定修订已缺失')
  await page.screenshot({
    path: testInfo.outputPath('fixed-source-lifecycle-light.png'),
    fullPage: true,
  })
  await page.getByTestId('publication-create-toggle').click()
  await expect(page.getByTestId('publication-library-choice')).toHaveCount(1)
  await page.getByTestId('publication-library-choice').click()
  await expect(page.getByTestId('publication-source-checkbox')).toHaveCount(2)
  await page.getByTestId('publication-source-checkbox').first().click()
  await expect(page.getByTestId('publication-selected-source')).toHaveCount(1)
  await page.screenshot({
    path: testInfo.outputPath('native-wiki-source-picker-light.png'),
    fullPage: true,
  })
  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
    document.documentElement.dataset.theme = 'dark'
  })
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: testInfo.outputPath('native-wiki-source-picker-dark-narrow.png'),
    fullPage: true,
  })
  await expect(firstPublication.getByTestId('publication-source-observation')).toBeVisible()
  const sourceToggle = firstPublication.getByTestId('publication-source-status-toggle')
  expect((await sourceToggle.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect(
    (await firstPublication.getByTestId('knowledge-refresh').boundingBox())!.height
  ).toBeGreaterThanOrEqual(44)
  await sourceToggle.focus()
  await page.keyboard.press('Enter')
  await expect(firstPublication.getByTestId('publication-source-observation')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(firstPublication.getByTestId('publication-source-observation')).toHaveCount(1)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBeTruthy()
  await page.screenshot({
    path: testInfo.outputPath('fixed-source-lifecycle-dark-narrow.png'),
    fullPage: true,
  })
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.dataset.theme = 'light'
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByTestId('knowledge-section-automation').click()
  await expect(page.getByTestId('automation-run')).toHaveCount(2)
  await page.screenshot({
    path: testInfo.outputPath('business-subscriptions-preview.png'),
    fullPage: true,
  })
  await page.getByTestId('subscription-form-toggle').click()
  await page.getByTestId('subscription-title').fill('每日事项办理简报')
  await page.getByTestId('subscription-workflow').selectOption('preview-report-flow@3')
  await page.getByTestId('subscription-timezone').fill('Asia/Shanghai')
  await page.getByTestId('subscription-preview').click()
  await expect(page.getByTestId('subscription-consent')).toBeEnabled()
  await expect(page.getByRole('status')).toContainText('09:00')
  await page.screenshot({
    path: testInfo.outputPath('business-subscriptions-create-preview.png'),
    fullPage: true,
  })
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBeTruthy()
})
