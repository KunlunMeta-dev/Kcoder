import { expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion } from './asyncQuestions'

for (const connectionBound of [false, true]) {
  for (const field of ['accepted', 'duplicate']) {
    it.each([undefined, null, 'true'])(
      `${connectionBound ? 'connection-bound' : 'legacy'} answer rejects ${field}=%j before applying turn state`,
      async value => {
        const task = { taskId: 'task', serverId: 'target', threadId: 'thread',
          workspacePath: '/owned', running: false }
        const input = { questionId: 'question', submissionId: 'submission', expectedRevision: 1,
          answers: { item: { text: 'original answer' } } }
        const question = { questionId: input.questionId, threadId: task.threadId,
          answer: { submissionId: input.submissionId, answers: input.answers } }
        const request = vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(async () => ({ threadId: task.threadId, question,
          accepted: true, duplicate: false, [field]: value,
          startedTurn: { id: 'unconfirmed-turn', status: 'running' } }))
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
}
