import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification } from './notifications'
import { trackActiveTurn } from './turns'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

function fixture(supported = true) {
  const task = {
    taskId: 'kcoder:target-a:thread-a',
    serverId: 'target-a',
    threadId: 'thread-a',
    workspacePath: '/owned/a',
  }
  const question = {
    questionId: 'question-a',
    threadId: task.threadId,
    revision: 4,
    status: 'queued',
    questions: [],
    answer: {
      submissionId: 'submission-a',
      answers: { item: { selectedOptionIds: ['option-a'] } },
      acceptedAtMs: 5,
    },
  }
  const client = {
    supportsExperimental: vi.fn(() => supported),
    request: vi.fn(async (method: string) => {
      if (method === 'asyncQuestion/list') return { threadId: task.threadId, questions: [question] }
      return { threadId: task.threadId, question, accepted: true, duplicate: false }
    }),
  }
  const server = { id: task.serverId, transport: 'local' }
  const runtime = {
    resolveTaskId: (id: string) => id,
    disposed: false,
    taskDescriptor: vi.fn(async () => ({ taskId: task.taskId, task, server })),
    readyTaskClient: vi.fn(async () => client),
    assertCommandTarget: vi.fn(async () => undefined),
    tasks: new Map([[task.taskId, task]]),
    clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(),
    taskByThread: new Map([[`${task.serverId}\0${task.threadId}`, task.taskId]]),
    threadKey: (serverId: string, threadId: string) => `${serverId}\0${threadId}`,
    activeTurnByTask: new Map(),
    pendingTurnStartByTask: new Set(),
    completedTurnKeys: new Set(),
    turnText: new Map(),
    turnAttemptIds: new Map(),
    pendingQuestionByKey: new Map(),
    backgroundJobById: new Map(),
    remoteSessions: { handleNotification: vi.fn(() => false) },
    trackActiveTurn: vi.fn(),
  }
  runtime.trackActiveTurn.mockImplementation((taskId: string, turnId: string) =>
    trackActiveTurn.call(runtime as unknown as GatewayRuntimeCore, taskId, turnId)
  )
  const call = (method: string, params: Record<string, unknown> = {}) =>
    requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, {
      taskId: task.taskId,
      method,
      params,
    })
  return { task, question, client, server, runtime, call }
}

beforeEach(() => vi.clearAllMocks())

describe('async answer uses the original turn event projection', () => {
  it.each(['before receipt', 'after receipt'])(
    'projects the real turn when completion arrives %s', async ordering => {
      const f = fixture()
      let finish!: (value: unknown) => void
      f.client.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const answer = f.call('asyncQuestion/answer', {
        questionId: 'question-a', submissionId: 'submission-a', expectedRevision: 4,
        answers: { item: { selectedOptionIds: ['option-a'] } },
      })
      await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
      const notify = (status: 'running' | 'completed') => forwardAcceptedNotification.call(
        f.runtime as unknown as GatewayRuntimeCore,
        status === 'running' ? 'turn/started' : 'turn/completed',
        { threadId: f.task.threadId, turnId: 'answer-turn', turn: { id: 'answer-turn', status } }, f.task.serverId
      )
      await notify('running')
      expect(f.runtime.tasks.get(f.task.taskId)).toMatchObject({ running: true })
      expect(f.runtime.trackActiveTurn).toHaveBeenCalledExactlyOnceWith(f.task.taskId, 'answer-turn', false)
      if (ordering === 'before receipt') await notify('completed')
      finish({ threadId: f.task.threadId, question: f.question, accepted: true, duplicate: false,
        startedTurn: { id: 'answer-turn', status: 'running' } })
      await answer
      expect(f.runtime.tasks.get(f.task.taskId)).toMatchObject({ running: ordering === 'after receipt' })
      if (ordering === 'after receipt') await notify('completed')
      expect(f.runtime.tasks.get(f.task.taskId)).toMatchObject({ running: false, turnStatus: 'completed' })
      expect(f.runtime.activeTurnByTask.size).toBe(0)
      expect(f.client.request).toHaveBeenCalledTimes(1)
    }
  )

  it('an accepted answer returns its turn reference without inventing a start event', async () => {
    const f = fixture()
    const result = { threadId: f.task.threadId, question: f.question, accepted: true, duplicate: false,
      startedTurn: { id: 'answer-turn', status: 'running' } }
    f.client.request.mockResolvedValueOnce(result)
    await expect(f.call('asyncQuestion/answer', {
      questionId: 'question-a', submissionId: 'submission-a', expectedRevision: 4,
      answers: { item: { selectedOptionIds: ['option-a'] } },
    })).resolves.toBe(result)
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    expect(f.runtime.tasks.get(f.task.taskId)).toEqual(f.task)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
  })
})

