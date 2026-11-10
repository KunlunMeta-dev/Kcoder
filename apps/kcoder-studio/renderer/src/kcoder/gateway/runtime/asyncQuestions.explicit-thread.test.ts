import { expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion } from './asyncQuestions'

function fixture(boundConnection: boolean) {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
  const request = vi.fn(async () => ({ threadId: task.threadId, questions: [],
    question: { threadId: task.threadId, questionId: 'question' }, accepted: false, duplicate: false }))
  const client = {
    supportsExperimental: () => true,
    request,
    ...(boundConnection ? {
      diagnosticConnection: { connectionId: 'connection' }, requestOnConnection: request,
    } : {}),
  }
  const runtime = {
    resolveTaskId: (id: string) => id,
    disposed: false, tasks: new Map([[task.taskId, task]]),
    taskDescriptor: async () => ({ taskId: task.taskId, task, server: { id: task.serverId } }),
    readyTaskClient: async () => client, assertCommandTarget: async () => undefined,
    clientByTask: new Map([[task.taskId, client]]), appServerDisconnectedClients: new WeakSet(),
  }
  const call = (method: string, binding: Record<string, unknown>) => requestAsyncQuestion.call(
    runtime as unknown as GatewayRuntimeCore,
    { taskId: task.taskId, method, params: { questionId: 'question', submissionId: 'submission',
      expectedRevision: 1, answers: { item: { text: 'original answer' } }, ...binding } }
  )
  return { task, runtime, request, call }
}

for (const boundConnection of [false, true]) {
  for (const method of ['asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']) {
    it.each([null, '', 42, 'another-thread'])(
      `${boundConnection ? 'connection-bound' : 'legacy'} ${method} rejects explicit thread %j without dispatch`,
      async threadId => {
        const f = fixture(boundConnection)
        // An invalid explicit address must never be replaced with the selected
        // task's address, especially for answer/cancel mutations.
        await expect(f.call(method, { threadId })).rejects.toThrow('ownership changed')
        expect(f.request).not.toHaveBeenCalled()
        expect(f.runtime.tasks.get(f.task.taskId)).toEqual(f.task)
        // Recovery is an explicit valid call, never automatic input replay.
        await expect(f.call(method, { threadId: f.task.threadId })).resolves.toBeDefined()
        expect(f.request).toHaveBeenCalledExactlyOnceWith(
          ...(boundConnection ? ['connection'] : []), method,
          expect.objectContaining({ threadId: f.task.threadId })
        )
      }
    )

    it(`${boundConnection ? 'connection-bound' : 'legacy'} ${method} retains omitted-thread compatibility`, async () => {
      const f = fixture(boundConnection)
      await expect(f.call(method, {})).resolves.toBeDefined()
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        ...(boundConnection ? ['connection'] : []), method,
        expect.objectContaining({ threadId: f.task.threadId })
      )
    })
  }
}
