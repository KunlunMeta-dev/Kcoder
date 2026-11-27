import { beforeEach, expect, test, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'
import { forwardAcceptedNotification } from './notifications'
import type { GatewayRuntimeCore } from './core'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

for (const kind of ['question', 'approval'] as const) {
  test.each([101, '101'])(`${kind}: reconnect keeps the new wire type after request %j`, async originalId => {
    const taskId = 'task', threadId = 'thread', turnId = 'turn'
    let connectionId = 'original-connection'
    const client = {
      get diagnosticConnection() { return { connectionId } },
      supportsExperimental: () => true, respond: vi.fn(), respondError: vi.fn(),
    }
    const runtime = {
      disposed: false, appServerDisconnectedClients: new WeakSet(),
      tasks: new Map([[taskId, { taskId, serverId: 'target', threadId, workspacePath: '/owned', runtimeHandle: {} }]]),
      clientByTask: new Map([[taskId, client]]), threadByTask: new Map([[taskId, threadId]]),
      taskByThread: new Map([['target\0thread', taskId]]),
      threadKey: (server: string, thread: string) => `${server}\0${thread}`,
      pendingQuestionByKey: new Map(), turnAttemptIds: new Map(), forwardApprovalRequest,
      remoteSessions: { handleNotification: () => false },
      toolPathPreviews: { beforeResumeBoundary: () => false, handle: () => {} },
    } as unknown as GatewayRuntimeCore
    const binding = { threadId, turnId, appServerEpoch: 'epoch',
      ...(kind === 'question' ? { questionId: 'question' } : { approvalId: 'approval' }) }
    const params = { ...binding, ...(kind === 'question'
      ? { questions: [{ id: 'choice', prompt: 'Which original choice?', options: [] }] }
      : { action: { type: 'command', command: 'echo controlled' }, availableDecisions: ['accept', 'decline'] }) }
    const forward = (id: string | number) => forwardServerRequest.call(runtime, client as never,
      { id, method: `${kind}/request`, params }, 'target')
    await forward(originalId)
    const key = `${taskId}\0${originalId}`, original = runtime.pendingQuestionByKey.get(key)!
    connectionId = 'replacement-connection'
    const requestId = typeof originalId === 'number' ? String(originalId) : Number(originalId)
    await forward(requestId)
    const current = runtime.pendingQuestionByKey.get(key)!
    expect(current).not.toBe(original)
    expect(current.requestId).toBe(requestId)
    expect(current.renderPayload.requestId).toBe(requestId)
    expect(current.connectionId).toBe(connectionId)
    expect(original.connectionId).toBe('original-connection')
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
    const answers = { [kind === 'question' ? 'choice' : 'approval']: {
      answers: [kind === 'question' ? 'Original answer' : 'Allow once'],
    } }
    expect(await respondToTaskQuestion.call(runtime, taskId, { requestId: originalId, answers }))
      .toMatchObject({ accepted: false, code: 'interaction_request_conflict' })
    expect(client.respond).not.toHaveBeenCalled()
    await forward(requestId)
    expect(runtime.pendingQuestionByKey.get(key)).toBe(current)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
    expect(await respondToTaskQuestion.call(runtime, taskId, { requestId, answers }))
      .toMatchObject({ accepted: true, pendingServerConfirmation: true })
    expect(await respondToTaskQuestion.call(runtime, taskId, { requestId, answers }))
      .toMatchObject({ accepted: false, code: 'request_user_input_response_pending' })
    expect(client.respond).toHaveBeenCalledExactlyOnceWith(requestId, {
      threadId, turnId, appServerEpoch: binding.appServerEpoch, ...(kind === 'question' ? { questionId: 'question', answers }
        : { approvalId: 'approval', decision: 'accept' }),
    })
    // A later replay with this exact wire ID preserves the unconfirmed send.
    connectionId = 'third-connection'
    await forward(requestId)
    expect(runtime.pendingQuestionByKey.get(key)).toBe(current)
    expect(current.responsePending).toBe(true)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
    expect(await respondToTaskQuestion.call(runtime, taskId, { requestId, answers }))
      .toMatchObject({ accepted: false, code: 'request_user_input_response_pending' })
    await forwardAcceptedNotification.call(runtime, `${kind}/resolved`, {
      ...binding, requestId: originalId, reason: 'client_response',
      ...(kind === 'approval' ? { decision: 'accept' } : {}),
    }, 'target', client as never)
    expect(runtime.pendingQuestionByKey.get(key)).toBe(current)
    await forwardAcceptedNotification.call(runtime, `${kind}/resolved`, {
      ...binding, requestId, reason: 'client_response',
      ...(kind === 'approval' ? { decision: 'accept' } : {}),
    }, 'target', client as never)
    expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
    expect(client.respond).toHaveBeenCalledOnce()
  })
}
