import { afterEach, expect, test, vi } from 'vitest'
import { GatewayRuntimeCore } from './gateway/runtime/core'
import { FakeGatewayClient } from './gatewayRuntime.test-support'
import { computerUseStates } from './computerUseState'
const runtimes: GatewayRuntimeCore[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.disposeAsync()))
})
test('projects only the bound client and turn, and treats missing cleanup receipts as unknown', async () => {
  const client = new FakeGatewayClient('desktop')
  const runtime = new GatewayRuntimeCore('token', {
    loadServers: async () => [
      { id: 'local', label: 'local', transport: 'local', workspacePath: '/workspace' },
    ],
    createClient: () => client,
  })
  runtimes.push(runtime)
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'desktop-task',
    executionRequest: { prompt: 'test' },
  })) as { taskId: string }
  const params = {
    threadId: 'desktop',
    turnId: 'desktop-turn',
    target: 'local_windows_desktop',
    state: 'active',
  }
  await runtime.forwardNotification(
    'computerUse/stateChanged',
    params,
    'local',
    new FakeGatewayClient('desktop')
  )
  expect(computerUseStates.get('local', created.taskId)).toBeNull()
  await runtime.forwardNotification(
    'computerUse/stateChanged',
    { ...params, turnId: 'other' },
    'local',
    client
  )
  expect(computerUseStates.get('local', created.taskId)).toBeNull()
  await runtime.forwardNotification('computerUse/stateChanged', params, 'local', client)
  expect(computerUseStates.get('local', created.taskId)?.state).toBe('active')
  await runtime.forwardNotification(
    'turn/completed',
    {
      threadId: 'desktop',
      turnId: 'desktop-turn',
      turn: { id: 'desktop-turn', status: 'completed' },
    },
    'local',
    client
  )
  expect(computerUseStates.get('local', created.taskId)?.state).toBe('unknown')
})

test.each(['disconnect', 'stopped'] as const)(
  'projects %s without conflating transport loss with cleanup',
  async outcome => {
    const client = new FakeGatewayClient('desktop')
    const runtime = new GatewayRuntimeCore('token', {
      loadServers: async () => [
        { id: 'local', label: 'local', transport: 'local', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    runtimes.push(runtime)
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'desktop-task',
      executionRequest: { prompt: 'test' },
    })) as { taskId: string }
    const params = {
      threadId: 'desktop',
      turnId: 'desktop-turn',
      target: 'local_windows_desktop',
      state: 'active',
    }
    await runtime.forwardNotification('computerUse/stateChanged', params, 'local', client)
    if (outcome === 'disconnect') {
      client.close()
      await vi.waitFor(() =>
        expect(computerUseStates.get('local', created.taskId)?.state).toBe('unknown')
      )
    } else {
      for (const state of ['stopping', 'stopped']) {
        await runtime.forwardNotification(
          'computerUse/stateChanged',
          { ...params, state },
          'local',
          client
        )
        expect(computerUseStates.get('local', created.taskId)?.state).toBe(state)
      }
      await runtime.forwardNotification(
        'turn/completed',
        {
          threadId: 'desktop',
          turnId: 'desktop-turn',
          turn: { id: 'desktop-turn', status: 'completed' },
        },
        'local',
        client
      )
      expect(computerUseStates.get('local', created.taskId)?.state).toBe('stopped')
    }
  }
)
