import { expect, test, vi } from 'vitest'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

async function fixture(kind: 'question' | 'approval') {
  const itemId = kind === 'question' ? 'choice' : 'original-approval'
  const client = new FakeGatewayClient('original-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()], createClient: () => client,
  })
  const { taskId } = await runtime.request('runtime.tasks.create', {
    taskId: 'draft', executionRequest: { prompt: 'controlled fixture' },
  }) as { taskId: string }
  const requestId = 1_000_000
  client.dispatchEvent(new CustomEvent('request', { detail: {
    id: requestId, method: `${kind}/request`, params: {
      threadId: 'original-thread', turnId: 'original-turn',
      ...(kind === 'question'
        ? { questionId: 'original-question', questions: [
            { id: itemId, prompt: 'Which?', options: [] },
            { id: 'details', prompt: 'Any details?', options: [] },
          ] }
        : { approvalId: itemId, action: { type: 'command', command: 'echo controlled' },
            availableDecisions: ['accept', 'decline'] }),
    },
  } }))
  await vi.waitFor(() => expect(runtime.pendingQuestionByKey.size).toBe(1))
  const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)!
  return { runtime, taskId, requestId, pending, client }
}

for (const kind of ['question', 'approval'] as const) {
  const itemId = kind === 'question' ? 'choice' : 'original-approval'
  test.each([
    ['missing answer map', undefined],
    ['null answer map', null],
    ['array answer map', []],
    ['string answer map', 'Original answer'],
    ['null item', { [itemId]: null }],
    ['array item', { [itemId]: [] }],
    ['string item', { [itemId]: 'Original answer' }],
    ['null selections', { [itemId]: { answers: null } }],
    ['string selections', { [itemId]: { answers: 'Original answer' } }],
    ['non-string selection', { [itemId]: { answers: [42] } }],
  ])(`${kind}: %s cannot consume or lock the original interaction`, async (_name, answers) => {
    const { runtime, taskId, requestId, pending, client } = await fixture(kind)
    try {
      expect(await runtime.request('runtime.tasks.send', {
        taskId, requestUserInputResponse: { requestId, answers },
      })).toMatchObject({ accepted: false, code: 'interaction_answer_conflict' })
      expect(client.responses).toEqual([])
      expect(pending.responsePending).toBeUndefined()
      expect(pending.submittedResponse).toBeUndefined()
      expect(runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)).toBe(pending)

      const corrected = { [itemId]: { answers: [kind === 'question' ? 'Original answer' : 'Allow once'] } }
      expect(await runtime.request('runtime.tasks.send', {
        taskId, requestUserInputResponse: { requestId, answers: corrected },
      })).toMatchObject({ accepted: true, pendingServerConfirmation: true })
      expect(client.responses).toEqual([{ id: requestId, result: {
        threadId: 'original-thread', turnId: 'original-turn',
        ...(kind === 'question' ? { questionId: 'original-question', answers: corrected }
          : { approvalId: itemId, decision: 'accept' }),
      } }])
    } finally {
      await runtime.dispose()
    }
  })

  test.each([
    ['empty map', {}],
    ['omitted selections', { [itemId]: {} }],
    ['empty selections', { [itemId]: { answers: [] } }],
  ])(`${kind}: legal %s keeps the native empty/partial-answer semantics`, async (_name, answers) => {
    const { runtime, taskId, requestId, pending, client } = await fixture(kind)
    try {
      expect(await runtime.request('runtime.tasks.send', {
        taskId, requestUserInputResponse: { requestId, answers },
      })).toMatchObject({ accepted: true, pendingServerConfirmation: true })
      expect(client.responses).toEqual([{ id: requestId, result: {
        threadId: 'original-thread', turnId: 'original-turn',
        ...(kind === 'question' ? { questionId: 'original-question', answers }
          : { approvalId: itemId, decision: 'decline' }),
      } }])
      expect(pending.responsePending).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
}
