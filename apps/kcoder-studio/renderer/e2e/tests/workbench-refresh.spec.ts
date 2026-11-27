import { expect, test } from '@playwright/test'

test('workbench refresh scopes receipts and pauses hidden environment polling (model-independent)', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.clock.install({ time: new Date('2026-11-22T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-22T12:00:01Z'))
  await page.goto('/e2e/fixtures/workbench-refresh.html')
  const readCounts = () => page.evaluate(() => {
    const calls = window.__workbenchRefreshFixture.calls()
    return { a: calls.filter(call => call.kind === 'queue' && call.deviceId === 'target-a').length,
      b: calls.filter(call => call.kind === 'queue' && call.deviceId === 'target-b').length,
      environment: calls.filter(call => call.kind === 'environment').length }
  })
  await expect.poll(readCounts).toEqual({ a: 1, b: 1, environment: 1 })
  await expect(page.getByTestId('environment-workspace')).toHaveText('/owned-a')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', {
    detail: { deviceId: 'target-a', taskId: 'task-a' },
  })))
  await expect.poll(readCounts).toEqual({ a: 2, b: 1, environment: 1 })
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(15_000)
  // Unknown input recovery remains live; only the hidden environment polls pause.
  await expect.poll(readCounts).toEqual({ a: 3, b: 2, environment: 1 })
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(readCounts).toEqual({ a: 3, b: 2, environment: 2 })
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.getByRole('button', { name: 'Finish turn', exact: true }).click()
  await expect.poll(readCounts).toEqual({ a: 3, b: 2, environment: 3 })
  const calls = await page.evaluate(() => window.__workbenchRefreshFixture.calls())
  expect(calls.at(-1)).toEqual({ kind: 'environment', deviceId: 'target-a', force: true })
  expect(errors).toEqual([])
  await testInfo.attach('workbench-read-calls', { body: JSON.stringify(calls), contentType: 'application/json' })
})
