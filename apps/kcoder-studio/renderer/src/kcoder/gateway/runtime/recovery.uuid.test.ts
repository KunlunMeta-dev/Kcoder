import { afterEach, expect, test, vi } from 'vitest'
import { recoverTaskAfterDisconnect } from './recovery'
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
    clientByTask,
    resumeTask,
    trackAsyncJob: vi.fn(),
  } as unknown as GatewayRuntimeCore
  expect(() => recoverTaskAfterDisconnect.call(runtime, task, Promise.resolve())).not.toThrow()
  const recovery = disconnectRecoveryByTask.get(task.taskId)
  expect(recovery).toBeDefined()
  await recovery
  expect(resumeTask).toHaveBeenCalledWith(task)
  expect(getRandomValues).toHaveBeenCalledTimes(1)
  expect(emit).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      event: 'response.block.updated',
      payload: expect.objectContaining({
        taskId: task.taskId,
        data: expect.objectContaining({ updates: { status: 'done' } }),
      }),
    })
  )
  expect(disconnectRecoveryByTask.has(task.taskId)).toBe(false)
})
