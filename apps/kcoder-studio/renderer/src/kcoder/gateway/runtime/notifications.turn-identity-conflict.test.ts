import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

for (const snapshot of [
  ...[...['running', 'unknown', null, 7].map(status => ({ status })),
    [], ['turn'], 7, false, 'malformed-turn'].map(turn => ({ turn })),
  ...['thread', 'widget'].flatMap(field => [[], 'malformed-task']
    .map(value => ({ [field]: value }))),
]) {
  test(`invalid completion snapshot ${JSON.stringify(snapshot)} preserves original question and replay`, async () => {
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
      await runtime.forwardServerRequest(client, { id: 41, method: 'question/request', params: {
        ...binding, questionId: 'original', questions: [{ id: 'item', prompt: 'Continue?', options: [] }],
      } }, 'local')
      const key = `${taskId}\0${41}`, pending = runtime.pendingQuestionByKey.get(key)!
      expect(pending).toBeDefined()
      const complete = vi.spyOn(active, 'complete')
      await runtime.forwardNotification('turn/completed', { ...binding, sequence: 42,
        ...snapshot,
      }, 'local', client)
      expect(runtime.pendingQuestionByKey.get(key)).toBe(pending)
      expect(runtime.activeTurnByTask.get(taskId)).toBe(active)
      expect(runtime.tasks.get(taskId)?.running).toBe(true)
      expect(complete).not.toHaveBeenCalled()
      await runtime.forwardNotification('turn/completed', { ...binding, sequence: 42,
        turn: { id: active.turnId, status: 'completed' },
      }, 'local', client)
      expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
      expect(complete).toHaveBeenCalledOnce()
    } finally { await runtime.dispose() }
  })
}

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


for (const method of ['turn/started', 'turn/completed']) {
  for (const [outer, nested] of [['current', 'old'], ['old', 'current'], ['\ud800', '\ud800'], ['\udfff', '\udfff']]) {
    test(`invalid or conflicting ${method} attempts ${JSON.stringify([outer, nested])} preserve original input and completion`, async () => {
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
        const key = `${taskId}\0${41}`, pending = runtime.pendingQuestionByKey.get(key)!
        expect(pending).toBeDefined()
        const complete = vi.spyOn(active, 'complete')
        await runtime.forwardNotification(method, { ...binding, sequence: 42, attemptId: outer,
          turn: { id: active.turnId, attemptId: nested, status: method === 'turn/started' ? 'running' : 'completed' },
        }, 'local', client)
        expect(runtime.pendingQuestionByKey.get(key)).toBe(pending)
        expect(runtime.activeTurnByTask.get(taskId)).toBe(active)
        expect(runtime.turnAttemptIds.get(`${taskId}:${active.turnId}`)).toBe('current')
        expect(runtime.tasks.get(taskId)?.running).toBe(true)
        expect(complete).not.toHaveBeenCalled()
        await runtime.forwardNotification('turn/completed', { ...binding, sequence: 42,
          turn: { id: active.turnId, attemptId: 'current', status: 'completed' },
        }, 'local', client)
        expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
        expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
        expect(complete).toHaveBeenCalledOnce()
      } finally { await runtime.dispose() }
    })
  }
}
