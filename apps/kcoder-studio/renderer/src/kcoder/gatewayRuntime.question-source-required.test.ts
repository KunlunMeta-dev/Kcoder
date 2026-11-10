import { expect, test, vi } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

async function fixture(autoResolutionMs?: number) {
  const threadId = 'thread-source-required'
  const client = new FakeGatewayClient(threadId)
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'source-required', executionRequest: { prompt: 'controlled task' },
  }) as { taskId: string }
  const source = {
    parentSessionId: threadId, agentId: 'child',
    backgroundRun: { parentSessionId: threadId, agentId: 'child', runId: 'original-run' },
  }
  client.dispatchEvent(new CustomEvent('request', { detail: {
    id: 44, method: 'question/request', params: {
      threadId, turnId: 'original-turn', questionId: 'question-44', sourceAgent: source,
      ...(autoResolutionMs === undefined ? {} : { autoResolutionMs }),
      questions: [{ id: 'choice', prompt: 'Continue?', options: [] }],
    },
  } }))
  await Promise.all([...runtime.pendingAsyncJobs])
  const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${44}`)!
  expect(pending).toBeDefined()
  const send = (response: object) => runtime.request('runtime.tasks.send', {
    taskId, requestUserInputResponse: response,
  })
  return { runtime, client, taskId, threadId, source, pending, send }
}

for (const response of [
  { requestId: 44, itemId: 'question-44', answers: { choice: { answers: ['Parent answer'] } } },
  { request_id: '44', item_id: 'question-44', answers: {} },
  { requestId: 44, itemId: 'question-44', sourceAgent: null, answers: {} },
  { requestId: 44, itemId: 'question-44', answers: {}, annotations: { ignored: true } },
]) {
  test(`an unscoped parent reply cannot consume a source question: ${JSON.stringify(response)}`, async () => {
    const f = await fixture()
    expect(await f.send(response)).toMatchObject({ accepted: false, code: 'source_agent_conflict' })
    expect(f.client.responses).toHaveLength(0)
    expect(f.pending.responsePending).not.toBe(true)
    expect(f.pending.submittedResponse).toBeUndefined()
    expect(f.runtime.pendingQuestionByKey.get(`${f.taskId}\0${44}`)).toBe(f.pending)

    // The rejected stale card must leave the original child question answerable.
    expect(await f.send({ requestId: 44, itemId: 'question-44', sourceAgent: f.source,
      answers: { choice: { answers: ['Child answer'] } } })).toMatchObject({ accepted: true })
    expect(f.client.responses).toEqual([{ id: 44, result: {
      threadId: f.threadId, turnId: 'original-turn', questionId: 'question-44',
      answers: { choice: { answers: ['Child answer'] } },
    } }])
    expect(f.runtime.activeTurnByTask.has(f.taskId)).toBe(true)
    expect(f.client.requests.some(request => request.method === 'turn/interrupt')).toBe(false)
  })
}

test('automatic resolution preserves the original child source without interrupting its parent', async () => {
  const f = await fixture(1_000)
  await vi.waitFor(() => expect(f.client.responses).toEqual([{ id: 44, result: {
    threadId: f.threadId, turnId: 'original-turn', questionId: 'question-44',
    answers: {}, annotations: { autoResolved: true },
  } }]), { timeout: 2_000 })
  expect(f.pending.submittedResponse).toMatchObject({ sourceAgent: f.source })
  expect(f.runtime.activeTurnByTask.has(f.taskId)).toBe(true)
  expect(f.client.requests.some(request => request.method === 'turn/interrupt')).toBe(false)
})
