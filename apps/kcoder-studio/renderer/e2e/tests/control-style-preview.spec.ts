import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/servers', route =>
    route.fulfill({
      json: {
        servers: [
          { id: 'local', label: '当前计算机', transport: 'local', workspacePath: '/preview' },
        ],
      },
    })
  )
})

test('task board date filters keep their default and fit a compact viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 })
  await page.goto('/e2e/fixtures/control-style-preview.html?panel=board&layout=rows')

  const periods = page.getByRole('group', { name: '按更新时间筛选' })
  await expect(periods.getByRole('button', { name: '最近 7 天' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('task-board-list-row')).toHaveCount(7)

  await periods.getByRole('button', { name: '全部', exact: true }).click()
  await expect(page.getByTestId('task-board-pagination')).toContainText('第 1 / 2 页 · 共 12 个任务')
  await expect(page.getByTestId('task-board-list-row')).toHaveCount(10)
  await page.getByTestId('task-board-page-next').click()
  await expect(page.getByTestId('task-board-list-row')).toHaveCount(2)

  await page.setViewportSize({ width: 900, height: 850 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('shared page headers keep a common height without mobile overflow', async ({ page }) => {
  await page.goto('/e2e/fixtures/control-style-preview.html?panel=headers')
  await expect(page.getByTestId('header-wiki')).toBeVisible()

  const heights = await page.evaluate(() =>
    ['wiki', 'tasks', 'schedule', 'workflow', 'plugins', 'channels'].map(id =>
      document.querySelector(`[data-testid="header-${id}"]`)!.getBoundingClientRect().height
    )
  )
  expect(heights).toEqual([56, 56, 56, 56, 56, 56])

  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('provider editor sections retain readable spacing', async ({ page }) => {
  await page.goto('/e2e/fixtures/provider-style-preview.html')
  await page.getByTestId('provider-edit-demo::MiniMax-M3').click()
  await expect(page.getByTestId('provider-form')).toBeVisible()

  const spacing = await page.evaluate(() => {
    const basic = document.querySelector('[data-testid="provider-default"]')!.closest('fieldset')!.getBoundingClientRect()
    const advancedNode = document.querySelector('[data-testid="provider-advanced-settings"]')!
    const advanced = advancedNode.getBoundingClientRect()
    const security = advancedNode.nextElementSibling!.getBoundingClientRect()
    return { basicToAdvanced: advanced.top - basic.bottom, advancedToSecurity: security.top - advanced.bottom }
  })
  expect(spacing.basicToAdvanced).toBeGreaterThanOrEqual(15)
  expect(spacing.advancedToSecurity).toBeGreaterThanOrEqual(15)
})

test('tool settings pagination resets when changing mode', async ({ page }) => {
  await page.goto('/e2e/fixtures/tools-settings-preview.html')
  await expect(page.getByTestId('tool-selection-read')).toBeVisible()
  await expect(page.getByRole('switch')).toHaveCount(10)

  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.getByRole('switch')).toHaveCount(3)

  await page.getByTestId('tool-selections-mode-kworker').click()
  await expect(page.getByRole('switch')).toHaveCount(10)
})

test('tool settings controls retain their position while a save settles', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 680 })
  await page.goto('/e2e/fixtures/tools-settings-preview.html?simulateSave')
  const toggle = page.getByTestId('tool-selection-read')
  const search = page.getByTestId('tool-selections-search')
  const refresh = page.getByTestId('tool-selections-refresh')
  const status = page.getByTestId('tool-selections-save-status')
  const geometry = () => Promise.all([search.boundingBox(), refresh.boundingBox(), toggle.boundingBox()])
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const initial = await geometry()
  expect(initial.every(box => box !== null)).toBe(true)

  await toggle.click()
  await expect(status.getByText('正在保存…', { exact: true }).filter({ visible: true })).toBeVisible()
  await expect.poll(geometry).toEqual(initial)
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:finish-tool-save')))
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(status.getByText('已保存', { exact: true }).filter({ visible: true })).toBeVisible()
  await expect.poll(geometry).toEqual(initial)
})

test('task overview and storage icons align in the synthetic preview', async ({ page }) => {
  await page.goto('/e2e/fixtures/control-style-preview.html?panel=overview')
  await expect(page.getByTestId('task-workspace-root-status')).toHaveText('空闲')

  await page.goto('/e2e/fixtures/control-style-preview.html?panel=storage')
  const row = page.getByTestId('storage-bucket-debug-logs')
  await expect(row).toBeVisible()
  const geometry = await page.evaluate(() => {
    const heading = [...document.querySelectorAll('h2')].find(element => element.textContent === '目录占用')!
    const headerIcon = heading.parentElement!.parentElement!.querySelector('[aria-hidden="true"]')!.getBoundingClientRect()
    const rowIcon = document.querySelector('[data-testid="storage-bucket-debug-logs"] [aria-hidden="true"]')!.getBoundingClientRect()
    return { headerX: headerIcon.x, rowX: rowIcon.x, headerWidth: headerIcon.width, rowWidth: rowIcon.width }
  })
  expect(Math.abs(geometry.headerX - geometry.rowX)).toBeLessThanOrEqual(0.5)
  expect(geometry.headerWidth).toBe(geometry.rowWidth)
})

test('scheduler defaults to the local target and keeps workflow spacing; disclosures toggle', async ({ page }) => {
  await page.goto('/e2e/fixtures/control-style-preview.html')
  const target = page.getByTestId('automation-target')
  await expect(target).toBeVisible()
  await expect(target.locator('option:checked')).toHaveText('当前计算机')

  await page.getByTestId('scheduled-task-kind').selectOption('workflow')
  const workflow = page.getByTestId('scheduled-workflow-choice')
  await expect(workflow.locator('option').filter({ hasText: '旅游攻略工作流' })).toHaveCount(1)
  const spacing = await page.evaluate(() => {
    const choice = document.querySelector('[data-testid="scheduled-workflow-choice"]')!.getBoundingClientRect()
    const title = document.querySelector('[data-testid="automation-title"]')!.closest('label')!.getBoundingClientRect()
    return title.top - choice.bottom
  })
  expect(spacing).toBeGreaterThanOrEqual(24)

  await page.goto('/e2e/fixtures/control-style-preview.html?panel=proxy')
  const disclosure = page.getByTestId('plugins-proxy-details')
  await expect(disclosure).not.toHaveAttribute('open', '')
  await disclosure.locator('summary').click()
  await expect(disclosure).toHaveAttribute('open', '')
})

test('wiki upload control opens a multiple-file picker', async ({ page }) => {
  await page.goto('/e2e/fixtures/control-style-preview.html?panel=upload')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('wiki-upload-browse').click()
  const chooser = await chooserPromise
  expect(chooser.isMultiple()).toBe(true)
  await chooser.setFiles([])
})
