import { describe, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'
import { taskDescriptor } from './turns'

const operations = ['support', 'asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']
const aliases = [
  ['/owned/repo', '/owned/repo/'],
  [String.raw`c:\work\repo`, 'C:/work/repo/'],
  [String.raw`\\?\C:\work\repo`, 'C:/work/repo'],
]

function fixture(workspacePath: string) {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath }
  const input = {
    questionId: 'question',
    submissionId: 'submission',
    expectedRevision: 1,
    answers: { item: { selectedOptionIds: ['option'], text: ' original answer ' } },
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
    accepted: true, duplicate: false,
    startedTurn: { id: 'answer-turn', threadId: task.threadId, status: 'running' },
  }
  const client = { supportsExperimental: () => true, request: vi.fn(async () => receipt) }
  const runtime = {
    disposed: false,
    tasks: new Map([[task.taskId, task]]),
    resolveTaskId: (id: string) => id,
    compatibility: { isRuntimeTaskId: () => true },
    servers: vi.fn(async () => [{ id: task.serverId }]),
    taskDescriptor,
    readyTaskClient: vi.fn<(address: typeof task) => Promise<typeof client>>(async () => client),
    assertCommandTarget: vi.fn(async () => undefined),
    clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(),
    completedTurnKeys: new Set(),
    activeTurnByTask: new Map(),
    trackActiveTurn: vi.fn(),
  }
  const call = (method: string) =>
    method === 'support'
      ? supportsAsyncQuestions.call(runtime as unknown as GatewayRuntimeCore, {
          taskId: task.taskId,
          workspacePath,
        })
      : requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, {
          taskId: task.taskId,
          workspacePath,
          method,
          params: input,
        })
  const replacePath = (path: string) => {
    runtime.tasks.set(task.taskId, { ...task, workspacePath: path })
  }
  return { task, runtime, client, receipt, input, call, replacePath }
}

describe('async question workspace identity across projection refreshes', () => {
  for (const [original, alias] of aliases) {
    for (const boundary of ['lookup', 'readiness', 'receipt'] as const) {
      const methods = boundary === 'receipt' ? operations.slice(1) : operations
      it.each(methods)(
        `%s retains ${original} ownership after an alias refresh during ${boundary}`,
        async method => {
          const f = fixture(original)
          if (boundary === 'lookup')
            f.runtime.servers.mockImplementationOnce(async () => {
              f.replacePath(alias)
              return [{ id: f.task.serverId }]
            })
          if (boundary === 'readiness')
            f.runtime.readyTaskClient.mockImplementationOnce(async () => {
              f.replacePath(alias)
              return f.client
            })
          if (boundary === 'receipt')
            f.client.request.mockImplementationOnce(async () => {
              f.replacePath(alias)
              return f.receipt
            })
          await expect(f.call(method)).resolves.toBeDefined()
          expect(f.client.request).toHaveBeenCalledTimes(method === 'support' ? 0 : 1)
          if (method !== 'support')
            expect(f.client.request).toHaveBeenCalledWith(
              method,
              expect.objectContaining({ threadId: f.task.threadId })
            )
          if (method === 'asyncQuestion/answer') {
            expect(f.client.request).toHaveBeenCalledWith(method, {
              ...f.input,
              threadId: f.task.threadId,
            })
            expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
          }
          // Comparison identities must never replace a path used for connection setup.
          expect(f.runtime.readyTaskClient.mock.calls[0][0]).toMatchObject({
            workspacePath: original,
          })
        }
      )
    }
  }

  it.each(['C:/Work/repo', 'C:/work/./repo', String.raw`\\?\C:\work\repo.`])(
    'still rejects a distinct workspace %s without applying or replaying its answer receipt',
    async replacement => {
      const f = fixture('C:/work/repo')
      f.client.request.mockImplementationOnce(async () => {
        f.replacePath(replacement)
        return f.receipt
      })
      await expect(f.call('asyncQuestion/answer')).rejects.toThrow(
        'Asynchronous question task ownership changed'
      )
      expect(f.client.request).toHaveBeenCalledOnce()
      expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
      expect(f.runtime.tasks.get(f.task.taskId)).not.toHaveProperty('running')
    }
  )
})
