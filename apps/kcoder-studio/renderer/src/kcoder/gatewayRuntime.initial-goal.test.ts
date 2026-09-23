import { describe, expect, test } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('initial goals reach the runtime', RuntimeClass => {
  test.each(['standard', 'strict'])(
    'creates the %s goal before starting the first turn',
    async mode => {
      const client = new FakeGatewayClient('goal-thread')
      const runtime = new RuntimeClass('token', {
        loadServers: async () => [
          { id: 'local', label: 'Local', transport: 'local', workspacePath: '/workspace' },
        ],
        createClient: () => client,
      })
      try {
        await runtime.request('runtime.tasks.create', {
          taskId: 'initial-goal',
          initialGoal: { objective: 'Finish the fixture', mode, tokenBudget: 2000 },
          executionRequest: { prompt: 'Finish the fixture' },
        })
        const goal = client.requests.findIndex(request => request.method === 'thread/goal/set')
        const turn = client.requests.findIndex(request => request.method === 'turn/start')
        expect(goal).toBeGreaterThanOrEqual(0)
        expect(goal).toBeLessThan(turn)
        expect(client.requests[goal].params).toMatchObject({
          threadId: 'goal-thread',
          objective: 'Finish the fixture',
          mode,
          tokenBudget: 2000,
        })
      } finally {
        await runtime.dispose()
      }
    }
  )

  test('failed goal initialization does not start an ordinary turn or leave a fake active goal', async () => {
    const client = new FakeGatewayClient('failed-goal')
    const request = client.request.bind(client)
    client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
      if (method === 'thread/goal/set') throw new Error('Goal configuration rejected')
      return request<T>(method, params)
    }
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    try {
      await expect(
        runtime.request('runtime.tasks.create', {
          initialGoal: { objective: 'Goal' },
          executionRequest: { prompt: 'Goal' },
        })
      ).rejects.toThrow('Goal configuration rejected')
      expect(client.requests.some(request => request.method === 'turn/start')).toBe(false)
      expect(client.requests).toContainEqual({
        method: 'thread/delete',
        params: { threadId: 'failed-goal' },
      })
      expect(client.closed).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
