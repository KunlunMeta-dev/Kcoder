import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

beforeEach(() => vi.clearAllMocks())

function fixture() {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
  const client = { supportsExperimental: vi.fn(() => true) }
  const runtime = {
    disposed: false,
    appServerDisconnectedClients: new WeakSet<object>(),
    tasks: new Map([[task.taskId, task]]),
    taskByThread: new Map([['target\0thread', task.taskId]]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([[task.taskId, client]]),
    notificationReplayGuard: new NotificationReplayGuard(),
    forwardAcceptedNotification,
  }
  const notify = () => forwardNotification.call(runtime as unknown as GatewayRuntimeCore,
    'asyncQuestion/changed', {
      threadId: 'thread', serverId: 'native', sequence: 42,
      question: { threadId: 'thread', questionId: 'question', revision: 2 },
    }, 'target', client as never)
  return { runtime, client, task, notify }
}

for (const timing of ['before projection', 'during projection']) {
  it.each(['disconnected', 'replaced client', 'rebound task', 'capability lost'])(
    `%s owner does not consume the recovered question notification (${timing})`, async reason => {
      const f = fixture()
      const invalidate = () => {
        if (reason === 'disconnected') f.runtime.appServerDisconnectedClients.add(f.client)
        else if (reason === 'replaced client') f.runtime.clientByTask.set('task', { ...f.client })
        else if (reason === 'rebound task') f.runtime.tasks.set('task', { ...f.task, threadId: 'other' })
        else f.client.supportsExperimental.mockReturnValue(false)
      }
      if (timing === 'before projection') invalidate()
      const old = f.notify()
      if (timing === 'during projection') invalidate()
      await old
      expect(emitRuntimeEvent).not.toHaveBeenCalled()

      // Recovery can replay the same native event on the restored task. The
      // discarded owner's frame must not spend its successful delivery marker.
      f.runtime.appServerDisconnectedClients.delete(f.client)
      f.runtime.clientByTask.set('task', f.client)
      f.runtime.tasks.set('task', f.task)
      f.client.supportsExperimental.mockReturnValue(true)
      await f.notify()
      expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
        event: 'async-question:changed',
        payload: { taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2 },
      })
      await f.notify()
      expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    }
  )
}

it('releases a failed projection for an explicit recovery without sending answers', async () => {
  const f = fixture()
  vi.mocked(emitRuntimeEvent).mockRejectedValueOnce(new Error('listener unavailable'))
  await expect(f.notify()).rejects.toThrow('listener unavailable')
  await f.notify()
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
  await f.notify()
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
})
