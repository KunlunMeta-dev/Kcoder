import { beforeEach, expect, it, vi } from 'vitest'
import type { AsyncQuestionRecord } from '../../../../../shared/generated/contracts'
import { asyncQuestionRevisionFingerprint } from '../../../../../shared/asyncQuestionRevision'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

it('projects the complete question fingerprint without trusting a producer-supplied hint', async () => {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
  const client = { supportsExperimental: () => true }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([['task', client]]),
  }
  const question: AsyncQuestionRecord = {
    questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'source',
    toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
    questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
  }
  await forwardAcceptedNotification.call(runtime as unknown as GatewayRuntimeCore,
    'asyncQuestion/changed', { threadId: 'thread', question, revisionFingerprint: 'forged' },
    'target', client as never)
  expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
    event: 'async-question:changed', payload: {
      taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 1,
      revisionFingerprint: asyncQuestionRevisionFingerprint(question),
    },
  })
})
