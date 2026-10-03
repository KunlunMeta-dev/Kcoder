import { subscribeRuntimeWorkChanged } from '../../runtimeWorkEvents'
import { expect, test, vi } from 'vitest'
import { forwardAcceptedNotification } from './notifications'
import type { GatewayRuntimeCore } from './core'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn() }))

test('scheduled admission failure stops the task and reports the actual reason', async () => {
  const changed = vi.fn()
  const unsubscribe = subscribeRuntimeWorkChanged(changed)
  const core = {
    remoteSessions: { handleNotification: () => false },
    servers: async () => [{ id: 'local', transport: 'local', workspacePath: '/workspace' }],
    threadKey: (server: string, thread: string) => `${server}:${thread}`,
    tasks: new Map(),
    taskByThread: new Map(),
    threadByTask: new Map(),
  } as unknown as GatewayRuntimeCore
  await forwardAcceptedNotification.call(
    core,
    'automation/runStarted',
    {
      jobId: 'job',
      threadId: 'scheduled',
      workspacePath: '/workspace',
      title: 'Task',
    },
    'local'
  )
  const task = [...core.tasks.values()][0]
  expect(task.running).toBe(true)
  expect(changed).toHaveBeenCalledTimes(1)
  await forwardAcceptedNotification.call(
    core,
    'automation/runFailed',
    {
      jobId: 'job',
      threadId: 'scheduled',
      requestId: 'internal',
      error: { code: -32602, message: 'Provider API key missing' },
    },
    'local'
  )
  expect(core.tasks.get(task.taskId)?.running).toBe(false)
  expect(changed).toHaveBeenCalledTimes(2)
  unsubscribe()
  expect(emitRuntimeEvent).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      event: 'response.failed',
      payload: expect.objectContaining({
        taskId: task.taskId,
        data: expect.objectContaining({ message: 'Provider API key missing' }),
      }),
    })
  )
})
