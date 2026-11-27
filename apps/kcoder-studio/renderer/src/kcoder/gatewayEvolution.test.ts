import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { GatewayRpcError } from './gatewayRpc'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'

const runtimes = new Set<KCoderGatewayRuntime>()
function fixture(capable = true, threadId: string | null = null) {
  const server = {
    id: 'remote',
    label: 'Remote',
    description: '',
    transport: 'ssh' as const,
    host: 'owned.test',
    workspacePath: '/default',
  }
  const client = new FakeGatewayClient(threadId)
  const fallback = client.request.bind(client)
  const request = vi
    .spyOn(client, 'request')
    .mockImplementation(async (method, params = {}) =>
      method.startsWith('evolution/') || method.startsWith('settings/evolution/')
        ? { method, params }
        : fallback(method, params)
    )
  const supported = vi
    .spyOn(client, 'supportsExperimental')
    .mockImplementation(name => capable && ['selfEvolutionV1', 'threadResidencyV1'].includes(name))
  const runtime = new KCoderGatewayRuntime('owned-test-token', {
    loadServers: async () => [server],
    createClient: () => client,
  })
  runtimes.add(runtime)
  return { runtime, request, supported, client }
}
beforeEach(() => {
  localStorage.clear()
  installTestTransport(() => undefined)
})
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.disposeAsync()))
  runtimes.clear()
  vi.restoreAllMocks()
  clearTestTransports()
})

test('reports the capability without sending an evolution request', async () => {
  const { runtime, request } = fixture()
  await expect(runtime.request('runtime.evolution.supports', { serverId: 'remote' })).resolves.toEqual({
    supported: true,
  })
  expect(request.mock.calls.some(([method]) => method.startsWith('evolution/'))).toBe(false)
  const absent = fixture(false)
  await expect(absent.runtime.request('runtime.evolution.supports', { serverId: 'remote' })).resolves.toEqual({
    supported: false,
  })
})

test('forwards allow-listed methods and settings only after observing selfEvolutionV1', async () => {
  const { runtime, request } = fixture()
  await expect(
    runtime.request('runtime.evolution.request', {
      serverId: 'remote',
      method: 'evolution/status',
      params: { workspace: '/repo' },
    })
  ).resolves.toEqual({ method: 'evolution/status', params: { workspace: '/repo' } })
  await runtime.request('runtime.settings.request', {
    serverId: 'remote',
    method: 'settings/evolution/save',
    params: { settings: { enabled: true }, expectedRevision: 'rev-1' },
  })
  expect(request.mock.calls.find(([method]) => method === 'settings/evolution/save')?.[1]).toEqual({
    settings: { enabled: true },
    expectedRevision: 'rev-1',
  })
  const before = request.mock.calls.length
  await expect(
    runtime.request('runtime.evolution.request', { serverId: 'remote', method: 'thread/start', params: {} })
  ).rejects.toThrow('EVOLUTION_INVALID_REQUEST')
  await expect(
    runtime.request('runtime.settings.request', {
      serverId: 'remote',
      method: 'settings/evolution/save',
      params: { settings: { enabled: true } },
    })
  ).rejects.toThrow('EVOLUTION_INVALID_REQUEST')
  expect(request.mock.calls.length).toBe(before)
})

test('an older target is diagnosed as unsupported before any evolution request', async () => {
  const { runtime, request } = fixture(false)
  await expect(
    runtime.request('runtime.settings.request', {
      serverId: 'remote',
      method: 'settings/evolution/read',
      params: {},
    })
  ).rejects.toMatchObject({ data: { kind: 'evolution_unsupported', capability: 'selfEvolutionV1' } })
  expect(request.mock.calls.some(([method]) => method.includes('evolution'))).toBe(false)
})

test('ratings require the original task and never accept a caller-supplied thread', async () => {
  const { runtime } = fixture()
  await expect(
    runtime.request('runtime.evolution.request', {
      serverId: 'remote',
      method: 'evolution/rate',
      params: { turnId: 't', rating: 'up' },
    })
  ).rejects.toThrow('EVOLUTION_TASK_REQUIRED')
  await expect(
    runtime.request('runtime.evolution.request', {
      serverId: 'remote',
      taskId: 'task-1',
      method: 'evolution/rate',
      params: { turnId: 't', rating: 'up', threadId: 'other-thread' },
    })
  ).rejects.toThrow('EVOLUTION_INVALID_REQUEST')
})

test('a child rating refused before admission resumes the same parent and retries once', async () => {
  const { runtime, request, client } = fixture(true, 'rating-parent-thread')
  const created = await runtime.request('runtime.tasks.create', {
    taskId: 'rating-parent',
    deviceId: 'remote',
    executionRequest: { prompt: 'Owned fixture task' },
  }) as { taskId: string }
  const threadId = runtime.tasks.get(created.taskId)!.threadId
  const params = { turnId: 'turn-1', rating: 'up', subagentId: 'child-1', threadId }
  const notResident = new GatewayRpcError('evicted', -32027, { threadId, reason: 'capacity' }, 'runtime-session', 'remote')
  request.mockClear()
  request.mockRejectedValueOnce(notResident)
    .mockResolvedValueOnce({ thread: { id: threadId } })
    .mockResolvedValueOnce({ recorded: true })
  const rate = () => runtime.request('runtime.evolution.request', {
    serverId: 'remote',
    taskId: created.taskId,
    method: 'evolution/rate',
    params: { turnId: 'turn-1', rating: 'up', subagentId: 'child-1' },
  })
  await expect(rate()).resolves.toEqual({ recorded: true })
  expect(request.mock.calls.map(([method, fields]) => [method, fields])).toEqual([
    ['evolution/rate', params],
    ['thread/resume', { threadId }],
    ['evolution/rate', params],
  ])
  expect(runtime.clientByTask.get(created.taskId)).toBe(client)

  request.mockClear()
  request.mockRejectedValueOnce(new Error('Unknown outcome'))
  await expect(rate()).rejects.toThrow('Unknown outcome')
  expect(request.mock.calls.map(([method]) => method)).toEqual(['evolution/rate'])
})
