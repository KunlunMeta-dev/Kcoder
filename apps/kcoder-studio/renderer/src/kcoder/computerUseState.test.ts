import { expect, test } from 'vitest'
import { ComputerUseStateStore } from './computerUseState'
test('a confirmed cleanup retry can recover failure without reactivating input', () => {
  const store = new ComputerUseStateStore(),
    owner = {}
  const apply = (state: string) =>
    store.apply(owner, 'local', 'task', 'turn', {
      state,
      target: 'local_windows_desktop',
    })
  for (const state of ['active', 'stop_failed', 'stopping', 'stopped']) {
    apply(state)
    expect(store.get('local', 'task')?.state).toBe(state)
  }
  apply('active')
  expect(store.get('local', 'task')?.state).toBe('stopped')
})
const event = (state: string) => ({ state, target: 'local_windows_desktop' })
test('scopes observations and never infers stopped from turn completion or disconnect', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    other = {}
  store.apply(owner, 'local', 'task', 'turn', event('active'))
  expect(store.get('remote', 'task')).toBeNull()
  expect(store.get('local', 'other')).toBeNull()
  store.unconfirmed(other, 'local', 'task')
  expect(store.get('local', 'task')?.state).toBe('active')
  store.unconfirmed(owner, 'local', 'task', 'another-turn')
  expect(store.get('local', 'task')?.state).toBe('active')
  store.unconfirmed(owner, 'local', 'task')
  expect(store.get('local', 'task')?.state).toBe('unknown')
  store.apply(owner, 'local', 'task', 'turn', event('active'))
  expect(store.get('local', 'task')?.state).toBe('unknown')
  store.apply(owner, 'local', 'task', 'turn', event('stopped'))
  expect(store.get('local', 'task')?.state).toBe('stopped')
})
test('rejects malformed state, preserves terminal state, and accepts a new authorized turn', () => {
  const store = new ComputerUseStateStore(),
    owner = {}
  store.apply(owner, 'local', 'task', 'turn', event('invented'))
  store.apply(owner, 'local', 'task', 'turn', { state: 'active', target: 'remote' })
  expect(store.get('local', 'task')).toBeNull()
  for (const state of ['active', 'stopping', 'active', 'stop_failed', 'active'])
    store.apply(owner, 'local', 'task', 'turn', event(state))
  expect(store.get('local', 'task')?.state).toBe('stop_failed')
  store.apply(owner, 'local', 'task', 'next', event('active'))
  expect(store.get('local', 'task')?.state).toBe('active')
  store.dispose({})
  expect(store.get('local', 'task')?.state).toBe('active')
  store.dispose(owner)
  expect(store.get('local', 'task')).toBeNull()
})

test('same-state diagnostics update while cleanup uncertainty and revoked authorization stay independent', () => {
  const store = new ComputerUseStateStore(),
    owner = {}
  const facts = {
    authorization: 'valid',
    channel: 'unavailable',
    cleanup: 'unknown',
    failureCode: 'connection_lost',
  }
  store.apply(owner, 'local', 'task', 'turn', {
    ...event('stop_failed'),
    diagnostic: facts,
    recoveryAvailable: true,
  })
  store.apply(owner, 'local', 'task', 'turn', {
    ...event('stop_failed'),
    diagnostic: { ...facts, cleanup: 'failed', failureCode: 'cleanup_failed' },
    recoveryAvailable: true,
  })
  expect(store.get('local', 'task')?.diagnostic?.failureCode).toBe('cleanup_failed')
  expect(store.get('local', 'task')?.recoveryAvailable).toBe(true)
  store.revoked(owner, 'local', 'task')
  expect(store.get('local', 'task')?.diagnostic?.authorization).toBe('revoked')
  expect(store.get('local', 'task')?.diagnostic?.cleanup).toBe('failed')
  expect(store.get('local', 'task')?.recoveryAvailable).toBe(false)
})

test('a trusted new attempt can reactivate the same turn only after its start sequence', () => {
  const store = new ComputerUseStateStore(),
    owner = {}
  store.apply(owner, 'local', 'task', 'turn', { ...event('stopped'), sequence: 2 })
  store.beginAttempt({}, 'local', 'task', 'turn', 'retry', 5)
  store.apply(owner, 'local', 'task', 'turn', { ...event('active'), sequence: 6 })
  expect(store.get('local', 'task')?.state).toBe('stopped')
  store.beginAttempt(owner, 'local', 'task', 'turn', 'retry', 5)
  store.apply(owner, 'local', 'task', 'turn', { ...event('stopped'), sequence: 4 })
  expect(store.get('local', 'task')?.attemptId).toBe('turn')
  store.apply(owner, 'local', 'task', 'turn', { ...event('active'), sequence: 6 })
  expect(store.get('local', 'task')).toMatchObject({ state: 'active', attemptId: 'retry' })
  store.apply(owner, 'local', 'task', 'turn', { ...event('stopped'), sequence: 4 })
  expect(store.get('local', 'task')?.state).toBe('active')
})
