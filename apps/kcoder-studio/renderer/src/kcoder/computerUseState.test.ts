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
