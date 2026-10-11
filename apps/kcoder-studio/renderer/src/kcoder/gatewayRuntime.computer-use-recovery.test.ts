import { expect, test } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'
import { computerUseStates } from './computerUseState'

async function fixture() {
  const client = new FakeGatewayClient('desktop')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'desktop-task',
    executionRequest: { prompt: 'test' },
  })) as { taskId: string }
  computerUseStates.apply(runtime, 'local', created.taskId, 'desktop-turn', {
    state: 'stop_failed',
    target: 'local_windows_desktop',
    recoveryAvailable: true,
    diagnostic: {
      authorization: 'valid',
      channel: 'unavailable',
      cleanup: 'unknown',
      failureCode: 'connection_lost',
    },
  })
  return { client, runtime, taskId: created.taskId }
}

test('recover uses the original resident client and sends only previous control identity', async () => {
  const { client, runtime, taskId } = await fixture()
  const original = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method === 'computerUse/recover') {
      client.requests.push({ method, params })
      return {
        threadId: 'desktop',
        previousTurnId: 'desktop-turn',
        turnId: 'recovered-turn',
        status: 'completed',
      } as T
    }
    return original<T>(method, params)
  }
  await runtime.request('runtime.computerUse.recover', {
    serverId: 'local',
    taskId,
    previousTurnId: 'desktop-turn',
    approved: true,
    input: ['unknown click'],
  })
  expect(client.requests.filter(request => request.method === 'computerUse/recover')).toEqual([
    {
      method: 'computerUse/recover',
      params: { threadId: 'desktop', previousTurnId: 'desktop-turn' },
    },
  ])
  expect(runtime.tasks.get(taskId)?.running).toBe(false)
})

test('revoke prevents later recover and does not infer worker cleanup', async () => {
  const { client, runtime, taskId } = await fixture()
  const original = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method === 'computerUse/revoke') {
      client.requests.push({ method, params })
      return { revoked: true } as T
    }
    return original<T>(method, params)
  }
  await runtime.request('runtime.computerUse.revoke', { serverId: 'local', taskId })
  expect(computerUseStates.get('local', taskId)?.diagnostic).toMatchObject({
    authorization: 'revoked',
    cleanup: 'unknown',
  })
  await expect(
    runtime.request('runtime.computerUse.recover', {
      serverId: 'local',
      taskId,
      previousTurnId: 'desktop-turn',
    })
  ).rejects.toThrow('not authorized')
  expect(client.requests.some(request => request.method === 'computerUse/recover')).toBe(false)
})

test('foreign target and stale previous control turn are rejected before RPC', async () => {
  const { client, runtime, taskId } = await fixture()
  for (const params of [
    { serverId: 'other', previousTurnId: 'desktop-turn' },
    { serverId: 'local', previousTurnId: 'stale' },
  ]) {
    await expect(
      runtime.request('runtime.computerUse.recover', { taskId, ...params })
    ).rejects.toThrow()
  }
  expect(client.requests.some(request => request.method === 'computerUse/recover')).toBe(false)
})
