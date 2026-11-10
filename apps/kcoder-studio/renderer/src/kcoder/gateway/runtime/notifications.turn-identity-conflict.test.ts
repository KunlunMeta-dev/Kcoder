import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

for (const kind of ['question', 'approval'] as const) {
  test.each(['turn/started', 'turn/completed'])(`${kind}: conflicting %s aliases preserve the original task and input`, async method => {
    const threadId = 'original-thread'
    const client = new FakeGatewayClient(threadId)
    const runtime = new KCoderGatewayRuntime('token', {
      loadServers: async () => [localGatewayServer()], createClient: () => client,
    })
    try {
      const { taskId } = await runtime.request('runtime.tasks.create', {
        executionRequest: { prompt: 'original input' },
      }) as { taskId: string }
      const active = runtime.activeTurnByTask.get(taskId)!
      const binding = { threadId, turnId: active.turnId, appServerEpoch: 'epoch' }
      await runtime.forwardServerRequest(client, { id: 41, method: `${kind}/request`, params: {
        ...binding, [`${kind}Id`]: 'original',
        ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
          : { action: { type: 'command', command: 'echo fixture' } }),
      } }, 'local')
      const key = `${taskId}\0${41}`
      const pending = runtime.pendingQuestionByKey.get(key)!
      expect(pending).toBeDefined()
      const terminal = { ...binding, sequence: 42,
        turn: { id: active.turnId, status: 'completed' } }
      await runtime.forwardNotification(method, {
        ...terminal, attemptId: 'foreign-attempt', turn: { id: 'peer-turn', status: 'completed' },
      }, 'local', client)
      expect(runtime.pendingQuestionByKey.get(key)).toBe(pending)
      expect(runtime.activeTurnByTask.get(taskId)).toBe(active)
      expect(runtime.tasks.get(taskId)?.running).toBe(true)
      // The real terminal must retain its replay identity and settle once.
      const complete = vi.spyOn(active, 'complete')
      await runtime.forwardNotification('turn/completed', terminal, 'local', client)
      expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
      expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
      expect(complete).toHaveBeenCalledOnce()
      await runtime.forwardNotification('turn/completed', terminal, 'local', client)
      expect(complete).toHaveBeenCalledOnce()
    } finally {
      await runtime.dispose()
    }
  })
}
