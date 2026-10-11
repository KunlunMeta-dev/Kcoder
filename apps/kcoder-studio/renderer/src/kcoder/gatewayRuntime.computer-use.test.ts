import { expect, test } from 'vitest'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

test('desktop status requires an explicit target and sends no action or authorization', async () => {
  const client = new FakeGatewayClient(null)
  const original = client.request.bind(client)
  client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
    if (method === 'computerUse/status') {
      client.requests.push({ method, params })
      return { availability: 'component_missing', canControl: false } as T
    }
    return original<T>(method, params)
  }
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  await expect(runtime.request('runtime.computerUse.status', {})).rejects.toThrow(
    'target is required'
  )
  await runtime.request('runtime.computerUse.status', { serverId: 'local', enabled: true })
  expect(client.requests).toContainEqual({ method: 'computerUse/status', params: {} })
})

test('older server cannot be reported as desktop ready', async () => {
  const client = new FakeGatewayClient(null)
  client.supportsExperimental = () => false
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  await expect(
    runtime.request('runtime.computerUse.status', { serverId: 'local' })
  ).resolves.toEqual({
    availability: 'unsupported_protocol',
    canControl: false,
  })
  expect(client.requests.some(request => request.method === 'computerUse/status')).toBe(false)
})

test('accepted desktop turn grants only that session; ordinary sends inherit until revoked', async () => {
  const { computerUseConsent } = await import('./computerUseConsent')
  const client = new FakeGatewayClient('consented-thread')
  const runtime = createTestGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  const created = (await runtime.request('runtime.tasks.create', {
    taskId: 'consented-task',
    computerUse: { approved: true, target: 'local_windows_desktop' },
    executionRequest: { prompt: 'first desktop task' },
  })) as { taskId: string }
  expect(computerUseConsent.has('local', created.taskId)).toBe(true)
  const complete = async () => {
    client.emitNotification('turn/completed', {
      threadId: 'consented-thread',
      turnId: 'consented-thread-turn',
      turn: { id: 'consented-thread-turn', status: 'completed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  await complete()
  await runtime.request('runtime.tasks.send', {
    taskId: created.taskId,
    message: 'continue normally',
  })
  expect(client.requests.filter(r => r.method === 'turn/start').at(-1)?.params.computerUse).toEqual(
    { approved: true, target: 'local_windows_desktop', useSessionAuthorization: true }
  )
  await complete()
  computerUseConsent.set('local', created.taskId, false)
  await runtime.request('runtime.tasks.send', { taskId: created.taskId, message: 'ordinary task' })
  expect(
    client.requests.filter(r => r.method === 'turn/start').at(-1)?.params.computerUse
  ).toBeUndefined()
})
