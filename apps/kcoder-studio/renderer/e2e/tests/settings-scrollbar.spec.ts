import { expect, test } from '@playwright/test'

test.use({
  launchOptions: {
    executablePath: process.env.KCODER_STUDIO_E2E_BROWSER_EXECUTABLE || undefined,
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: ['--disable-features=OverlayScrollbar'],
  },
})

test('settings directory keeps its content width as overflow changes', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 440 })
  await page.goto('/e2e/fixtures/reference-panels.html?panel=settings-sidebar&locale=en')
  const nav = page.getByTestId('settings-sidebar-nav')
  await expect(nav).toBeVisible()
  await page.addStyleTag({
    content: '[data-testid="settings-sidebar-nav"] { scrollbar-width: auto; }' +
      '[data-testid="settings-sidebar-nav"]::-webkit-scrollbar { width: 16px; }',
  })
  const measure = () => nav.evaluate(node => ({
    overflow: node.scrollHeight > node.clientHeight,
    width: node.clientWidth,
    gutter: node.offsetWidth - node.clientWidth,
  }))
  await expect.poll(async () => (await measure()).overflow).toBe(true)
  const expanded = await measure()
  expect(expanded.gutter).toBeGreaterThan(0)
  await page.getByTestId('settings-search').fill('About')
  await expect.poll(async () => (await measure()).overflow).toBe(false)
  expect(await measure()).toEqual({ ...expanded, overflow: false })
  await page.getByTestId('settings-search').clear()
  await expect.poll(measure).toEqual(expanded)
})
