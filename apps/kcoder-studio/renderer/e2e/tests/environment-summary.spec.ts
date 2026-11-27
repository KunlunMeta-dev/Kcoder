import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    for (const edge of ['top', 'bottom']) {
      test(`branch explanation escapes the subagent stacking context (${theme}, ${width}, ${edge})`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 700 })
        await page.goto(`/e2e/fixtures/environment-summary.html?docked=1&edge=${edge}&theme=${theme}`)
        const row = page.getByTestId('environment-changes-button')
        const description = page.getByTestId('environment-changes-description')
        const agents = page.getByTestId('subagent-status-toggle-button')
        await expect(agents).toBeVisible()
        await row.hover()
        await expect(description).toBeVisible()
        expect(await description.evaluate(node => node.parentElement === document.body)).toBe(true)
        const box = (await description.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(15)
        expect(box.y).toBeGreaterThanOrEqual(15)
        expect(box.x + box.width).toBeLessThanOrEqual(width - 15)
        expect(box.y + box.height).toBeLessThanOrEqual(685)
        if (edge === 'bottom') expect(box.y + box.height).toBeLessThanOrEqual((await row.boundingBox())!.y)
        await page.screenshot({ path: testInfo.outputPath(`environment-tooltip-${theme}-${width}-${edge}.png`) })
        await row.focus()
        await row.press('Escape')
        await expect(description).toBeHidden()
        await agents.click()
        await expect(page.getByTestId('subagent-status-panel')).toBeVisible()
      })
    }
  }
}

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`branch summary explains its scope on hover and focus (${theme}, ${width})`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(`/e2e/fixtures/environment-summary.html?theme=${theme}`)
      const row = page.getByTestId('environment-changes-button')
      const counts = page.getByTestId('environment-change-counts')
      const explanation = page.getByTestId('environment-changes-description')
      await expect(row).toBeVisible()
      await expect(counts).toHaveText('+3,438-220')
      await expect(page.getByTestId('environment-comparison-base')).toContainText(
        'origin/main 的共同祖先'
      )
      await expect(explanation).toBeHidden()
      await row.hover()
      await expect(explanation).toBeVisible()
      await expect(explanation).toContainText('不限于本次对话')
      await expect(explanation).toContainText('1 个二进制文件不计入增删行数')
      const box = await explanation.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      const [added, removed] = await counts.locator('span').all()
      const addedBox = await added.boundingBox()
      const removedBox = await removed.boundingBox()
      expect(addedBox!.y).toBe(removedBox!.y)
      await page.mouse.move(0, 0)
      await expect(explanation).toBeHidden()
      await row.focus()
      await expect(explanation).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`branch-summary-${theme}-${width}.png`) })
      await row.press('Enter')
      await expect(page.getByTestId('review-requested')).toBeVisible()
    })
  }
}

test('legacy statistics disclose their unknown base and plain directories do not invent counts', async ({
  page,
}) => {
  await page.goto('/e2e/fixtures/environment-summary.html?state=legacy')
  await expect(page.getByTestId('environment-comparison-base')).toContainText(
    '后端尚未提供比较基准'
  )
  await expect(page.getByText('旧版后端：统计范围尚未确认。')).toBeVisible()
  await page.goto('/e2e/fixtures/environment-summary.html?state=plain')
  await expect(page.getByTestId('environment-change-counts')).toHaveText('—')
  await expect(page.getByTestId('environment-changes-button')).toBeDisabled()
})

test('English summary explains the comparison and counted units', async ({ page }) => {
  await page.goto('/e2e/fixtures/environment-summary.html?locale=en')
  const row = page.getByRole('button', { name: /Branch changes/ })
  await row.focus()
  await expect(page.getByRole('tooltip')).toContainText('added/deleted text lines')
  await expect(page.getByTestId('environment-comparison-base')).toContainText(
    'merge base of origin/main'
  )
})
