import { expect, test } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

for (const method of ['turn/started', 'turn/completed']) {
  test.each([null, -1, 1.5, '42', {}, Number.MAX_SAFE_INTEGER + 1])(
    `${method} sequence %j cannot replace the original attempt or close its question`, async sequence => {
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
        await runtime.forwardNotification(method, { ...binding, sequence,
          turn: { id: active.turnId, attemptId: method === 'turn/started' ? 'false-attempt' : 'current',
            status: method === 'turn/started' ? 'running' : 'completed' },
        }, 'local', client)
        expect(runtime.pendingQuestionByKey.has(key)).toBe(true)
        expect(runtime.turnAttemptIds.get(`${taskId}:${active.turnId}`)).toBe('current')
        expect(runtime.activeTurnByTask.has(taskId)).toBe(true)
        await runtime.forwardNotification('turn/completed', { ...binding, sequence: 42,
          turn: { id: active.turnId, attemptId: 'current', status: 'completed' },
        }, 'local', client)
        expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
        expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
        expect(runtime.tasks.get(taskId)?.running).toBe(false)
      } finally { await runtime.dispose() }
    }
  )
}
