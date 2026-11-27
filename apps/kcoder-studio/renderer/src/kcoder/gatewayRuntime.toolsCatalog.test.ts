import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { GatewayRpcError } from './gatewayRpc'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'

const KCODER_PRESENTATION = { version: 1, studioWorkMode: 'kcoder', inlineWidgets: true }

// These tests exercise routing and capability boundaries, independent of model output.
describe.each([Runtime, InstalledRuntime])('tools catalog routing', RuntimeClass => {
  test('does not resume historical nonresident tasks just to obtain presentation metadata', async () => {
    const client = new FakeGatewayClient(null)
    client.persistedThreads = [{ id: 'historical', cwd: '/workspace', status: 'idle' }]
    client.threadResumeSupported = true
    vi.spyOn(client, 'supportsExperimental').mockImplementation(capability => capability !== 'threadListCompleteness')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    try {
      await runtime.request('runtime.tasks.list', {})
      await expect(
        runtime.request('runtime.tools.catalog', {
          taskId: 'kcoder:remote:historical',
          serverId: 'remote',
        })
      ).rejects.toThrow('not resident')
      expect(client.requests.some(request => request.method === 'thread/resume')).toBe(false)
    } finally {
      runtime.dispose()
    }
  })
  test('routes resident tools through their task client without changing invocation identity', async () => {
    const client = new FakeGatewayClient('catalog-thread')
    vi.spyOn(client, 'supportsExperimental').mockReturnValue(true)
    const original = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'tools/catalog') {
        client.requests.push({ method, params: params ?? {} })
        return { tools: [{ name: 'exact_tool_id' }] }
      }
      return original(method, params)
    })
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    try {
      await runtime.request('runtime.tasks.create', {
        taskId: 'catalog-task',
        executionRequest: { prompt: 'Fixture for routing only' },
      })
      await expect(
        runtime.request('runtime.tools.catalog', { taskId: 'catalog-task', serverId: 'remote' })
      ).resolves.toEqual({ tools: [{ name: 'exact_tool_id' }] })
      expect(client.requests.at(-1)).toMatchObject({
        method: 'tools/catalog',
        params: { threadId: expect.any(String) },
      })
      await expect(
        runtime.request('runtime.tools.catalog', { taskId: 'catalog-task', serverId: 'wrong' })
      ).rejects.toThrow('does not match')
    } finally {
      runtime.dispose()
    }
  })
  test('recovers a resident catalog when its request beats the eviction notification', async () => {
    const threadId = 'catalog-evicted-thread'
    const client = new FakeGatewayClient(threadId)
    const createClient = vi.fn(() => client)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/workspace' },
      ],
      createClient,
    })
    try {
      const created = await runtime.request('runtime.tasks.create', {
        taskId: 'catalog-evicted',
        executionRequest: { prompt: 'Resident tools' },
      }) as { taskId: string }
      const refused = new GatewayRpcError('evicted', -32027, { threadId, reason: 'capacity' }, 'runtime-session', 'remote')
      const request = vi.spyOn(client, 'request')
        .mockRejectedValueOnce(refused)
        .mockResolvedValueOnce({ thread: { id: threadId } })
        .mockResolvedValueOnce({ tools: [{ name: 'owned_tool' }] })
      const read = () => runtime.request('runtime.tools.catalog', { taskId: created.taskId, serverId: 'remote' })
      await expect(read()).resolves.toEqual({ tools: [{ name: 'owned_tool' }] })
      expect(request.mock.calls).toEqual([
        ['tools/catalog', { threadId, clientPresentation: KCODER_PRESENTATION }],
        ['thread/resume', { threadId }],
        ['tools/catalog', { threadId, clientPresentation: KCODER_PRESENTATION }],
      ])
      expect(createClient).toHaveBeenCalledTimes(1)
      for (const failure of [
        new GatewayRpcError('other thread', -32027, { threadId: 'something-else', reason: 'capacity' }, 'runtime-session', 'remote'),
        new GatewayRpcError('disconnected', -1, undefined, 'runtime-session', 'transport'),
      ]) {
        request.mockClear()
        request.mockRejectedValueOnce(failure)
        await expect(read()).rejects.toBe(failure)
        expect(request.mock.calls.map(([method]) => method)).toEqual(['tools/catalog'])
      }
    } finally {
      await runtime.dispose()
    }
  })
  test('uses the explicit target, gates old servers, and rejects unknown tasks', async () => {
    const client = new FakeGatewayClient(null)
    const support = vi.spyOn(client, 'supportsExperimental').mockReturnValue(true)
    const request = vi.spyOn(client, 'request').mockImplementation(async () => ({ tools: [] }))
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    try {
      await runtime.request('runtime.tools.catalog', { serverId: 'remote' })
      expect(request).toHaveBeenCalledWith('tools/catalog', { clientPresentation: KCODER_PRESENTATION })
      support.mockReturnValue(false)
      request.mockClear()
      await expect(
        runtime.request('runtime.tools.catalog', { serverId: 'remote' })
      ).resolves.toBeNull()
      expect(request).not.toHaveBeenCalled()
      await expect(runtime.request('runtime.tools.catalog', {})).rejects.toThrow()
      await expect(
        runtime.request('runtime.tools.catalog', { taskId: 'missing' })
      ).rejects.toThrow()
    } finally {
      runtime.dispose()
    }
  })
})
