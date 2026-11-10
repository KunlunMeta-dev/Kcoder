import { describe, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'

function fixture() {
  const task = {
    taskId: 'kcoder:target-a:thread-a',
    serverId: 'target-a',
    threadId: 'thread-a',
    workspacePath: '/owned/a',
  }
  const input = {
    questionId: 'question-a',
    submissionId: 'submission-a',
    expectedRevision: 4,
    answers: { item: { selectedOptionIds: ['option-a'] } },
  }
  const question = {
    threadId: task.threadId,
    questionId: input.questionId,
    answer: { submissionId: input.submissionId, answers: input.answers },
  }
  const receipt = {
    threadId: task.threadId,
    questions: [question],
    question,
    accepted: true,
    duplicate: false,
    startedTurn: { id: 'answer-turn', status: 'running' },
  }
  const client = {
    // Losing app-server does not require the Gateway WebSocket to reconnect.
    diagnosticConnection: { targetId: task.serverId, connectionId: 'still-open-gateway' },
    supportsExperimental: vi.fn(() => true),
    request: vi.fn(async () => receipt),
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
    appServerDisconnectedClients: new WeakSet<object>(),
    completedTurnKeys: new Set(),
    activeTurnByTask: new Map(),
    trackActiveTurn: vi.fn(),
  }
  const call = (method: string) =>
    method === 'support'
      ? supportsAsyncQuestions.call(runtime as unknown as GatewayRuntimeCore, {
          taskId: task.taskId,
        })
      : requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, {
          taskId: task.taskId,
          method,
          params: input,
        })
  return { task, client, runtime, receipt, call }
}

const operations = ['support', 'asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']

function invalidateOwner(f: ReturnType<typeof fixture>, change: string) {
  if (change === 'disconnect') f.runtime.appServerDisconnectedClients.add(f.client)
  else if (change === 'task rebinding') {
    f.runtime.tasks.set(f.task.taskId, { ...f.task, threadId: 'replacement-thread' })
  } else if (change === 'client replacement') {
    f.runtime.clientByTask.set(f.task.taskId, { ...f.client })
  } else f.client.diagnosticConnection.connectionId = 'replacement-connection'
}

const changes = ['disconnect', 'task rebinding', 'client replacement', 'connection replacement']

function deferredTargetCheck(f: ReturnType<typeof fixture>) {
  let release!: () => void
  f.runtime.assertCommandTarget.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        release = resolve
      })
  )
  return () => release()
}

describe('async question ownership at await boundaries', () => {
  it.each(operations.flatMap(method => changes.map(change => [method, change])))(
    '%s rechecks ownership after owner lookup (%s)',
    async (method, change) => {
      const f = fixture()
      const release = deferredTargetCheck(f)
      const pending = f.call(method)
      const outcome = pending.then(
        value => ({ value, error: undefined }),
        error => ({ value: undefined, error })
      )
      await vi.waitFor(() => expect(f.runtime.assertCommandTarget).toHaveBeenCalledTimes(1))
      release()
      // The target check continuation validates the old owner first. Another
      // pending operation then changes it before the nested lookup returns.
      await Promise.resolve()
      invalidateOwner(f, change)
      const result = await outcome
      expect(result.error).toBeInstanceOf(Error)
      expect(f.client.request).not.toHaveBeenCalled()
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    }
  )

  it.each(operations.slice(1).flatMap(method => changes.map(change => [method, change])))(
    '%s rechecks ownership before applying a checked receipt (%s)',
    async (method, change) => {
      const f = fixture()
      // Only hold the post-receipt target check; initial task lookup is current.
      f.runtime.assertCommandTarget.mockResolvedValueOnce(undefined)
      const release = deferredTargetCheck(f)
      const pending = f.call(method)
      const outcome = pending.then(
        value => ({ value, error: undefined }),
        error => ({ value: undefined, error })
      )
      await vi.waitFor(() => expect(f.runtime.assertCommandTarget).toHaveBeenCalledTimes(2))
      release()
      await Promise.resolve()
      invalidateOwner(f, change)
      const result = await outcome
      expect(result.error).toBeInstanceOf(Error)
      expect(f.client.request).toHaveBeenCalledTimes(1)
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.tasks.get(f.task.taskId)).not.toHaveProperty('running')
    }
  )
})
