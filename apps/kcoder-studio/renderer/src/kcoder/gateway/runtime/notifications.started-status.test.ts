import { expect, test } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

for (const status of ['completed', 'failed', 'interrupted', 'unknown', null, 7]) {
  test(`start status ${JSON.stringify(status)} cannot strand the original question on a false attempt`, async () => {
    const threadId = 'original-thread', client = new FakeGatewayClient(threadId)
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()], createClient: () => client,
    })
    try {
      const { taskId } = await runtime.request('runtime.tasks.create', {
        executionRequest: { prompt: 'original input' },
      }) as { taskId: string }
      const active = runtime.activeTurnByTask.get(taskId)!
      const binding = { threadId, turnId: active.turnId, appServerEpoch: 'epoch' }
      runtime.turnAttemptIds.set(`${taskId}:${active.turnId}`, 'current')
      await runtime.forwardServerRequest(client, { id: 41, method: 'question/request', params: {
        ...binding, questionId: 'original', questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
      } }, 'local')
      const key = `${taskId}\0${41}`
      expect(runtime.pendingQuestionByKey.has(key)).toBe(true)
      await runtime.forwardNotification('turn/started', { ...binding, sequence: 41,
        turn: { id: active.turnId, attemptId: 'false-attempt', status },
      }, 'local', client)
      await runtime.forwardNotification('turn/completed', { ...binding, sequence: 42,
        turn: { id: active.turnId, attemptId: 'current', status: 'completed' },
      }, 'local', client)
      expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
      expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
      expect(runtime.tasks.get(taskId)?.running).toBe(false)
    } finally { await runtime.dispose() }
  })
}
