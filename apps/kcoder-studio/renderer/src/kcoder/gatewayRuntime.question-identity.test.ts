import { describe, expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

test.each([
  { 'foreign-question': { answers: ['another card'] } },
  { choice: { answers: ['original'] }, 'foreign-question': { answers: ['another card'] } },
  { constructor: { answers: ['another card'] } },
])('foreign answer items cannot consume or lock the original question: %j', async answers => {
  const client = new FakeGatewayClient('answer-item-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'answer-item-draft', executionRequest: { prompt: 'work' },
  }) as { taskId: string }
  const requestId = 1_000_000
  client.dispatchEvent(new CustomEvent('request', { detail: {
    id: requestId, method: 'question/request', params: {
      threadId: 'answer-item-thread', turnId: 'turn', questionId: 'original-question',
      questions: [{ id: 'choice', prompt: 'Choose', options: [] }],
    },
  } }))
  await vi.waitFor(() => expect(runtime.pendingQuestionByKey.size).toBe(1))
  const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
  expect(await runtime.request('runtime.tasks.send', {
    taskId, requestUserInputResponse: { requestId, itemId: 'original-question', answers },
  })).toMatchObject({ accepted: false, code: 'interaction_answer_conflict' })
  expect(client.responses).toEqual([])
  expect(pending.responsePending).not.toBe(true)
  expect(pending.submittedResponse).toBeUndefined()
  expect(runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)).toBe(pending)
  expect(await runtime.request('runtime.tasks.send', {
    taskId, requestUserInputResponse: {
      requestId, itemId: 'original-question', answers: { choice: { answers: ['original freeform'] } },
    },
  })).toMatchObject({ accepted: true })
  expect(client.responses).toHaveLength(1)
  expect(pending.responsePending).toBe(true)
})

describe.each(['question', 'approval'] as const)('%s response item identity', kind => {
  test.each(['itemId', 'item_id'] as const)(
    'rejects a stale %s before answering the current request',
    async itemField => {
      const client = new FakeGatewayClient('identity-thread')
      const runtime = createTestGatewayRuntime('token', {
        loadServers: async () => [localGatewayServer()],
        createClient: () => client,
      })
      const { taskId } = await runtime.request('runtime.tasks.create', {
        taskId: 'identity-draft',
        executionRequest: { prompt: 'work' },
      }) as { taskId: string }
      const requestId = 1_000_000
      const itemId = `${kind}-current`
      client.dispatchEvent(new CustomEvent('request', {
        detail: {
          id: requestId,
          method: `${kind}/request`,
          params: {
            threadId: 'identity-thread',
            turnId: 'current-turn',
            ...(kind === 'question'
              ? { questionId: itemId, questions: [{ id: 'choice', prompt: 'Choose', options: [] }] }
              : { approvalId: itemId, action: { type: 'command', command: 'echo current' } }),
          },
        },
      }))
      await vi.waitFor(() => expect(runtime.pendingQuestionByKey.size).toBe(1))
      const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!

      // A restarted connection can reuse a request ID. The stale card must not
      // authorize the current operation, even when it is the only pending one.
      for (const requestFields of [{ requestId }, {}]) {
        expect(await runtime.request('runtime.tasks.send', {
          taskId,
          requestUserInputResponse: {
            ...requestFields,
            [itemField]: `${kind}-previous`,
            answers: { [kind === 'question' ? 'choice' : itemId]: { answers: ['Allow once'] } },
          },
        })).toMatchObject({ accepted: false, code: 'interaction_item_conflict' })
        expect(client.responses).toEqual([])
        expect(pending.responsePending).not.toBe(true)
        expect(pending.submittedResponse).toBeUndefined()
        expect(runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)).toBe(pending)
      }

      expect(await runtime.request('runtime.tasks.send', {
        taskId,
        requestUserInputResponse: {
          requestId,
          [itemField]: itemId,
          answers: { [kind === 'question' ? 'choice' : itemId]: { answers: ['Allow once'] } },
        },
      })).toMatchObject({ accepted: true })
      expect(client.responses).toEqual([{
        id: requestId,
        result: expect.objectContaining({
          threadId: 'identity-thread',
          turnId: 'current-turn',
          [kind === 'question' ? 'questionId' : 'approvalId']: itemId,
        }),
      }])
      expect(client.requests.some(request => request.method === 'turn/interrupt')).toBe(false)
    }
  )
})

test.each([undefined, 2_000])('an old timer cannot answer a replacement with timeout %s', async replacementTimeout => {
  const client = new FakeGatewayClient('timer-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'timer-draft',
    executionRequest: { prompt: 'work' },
  }) as { taskId: string }
  const requestId = 1_000_000
  const dispatchQuestion = (autoResolutionMs?: number, questionId = 'original-question-id') => client.dispatchEvent(new CustomEvent('request', {
    detail: {
      id: requestId,
      method: 'question/request',
      params: {
        threadId: 'timer-thread', turnId: 'timer-turn', questionId,
        questions: [{ id: 'choice', prompt: 'Choose', options: [] }],
        ...(autoResolutionMs === undefined ? {} : { autoResolutionMs }),
      },
    },
  }))

  vi.useFakeTimers()
  try {
    dispatchQuestion(1_000)
    await vi.waitFor(() => expect(runtime.pendingQuestionByKey.size).toBe(1))
    const original = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
    dispatchQuestion(replacementTimeout, 'replacement-question-id')
    await vi.waitFor(() => expect(runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)).not.toBe(original))
    const replacement = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!

    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.responses).toEqual([])
    expect(replacement.responsePending).not.toBe(true)
    expect(runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)).toBe(replacement)
    if (replacementTimeout !== undefined) {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(client.responses).toEqual([{
        id: requestId,
        result: expect.objectContaining({ annotations: { autoResolved: true } }),
      }])
      expect(replacement.responsePending).toBe(true)
    }
  } finally {
    vi.useRealTimers()
  }
})
