import { expect, test } from 'vitest'
import { WorkspaceScanProgress } from './workspaceScanProgress'

test('returns the first ready project before the final scan without polling', async () => {
  const progress = new WorkspaceScanProgress<string[]>()
  const first = progress.read(0)
  progress.publish(['current'])
  expect(await first).toEqual({ revision: 1, complete: false, snapshot: ['current'] })
  const next = progress.read(1)
  progress.finish(['current', 'other'])
  expect(await next).toEqual({ revision: 2, complete: true, snapshot: ['current', 'other'] })
})

test('coalesces unread progress and rejects invalid cursors', async () => {
  const progress = new WorkspaceScanProgress<string[]>()
  progress.publish(['current'])
  progress.publish(['current', 'second'])
  expect(await progress.read(0)).toMatchObject({ revision: 2, snapshot: ['current', 'second'] })
  for (const cursor of [-1, 0.5, 3, NaN, Infinity]) {
    await expect(progress.read(cursor)).rejects.toThrow('Invalid workspace scan revision')
  }
})

test('disposal wakes every pending reader and refuses late publications', async () => {
  const progress = new WorkspaceScanProgress<string[]>()
  const first = expect(progress.read(0)).rejects.toThrow('Runtime disposed')
  const second = expect(progress.read(0)).rejects.toThrow('Runtime disposed')
  progress.fail(new Error('Runtime disposed'))
  progress.publish(['stale'])
  progress.finish(['stale'])
  await Promise.all([first, second])
  await expect(progress.read(0)).rejects.toThrow('Runtime disposed')
})
