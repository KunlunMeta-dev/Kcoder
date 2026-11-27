import { describe, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion } from './asyncQuestions'

function fixture(boundConnection: boolean) {
  const task = {
    taskId: 'kcoder:target-a:thread-a', serverId: 'target-a',
    threadId: 'thread-a', workspacePath: '/owned/a',
  }
  const input = {
    questionId: 'question-a', submissionId: 'submission-a', expectedRevision: 1,
    answers: { item: { text: 'original answer' } },
  }
  const question = {
    threadId: task.threadId, questionId: input.questionId,
    answer: { submissionId: input.submissionId, answers: input.answers },
  }
  const receipt = (startedTurn: Record<string, unknown>) => ({
    threadId: task.threadId, question, accepted: true, duplicate: false, startedTurn,
  })
  const request = vi.fn(async (): Promise<unknown> => receipt({
    threadId: task.threadId, id: 'answer-turn', status: 'running',
  }))
  const client = {
    diagnosticConnection: { connectionId: 'original-connection' },
    supportsExperimental: () => true,
    request,
    ...(boundConnection ? { requestOnConnection: request } : {}),
  }
  const runtime = {
    resolveTaskId: (id: string) => id,
    disposed: false,
    taskDescriptor: async () => ({ taskId: task.taskId, task, server: { id: task.serverId } }),
    readyTaskClient: async () => client,
    assertCommandTarget: async () => undefined,
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(), completedTurnKeys: new Set(),
    activeTurnByTask: new Map(), trackActiveTurn: vi.fn(),
  }
  const answer = () => requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, {
    taskId: task.taskId, method: 'asyncQuestion/answer', params: input,
  })
  return { task, input, runtime, request, receipt, answer }
}

for (const boundConnection of [false, true]) {
  describe(`${boundConnection ? 'connection-bound' : 'legacy'} async answer turn binding`, () => {
    it.each(['another-task', '', null])(
      'rejects an explicit nested task identity %j before changing the original task',
      async threadId => {
        const f = fixture(boundConnection)
        f.request.mockResolvedValueOnce(f.receipt({ threadId, id: 'foreign-turn', status: 'running' }))
        await expect(f.answer()).rejects.toThrow('another task')
        expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
        expect(f.runtime.tasks.get(f.task.taskId)).toEqual(f.task)
        expect(f.request).toHaveBeenCalledTimes(1)
        expect(f.request).toHaveBeenCalledWith(
          ...(boundConnection ? ['original-connection'] : []),
          'asyncQuestion/answer', { ...f.input, threadId: f.task.threadId }
        )

        // Only a subsequent explicit operation may reconcile the original task.
        await expect(f.answer()).resolves.toHaveProperty('accepted', true)
        expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
        expect(f.request).toHaveBeenCalledTimes(2)
      }
    )

    it.each([undefined, 'completed', 'interrupted', 'failed'])(
      'requires original-task readback when startedTurn reports %s',
      async status => {
        const f = fixture(boundConnection)
        const result = f.receipt({ threadId: f.task.threadId, id: 'answer-turn', status })
        f.request.mockResolvedValueOnce(result)
        await expect(f.answer()).rejects.toThrow('started turn status')
        expect(f.request).toHaveBeenCalledTimes(1)

        f.request.mockResolvedValueOnce({ ...result, questions: [result.question] })
        await expect(requestAsyncQuestion.call(f.runtime as unknown as GatewayRuntimeCore, {
          taskId: f.task.taskId, method: 'asyncQuestion/list', params: {},
        })).resolves.toHaveProperty('questions', [result.question])
        expect(f.request).toHaveBeenNthCalledWith(2,
          ...(boundConnection ? ['original-connection'] : []),
          'asyncQuestion/list', { threadId: f.task.threadId, includeTerminal: true })
        expect(f.request).toHaveBeenCalledTimes(2)
        expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      }
    )

    it.each(['context_applied', 'delivery_unknown'] as const)(
      'reconciles a saved %s answer without accepting it as turn admission',
      async status => {
        const f = fixture(boundConnection)
        const result = f.receipt({ threadId: f.task.threadId, id: 'answer-turn', status: 'running' })
        const question = {
          ...result.question, sourceTurnId: 'source-turn', requestId: 'request-a', toolCallId: 'tool-a',
          createdAtMs: 1, revision: 3, status,
          questions: [{ id: 'item', header: 'Note', question: 'Any details?', options: [], multiSelect: false }],
          answer: { ...result.question.answer, acceptedAtMs: 2 },
          ...(status === 'delivery_unknown' ? { deliveryError: 'Delivery could not be confirmed' } : {}),
        }
        f.request.mockResolvedValueOnce({ ...result, question })
        await expect(f.answer()).rejects.toThrow('started turn receipt')

        f.request.mockResolvedValueOnce({ threadId: f.task.threadId, questions: [question] })
        await expect(requestAsyncQuestion.call(f.runtime as unknown as GatewayRuntimeCore, {
          taskId: f.task.taskId, method: 'asyncQuestion/list', params: {},
        })).resolves.toHaveProperty('questions', [question])
        expect(f.request).toHaveBeenNthCalledWith(2,
          ...(boundConnection ? ['original-connection'] : []),
          'asyncQuestion/list', { threadId: f.task.threadId, includeTerminal: true })
        expect(f.request).toHaveBeenCalledTimes(2)
        expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()

        const savedReceipt = { ...result, question, startedTurn: undefined }
        f.request.mockResolvedValueOnce(savedReceipt)
        await expect(f.answer()).resolves.toBe(savedReceipt)
      }
    )

    it.each([7, {}, '\ud800'])('rejects a malformed turn snapshot locator %j', async memorySnapshotId => {
      const f = fixture(boundConnection)
      f.request.mockResolvedValueOnce(f.receipt({ id: 'answer-turn', status: 'running', memorySnapshotId }))
      await expect(f.answer()).rejects.toThrow('started turn')
      expect(f.request).toHaveBeenCalledTimes(1)
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    })

    it.each([false, true])('retains a valid started turn with explicit task=%s', async explicitTask => {
      const f = fixture(boundConnection)
      const result = f.receipt({
        ...(explicitTask ? { threadId: f.task.threadId } : {}),
        id: 'answer-turn', status: 'running', memorySnapshotId: '原快照-😀',
      })
      f.request.mockResolvedValueOnce(result)
      await expect(f.answer()).resolves.toBe(result)
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.tasks.get(f.task.taskId)).toEqual(f.task)
    })
  })
}

