import { expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion } from './asyncQuestions'

for (const connectionBound of [false, true]) {
  it.each([
    ...['accepted', 'duplicate'].flatMap(field => [undefined, null, 'true'].map(value => ({
      label: `${field}=${String(value)}`, override: { [field]: value },
    }))),
    { label: 'a started turn reusing the source turn identity',
      override: { startedTurn: { id: 'source-turn', status: 'running' } } },
    { label: 'a cancelled answer claiming a started turn',
      override: { questionStatus: 'cancelled' } },
    { label: 'a stale answer claiming a started turn',
      override: { questionStatus: 'stale' } },
    { label: 'a refusal for the exact saved submission',
      override: { accepted: false, startedTurn: undefined } },
    ...[undefined, null, { submissionId: 'winner', answers: {} },
      { submissionId: 'winner', answers: { item: { text: 7 } } }].map(answer => ({
      label: `a competing receipt with an unusable saved answer ${JSON.stringify(answer)}`,
      override: { accepted: false, startedTurn: undefined, savedAnswerOverride: { answer } },
    })),
    { label: 'a competing receipt claiming a started turn',
      override: { accepted: false, competing: true } },
    { label: 'a competing receipt claiming an exact retry',
      override: { accepted: false, duplicate: true, startedTurn: undefined, competing: true } },
  ])(
    `${connectionBound ? 'connection-bound' : 'legacy'} answer rejects $label before applying turn state`,
    async ({ override }) => {
      const { competing, questionStatus, savedAnswerOverride, ...receiptFields } = override
      const task = { taskId: 'task', serverId: 'target', threadId: 'thread',
        workspacePath: '/owned', running: false }
      const input = { questionId: 'question', submissionId: 'submission', expectedRevision: 1,
        answers: { item: { text: 'original answer' } } }
      const question = { questionId: input.questionId, threadId: task.threadId,
        sourceTurnId: 'source-turn', status: questionStatus ?? 'queued',
        answer: { submissionId: input.submissionId, answers: input.answers } }
      const request = vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
        threadId: task.threadId,
        question: {
          ...question,
          ...(competing ? { answer: { ...question.answer, submissionId: 'winner' } } : {}),
          ...savedAnswerOverride,
        },
        accepted: true, duplicate: false,
        startedTurn: { id: 'unconfirmed-turn', status: 'running' },
        ...receiptFields,
      }))
      const client = { request, supportsExperimental: () => true,
        ...(connectionBound ? { diagnosticConnection: { connectionId: 'connection' },
          requestOnConnection: request } : {}) }
      const runtime = {
        disposed: false, resolveTaskId: (id: string) => id,
        taskDescriptor: async () => ({ taskId: task.taskId, task, server: { id: task.serverId } }),
        readyTaskClient: async () => client, assertCommandTarget: async () => undefined,
        tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
        appServerDisconnectedClients: new WeakSet(),
        activeTurnByTask: new Map(), completedTurnKeys: new Set(), trackActiveTurn: vi.fn(),
      }
      const call = (method: string) => requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore,
        { taskId: task.taskId, method, params: input })
      if (questionStatus === 'cancelled' || questionStatus === 'stale') {
        request.mockResolvedValueOnce({
          threadId: task.threadId, question, accepted: true, duplicate: true, startedTurn: null,
        })
        await expect(call('asyncQuestion/answer')).resolves.toMatchObject({ question, startedTurn: null })
        request.mockClear()
      }
      const outcome = await call('asyncQuestion/answer').then(() => undefined, error => error)
      expect(runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(runtime.tasks.get(task.taskId)).toEqual(task)
      expect(outcome).toBeInstanceOf(Error)
      expect(outcome.message).toContain('receipt')
      expect(request).toHaveBeenCalledTimes(1)

      // Recovery reads the original task; it never repeats the answer.
      request.mockResolvedValueOnce({ threadId: task.threadId, questions: [question] })
      await expect(call('asyncQuestion/list')).resolves.toHaveProperty('questions', [question])
      expect(request.mock.calls.map(args => args[connectionBound ? 1 : 0]))
        .toEqual(['asyncQuestion/answer', 'asyncQuestion/list'])
    }
  )
}
