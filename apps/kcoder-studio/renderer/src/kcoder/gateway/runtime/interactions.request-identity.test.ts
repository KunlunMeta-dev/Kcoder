import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'
import type { GatewayRuntimeCore } from './core'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', async importOriginal => ({
  ...await importOriginal<typeof import('../../gatewayServiceBridge')>(),
  emitRuntimeEvent: vi.fn(async () => undefined),
}))

async function fixture(kind: 'question' | 'approval') {
  const client = { supportsExperimental: () => true, respond: vi.fn() }
  const taskId = 'original-task', threadId = 'original-thread', turnId = 'original-turn'
  const requestId = 101, itemId = `original-${kind}`
  const core = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[taskId, { taskId, serverId: 'target', threadId }]]),
    clientByTask: new Map([[taskId, client]]), threadByTask: new Map([[taskId, threadId]]),
    taskByThread: new Map([[`target\0${threadId}`, taskId]]),
    threadKey: (serverId: string, id: string) => `${serverId}\0${id}`,
    turnAttemptIds: new Map(), pendingQuestionByKey: new Map(), forwardApprovalRequest,
  } as unknown as GatewayRuntimeCore
  await forwardServerRequest.call(core, client as never, {
    id: requestId, method: `${kind}/request`, params: {
      threadId, turnId,
      ...(kind === 'question'
        ? { questionId: itemId, questions: [{ id: 'choice', prompt: 'Which?', options: [] }] }
        : { approvalId: itemId, action: { type: 'command', command: 'echo controlled' },
            availableDecisions: ['accept', 'decline'] }),
    },
  }, 'target')
  const pending = core.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
  const answers = { [kind === 'question' ? 'choice' : itemId]: { answers: [kind === 'question' ? 'Original answer' : 'Allow once'] } }
  return { core, client, pending, taskId, requestId, answers }
}

test('runtime.tasks.send rejects a stale identity without sending or consuming the original question', async () => {
  const client = new FakeGatewayClient('original-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  try {
    const { taskId } = await runtime.request('runtime.tasks.create', {
      taskId: 'draft', executionRequest: { prompt: 'controlled fixture' },
    }) as { taskId: string }
    const requestId = 1_000_000
    client.dispatchEvent(new CustomEvent('request', { detail: {
      id: requestId, method: 'question/request', params: {
        threadId: 'original-thread', turnId: 'original-turn', questionId: 'original-question',
        questions: [{ id: 'choice', prompt: 'Which?', options: [] }],
      },
    } }))
    await vi.waitFor(() => expect(runtime.pendingQuestionByKey.size).toBe(1))
    const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
    const answers = { choice: { answers: ['Original answer'] } }
    for (const identity of [{ requestId: null }, { requestId, request_id: requestId + 1 }]) {
      expect(await runtime.request('runtime.tasks.send', {
        taskId, requestUserInputResponse: { ...identity, answers },
      })).toMatchObject({ accepted: false, code: 'interaction_request_conflict' })
    }
    expect(client.responses).toEqual([])
    expect(pending.responsePending).toBeUndefined()
    expect(await runtime.request('runtime.tasks.send', {
      taskId, requestUserInputResponse: { requestId, answers },
    })).toMatchObject({ accepted: true, pendingServerConfirmation: true })
    expect(client.responses).toEqual([{ id: requestId, result: {
      answers, threadId: 'original-thread', turnId: 'original-turn', questionId: 'original-question',
    } }])
  } finally {
    await runtime.dispose()
  }
})

for (const kind of ['question', 'approval'] as const) {
  for (const field of ['requestId', 'request_id']) {
    test.each([null, '', {}])(`${kind}: explicit invalid ${field}=%j cannot select the sole pending interaction`, async value => {
      const f = await fixture(kind)
      const result = await respondToTaskQuestion.call(f.core, f.taskId, {
        [field]: value, answers: f.answers,
      })
      expect(result).toMatchObject({ accepted: false, code: 'interaction_request_conflict' })
      expect(f.client.respond).not.toHaveBeenCalled()
      expect(f.pending.responsePending).toBeUndefined()
      expect(f.pending.submittedResponse).toBeUndefined()
      expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
      expect(await respondToTaskQuestion.call(f.core, f.taskId, {
        requestId: f.requestId, answers: f.answers,
      })).toMatchObject({ accepted: true })
      expect(f.client.respond).toHaveBeenCalledOnce()
    })
  }

  test(`${kind}: a matching camelCase request ID cannot override a contradictory legacy ID`, async () => {
    const f = await fixture(kind)
    expect(await respondToTaskQuestion.call(f.core, f.taskId, {
      requestId: f.requestId, request_id: f.requestId + 1, answers: f.answers,
    })).toMatchObject({ accepted: false, code: 'interaction_request_conflict' })
    expect(f.client.respond).not.toHaveBeenCalled()
    expect(f.pending.responsePending).toBeUndefined()
  })

  test.each([
    ['omitted legacy identity', {}],
    ['legacy string identity', { request_id: '101' }],
    ['equivalent aliases', { requestId: 101, request_id: '101' }],
  ])(`${kind}: %s still submits once on the original binding`, async (_name, identity) => {
    const f = await fixture(kind)
    const response = { ...identity, answers: f.answers }
    expect(await respondToTaskQuestion.call(f.core, f.taskId, response)).toMatchObject({ accepted: true })
    expect(await respondToTaskQuestion.call(f.core, f.taskId, response)).toMatchObject({
      accepted: false, code: 'request_user_input_response_pending',
    })
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(f.requestId, expect.objectContaining({
      threadId: 'original-thread', turnId: 'original-turn',
      ...(kind === 'question' ? { questionId: 'original-question', answers: f.answers }
        : { approvalId: 'original-approval', decision: 'accept' }),
    }))
  })
}

