import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

for (const method of ['turn/started', 'turn/completed']) {
  test(`${method}: malformed params preserve the original question and valid terminal`, async () => {
    const client = new FakeGatewayClient('original-thread')
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()], createClient: () => client,
    })
    try {
      const { taskId } = await runtime.request('runtime.tasks.create', {
        executionRequest: { prompt: 'original input' },
      }) as { taskId: string }
      const active = runtime.activeTurnByTask.get(taskId)!
      const binding = { threadId: 'original-thread', turnId: active.turnId, appServerEpoch: 'epoch' }
      await runtime.forwardServerRequest(client, { id: 41, method: 'question/request', params: {
        ...binding, questionId: 'original', questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
      } }, 'local')
      const key = `${taskId}\0${41}`, pending = runtime.pendingQuestionByKey.get(key)!
      expect(pending).toBeDefined()
      const complete = vi.spyOn(active, 'complete')
      for (const params of [undefined, null, [], ['legacy'], 'legacy', 7, false]) {
        // Exercise old/direct transports that bypass the current Gateway guard.
        await expect(runtime.forwardNotification(method, params as unknown as Record<string, unknown>,
          'local', client)).resolves.toBeUndefined()
        expect(runtime.pendingQuestionByKey.get(key)).toBe(pending)
        expect(runtime.activeTurnByTask.get(taskId)).toBe(active)
        expect(complete).not.toHaveBeenCalled()
      }
      await runtime.forwardNotification('turn/completed', { ...binding, sequence: 42,
        turn: { id: active.turnId, status: 'completed' } }, 'local', client)
      expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
      expect(complete).toHaveBeenCalledOnce()
    } finally { await runtime.dispose() }
  })
}
