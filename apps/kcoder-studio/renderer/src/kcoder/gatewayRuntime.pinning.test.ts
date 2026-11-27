import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('app-server sidebar pinning', RuntimeClass => {
  test('rejects caller-supplied root routing and targets without root pinning support', async () => {
    const client = new FakeGatewayClient(null)
    const supportsExperimental = vi.spyOn(client, 'supportsExperimental').mockReturnValue(false)
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
      expect(supportsExperimental).toHaveBeenCalledWith('sidebarRootPinning')
      expect(
        client.requests.some(request => request.method === 'runtime.sidebar.projects.pin')
      ).toBe(false)
    } finally {
      runtime.dispose()
    }
  })

  test('rejects a synthetic root key that collides with a registered project', async () => {
    const client = new FakeGatewayClient(null)
    const request = client.request.bind(client)
    client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
      if (method === 'runtime.workspaces.list') {
        client.requests.push({ method, params })
        return {
          items: [
            {
              projectKey: 'runtime-target:local',
              workspacePath: '/another-project',
              projectSource: 'legacy_root',
            },
          ],
        } as T
      }
      return request<T>(method, params)
    }
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      await expect(
        runtime.request('runtime.sidebar.projects.pin', {
          deviceId: 'local',
          projectKey: 'runtime-target:local',
          pinned: false,
        })
      ).rejects.toThrow('ambiguous')
      expect(
        client.requests.some(request => request.method === 'runtime.workspaces.list')
      ).toBe(true)
      expect(
        client.requests.some(request => request.method === 'runtime.sidebar.projects.pin')
      ).toBe(false)
    } finally {
      runtime.dispose()
    }
  })

  test('fails closed when the workspace registry response is invalid', async () => {
    const client = new FakeGatewayClient(null)
    client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
      client.requests.push({ method, params })
      return {} as T
    }
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      await expect(
        runtime.request('runtime.sidebar.projects.pin', {
          deviceId: 'local',
          projectKey: 'runtime-target:local',
          pinned: false,
        })
      ).rejects.toThrow('workspace registry is invalid')
      expect(
        client.requests.some(request => request.method === 'runtime.sidebar.projects.pin')
      ).toBe(false)
    } finally {
      runtime.dispose()
    }
  })

  test('shares target pin state across runtime instances and target IDs for the same workspace', async () => {
    const targets = new Map([
      ['local', '/workspace'],
      ['workspace-alias', '/workspace'],
    ])
    const rootPinByWorkspace = new Map([['/workspace', true]])
    const writes = vi.fn()
    const options = {
      loadServers: async () => [
        localGatewayServer(),
        localGatewayServer({ id: 'workspace-alias', label: 'Workspace alias' }),
      ],
      createClient: (serverId: string) => {
        const client = new FakeGatewayClient(null)
        const request = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          const workspacePath = targets.get(serverId)
          if (!workspacePath) throw new Error(`Unknown fixture target: ${serverId}`)
          if (method === 'runtime.sidebar.projects.pin') {
            writes(serverId, params)
            if (params.rootProject !== true || params.projectKey !== workspacePath)
              throw new Error('root project routing did not use the target workspace')
            rootPinByWorkspace.set(workspacePath, params.pinned === true)
            return { success: true, accepted: true, deviceId: serverId } as T
          }
          if (method === 'runtime.workspaces.list') {
            return {
              items: [],
              pinnedTaskIds: [],
              rootProjectPinned: rootPinByWorkspace.get(workspacePath),
            } as T
          }
          if (method === 'runtime.worktrees.list') return { items: [] } as T
          return request<T>(method, params)
        }
        return client
      },
    }

    const writer = new RuntimeClass('token', options)
    try {
      await expect(
        writer.request('runtime.sidebar.projects.pin', {
          deviceId: 'local',
          projectKey: 'runtime-target:local',
          pinned: false,
        })
      ).resolves.toEqual({ success: true, accepted: true, deviceId: 'local' })
      expect(writes).toHaveBeenCalledOnce()
      expect(writes).toHaveBeenCalledWith('local', {
        deviceId: 'local',
        projectKey: '/workspace',
        pinned: false,
        rootProject: true,
      })

      const reader = new RuntimeClass('token', options)
      try {
        const result = (await reader.request('runtime.tasks.list', {})) as {
          workspaces: Array<{ deviceId: string; workspacePath: string; projectPinned: boolean }>
        }
        const rootRows = result.workspaces.filter(item => item.workspacePath === '/workspace')
        expect(rootRows.map(item => item.deviceId).sort()).toEqual(['local', 'workspace-alias'])
        expect(rootRows.every(item => item.projectPinned === false)).toBe(true)
      } finally {
        reader.dispose()
      }
    } finally {
      writer.dispose()
    }
  })

  test('keeps a fresh root pin and reports a worktree read error when cached descriptors exist', async () => {
    let rootProjectPinned = true
    let failWorktreeRead = false
    const worktreeReadError = 'worktree registry unavailable'
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => {
        const client = new FakeGatewayClient(null)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          client.requests.push({ method, params })
          if (method === 'runtime.workspaces.list') {
            return { items: [], pinnedTaskIds: [], rootProjectPinned } as T
          }
          if (method === 'runtime.worktrees.list') {
            if (failWorktreeRead) throw new Error(worktreeReadError)
            return {
              items: [{ path: '/workspace/tree', state: 'active', worktreeId: 'fixture' }],
            } as T
          }
          return {} as T
        }
        return client
      },
    })
    try {
      const initial = (await runtime.request('runtime.tasks.list', {})) as {
        workspaces: Array<{ workspacePath: string; projectPinned: boolean }>
      }
      expect(initial.workspaces.find(item => item.workspacePath === '/workspace')?.projectPinned)
        .toBe(true)

      rootProjectPinned = false
      failWorktreeRead = true
      const result = (await runtime.request('runtime.tasks.list', {})) as {
        workspaces: Array<{
          workspacePath: string
          projectPinned: boolean
          available: boolean
          error?: string
        }>
      }
      const root = result.workspaces.find(item => item.workspacePath === '/workspace')
      const worktree = result.workspaces.find(item => item.workspacePath === '/workspace/tree')
      expect(root?.projectPinned).toBe(false)
      expect(root?.available).toBe(false)
      expect(root?.error).toBe(worktreeReadError)
      expect(worktree?.projectPinned).toBe(false)
      expect(worktree?.available).toBe(false)
      expect(worktree?.error).toBe(worktreeReadError)
      vi.mocked(console.warn).mockClear()
    } finally {
      runtime.dispose()
    }
  })

  test('keeps the last confirmed root pin when the workspace registry is offline', async () => {
    const rootProjectPinned = false
    let failWorkspaceRead = false
    const workspaceReadError = 'workspace registry unavailable'
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => {
        const client = new FakeGatewayClient(null)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          client.requests.push({ method, params })
          if (method === 'runtime.workspaces.list') {
            if (failWorkspaceRead) throw new Error(workspaceReadError)
            return { items: [], pinnedTaskIds: [], rootProjectPinned } as T
          }
          if (method === 'runtime.worktrees.list') return { items: [] } as T
          return {} as T
        }
        return client
      },
    })
    try {
      await runtime.request('runtime.tasks.list', {})

      failWorkspaceRead = true
      const result = (await runtime.request('runtime.tasks.list', {})) as {
        workspaces: Array<{
          workspacePath: string
          projectPinned: boolean
          available: boolean
          error?: string
        }>
      }
      const root = result.workspaces.find(item => item.workspacePath === '/workspace')
      expect(root?.projectPinned).toBe(false)
      expect(root?.available).toBe(false)
      expect(root?.error).toBe(workspaceReadError)
      vi.mocked(console.warn).mockClear()
    } finally {
      runtime.dispose()
    }
  })

  test('surfaces offline and app-server pin failures instead of returning a success acknowledgement', async () => {
    const offline = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => {
        throw new Error('Target offline')
      },
    })
    try {
      await expect(
        offline.request('runtime.sidebar.projects.pin', {
          deviceId: 'local',
          projectKey: 'runtime-target:local',
          pinned: false,
        })
      ).rejects.toThrow('Target offline')
    } finally {
      offline.dispose()
    }

    const client = new FakeGatewayClient(null)
    const pinFailure = new Error('app-server refused project pin')
    client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
      client.requests.push({ method, params })
      if (method === 'runtime.workspaces.list') return { items: [] } as T
      if (method === 'runtime.sidebar.projects.pin') throw pinFailure
      return {} as T
    }
    const failing = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    try {
      await expect(
        failing.request('runtime.sidebar.projects.pin', {
          deviceId: 'local',
          projectKey: 'runtime-target:local',
          pinned: false,
        })
      ).rejects.toBe(pinFailure)
      expect(
        client.requests.some(request => request.method === 'runtime.sidebar.projects.pin')
      ).toBe(true)
    } finally {
      failing.dispose()
    }
  })
})
