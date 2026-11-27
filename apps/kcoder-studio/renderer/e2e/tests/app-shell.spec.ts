import { expect, test } from '@playwright/test'
import { StudioApp } from '../fixtures/studio-app'

test('exposes the automation bridge and explains how to open a standalone renderer', async ({
  page,
}) => {
  const app = new StudioApp(page)

  await app.goto('/')

  await expect(page.getByTestId('studio-gateway-required')).toBeVisible()
  await expect.poll(() => app.route()).toBe('/')
  await expect.poll(async () => (await app.runtimeConfig())?.runtimeMode).toBe('backend')

  expect(await app.testIds('login-')).toEqual([])
})
