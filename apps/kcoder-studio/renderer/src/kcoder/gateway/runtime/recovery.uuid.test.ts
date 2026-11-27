import { afterEach, expect, test, vi } from 'vitest'
import { recoverTaskAfterDisconnect } from './recovery'
import { taskConnectionStatus } from '../../taskConnectionStatus'
import type { GatewayRuntimeCore } from './core'
import type { GatewayTask } from './contracts'

const { emit } = vi.hoisted(() => ({ emit: vi.fn(async () => undefined) }))
vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: emit }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

test('LAN HTTP disconnect recovery proceeds when randomUUID is unavailable', async () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.fill(7)
    return bytes
  })
  vi.stubGlobal('crypto', { getRandomValues })
  const task = {
    taskId: 'owned-task',
    threadId: 'owned-thread',
    serverId: 'owned-server',
    workspacePath: '/owned/workspace',
  } as GatewayTask
  const client = {}
  const clientByTask = new Map()
  const disconnectRecoveryByTask = new Map<string, Promise<void>>()
  const resumeTask = vi.fn(async () => {
    clientByTask.set(task.taskId, client)
    return client
  })
  const runtime = {
    disposed: false,
    isRestartingServer: () => false,
    tasks: new Map([[task.taskId, task]]),
    disconnectRecoveryByTask,
    activeTurnByTask: new Map(),
    clientByTask,
    appServerDisconnectedClients: new WeakSet(),
    resumeTask,
    trackAsyncJob: vi.fn(),
  } as unknown as GatewayRuntimeCore
  expect(() => recoverTaskAfterDisconnect.call(runtime, task, Promise.resolve())).not.toThrow()
  expect(taskConnectionStatus.read(task.serverId, task.taskId)).toBe('reconnecting')
  const recovery = disconnectRecoveryByTask.get(task.taskId)
  expect(recovery).toBeDefined()
  await recovery
  expect(resumeTask).toHaveBeenCalledWith(task)
  expect(getRandomValues).not.toHaveBeenCalled()
  expect(emit).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      event: 'async-question:refresh',
      payload: { taskId: task.taskId, serverId: task.serverId,
        threadId: task.threadId, workspacePath: task.workspacePath },
    })
  )
  expect(disconnectRecoveryByTask.has(task.taskId)).toBe(false)
  expect(taskConnectionStatus.read(task.serverId, task.taskId)).toBeNull()
})
