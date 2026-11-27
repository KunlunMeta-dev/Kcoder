import { describe, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'
import { refreshCommandDirectory } from './connections'

const operations = ['support', 'asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']

function fixture() {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
  const server = { id: task.serverId, transport: 'local' }
  const input = { questionId: 'question', expectedRevision: 1, submissionId: 'submission',
    answers: { item: { text: 'original' } } }
  const question = { threadId: task.threadId, questionId: input.questionId,
    answer: { submissionId: input.submissionId, answers: input.answers } }
  const receipt = { threadId: task.threadId, question, questions: [question], accepted: true, duplicate: false,
    startedTurn: { id: 'answer-turn', status: 'running' } }
  const client = { supportsExperimental: () => true, request: vi.fn(async () => receipt) }
  let finishDirectory!: () => void
  const directory = new Promise<Array<typeof server>>(resolve => {
    finishDirectory = () => resolve([server])
  })
  const runtime = {
    resolveTaskId: (id: string) => id,
    disposed: false,
    taskDescriptor: async () => ({ taskId: task.taskId, task, server }),
    readyTaskClient: async () => client,
    assertCommandTarget: vi.fn(async () => undefined),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(),
    completedTurnKeys: new Set(), activeTurnByTask: new Map(), trackActiveTurn: vi.fn(),
    commandDirectoryRefresh: new Map(), commandDirectorySequence: 0,
    configurationEpochByTarget: new Map(), commandClientByServer: new Map(),
    commandClientScopeByKey: new Map(), servers: () => directory, serversPromise: directory,
  }
  const core = runtime as unknown as GatewayRuntimeCore
  const call = (method: string) => method === 'support'
    ? supportsAsyncQuestions.call(core, { taskId: task.taskId })
    : requestAsyncQuestion.call(core, { taskId: task.taskId, method, params: input })
  const refresh = (targetId: string | undefined) => {
    refreshCommandDirectory.call(core, targetId, new Map())
    return runtime.commandDirectoryRefresh.get(targetId).result as Promise<unknown>
  }
  return { runtime, task, client, call, refresh, finishDirectory }
}

function holdTargetCheck(f: ReturnType<typeof fixture>) {
  let release!: () => void
  f.runtime.assertCommandTarget.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  return () => release()
}

describe('async question target directory refresh fence', () => {
  for (const targetId of ['target', undefined]) {
    it.each(operations)('%s cannot dispatch after a new directory refresh starts (' + targetId + ')', async method => {
      const f = fixture(), release = holdTargetCheck(f)
      const outcome = f.call(method).then(value => ({ value, error: undefined }),
        error => ({ value: undefined, error }))
      await vi.waitFor(() => expect(f.runtime.assertCommandTarget).toHaveBeenCalledTimes(1))
      release()
      // The helper checks its old binding, then yields before its caller sends.
      await Promise.resolve()
      const refreshed = f.refresh(targetId)
      try {
        expect((await outcome).error).toEqual(expect.objectContaining({
          message: 'Asynchronous question task ownership changed',
        }))
        expect(f.client.request).not.toHaveBeenCalled()
      } finally {
        f.finishDirectory()
        await refreshed
      }
      // An explicit new operation can use the newly checked directory.
      await expect(f.call(method)).resolves.toBeDefined()
    })

    it.each(operations.slice(1))('%s cannot publish a receipt after a new refresh starts (' + targetId + ')', async method => {
      const f = fixture()
      f.runtime.assertCommandTarget.mockResolvedValueOnce(undefined)
      const release = holdTargetCheck(f)
      const outcome = f.call(method).then(value => ({ value, error: undefined }),
        error => ({ value: undefined, error }))
      await vi.waitFor(() => expect(f.runtime.assertCommandTarget).toHaveBeenCalledTimes(2))
      release()
      await Promise.resolve()
      const refreshed = f.refresh(targetId)
      try {
        expect((await outcome).error).toBeInstanceOf(Error)
        expect(f.client.request).toHaveBeenCalledTimes(1)
        expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
        expect(f.runtime.tasks.get(f.task.taskId)).not.toHaveProperty('running')
      } finally {
        f.finishDirectory()
        await refreshed
      }
    })
  }

  it.each(operations)('%s remains valid when only another target refreshes', async method => {
    const f = fixture(), release = holdTargetCheck(f)
    const operation = f.call(method)
    await vi.waitFor(() => expect(f.runtime.assertCommandTarget).toHaveBeenCalledTimes(1))
    release()
    await Promise.resolve()
    const refreshed = f.refresh('unrelated-target')
    try {
      await expect(operation).resolves.toBeDefined()
      expect(f.client.request).toHaveBeenCalledTimes(method === 'support' ? 0 : 1)
    } finally {
      f.finishDirectory()
      await refreshed
    }
  })
})
