import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('task-list run state ordering', RuntimeClass => {
  test('a fresh failed snapshot retires a phantom active turn and allows archiving', async () => {
    const taskId = 'kcoder:local:failed-list'
    const thread = { id: 'failed-list', cwd: '/workspace', status: 'idle',
      runSummary: { mainTurn: 'idle', latestTurnStatus: 'failed', pendingApprovals: 0,
        pendingQuestions: 0, activeJobs: 0, tasksPending: 0, tasksRunning: 0,
        pendingFollowups: 0, pendingGoals: 0 } }
    const clients: FakeGatewayClient[] = []
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => {
        const client = new FakeGatewayClient(thread.id)
        client.threadResumeSupported = true
        client.persistedThreads = [thread]
        clients.push(client)
        return client
      },
    })
    try {
      await runtime.request('runtime.tasks.list', {})
      runtime.trackActiveTurn(taskId, 'stale-turn')
      runtime.tasks.set(taskId, { ...runtime.tasks.get(taskId)!, running: true, turnStatus: 'inProgress' })
      runtime.pendingTurnStartByTask.add(taskId)
      await runtime.request('runtime.tasks.list', {})
      expect(runtime.tasks.get(taskId)?.running).toBe(true)
      expect(runtime.activeTurnByTask.has(taskId)).toBe(true)
      runtime.pendingTurnStartByTask.delete(taskId)
      await runtime.request('runtime.tasks.list', {})
      expect(runtime.tasks.get(taskId)).toMatchObject({ running: false, turnStatus: 'failed' })
      expect(runtime.activeTurnByTask.has(taskId)).toBe(false)
      await expect(runtime.request('runtime.tasks.archive', { taskId })).resolves.toMatchObject({ accepted: true })
      expect(clients.flatMap(client => client.requests).some(row => row.method === 'turn/interrupt')).toBe(false)
    } finally { await runtime.dispose() }
  })

  test.each(['inProgress', 'failed'] as const)(
    'a delayed list cannot overwrite a newer %s event', async status => {
      const taskId = 'kcoder:local:list-race'
      const summary = { mainTurn: 'idle', pendingApprovals: 0, pendingQuestions: 0,
        activeJobs: 0, tasksPending: 0, tasksRunning: 0, pendingFollowups: 0, pendingGoals: 0 }
      const thread = { id: 'list-race', cwd: '/workspace', status: 'idle', runSummary: summary }
      let pause = false
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const listStarted = vi.fn()
      const runtime = new RuntimeClass('token', {
        loadServers: async () => [localGatewayServer()],
        createClient: () => {
          const client = new FakeGatewayClient(thread.id)
          client.threadResumeSupported = true
          client.persistedThreads = [thread]
          const request = client.request.bind(client)
          client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
            const value = method === 'thread/resume'
              ? { thread: structuredClone(thread) } as T
              : await request<T>(method, params)
            if (method === 'thread/list' && pause) {
              pause = false
              const snapshot = structuredClone(value)
              listStarted()
              await gate
              return snapshot
            }
            return value
          }
          return client
        },
      })
      let refresh: Promise<unknown> | undefined
      try {
        await runtime.request('runtime.tasks.list', {})
        await runtime.request('runtime.tasks.transcript', {
          taskId, deviceId: 'local', threadId: thread.id,
          workspacePath: '/workspace', attachToLiveTurn: true,
        })
        const owner = runtime.clientByTask.get(taskId) as FakeGatewayClient
        let sequence = 1
        const started = () => owner.emitNotification('turn/started', {
          serverId: 'list-server', sequence: sequence++, attemptId: 'live-attempt',
          threadId: thread.id, turnId: 'live-turn', turn: { id: 'live-turn', status: 'running' },
        })
        if (status === 'failed') {
          started()
          await runtime.notificationQueueByClient.get(owner)
          await vi.waitFor(() => expect(runtime.tasks.get(taskId)?.running).toBe(true))
          thread.status = 'running'
          summary.mainTurn = 'running'
        }
        pause = true
        refresh = runtime.request('runtime.tasks.list', {})
        await vi.waitFor(() => expect(listStarted).toHaveBeenCalledOnce())
        if (status === 'inProgress') started()
        else owner.emitNotification('turn/completed', {
          serverId: 'list-server', sequence: sequence++, attemptId: 'live-attempt',
          threadId: thread.id, turnId: 'live-turn', turn: { id: 'live-turn', status: 'failed' },
        })
        await runtime.notificationQueueByClient.get(owner)
        await vi.waitFor(() => expect(runtime.tasks.get(taskId)?.turnStatus).toBe(status))
        release()
        await refresh
        expect(runtime.tasks.get(taskId)).toMatchObject({
          running: status === 'inProgress', turnStatus: status,
          runSummary: { mainTurn: status === 'inProgress' ? 'running' : 'idle' },
        })
        expect(runtime.activeTurnByTask.has(taskId)).toBe(status === 'inProgress')
      } finally {
        release()
        await refresh
        await runtime.dispose()
      }
    }
  )
})
