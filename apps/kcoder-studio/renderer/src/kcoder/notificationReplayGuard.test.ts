import { expect, test } from 'vitest'
import { NotificationReplayGuard } from './notificationReplayGuard'

test('deduplicates the same event across clients without losing interleaved or reordered events', () => {
  const guard = new NotificationReplayGuard()
  const frame = { serverId: 'process-a', threadId: 'thread', sequence: 2 }
  expect(guard.accept('item/delta', frame, 'local')).toBe(true)
  expect(guard.accept('item/delta', frame, 'local')).toBe(false)
  expect(guard.accept('item/delta', { ...frame, sequence: 1 }, 'local')).toBe(true)
  expect(guard.accept('item/delta', { ...frame, serverId: 'process-b' }, 'local')).toBe(true)
  expect(guard.accept('item/delta', { ...frame, threadId: 'other' }, 'local')).toBe(true)
})

test('bounds retained event identities and leaves unsequenced events untouched', () => {
  const guard = new NotificationReplayGuard(2)
  for (const sequence of [1, 2, 3, 1])
    expect(guard.accept('item/delta', { serverId: 'p', threadId: 't', sequence })).toBe(true)
  expect(guard.accept('thread/started', {})).toBe(true)
  expect(guard.accept('thread/started', {})).toBe(true)
})
