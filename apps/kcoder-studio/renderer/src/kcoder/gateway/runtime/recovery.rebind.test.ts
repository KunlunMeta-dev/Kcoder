import { afterEach, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import type { GatewayTask } from './contracts'
import { recoverTaskAfterDisconnect } from './recovery'

const { emit } = vi.hoisted(() => ({ emit: vi.fn<(name: string, event: unknown) => Promise<void>>(async () => undefined) }))
vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: emit }))
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

function fixture() {
  const task = { taskId: 'task', serverId: 'server', threadId: 'thread', workspacePath: '/workspace' } as GatewayTask
  const client = {}
  const clientByTask = new Map()
  const runtime = {
    disposed: false, tasks: new Map([[task.taskId, task]]), clientByTask,
    disconnectRecoveryByTask: new Map(), appServerDisconnectedClients: new WeakSet(),
    isRestartingServer: () => false, trackAsyncJob: vi.fn(),
    resumeTask: vi.fn(async () => { clientByTask.set('task', client); return client }),
  } as unknown as GatewayRuntimeCore
  let release!: () => void
  const projection = new Promise<void>(resolve => { release = resolve })
  recoverTaskAfterDisconnect.call(runtime, task, projection)
  return { runtime, task, release, recovery: runtime.disconnectRecoveryByTask.get('task')! }
}

it.each(['taskId', 'serverId', 'threadId', 'workspacePath'] as const)(
  'does not resume a replacement %s after disconnect projection yields', async field => {
    const f = fixture()
    f.task[field] = 'replacement'
    f.release()
    await f.recovery
    expect(f.runtime.resumeTask).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(f.runtime.disconnectRecoveryByTask.size).toBe(0)
  }
)

it('does not resume after the original task entry is replaced', async () => {
  const f = fixture()
  f.runtime.tasks.set('task', { ...f.task, threadId: 'replacement' })
  f.release()
  await f.recovery
  expect(f.runtime.resumeTask).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
})

it('rechecks the original binding after retry backoff', async () => {
  vi.useFakeTimers()
  const f = fixture()
  vi.mocked(f.runtime.resumeTask).mockRejectedValueOnce(new Error('transport unavailable'))
  f.release()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.runtime.resumeTask).toHaveBeenCalledTimes(1)
  f.task.threadId = 'replacement'
  await vi.advanceTimersByTimeAsync(250)
  await f.recovery
  expect(f.runtime.resumeTask).toHaveBeenCalledTimes(1)
  expect(emit.mock.calls.some(([, event]) => (event as { event: string }).event === 'async-question:refresh')).toBe(false)
})

it('refreshes the original questions after recovery with equivalent path spelling', async () => {
  const f = fixture()
  f.runtime.tasks.set('task', { ...f.task, workspacePath: '/workspace/' })
  f.release()
  await f.recovery
  expect(f.runtime.resumeTask).toHaveBeenCalledOnce()
  expect(emit).toHaveBeenCalledWith(expect.any(String), {
    event: 'async-question:refresh', payload: {
      taskId: 'task', serverId: 'server', threadId: 'thread', workspacePath: '/workspace',
    },
  })
})

it('does not publish recovered questions after the binding changes during resume', async () => {
  const f = fixture()
  const resume = f.runtime.resumeTask
  vi.mocked(resume).mockImplementationOnce(async task => {
    f.runtime.tasks.set('task', { ...task, threadId: 'replacement' })
    const client = {} as Awaited<ReturnType<typeof resume>>
    f.runtime.clientByTask.set('task', client)
    return client
  })
  f.release()
  await f.recovery
  expect(emit.mock.calls.map(([, event]) => (event as { event: string }).event))
    .toEqual(['response.block.created'])
})

it('does not publish reconnect success after a question refresh yields to a rebind', async () => {
  const f = fixture()
  emit.mockImplementation(async (_name, event) => {
    if ((event as { event: string }).event === 'async-question:refresh')
      f.task.threadId = 'replacement'
  })
  f.release()
  await f.recovery
  expect(emit.mock.calls.map(([, event]) => (event as { event: string }).event))
    .toEqual(['response.block.created', 'async-question:refresh'])
})
