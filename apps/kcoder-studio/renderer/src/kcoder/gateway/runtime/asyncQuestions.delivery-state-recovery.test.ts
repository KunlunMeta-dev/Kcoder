import { beforeEach, expect, it, vi } from 'vitest'
import { hasValidQuestionAnswers } from '../../../../../shared/asyncQuestionRecordValidation'
import type { AsyncQuestionRecord } from '../../../../../shared/generated/contracts'
import { asyncQuestionRevisionFingerprint } from '../../../../../shared/asyncQuestionRevision'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

const item = { id: 'item', header: 'Mode', question: 'Continue?', multiSelect: false,
  options: [{ id: 'yes', label: 'Yes', description: '' }] }
const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'source',
  toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued', questions: [item],
  answer: { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { selectedOptionIds: ['yes'] } } },
}

it.each([
  ['unexpected queued error', { deliveryError: 'Old delivery failure' }],
  ['missing failure diagnostic', { revision: 3, status: 'delivery_failed' }, 'delivery_failed'],
  ['null unknown-delivery diagnostic', { revision: 3, status: 'delivery_unknown', deliveryError: null }, 'delivery_unknown'],
  ['a saved answer at creation', { revision: 1 }],
  ['a queued answer above the save revision', { revision: 3 }],
  ['applied context at the save revision', { status: 'context_applied' }],
  ['failed delivery at the save revision', { status: 'delivery_failed' }],
  ['unknown delivery at the save revision', { status: 'delivery_unknown' }],
  ['cancellation of a saved answer at its save revision', { status: 'cancelled', revision: 2 }],
  ['staleness of a saved answer at its save revision', { status: 'stale', revision: 2 }],
  ['cancellation at creation', { status: 'cancelled', revision: 1, answer: undefined }],
  ['staleness at creation', { status: 'stale', revision: 1, answer: undefined }],
  ['unexpected pending error', { status: 'pending', revision: 1, answer: undefined, deliveryError: 'Old delivery failure' }],
  ['unexpected cancellation error', { status: 'cancelled', answer: undefined, deliveryError: 'Old delivery failure' }],
] as const)('a complete notification with %s leaves its replay identity available for recovery', async (_name, overrides, correctedStatus?) => {
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
    'asyncQuestion/changed', { threadId: 'thread', serverId: 'native', sequence: 42, question: JSON.parse(JSON.stringify(record)) },
    'target', client as never)

  await notify({ ...question, ...overrides })
  expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
  // Native compatibility transports can replay a corrected complete snapshot
  // under the same event ID. Rejection by the card must not consume that event.
  const corrected: AsyncQuestionRecord = correctedStatus
    ? { ...question, revision: 3, status: correctedStatus, deliveryError: 'Original delivery diagnostic' }
    : question
  await notify(corrected)
  expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
    event: 'async-question:changed', payload: {
      taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: corrected.revision,
      revisionFingerprint: asyncQuestionRevisionFingerprint(corrected),
    },
  })
  await notify(corrected)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

// Valid failure receipts retain their diagnostic text; nullable legacy fields
// still mean no error on an unanswered pending card.
it.each(['delivery_failed', 'delivery_unknown'] as const)('retains an original %s error', status => {
  expect(hasValidQuestionAnswers({ ...question, revision: 3, status, deliveryError: '原投递失败\n😀' })).toBe(true)
})
it.each([undefined, null])('preserves a nullable legacy pending error (%s)', deliveryError => {
  const pending: AsyncQuestionRecord = { ...question }
  delete pending.answer
  expect(hasValidQuestionAnswers({ ...pending, status: 'pending', revision: 1, deliveryError })).toBe(true)
})
