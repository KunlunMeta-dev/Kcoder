import { expect, test } from 'vitest'
import { scanWorkspaces } from './workspaceScan'

test('starts four independent workspace scans without waiting for a slow first one', async () => {
  const started: number[] = []
  const release = new Map<number, () => void>()
  const done = scanWorkspaces(
    [0, 1, 2, 3, 4],
    async item => {
      started.push(item)
      await new Promise<void>(resolve => release.set(item, resolve))
    },
    () => false
  )
  expect(started).toEqual([0, 1, 2, 3])
  release.get(1)!()
  await Promise.resolve()
  await Promise.resolve()
  expect(started).toEqual([0, 1, 2, 3, 4])
  for (const resolve of release.values()) resolve()
  await done
})

test('does not schedule more work after runtime disposal', async () => {
  let cancelled = false
  const started: number[] = []
  const releases: Array<() => void> = []
  const done = scanWorkspaces(
    [0, 1, 2, 3, 4, 5],
    async item => {
      started.push(item)
      await new Promise<void>(resolve => releases.push(resolve))
    },
    () => cancelled
  )
  expect(started).toHaveLength(4)
  cancelled = true
  for (const release of releases) release()
  await done
  expect(started).toEqual([0, 1, 2, 3])
})
