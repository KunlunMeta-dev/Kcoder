import { expect, test } from '@playwright/test'

for (const scenario of [
  { width: 1280, locale: 'zh-CN', theme: 'light' },
  { width: 900, locale: 'en', theme: 'dark' },
  { width: 390, locale: 'zh-CN', theme: 'light' },
]) {
  test(`skill saving preserves content and card geometry at ${scenario.width}px in ${scenario.locale}`, async ({
    page,
  }, testInfo) => {
    await page.route('**/api/servers', route =>
      route.fulfill({
        json: {
          servers: [
            { id: 'local', label: 'Fixture', transport: 'local', workspacePath: 'D:/fixture' },
          ],
        },
      })
    )
    await page.setViewportSize({ width: scenario.width, height: 900 })
    await page.goto(
      `/e2e/fixtures/reference-panels.html?panel=plugins&skillsSaving=1&locale=${scenario.locale}&theme=${scenario.theme}`
    )
    await page.getByTestId('kcoder-plugin-tab-skills').click()
    const row = page.getByTestId('kcoder-skill-row').first()
    const toggle = row.getByTestId('kcoder-skill-toggle')
    await toggle.scrollIntoViewIfNeeded()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    const readGeometry = () =>
      row.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const content = element
          .querySelector('[data-testid=kcoder-skill-content]')!
          .getBoundingClientRect()
        const control = element
          .querySelector('[data-testid=kcoder-skill-toggle]')!
          .getBoundingClientRect()
        return {
          cardHeight: rect.height,
          contentWidth: content.width,
          contentHeight: content.height,
          controlX: control.x,
        }
      })
    const before = await readGeometry()
    await toggle.click()
    await expect(toggle).toBeDisabled()
    await expect(row.getByTestId('kcoder-skill-saving-status')).toBeVisible()
    const during = await readGeometry()
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      expect(
        Math.abs(during[key] - before[key]),
        `${key} must remain stable during the request`
      ).toBeLessThanOrEqual(1)
    }
    await row.screenshot({ path: testInfo.outputPath('skill-saving.png') })
    await page.evaluate(() =>
      (window as Window & { completeSkillSave?: () => void }).completeSkillSave!()
    )
    await expect(toggle).toBeEnabled()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(row.getByTestId('kcoder-skill-saving-status')).not.toBeVisible()
    expect((await readGeometry()).contentWidth).toBeCloseTo(before.contentWidth, 0)
  })
}
