import { describe, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'
import { readyTaskClient, taskDescriptor } from './turns'

const expected = { targetId: 'original-native', workspaceId: 'original-workspace', threadId: 'thread' }
const operations = ['support', 'asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']

function fixture(supportsSelector = true) {
  const task = { taskId: 'kcoder:target:thread', serverId: 'target', threadId: 'thread', workspacePath: '/original' }
  const question = { threadId: task.threadId, questionId: 'question', revision: 2,
    answer: { submissionId: 'submission', answers: { item: { text: 'Original answer' } } } }
  const client = {
    supportsExperimental: () => true,
    request: vi.fn(async (method: string) => method === 'asyncQuestion/cancel'
      ? { threadId: task.threadId, question: { ...question, status: 'cancelled', revision: 3 } }
      : { threadId: task.threadId, questions: [], question, accepted: true, duplicate: false }),
    ...(supportsSelector ? { expectSessionAddress: vi.fn() } : {}),
  }
  const runtime = {
    disposed: false, tasks: new Map([[task.taskId, task]]),
    resolveTaskId: (id: string) => id, compatibility: { isRuntimeTaskId: () => true },
    servers: vi.fn(async () => [{ id: task.serverId }]),
    taskDescriptor, readyTaskClient,
    assertCommandTarget: vi.fn(async () => undefined), isRestartingServer: () => false,
    disconnectRecoveryByTask: new Map(), clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet(),
  }
  const call = (operation: string, selector: unknown) => {
    const params = { taskId: task.taskId, deviceId: task.serverId, workspacePath: task.workspacePath,
      expectedSessionAddress: selector, method: operation,
      params: { questionId: 'question', expectedRevision: 1, submissionId: 'submission', answers: question.answer.answers } }
    return operation === 'support'
      ? supportsAsyncQuestions.call(runtime as unknown as GatewayRuntimeCore, params)
      : requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, params)
  }
  return { client, runtime, call }
}

describe('async questions retain the original canonical session selector', () => {
  it.each(operations)('%s binds the selector before preparing or using the original connection', async operation => {
    const f = fixture()
    await expect(f.call(operation, expected)).resolves.toBeDefined()
    expect(f.client.expectSessionAddress).toHaveBeenCalledWith(expected)
    expect(f.client.request).toHaveBeenCalledTimes(operation === 'support' ? 0 : 1)
    if (operation !== 'support')
      expect(f.client.expectSessionAddress!.mock.invocationCallOrder[0])
        .toBeLessThan(f.client.request.mock.invocationCallOrder[0])
  })

  it.each(operations)('%s keeps the original selector while target discovery is pending', async operation => {
    const f = fixture()
    let release!: () => void
    f.runtime.servers.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve([{ id: 'target' }])
    }))
    const selector = { ...expected }
    const pending = f.call(operation, selector)
    expect(f.runtime.servers).toHaveBeenCalledTimes(1)
    selector.workspaceId = 'replacement-workspace'
    release()

    await expect(pending).resolves.toBeDefined()
    expect(f.client.expectSessionAddress).toHaveBeenCalledExactlyOnceWith(expected)
    expect(f.client.request).toHaveBeenCalledTimes(operation === 'support' ? 0 : 1)
  })

  it.each(operations)('%s refuses a same-alias replacement that cannot honor the selector', async operation => {
    const f = fixture(false)
    await expect(f.call(operation, expected)).rejects.toThrow('SESSION_ADDRESS_EXPECTATION_UNSUPPORTED')
    expect(f.client.request).not.toHaveBeenCalled()
  })

  it.each(operations)('%s rejects a changed canonical workspace without replacing the original constraint', async operation => {
    const f = fixture()
    await f.call('support', expected)
    await expect(f.call(operation, { ...expected, workspaceId: 'replacement-workspace' }))
      .rejects.toThrow('SESSION_ADDRESS_EXPECTATION_CONFLICT')
    expect(f.client.request).not.toHaveBeenCalled()
    await expect(f.call(operation, expected)).resolves.toBeDefined()
    expect(f.client.expectSessionAddress).toHaveBeenLastCalledWith(expected)
  })

  it.each(operations)('%s keeps ordinary task calls without a selector compatible', async operation => {
    const f = fixture(false)
    await expect(f.call(operation, undefined)).resolves.toBeDefined()
    expect(f.client.request).toHaveBeenCalledTimes(operation === 'support' ? 0 : 1)
  })
})
