import { afterEach, expect, test, vi } from 'vitest'
import { registerRuntimeTransport } from '@/lib/runtime-transport'
import { createGatewayIpcHandler } from './gatewayRuntimeInstall'
import { createTestGatewayRuntime, FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'
import { readProviderSettings } from './providerSettings'
import { notifyAccountContextChange } from './accountContextEvents'

class ProviderReadClient extends FakeGatewayClient {
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'runtime.providers.list') {
      this.requests.push({ method, params })
      return { profiles: [], restartRequired: false, supportsRuntimeScope: true } as T
    }
    return super.request<T>(method, params)
  }
}
const stops: (() => void)[] = []
afterEach(() => { while (stops.length) stops.pop()?.() })
function fixture(scoped: boolean) {
  const server = localGatewayServer({ id: 'provider-owner' })
  const client = new ProviderReadClient('owned-thread')
  vi.spyOn(client, 'supportsExperimental').mockImplementation(name => scoped || name !== 'providerRuntimeScopeV1')
  const runtime = createTestGatewayRuntime('owned-provider-read', { loadServers: async () => [server], createClient: () => client })
  const handler = vi.fn(createGatewayIpcHandler(runtime))
  stops.push(registerRuntimeTransport(handler))
  return { server, client, runtime, handler }
}

test('a selected task reads its Native configuration once after Runtime capability negotiation', async () => {
  const f = fixture(true)
  await f.runtime.request('runtime.tasks.create', { deviceId: f.server.id, taskId: 'owned-task', executionRequest: { prompt: 'owned fixture' } })
  const task = [...f.runtime.tasks.values()][0]
  f.client.requests.length = 0; f.handler.mockClear()
  await readProviderSettings(f.server.id, task.taskId)
  expect(f.client.requests.filter(item => item.method === 'runtime.providers.list')).toEqual([
    { method: 'runtime.providers.list', params: { threadId: task.threadId } },
  ])
  expect(f.handler).toHaveBeenCalledTimes(1)
  expect(f.client.requests.some(item => item.method === 'turn/start')).toBe(false)
})

test('a legacy target ignores preferred read context without restoring a cold task, even if list metadata claims support', async () => {
  const f = fixture(false), task = vi.spyOn(f.runtime, 'taskConnection')
  await readProviderSettings(f.server.id, 'unrestored-task')
  expect(task).not.toHaveBeenCalled()
  expect(f.handler).toHaveBeenCalledTimes(1)
  expect(f.client.requests.filter(item => item.method === 'runtime.providers.list')).toEqual([
    { method: 'runtime.providers.list', params: {} },
  ])
})

test('an explicit task constraint cannot fall back to preferred read context', async () => {
  const f = fixture(false)
  const task = vi.spyOn(f.runtime, 'taskConnection').mockRejectedValue(new Error('original task unavailable'))
  await expect(f.runtime.request('runtime.providers.request', { serverId: f.server.id,
    taskId: 'explicit-task', preferredTaskId: 'another-task', method: 'runtime.providers.list', params: {} })).rejects.toThrow('original task unavailable')
  expect(task).toHaveBeenCalledOnce()
  expect(f.client.requests.some(item => item.method === 'runtime.providers.list')).toBe(false)
})

test('read preference cannot relax a mutation task constraint', async () => {
  const f = fixture(false)
  vi.spyOn(f.runtime, 'taskConnection').mockRejectedValue(new Error('original task unavailable'))
  await expect(f.runtime.request('runtime.providers.request', { serverId: f.server.id,
    taskId: 'explicit-task', preferredTaskId: 'another-task', method: 'runtime.providers.upsert', params: { id: 'owned' } })).rejects.toThrow('original task unavailable')
  expect(f.client.requests.some(item => item.method === 'runtime.providers.upsert')).toBe(false)
})

test('an account change during capability negotiation prevents a later provider read', async () => {
  const f = fixture(true)
  let finish!: () => void
  f.client.connectGate = new Promise<void>(resolve => { finish = resolve })
  const connect = vi.spyOn(f.client, 'connect')
  const result = readProviderSettings(f.server.id, 'unrestored-task').then(value => value, error => error)
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
  notifyAccountContextChange(f.server.id)
  finish()
  expect(await result).toBeInstanceOf(Error)
  expect(f.client.requests.some(item => item.method === 'runtime.providers.list')).toBe(false)
})

test('a capable target cannot replace an unavailable preferred task with profile scope', async () => {
  const f = fixture(true)
  const task = vi.spyOn(f.runtime, 'taskConnection').mockRejectedValue(new Error('selected task unavailable'))
  await expect(readProviderSettings(f.server.id, 'missing-task')).rejects.toThrow('selected task unavailable')
  expect(task).toHaveBeenCalledWith({ taskId: 'missing-task', deviceId: f.server.id })
  expect(f.client.requests.some(item => item.method === 'runtime.providers.list')).toBe(false)
})

test('a preference cannot make a read accept another target task connection', async () => {
  const f = fixture(true)
  await f.runtime.request('runtime.tasks.create', { deviceId: f.server.id, taskId: 'owned-task', executionRequest: { prompt: 'owned fixture' } })
  const task = [...f.runtime.tasks.values()][0]
  const original = await f.runtime.taskConnection({ taskId: task.taskId, deviceId: f.server.id })
  vi.spyOn(f.runtime, 'taskConnection').mockResolvedValue({ ...original, server: localGatewayServer({ id: 'another-target' }) })
  f.client.requests.length = 0
  await expect(readProviderSettings(f.server.id, task.taskId)).rejects.toThrow('another target')
  expect(f.client.requests.some(item => item.method === 'runtime.providers.list')).toBe(false)
})
