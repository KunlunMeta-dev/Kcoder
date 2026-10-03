import { expect, test } from 'vitest'
import { BackgroundJobRegistry } from './backgroundJobRegistry'

test('copied agent IDs stay isolated across targets and parent tasks', () => {
  const jobs = new BackgroundJobRegistry()
  const a = { taskId: 'parent', serverId: 'a', runId: 'one' }
  const b = { ...a, serverId: 'b' }
  const c = { ...a, taskId: 'other' }
  for (const job of [a, b, c]) jobs.set('agent', job)
  expect(jobs.get('agent', 'parent', 'a')).toBe(a)
  expect(jobs.get('agent', 'parent', 'b')).toBe(b)
  expect(jobs.get('agent', 'other', 'a')).toBe(c)
  expect([...jobs.entries()]).toHaveLength(3)
})

test('an old asynchronous terminal cannot delete the replacement run', () => {
  const jobs = new BackgroundJobRegistry()
  const old = { taskId: 'parent', serverId: 'target', runId: 'one' }
  const next = { ...old, runId: 'two' }
  jobs.set('agent', old)
  jobs.set('agent', next)
  expect(jobs.delete('agent', old)).toBe(false)
  expect(jobs.get('agent', 'parent', 'target')).toBe(next)
  expect(jobs.delete('agent', next)).toBe(true)
})
