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

it('a replacement client can replay a question while its stale predecessor is still projecting', async () => {
  const f = fixture()
  const previous = f.notify()
  const recovered = { supportsExperimental: vi.fn(() => true) }
  f.runtime.clientByTask.set('task', recovered)
  const replay = () => forwardNotification.call(f.runtime as unknown as GatewayRuntimeCore,
    'asyncQuestion/changed', {
      threadId: 'thread', serverId: 'native', sequence: 42,
      question: { threadId: 'thread', questionId: 'question', revision: 2 },
    }, 'target', recovered as never)

  // Each client owns an ordered queue, but old and replacement queues overlap.
  // Neither a stale projection nor its optimistic replay claim refreshed the card.
  const current = replay()
  await Promise.all([previous, current])
  expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
    event: 'async-question:changed',
    payload: { taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2 },
  })
  await replay()
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

it('a duplicate arriving during question publication cannot release the winning replay claim', async () => {
  const f = fixture()
  let finish!: () => void
  vi.mocked(emitRuntimeEvent).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const first = f.notify()
  await vi.waitFor(() => expect(emitRuntimeEvent).toHaveBeenCalledTimes(1))
  await f.notify()
  finish()
  await first
  await f.notify()
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

it('a failed publication on a retired connection cannot swallow the recovered replay', async () => {
  const f = fixture()
  const params = { threadId: 'thread', serverId: 'native', sequence: 42,
    question: { threadId: 'thread', questionId: 'question', revision: 2 } }
  const notifyOn = (client: typeof f.client, connectionId: string) => {
    const diagnosticConnection = { targetId: 'target', connectionId }
    return forwardNotification.call(f.runtime as unknown as GatewayRuntimeCore,
      'asyncQuestion/changed', params, 'target',
      Object.assign(client, { diagnosticConnection }) as never, diagnosticConnection)
  }
  let fail!: (error: Error) => void
  vi.mocked(emitRuntimeEvent).mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject }))
  const previous = notifyOn(f.client, 'rpc-1-1')
  const failed = expect(previous).rejects.toThrow('old listener unavailable')
  await vi.waitFor(() => expect(emitRuntimeEvent).toHaveBeenCalledTimes(1))

  const recovered = { ...f.client }
  f.runtime.clientByTask.set('task', recovered)
  await notifyOn(recovered, 'rpc-2-1')
  fail(new Error('old listener unavailable'))
  await failed
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)

  await notifyOn(recovered, 'rpc-2-1')
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
})

it.each(['native', undefined])('scopes replay to the owning client without diagnostics (producer=%s)', async serverId => {
  const f = fixture()
  const replay = (client: typeof f.client) => forwardNotification.call(f.runtime as unknown as GatewayRuntimeCore,
    'asyncQuestion/changed', {
      threadId: 'thread', ...(serverId === undefined ? {} : { serverId }), sequence: 42,
      question: { threadId: 'thread', questionId: 'question', revision: 2 },
    }, 'target', client as never)

  await replay(f.client)
  await replay(f.client)
  expect.soft(emitRuntimeEvent).toHaveBeenCalledTimes(1)

  const recovered = { ...f.client }
  f.runtime.clientByTask.set('task', recovered)
  await replay(f.client)
  await replay(recovered)
  await replay(recovered)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
})
