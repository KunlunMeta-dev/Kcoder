import { describe, expect, test, vi } from 'vitest'
import * as gatewayServiceBridge from './gatewayServiceBridge'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

describe.each(['question', 'approval'] as const)('%s task rebinding', kind => {
  test.each([
    ['threadId', false], ['threadId', true],
    ['workspacePath', false], ['workspacePath', true],
  ] as const)('reused request after %s changes gets a current card (old answer pending=%s)', async (field, answered) => {
    const client = new FakeGatewayClient('original-thread')
    const runtime = createTestGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()], createClient: () => client,
    })
    const { taskId } = await runtime.request('runtime.tasks.create', {
      taskId: 'rebind-draft', executionRequest: { prompt: 'controlled task' },
    }) as { taskId: string }
    const emit = vi.spyOn(gatewayServiceBridge, 'emitRuntimeEvent')
    const requestId = 1_000_000
    const key = `${taskId}\0${requestId}`
    const message = { id: requestId, method: `${kind}/request`, params: {
      threadId: 'original-thread', turnId: 'turn-1', appServerEpoch: 'epoch',
      ...(kind === 'question'
        ? { questionId: 'question', questions: [{ id: 'choice', prompt: 'Continue?', options: [] }] }
        : { approvalId: 'approval', action: { type: 'command', command: 'echo controlled' } }),
    } }
    const forward = async () => {
      client.dispatchEvent(new CustomEvent('request', { detail: message }))
      await Promise.all([...runtime.pendingAsyncJobs])
    }
    const answer = () => runtime.request('runtime.tasks.send', { taskId,
      requestUserInputResponse: { requestId, itemId: kind,
        answers: { [kind === 'question' ? 'choice' : kind]: { answers: ['Allow once'] } } },
    })
    await forward()
    const original = runtime.pendingQuestionByKey.get(key)!
    expect(original).toBeDefined()
    if (answered) expect(await answer()).toMatchObject({ accepted: true })
    const task = runtime.tasks.get(taskId)!
    const previousThreadKey = runtime.threadKey(task.serverId, task.threadId)
    if (field === 'threadId') {
      task.threadId = 'replacement-thread'
      runtime.threadByTask.set(taskId, task.threadId)
      runtime.taskByThread.delete(previousThreadKey)
      runtime.taskByThread.set(runtime.threadKey(task.serverId, task.threadId), taskId)
    } else {
      task.workspacePath = '/replacement-workspace'
    }
    message.params.threadId = task.threadId

    await forward()
    const replacement = runtime.pendingQuestionByKey.get(key)
    expect.soft(replacement).toBeDefined()
    expect.soft(replacement).not.toBe(original)
    expect.soft(replacement?.responsePending).not.toBe(true)
    const cards = emit.mock.calls.filter(([, event]) =>
      (event as { event: string }).event === 'response.block.created')
    expect.soft(cards).toHaveLength(2)
    expect(await answer()).toMatchObject({ accepted: true, pendingServerConfirmation: true })
    expect(client.responses).toHaveLength(answered ? 2 : 1)
    expect(client.responses.at(-1)).toEqual({ id: requestId,
      result: expect.objectContaining({ threadId: task.threadId, turnId: 'turn-1' }),
    })
    await forward()
    expect(runtime.pendingQuestionByKey.get(key)).toBe(replacement)
    expect(await answer()).toMatchObject({ accepted: false, code: 'request_user_input_response_pending' })
    expect(client.responses).toHaveLength(answered ? 2 : 1)
  })
})