describe('async question runtime adapter', () => {
  it('projects negotiated support from the selected task client without an RPC probe', async () => {
    const f = fixture()
    await expect(
      supportsAsyncQuestions.call(f.runtime as unknown as GatewayRuntimeCore, {
        taskId: f.task.taskId,
      })
    ).resolves.toEqual({ taskId: f.task.taskId, threadId: f.task.threadId, supported: true })
    expect(f.client.supportsExperimental).toHaveBeenCalledWith('asyncUserQuestionsV1')
    expect(f.client.request).not.toHaveBeenCalled()
  })

  it('returns unsupported and never calls an async question RPC for an old target', async () => {
    const f = fixture(false)
    await expect(
      supportsAsyncQuestions.call(f.runtime as unknown as GatewayRuntimeCore, {
        taskId: f.task.taskId,
      })
    ).resolves.toMatchObject({ supported: false })
    await expect(f.call('asyncQuestion/list')).rejects.toThrow('does not support')
    expect(f.client.request).not.toHaveBeenCalled()
  })

  it('binds list and answer RPCs to the canonical thread and stable answer receipt fields', async () => {
    const f = fixture()
    await f.call('asyncQuestion/list', { includeTerminal: false, serverId: 'forged' })
    expect(f.client.request).toHaveBeenCalledWith('asyncQuestion/list', {
      threadId: f.task.threadId,
      includeTerminal: true,
    })

    f.client.request.mockResolvedValueOnce({
      threadId: f.task.threadId,
      question: {
        ...f.question,
        answer: {
          ...f.question.answer,
          answers: { item: { selectedOptionIds: ['option-a'], text: 'note' } },
        },
      },
      accepted: true,
      duplicate: false,
    })
    await f.call('asyncQuestion/answer', {
      questionId: 'question-a',
      submissionId: 'submission-a',
      expectedRevision: 4,
      answers: { item: { selectedOptionIds: ['option-a'], text: 'note' } },
      serverId: 'forged',
    })
    expect(f.client.request).toHaveBeenLastCalledWith('asyncQuestion/answer', {
      threadId: f.task.threadId,
      questionId: 'question-a',
      submissionId: 'submission-a',
      expectedRevision: 4,
      answers: { item: { selectedOptionIds: ['option-a'], text: 'note' } },
    })
  })

  it.each([
    { name: 'another submission', submissionId: 'submission-other', duplicate: false },
    { name: 'another duplicate submission', submissionId: 'submission-other', duplicate: true },
    { name: 'a missing saved answer', submissionId: undefined, duplicate: false },
  ])(
    'rejects an accepted receipt for $name before tracking its turn',
    async ({ submissionId, duplicate }) => {
      const f = fixture()
      f.client.request.mockResolvedValueOnce({
        threadId: f.task.threadId,
        question: {
          ...f.question,
          answer: submissionId
            ? {
                submissionId,
                answers: { item: { selectedOptionIds: ['option-a'] } },
                acceptedAtMs: 5,
              }
            : undefined,
        },
        accepted: true,
        duplicate,
        startedTurn: { id: 'unconfirmed-turn', status: 'running' },
      })

      await expect(
        f.call('asyncQuestion/answer', {
          questionId: 'question-a',
          submissionId: 'submission-a',
          expectedRevision: 4,
          answers: { item: { selectedOptionIds: ['option-a'] } },
        })
      ).rejects.toThrow('submission')
      expect(f.client.request).toHaveBeenCalledTimes(1)
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.tasks.get(f.task.taskId)).not.toHaveProperty('running')
    }
  )

  it('returns the authoritative winner when another device answered first without tracking its turn', async () => {
    const f = fixture()
    const winner = {
      ...f.question,
      answer: {
        submissionId: 'other-device-submission',
        answers: { item: { selectedOptionIds: ['option-b'] } },
        acceptedAtMs: 5,
      },
    }
    f.client.request.mockResolvedValueOnce({
      threadId: f.task.threadId,
      question: winner,
      accepted: false,
      duplicate: false,
      startedTurn: { id: 'other-device-turn', status: 'running' },
    })
    await expect(
      f.call('asyncQuestion/answer', {
        questionId: 'question-a',
        submissionId: 'submission-a',
        expectedRevision: 4,
        answers: { item: { selectedOptionIds: ['option-a'] } },
      })
    ).resolves.toMatchObject({ accepted: false, question: winner })
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
  })

  it('rejects a stale client connection or mismatched thread without replaying a mutation', async () => {
    const f = fixture()
    await expect(
      f.call('asyncQuestion/answer', {
        threadId: 'thread-other',
        questionId: 'question-a',
        submissionId: 'submission-a',
        expectedRevision: 4,
        answers: { item: { selectedOptionIds: ['option-a'] } },
      })
    ).rejects.toThrow('ownership changed')
    expect(f.client.request).not.toHaveBeenCalled()

    f.client.request.mockImplementationOnce(async () => {
      f.runtime.clientByTask.set(f.task.taskId, {})
      return {
        threadId: f.task.threadId,
        question: f.question,
        accepted: true,
        duplicate: false,
      }
    })
    await expect(
      f.call('asyncQuestion/answer', {
        questionId: 'question-a',
        submissionId: 'submission-a',
        expectedRevision: 4,
        answers: { item: { selectedOptionIds: ['option-a'] } },
      })
    ).rejects.toThrow('ownership changed')
    expect(f.client.request).toHaveBeenCalledTimes(1)
  })

  it('returns the fresh turn reference while recovering an already saved answer', async () => {
    const f = fixture()
    f.client.request.mockResolvedValueOnce({
      threadId: f.task.threadId,
      question: {
        ...f.question,
        answer: { ...f.question.answer, submissionId: 'saved-submission' },
      },
      accepted: true,
      duplicate: true,
      startedTurn: { id: 'recovery-turn', status: 'running' },
    })
    await f.call('asyncQuestion/answer', {
      questionId: 'question-a',
      submissionId: 'saved-submission',
      expectedRevision: 4,
      answers: { item: { selectedOptionIds: ['option-a'] } },
    })
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    expect(f.runtime.tasks.get(f.task.taskId)).toEqual(f.task)
  })

  it('does not resurrect an auto-started turn completed before the answer receipt arrives', async () => {
    const f = fixture()
    let resolveReceipt!: (value: Record<string, unknown>) => void
    f.client.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveReceipt = resolve
        })
    )

    const answer = f.call('asyncQuestion/answer', {
      questionId: 'question-a',
      submissionId: 'submission-a',
      expectedRevision: 4,
      answers: { item: { selectedOptionIds: ['option-a'] } },
    })
    await vi.waitFor(() =>
      expect(f.client.request).toHaveBeenCalledTimes(1)
    )

    await forwardAcceptedNotification.call(
      f.runtime as unknown as GatewayRuntimeCore,
      'turn/completed',
      { threadId: f.task.threadId, turnId: 'turn-a', turn: { id: 'turn-a', status: 'completed' } },
      f.task.serverId
    )
    expect(f.runtime.tasks.get(f.task.taskId)).toMatchObject({ running: false })

    resolveReceipt!({
      threadId: f.task.threadId,
      question: f.question,
      accepted: true,
      duplicate: false,
      startedTurn: { id: 'turn-a', status: 'running' },
    })
    await answer

    expect(f.runtime.tasks.get(f.task.taskId)).toMatchObject({ running: false })
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    expect(f.runtime.tasks.get(f.task.taskId)).toMatchObject({ running: false })
  })

  it.each(['first receipt before completion', 'both receipts after completion'])(
    'keeps a completed turn settled with overlapping answer receipts: %s',
    async ordering => {
      const f = fixture()
      const receipts: Array<(value: Record<string, unknown>) => void> = []
      f.client.request.mockImplementation(() => new Promise(resolve => receipts.push(resolve)))
      const input = {
        questionId: 'question-a',
        submissionId: 'submission-a',
        expectedRevision: 4,
        answers: { item: { selectedOptionIds: ['option-a'] } },
      }
      const first = f.call('asyncQuestion/answer', input)
      const second = f.call('asyncQuestion/answer', input)
      await vi.waitFor(() => expect(receipts).toHaveLength(2))
      const receipt = {
        threadId: f.task.threadId,
        question: f.question,
        accepted: true,
        duplicate: true,
        startedTurn: { id: 'shared-turn', status: 'running' },
      }
      if (ordering === 'first receipt before completion') {
        receipts[0](receipt)
        await first
      }
      await forwardAcceptedNotification.call(
        f.runtime as unknown as GatewayRuntimeCore,
        'turn/completed',
        {
          threadId: f.task.threadId,
          turnId: 'shared-turn',
          turn: { id: 'shared-turn', status: 'completed' },
        },
        f.task.serverId
      )
      f.runtime.trackActiveTurn.mockClear()
      receipts[0](receipt)
      receipts[1](receipt)
      await Promise.all([first, second])
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.tasks.get(f.task.taskId)).toMatchObject({ running: false })
      expect(f.runtime.activeTurnByTask.has(f.task.taskId)).toBe(false)
    }
  )

  it.each([true, false])(
    'keeps a newer active turn when an older answer receipt arrives late (completion observed: %s)',
    async completed => {
      const f = fixture()
      let resolveReceipt!: (value: Record<string, unknown>) => void
      f.client.request.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveReceipt = resolve
          })
      )
      const answer = f.call('asyncQuestion/answer', {
        questionId: 'question-a',
        submissionId: 'submission-a',
        expectedRevision: 4,
        answers: { item: { selectedOptionIds: ['option-a'] } },
      })
      await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
      if (completed)
        await forwardAcceptedNotification.call(
          f.runtime as unknown as GatewayRuntimeCore,
          'turn/completed',
          {
            threadId: f.task.threadId,
            turnId: 'older-turn',
            turn: { id: 'older-turn', status: 'completed' },
          },
          f.task.serverId
        )
      const newerTurn = { turnId: 'newer-turn', complete: vi.fn() }
      f.runtime.activeTurnByTask.set(f.task.taskId, newerTurn)
      f.runtime.tasks.set(f.task.taskId, { ...f.task, running: true } as typeof f.task)
      resolveReceipt({
        threadId: f.task.threadId,
        question: f.question,
        accepted: true,
        duplicate: false,
        startedTurn: { id: 'older-turn', status: 'running' },
      })
      await answer
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.activeTurnByTask.get(f.task.taskId)).toBe(newerTurn)
      expect(f.runtime.tasks.get(f.task.taskId)).toMatchObject({ running: true })
    }
  )

  it('cleans up a rejected answer without removing an ordinary turn start marker', async () => {
    const f = fixture()
    f.runtime.pendingTurnStartByTask.add(f.task.taskId)
    f.client.request.mockRejectedValueOnce(new Error('transport closed'))
    await expect(
      f.call('asyncQuestion/answer', {
        questionId: 'question-a',
        submissionId: 'submission-a',
        expectedRevision: 4,
        answers: { item: { selectedOptionIds: ['option-a'] } },
      })
    ).rejects.toThrow('transport closed')
    expect(f.runtime.pendingTurnStartByTask.has(f.task.taskId)).toBe(true)
  })

  it('refreshes only the matching task for a notification from its current owner client', async () => {
    const f = fixture()
    const handler = forwardAcceptedNotification.bind(f.runtime as unknown as GatewayRuntimeCore)
    await handler(
      'asyncQuestion/changed',
      { threadId: f.task.threadId, question: f.question },
      f.task.serverId,
      f.client as never
    )
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
      event: 'async-question:changed',
      payload: {
        taskId: f.task.taskId,
        serverId: f.task.serverId,
        threadId: f.task.threadId,
        questionId: f.question.questionId,
        revision: 4,
      },
    })

    vi.mocked(emitRuntimeEvent).mockClear()
    await handler(
      'asyncQuestion/changed',
      { threadId: 'thread-other', question: f.question },
      f.task.serverId,
      f.client as never
    )
    await handler(
      'asyncQuestion/changed',
      { threadId: f.task.threadId, question: f.question },
      'target-other',
      f.client as never
    )
    f.runtime.clientByTask.set(f.task.taskId, {})
    await handler(
      'asyncQuestion/changed',
      { threadId: f.task.threadId, question: f.question },
      f.task.serverId,
      f.client as never
    )
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
  })
})

