import { afterEach, expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'
import { computerUseStates } from './computerUseState'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

const runtimes: GatewayRuntimeCore[] = []
const releasePending: Array<() => void> = []
afterEach(async () => {
  releasePending.splice(0).forEach(release => release())
  await Promise.all(runtimes.splice(0).map(runtime => runtime.disposeAsync()))
})

async function freshActiveTurn(
  statusResult: Promise<unknown>,
  seedPreviousTurn: boolean | 'stop_failed' = false,
  includeActiveTurn = true
) {
  const clients: FakeGatewayClient[] = []
  let currentStatusResult = statusResult
  let resumeCount = 0
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => {
      const client = new FakeGatewayClient('desktop-thread')
      clients.push(client)
      if (clients.length > 1) {
        const original = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          if (method === 'thread/resume') {
            client.requests.push({ method, params })
            resumeCount += 1
            return {
              thread: { id: 'desktop-thread', status: 'running' },
              streamContext: {
                serverId: 'desktop-instance',
                throughSequence: resumeCount === 1 ? 10 : 12,
                activeTurn: resumeCount === 1 && includeActiveTurn ? {
                  id: 'current-turn',
                  threadId: 'desktop-thread',
                  attemptId: 'current-attempt',
                  status: 'running',
                } : null,
              },
            } as T
          }
          if (method === 'computerUse/turn/status') {
            client.requests.push({ method, params })
            return (await currentStatusResult) as T
          }
          return original<T>(method, params)
        }
      }
      return client
    },
  })
  runtimes.push(runtime)
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'fresh-desktop-task',
    executionRequest: { prompt: 'test' },
  })) as { taskId: string }
  const task = runtime.tasks.get(created.taskId)!
  if (seedPreviousTurn) {
    const previousState = seedPreviousTurn === 'stop_failed' ? 'stop_failed' : 'active'
    computerUseStates.apply(
      runtime,
      'local',
      task.taskId,
      'previous-turn',
      { state: previousState, target: 'local_windows_desktop', sequence: 5 },
      clients[0]
    )
    if (previousState === 'active')
      computerUseStates.unconfirmed(runtime, 'local', task.taskId, 'previous-turn')
  }
  const resumed = await runtime.resumeTaskOnce(task)
  const expectedTurnId = includeActiveTurn ? 'current-turn' : 'previous-turn'
  if (includeActiveTurn || seedPreviousTurn) {
    await vi.waitFor(() => {
      expect(clients[1].requests).toContainEqual({
        method: 'computerUse/turn/status',
        params: { threadId: 'desktop-thread', turnId: expectedTurnId },
      })
    })
  }
  return {
    runtime,
    task,
    client: resumed as FakeGatewayClient,
    setStatusResult: (result: Promise<unknown>) => { currentStatusResult = result },
  }
}

test('resume returns while one read-only host observation is pending and accepts its new sequence space', async () => {
  const clients: FakeGatewayClient[] = []
  let resolveStatus!: (result: unknown) => void
  const pendingStatus = new Promise<unknown>(resolve => {
    resolveStatus = resolve
  })
  releasePending.push(() => resolveStatus({}))
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => {
      const client = new FakeGatewayClient('desktop-thread')
      clients.push(client)
      if (clients.length > 1) {
        const original = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          if (method === 'computerUse/turn/status') {
            client.requests.push({ method, params })
            return (await pendingStatus) as T
          }
          return original<T>(method, params)
        }
      }
      return client
    },
  })
  runtimes.push(runtime)
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'desktop-task',
    executionRequest: { prompt: 'test' },
  })) as { taskId: string }
  const task = runtime.tasks.get(created.taskId)!
  const previousClient = clients[0]
  runtime.activeTurnByTask.get(task.taskId)?.complete()
  runtime.activeTurnByTask.delete(task.taskId)
  computerUseStates.apply(
    runtime,
    'local',
    task.taskId,
    'desktop-turn',
    { state: 'active', target: 'local_windows_desktop', sequence: 100 },
    previousClient
  )
  computerUseStates.unconfirmed(runtime, 'local', task.taskId, 'desktop-turn')

  const resumedClient = await runtime.resumeTaskOnce(task)
  expect(resumedClient).toBe(clients[1])
  await vi.waitFor(() => {
    expect(clients[1].requests).toContainEqual({
      method: 'computerUse/turn/status',
      params: { threadId: 'desktop-thread', turnId: 'desktop-turn' },
    })
  })
  expect(computerUseStates.get('local', task.taskId)?.state).toBe('unknown')
  expect(clients[1].requests.some(request => request.method === 'computerUse/recover')).toBe(false)

  resolveStatus({
    threadId: 'desktop-thread',
    turnId: 'desktop-turn',
    sequence: 1,
    observation: {
      state: 'stopped',
      target: 'local_windows_desktop',
      diagnostic: { authorization: 'valid', channel: 'available', cleanup: 'confirmed' },
      recoveryAvailable: false,
    },
  })
  await vi.waitFor(() => {
    expect(computerUseStates.get('local', task.taskId)?.state).toBe('stopped')
  })
  expect(clients[1].requests.filter(request => request.method === 'computerUse/turn/status')).toHaveLength(1)
})

test('fresh reopen reads the authoritative active turn and stores only a real observation', async () => {
  const result = Promise.resolve({
    threadId: 'desktop-thread',
    turnId: 'current-turn',
    sequence: 11,
    observation: {
      state: 'active',
      target: 'local_windows_desktop',
      diagnostic: { authorization: 'valid', channel: 'available', cleanup: 'pending' },
      recoveryAvailable: false,
    },
  })
  const { runtime, task, client } = await freshActiveTurn(result)
  await Promise.all([...runtime.pendingAsyncJobs])
  expect(runtime.activeTurnByTask.get(task.taskId)?.turnId).toBe('current-turn')
  expect(computerUseStates.get('local', task.taskId)).toMatchObject({
    turnId: 'current-turn',
    attemptId: 'current-attempt',
    state: 'active',
  })
  expect(client.requests.filter(request => request.method === 'computerUse/turn/status')).toHaveLength(1)
})

