import { beforeEach, expect, test, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

const invalidEnvelopes = [
  ...['1.0', '', null, 2].map(jsonrpc => ({ jsonrpc })),
  ...[{ thread_id: 'peer-thread' }, { thread: { id: 'peer-thread' } },
    { thread: { threadId: 'peer-thread' } }, { widget: { threadId: 'peer-thread' } },
    { turn: { threadId: 'peer-thread' } }, { turn_id: 'peer-turn' },
    { turn: { id: 'peer-turn' } }, { turn: { turnId: 'peer-turn' } },
    { thread_id: 7 }, { turn_id: '' },
    { thread: [] }, { widget: 'invalid' }, { turn: [] },
  ].map(params => ({ params })),
]

for (const kind of ['question', 'approval'] as const) {
  test.each(invalidEnvelopes)(`${kind}: invalid request envelope %j cannot reserve or replace the original card`, async invalid => {
    const client = { respond: vi.fn(), respondError: vi.fn(), supportsExperimental: () => true }
    const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
    const runtime = {
      disposed: false, appServerDisconnectedClients: new WeakSet(),
      tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
      threadByTask: new Map([[task.taskId, task.threadId]]),
      taskByThread: new Map([['target\0thread', task.taskId]]),
      threadKey: (target: string, thread: string) => `${target}\0${thread}`,
      turnAttemptIds: new Map(), pendingQuestionByKey: new Map(), forwardApprovalRequest,
    } as unknown as GatewayRuntimeCore
    const original = { id: 101, method: `${kind}/request`, params: {
      threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original',
      ...(kind === 'question'
        ? { questions: [{ id: 'choice', prompt: 'Original prompt?', options: [] }] }
        : { reason: 'Original permission', action: { type: 'command', command: 'echo original' },
            availableDecisions: ['accept', 'decline'] }),
    } }
    const forward = (message: unknown) => forwardServerRequest.call(runtime, client as never, message as typeof original, 'target')
    const malformed = { ...original, ...invalid,
      params: { ...original.params, ...('params' in invalid ? invalid.params : {}),
        ...(kind === 'question' ? { questions: [{ id: 'choice', prompt: 'Foreign prompt?', options: [] }] }
          : { reason: 'Foreign permission' }),
      } }
    await forward(malformed)
    expect.soft(runtime.pendingQuestionByKey.size).toBe(0)
    expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
    expect.soft(client.respondError).not.toHaveBeenCalled()
    // Older producers can omit the version and nullable aliases. Matching
    // locators must still restore the exact original question and answer.
    await forward({ ...original, params: { ...original.params, thread_id: 'thread',
      thread: { id: 'thread', threadId: 'thread' }, widget: null, turn_id: null,
      turn: { id: 'turn', turnId: 'turn', threadId: 'thread' },
    } })
    const pending = runtime.pendingQuestionByKey.get('task\0' + 101)!
    expect(pending.renderPayload.questions).toMatchObject([{ question: expect.stringContaining('Original') }])
    const publications = vi.mocked(emitRuntimeEvent).mock.calls.length
    await forward(malformed)
    expect(runtime.pendingQuestionByKey.get('task\0' + 101)).toBe(pending)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(publications)
    await forward({ ...original, jsonrpc: '2.0' })
    expect(runtime.pendingQuestionByKey.get('task\0' + 101)).toBe(pending)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(publications)
    expect(await respondToTaskQuestion.call(runtime, 'task', { requestId: 101,
      answers: { [kind === 'question' ? 'choice' : 'original']: { answers: [kind === 'question' ? 'Original answer' : 'Allow once'] } },
    })).toMatchObject({ accepted: true })
    expect(client.respond).toHaveBeenCalledExactlyOnceWith(101, expect.objectContaining({
      threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'original',
    }))
  })
}
