import { afterEach, expect, test } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from '../../gatewayRuntime.test-support'
import { computerUseStates } from '../../computerUseState'
import type { GatewayRuntimeCore } from './core'

const runtimes: GatewayRuntimeCore[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.disposeAsync()))
})

async function fixture(initialConnectionId?: string) {
  const client = new FakeGatewayClient('desktop-thread')
  let connectionId = initialConnectionId
    ? { targetId: 'local', connectionId: initialConnectionId }
    : undefined
  Object.defineProperty(client, 'diagnosticConnection', { get: () => connectionId })
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  runtimes.push(runtime)
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'desktop-task',
    executionRequest: { prompt: 'test' },
  })) as { taskId: string }
  computerUseStates.apply(
    runtime,
    'local',
    created.taskId,
    'desktop-turn',
    { state: 'active', target: 'local_windows_desktop', sequence: 1 },
    connectionId?.connectionId ?? client
  )
  runtime.trackActiveTurn(created.taskId, 'desktop-turn')
  const notify = (
    method: string,
    turnId: string,
    sequence: number,
    extra = {},
    capturedConnection = connectionId
  ) =>
    runtime.forwardNotification(
      method,
      {
        threadId: 'desktop-thread',
        turnId,
        sequence,
        ...(method === 'turn/started'
          ? { attemptId: `${turnId}-attempt`, turn: { id: turnId, status: 'running' } }
          : method === 'turn/completed'
            ? { turn: { id: turnId, status: 'completed' } }
            : {}),
        ...extra,
      },
      'local',
      client,
      capturedConnection
    )
  const setConnectionId = (next?: string) => {
    connectionId = next ? { targetId: 'local', connectionId: next } : undefined
  }
  return { client, runtime, taskId: created.taskId, notify, setConnectionId }
}

test('same-turn late stopped settles an observation after turn completion', async () => {
  const { notify, taskId } = await fixture()
  await notify('turn/completed', 'desktop-turn', 2)
  expect(computerUseStates.get('local', taskId)?.state).toBe('unknown')

  await notify('computerUse/stateChanged', 'desktop-turn', 3, {
    target: 'local_windows_desktop',
    state: 'stopped',
  })
  expect(computerUseStates.get('local', taskId)?.state).toBe('stopped')
})

test('late stop_failed and then stopped settle after completion', async () => {
  const { notify, taskId } = await fixture()
  await notify('turn/completed', 'desktop-turn', 2)
  await notify('computerUse/stateChanged', 'desktop-turn', 3, {
    target: 'local_windows_desktop',
    state: 'stop_failed',
    diagnostic: {
      authorization: 'valid',
      channel: 'unavailable',
      cleanup: 'failed',
      failureCode: 'connection_lost',
    },
  })
  expect(computerUseStates.get('local', taskId)).toMatchObject({
    state: 'stop_failed',
    diagnostic: { failureCode: 'connection_lost' },
  })

  await notify('computerUse/stateChanged', 'desktop-turn', 4, {
    target: 'local_windows_desktop',
    state: 'stopped',
  })
  expect(computerUseStates.get('local', taskId)?.state).toBe('stopped')
})

test('late active cannot revive an observation after completion', async () => {
  const { notify, taskId } = await fixture()
  await notify('turn/completed', 'desktop-turn', 2)
  await notify('computerUse/stateChanged', 'desktop-turn', 3, {
    target: 'local_windows_desktop',
    state: 'active',
  })
  expect(computerUseStates.get('local', taskId)?.state).toBe('unknown')
})

test('a same-turn retry attempt can become active after stopped A, while delayed active A is rejected', async () => {
  const { notify, taskId } = await fixture()
  await notify('computerUse/stateChanged', 'desktop-turn', 2, {
    target: 'local_windows_desktop',
    state: 'stopped',
  })
  await notify('turn/completed', 'desktop-turn', 4)
  await notify('turn/started', 'desktop-turn', 5, { attemptId: 'retry-attempt' })
  await notify('computerUse/stateChanged', 'desktop-turn', 3, {
    target: 'local_windows_desktop',
    state: 'active',
  })
  expect(computerUseStates.get('local', taskId)?.state).toBe('stopped')

  await notify('computerUse/stateChanged', 'desktop-turn', 6, {
    target: 'local_windows_desktop',
    state: 'active',
  })

  expect(computerUseStates.get('local', taskId)).toMatchObject({
    turnId: 'desktop-turn',
    attemptId: 'retry-attempt',
    state: 'active',
  })
})

test('an older turn settlement is rejected after a newer turn has started and completed', async () => {
  const { notify, taskId } = await fixture()
  await notify('turn/completed', 'desktop-turn', 2)
  await notify('turn/started', 'newer-turn', 3)
  await notify('turn/completed', 'newer-turn', 4)

  await notify('computerUse/stateChanged', 'desktop-turn', 5, {
    target: 'local_windows_desktop',
    state: 'stopped',
  })
  expect(computerUseStates.get('local', taskId)).toMatchObject({
    turnId: 'desktop-turn',
    state: 'unknown',
  })
})

test('a completed latest turn can settle even while the visible projection still belongs to the old turn', async () => {
  const { notify, taskId } = await fixture()
  await notify('turn/completed', 'desktop-turn', 2)
  await notify('turn/started', 'newer-turn', 3)
  await notify('turn/completed', 'newer-turn', 4)
  expect(computerUseStates.get('local', taskId)).toMatchObject({
    turnId: 'desktop-turn',
    state: 'unknown',
  })

  await notify('computerUse/stateChanged', 'newer-turn', 5, {
    target: 'local_windows_desktop',
    state: 'stopped',
  })
  expect(computerUseStates.get('local', taskId)).toMatchObject({
    turnId: 'newer-turn',
    attemptId: 'newer-turn-attempt',
    state: 'stopped',
  })
})

test('a replaced client cannot deliver a late settlement for the previous connection', async () => {
  const { client, runtime, notify, taskId } = await fixture()
  await notify('turn/completed', 'desktop-turn', 2)
  runtime.clientByTask.set(taskId, new FakeGatewayClient('desktop-thread'))

  await notify('computerUse/stateChanged', 'desktop-turn', 3, {
    target: 'local_windows_desktop',
    state: 'stopped',
  })
  expect(runtime.clientByTask.get(taskId)).not.toBe(client)
  expect(computerUseStates.get('local', taskId)?.state).toBe('unknown')
})

test('a reused client fences the old socket and accepts sequence reset on its new socket', async () => {
  const { client, taskId, notify, setConnectionId } = await fixture('rpc-7-4')
  await notify('turn/completed', 'desktop-turn', 2)
  setConnectionId('rpc-7-5')

  await notify(
    'computerUse/stateChanged',
    'desktop-turn',
    101,
    { target: 'local_windows_desktop', state: 'stopped' },
    { targetId: 'local', connectionId: 'rpc-7-4' }
  )
  expect(computerUseStates.get('local', taskId)?.state).toBe('unknown')

  await notify('computerUse/stateChanged', 'desktop-turn', 1, {
    target: 'local_windows_desktop',
    state: 'stopped',
  })
  expect(client.diagnosticConnection?.connectionId).toBe('rpc-7-5')
  expect(computerUseStates.get('local', taskId)?.state).toBe('stopped')
})
