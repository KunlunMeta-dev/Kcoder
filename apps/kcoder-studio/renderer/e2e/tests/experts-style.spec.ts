import { expect, test } from '@playwright/test'

test('a late binding response from a retired account is rejected before fresh recovery (model-independent)', async ({ page }) => {
  await page.goto('/e2e/fixtures/expert-task-binding.html?hold=1')
  await expect.poll(() => page.evaluate(() => window.__expertBindingFixture.reads().length)).toBe(1)
  await page.evaluate(() => {
    window.__expertBindingFixture.changeAccount()
    window.__expertBindingFixture.release()
  })
  await expect(page.getByTestId('binding-revision')).toBeEmpty()
  await expect(page.getByTestId('binding-error')).toContainText('AGENT_ORIGINAL_TASK_CHANGED')
  await page.getByRole('button', { name: 'Read again', exact: true }).click()
  await expect(page.getByTestId('binding-revision')).toHaveText('2')
  await expect(page.getByTestId('binding-error')).toBeEmpty()
  expect(await page.evaluate(() => window.__expertBindingFixture.reads().length)).toBe(2)
})

test('two task views share a pending expert RPC and cancel only their own waits (model-independent)', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/expert-task-binding.html?readers=2&hold=1')
  const first = page.getByTestId('binding-first')
  const second = page.getByTestId('binding-second')
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__expertBindingFixture.reads().length)).toBe(1)
  await page.getByRole('button', { name: 'Close second view', exact: true }).click()
  await expect(second).toHaveCount(0)
  expect(await page.evaluate(() => window.__expertBindingFixture.cancellations())).toBe(0)
  await page.evaluate(() => window.__expertBindingFixture.release())
  await expect(first.getByTestId('binding-revision')).toHaveText('1')
  await expect(first.getByTestId('binding-error')).toBeEmpty()
  await page.evaluate(() => {
    window.__expertBindingFixture.holdNextRead()
    window.dispatchEvent(new Event('focus'))
  })
  await expect.poll(() => page.evaluate(() => window.__expertBindingFixture.reads().length)).toBe(2)
  await page.getByRole('button', { name: 'Close all views', exact: true }).click()
  await expect(first).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.__expertBindingFixture.cancellations())).toBe(1)
  await testInfo.attach('shared-binding-counts', {
    body: JSON.stringify(await page.evaluate(() => ({
      reads: window.__expertBindingFixture.reads(), cancellations: window.__expertBindingFixture.cancellations(),
    }))), contentType: 'application/json',
  })
})

test('task binding focus and manual recovery replace old refresh deadlines (model-independent)', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-11-22T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-22T12:00:01Z'))
  await page.goto('/e2e/fixtures/expert-task-binding.html')
  const revision = page.getByTestId('binding-revision')
  const error = page.getByTestId('binding-error')
  await expect(revision).toHaveText('1')
  await page.clock.runFor(29_900)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(revision).toHaveText('2')
  await page.clock.runFor(100)
  expect(await page.evaluate(() => window.__expertBindingFixture.reads().length)).toBe(2)
  await page.clock.runFor(29_900)
  await expect(revision).toHaveText('3')

  await page.evaluate(() => {
    window.__expertBindingFixture.failNextRead()
    window.dispatchEvent(new Event('focus'))
  })
  await expect(error).toContainText('Fixture binding read failed')
  await page.clock.runFor(9_900)
  await page.getByRole('button', { name: 'Read again', exact: true }).click()
  await expect(revision).toHaveText('5')
  await expect(error).toBeEmpty()
  await page.clock.runFor(100)
  expect(await page.evaluate(() => window.__expertBindingFixture.reads().length)).toBe(5)
  await page.clock.runFor(29_900)
  await expect(revision).toHaveText('6')
  await testInfo.attach('binding-read-times', {
    body: JSON.stringify(await page.evaluate(() => window.__expertBindingFixture.reads())),
    contentType: 'application/json',
  })
})

