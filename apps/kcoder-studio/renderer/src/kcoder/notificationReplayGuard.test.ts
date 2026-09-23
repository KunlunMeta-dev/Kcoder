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

test('logical background identities survive process and transport sequence changes', () => {
  const guard = new NotificationReplayGuard()
  const identity = {
    run: { parentSessionId: 'parent', agentId: 'agent', runId: 'run-1' },
    eventId: 'done',
    runSequence: 3,
  }
  const frame = {
    serverId: 'first',
    threadId: 'parent',
    sequence: 1,
    identity,
    event: { type: 'background_job_started' },
  }
  expect(guard.accept('item/event', frame, 'target')).toBe(true)
  expect(
    guard.accept('item/event', { ...frame, serverId: 'restart', sequence: 42 }, 'target')
  ).toBe(false)
  expect(guard.accept('item/event', frame, 'other-target')).toBe(true)
  expect(
    guard.accept(
      'item/event',
      { ...frame, identity: { ...identity, run: { ...identity.run, runId: 'run-2' } } },
      'target'
    )
  ).toBe(true)
})

test('late events cannot finish a newer run and terminal progress cannot reopen it', () => {
  const guard = new NotificationReplayGuard()
  const frame = (runId: string, eventId: string, type: string) => ({
    identity: {
      run: { parentSessionId: 'parent', agentId: 'agent', runId },
      eventId,
      runSequence: 1,
    },
    event: { type },
  })
  expect(
    guard.accept('item/event', frame('one', 'start', 'background_job_started'), 'target')
  ).toBe(true)
  expect(
    guard.accept('item/event', frame('two', 'start', 'background_job_started'), 'target')
  ).toBe(true)
  expect(
    guard.accept('item/event', frame('one', 'done', 'background_job_completed'), 'target')
  ).toBe(false)
  expect(
    guard.accept('item/event', frame('one', 'start-again', 'background_job_started'), 'target')
  ).toBe(false)
  expect(
    guard.accept('item/event', frame('two', 'done', 'background_job_completed'), 'target')
  ).toBe(true)
  expect(
    guard.accept('item/event', frame('two', 'progress', 'background_job_progress'), 'target')
  ).toBe(false)
})

test('rejects reordered status updates and releases failed terminal forwarding', () => {
  const guard = new NotificationReplayGuard()
  const frame = (eventId: string, runSequence: number, type: string) => ({
    identity: { run: { parentSessionId: 'p', agentId: 'a', runId: 'r' }, eventId, runSequence },
    event: { type },
  })
  expect(guard.accept('item/event', frame('progress', 5, 'background_job_progress'))).toBe(true)
  expect(guard.accept('item/event', frame('old-pause', 4, 'background_job_paused'))).toBe(false)
  const terminal = frame('terminal', Number.MAX_SAFE_INTEGER, 'background_job_completed')
  expect(guard.accept('item/event', terminal)).toBe(true)
  guard.release('item/event', terminal)
  expect(guard.accept('item/event', terminal)).toBe(true)
  expect(guard.accept('item/event', terminal)).toBe(false)
})

test('a successfully projected terminal snapshot cannot be replaced by stale running state', () => {
  const guard = new NotificationReplayGuard()
  const run = { parentSessionId: 'p', agentId: 'a', runId: 'r' }
  expect(guard.canSeedBackgroundRun(run, 'completed')).toBe(true)
  expect(guard.seedBackgroundRun(run, 'completed')).toBe(true)
  expect(guard.canSeedBackgroundRun(run, 'running')).toBe(false)
  expect(
    guard.accept('item/event', {
      identity: { run, eventId: 'progress', runSequence: 4 },
      event: { type: 'background_job_progress' },
    })
  ).toBe(false)
})

test('a reconnect snapshot can advance a completed run without reviving an old run', () => {
  const guard = new NotificationReplayGuard()
  const old = { parentSessionId: 'p', agentId: 'a', runId: 'old' }
  const next = { ...old, runId: 'next' }
  guard.seedBackgroundRun(old, 'completed')
  expect(guard.canSeedBackgroundRun(next, 'running')).toBe(true)
  guard.seedBackgroundRun(next, 'running')
  expect(
    guard.accept('item/event', {
      identity: { run: next, eventId: 'progress', runSequence: 1 },
      event: { type: 'background_job_progress' },
    })
  ).toBe(true)
  expect(guard.canSeedBackgroundRun(old, 'completed')).toBe(false)
})
