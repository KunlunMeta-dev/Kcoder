import { describe, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'

function fixture() {
  const task = {
    taskId: 'task-a', serverId: 'target-a', threadId: 'thread-a', workspacePath: '/owned/a',
  }
  const server = { id: task.serverId }
  const input = {
    questionId: 'question-a', submissionId: 'submission-a', expectedRevision: 4,
    answers: { item: { selectedOptionIds: ['option-a'] } },
  }
  const question = {
    threadId: task.threadId, questionId: input.questionId,
    answer: { submissionId: input.submissionId, answers: input.answers },
  }
  const receipt = {
    threadId: task.threadId, questions: [question], question, accepted: true, duplicate: false,
    startedTurn: { id: 'answer-turn', status: 'running' },
  }
  const client = {
    supportsExperimental: () => true,
    request: vi.fn(async () => receipt),
  }
  const runtime = {
    resolveTaskId: (id: string) => id,
    disposed: false,
    // taskDescriptor exposes the task stored in the runtime map by reference.
    taskDescriptor: vi.fn(async () => ({ taskId: task.taskId, task, server })),
    readyTaskClient: vi.fn(async () => client),
    assertCommandTarget: vi.fn(async () => undefined),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(), completedTurnKeys: new Set(),
    activeTurnByTask: new Map(), trackActiveTurn: vi.fn(),
  }
  const call = (method: string) => method === 'support'
    ? supportsAsyncQuestions.call(runtime as unknown as GatewayRuntimeCore, { taskId: task.taskId })
    : requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, {
      taskId: task.taskId, method, params: input,
    })
  return { task, server, runtime, client, receipt, call }
}

const operations = ['support', 'asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']
const fields = ['threadId', 'workspacePath', 'serverId'] as const

describe('async question original task binding snapshot', () => {
  it.each(operations)('%s rejects a workspace from an older card before task readiness', async method => {
    const f = fixture()
    const params = { taskId: f.task.taskId, workspacePath: '/previous-workspace' }
    const request = method === 'support'
      ? supportsAsyncQuestions.call(f.runtime as unknown as GatewayRuntimeCore, params)
      : requestAsyncQuestion.call(f.runtime as unknown as GatewayRuntimeCore, {
          ...params, method, params: {
            questionId: 'question-a', submissionId: 'submission-a', expectedRevision: 4,
            answers: { item: { selectedOptionIds: ['option-a'] } },
          },
        })
    await expect(request).rejects.toThrow('Asynchronous question task ownership changed')
    expect(f.runtime.readyTaskClient).not.toHaveBeenCalled()
    expect(f.client.request).not.toHaveBeenCalled()
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
  })

  it.each(operations)('%s accepts an equivalent original workspace spelling', async method => {
    const f = fixture()
    const params = { taskId: f.task.taskId, workspacePath: '/owned/a/' }
    const request = method === 'support'
      ? supportsAsyncQuestions.call(f.runtime as unknown as GatewayRuntimeCore, params)
      : requestAsyncQuestion.call(f.runtime as unknown as GatewayRuntimeCore, {
          ...params, method, params: {
            questionId: 'question-a', submissionId: 'submission-a', expectedRevision: 4,
            answers: { item: { selectedOptionIds: ['option-a'] } },
          },
        })
    await expect(request).resolves.toBeDefined()
    expect(f.client.request).toHaveBeenCalledTimes(method === 'support' ? 0 : 1)
    if (method !== 'support') expect(f.client.request).toHaveBeenCalledWith(
      method, expect.not.objectContaining({ workspacePath: expect.anything() })
    )
  })

  for (const boundary of ['readyTaskClient', 'assertCommandTarget'] as const) {
    it.each(operations.flatMap(method => fields.map(field => [method, field] as const)))(
      '%s rejects an in-place %s rebind during ' + boundary,
      async (method, field) => {
        const f = fixture()
        let release!: () => void
        let entered!: () => void
        const waiting = new Promise<void>(resolve => { entered = resolve })
        const gate = new Promise<void>(resolve => { release = resolve })
        if (boundary === 'readyTaskClient') {
          f.runtime.readyTaskClient.mockImplementationOnce(async () => {
            entered()
            await gate
            return f.client
          })
        } else {
          f.runtime.assertCommandTarget.mockImplementationOnce(async () => {
            entered()
            await gate
          })
        }
        const outcome = f.call(method).then(value => ({ value, error: undefined }),
          error => ({ value: undefined, error }))
        await waiting
        f.task[field] = 'replacement'
        if (field === 'serverId') f.server.id = 'replacement'
        release()
        const result = await outcome
        expect(result.error).toEqual(expect.objectContaining({ message: 'Asynchronous question task ownership changed' }))
        expect(f.client.request).not.toHaveBeenCalled()
        expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      }
    )
  }

  it.each(operations.slice(1).flatMap(method => fields.map(field => [method, field] as const)))(
    '%s rejects an old receipt after an in-place %s rebind', async (method, field) => {
      const f = fixture()
      let finish!: () => void
      let entered!: () => void
      const waiting = new Promise<void>(resolve => { entered = resolve })
      f.client.request.mockImplementationOnce(() => new Promise(resolve => {
        finish = () => resolve(f.receipt)
        entered()
      }))
      const outcome = f.call(method).then(value => ({ value, error: undefined }),
        error => ({ value: undefined, error }))
      await waiting
      f.task[field] = 'replacement'
      if (field === 'serverId') f.server.id = 'replacement'
      finish()
      const result = await outcome
      expect(result.error).toEqual(expect.objectContaining({ message: 'Asynchronous question task ownership changed' }))
      expect(f.client.request).toHaveBeenCalledExactlyOnceWith(method, expect.objectContaining({ threadId: 'thread-a' }))
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.tasks.get(f.task.taskId)).not.toHaveProperty('running')
    }
  )

  it.each(operations)('%s permits task projection replacement with unchanged binding', async method => {
    const f = fixture()
    f.runtime.readyTaskClient.mockImplementationOnce(async () => {
      f.runtime.tasks.set(f.task.taskId, { ...f.task })
      return f.client
    })
    await expect(f.call(method)).resolves.toBeDefined()
    expect(f.client.request).toHaveBeenCalledTimes(method === 'support' ? 0 : 1)
  })
})
