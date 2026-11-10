import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayServer } from '../../gatewayRpc'
import type { GatewayRuntimeCore } from './core'
import type { GatewayTask } from './contracts'
import { trackAsyncJob } from './connections'
import { bindTaskClient, emitSubagentSnapshot, resumeTaskOnce } from './recovery'
import { readyTaskClient, resumeTask } from './turns'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'

const testState = vi.hoisted(() => ({
  accountCurrent: true,
  emitted: [] as unknown[],
}))

vi.mock('../../accountContextEvents', () => ({
  captureAccountContextRevision: vi.fn(() => () => testState.accountCurrent),
  listenAccountContextChanges: vi.fn(() => () => undefined),
}))

vi.mock('../../gatewayServiceBridge', () => ({
  emitRuntimeEvent: vi.fn(async (_event: string, payload: unknown) => {
    testState.emitted.push(payload)
  }),
}))

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}

const task: GatewayTask = {
  serverId: 'server-a',
  taskId: 'kcoder:server-a:thread-a',
  threadId: 'thread-a',
  workspacePath: '/workspace/a',
  title: 'Task A',
  runtime: 'kcoder',
  persisted: true,
  running: false,
  createdAt: 1,
  updatedAt: 1,
  runtimeHandle: { threadId: 'thread-a' },
}

function createFixture() {
  const server = {
    id: 'server-a',
    label: 'Server A',
    description: '',
    runtime: 'kcoder',
    transport: 'local',
    workspacePath: '/workspace/a',
  } as GatewayServer
  const agentListStarted = deferred<void>()
  const agentList = deferred<{ agents: Array<Record<string, unknown>> }>()
  const requestedMethods: string[] = []
  const client = Object.assign(new EventTarget(), {
    request: vi.fn((method: string) => {
      requestedMethods.push(method)
      if (method === 'thread/resume')
        return Promise.resolve({ thread: { id: task.threadId, status: 'idle' } })
      if (method === 'agent/list') {
        agentListStarted.resolve()
        return agentList.promise
      }
      if (method === 'asyncQuestion/list')
        return Promise.resolve({ threadId: task.threadId, questions: [] })
      throw new Error(`Unexpected request: ${method}`)
    }),
    supportsExperimental: (capability: string) =>
      capability === 'agentSteering' || capability === 'asyncUserQuestionsV1',
    close: vi.fn(),
  }) as unknown as GatewayClient
  const pendingAsyncJobs = new Set<Promise<void>>()
  const clientByTask = new Map<string, GatewayClient>()
  const tasks = new Map<string, GatewayTask>([[task.taskId, { ...task }]])
  const runtime = {
    resolveTaskId: (id: string) => id,
    disposed: false,
    tasks,
    clientByTask,
    resumeClientByTask: new Map(),
    disconnectRecoveryByTask: new Map(),
    taskViewGenerations: new Map(),
    notificationQueueByClient: new WeakMap(),
    appServerDisconnectedClients: new WeakSet(),
    connectionsByClient: new Map([[client, { client, server, serverId: server.id }]]),
    activeTurnByTask: new Map(),
    completedTurnKeys: new Set(),
    turnAttemptIds: new Map(),
    threadByTask: new Map(),
    taskByThread: new Map(),
    backgroundJobById: new Map(),
    pendingAsyncJobs,
    notificationReplayGuard: {
      canSeedBackgroundRun: vi.fn(() => true),
      seedBackgroundRun: vi.fn(),
    },
    toolPathPreviews: { seedResume: vi.fn(() => false) },
    servers: vi.fn(async () => [server]),
    serverForParams: vi.fn(async () => server),
    taskDescriptor: vi.fn(async () => ({ taskId: task.taskId, task, server })),
    assertCommandTarget: vi.fn(async () => undefined),
    connectClient: vi.fn(async () => client),
    isRestartingServer: vi.fn(() => false),
    threadKey: (serverId: string, threadId: string) => `${serverId}\0${threadId}`,
    bindTaskClient: (taskId: string, selectedClient: GatewayClient) =>
      bindTaskClient.call(runtime, taskId, selectedClient),
    resumeTaskOnce: (selectedTask: GatewayTask) => resumeTaskOnce.call(runtime, selectedTask),
    emitSubagentSnapshot: (
      selectedTask: GatewayTask,
      selectedClient: GatewayClient,
      owner: Parameters<typeof emitSubagentSnapshot>[2]
    ) => emitSubagentSnapshot.call(runtime, selectedTask, selectedClient, owner),
    resumeTask: (selectedTask: GatewayTask) => resumeTask.call(runtime, selectedTask),
    readyTaskClient: (selectedTask: GatewayTask) => readyTaskClient.call(runtime, selectedTask),
    trackAsyncJob: (job: Promise<unknown>) => trackAsyncJob.call(runtime, job),
    trackActiveTurn: vi.fn(),
    emitBackgroundToolLifecycle: vi.fn(async () => undefined),
  } as unknown as GatewayRuntimeCore
  return {
    runtime,
    server,
    client,
    agentListStarted,
    agentList,
    pendingAsyncJobs,
    requestedMethods,
  }
}