for (const connectionBound of [false, true]) {
  it.each(['peer-turn', '', null])(
    `rejects a conflicting turn alias %j from an older Gateway (connection-bound=${connectionBound})`,
    async turnId => {
      const f = fixture(connectionBound)
      f.request.mockResolvedValueOnce(f.receipt({
        threadId: f.task.threadId, id: 'answer-turn', turnId, status: 'running',
      }))
      await expect(f.answer()).rejects.toThrow('turn')
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.tasks.get(f.task.taskId)).toEqual(f.task)
      expect(f.request).toHaveBeenCalledTimes(1)
    }
  )
  it(`accepts a matching legacy turn alias (connection-bound=${connectionBound})`, async () => {
    const f = fixture(connectionBound)
    f.request.mockResolvedValueOnce(f.receipt({
      id: 'answer-turn', turnId: 'answer-turn', status: 'running',
    }))
    await expect(f.answer()).resolves.toHaveProperty('accepted', true)
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
  })
}

for (const boundConnection of [false, true]) {
  it.each([undefined, null, 7, '', '   ', '\u0085', ' \u0085\t', '\ud800', '\udfff', 'turn\ud800id'])(
    `rejects an invalid canonical started turn ID %j from an older Gateway (connection-bound=${boundConnection})`,
    async id => {
      const f = fixture(boundConnection)
      f.request.mockResolvedValueOnce(f.receipt({ id, status: 'running' }))
      await expect(f.answer()).rejects.toThrow('turn')
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.tasks.get(f.task.taskId)).toEqual(f.task)
      expect(f.request).toHaveBeenCalledTimes(1)
    }
  )
}

for (const boundConnection of [false, true]) {
  it.each(['', '   ', '\u0085', ' \u0085\t', 7, '\ud800', '\udfff', 'attempt\udfffid'])(
    `rejects an invalid answer attempt %j from an older Gateway (connection-bound=${boundConnection})`,
    async attemptId => {
      const f = fixture(boundConnection)
      f.request.mockResolvedValueOnce(f.receipt({ id: 'answer-turn', status: 'running', attemptId }))
      await expect(f.answer()).rejects.toThrow('turn')
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.request).toHaveBeenCalledTimes(1)
    }
  )
  it.each([undefined, null, 'answer-attempt', '\uFEFF'])(
    `retains a valid optional answer attempt %j (connection-bound=${boundConnection})`,
    async attemptId => {
      const f = fixture(boundConnection)
      const result = f.receipt({ id: 'answer-turn', status: 'running', attemptId })
      f.request.mockResolvedValueOnce(result)
      await expect(f.answer()).resolves.toBe(result)
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    }
  )

  it(`reads the saved answer after an invalid Unicode receipt without resubmitting (connection-bound=${boundConnection})`, async () => {
    const f = fixture(boundConnection)
    const result = f.receipt({ id: 'answer-turn', attemptId: '\ud800', status: 'running' })
    f.request.mockResolvedValueOnce(result)
    await expect(f.answer()).rejects.toThrow('turn')
    expect(f.request).toHaveBeenCalledTimes(1)
    const saved = { ...result, questions: [result.question] }
    f.request.mockResolvedValueOnce(saved)
    await expect(requestAsyncQuestion.call(f.runtime as unknown as GatewayRuntimeCore, {
      taskId: f.task.taskId, method: 'asyncQuestion/list', params: {},
    })).resolves.toHaveProperty('questions', [result.question])
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.request).toHaveBeenNthCalledWith(2,
      ...(boundConnection ? ['original-connection'] : []),
      'asyncQuestion/list', { threadId: f.task.threadId, includeTerminal: true })
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    expect(f.runtime.tasks.get(f.task.taskId)).toEqual(f.task)
  })

  it.each(['新轮次-😀', '\uFEFF'])(`preserves a valid Unicode turn identity %j (connection-bound=${boundConnection})`, async id => {
    const f = fixture(boundConnection)
    const result = f.receipt({ id, attemptId: '新尝试-😀', status: 'running' })
    f.request.mockResolvedValueOnce(result)
    await expect(f.answer()).resolves.toBe(result)
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
  })
}
