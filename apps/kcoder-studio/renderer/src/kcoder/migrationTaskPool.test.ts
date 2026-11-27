import { expect, it, vi } from 'vitest'
import { runMigrationTasks } from './migrationTaskPool'
it('shares the same two-lane bound across callers while repeated job keys remain ordered', async () => {
  const starts: string[] = [],
    finish: Array<() => void> = []
  const running = runMigrationTasks(
    ['a:1', 'b:1', 'a:2', 'c:1'],
    { concurrency: 2, key: value => value[0], check: () => {} },
    async value => {
      starts.push(value)
      await new Promise<void>(resolve => finish.push(resolve))
    }
  )
  expect(starts).toEqual(['a:1', 'b:1'])
  finish[0]()
  await vi.waitFor(() => expect(starts).toContain('a:2'))
  expect(starts).not.toContain('c:1')
  finish[1]()
  await vi.waitFor(() => expect(starts).toContain('c:1'))
  finish.slice(2).forEach(resolve => resolve())
  await running
})
it('drains other admitted lanes before rejecting and never admits a queued third job', async () => {
  let reject!: (cause: unknown) => void, finish!: () => void
  const started: number[] = []
  const running = runMigrationTasks(
    [1, 2, 3],
    { concurrency: 2, key: String, check: () => {} },
    async id => {
      started.push(id)
      await new Promise<void>((resolve, fail) => {
        if (id === 1) reject = fail
        else finish = resolve
      })
    }
  )
  const settled = vi.fn()
  const failure = running.catch(error => {
    settled()
    return error
  })
  reject(new Error('original failure'))
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  finish()
  expect((await failure).message).toBe('original failure')
  expect(started).toEqual([1, 2])
})

it('admits sixty-four independent jobs and queues the sixty-fifth until a real lane finishes', async () => {
  const started: number[] = [],
    pending = new Map<number, () => void>()
  let peak = 0,
    active = 0
  const running = runMigrationTasks(
    Array.from({ length: 65 }, (_, index) => index),
    { key: String, check: () => {} },
    async index => {
      started.push(index)
      active++
      peak = Math.max(peak, active)
      await new Promise<void>(resolve =>
        pending.set(index, () => {
          pending.delete(index)
          active--
          resolve()
        })
      )
    }
  )
  expect(started).toHaveLength(64)
  expect(started).not.toContain(64)
  expect(peak).toBe(64)
  pending.get(0)!()
  await vi.waitFor(() => expect(started).toHaveLength(65))
  expect(peak).toBe(64)
  Array.from(pending.values()).forEach(done => done())
  await running
  expect(active).toBe(0)
})
