import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

function fixture(field: string) {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
  const client = { supportsExperimental: () => true }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([['task', client]]), notificationReplayGuard: new NotificationReplayGuard(),
    forwardAcceptedNotification,
  }
  return (value: string) => forwardNotification.call(runtime as unknown as GatewayRuntimeCore,
    'asyncQuestion/changed', {
      threadId: 'thread', serverId: 'native', sequence: 42,
      question: {
        threadId: 'thread', questionId: 'question', revision: 2,
        ...(field === 'submissionId' ? {
          status: 'queued', answer: { submissionId: value, acceptedAtMs: 2,
            answers: { item: { text: 'Original answer' } } },
        } : { [field]: value }),
      },
    }, 'target', client as never)
}

for (const field of ['questionId', 'requestId', 'sourceTurnId', 'toolCallId', 'submissionId']) {
  it(`a Rust whitespace-only legacy ${field} leaves the original recovery sequence available`, async () => {
    const notify = fixture(field)
    await notify(' \u0085\t')
    expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
    await notify('original')
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
      event: 'async-question:changed', payload: {
        taskId: 'task', serverId: 'target', threadId: 'thread',
        questionId: field === 'questionId' ? 'original' : 'question', revision: 2,
      },
    })
    await notify('original')
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  })

  it.each(['\ufeff', ' \u0085Original\u0085 '])(
    `a valid legacy ${field} retains exact Unicode content (%j)`, async value => {
      const notify = fixture(field)
      await notify(value)
      expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
        event: 'async-question:changed', payload: {
          taskId: 'task', serverId: 'target', threadId: 'thread',
          questionId: field === 'questionId' ? value : 'question', revision: 2,
        },
      })
      await notify(value)
      expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    }
  )
}
