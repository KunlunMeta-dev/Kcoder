import { afterEach, expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from '../../gatewayRuntime.test-support'
import { computerUseStates } from '../../computerUseState'
import { readComputerUseTurnObservation } from './computerUseObservation'
import type { GatewayRuntimeCore } from './core'

const runtimes: GatewayRuntimeCore[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.disposeAsync()))
})

async function fixture() {
  const client = new FakeGatewayClient('desktop')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  runtimes.push(runtime)
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'desktop-task',
    executionRequest: { prompt: 'test' },
  })) as { taskId: string }
  const task = runtime.tasks.get(created.taskId)!
  const previousClient = {}
  runtime.trackActiveTurn(task.taskId, 'desktop-turn')
  runtime.turnAttemptIds.set(`${task.taskId}:desktop-turn`, 'desktop-attempt')
  computerUseStates.apply(
    runtime,
    'local',
    task.taskId,
    'desktop-turn',
    { state: 'active', target: 'local_windows_desktop', sequence: 8 },
    previousClient
  )
  computerUseStates.unconfirmed(runtime, 'local', task.taskId, 'desktop-turn')
  const token = computerUseStates.captureActiveTurn(
    runtime,
    'local',
    task.taskId,
    'desktop-turn',
    'desktop-attempt',
    client
  )
  expect(token).not.toBeNull()
  return { client, runtime, task, token: token! }
}

test('an unobservable read leaves the watermark open for a delayed valid cleanup event', async () => {
  const { client, runtime, task, token } = await fixture()
  const sideEffectsBefore = client.requests.filter(request =>
    ['computerUse/recover', 'computerUse/revoke', 'turn/start'].includes(request.method)
  )
  const original = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method === 'computerUse/turn/status') {
      client.requests.push({ method, params })
      return { threadId: task.threadId, turnId: token.turnId, sequence: 10 } as T
    }
    return original<T>(method, params)
  }

  await readComputerUseTurnObservation(runtime, task, client, token, async () => {})
  expect(computerUseStates.get('local', task.taskId)?.state).toBe('unknown')
  expect(client.requests).toContainEqual({
    method: 'computerUse/turn/status',
    params: { threadId: task.threadId, turnId: 'desktop-turn' },
  })

  await runtime.forwardNotification(
    'computerUse/stateChanged',
    {
      threadId: task.threadId,
      turnId: token.turnId,
      sequence: 9,
      target: 'local_windows_desktop',
      state: 'stopped',
    },
    'local',
    client
  )
  expect(computerUseStates.get('local', task.taskId)?.state).toBe('stopped')
  expect(
    client.requests.filter(request =>
      ['computerUse/recover', 'computerUse/revoke', 'turn/start'].includes(request.method)
    )
  ).toEqual(sideEffectsBefore)
})

test('a valid snapshot can supersede an earlier same-connection notification', async () => {
  const { client, runtime, task, token } = await fixture()
  const original = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method === 'computerUse/turn/status') {
      client.requests.push({ method, params })
      return {
        threadId: task.threadId,
        turnId: token.turnId,
        sequence: 10,
        observation: {
          state: 'stopped',
          target: 'local_windows_desktop',
          diagnostic: { authorization: 'valid', channel: 'available', cleanup: 'confirmed' },
          recoveryAvailable: false,
        },
      } as T
    }
    return original<T>(method, params)
  }

  await runtime.forwardNotification(
    'computerUse/stateChanged',
    {
      threadId: task.threadId,
      turnId: token.turnId,
      sequence: 9,
      target: 'local_windows_desktop',
      state: 'active',
    },
    'local',
    client
  )
  expect(computerUseStates.get('local', task.taskId)?.state).toBe('active')

  await readComputerUseTurnObservation(runtime, task, client, token, async () => {})
  expect(computerUseStates.get('local', task.taskId)?.state).toBe('stopped')
})

test('a delayed query cannot replace the current connection or a different active turn', async () => {
  const { client, runtime, task, token } = await fixture()
  let resolveStatus!: (result: unknown) => void
  const status = new Promise<unknown>(resolve => {
    resolveStatus = resolve
  })
  const original = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method === 'computerUse/turn/status') {
      client.requests.push({ method, params })
      return (await status) as T
    }
    return original<T>(method, params)
  }

  const pending = readComputerUseTurnObservation(runtime, task, client, token, async () => {})
  await viWaitForRequest(client)
  runtime.trackActiveTurn(task.taskId, 'replacement-turn')
  resolveStatus({
    threadId: task.threadId,
    turnId: token.turnId,
    sequence: 11,
    observation: { state: 'stopped', target: 'local_windows_desktop' },
  })
  await pending
  expect(computerUseStates.get('local', task.taskId)).toMatchObject({
    turnId: 'desktop-turn',
    state: 'unknown',
  })
})

test('status read uses the captured socket and drops a late result after the same client reconnects', async () => {
  const { client, runtime, task } = await fixture()
  let connectionId = 'rpc-3-7'
  const boundClient = client as FakeGatewayClient & {
    diagnosticConnection?: { targetId: string; connectionId: string }
    requestOnConnection?: <T>(
      connectionId: string,
      method: string,
      params?: Record<string, unknown>
    ) => Promise<T>
  }
  Object.defineProperty(boundClient, 'diagnosticConnection', {
    get: () => ({ targetId: 'local', connectionId }),
  })
  let resolveStatus!: (result: unknown) => void
  const status = new Promise<unknown>(resolve => {
    resolveStatus = resolve
  })
  let requestedConnectionId: string | undefined
  boundClient.requestOnConnection = async <T>(requestedId, method, params = {}) => {
    requestedConnectionId = requestedId
    client.requests.push({ method, params })
    return (await status) as T
  }
  const token = computerUseStates.captureActiveTurn(
    runtime,
    'local',
    task.taskId,
    'desktop-turn',
    'desktop-attempt',
    connectionId
  )
  expect(token).not.toBeNull()

  const pending = readComputerUseTurnObservation(runtime, task, client, token!, async () => {})
  try {
    await vi.waitFor(() => expect(requestedConnectionId).toBe('rpc-3-7'))
    connectionId = 'rpc-3-8'
    resolveStatus({
      threadId: task.threadId,
      turnId: token!.turnId,
      sequence: 1,
      observation: { state: 'stopped', target: 'local_windows_desktop' },
    })
    await pending
  } finally {
    resolveStatus({})
    await pending
  }
  expect(computerUseStates.get('local', task.taskId)?.state).toBe('unknown')
})

async function viWaitForRequest(client: FakeGatewayClient) {
  await vi.waitFor(() => {
    expect(client.requests.some(request => request.method === 'computerUse/turn/status')).toBe(true)
  })
}
