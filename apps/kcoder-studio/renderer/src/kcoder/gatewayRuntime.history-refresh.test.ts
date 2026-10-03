import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'

// These tests cover protocol routing and scan lifecycle, independent of model output.
describe.each([Runtime, InstalledRuntime])('workspace history refresh bridge', RuntimeClass => {
  test('routes exactly one acknowledged step to the explicit target workspace', async () => {
    const requests: Array<{ server: string; path?: string; params: Record<string, unknown> }> = []
    const runtime = new RuntimeClass('token', {
      loadServers: async () =>
        ['local', 'remote'].map(id => ({
          id,
          label: id,
          transport: 'local' as const,
          workspacePath: '/default',
        })),
      createClient: (server, _token, _channel, path) => {
        const client = new FakeGatewayClient(null)
        const original = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          if (method === 'thread/history/refresh') {
            requests.push({ server, path, params })
            return {
              status: 'building',
              nextCursor: 'next',
              examinedEntries: 128,
              indexedSessions: 5,
              issueCount: 0,
            } as T
          }
          return original<T>(method, params)
        }
        return client
      },
    })
    try {
      await expect(
        runtime.request('runtime.history.refresh', {
          deviceId: 'remote',
          workspacePath: '/project',
          acknowledgeExternalWriters: true,
        })
      ).resolves.toMatchObject({ status: 'building', nextCursor: 'next' })
      expect(requests).toEqual([
        { server: 'remote', path: '/project', params: { acknowledgeExternalWriters: true } },
      ])
    } finally {
      await runtime.dispose()
    }
  })

  test('requires capability and never silently forwards to an old server', async () => {
    const wire = vi.fn()
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/project' },
      ],
      createClient: () => {
        const client = new FakeGatewayClient(null)
        client.supportsExperimental = () => false
        const original = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          wire(method)
          return original<T>(method, params)
        }
        return client
      },
    })
    try {
      await expect(
        runtime.request('runtime.history.refresh', {
          deviceId: 'local',
          workspacePath: '/project',
          acknowledgeExternalWriters: true,
        })
      ).rejects.toThrow('threadHistoryIndexRefresh')
      expect(wire).not.toHaveBeenCalledWith('thread/history/refresh')
      await expect(
        runtime.request('runtime.history.refresh', {
          workspacePath: '/project',
          acknowledgeExternalWriters: true,
        })
      ).rejects.toThrow('explicit')
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps continuation and cancellation on one workspace command client', async () => {
    const calls: Array<Record<string, unknown>> = []
    const active = new Set<FakeGatewayClient>()
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/project' },
      ],
      createClient: () => {
        const client = new FakeGatewayClient(null)
        const original = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          if (method === 'thread/history/refresh') {
            active.add(client)
            calls.push(params)
            return {
              status: params.cancel ? 'cancelled' : 'building',
              ...(params.cancel ? {} : { nextCursor: 'next' }),
              examinedEntries: 128,
              indexedSessions: 2,
              issueCount: 0,
            } as T
          }
          return original<T>(method, params)
        }
        return client
      },
    })
    try {
      await runtime.request('runtime.history.refresh', {
        deviceId: 'local',
        workspacePath: '/project',
        acknowledgeExternalWriters: true,
      })
      await runtime.request('runtime.history.refresh', {
        deviceId: 'local',
        workspacePath: '/project',
        cursor: 'next',
        cancel: true,
      })
      expect(calls).toEqual([
        { acknowledgeExternalWriters: true },
        { cursor: 'next', cancel: true },
      ])
      expect(active.size).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('ready reloads only the selected server and workspace', async () => {
    const lists: Array<{ server: string; path?: string }> = []
    const runtime = new RuntimeClass('token', {
      loadServers: async () =>
        ['local', 'remote'].map(id => ({
          id,
          label: id,
          transport: 'local' as const,
          workspacePath: '/default',
        })),
      createClient: (server, _token, _channel, path) => {
        const client = new FakeGatewayClient(null)
        client.threadResumeSupported = true
        client.workspaceItems = [
          { workspacePath: '/project', projectKey: 'project', projectName: 'Project' },
        ]
        const original = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          if (method === 'thread/history/refresh')
            return { status: 'ready', examinedEntries: 128, indexedSessions: 2, issueCount: 0 } as T
          if (method === 'thread/list') lists.push({ server, path })
          return original<T>(method, params)
        }
        return client
      },
    })
    try {
      await runtime.request('runtime.history.refresh', {
        deviceId: 'remote',
        workspacePath: '/project',
        acknowledgeExternalWriters: true,
      })
      expect(lists).toEqual([{ server: 'remote', path: '/project' }])
    } finally {
      await runtime.dispose()
    }
  })

  test('a stale scan cannot resurrect a conversation archived during history refresh', async () => {
    const threads: Array<Record<string, unknown>> = [
      { id: 'race', cwd: '/project', title: 'Race', status: 'idle' },
    ]
    let holdNext = false
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const started = vi.fn()
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [
        { id: 'local', label: 'Local', transport: 'local', workspacePath: '/project' },
      ],
      createClient: () => {
        const client = new FakeGatewayClient(null)
        client.threadResumeSupported = true
        client.persistedThreads = threads
        const original = client.request.bind(client)
        client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
          if (method === 'thread/history/refresh')
            return { status: 'ready', examinedEntries: 1, indexedSessions: 1, issueCount: 0 } as T
          if (method === 'thread/list' && holdNext) {
            holdNext = false
            const stale = JSON.parse(JSON.stringify(await original(method, params)))
            started()
            await gate
            return stale as T
          }
          return original<T>(method, params)
        }
        return client
      },
    })
    try {
      await runtime.request('runtime.tasks.list', {})
      holdNext = true
      const stale = runtime.request('runtime.tasks.list', {}).catch(error => error)
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
      const archive = runtime.request('runtime.tasks.archive', { taskId: 'kcoder:local:race' })
      const refresh = runtime.request('runtime.history.refresh', {
        deviceId: 'local',
        workspacePath: '/project',
        acknowledgeExternalWriters: true,
      })
      release()
      await Promise.all([stale, archive, refresh])
      const projection = runtime as unknown as {
        tasks: Map<string, unknown>
        archivedTasks: Map<string, unknown>
      }
      expect(projection.tasks.has('kcoder:local:race')).toBe(false)
      expect(projection.archivedTasks.has('kcoder:local:race')).toBe(true)
    } finally {
      release()
      await runtime.dispose()
    }
  })
})
