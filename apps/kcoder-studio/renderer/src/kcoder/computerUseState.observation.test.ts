import { expect, test } from 'vitest'
import { ComputerUseStateStore } from './computerUseState'

const observation = (state: string) => ({ state, target: 'local_windows_desktop' })

test('a reconnect snapshot uses the new client sequence namespace', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    oldClient = {},
    newClient = {}
  store.apply(owner, 'local', 'task', 'turn', { ...observation('active'), sequence: 100 }, oldClient)
  store.unconfirmed(owner, 'local', 'task', 'turn')
  const token = store.captureUnsettled(owner, 'local', 'task', newClient)

  expect(token).not.toBeNull()
  expect(
    store.applyObservation(token!, newClient, 1, observation('stopped'))
  ).toBe(true)
  expect(store.get('local', 'task')?.state).toBe('stopped')
})

test('one GatewayClient can reset its sequence under a new connection id', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    oldConnectionId = 'rpc-12-3',
    newConnectionId = 'rpc-12-4'
  store.apply(
    owner,
    'local',
    'task',
    'turn',
    { ...observation('active'), sequence: 100 },
    oldConnectionId
  )
  store.unconfirmed(owner, 'local', 'task', 'turn')
  const token = store.captureUnsettled(owner, 'local', 'task', newConnectionId)

  expect(token).not.toBeNull()
  expect(
    store.applyObservation(token!, newConnectionId, 1, observation('stopped'))
  ).toBe(true)
  expect(store.get('local', 'task')?.state).toBe('stopped')
})

test('a fresh active-turn observation replaces the one-item projection without inferring old cleanup', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    connectionId = 'rpc-4-2'
  store.apply(
    owner,
    'local',
    'task',
    'old-turn',
    { ...observation('active'), sequence: 4 },
    connectionId
  )
  store.unconfirmed(owner, 'local', 'task', 'old-turn')
  const token = store.captureActiveTurn(
    owner,
    'local',
    'task',
    'new-turn',
    'new-attempt',
    connectionId
  )

  expect(store.get('local', 'task')).toMatchObject({ turnId: 'old-turn', state: 'unknown' })
  expect(
    store.applyObservation(token!, connectionId, 11, observation('active'))
  ).toBe(true)
  expect(store.get('local', 'task')).toMatchObject({
    turnId: 'new-turn',
    attemptId: 'new-attempt',
    state: 'active',
  })
})

test('a new connection rechecks an active-turn snapshot from the previous connection', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    oldConnectionId = 'rpc-6-1',
    newConnectionId = 'rpc-6-2'
  const first = store.captureActiveTurn(
    owner,
    'local',
    'task',
    'turn',
    'attempt',
    oldConnectionId
  )
  expect(first).not.toBeNull()
  expect(
    store.applyObservation(first!, oldConnectionId, 9, observation('stop_failed'))
  ).toBe(true)

  const resumed = store.captureActiveTurn(
    owner,
    'local',
    'task',
    'turn',
    'attempt',
    newConnectionId
  )
  expect(resumed).not.toBeNull()
  expect(
    store.applyObservation(resumed!, newConnectionId, 1, observation('stopped'))
  ).toBe(true)
  expect(store.get('local', 'task')).toMatchObject({ state: 'stopped', attemptId: 'attempt' })
})

test('empty active-turn reads leave no entry when no host observation arrives', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    connectionId = 'rpc-8-1'
  const token = store.captureActiveTurn(
    owner,
    'local',
    'task',
    'active-turn',
    'active-attempt',
    connectionId
  )
  expect(token).not.toBeNull()
  expect(store.get('local', 'task')).toBeNull()

  store.releaseObservation(token!)
  expect(store.get('local', 'task')).toBeNull()
  const nextToken = store.captureActiveTurn(
    owner,
    'local',
    'task',
    'active-turn',
    'active-attempt',
    connectionId
  )
  expect(nextToken).not.toBeNull()
  store.releaseObservation(nextToken!)
})

