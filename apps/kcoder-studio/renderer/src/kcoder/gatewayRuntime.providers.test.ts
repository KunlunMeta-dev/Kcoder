import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'

class ProviderClient extends FakeGatewayClient {
  override async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'runtime.providers.discoverModels') {
      this.requests.push({ method, params })
      return { models: ['Owned-Model'] } as T
    }
    if (method === 'runtime.providers.templates') {
      this.requests.push({ method, params })
      return { templates: [{ id: 'fixture-template' }] } as T
    }
    if (method === 'runtime.providers.validate') {
      this.requests.push({ method, params })
      return { valid: true } as T
    }
    if (method === 'runtime.providers.delete') {
      this.requests.push({ method, params })
      if (params.confirm !== true)
        throw new Error('Provider deletion requires explicit confirmation')
      return { profiles: [], restartRequired: true } as T
    }
    if (method === 'runtime.providers.list' || method === 'runtime.providers.upsert') {
      this.requests.push({ method, params })
      return { profiles: [], restartRequired: method.endsWith('upsert') } as T
    }
    return super.request<T>(method, params)
  }
}

describe.each([Runtime, InstalledRuntime])('target-owned provider configuration', RuntimeClass => {
  test('draft discovery needs no model and cannot fall back to an unsupported target', async () => {
    const client = new ProviderClient(null)
    const capability = vi
      .spyOn(client, 'supportsExperimental')
      .mockImplementation(name => name !== 'providerModelDiscoveryV1')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    const request = {
      serverId: 'remote',
      method: 'runtime.providers.discoverModels',
      params: {
        endpoint: 'https://owned.invalid/v1',
        apiFormat: 'openai_chat_completions',
        apiKey: 'fixture',
      },
    }
    try {
      await expect(runtime.request('runtime.providers.request', request)).rejects.toThrow(
        'provider_discovery_unsupported'
      )
      expect(client.requests.some(item => item.method === request.method)).toBe(false)
      capability.mockImplementation(() => true)
      await runtime.request('runtime.providers.request', request)
      expect(client.requests).toContainEqual({ method: request.method, params: request.params })
      expect(
        client.requests.some(item =>
          ['runtime.providers.upsert', 'turn/start'].includes(item.method)
        )
      ).toBe(false)
    } finally {
      runtime.dispose()
    }
  })
  test('does not silently discard capability edits on an old server', async () => {
    const client = new ProviderClient(null)
    vi.spyOn(client, 'supportsExperimental').mockImplementation(
      capability => capability !== 'providerModelCapabilities'
    )
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    try {
      await expect(
        runtime.request('runtime.providers.request', {
          serverId: 'remote',
          method: 'runtime.providers.upsert',
          params: { capabilities: { tools: false } },
        })
      ).rejects.toThrow()
      expect(client.requests.some(request => request.method === 'runtime.providers.upsert')).toBe(
        false
      )
    } finally {
      runtime.dispose()
    }
  })
  test('loads templates from the target and avoids unsupported RPCs on old servers', async () => {
    const client = new ProviderClient(null)
    const support = vi.spyOn(client, 'supportsExperimental').mockReturnValue(true)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    try {
      const request = { serverId: 'remote', method: 'runtime.providers.templates', params: {} }
      await expect(runtime.request('runtime.providers.request', request)).resolves.toEqual({
        templates: [{ id: 'fixture-template' }],
        supportsAuthenticationPolicy: true,
      })
      const count = client.requests.length
      support.mockImplementation(capability => capability !== 'providerTemplates')
      await expect(runtime.request('runtime.providers.request', request)).resolves.toEqual({
        templates: [],
        supportsAuthenticationPolicy: true,
      })
      expect(client.requests.length).toBe(count)
    } finally {
      runtime.dispose()
    }
  })
  test('gates authentication policy and keeps old API-key requests wire-compatible', async () => {
    const client = new ProviderClient(null)
    const support = vi.spyOn(client, 'supportsExperimental').mockReturnValue(true)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    const upsert = (params: Record<string, unknown>) =>
      runtime.request('runtime.providers.request', {
        serverId: 'local',
        method: 'runtime.providers.upsert',
        params,
      })
    try {
      await upsert({ id: 'local-model', authentication: { mode: 'none' } })
      expect(client.requests.at(-1)?.params).toEqual({
        id: 'local-model',
        authentication: { mode: 'none' },
      })
      support.mockImplementation(capability => capability !== 'providerAuthenticationPolicy')
      const count = client.requests.length
      await expect(upsert({ id: 'local-model', authentication: { mode: 'none' } })).rejects.toThrow(
        '升级'
      )
      expect(client.requests.length).toBe(count)
      await upsert({ id: 'custom', authentication: { mode: 'api_key' }, apiKey: 'fixture-secret' })
      expect(client.requests.at(-1)?.params).toEqual({ id: 'custom', apiKey: 'fixture-secret' })
      await expect(
        runtime.request('runtime.providers.request', {
          serverId: 'local',
          method: 'runtime.providers.templates',
          params: {},
        })
      ).resolves.toMatchObject({ supportsAuthenticationPolicy: false })
    } finally {
      runtime.dispose()
    }
  })
  test('refuses unvalidated saves on older servers while retaining readonly access', async () => {
    const client = new ProviderClient(null)
    vi.spyOn(client, 'supportsExperimental').mockImplementation(
      capability => capability !== 'providerConnectionValidation'
    )
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/workspace' },
      ],
      createClient: () => client,
    })
    try {
      await expect(
        runtime.request('runtime.providers.request', {
          serverId: 'local',
          method: 'runtime.providers.upsert',
          params: {},
        })
      ).rejects.toThrow('连通性验证')
      expect(client.requests.some(request => request.method === 'runtime.providers.upsert')).toBe(
        false
      )
      await expect(
        runtime.request('runtime.providers.request', {
          serverId: 'local',
          method: 'runtime.providers.list',
          params: {},
        })
      ).resolves.toMatchObject({ profiles: [] })
    } finally {
      runtime.dispose()
    }
  })
  test('deletes only the selected target with exact explicit options and no automatic restart', async () => {
    const local = new ProviderClient(null)
    const remote = new ProviderClient(null)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/local' },
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/remote' },
      ],
      createClient: serverId => (serverId === 'remote' ? remote : local),
    })
    const params = {
      id: 'custom',
      confirm: true,
      replacementProvider: 'backup',
      removeCredentials: true,
    }
    try {
      await expect(
        runtime.request('runtime.providers.request', {
          serverId: 'remote',
          method: 'runtime.providers.delete',
          params,
        })
      ).resolves.toMatchObject({ restartRequired: true })
      expect(
        remote.requests.filter(request => request.method === 'runtime.providers.delete')
      ).toEqual([{ method: 'runtime.providers.delete', params }])
      expect(local.requests.some(request => request.method === 'runtime.providers.delete')).toBe(
        false
      )
      expect(
        [...remote.requests, ...local.requests].some(
          request => request.method === 'gateway/app-server/restart'
        )
      ).toBe(false)
      expect(remote.closed).toBe(false)
      expect(local.closed).toBe(false)
      for (const serverId of [undefined, 'missing-target']) {
        await expect(
          runtime.request('runtime.providers.request', {
            serverId,
            method: 'runtime.providers.delete',
            params,
          })
        ).rejects.toThrow()
      }
      expect(
        remote.requests.filter(request => request.method === 'runtime.providers.delete')
      ).toHaveLength(1)
    } finally {
      runtime.dispose()
    }
  })

  test('requires the independent deletion capability even on a configurable target', async () => {
    const client = new ProviderClient(null)
    vi.spyOn(client, 'supportsExperimental').mockImplementation(
      capability => capability !== 'providerDeletion'
    )
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/remote' },
      ],
      createClient: () => client,
    })
    try {
      await expect(
        runtime.request('runtime.providers.request', {
          serverId: 'remote',
          method: 'runtime.providers.delete',
          params: { id: 'custom', confirm: true },
        })
      ).rejects.toThrow('删除 API 配置')
      expect(client.requests.some(request => request.method === 'runtime.providers.delete')).toBe(
        false
      )
      await expect(
        runtime.request('runtime.providers.request', {
          serverId: 'remote',
          method: 'runtime.providers.list',
          params: {},
        })
      ).resolves.toMatchObject({ profiles: [] })
    } finally {
      runtime.dispose()
    }
  })

  test('never synthesizes deletion confirmation and propagates the target refusal', async () => {
    const client = new ProviderClient(null)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/local' },
      ],
      createClient: () => client,
    })
    try {
      for (const params of [{ id: 'custom' }, { id: 'custom', confirm: false }]) {
        await expect(
          runtime.request('runtime.providers.request', {
            serverId: 'local',
            method: 'runtime.providers.delete',
            params,
          })
        ).rejects.toThrow('explicit confirmation')
        expect(client.requests.at(-1)).toEqual({ method: 'runtime.providers.delete', params })
      }
      expect(client.requests.some(request => request.method === 'gateway/app-server/restart')).toBe(
        false
      )
    } finally {
      runtime.dispose()
    }
  })

  test('writes only to the selected target and never persists credentials in the renderer', async () => {
    const local = new ProviderClient(null)
    const remote = new ProviderClient(null)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/local' },
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/remote' },
      ],
      createClient: serverId => (serverId === 'remote' ? remote : local),
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    await runtime.request('runtime.providers.request', {
      serverId: 'remote',
      method: 'runtime.providers.upsert',
      params: { id: 'custom', apiKey: 'fixture-secret' },
    })
    expect(remote.requests).toContainEqual({
      method: 'runtime.providers.upsert',
      params: { id: 'custom', apiKey: 'fixture-secret' },
    })
    expect(local.requests.some(request => request.method === 'runtime.providers.upsert')).toBe(
      false
    )
    expect(
      setItem.mock.calls.some(call => call.some(value => String(value).includes('fixture-secret')))
    ).toBe(false)
    await expect(
      runtime.request('runtime.providers.request', {
        serverId: 'unknown',
        method: 'runtime.providers.list',
      })
    ).rejects.toThrow()
    await expect(
      runtime.request('runtime.providers.request', { method: 'runtime.providers.list' })
    ).rejects.toThrow('target is required')
    await expect(
      runtime.request('runtime.providers.request', { serverId: 'remote', method: 'turn/start' })
    ).rejects.toThrow('Unsupported')
    runtime.dispose()
    setItem.mockRestore()
  })

  test('rejects an in-flight provider mutation when the selected target identity changes without replaying it', async () => {
    let workspacePath = '/before'
    let finishOldMutation!: (value: unknown) => void
    let mutationStarted = false
    let clientsCreated = 0
    const oldClient = new ProviderClient(null)
    const replacementClient = new ProviderClient(null)
    const originalRequest = oldClient.request.bind(oldClient)
    vi.spyOn(oldClient, 'request').mockImplementation(
      async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        if (method === 'runtime.providers.upsert') {
          oldClient.requests.push({ method, params })
          mutationStarted = true
          return new Promise(resolve => {
            finishOldMutation = value => resolve(value as T)
          })
        }
        return originalRequest<T>(method, params)
      }
    )
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [{ id: 'local', label: 'Local', transport: 'local', workspacePath }],
      createClient: () => (++clientsCreated === 1 ? oldClient : replacementClient),
    })
    try {
      const pending = runtime.request('runtime.providers.request', {
        serverId: 'local',
        method: 'runtime.providers.upsert',
        params: { id: 'fixture-provider', validateConnection: false },
      })
      const rejected = expect(pending).rejects.toThrow('target changed')
      await vi.waitFor(() => expect(mutationStarted).toBe(true))
      workspacePath = '/after'
      window.dispatchEvent(new Event('kcoder:servers-changed'))
      finishOldMutation({ profiles: [], restartRequired: true })
      await rejected
      expect(
        oldClient.requests.filter(item => item.method === 'runtime.providers.upsert')
      ).toHaveLength(1)
      expect(
        replacementClient.requests.some(item => item.method === 'runtime.providers.upsert')
      ).toBe(false)
      expect(clientsCreated).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('rejects old target capabilities instead of acknowledging a configuration no-op', async () => {
    const client = new ProviderClient(null)
    vi.spyOn(client, 'supportsExperimental').mockReturnValue(false)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/local' },
      ],
      createClient: () => client,
    })
    await expect(
      runtime.request('runtime.providers.request', {
        serverId: 'local',
        method: 'runtime.providers.list',
        params: {},
      })
    ).rejects.toThrow('升级')
    expect(client.requests.some(request => request.method === 'runtime.providers.list')).toBe(false)
    runtime.dispose()
  })

  test('applies only the selected target without force', async () => {
    const clients: Array<{ serverId: string; client: FakeGatewayClient }> = []
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/local' },
        { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/remote' },
      ],
      createClient: serverId => {
        const client = new ProviderClient(null)
        clients.push({ serverId, client })
        return client
      },
    })
    for (const serverId of ['local', 'remote'])
      await runtime.request('runtime.providers.request', {
        serverId,
        method: 'runtime.providers.list',
        params: {},
      })
    await expect(
      runtime.request('runtime.providers.restart', { serverId: 'remote', force: true })
    ).resolves.toMatchObject({ restarted: true })
    const restarts = clients.flatMap(({ serverId, client }) =>
      client.requests
        .filter(request => request.method === 'gateway/app-server/restart')
        .map(request => ({ serverId, params: request.params }))
    )
    expect(restarts).toEqual([{ serverId: 'remote', params: { confirm: true, force: false } }])
    expect(clients.find(item => item.serverId === 'local')?.client.closed).toBe(false)
    runtime.dispose()
  })

  test('does not stop the target if saved provider preflight fails', async () => {
    const client = new ProviderClient(null)
    const original = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(
      async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
        if (method === 'runtime.providers.validate') throw new Error('Missing API credentials')
        return original<T>(method, params)
      }
    )
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/local' },
      ],
      createClient: () => client,
    })
    await expect(
      runtime.request('runtime.providers.restart', { serverId: 'local' })
    ).rejects.toThrow('Missing API credentials')
    expect(client.requests.some(request => request.method === 'gateway/app-server/restart')).toBe(
      false
    )
    expect(client.closed).toBe(false)
    runtime.dispose()
  })
})
