import { expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

test.each([false, true])('async answer dispatch validates the nested original task (foreign=%s)', async foreign => {
  const client = new FakeGatewayClient('original-question-task')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'question-draft', executionRequest: { prompt: 'work' },
  }) as { taskId: string }
  // Exercise idle answer admission after the source turn's real notification.
  const sourceTurnId = runtime.activeTurnByTask.get(taskId)!.turnId
  client.emitNotification('turn/completed', {
    threadId: 'original-question-task', turnId: sourceTurnId,
    turn: { id: sourceTurnId, status: 'completed' },
  })
  await vi.waitFor(() => expect(runtime.activeTurnByTask.has(taskId)).toBe(false))
  const before = { ...runtime.tasks.get(taskId)! }
  const activeBefore = runtime.activeTurnByTask.get(taskId)
  const originalRequest = client.request.bind(client)
  const request = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method !== 'asyncQuestion/answer') return originalRequest(method, params)
    return {
      threadId: 'original-question-task', accepted: true, duplicate: false,
      question: { threadId: 'original-question-task', questionId: 'question',
        answer: { submissionId: 'submission', answers: { item: { text: 'original answer' } } } },
      startedTurn: { threadId: foreign ? 'another-task' : 'original-question-task',
        id: 'answer-turn', status: 'running' },
    }
  })
  const answer = runtime.request('runtime.asyncQuestion.request', {
    taskId, method: 'asyncQuestion/answer', params: {
      questionId: 'question', submissionId: 'submission', expectedRevision: 1,
      answers: { item: { text: 'original answer' } },
    },
  })
  if (foreign) {
    await expect(answer).rejects.toThrow('another task')
    expect(runtime.tasks.get(taskId)).toEqual(before)
    expect(runtime.activeTurnByTask.get(taskId)).toBe(activeBefore)
  } else {
    await expect(answer).resolves.toHaveProperty('accepted', true)
    expect(runtime.tasks.get(taskId)).toEqual(before)
    expect(runtime.activeTurnByTask.get(taskId)).toBe(activeBefore)
    client.emitNotification('turn/started', {
      threadId: 'original-question-task', turnId: 'answer-turn', turn: { id: 'answer-turn' },
    })
    await vi.waitFor(() => expect(runtime.activeTurnByTask.get(taskId)?.turnId).toBe('answer-turn'))
    expect(runtime.tasks.get(taskId)?.running).toBe(true)
  }
  expect(request.mock.calls.filter(([method]) => method === 'asyncQuestion/answer')).toHaveLength(1)
  expect(request.mock.calls.some(([method]) => method === 'turn/interrupt')).toBe(false)
})
