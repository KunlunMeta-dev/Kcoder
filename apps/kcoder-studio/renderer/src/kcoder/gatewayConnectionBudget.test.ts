import { expect, test } from 'vitest'
import { GatewayConnectionBudget, gatewayReconnectDelay } from './gatewayConnectionBudget'

test('bounds concurrent handshakes, rejects queue overflow and releases failed slots', async () => {
  const budget = new GatewayConnectionBudget(2, 1)
  const releases: Array<() => void> = []
  let active = 0
  let maximum = 0
  const task = () =>
    budget.run(async () => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise<void>(resolve => releases.push(resolve))
      active--
    })
  const a = task(),
    b = task(),
    c = task()
  await expect(task()).rejects.toThrow('queue is full')
  expect(releases).toHaveLength(2)
  releases[0]()
  await a
  await Promise.resolve()
  expect(releases).toHaveLength(3)
  releases[1]()
  releases[2]()
  await Promise.all([b, c])
  expect(maximum).toBe(2)
  await expect(
    budget.run(async () => {
      throw new Error('failed')
    })
  ).rejects.toThrow('failed')
  await expect(budget.run(async () => 'recovered')).resolves.toBe('recovered')
})

test('queued cancellation does not launch a disposed client or block the next owner', async () => {
  const budget = new GatewayConnectionBudget(1, 1)
  let release!: () => void
  const live = budget.run(
    () =>
      new Promise<void>(resolve => {
        release = resolve
      })
  )
  const controller = new AbortController()
  let started = false
  const queued = budget.run(async () => {
    started = true
  }, controller.signal)
  controller.abort()
  await expect(queued).rejects.toThrow('cancelled')
  release()
  await live
  expect(started).toBe(false)
  await expect(budget.run(async () => true)).resolves.toBe(true)
})

test('reconnection jitter stays within the bounded backoff window', () => {
  expect(gatewayReconnectDelay(0, () => 1)).toBe(0)
  expect(gatewayReconnectDelay(1000, () => 0)).toBe(750)
  expect(gatewayReconnectDelay(1000, () => 1)).toBe(1250)
  expect(gatewayReconnectDelay(1000, () => 0.5)).toBe(1000)
})
