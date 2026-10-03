import { expect, test } from '@playwright/test'
import { StudioApp } from '../fixtures/studio-app'

test('exposes a CI automation bridge and renders the login route without Tauri', async ({
  page,
}) => {
  const app = new StudioApp(page)

  await app.goto('/')

  await expect(page.getByTestId('login-form')).toBeVisible()
  await expect(page.getByTestId('login-username-input')).toBeVisible()
  await expect(page.getByTestId('login-password-input')).toBeVisible()

  await expect.poll(() => app.route()).toBe('/login')
  await expect.poll(async () => (await app.runtimeConfig())?.runtimeMode).toBe('backend')

  const loginTestIds = await app.testIds('login-')
  expect(loginTestIds).toContain('login-form')
  expect(loginTestIds).toContain('login-submit-button')
})
