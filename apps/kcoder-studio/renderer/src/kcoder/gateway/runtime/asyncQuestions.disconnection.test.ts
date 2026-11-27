import { describe, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { requestAsyncQuestion, supportsAsyncQuestions } from './asyncQuestions'

function fixture() {
  const task = {
    taskId: 'kcoder:target-a:thread-a', serverId: 'target-a',
    threadId: 'thread-a', workspacePath: '/owned/a',
  }
  const input = {
    questionId: 'question-a', submissionId: 'submission-a', expectedRevision: 4,
    answers: { item: { selectedOptionIds: ['option-a'] } },
  }
  const question = {
    threadId: task.threadId, questionId: input.questionId,
    answer: { submissionId: input.submissionId, answers: input.answers },
  }
  const receipt = {
    threadId: task.threadId, questions: [question], question,
    accepted: true, duplicate: false, startedTurn: { id: 'answer-turn', status: 'running' },
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
    taskDescriptor: vi.fn(async () => ({ taskId: task.taskId, task, server: { id: task.serverId } })),
    readyTaskClient: vi.fn(async () => client),
    assertCommandTarget: vi.fn(async () => undefined),
    tasks: new Map([[task.taskId, task]]),
    clientByTask: new Map([[task.taskId, client]]),
    appServerDisconnectedClients: new WeakSet<object>(),
    completedTurnKeys: new Set(), activeTurnByTask: new Map(),
    trackActiveTurn: vi.fn(),
  }
  const call = (method: string) => method === 'support'
    ? supportsAsyncQuestions.call(runtime as unknown as GatewayRuntimeCore, { taskId: task.taskId })
    : requestAsyncQuestion.call(runtime as unknown as GatewayRuntimeCore, {
      taskId: task.taskId, method, params: input,
    })
  return { task, client, runtime, receipt, call }
}

const operations = ['support', 'asyncQuestion/list', 'asyncQuestion/answer', 'asyncQuestion/cancel']

describe('async question app-server disconnect fence', () => {
  for (const timing of ['before lookup', 'during target lookup']) {
    it.each(operations)('%s refuses dispatch after app-server loss ' + timing, async method => {
      const f = fixture()
      if (timing === 'before lookup') f.runtime.appServerDisconnectedClients.add(f.client)
      else f.runtime.assertCommandTarget.mockImplementationOnce(async () => {
        f.runtime.appServerDisconnectedClients.add(f.client)
      })
      await expect(f.call(method)).rejects.toThrow('ownership changed')
      expect(f.client.request).not.toHaveBeenCalled()
    })
  }

  it.each(operations.slice(1))('%s rejects a delayed receipt after app-server loss', async method => {
    const f = fixture()
    let finish!: (value: typeof f.receipt) => void
    f.client.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.call(method)
    await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(1))
    // connectClient records this synchronously on server/disconnected, before
    // its asynchronous task recovery can replace the old task client.
    f.runtime.appServerDisconnectedClients.add(f.client)
    finish(f.receipt)
    await expect(pending).rejects.toThrow('ownership changed')
    expect(f.runtime.trackActiveTurn).not.toHaveBeenCalled()
    expect(f.runtime.tasks.get(f.task.taskId)).not.toHaveProperty('running')
    expect(f.client.request).toHaveBeenCalledTimes(1)
  })

  it('allows an explicitly recovered client without replaying the old answer', async () => {
    const f = fixture()
    f.runtime.appServerDisconnectedClients.add(f.client)
    const recovered = { ...f.client, diagnosticConnection: { ...f.client.diagnosticConnection,
      connectionId: 'recovered-gateway' }, request: vi.fn(async () => f.receipt) }
    f.runtime.clientByTask.set(f.task.taskId, recovered)
    f.runtime.readyTaskClient.mockResolvedValueOnce(recovered)
    await expect(f.call('asyncQuestion/list')).resolves.toBe(f.receipt)
    expect(recovered.request).toHaveBeenCalledExactlyOnceWith('asyncQuestion/list', {
      threadId: f.task.threadId, includeTerminal: true,
    })
    expect(f.client.request).not.toHaveBeenCalled()
  })
})
