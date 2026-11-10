import { describe, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion } from './asyncQuestions'

function fixture() {
  const task = {
    taskId: 'kcoder:target-a:thread-a',
    serverId: 'target-a',
    threadId: 'thread-a',
    workspacePath: '/owned/a',
  }
  let finish!: (value: Record<string, unknown>) => void
  const client = {
    supportsExperimental: () => true,
    request: vi.fn(
      () =>
        new Promise<Record<string, unknown>>(resolve => {
          finish = resolve
        })
    ),
  }
  const runtime = {
    resolveTaskId: (id: string) => id,
    disposed: false,
    taskDescriptor: vi.fn(async () => ({
      taskId: task.taskId,
      task,
      server: { id: task.serverId },
    })),
    readyTaskClient: vi.fn(async () => client),
    assertCommandTarget: vi.fn(async () => undefined),
    tasks: new Map([[task.taskId, task]]),
    clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(),
    completedTurnKeys: new Set(),
    activeTurnByTask: new Map(),
    trackActiveTurn: vi.fn(),
  }
  const input = {
    questionId: 'question-a',
    submissionId: 'submission-a',
    expectedRevision: 4,
    answers: { item: { selectedOptionIds: ['option-a'], text: ' original ' } },
  }
  const receipt = {
    threadId: task.threadId,
    question: {
      threadId: task.threadId,
      questionId: 'question-a',
      answer: {
        submissionId: 'submission-a',
        answers: { item: { selectedOptionIds: ['option-a'], text: ' original ' } },
      },
    },
    accepted: true,
    duplicate: false,
    startedTurn: { id: 'answer-turn', status: 'running' },
  }
  const call = (method = 'asyncQuestion/answer') =>
    requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, {
      taskId: task.taskId,
      method,
      params: input,
    })
  return { task, runtime, client, input, receipt, call, finish: (value = receipt) => finish(value) }
}

describe('async question immutable request identity', () => {
  it('captures question, revision and answer before awaiting task readiness', async () => {
    const f = fixture()
    const original = structuredClone(f.input)
    const pending = f.call()
    f.input.questionId = 'question-b'
    f.input.submissionId = 'submission-b'
    f.input.expectedRevision = 9
    f.input.answers.item.text = 'edited'
    f.input.answers.item.selectedOptionIds.push('option-b')
    await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
    const dispatched = structuredClone(f.client.request.mock.calls[0])
    f.finish()
    // Settle the operation before asserting, including on the unfixed source.
    const result = await pending.then(
      value => ({ value }),
      error => ({ error })
    )
    expect(dispatched).toEqual(['asyncQuestion/answer', { threadId: f.task.threadId, ...original }])
    expect(result).toMatchObject({ value: { accepted: true } })
  })

  it('accepts the original receipt after nested draft edits while awaiting the server', async () => {
    const f = fixture()
    const pending = f.call()
    await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
    f.input.answers.item.text = 'edited'
    f.input.answers.item.selectedOptionIds[0] = 'option-b'
    f.finish()
    await expect(pending).resolves.toMatchObject({ accepted: true })
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
  })

  it('rejects a receipt matching later edits instead of the dispatched answer', async () => {
    const f = fixture()
    const pending = f.call()
    await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
    f.input.answers.item.text = 'edited'
    f.input.answers.item.selectedOptionIds[0] = 'option-b'
    f.receipt.question.answer.answers = structuredClone(f.input.answers)
    f.finish()
    await expect(pending).rejects.toThrow('does not match')
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    expect(f.runtime.tasks.get(f.task.taskId)).not.toHaveProperty('running')
  })

  it('confirms cancellation against the dispatched question after caller identity edits', async () => {
    const f = fixture()
    const pending = f.call('asyncQuestion/cancel')
    await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
    f.input.questionId = 'question-b'
    f.finish()
    await expect(pending).resolves.toMatchObject({ question: { questionId: 'question-a' } })
    expect(f.client.request).toHaveBeenCalledTimes(1)
  })
})

describe('async question answer value contracts', () => {
  it.each([
    ['null item', null],
    ['array item', []],
    ['string item', 'answer'],
    ['numeric option', { selectedOptionIds: [7] }],
    ['null options', { selectedOptionIds: null }],
    ['numeric text', { text: 7 }],
    ['unknown field', { text: 'answer', legacyText: 'different answer' }],
  ])('rejects %s before dispatching an answer', async (_name, item) => {
    const f = fixture()
    Object.assign(f.input.answers, { item })
    f.client.request.mockResolvedValueOnce(f.receipt)
    await expect(f.call()).rejects.toThrow('answer is incomplete')
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'rejects unknown saved answer fields before confirming its turn (duplicate=%s)',
    async duplicate => {
      const f = fixture()
      Object.assign(f.receipt.question.answer.answers.item, { legacyText: 'different answer' })
      f.receipt.duplicate = duplicate
      f.client.request.mockResolvedValueOnce(f.receipt)
      await expect(f.call()).rejects.toThrow('does not match')
      expect(f.client.request).toHaveBeenCalledTimes(1)
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.tasks.get(f.task.taskId)).not.toHaveProperty('running')
    }
  )

  it('retains Rust defaults for omitted selections and null text', async () => {
    const f = fixture()
    Object.assign(f.input, { answers: { item: { text: ' original ' }, second: {} } })
    Object.assign(f.receipt.question.answer, {
      answers: {
        second: { selectedOptionIds: [], text: null },
        item: { selectedOptionIds: [], text: ' original ' },
      },
    })
    f.client.request.mockResolvedValueOnce(f.receipt)
    await expect(f.call()).resolves.toMatchObject({ accepted: true })
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
  })
})
