import { expect, test, vi } from 'vitest'
import * as gatewayServiceBridge from './gatewayServiceBridge'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

test.each([
  ['question', 'threadId'], ['approval', 'threadId'],
  ['question', 'serverId'], ['approval', 'serverId'],
] as const)(
  '%s requests cannot bind after the indexed task changes %s', async (kind, field) => {
    const client = new FakeGatewayClient('original-thread')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()], createClient: () => client,
    })
    const { taskId } = await runtime.request('runtime.tasks.create', {
      taskId: 'source-address-draft', executionRequest: { prompt: 'controlled task' },
    }) as { taskId: string }
    const emit = vi.spyOn(gatewayServiceBridge, 'emitRuntimeEvent')
    const task = runtime.tasks.get(taskId)!
    // The directory entry can change before resume replaces its reverse index.
    // The connection still being current does not certify the old frame's task.
    const originalServerId = task.serverId
    task[field] = field === 'threadId' ? 'replacement-thread' : 'replacement-target'
    const requestId = 1_000_001
    const original = { id: requestId, method: `${kind}/request`, params: {
      threadId: 'original-thread', turnId: 'turn-1', appServerEpoch: 'epoch',
      ...(kind === 'question'
        ? { questionId: 'question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] }
        : { approvalId: 'approval', action: { type: 'command', command: 'echo controlled' } }),
    } }
    const forward = async (message: typeof original) => {
      client.dispatchEvent(new CustomEvent('request', { detail: message }))
      await Promise.all([...runtime.pendingAsyncJobs])
    }
    await forward(original)
    expect.soft(runtime.pendingQuestionByKey.size).toBe(0)
    expect.soft(emit.mock.calls.filter(([, event]) =>
      (event as { event: string }).event === 'response.block.created')).toHaveLength(0)
    expect.soft(client.responses).toHaveLength(0)

    // A current request remains deliverable after the directory is reconciled.
    task.serverId = originalServerId
    runtime.threadByTask.set(taskId, task.threadId)
    runtime.taskByThread.set(runtime.threadKey(task.serverId, task.threadId), taskId)
    await forward({ ...original, params: { ...original.params, threadId: task.threadId } })
    const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)
    expect(pending?.renderPayload.threadId).toBe(task.threadId)
    expect(emit.mock.calls.filter(([, event]) =>
      (event as { event: string }).event === 'response.block.created')).toHaveLength(1)
    expect(client.responses).toHaveLength(0)
    if (field === 'threadId') {
      await forward(original)
      expect(runtime.pendingQuestionByKey.get(`${taskId}\0${requestId}`)).toBe(pending)
    }
    expect(await runtime.request('runtime.tasks.send', { taskId,
      requestUserInputResponse: { requestId, answers: {
        [kind === 'question' ? 'choice' : 'approval']: {
          answers: [kind === 'question' ? 'Current task only' : 'Allow once'],
        },
      } },
    })).toMatchObject({ accepted: true, pendingServerConfirmation: true })
    expect(client.responses).toEqual([{ id: requestId, result: expect.objectContaining({
      threadId: task.threadId, turnId: 'turn-1',
      ...(kind === 'question' ? { questionId: 'question' } : { approvalId: 'approval' }),
    }) }])
  }
)