test('a newer started turn invalidates the query ticket from an older resume snapshot', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    connectionId = 'rpc-8-2'
  const token = store.captureActiveTurn(
    owner,
    'local',
    'task',
    'resume-turn',
    'resume-attempt',
    connectionId
  )
  store.noteTurnStarted(owner, 'local', 'task', 'newer-turn')

  expect(
    store.applyObservation(token!, connectionId, 21, observation('active'))
  ).toBe(false)
  store.releaseObservation(token!)
  expect(store.get('local', 'task')).toBeNull()
})

test('a new connection snapshot clears the previous attempt sequence fence for following events', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    oldConnectionId = 'rpc-5-1',
    newConnectionId = 'rpc-5-2'
  store.apply(
    owner,
    'local',
    'task',
    'turn',
    { ...observation('active'), sequence: 2 },
    oldConnectionId
  )
  store.beginAttempt(owner, 'local', 'task', 'turn', 'retry', 100, oldConnectionId)
  store.unconfirmed(owner, 'local', 'task', 'turn')
  const token = store.captureUnsettled(owner, 'local', 'task', newConnectionId)
  expect(token?.attemptId).toBe('retry')

  expect(
    store.applyObservation(token!, newConnectionId, 1, observation('active'))
  ).toBe(true)
  expect(store.apply(owner, 'local', 'task', 'turn', {
    ...observation('stopping'),
    sequence: 2,
  }, newConnectionId)).toBeUndefined()
  expect(store.get('local', 'task')).toMatchObject({ state: 'stopping', attemptId: 'retry' })
})

test('a newer event wins over a pending same-client snapshot', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    client = {}
  store.apply(owner, 'local', 'task', 'turn', { ...observation('active'), sequence: 1 }, client)
  store.unconfirmed(owner, 'local', 'task', 'turn')
  const token = store.captureUnsettled(owner, 'local', 'task', client)
  expect(token).not.toBeNull()

  store.apply(owner, 'local', 'task', 'turn', { ...observation('stopped'), sequence: 5 }, client)
  expect(store.applyObservation(token!, client, 4, observation('active'))).toBe(false)
  expect(store.get('local', 'task')?.state).toBe('stopped')
})

test('a later snapshot wins over an earlier event delivered while the read is pending', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    client = {}
  store.apply(owner, 'local', 'task', 'turn', { ...observation('active'), sequence: 8 }, client)
  store.unconfirmed(owner, 'local', 'task', 'turn')
  const token = store.captureUnsettled(owner, 'local', 'task', client)
  expect(token).not.toBeNull()

  store.apply(owner, 'local', 'task', 'turn', { ...observation('active'), sequence: 9 }, client)
  expect(store.get('local', 'task')?.state).toBe('active')
  expect(store.applyObservation(token!, client, 10, observation('stopped'))).toBe(true)
  expect(store.get('local', 'task')?.state).toBe('stopped')
})

test('turn completion invalidates an old query without fencing a delayed cleanup event', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    client = {}
  store.apply(owner, 'local', 'task', 'turn', { ...observation('active'), sequence: 8 }, client)
  const token = store.captureUnsettled(owner, 'local', 'task', client)
  expect(token).toBeNull()

  store.unconfirmed(owner, 'local', 'task', 'turn', true)
  const pending = store.captureUnsettled(owner, 'local', 'task', client)
  expect(pending).not.toBeNull()
  store.unconfirmed(owner, 'local', 'task', 'turn')

  expect(store.applyObservation(pending!, client, 9, observation('active'))).toBe(false)
  store.apply(owner, 'local', 'task', 'turn', { ...observation('stopped'), sequence: 9 }, client)
  expect(store.get('local', 'task')?.state).toBe('stopped')
})

test('a new attempt on a replacement client does not inherit the previous sequence watermark', () => {
  const store = new ComputerUseStateStore(),
    owner = {},
    oldClient = {},
    newClient = {}
  store.apply(owner, 'local', 'task', 'turn', { ...observation('stopped'), sequence: 100 }, oldClient)
  store.beginAttempt(owner, 'local', 'task', 'turn', 'retry', 1, newClient)
  store.apply(owner, 'local', 'task', 'turn', { ...observation('active'), sequence: 2 }, newClient)
  expect(store.get('local', 'task')).toMatchObject({ state: 'active', attemptId: 'retry' })
})
