import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

beforeEach(() => vi.clearAllMocks())

function fixture() {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
  const client = { supportsExperimental: () => true }
  const runtime = {
    disposed: false,
    appServerDisconnectedClients: new WeakSet<object>(),
    tasks: new Map([[task.taskId, task]]),
    taskByThread: new Map([['target\0thread', task.taskId]]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([[task.taskId, client]]),
    notificationReplayGuard: { accept: () => true, release: vi.fn() },
    forwardAcceptedNotification: forwardAcceptedNotification as unknown,
  }
  const notify = (source = client) => forwardNotification.call(runtime as unknown as GatewayRuntimeCore,
    'asyncQuestion/changed', { threadId: task.threadId,
      question: { threadId: task.threadId, questionId: 'question', revision: 2 } },
    task.serverId, source as never)
  return { runtime, client, notify }
}

for (const reason of ['app-server disconnected', 'runtime disposed']) {
  for (const timing of ['before queue', 'during projection']) {
    it(`does not refresh question cards after ${reason} (${timing})`, async () => {
      const f = fixture()
      const invalidate = () => {
        if (reason === 'app-server disconnected') f.runtime.appServerDisconnectedClients.add(f.client)
        else f.runtime.disposed = true
      }
      if (timing === 'before queue') invalidate()
      const notification = f.notify()
      // Notification projection yields while earlier ordered work settles. The
      // connection listener records disconnect before that queue drains.
      if (timing === 'during projection') invalidate()
      await notification
      expect(emitRuntimeEvent).not.toHaveBeenCalled()
    })
  }
}

it('a recovered owner still refreshes the original task and rejects the disconnected client', async () => {
  const f = fixture()
  f.runtime.appServerDisconnectedClients.add(f.client)
  await f.notify()
  expect(emitRuntimeEvent).not.toHaveBeenCalled()
  const recovered = { supportsExperimental: () => true }
  f.runtime.clientByTask.set('task', recovered)
  await f.notify(recovered)
  expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
    event: 'async-question:changed',
    payload: { taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2 },
  })
  await f.notify(f.client)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

it.each(['before projection', 'during projection'])(
  'an old socket cannot refresh async question cards after same-client reconnect (%s)', async timing => {
    const f = fixture()
    const original = { targetId: 'target', connectionId: 'rpc-1-1' }
    const connection = { ...original, connectionId: 'rpc-1-2' }
    Object.assign(f.runtime, { notificationReplayGuard: new NotificationReplayGuard() })
    Object.assign(f.client, { diagnosticConnection: timing === 'before projection' ? connection : original })
    const notify = (source = original) => forwardNotification.call(f.runtime as unknown as GatewayRuntimeCore,
      'asyncQuestion/changed', { threadId: 'thread', serverId: 'native', sequence: 42,
        question: { threadId: 'thread', questionId: 'question', revision: 2 } },
      'target', f.client as never, source)
    const pending = notify()
    Object.assign(f.client, { diagnosticConnection: connection })
    await pending
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    // The stale frame must not spend the current socket's recovery identity.
    await notify(connection)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    await notify(connection)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  }
)

it.each([1.5, Number.MAX_SAFE_INTEGER + 1])(
  'an invalid question revision %s cannot refresh a card or consume its recovery replay identity',
  async revision => {
    const f = fixture()
    Object.assign(f.runtime, { notificationReplayGuard: new NotificationReplayGuard() })
    const notify = (questionRevision: number) => forwardNotification.call(
      f.runtime as unknown as GatewayRuntimeCore, 'asyncQuestion/changed', {
        threadId: 'thread', serverId: 'native', sequence: 42,
        question: { threadId: 'thread', questionId: 'question', revision: questionRevision },
      }, 'target', f.client as never)

    await notify(revision)
    await notify(2)
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
      event: 'async-question:changed',
      payload: { taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2 },
    })
    await notify(2)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  }
)
