import { expect, test } from '@playwright/test'

test('experts use the live workbench theme and font scale in the real browser', async ({
  page,
}, testInfo) => {
  await page.goto('/e2e/fixtures/expert-style-preview.html')
  const preview = page.getByTestId('expert-style-preview')
  const cards = preview.getByTestId('expert-card')
  await expect(cards).toHaveCount(2)
  await expect(preview.getByTestId('workspace-page-header')).toBeVisible()
  const title = cards.first().locator('h2')
  await expect(title).toHaveCSS('font-size', '14px')
  await expect(cards.first()).not.toContainText('personal.contract')
  for (const mode of ['light', 'dark']) {
    if (mode === 'dark') await page.getByTestId('expert-preview-theme').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
    const primary = cards.first().getByRole('button', { name: '对话', exact: true })
    const foreground = await page.locator('main').evaluate(node => getComputedStyle(node).color)
    const background = await page
      .locator('main')
      .evaluate(node => getComputedStyle(node).backgroundColor)
    await expect(primary).toHaveCSS('background-color', foreground)
    await expect(primary).toHaveCSS('color', background)
    await cards.first().hover()
    await expect(cards.first()).toHaveCSS('transform', 'none')
    await page.mouse.move(0, 0)
    await preview.screenshot({
      path: testInfo.outputPath('experts-' + mode + '.png'),
      animations: 'disabled',
    })
  }
  await page.getByTestId('expert-preview-font').click()
  await expect(title).toHaveCSS('font-size', '16px')
  await expect(preview.getByRole('searchbox', { name: '搜索专家' })).toHaveCSS('font-size', '16px')
})

test('expert menus, details, categories and narrow layouts retain their original actions', async ({
  page,
}, testInfo) => {
  await page.goto('/e2e/fixtures/expert-style-preview.html')
  const preview = page.getByTestId('expert-style-preview')
  const cards = preview.getByTestId('expert-card')
  await expect(cards).toHaveCount(2)
  await cards.first().getByRole('button', { name: '更多操作' }).click()
  await expect(page.getByTestId('expert-files-personal.contract')).toBeVisible()
  await expect(page.getByTestId('expert-copy-personal.contract')).toBeVisible()
  await page.getByTestId('expert-delete-personal.contract').click()
  const confirm = page.getByTestId('expert-delete-confirm')
  await expect(confirm).toContainText('已有任务保留')
  await confirm.getByRole('button', { name: '取消', exact: true }).last().click()
  await expect(confirm).toHaveCount(0)
  await expect(cards).toHaveCount(2)
  await cards.first().getByRole('button', { name: '编辑', exact: true }).click()
  const id = page.getByRole('textbox', { name: '专家 ID', exact: true })
  await expect(id).toHaveValue('personal.contract')
  await expect(id).toHaveAttribute('readonly', '')
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('未保存的专家草稿')
  await page
    .getByRole('dialog')
    .screenshot({ path: testInfo.outputPath('expert-editor.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(id).toHaveCount(0)
  const search = preview.getByRole('searchbox', { name: '搜索专家' })
  await search.fill('合同')
  await expect(cards).toHaveCount(1)
  await search.fill('')
  await expect(cards).toHaveCount(2)
  await preview.getByRole('tab', { name: '内置专家', exact: true }).click()
  await expect(preview.getByText('合同专家模板', { exact: true })).toBeVisible()
  await preview.getByRole('tab', { name: '我的专家', exact: true }).click()
  await expect(cards).toHaveCount(2)
  await page.setViewportSize({ width: 390, height: 850 })
  await expect(cards.first()).toBeVisible()
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }))
  expect(widths.page).toBeLessThanOrEqual(widths.viewport)
  await preview.screenshot({
    path: testInfo.outputPath('experts-narrow.png'),
    animations: 'disabled',
  })
  await cards.first().getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '专家 ID', exact: true })).toBeVisible()
  const drawer = await page.getByRole('dialog').boundingBox()
  expect(drawer!.width).toBeLessThanOrEqual(390)
})

test('catalog tabs share loaded empty data and empty-list refresh never replaces it with a spinner', async ({
  page,
}, testInfo) => {
  await page.goto(
    '/e2e/fixtures/expert-style-preview.html?holdCatalogs=personal,library&emptyCatalogs=personal'
  )
  const preview = page.getByTestId('expert-style-preview')
  const loading = preview.getByTestId('expert-catalog-loading')
  await expect(loading).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__expertCatalogFixture.calls().length)).toBe(2)
  await preview.getByRole('tab', { name: '我的团队', exact: true }).click()
  await expect(loading).toBeVisible()
  await page.evaluate(() => window.__expertCatalogFixture.release('personal'))
  await expect(loading).toHaveCount(0)
  await preview.getByRole('tab', { name: '内置专家', exact: true }).click()
  await expect(loading).toBeVisible()
  await page.evaluate(() => window.__expertCatalogFixture.release('library'))
  await expect(preview.getByText('合同专家模板', { exact: true })).toBeVisible()
  for (const name of ['我的专家', '我的团队', '内置专家', '我的专家']) {
    await preview.getByRole('tab', { name, exact: true }).click()
    await expect(loading).toHaveCount(0)
  }
  await expect(preview.getByText('还没有专家', { exact: true })).toBeVisible()
  await expect(preview.locator('img')).toHaveCount(0)
  expect(await page.evaluate(() => window.__expertCatalogFixture.calls().length)).toBe(2)
  await page.evaluate(() => window.__expertCatalogFixture.holdNext('personal'))
  await preview.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(preview.getByTestId('expert-catalog-content')).toHaveAttribute('aria-busy', 'true')
  await expect(loading).toHaveCount(0)
  await page.evaluate(() => window.__expertCatalogFixture.fail('personal'))
  await expect(preview.getByRole('alert')).toBeVisible()
  await expect(loading).toHaveCount(0)
  await preview.getByRole('button', { name: '刷新', exact: true }).last().click()
  await expect(preview.getByRole('alert')).toHaveCount(0)
  await expect(preview.getByTestId('expert-catalog-content')).toHaveAttribute('aria-busy', 'false')
  await preview.screenshot({ path: testInfo.outputPath('loaded-empty-catalog.png') })
})

