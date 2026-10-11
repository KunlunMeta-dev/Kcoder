import { expect, test, vi } from 'vitest'
import type { Page, Request } from '@playwright/test'
import { StudioApp } from '../../e2e/fixtures/studio-app'

function pageFixture(failure: string | null, repeats = false) {
  let listener: ((request: Request) => void) | undefined
  let attempts = 0
  const page = {
    on: vi.fn((_event: string, callback: (request: Request) => void) => { listener = callback }),
    off: vi.fn(() => { listener = undefined }),
    goto: vi.fn(async () => {
      attempts += 1
      if (failure && (attempts === 1 || repeats)) {
        listener?.({ resourceType: () => 'script', failure: () => ({ errorText: failure }) } as Request)
        if (failure !== 'net::ERR_NETWORK_CHANGED') throw new Error(failure)
      }
    }),
    evaluate: vi.fn(async () => true),
    waitForTimeout: vi.fn(async () => undefined),
  }
  return { page, app: new StudioApp(page as unknown as Page) }
}

test('recovers initial network-change resource abort once', async () => {
  const { page, app } = pageFixture('net::ERR_NETWORK_CHANGED')
  await app.goto('/login')
  expect(page.goto).toHaveBeenCalledTimes(2)
  expect(page.goto).toHaveBeenLastCalledWith('/login')
  expect(page.off).toHaveBeenCalledTimes(2)
})

test('retains repeated network-change failures and cleans listeners', async () => {
  const { page, app } = pageFixture('net::ERR_NETWORK_CHANGED', true)
  await expect(app.goto('/login')).rejects.toThrow('ERR_NETWORK_CHANGED')
  expect(page.goto).toHaveBeenCalledTimes(2)
  expect(page.off).toHaveBeenCalledTimes(2)
})

test('does not retry unrelated navigation failures', async () => {
  const { page, app } = pageFixture('net::ERR_CONNECTION_REFUSED')
  await expect(app.goto('/login')).rejects.toThrow('ERR_CONNECTION_REFUSED')
  expect(page.goto).toHaveBeenCalledTimes(1)
  expect(page.off).toHaveBeenCalledTimes(1)
})