test('a missing original receipt still refreshes saved experts without clearing uncertainty', async ({ page }) => {
  await page.goto('/e2e/fixtures/expert-style-preview.html?missingReceipt=1&emptyCatalogs=personal')
  const preview = page.getByTestId('expert-style-preview')
  await expect(preview.getByText(/列表为空不代表原操作未执行/)).toBeVisible()
  await page.evaluate(() => window.__expertCatalogFixture.populate('personal'))
  await preview.getByRole('button', { name: '核对原操作', exact: true }).click()
  await expect(preview.getByText(/暂未找到原操作的完成回执/)).toBeVisible()
  await expect(preview.getByTestId('expert-card')).toHaveCount(2)
  await expect(preview.getByTestId('expert-card').first().getByRole('button', { name: '编辑', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => Object.values(sessionStorage).includes('visual-original-operation'))).toBe(true)
})

for (const emptyCatalog of [true, false]) {
  test(`an absent original receipt retains uncertainty and permits reviewed recovery with ${emptyCatalog ? 'an empty catalog' : 'existing experts'} (model-independent)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/fixtures/expert-style-preview.html?missingReceipt=1' + (emptyCatalog ? '&emptyCatalogs=personal' : ''))
    const preview = page.getByTestId('expert-style-preview')
    const cards = preview.getByTestId('expert-card')
    if (emptyCatalog) {
      await expect(preview.getByText(/列表为空不代表原操作未执行/)).toBeVisible()
    } else {
      await expect(cards).toHaveCount(2)
      await expect(cards.first().getByRole('button', { name: '编辑', exact: true })).toBeDisabled()
      await expect(cards.first().getByRole('button', { name: '对话', exact: true })).toBeDisabled()
    }
    await preview.getByRole('button', { name: '核对原操作', exact: true }).click()
    await expect(preview.getByText(/暂未找到原操作的完成回执/)).toBeVisible()
    await expect(preview.getByRole('button', { name: '核对原操作', exact: true })).toBeEnabled()
    await expect(preview).not.toContainText('OFFICE_ACTION_NOT_FOUND')
    expect(await page.evaluate(() => Object.values(sessionStorage).includes('visual-original-operation'))).toBe(true)
    expect(errors).toEqual([])
    await preview.screenshot({ path: testInfo.outputPath('expert-original-receipt-missing.png') })
    await preview.getByTestId('expert-pending-review-open').click()
    const review = page.getByTestId('expert-pending-review')
    await expect(review).toContainText('原操作的结果仍未知')
    await review.getByRole('button', { name: '取消', exact: true }).last().click()
    expect(await page.evaluate(() => Object.values(sessionStorage).includes('visual-original-operation'))).toBe(true)
    await preview.getByTestId('expert-pending-review-open').click()
    await review.getByTestId('expert-pending-review-confirm').click()
    await expect(review).toHaveCount(0)
    expect(await page.evaluate(() => Object.values(sessionStorage).includes('visual-original-operation'))).toBe(false)
    await expect(preview.getByTestId('expert-pending-review-open')).toHaveCount(0)
    await expect(preview).not.toContainText('OFFICE_ACTION_NOT_FOUND')
    if (!emptyCatalog) {
      await expect(cards).toHaveCount(2)
      await expect(cards.first().getByRole('button', { name: '编辑', exact: true })).toBeEnabled()
      await expect(cards.first().getByRole('button', { name: '对话', exact: true })).toBeEnabled()
      await expect(cards.first()).toContainText('合同起草专家')
    }
    expect(errors).toEqual([])
  })
}

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
  await expect(confirm).toContainText('已有任务无法再使用这些版本执行')
  await expect(confirm).toContainText('历史仍保留')
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
  // Transformed dialogs can acquire subpixel rounding without visible overflow.
  expect(drawer!.width).toBeLessThanOrEqual(390 + 0.5)
})

test('creating from the market never shows the previously opened expert package', async ({
  page,
}) => {
  await page.goto('/e2e/fixtures/expert-style-preview.html?marketExpert')
  const preview = page.getByTestId('expert-style-preview')
  const cards = preview.getByTestId('expert-card')
  await cards.nth(1).getByRole('button', { name: '编辑', exact: true }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText('skills/lint/SKILL.md', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await preview.getByRole('tab', { name: '专家市场', exact: true }).click()
  await preview.getByRole('button', { name: '从市场创建', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('接口文档专家')
  await expect(page.getByRole('dialog').getByText('skills/lint/SKILL.md', { exact: true })).toHaveCount(0)
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
