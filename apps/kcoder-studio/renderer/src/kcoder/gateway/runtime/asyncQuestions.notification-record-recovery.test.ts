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
  questions: [{ id: 'item', header: 'Mode', question: 'Continue?', multiSelect: false, options: [] }],
}

it.each([
  ['null items', { questions: null }],
  ['malformed option', { questions: [{ ...question.questions[0], options: [null] }] }],
  ['missing source identity', { requestId: undefined }],
  ['inflated pending revision', { revision: 2 }],
  ['malformed saved answer', { status: 'queued', answer: { submissionId: 'saved', answers: null } }],
])('an explicit snapshot with %s cannot consume the original recovery event', async (_name, overrides) => {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
  const client = { supportsExperimental: () => true }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([['task', client]]), notificationReplayGuard: new NotificationReplayGuard(),
    forwardAcceptedNotification,
  }
  const notify = (record: unknown) => forwardNotification.call(runtime as unknown as GatewayRuntimeCore,
    'asyncQuestion/changed', { threadId: 'thread', serverId: 'native', sequence: 42, question: record },
    'target', client as never)

  await notify({ ...question, ...overrides })
  expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
  // Recovery may redeliver this event with the complete original record. The
  // rejected copy must not suppress that refresh, even with the same sequence.
  await notify(question)
  expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
    event: 'async-question:changed', payload: {
      taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 1,
      revisionFingerprint: asyncQuestionRevisionFingerprint(question),
    },
  })
  await notify(question)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})