it.each([false, true])(
  'confirms accepted answer contents before tracking its turn (duplicate=%s)',
  async duplicate => {
    const submitted = { item: { selectedOptionIds: ['option-a'], text: ' keep spacing ' } }
    const mismatches = [
      { item: { selectedOptionIds: ['option-b'], text: ' keep spacing ' } },
      { item: { selectedOptionIds: ['option-a'], text: 'another answer' } },
      { item: { selectedOptionIds: ['option-a'] } },
      { item: { selectedOptionIds: ['option-a'], text: 'keep spacing' } },
      {},
    ]
    for (const answers of mismatches) {
      const f = fixture()
      f.client.request.mockResolvedValueOnce({
        threadId: f.task.threadId,
        question: { ...f.question, answer: { ...f.question.answer, answers } },
        accepted: true,
        duplicate,
        startedTurn: { id: 'unconfirmed-turn', status: 'running' },
      })
      await expect(
        f.call('asyncQuestion/answer', {
          questionId: 'question-a',
          submissionId: 'submission-a',
          expectedRevision: 4,
          answers: submitted,
        })
      ).rejects.toThrow('answer')
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.client.request).toHaveBeenCalledTimes(1)
    }
  }
)

it.each([false, true])(
  'accepts exact text answers with Rust defaults (duplicate=%s)',
  async duplicate => {
    const f = fixture()
    const answers = { second: { text: '' }, item: { text: ' keep spacing ' } }
    f.client.request.mockResolvedValueOnce({
      threadId: f.task.threadId,
      question: {
        ...f.question,
        answer: {
          ...f.question.answer,
          answers: {
            item: { selectedOptionIds: [], text: ' keep spacing ' },
            second: { selectedOptionIds: [], text: '' },
          },
        },
      },
      accepted: true,
      duplicate,
      startedTurn: { id: 'confirmed-turn', status: 'running' },
    })
    await expect(
      f.call('asyncQuestion/answer', {
        questionId: 'question-a',
        submissionId: 'submission-a',
        expectedRevision: 4,
        answers,
      })
    ).resolves.toMatchObject({ accepted: true, duplicate })
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
  }
)