const reportedAgent = {
  agentId: 'agent-a',
  agentName: 'spawn_agent',
  status: 'running',
  backgroundRun: { runId: 'run-a' },
  queueDepth: 0,
}

async function settleSnapshot(fixture: ReturnType<typeof createFixture>) {
  fixture.agentList.resolve({ agents: [reportedAgent] })
  await vi.waitFor(() => expect(fixture.pendingAsyncJobs.size).toBe(0))
}

beforeEach(() => {
  testState.accountCurrent = true
  testState.emitted.length = 0
})

describe('resume task question readiness', () => {
  it('returns the bound client while the owned subagent snapshot is still pending', async () => {
    const fixture = createFixture()
    const readiness = readyTaskClient.call(fixture.runtime, { ...task })
    await fixture.agentListStarted.promise

    const outcome = await Promise.race([
      readiness.then(() => 'ready'),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 0)),
    ])

    expect(fixture.pendingAsyncJobs.size).toBe(1)
    fixture.agentList.resolve({ agents: [reportedAgent] })
    await expect(readiness).resolves.toBe(fixture.client)
    expect(outcome).toBe('ready')
    expect(fixture.runtime.clientByTask.get(task.taskId)).toBe(fixture.client)
    await vi.waitFor(() => expect(fixture.pendingAsyncJobs.size).toBe(0))
    expect(fixture.runtime.backgroundJobById.get('agent-a')).toMatchObject({
      taskId: task.taskId,
      serverId: task.serverId,
      runId: 'run-a',
    })
    expect(testState.emitted).toContainEqual(
      expect.objectContaining({ event: 'response.subagent.activity' })
    )
  })

  it('issues the actual async-question support and list calls before the subagent snapshot', async () => {
    const fixture = createFixture()
    await expect(
      supportsAsyncQuestions.call(fixture.runtime, { taskId: task.taskId })
    ).resolves.toMatchObject({ taskId: task.taskId, supported: true })
    await expect(
      requestAsyncQuestion.call(fixture.runtime, {
        taskId: task.taskId,
        method: 'asyncQuestion/list',
        params: {},
      })
    ).resolves.toMatchObject({ threadId: task.threadId, questions: [] })
    await fixture.agentListStarted.promise

    expect(fixture.requestedMethods.indexOf('asyncQuestion/list')).toBeGreaterThan(-1)
    expect(fixture.requestedMethods.indexOf('asyncQuestion/list')).toBeLessThan(
      fixture.requestedMethods.indexOf('agent/list')
    )
    await settleSnapshot(fixture)
  })

  it.each([
    [
      'a replacement client owns the task',
      (fixture: ReturnType<typeof createFixture>) => {
        fixture.runtime.clientByTask.set(task.taskId, new EventTarget() as unknown as GatewayClient)
      },
    ],
    [
      'the runtime has been disposed',
      (fixture: ReturnType<typeof createFixture>) => {
        fixture.runtime.disposed = true
      },
    ],
    [
      'the account context has changed',
      () => {
        testState.accountCurrent = false
      },
    ],
    [
      'the task thread has changed',
      (fixture: ReturnType<typeof createFixture>) => {
        fixture.runtime.tasks.set(task.taskId, { ...task, threadId: 'thread-b' })
      },
    ],
    [
      'the target identity has changed',
      (fixture: ReturnType<typeof createFixture>) => {
        fixture.server.workspacePath = '/workspace/other'
      },
    ],
  ])('ignores a late snapshot when %s', async (_name, invalidate) => {
    const fixture = createFixture()
    const readiness = readyTaskClient.call(fixture.runtime, { ...task })
    await fixture.agentListStarted.promise

    invalidate(fixture)
    await settleSnapshot(fixture)
    await readiness

    expect(fixture.runtime.backgroundJobById.has('agent-a')).toBe(false)
    expect(testState.emitted).toHaveLength(0)
    expect(fixture.runtime.notificationReplayGuard.seedBackgroundRun).not.toHaveBeenCalled()
  })

  it('ignores a late snapshot when the captured task identity mutates in place', async () => {
    const fixture = createFixture()
    const currentTask = fixture.runtime.tasks.get(task.taskId)!
    const readiness = readyTaskClient.call(fixture.runtime, currentTask)
    await fixture.agentListStarted.promise

    currentTask.threadId = 'thread-b'
    await settleSnapshot(fixture)
    await readiness

    expect(fixture.runtime.backgroundJobById.has('agent-a')).toBe(false)
    expect(testState.emitted).toHaveLength(0)
    expect(fixture.runtime.notificationReplayGuard.seedBackgroundRun).not.toHaveBeenCalled()
  })
})
