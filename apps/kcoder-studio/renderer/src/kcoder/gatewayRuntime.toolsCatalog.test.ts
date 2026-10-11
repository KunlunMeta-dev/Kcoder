import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'

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
      expect(request).toHaveBeenCalledWith('tools/catalog', {})
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
