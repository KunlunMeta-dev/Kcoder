import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

for (const kind of ['question', 'approval'] as const) {
  test(`FEFF attempt completion releases the original ${kind}`, async () => {
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
      await runtime.forwardServerRequest(client, { id: 41, method: `${kind}/request`, params: {
        ...binding, [`${kind}Id`]: 'original',
        ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
          : { action: { type: 'command', command: 'echo fixture' } }),
      } }, 'local')
      const key = `${taskId}\0${41}`, complete = vi.spyOn(active, 'complete')
      expect(runtime.pendingQuestionByKey.has(key)).toBe(true)
      const terminal = { ...binding, sequence: 42,
        turn: { id: active.turnId, attemptId: '\uFEFF', status: 'completed' } }
      await runtime.forwardNotification('turn/completed', terminal, 'local', client)
      expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
      expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
      expect(complete).toHaveBeenCalledOnce()
      await runtime.forwardNotification('turn/completed', terminal, 'local', client)
      expect(complete).toHaveBeenCalledOnce()
    } finally { await runtime.dispose() }
  })
}


for (const [current, stale] of [['current', '\uFEFF'], ['\uFEFF', 'old']]) {
  test(`FEFF remains an exact attempt identity (${JSON.stringify([current, stale])})`, async () => {
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
      await runtime.forwardNotification('turn/started', { ...binding, sequence: 40,
        turn: { id: active.turnId, attemptId: current, status: 'running' },
      }, 'local', client)
      expect(runtime.turnAttemptIds.get(`${taskId}:${active.turnId}`)).toBe(current)
      await runtime.forwardServerRequest(client, { id: 41, method: 'question/request', params: {
        ...binding, questionId: 'original', questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
      } }, 'local')
      const key = `${taskId}\0${41}`, complete = vi.spyOn(active, 'complete')
      await runtime.forwardNotification('turn/completed', { ...binding, sequence: 42,
        turn: { id: active.turnId, attemptId: stale, status: 'completed' },
      }, 'local', client)
      expect(runtime.pendingQuestionByKey.has(key)).toBe(true)
      expect(complete).not.toHaveBeenCalled()
      await runtime.forwardNotification('turn/completed', { ...binding, sequence: 43,
        turn: { id: active.turnId, attemptId: current, status: 'completed' },
      }, 'local', client)
      expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
      expect(complete).toHaveBeenCalledOnce()
    } finally { await runtime.dispose() }
  })
}
