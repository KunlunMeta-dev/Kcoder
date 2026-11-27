import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

for (const kind of ['question', 'approval'] as const) {
  for (const locator of ['outer', 'nested'] as const) {
    test(`${kind}: a delayed ${locator} start cannot replace a finished attempt's retry`, async () => {
      const threadId = 'original-thread', client = new FakeGatewayClient(threadId)
      const runtime = new KCoderGatewayRuntime('token', {
        loadServers: async () => [localGatewayServer()], createClient: () => client,
      })
      try {
        const { taskId } = await runtime.request('runtime.tasks.create', {
          executionRequest: { prompt: 'original input' },
        }) as { taskId: string }
        const turnId = runtime.activeTurnByTask.get(taskId)!.turnId
        const binding = { serverId: 'epoch', threadId, turnId }
        const notify = (method: string, attemptId: string, sequence: number) =>
          runtime.forwardNotification(method, { ...binding, sequence,
            turn: { id: turnId, attemptId, status: method === 'turn/started' ? 'running' : 'completed' },
          }, 'local', client)
        // Recovery can deliver a terminal before the first copy of its old start.
        await notify('turn/completed', 'old', 2)
        await notify('turn/started', 'current', 3)
        await runtime.forwardServerRequest(client, { id: 41, method: `${kind}/request`, params: {
          ...binding, appServerEpoch: 'epoch', [`${kind}Id`]: 'original',
          ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Continue?', options: [] }] }
            : { action: { type: 'command', command: 'echo fixture' } }),
        } }, 'local')
        const key = `${taskId}\0${41}`
        expect(runtime.pendingQuestionByKey.has(key)).toBe(true)
        const active = runtime.activeTurnByTask.get(taskId)!, complete = vi.spyOn(active, 'complete')
        await runtime.forwardNotification('turn/started', { ...binding, sequence: 1,
          ...(locator === 'outer' ? { attemptId: 'old' } : {}),
          turn: { id: turnId, status: 'running', ...(locator === 'nested' ? { attemptId: 'old' } : {}) },
        }, 'local', client)
        expect(runtime.turnAttemptIds.get(`${taskId}:${turnId}`)).toBe('current')
        await notify('turn/completed', 'current', 4)
        expect(runtime.pendingQuestionByKey.has(key)).toBe(false)
        expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
        expect(runtime.tasks.get(taskId)?.running).toBe(false)
        expect(complete).toHaveBeenCalledOnce()
        // A completed attempt cannot reopen the idle task with a new event ID.
        await notify('turn/started', 'current', 5)
        expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
        expect(runtime.turnAttemptIds.has(`${taskId}:${turnId}`)).toBe(false)
        // A distinct retry of the same turn remains valid.
        await notify('turn/started', 'next', 6)
        expect(runtime.turnAttemptIds.get(`${taskId}:${turnId}`)).toBe('next')
        await notify('turn/completed', 'next', 7)
        // A replacement app-server may restore the same turn/attempt identity.
        await runtime.forwardNotification('turn/started', { ...binding, serverId: 'replacement', sequence: 1,
          turn: { id: turnId, attemptId: 'old', status: 'running' },
        }, 'local', client)
        expect(runtime.turnAttemptIds.get(`${taskId}:${turnId}`)).toBe('old')
        expect(client.responses).toEqual([])
        runtime.invalidateAccountTarget('local')
        expect(runtime.completedTurnAttemptKeys.size).toBe(0)
      } finally { await runtime.dispose() }
    })
  }
}
