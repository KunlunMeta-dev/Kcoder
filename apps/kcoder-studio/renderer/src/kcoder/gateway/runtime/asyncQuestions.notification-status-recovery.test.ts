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
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([['task', client]]), notificationReplayGuard: new NotificationReplayGuard(),
    forwardAcceptedNotification,
  }
  return (status: unknown, revision = 2) => forwardNotification.call(runtime as unknown as GatewayRuntimeCore,
    'asyncQuestion/changed', { threadId: 'thread', serverId: 'native', sequence: 42,
      question: { threadId: 'thread', questionId: 'question', revision, status } },
    'target', client as never)
}

it.each([null, '', 'unknown_status', 7, false, {}, []].map(status => ({ status })))(
  'a legacy hint with status $status cannot consume the original recovery event', async ({ status }) => {
    const notify = fixture()
    await notify(status, 1)
    expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
    // An older Gateway can send partial hints. Reject the bad copy without
    // claiming the sequence needed to refresh the original task on recovery.
    await notify('queued')
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
      event: 'async-question:changed', payload: {
        taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2,
      },
    })
    await notify('queued')
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  }
)

it.each([
  [undefined, 1], ['pending', 1], ['answer_saved', 2], ['queued', 2], ['context_applied', 3],
  ['delivery_failed', 3], ['delivery_unknown', 3], ['cancelled', 2], ['stale', 2],
])(
  'retains legacy refresh hints with status %s at revision %s', async (status, revision) => {
    await fixture()(status, revision)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  }
)

it.each(['pending', 'context_applied', 'delivery_failed', 'delivery_unknown'])(
  'an impossible %s revision leaves the corrected notification available for readback', async status => {
    const notify = fixture()
    await notify(status, 2)
    expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
    await notify('queued', 2)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  }
)
