import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('authoritative sidebar pinning', RuntimeClass => {
  test('rejects forged root routing and old server root pin capabilities', async () => {
    const client = new FakeGatewayClient(null)
    vi.spyOn(client, 'supportsExperimental').mockReturnValue(false)
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      await expect(
        runtime.request('runtime.sidebar.projects.pin', {
          deviceId: 'local',
          projectKey: '/other',
          rootProject: true,
          pinned: false,
        })
      ).rejects.toThrow('owned by the gateway')
      await expect(
        runtime.request('runtime.sidebar.projects.pin', {
          deviceId: 'local',
          projectKey: 'runtime-target:local',
          pinned: false,
        })
      ).rejects.toThrow('Upgrade')
      expect(
        client.requests.some(request => request.method === 'runtime.sidebar.projects.pin')
      ).toBe(false)
    } finally {
      runtime.dispose()
    }
  })
  test('persists the synthetic root/worktree group on its own server and restores it on reload', async () => {
    const pins = new Map([
      ['local', true],
      ['remote', true],
    ])
    const writes = vi.fn()
    const options = {
      loadServers: async () => [
        localGatewayServer(),
        localGatewayServer({ id: 'remote', workspacePath: '/remote' }),
      ],
      createClient: (serverId: string) => {
        const client = new FakeGatewayClient(null)
        const request = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          if (method === 'runtime.sidebar.projects.pin') {
            writes(serverId, params)
            if (params.rootProject !== true) throw new Error('project was not found')
            expect(params.projectKey).toBe(serverId === 'remote' ? '/remote' : '/workspace')
            pins.set(serverId, params.pinned === true)
            return { success: true, accepted: true } as T
          }
          if (method === 'runtime.workspaces.list')
            return { items: [], pinnedTaskIds: [], rootProjectPinned: pins.get(serverId) } as T
          if (method === 'runtime.worktrees.list')
            return {
              items: [
                {
                  path: `${serverId === 'remote' ? '/remote' : '/workspace'}/tree`,
                  state: 'active',
                  worktreeId: 'fixture',
                },
              ],
            } as T
          return request<T>(method, params)
        }
        return client
      },
    }
    const runtime = new RuntimeClass('token', options)
    try {
      await runtime.request('runtime.sidebar.projects.pin', {
        deviceId: 'remote',
        projectKey: 'runtime-target:remote',
        pinned: false,
      })
      expect(writes).toHaveBeenCalledOnce()
      const reader = new RuntimeClass('token', options)
      try {
        const result = (await reader.request('runtime.tasks.list', {})) as {
          workspaces: Array<{ deviceId: string; projectPinned: boolean }>
        }
        expect(
          result.workspaces
            .filter(item => item.deviceId === 'remote')
            .every(item => item.projectPinned === false)
        ).toBe(true)
        expect(
          result.workspaces
            .filter(item => item.deviceId === 'local')
            .every(item => item.projectPinned === true)
        ).toBe(true)
      } finally {
        reader.dispose()
      }
    } finally {
      runtime.dispose()
    }
  })
})