test('a plain navigation to experts selects My experts again', async ({ page }) => {
  await page.goto('/e2e/fixtures/expert-style-preview.html')
  const preview = page.getByTestId('expert-style-preview')
  await expect(preview.getByTestId('expert-card')).toHaveCount(2)
  await preview.getByRole('tab', { name: '内置专家', exact: true }).click()
  await expect(preview.getByRole('tab', { name: '内置专家', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.evaluate(() => {
    window.history.pushState({}, '', '/experts')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(preview.getByRole('tab', { name: '我的专家', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(preview.getByTestId('expert-card')).toHaveCount(2)
})

test('market tab retains its pending read, search and completed empty result across switches', async ({
  page,
}) => {
  await page.goto('/e2e/fixtures/expert-style-preview.html?holdCatalogs=market')
  const preview = page.getByTestId('expert-style-preview')
  await expect(preview.getByTestId('expert-card')).toHaveCount(2)
  await preview.getByRole('tab', { name: '专家市场', exact: true }).click()
  await expect(preview.getByTestId('expert-catalog-loading')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__expertCatalogFixture.calls().filter(c => c.resource === 'market').length
      )
    )
    .toBe(1)
  await preview.getByRole('tab', { name: '我的专家', exact: true }).click()
  await expect(preview.getByTestId('expert-card')).toHaveCount(2)
  await preview.getByRole('tab', { name: '专家市场', exact: true }).click()
  await page.evaluate(() => window.__expertCatalogFixture.release('market'))
  await expect(preview.getByTestId('expert-catalog-loading')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => window.__expertCatalogFixture.calls().filter(c => c.resource === 'market').length
    )
  ).toBe(1)
  await page.evaluate(() => window.__expertCatalogFixture.holdNext('market'))
  await preview.getByRole('searchbox', { name: '搜索专家市场' }).fill('合同')
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__expertCatalogFixture.calls().filter(c => c.resource === 'market').length
      )
    )
    .toBe(2)
  await expect(preview.getByTestId('expert-catalog-loading')).toHaveCount(0)
  await preview.getByRole('tab', { name: '我的专家', exact: true }).click()
  await preview.getByRole('tab', { name: '专家市场', exact: true }).click()
  await expect(preview.getByRole('searchbox', { name: '搜索专家市场' })).toHaveValue('合同')
  await page.evaluate(() => window.__expertCatalogFixture.release('market'))
  await expect(preview.getByTestId('expert-catalog-content')).toHaveAttribute('aria-busy', 'false')
  expect(
    await page.evaluate(
      () => window.__expertCatalogFixture.calls().filter(c => c.resource === 'market').length
    )
  ).toBe(2)
})

test('refresh retains expert cards and local filtering never refetches their catalog', async ({
  page,
}, testInfo) => {
  await page.goto('/e2e/fixtures/expert-style-preview.html')
  const preview = page.getByTestId('expert-style-preview')
  const cards = preview.getByTestId('expert-card')
  await expect(cards).toHaveCount(2)
  await preview.getByRole('searchbox', { name: '搜索专家', exact: true }).fill('合同')
  await expect(cards).toHaveCount(1)
  expect(await page.evaluate(() => window.__expertCatalogFixture.calls().length)).toBe(2)
  await page.evaluate(() => window.__expertCatalogFixture.holdNext('personal'))
  await preview.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(preview.getByTestId('expert-catalog-content')).toHaveAttribute('aria-busy', 'true')
  await expect(cards).toHaveCount(1)
  await expect(cards.first().getByRole('button', { name: '编辑', exact: true })).toBeEnabled()
  await expect(preview.getByTestId('expert-catalog-loading')).toHaveCount(0)
  await preview.getByRole('tab', { name: '内置专家', exact: true }).click()
  await expect(preview.getByText('合同专家模板', { exact: true })).toBeVisible()
  await page.evaluate(() => window.__expertCatalogFixture.release('personal'))
  await preview.getByRole('tab', { name: '我的专家', exact: true }).click()
  await expect(preview.getByRole('searchbox', { name: '搜索专家', exact: true })).toHaveValue(
    '合同'
  )
  await expect(cards).toHaveCount(1)
  await page.getByTestId('expert-preview-theme').click()
  await preview.screenshot({ path: testInfo.outputPath('retained-catalog-dark.png') })
})
