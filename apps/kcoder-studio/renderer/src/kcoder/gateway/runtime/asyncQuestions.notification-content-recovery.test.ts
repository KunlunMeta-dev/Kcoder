import { beforeEach, expect, it, vi } from 'vitest'
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
  ['oversized UTF-8 source identity', { sourceTurnId: '界'.repeat(86) }],
  ['oversized UTF-8 header', { questions: [{ ...item, header: '界'.repeat(86) }] }],
  ['oversized prompt', { questions: [{ ...item, question: 'x'.repeat(16385) }] }],
  ['oversized label', { questions: [{ ...item, options: [{ ...item.options[0], label: '界'.repeat(86) }] }] }],
  ['oversized description', { questions: [{ ...item, options: [{ ...item.options[0], description: '界'.repeat(683) }] }] }],
  ['escaped request overflow', { questions: [{ ...item, question: '\u0001'.repeat(12000) }] }],
  ['oversized saved answer', { answer: { ...question.answer!, answers: { item: { text: 'x'.repeat(16384) } } } }],
  ['escaped delivery error overflow', { deliveryError: '\u0001'.repeat(342) }],
  ['no question items', { questions: [] }],
  ['empty header', { questions: [{ ...item, header: '' }] }],
  ['blank header', { questions: [{ ...item, header: '   ' }] }],
  ['blank prompt', { questions: [{ ...item, question: '   ' }] }],
  ['duplicate items', { questions: [item, item] }],
  ['duplicate choices', { questions: [{ ...item, options: [...item.options, ...item.options] }] }],
  ['foreign answer item', { answer: { ...question.answer!, answers: { foreign: { text: 'Another question' } } } }],
  ['foreign selected option', { answer: { ...question.answer!, answers: { item: { selectedOptionIds: ['other'] } } } }],
  ['empty saved answer', { answer: { ...question.answer!, answers: { item: { text: '   ' } } } }],
  ['missing saved answer', { answer: undefined }],
])('a complete notification with %s leaves its replay identity available for recovery', async (_name, overrides) => {
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
  // Native compatibility transports can replay a corrected complete snapshot
  // under the same event ID. Rejection by the card must not consume that event.
  await notify(question)
  expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
    event: 'async-question:changed', payload: {
      taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2,
      revisionFingerprint: asyncQuestionRevisionFingerprint(question),
    },
  })
  await notify(question)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})