for (const kind of ['question', 'approval'] as const) {
  test.each([
    ['threadId', 'previous-thread'], ['turnId', 'previous-turn'],
    ['questionId', 'previous-question'], ['approvalId', 'previous-approval'],
    ['appServerEpoch', 'previous-epoch'], ['turnId', 42],
  ])(`${kind}: a contradictory explicit %s=%j cannot be rebound to the pending interaction`, async (field, value) => {
    const f = await fixture(kind)
    f.pending.appServerEpoch = 'current-epoch'
    expect(await respondToTaskQuestion.call(f.core, f.taskId, {
      requestId: f.requestId, [field]: value, answers: f.answers,
    })).toMatchObject({ accepted: false, code: 'interaction_binding_conflict' })
    expect(f.client.respond).not.toHaveBeenCalled()
    expect(f.pending.responsePending).toBeUndefined()
    expect(f.pending.submittedResponse).toBeUndefined()
    expect(f.core.pendingQuestionByKey.get(`${f.taskId}\0${f.requestId}`)).toBe(f.pending)
    // Rejection preserves the original card and permits its correct answer once.
    expect(await respondToTaskQuestion.call(f.core, f.taskId, {
      requestId: f.requestId, answers: f.answers,
    })).toMatchObject({ accepted: true })
    expect(f.client.respond).toHaveBeenCalledOnce()
  })

  test(`${kind}: matching explicit bindings preserve nullable optional identities and the send guard`, async () => {
    const f = await fixture(kind)
    f.pending.appServerEpoch = 'current-epoch'
    const response = {
      requestId: f.requestId, threadId: 'original-thread', turnId: 'original-turn',
      questionId: kind === 'question' ? 'original-question' : null,
      approvalId: kind === 'approval' ? 'original-approval' : null,
      appServerEpoch: 'current-epoch', answers: f.answers,
    }
    expect(await respondToTaskQuestion.call(f.core, f.taskId, response)).toMatchObject({ accepted: true })
    expect(await respondToTaskQuestion.call(f.core, f.taskId, response)).toMatchObject({
      accepted: false, code: 'request_user_input_response_pending',
    })
    expect(f.client.respond).toHaveBeenCalledOnce()
  })
}

test.each(['turnId', 'appServerEpoch'] as const)(
  'runtime.tasks.send rejects a stale %s before constructing a current native reply', async field => {
    const client = new FakeGatewayClient('original-thread')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()], createClient: () => client,
    })
    try {
      const { taskId } = await runtime.request('runtime.tasks.create', {
        taskId: 'draft', executionRequest: { prompt: 'controlled fixture' },
      }) as { taskId: string }
      const requestId = 1_000_000
      client.dispatchEvent(new CustomEvent('request', { detail: {
        id: requestId, method: 'question/request', params: {
          threadId: 'original-thread', turnId: 'current-turn', questionId: 'original-question',
          appServerEpoch: 'current-epoch',
          questions: [{ id: 'choice', prompt: 'Which?', options: [] }],
        },
      } }))
      await vi.waitFor(() => expect(runtime.pendingQuestionByKey.size).toBe(1))
      const response = { requestId, itemId: 'original-question',
        [field]: `previous-${field}`, answers: { choice: { answers: ['Original answer'] } } }
      expect(await runtime.request('runtime.tasks.send', {
        taskId, requestUserInputResponse: response,
      })).toMatchObject({ accepted: false, code: 'interaction_binding_conflict' })
      expect(client.responses).toEqual([])
      expect(runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)?.responsePending).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  }
)
