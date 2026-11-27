import { expect, it, vi } from 'vitest'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import type { GatewayServer } from '../../gatewayRpc'
import type { GatewayRuntimeCore } from './core'
import type { GatewayTask } from './contracts'
import { sendTask } from './turns'
import { TurnAcceptanceUnknownError } from '../../gatewayTurnReceipt'

it('does not start a fallback turn when the task client changes during sendTask awaits', async () => {
  const request = vi.fn(async () => ({ turn: { id: 'unexpected-turn', status: 'running' } }))
  const oldClient = Object.assign(new EventTarget(), {
    supportsExperimental: () => true,
    request,
  }) as unknown as GatewayClient
  const newClient = Object.assign(new EventTarget(), {
    supportsExperimental: () => true,
    request: vi.fn(async () => ({ turn: { id: 'unexpected-turn', status: 'running' } })),
  }) as unknown as GatewayClient
  const task: GatewayTask = {
    taskId: 'task', serverId: 'server', threadId: 'thread', workspacePath: '/workspace',
    runtime: 'kcoder', title: 'Task', persisted: true, running: false,
    createdAt: 1, updatedAt: 1, runtimeHandle: { threadId: 'thread' },
  }
  const tasks = new Map([[task.taskId, task]])
  const clientByTask = new Map<string, GatewayClient>([[task.taskId, oldClient]])
  let readinessCalls = 0
  const core = {
    resolveTaskId: (value?: string) => value,
    tasks,
    threadByTask: new Map([[task.taskId, task.threadId]]),
    clientByTask,
    pendingTaskInputs: new Map(),
    readyTaskClient: vi.fn(async () => {
      readinessCalls += 1
      if (readinessCalls === 1) return oldClient
      clientByTask.set(task.taskId, newClient)
      return newClient
    }),
    compatibility: { executionProxyUrl: () => null },
    activeTurnByTask: new Map(),
  } as unknown as GatewayRuntimeCore
  const server = { id: task.serverId, transport: 'local', workspacePath: '/workspace' } as GatewayServer

  const delivery = sendTask.call(
    core,
    { taskId: task.taskId, clientMessageId: 'guidance-1', executionRequest: { prompt: 'use staging' } },
    server,
    false,
    oldClient
  )

  await expect(delivery).rejects.toBeInstanceOf(TurnAcceptanceUnknownError)
  expect(readinessCalls).toBe(2)
  expect(request).not.toHaveBeenCalled()
  expect(newClient.request).not.toHaveBeenCalled()
})