it.each(['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel'])(
  '%s cannot accept a receipt after the same client reconnects',
  async method => {
    const f = fixture()
    const connection = { targetId: f.server.id, connectionId: 'rpc-1-1' }
    Object.assign(f.client, { diagnosticConnection: connection })
    let finish!: (value: unknown) => void
    f.client.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const operation = f.call(method, {
      questionId: 'question-a', submissionId: 'submission-a', expectedRevision: 4,
      answers: { item: { selectedOptionIds: ['option-a'] } },
    })
    const rejected = expect(operation).rejects.toThrow('ownership changed')
    await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
    connection.connectionId = 'rpc-1-2'
    finish({ threadId: f.task.threadId, questions: [f.question], question: f.question,
      accepted: true, duplicate: false, startedTurn: { id: 'old-turn', status: 'running' } })
    await rejected
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    expect(f.client.request).toHaveBeenCalledTimes(1)
  }
)

it.each(['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel'])(
  '%s dispatches only on its captured connection without reconnecting',
  async method => {
    const f = fixture()
    const requestOnConnection = vi.fn(async () => { throw new Error('original connection closed') })
    Object.assign(f.client, {
      diagnosticConnection: { targetId: f.server.id, connectionId: 'rpc-1-1' },
      requestOnConnection,
    })
    // Ordinary request() may establish a replacement socket. It must not be
    // used after task ownership was resolved on the original connection.
    await expect(f.call(method, {
      questionId: 'question-a', submissionId: 'submission-a', expectedRevision: 4,
      answers: { item: { selectedOptionIds: ['option-a'] } },
    })).rejects.toThrow('original connection closed')
    expect(requestOnConnection).toHaveBeenCalledWith('rpc-1-1', method, expect.objectContaining({
      threadId: f.task.threadId,
    }))
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
  }
)

it.each(['support', 'list'])(
  '%s rejects a same-client connection change while resolving target ownership',
  async operation => {
    const f = fixture()
    const connection = { targetId: f.server.id, connectionId: 'rpc-1-1' }
    Object.assign(f.client, { diagnosticConnection: connection })
    f.runtime.assertCommandTarget.mockImplementationOnce(async () => {
      connection.connectionId = 'rpc-1-2'
    })
    await expect(operation === 'support'
      ? supportsAsyncQuestions.call(f.runtime as unknown as GatewayRuntimeCore, { taskId: f.task.taskId })
      : f.call('asyncQuestion/list')).rejects.toThrow('ownership changed')
    expect(f.client.request).not.toHaveBeenCalled()
  }
)
