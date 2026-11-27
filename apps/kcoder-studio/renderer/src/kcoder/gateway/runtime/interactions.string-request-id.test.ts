import { beforeEach, expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'
import { forwardAcceptedNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', async importOriginal => ({
  ...await importOriginal<typeof import('../../gatewayServiceBridge')>(),
  emitRuntimeEvent: vi.fn(async () => undefined),
}))
beforeEach(() => vi.clearAllMocks())

for (const kind of ['question', 'approval'] as const) {
  test.each(['original-interaction', '101'])(`${kind}: string request ID %s supports replay, rejection recovery and terminal settlement`, async requestId => {
    const taskId = 'task', threadId = 'thread', turnId = 'turn'
    const client = { supportsExperimental: () => true, respond: vi.fn(), respondError: vi.fn() }
    const runtime = {
      disposed: false, appServerDisconnectedClients: new WeakSet(),
      remoteSessions: { handleNotification: () => false },
      toolPathPreviews: { beforeResumeBoundary: () => false, handle: () => {} },
      tasks: new Map([[taskId, { taskId, serverId: 'target', threadId, workspacePath: '/owned' }]]),
      clientByTask: new Map([[taskId, client]]), threadByTask: new Map([[taskId, threadId]]),
      taskByThread: new Map([['target\0thread', taskId]]),
      threadKey: (server: string, thread: string) => `${server}\0${thread}`,
      pendingQuestionByKey: new Map(), turnAttemptIds: new Map(), forwardApprovalRequest,
    } as unknown as GatewayRuntimeCore
    const binding = { threadId, turnId, appServerEpoch: 'epoch',
      ...(kind === 'question' ? { questionId: 'question' } : { approvalId: 'approval' }) }
    const frame = { id: requestId, method: `${kind}/request`, params: {
      ...binding, ...(kind === 'question'
        ? { questions: [{ id: 'item', prompt: 'Which?', options: [] }] }
        : { action: { type: 'command', command: 'echo controlled' }, availableDecisions: ['accept', 'decline'] }),
    } }
    await forwardServerRequest.call(runtime, client as never, frame, 'target')
    const key = `${taskId}\0${requestId}`, pending = runtime.pendingQuestionByKey.get(key)
    expect(pending).toBeDefined()
    expect(pending?.requestId).toBe(requestId)
    await forwardServerRequest.call(runtime, client as never, frame, 'target')
    expect(runtime.pendingQuestionByKey.get(key)).toBe(pending)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    if (requestId === '101') {
      await forwardServerRequest.call(runtime, client as never, { ...frame, id: 101 }, 'target')
      expect(runtime.pendingQuestionByKey.get(key)).toBe(pending)
      expect(client.respondError).toHaveBeenCalledExactlyOnceWith(101, -32040, expect.any(String), {
        interactionBinding: binding,
      })
    }
    const response = { requestId, ...binding,
      answers: { [kind === 'question' ? 'item' : 'approval']: { answers: [kind === 'question' ? 'Answer' : 'Allow once'] } } }
    expect(await respondToTaskQuestion.call(runtime, taskId, response)).toMatchObject({ accepted: true })
    expect(await respondToTaskQuestion.call(runtime, taskId, response)).toMatchObject({ accepted: false })
      expect(client.respond).toHaveBeenCalledExactlyOnceWith(requestId, expect.objectContaining({
        threadId, turnId, appServerEpoch: 'epoch',
        ...(kind === 'question' ? { questionId: 'question' } : { approvalId: 'approval' }),
      }))
    if (requestId === '101') {
      await forwardAcceptedNotification.call(runtime, 'gateway/interaction/replyRejected',
        { requestId: 101, ...binding }, 'target', client as never)
      await forwardAcceptedNotification.call(runtime, `${kind}/resolved`, {
        requestId: 101, ...binding, reason: 'client_response',
        ...(kind === 'approval' ? { decision: 'accept' } : {}),
      }, 'target', client as never)
      expect(runtime.pendingQuestionByKey.get(key)).toBe(pending)
      expect(pending?.responsePending).toBe(true)
    }
    await forwardAcceptedNotification.call(runtime, 'gateway/interaction/replyRejected',
      { requestId, ...binding }, 'target', client as never)
    expect(pending?.responsePending).toBeFalsy()
    expect(pending?.submittedResponse).toBeUndefined()
    expect(await respondToTaskQuestion.call(runtime, taskId, response)).toMatchObject({ accepted: true })
    await forwardAcceptedNotification.call(runtime, `${kind}/resolved`, {
      requestId, ...binding, reason: 'client_response', ...(kind === 'approval' ? { decision: 'accept' } : {}),
    }, 'target', client as never)
    expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
    expect(client.respond).toHaveBeenCalledTimes(2)
    expect(emitRuntimeEvent).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      event: 'response.block.updated', payload: expect.objectContaining({
        data: expect.objectContaining({ updates: expect.objectContaining({ status: 'done' }) }),
      }),
    }))
  })
}

test.each([101, '101'])('runtime.tasks.send keeps the type of request %j on the original task connection', async requestId => {
  const client = new FakeGatewayClient('original-thread')
  const runtime = createTestGatewayRuntime('fixture-token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  try {
    const { taskId } = await runtime.request('runtime.tasks.create', {
      taskId: 'draft', executionRequest: { prompt: 'controlled fixture' },
    }) as { taskId: string }
    client.dispatchEvent(new CustomEvent('request', { detail: {
      id: requestId, method: 'question/request', params: {
        threadId: 'original-thread', turnId: 'turn', questionId: 'original-question',
        questions: [{ id: 'item', prompt: 'Which?', options: [] }],
      },
    } }))
    await vi.waitFor(() => expect(runtime.pendingQuestionByKey.size).toBe(1))
    const answers = { item: { answers: ['Answer'] } }
    const otherType = typeof requestId === 'number' ? String(requestId) : Number(requestId)
    expect(await runtime.request('runtime.tasks.send', { taskId,
      requestUserInputResponse: { requestId: otherType, answers },
    })).toMatchObject({ accepted: false, code: 'interaction_request_conflict' })
    expect(client.responses).toEqual([])
    expect([...runtime.pendingQuestionByKey.values()][0].responsePending).toBeUndefined()
    expect(await runtime.request('runtime.tasks.send', { taskId,
      requestUserInputResponse: { requestId, answers },
    })).toMatchObject({ accepted: true, pendingServerConfirmation: true })
    expect(client.responses).toEqual([{ id: requestId, result: {
      answers, threadId: 'original-thread', turnId: 'turn', questionId: 'original-question',
    } }])
  } finally { await runtime.dispose() }
})
