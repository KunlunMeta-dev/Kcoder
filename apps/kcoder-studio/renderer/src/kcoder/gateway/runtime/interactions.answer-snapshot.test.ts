import { beforeEach, expect, test, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { forwardServerRequest, respondToTaskQuestion } from './interactions'
import { forwardAcceptedNotification } from './notifications'
import type { GatewayRuntimeCore } from './core'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from '../../gatewayRuntime.test-support'

vi.mock('../../gatewayServiceBridge', async importOriginal => ({
  ...await importOriginal<typeof import('../../gatewayServiceBridge')>(),
  emitRuntimeEvent: vi.fn(async () => undefined),
}))
beforeEach(() => vi.clearAllMocks())

test.each(['requestId', 'request_id'] as const)(
  '%s confirmation retains the dispatched answer when the caller edits its draft', async requestField => {
    const taskId = 'original-task', threadId = 'original-thread', turnId = 'original-turn'
    const requestId = 101, questionId = 'original-question', appServerEpoch = 'original-epoch'
    const wireReplies: unknown[] = []
    const client = {
      supportsExperimental: () => true,
      respond: vi.fn((id, result) => wireReplies.push(structuredClone({ id, result }))),
    } as unknown as GatewayClient
    const runtime = {
      disposed: false,
      appServerDisconnectedClients: new WeakSet(),
      tasks: new Map([[taskId, { taskId, serverId: 'target', threadId, runtimeHandle: {} }]]),
      threadByTask: new Map([[taskId, threadId]]),
      taskByThread: new Map([['target\0original-thread', taskId]]),
      threadKey: (serverId: string, id: string) => `${serverId}\0${id}`,
      clientByTask: new Map([[taskId, client]]),
      pendingQuestionByKey: new Map(),
      turnAttemptIds: new Map(),
      remoteSessions: { handleNotification: () => false },
    } as unknown as GatewayRuntimeCore
    await forwardServerRequest.call(runtime, client, {
      id: requestId, method: 'question/request', params: {
        threadId, turnId, questionId, appServerEpoch,
        questions: [{ id: 'choice', prompt: 'Choose', options: [] }],
      },
    }, 'target')
    vi.mocked(emitRuntimeEvent).mockClear()
    const response = {
      [requestField]: requestId,
      itemId: questionId,
      answers: { choice: { answers: ['Original option', ' original free text '] } },
      annotations: { answerLists: [['Original option', ' original free text ']] },
    }
    const dispatched = structuredClone(response)
    expect(await respondToTaskQuestion.call(runtime, taskId, response)).toMatchObject({
      accepted: true, pendingServerConfirmation: true,
    })
    response[requestField] = 202
    response.itemId = 'another-question'
    response.answers.choice.answers.splice(0, 2, 'Changed draft')
    response.annotations.answerLists[0][0] = 'Changed annotation'
    expect(wireReplies).toEqual([{ id: requestId, result: {
      threadId, turnId, questionId, answers: dispatched.answers, annotations: dispatched.annotations,
    } }])
    await forwardAcceptedNotification.call(runtime, 'question/resolved', {
      threadId, turnId, requestId, questionId, appServerEpoch, reason: 'client_response',
    }, 'target', client)
    expect(runtime.pendingQuestionByKey.size).toBe(0)
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    expect(vi.mocked(emitRuntimeEvent).mock.calls[0][1]).toMatchObject({
      event: 'response.block.updated',
      payload: { taskId, data: { updates: {
        status: 'done',
        renderPayload: { requestId, itemId: questionId, response: dispatched },
        toolOutput: dispatched,
      } } },
    })
    expect(client.respond).toHaveBeenCalledOnce()
  }
)

test('runtime.tasks.send keeps its original answer while the native receipt is pending', async () => {
  const client = new FakeGatewayClient('answer-snapshot-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'answer-snapshot-draft', executionRequest: { prompt: 'work' },
  }) as { taskId: string }
  const requestId = 1_000_000, questionId = 'answer-snapshot-question'
  client.dispatchEvent(new CustomEvent('request', { detail: {
    id: requestId, method: 'question/request', params: {
      threadId: 'answer-snapshot-thread', turnId: 'turn', questionId,
      questions: [{ id: 'choice', prompt: 'Choose', options: [] }],
    },
  } }))
  await vi.waitFor(() => expect(runtime.pendingQuestionByKey.size).toBe(1))
  const response = { requestId, itemId: questionId, answers: { choice: { answers: ['Original'] } } }
  expect(await runtime.request('runtime.tasks.send', {
    taskId, requestUserInputResponse: response,
  })).toMatchObject({ accepted: true })
  response.answers.choice.answers[0] = 'Edited after sending'
  expect(runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)?.submittedResponse)
    .toEqual({ requestId, itemId: questionId, answers: { choice: { answers: ['Original'] } } })
  expect(client.responses).toHaveLength(1)
})
