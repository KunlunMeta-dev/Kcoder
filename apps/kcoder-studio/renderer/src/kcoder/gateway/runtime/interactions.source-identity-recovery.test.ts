import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

it.each([
  { parentSessionId: 'thread', agentId: ' \t' },
  { parentSessionId: 'thread', agentId: 'worker',
    backgroundRun: { parentSessionId: 'thread', agentId: 'worker', runId: '\u3000' } },
])('invalid source %j cannot reserve a question or hide its recovered original', async sourceAgent => {
  const client = { respond: vi.fn(), respondError: vi.fn(), supportsExperimental: () => true }
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    threadByTask: new Map([[task.taskId, task.threadId]]),
    taskByThread: new Map([['target\0thread', task.taskId]]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    turnAttemptIds: new Map(), pendingQuestionByKey: new Map(),
  } as unknown as GatewayRuntimeCore
  const forward = (source: Record<string, unknown>) => forwardServerRequest.call(runtime, client as never, {
    id: 101, method: 'question/request', params: {
      threadId: 'thread', turnId: 'turn', appServerEpoch: 'current-epoch',
      questionId: 'original', sourceAgent: source,
      questions: [{ id: 'choice', prompt: 'Which original choice?', options: [] }],
    },
  }, 'target')

  await forward(sourceAgent)
  expect(client.respondError).toHaveBeenCalledExactlyOnceWith(101, -32040, 'invalid subagent interaction origin', {
    interactionBinding: {
      questionId: 'original', threadId: 'thread', turnId: 'turn', appServerEpoch: 'current-epoch',
    },
  })
  expect(runtime.pendingQuestionByKey.size).toBe(0)
  expect(emitRuntimeEvent).not.toHaveBeenCalled()
  expect(client.respond).not.toHaveBeenCalled()

  const originalSource = { parentSessionId: 'thread', agentId: 'worker',
    backgroundRun: { parentSessionId: 'thread', agentId: 'worker', runId: 'original-run' } }
  await forward(originalSource)
  expect(runtime.pendingQuestionByKey.get('task\0' + 101)?.renderPayload.sourceAgent).toEqual(originalSource)
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
  const answers = { choice: { answers: ['Original answer'] } }
  expect(await respondToTaskQuestion.call(runtime, 'task', {
    requestId: 101, answers, sourceAgent: originalSource,
  })).toMatchObject({ accepted: true })
  expect(client.respond).toHaveBeenCalledExactlyOnceWith(101, {
    answers, questionId: 'original', threadId: 'thread', turnId: 'turn', appServerEpoch: 'current-epoch',
  })
})

it('binds a missing-task-index refusal to this prompt and leaves unrelated waiters intact', async () => {
  const client = { respond: vi.fn(), respondError: vi.fn(), supportsExperimental: () => true }
  const unrelatedKey = `other-task\0${101}`
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map(), clientByTask: new Map(), threadByTask: new Map(),
    taskByThread: new Map(), threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    pendingQuestionByKey: new Map([[unrelatedKey, { requestId: 101, taskId: 'other-task' }]]),
  } as unknown as GatewayRuntimeCore

  await forwardServerRequest.call(runtime, client as never, {
    id: 101, method: 'question/request', params: {
      threadId: 'current-thread', turnId: 'current-turn', questionId: 'current-question',
      appServerEpoch: 'current-epoch',
      questions: [{ id: 'choice', prompt: 'Current prompt?', options: [] }],
    },
  }, 'current-target')

  expect(client.respondError).toHaveBeenCalledExactlyOnceWith(101, -32040,
    '交互请求无法关联到活动任务', { interactionBinding: {
      questionId: 'current-question', threadId: 'current-thread', turnId: 'current-turn',
      appServerEpoch: 'current-epoch',
    } })
  expect(runtime.pendingQuestionByKey.get(unrelatedKey)).toBeDefined()
  expect(runtime.pendingQuestionByKey.size).toBe(1)
})

it('does not invent a binding when the current refusal lacks an interaction identity', async () => {
  const client = { respond: vi.fn(), respondError: vi.fn(), supportsExperimental: () => true }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map(), clientByTask: new Map(), threadByTask: new Map(), taskByThread: new Map(),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
  } as unknown as GatewayRuntimeCore

  await forwardServerRequest.call(runtime, client as never, {
    id: 102, method: 'question/request', params: {
      threadId: 'current-thread', turnId: 'current-turn', appServerEpoch: 'current-epoch',
      questions: [{ id: 'choice', prompt: 'Current prompt?', options: [] }],
    },
  }, 'current-target')

  expect(client.respondError).toHaveBeenCalledExactlyOnceWith(102, -32040,
    '交互请求无法关联到活动任务')
})
