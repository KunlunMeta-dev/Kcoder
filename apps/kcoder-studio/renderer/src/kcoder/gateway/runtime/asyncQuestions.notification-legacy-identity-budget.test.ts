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
  return (fields: Record<string, unknown>) => forwardNotification.call(
    runtime as unknown as GatewayRuntimeCore, 'asyncQuestion/changed', {
      threadId: 'thread', serverId: 'native', sequence: 42,
      question: { threadId: 'thread', questionId: 'question', revision: 2, ...fields },
    }, 'target', client as never)
}

for (const field of ['questionId', 'requestId', 'sourceTurnId', 'toolCallId']) {
  it.each([
    ['ASCII overflow', 'x'.repeat(257)],
    ['UTF-8 overflow', '界'.repeat(86)],
    ['invalid Unicode scalar', 'source\ud800'],
  ])(`a legacy hint with ${field} %s cannot consume corrected recovery`, async (_name, value) => {
    const notify = fixture()
    await notify({ [field]: value })
    expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
    await notify({})
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
      event: 'async-question:changed', payload: {
        taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2,
      },
    })
    await notify({})
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  })
}

it.each(['x'.repeat(256), '界'.repeat(85) + 'x', '😀'.repeat(64), ' ' + 'x'.repeat(254) + ' '])(
  'retains exact 256-byte legacy identities without normalization (%j)', async value => {
    const notify = fixture()
    await notify({ questionId: value, requestId: value, sourceTurnId: value, toolCallId: value })
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
      event: 'async-question:changed', payload: {
        taskId: 'task', serverId: 'target', threadId: 'thread', questionId: value, revision: 2,
      },
    })
  }
)
