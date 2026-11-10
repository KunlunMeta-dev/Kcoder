import { describe, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'
import { taskDescriptor } from './turns'
import { resolveTaskId } from './resources'

function fixture(requestedTaskId = 'task') {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/original' }
  const servers = [{ id: 'target' }, { id: 'replacement' }]
  let release!: () => void
  const directory = new Promise<typeof servers>(resolve => { release = () => resolve(servers) })
  const client = { supportsExperimental: () => true, request: vi.fn(async () => ({
    threadId: task.threadId, questions: [], question: { threadId: task.threadId, questionId: 'question' },
    accepted: false, duplicate: false,
  })) }
  const runtime = {
    disposed: false, tasks: new Map([[task.taskId, task]]), resolveTaskId,
    canonicalTaskByRequested: new Map([[requestedTaskId, task.taskId]]),
    compatibility: { isRuntimeTaskId: () => true },
    hydrateAllPersistedTasks: vi.fn(async () => { runtime.tasks.set(task.taskId, task) }),
    servers: vi.fn(() => directory), taskDescriptor,
    readyTaskClient: vi.fn(async () => client), assertCommandTarget: vi.fn(async () => undefined),
    clientByTask: new Map([[task.taskId, client]]), appServerDisconnectedClients: new WeakSet(),
  }
  const call = (method: string) => method === 'support'
    ? supportsAsyncQuestions.call(runtime as unknown as GatewayRuntimeCore, { taskId: requestedTaskId })
    : requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, {
      taskId: requestedTaskId, method, params: { questionId: 'question', submissionId: 'submission',
        expectedRevision: 1, answers: { item: { text: 'original answer' } } },
    })
  return { task, runtime, client, release, call }
}

const operations = ['support', 'asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']

describe('async question binding during the original task lookup', () => {
  for (const change of ['threadId', 'serverId', 'workspacePath', 'replacement', 'deletion'] as const) {
    it.each(operations)('%s rejects ' + change + ' changes while the server directory is pending', async method => {
      const f = fixture()
      const outcome = f.call(method).then(value => ({ value, error: undefined }),
        error => ({ value: undefined, error }))
      expect(f.runtime.servers).toHaveBeenCalledOnce()
      if (change === 'replacement') f.runtime.tasks.set(f.task.taskId, { ...f.task, threadId: 'replacement' })
      else if (change === 'deletion') f.runtime.tasks.delete(f.task.taskId)
      else f.task[change] = 'replacement'
      f.release()
      expect((await outcome).error).toEqual(expect.objectContaining({
        message: 'Asynchronous question task ownership changed',
      }))
      expect(f.runtime.readyTaskClient).not.toHaveBeenCalled()
      expect(f.client.request).not.toHaveBeenCalled()
    })
  }

  it.each(operations)('%s permits a projection update with the same original address', async method => {
    const f = fixture(), operation = f.call(method)
    f.runtime.tasks.set(f.task.taskId, { ...f.task })
    f.release()
    await expect(operation).resolves.toBeDefined()
    expect(f.client.request).toHaveBeenCalledTimes(method === 'support' ? 0 : 1)
  })

  it.each(operations)('%s can resolve a persisted task that was not cached at entry', async method => {
    const f = fixture()
    f.runtime.tasks.clear()
    const operation = f.call(method)
    f.release()
    await expect(operation).resolves.toBeDefined()
    expect(f.runtime.hydrateAllPersistedTasks).toHaveBeenCalledOnce()
    expect(f.client.request).toHaveBeenCalledTimes(method === 'support' ? 0 : 1)
  })
})

describe('async question lookup through the original task alias', () => {
  for (const field of ['threadId', 'serverId', 'workspacePath'] as const) {
    it.each(operations)('%s rejects an in-place ' + field + ' rebind through an index alias', async method => {
      const f = fixture('index-alias')
      const outcome = f.call(method).then(value => ({ value, error: undefined }),
        error => ({ value: undefined, error }))
      expect(f.runtime.servers).toHaveBeenCalledOnce()
      f.task[field] = 'replacement'
      f.release()
      expect((await outcome).error).toEqual(expect.objectContaining({
        message: 'Asynchronous question task ownership changed',
      }))
      expect(f.runtime.readyTaskClient).not.toHaveBeenCalled()
      expect(f.client.request).not.toHaveBeenCalled()
    })
  }

  it.each(operations)('%s rejects an alias retargeted during lookup', async method => {
    const f = fixture('index-alias')
    const outcome = f.call(method).then(value => ({ value, error: undefined }),
      error => ({ value: undefined, error }))
    f.runtime.canonicalTaskByRequested.set('index-alias', 'another-task')
    f.release()
    expect((await outcome).error).toEqual(expect.objectContaining({
      message: 'Asynchronous question task ownership changed',
    }))
    expect(f.client.request).not.toHaveBeenCalled()
  })

  it.each(operations)('%s accepts an unchanged alias and canonical address', async method => {
    const f = fixture('index-alias'), operation = f.call(method)
    f.runtime.tasks.set(f.task.taskId, { ...f.task })
    f.release()
    await expect(operation).resolves.toBeDefined()
    expect(f.client.request).toHaveBeenCalledTimes(method === 'support' ? 0 : 1)
  })
})

it.each(operations.flatMap(method => ['readiness', 'receipt']
  .filter(boundary => boundary !== 'receipt' || method !== 'support')
  .map(boundary => [method, boundary])))('%s rejects an alias retargeted during %s', async (method, boundary) => {
  const f = fixture('index-alias')
  if (boundary === 'readiness') {
    f.runtime.readyTaskClient.mockImplementationOnce(async () => {
      f.runtime.canonicalTaskByRequested.set('index-alias', 'another-task')
      return f.client
    })
  } else {
    f.client.request.mockImplementationOnce(async () => {
      f.runtime.canonicalTaskByRequested.set('index-alias', 'another-task')
      return { threadId: f.task.threadId, questions: [],
        question: { threadId: f.task.threadId, questionId: 'question' }, accepted: false, duplicate: false }
    })
  }
  const outcome = f.call(method)
  f.release()
  await expect(outcome).rejects.toThrow('Asynchronous question task ownership changed')
  expect(f.client.request).toHaveBeenCalledTimes(boundary === 'receipt' ? 1 : 0)
})
