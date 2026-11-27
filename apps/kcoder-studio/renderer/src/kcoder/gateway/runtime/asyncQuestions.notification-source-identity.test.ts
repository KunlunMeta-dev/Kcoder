import { beforeEach, expect, it, vi } from 'vitest'
import type { AsyncQuestionRecord } from '../../../../../shared/generated/contracts'
import { asyncQuestionRevisionFingerprint } from '../../../../../shared/asyncQuestionRevision'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Details', question: 'Any details?', multiSelect: false, options: [] }],
}

for (const field of ['questionId', 'requestId', 'sourceTurnId', 'toolCallId'] as const) {
  it.each(['', ' \t\n '])(`a blank ${field} cannot consume the corrected notification's replay identity (%j)`, async value => {
    const client = { supportsExperimental: () => true }
    const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
    const runtime = {
      disposed: false, appServerDisconnectedClients: new WeakSet(),
      tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
      threadKey: (target: string, thread: string) => `${target}\0${thread}`,
      clientByTask: new Map([['task', client]]), notificationReplayGuard: new NotificationReplayGuard(),
      forwardAcceptedNotification,
    }
    const notify = (record: AsyncQuestionRecord) => forwardNotification.call(runtime as unknown as GatewayRuntimeCore,
      'asyncQuestion/changed', { threadId: 'thread', serverId: 'native', sequence: 42, question: record },
      'target', client as never)

    await notify({ ...question, [field]: value })
    expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
    await notify(question)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(emitRuntimeEvent).mock.calls[0][1]).toMatchObject({
      event: 'async-question:changed', payload: { taskId: 'task', questionId: 'question',
        revisionFingerprint: asyncQuestionRevisionFingerprint(question) },
    })
    await notify(question)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  })
}
