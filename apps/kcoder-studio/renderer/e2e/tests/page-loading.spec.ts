import { expect, test, type Locator } from '@playwright/test'

async function expectCentered(status: Locator, container: Locator) {
  const item = await status.boundingBox()
  const area = await container.boundingBox()
  expect(item).not.toBeNull()
  expect(area).not.toBeNull()
  expect(Math.abs(item!.x + item!.width / 2 - area!.x - area!.width / 2)).toBeLessThan(2)
  expect(Math.abs(item!.y + item!.height / 2 - area!.y - area!.height / 2)).toBeLessThan(2)
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: actual HTML placeholder and deferred feature keep a themed, centered loading state`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90000)
    // Hold only the app entry; the actual HTML, startup entry and styles are served by Vite.
    let releaseApp!: () => void
    const appHeld = new Promise<void>(resolve => {
      releaseApp = resolve
    })
    await page.addInitScript(mode => {
      localStorage.setItem('wework.appearance', JSON.stringify({ mode }))
    }, theme)
    await page.emulateMedia({
      colorScheme: theme === 'light' ? 'dark' : 'light',
      reducedMotion: 'reduce',
    })
    await page.route(/\/src\/main\.tsx(?:\?.*)?$/, async route => {
      await appHeld
      await route.fulfill({
        contentType: 'application/javascript',
        body: 'import "/e2e/fixtures/page-loading.tsx"',
      })
    })

    try {
      await page.goto('/', { waitUntil: 'commit' })
      const boot = page.locator('#kcoder-boot-loading')
      await expect(boot).toBeVisible()
      await expect(page.locator('#kcoder-boot-loading-style')).toHaveCount(1)
      await expectCentered(boot.getByRole('status'), boot)
      // A cold, isolated Vite optimizer can delay module transforms; the HTML remains visible.
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 45000 })
      await expect(boot).toHaveCSS(
        'background-color',
        theme === 'dark' ? 'rgb(17, 19, 22)' : 'rgb(255, 255, 255)'
      )
      await expectCentered(boot.getByRole('status'), boot)
      await expect(boot.locator('.kcoder-page-loading-spinner')).toHaveCSS('animation-name', 'none')
      await page.screenshot({ path: testInfo.outputPath(`startup-${theme}.png`) })

      releaseApp()
      await expect(page.getByText('Home ready')).toBeVisible({ timeout: 45000 })
      await expect(boot).toHaveCount(0)
      await page.getByRole('button', { name: 'Sidebar state: 0' }).click()
      await page.getByRole('button', { name: 'Open feature' }).click()
      const loading = page.getByTestId('page-loading-state')
      await expect(loading).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sidebar state: 1' })).toBeVisible()
      await expectCentered(loading.getByRole('status'), page.getByTestId('feature-content'))
      await expect(loading).toHaveCSS(
        'background-color',
        theme === 'dark' ? 'rgb(17, 19, 22)' : 'rgb(255, 255, 255)'
      )
      await page.screenshot({ path: testInfo.outputPath(`feature-loading-${theme}.png`) })
      await page.getByRole('button', { name: 'Finish loading' }).click()
      await expect(page.getByText('Feature ready')).toBeVisible()
      await expect(loading).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Sidebar state: 1' })).toBeVisible()
    } finally {
      releaseApp()
    }
  })
}

test('slow loading offers manual reload without navigating automatically', async ({ page }) => {
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, route =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'import "/e2e/fixtures/page-loading.tsx"',
    })
  )
  await page.goto('/')
  await page.clock.install()
  await page.getByRole('button', { name: 'Open feature' }).click()
  const reload = page.getByRole('button', { name: '重新加载页面' })
  await expect(reload).toHaveCount(0)
  await page.clock.fastForward(10000)
  await expect(reload).toBeVisible()
  await expect(page.getByText('加载时间较长', { exact: false })).toBeVisible()
  await page.clock.fastForward(20000)
  await expect(page.getByTestId('page-loading-state')).toBeVisible()
  await expect(page.getByTestId('page-loading-state').locator('.kcoder-page-loading-spinner')).toHaveCSS('animation-iteration-count', 'infinite')
  await Promise.all([page.waitForEvent('domcontentloaded'), reload.click()])
  await expect(page.getByText('Home ready')).toBeVisible()
})

test('cold opening a deferred route keeps the startup scene until its content commits', async ({ page }) => {
  await page.clock.install()
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, route =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'import "/e2e/fixtures/page-loading.tsx"',
    })
  )
  await page.goto('/settings/access-links?initial-feature')
  const startup = page.getByTestId('kcoder-startup-scene')
  const routeLoading = page.getByTestId('page-loading-state')
  await expect(startup).toBeVisible()
  await expect(routeLoading).toHaveCount(1)
  await expect(routeLoading).toBeHidden()
  const hint = page.getByTestId('local-runtime-slow-startup-help')
  await expect(hint).toBeHidden()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const before = await startup.boundingBox()
  expect(before).not.toBeNull()
  await page.clock.fastForward(10000)
  await expect(hint).toBeVisible()
  expect(await startup.boundingBox()).toEqual(before)
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-finish-loading')))
  await expect(page.getByText('Feature ready')).toBeVisible()
  await expect(startup).toHaveCount(0)
  await expect(routeLoading).toHaveCount(0)
})
