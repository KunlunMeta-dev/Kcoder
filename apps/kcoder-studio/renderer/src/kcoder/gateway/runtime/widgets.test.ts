import { expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime } from '../../gatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from '../../gatewayRuntime.test-support'

class WidgetClient extends FakeGatewayClient {
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method.startsWith('widget/')) {
      this.requests.push({ method, params })
      return { accepted: true } as T
    }
    return super.request<T>(method, params)
  }
}

test('widget operations route through their explicit task target and reject mismatched addresses and methods', async () => {
  localStorage.clear()
  const local = new WidgetClient('local-thread'),
    remote = new WidgetClient('remote-thread')
  const runtime = new KCoderGatewayRuntime('token', {
    loadServers: async () => [
      localGatewayServer(),
      { ...localGatewayServer(), id: 'ssh-target', transport: 'ssh' },
    ],
    createClient: id => (id === 'local' ? local : remote),
  })
  try {
    const created = (await runtime.request('runtime.tasks.create', {
      deviceId: 'ssh-target',
      taskId: 'remote',
      executionRequest: { prompt: 'office' },
    })) as { taskId: string }
    const address = { deviceId: 'ssh-target', taskId: created.taskId, workspacePath: '/workspace' }
    await runtime.request('runtime.widgets.request', {
      address,
      method: 'widget/read',
      params: { widgetId: 'w1', revision: 1 },
    })
    expect(remote.requests.at(-1)).toEqual({
      method: 'widget/read',
      params: { widgetId: 'w1', revision: 1, threadId: 'remote-thread' },
    })
    expect(local.requests.some(request => request.method.startsWith('widget/'))).toBe(false)
    const before = remote.requests.length
    for (const request of [
      { address: { ...address, deviceId: 'local' }, method: 'widget/read' },
      { address, method: 'thread/delete' },
      { address, method: 'widget/read', params: { threadId: 'peer-thread' } },
      { address, method: 'widget/render/receipt', params: { widget: { threadId: 'peer-thread' } } },
    ])
      await expect(runtime.request('runtime.widgets.request', request)).rejects.toThrow()
    expect(remote.requests.length).toBe(before)
    await runtime.request('runtime.widgets.request', {
      address,
      method: 'widget/render/receipt',
      params: { widget: { widgetId: 'w1', revision: 1 }, status: 'rendered' },
    })
    expect(remote.requests.at(-1)?.params.widget).toEqual({
      widgetId: 'w1',
      revision: 1,
      threadId: 'remote-thread',
    })
  } finally {
    await runtime.dispose()
  }
})

test('cancelled widget reads do not reach the server', async () => {
  const client = new WidgetClient('widget-thread')
  const runtime = new KCoderGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  try {
    const created = (await runtime.request('runtime.tasks.create', {
      taskId: 'cancel-widget',
      executionRequest: { prompt: 'office' },
    })) as { taskId: string }
    const abort = new AbortController()
    abort.abort()
    await expect(
      runtime.request(
        'runtime.widgets.request',
        { address: { deviceId: 'local', taskId: created.taskId }, method: 'widget/list' },
        { signal: abort.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(client.requests.some(request => request.method.startsWith('widget/'))).toBe(false)
  } finally {
    await runtime.dispose()
  }
})

test('MCP App requests require the same addressed office task and capability on its actual client', async () => {
  class AppClient extends WidgetClient {
    override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method === 'thread/start') {
        this.requests.push({ method, params })
        return {
          thread: { id: 'app-thread', studioWorkMode: params.studioWorkMode ?? 'kcoder' },
        } as T
      }
      if (method.startsWith('mcp/apps/')) {
        this.requests.push({ method, params })
        return { live: false } as T
      }
      return super.request<T>(method, params)
    }
  }
  const client = new AppClient('app-thread')
  const runtime = new KCoderGatewayRuntime('token', {
    loadServers: async () => [localGatewayServer()],
    createClient: () => client,
  })
  try {
    const created = (await runtime.request('runtime.tasks.create', {
      studioWorkMode: 'kworker',
      executionRequest: { prompt: 'office' },
    })) as { taskId: string }
    const address = { deviceId: 'local', taskId: created.taskId }
    await runtime.request('runtime.mcpApps.request', {
      address,
      method: 'mcp/apps/read',
      params: { widgetId: 'app', revision: 1, connectionId: 'original' },
    })
    expect(client.requests.at(-1)).toEqual({
      method: 'mcp/apps/read',
      params: { threadId: 'app-thread', widgetId: 'app', revision: 1, connectionId: 'original' },
    })
    const before = client.requests.length
    await expect(
      runtime.request('runtime.widgets.request', { address, method: 'mcp/apps/toolCall' })
    ).rejects.toThrow()
    await expect(
      runtime.request('runtime.mcpApps.request', {
        address,
        method: 'mcp/apps/read',
        params: { threadId: 'peer' },
      })
    ).rejects.toThrow()
    vi.spyOn(client, 'supportsExperimental').mockImplementation(cap => cap !== 'mcpAppsV1')
    await expect(
      runtime.request('runtime.mcpApps.request', { address, method: 'mcp/apps/read' })
    ).rejects.toThrow('capable native')
    expect(client.requests).toHaveLength(before)
  } finally {
    await runtime.dispose()
  }
})
