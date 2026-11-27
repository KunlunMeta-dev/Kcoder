import { expect, test } from '@playwright/test'

// Deterministic keyboard behavior of the real composer; no backend/model execution.
for (const width of [390, 1280]) {
  test(`exact slash commands activate with Enter and menu choices with Tab (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/e2e/fixtures/composer-slash.html')
    const editor = page.getByTestId('chat-message-input')
    const action = page.getByTestId('fixture-action')
    const submitted = page.getByTestId('fixture-submitted')
    await editor.fill('/')
    await page.getByTestId('slash-command-menu').waitFor()
    await editor.press('ArrowDown')
    await editor.press('Tab')
    await expect(action).toHaveText('goal')
    await expect(editor).toBeEmpty()
    for (const name of [
      'plan',
      'goal',
      'goal-pro',
      'orchestrate',
      'moa',
      'moa-plan',
      'compact',
      'model',
    ]) {
      const previousAction = await action.textContent()
      await editor.fill(`/${name}`)
      const option = page.getByTestId(`slash-command-option-${name}`)
      await expect(option).toBeVisible()
      await expect(option.locator('kbd')).toHaveText('Tab')
      await editor.press('Enter')
      if (name === 'model') {
        const search = page.getByTestId('slash-model-search-input')
        await expect(search).toBeFocused()
        await search.press('Enter')
        await expect(action).toHaveText(previousAction ?? '')
        await search.press('Tab')
        await expect(action).toHaveText('fixture-model')
      } else {
        await expect(action).toHaveText(name)
      }
      await expect(editor).toBeEmpty()
      await expect(submitted).toBeEmpty()
    }
    await editor.fill('/sample-skill')
    await expect(page.getByTestId('slash-command-option-skill-sample-skill')).toBeVisible()
    await editor.press('Enter')
    await expect(editor.locator('[data-composer-skill-reference]')).toHaveCount(1)
    await expect(submitted).toBeEmpty()
    await editor.fill('ordinary message')
    await editor.press('Enter')
    await expect(submitted).toHaveText('ordinary message')
  })
}

for (const scenario of [
  { width: 390, theme: 'light', locale: 'zh-CN' },
  { width: 1280, theme: 'dark', locale: 'en' },
]) {
  test(`plugins can be selected inside the current composer (${scenario.theme}, ${scenario.width}px)`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 800 })
    await page.goto(
      `/e2e/fixtures/composer-slash.html?theme=${scenario.theme}&locale=${scenario.locale}`
    )
    const editor = page.getByTestId('chat-message-input')
    for (const trigger of ['@', '$']) {
      await editor.fill(`${trigger}Factory`)
      await expect(page.locator('[data-testid^="local-plugin-option-"]')).toBeVisible()
      await editor.press('Shift+Enter')
      await expect(editor.locator('[data-composer-skill-reference]')).toHaveCount(0)
      await expect.poll(() => editor.evaluate(element => (element as HTMLElement & { value: string }).value))
        .toBe(`${trigger}Factory\n`)
      await expect(page.getByTestId('fixture-submitted')).toBeEmpty()
    }
    await editor.fill('请使用 $')
    const plugin = page.locator('[data-testid^="local-plugin-option-"]')
    await expect(plugin).toBeVisible()
    await expect(page.locator('[data-testid^="mention-plugin-skills-"]')).toHaveText(scenario.locale === 'en' ? 'Factory skills' : 'Factory 的技能')
    await expect(page.getByTestId('local-skill-option-factory-build')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('plugin-picker.png') })
    await plugin.click()
    await expect(editor.locator('[data-composer-skill-reference]')).toHaveAttribute(
      'data-composer-skill-reference',
      '[$Factory](plugin://factory@local)'
    )
    await expect(editor).toContainText('请使用')
    await expect(page.getByTestId('fixture-submitted')).toBeEmpty()
    await expect(page).toHaveURL(/composer-slash.html/)
    await editor.fill('$tools')
    await page.locator('[data-testid^="mention-plugin-skills-"]').click()
    const skill = page.getByTestId('local-skill-option-factory-build')
    await expect(skill).toBeVisible()
    await expect(editor).toHaveText('$')
    await skill.click()
    await expect(editor.locator('[data-composer-skill-reference]')).toHaveCount(1)
    await editor.getByTestId('local-skill-chip-factory-build').click()
    await expect(page.getByTestId('fixture-action')).toHaveText(String.raw`C:\Users\fixture\factory ((work))\skills\build\SKILL.md`)
    await expect(editor).not.toContainText('C:\\Users')
    await page.screenshot({ path: testInfo.outputPath('windows-skill-chip.png') })
    await expect(page.getByTestId('fixture-submitted')).toBeEmpty()
  })
}

test('disabled menu choices cannot consume drafts or submit messages', async ({ page }) => {
  await page.goto('/e2e/fixtures/composer-slash.html?disabled=true')
  const editor = page.getByTestId('chat-message-input')
  await editor.fill('$Factory')
  const plugin = page.locator('[data-testid^="local-plugin-option-"]')
  await expect(plugin).toBeDisabled()
  for (const key of ['Tab', 'Enter']) {
    await editor.press(key)
    await expect(editor).toHaveText('$Factory')
    await expect(page.getByTestId('fixture-submitted')).toBeEmpty()
  }
})