test('fresh reopen with no host observation leaves no empty Computer Use card', async () => {
  const result = Promise.resolve({ threadId: 'desktop-thread', turnId: 'current-turn', sequence: 11 })
  const { runtime, task } = await freshActiveTurn(result)
  await Promise.all([...runtime.pendingAsyncJobs])
  expect(computerUseStates.get('local', task.taskId)).toBeNull()
})

test.each([
  ['host confirms cleanup', {
    threadId: 'desktop-thread',
    turnId: 'previous-turn',
    sequence: 11,
    observation: { state: 'stopped', target: 'local_windows_desktop' },
  }, 'stopped'],
  ['host remains unobservable', {
    threadId: 'desktop-thread',
    turnId: 'previous-turn',
    sequence: 11,
  }, 'stop_failed'],
] as const)(
  'resume reads an unsettled stop_failed turn when there is no active turn and %s',
  async (_label, result, expectedState) => {
    const { runtime, task } = await freshActiveTurn(Promise.resolve(result), 'stop_failed', false)
    await Promise.all([...runtime.pendingAsyncJobs])
    expect(computerUseStates.get('local', task.taskId)?.state).toBe(expectedState)
  }
)

test('a later resume reads the current completed turn even while the visible projection is from an older turn', async () => {
  const { runtime, task, client, setStatusResult } = await freshActiveTurn(
    Promise.resolve({ threadId: 'desktop-thread', turnId: 'current-turn', sequence: 11 }),
    true
  )
  await Promise.all([...runtime.pendingAsyncJobs])
  expect(computerUseStates.get('local', task.taskId)).toMatchObject({
    turnId: 'previous-turn',
    state: 'unknown',
  })

  await runtime.forwardNotification(
    'turn/completed',
    {
      threadId: task.threadId,
      turnId: 'current-turn',
      attemptId: 'current-attempt',
      sequence: 12,
      turn: { id: 'current-turn', status: 'completed' },
    },
    'local',
    client
  )
  expect(computerUseStates.get('local', task.taskId)).toMatchObject({
    turnId: 'previous-turn',
    state: 'unknown',
  })

  setStatusResult(Promise.resolve({
    threadId: 'desktop-thread',
    turnId: 'current-turn',
    sequence: 13,
    observation: { state: 'stopped', target: 'local_windows_desktop' },
  }))
  const secondClient = await runtime.resumeTaskOnce(task) as FakeGatewayClient
  await vi.waitFor(() => {
    expect(secondClient.requests.filter(request => request.method === 'computerUse/turn/status'))
      .toHaveLength(1)
  })
  await Promise.all([...runtime.pendingAsyncJobs])
  expect(secondClient.requests).toContainEqual({
    method: 'computerUse/turn/status',
    params: { threadId: 'desktop-thread', turnId: 'current-turn' },
  })
  expect(computerUseStates.get('local', task.taskId)).toMatchObject({
    turnId: 'current-turn',
    attemptId: 'current-attempt',
    state: 'stopped',
  })
})

test.each([false, true])(
  'a delayed desktop cleanup below the resume watermark is accepted after an unobservable read (old snapshot=%s)',
  async seedPreviousTurn => {
    const result = Promise.resolve({ threadId: 'desktop-thread', turnId: 'current-turn', sequence: 11 })
    const { runtime, task, client } = await freshActiveTurn(result, seedPreviousTurn)
    await Promise.all([...runtime.pendingAsyncJobs])
    const beforeLateEvent = computerUseStates.get('local', task.taskId)
    expect(beforeLateEvent?.state ?? null).toBe(seedPreviousTurn ? 'unknown' : null)

    await runtime.forwardNotification(
      'computerUse/stateChanged',
      {
        serverId: 'desktop-instance',
        threadId: task.threadId,
        turnId: 'current-turn',
        sequence: 9,
        target: 'local_windows_desktop',
        state: 'stopped',
      },
      'local',
      client
    )
    expect(computerUseStates.get('local', task.taskId)).toMatchObject({
      turnId: 'current-turn',
      state: 'stopped',
    })
  }
)

test.each(['turn completion', 'permission revocation', 'task release'] as const)(
  'a fresh active-turn query cannot apply after %s', async change => {
    let resolveStatus!: (result: unknown) => void
    const result = new Promise<unknown>(resolve => {
      resolveStatus = resolve
    })
    releasePending.push(() => resolveStatus({}))
    const { runtime, task, client } = await freshActiveTurn(result)
    if (change === 'turn completion') {
      await runtime.forwardNotification(
        'turn/completed',
        {
          threadId: task.threadId,
          turnId: 'current-turn',
          attemptId: 'current-attempt',
          sequence: 11,
          turn: { id: 'current-turn', status: 'completed' },
        },
        'local',
        client
      )
    } else if (change === 'permission revocation') {
      computerUseStates.revoked(runtime, 'local', task.taskId)
    } else {
      runtime.tasks.delete(task.taskId)
    }
    resolveStatus({
      threadId: task.threadId,
      turnId: 'current-turn',
      sequence: 12,
      observation: { state: 'stopped', target: 'local_windows_desktop' },
    })
    await Promise.all([...runtime.pendingAsyncJobs])
    expect(computerUseStates.get('local', task.taskId)).toBeNull()
  }
)
