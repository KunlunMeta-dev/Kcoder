import { describe, expect, test } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('Windows project history identity', RuntimeClass => {
  test('deduplicates root aliases without merging different servers or directories', async () => {
    const regular = String.raw`D:\project`
    const namespaced = String.raw`\\?\D:\project`
    const clients: Array<{ server: string; path?: string; client: FakeGatewayClient }> = []
    const runtime = new RuntimeClass('token', {
      loadServers: async () =>
        ['local', 'remote'].map(id => ({
          id,
          label: id,
          transport: 'local' as const,
          workspacePath: regular,
        })),
      createClient: (server, _token, _channel, path) => {
        const client = new FakeGatewayClient(null)
        client.threadResumeSupported = true
        client.workspaceItems = [
          { workspacePath: namespaced, projectKey: 'project', projectName: 'Project' },
        ]
        client.persistedThreads = [{ id: `${server}-old`, cwd: regular, title: 'Retained history' }]
        const request = client.request.bind(client)
        client.request = async <T>(
          method: string,
          params: Record<string, unknown> = {}
        ): Promise<T> => {
          if (method === 'cron/list') {
            client.requests.push({ method, params })
            return { jobs: [] } as T
          }
          return request<T>(method, params)
        }
        clients.push({ server, path, client })
        return client
      },
    })
    try {
      const listed = (await runtime.request('runtime.tasks.list', {})) as {
        workspaces: Array<{
          deviceId: string
          workspacePath: string
          tasks: Array<{ threadId: string }>
        }>
      }
      expect(listed.workspaces).toHaveLength(2)
      for (const workspace of listed.workspaces) {
        expect(workspace.workspacePath).toBe(namespaced)
        expect(workspace.tasks.map(task => task.threadId)).toEqual([`${workspace.deviceId}-old`])
      }
      const listJobs = (deviceId: string, workspacePath: string) =>
        runtime.request('runtime.automations.request', {
          deviceId,
          workspacePath,
          method: 'cron/list',
          params: {},
        })
      await listJobs('local', namespaced)
      await listJobs('local', 'd:/project/')
      await listJobs('remote', regular)
      await listJobs('local', 'D:/different')
      const commandClients = clients.filter(item =>
        item.client.requests.some(request => request.method === 'cron/list')
      )
      expect(commandClients).toHaveLength(3)
      expect(commandClients[0].path).toBe(namespaced)
      expect(
        commandClients[0].client.requests.filter(request => request.method === 'cron/list')
      ).toHaveLength(2)
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps old conversations visible across creation, refresh, archive and reconnect', async () => {
    const workspace = String.raw`\\?\D:\ComfyUI-master`
    const historyPath = String.raw`D:\ComfyUI-master`
    const threads: Array<Record<string, unknown>> = Array.from({ length: 5 }, (_, index) => ({
      id: `old-${index}`,
      cwd: historyPath,
      title: `Old conversation ${index}`,
      createdAt: '1700000000000',
      updatedAt: '1700000000001',
    }))
    const clients: FakeGatewayClient[] = []
    const makeRuntime = () =>
      new RuntimeClass('token', {
        loadServers: async () => [
          { id: 'local', label: 'Local', transport: 'local', workspacePath: 'C:/Users/test' },
        ],
        createClient: (_id, _token, _channel, path) => {
          const client = new FakeGatewayClient('new-thread')
          client.threadResumeSupported = true
          client.workspaceItems = [
            { workspacePath: workspace, projectKey: 'comfyui', projectName: 'comfyui' },
          ]
          client.persistedThreads = path === 'C:/Users/test' || !path ? [] : threads
          clients.push(client)
          return client
        },
      })
    const list = async (runtime: Pick<Runtime, 'request'>) => {
      const result = (await runtime.request('runtime.tasks.list', {})) as {
        workspaces: Array<{
          workspacePath: string
          tasks: Array<{ threadId: string; taskId: string }>
        }>
      }
      return result.workspaces.find(item => item.workspacePath === workspace)!.tasks
    }
    let runtime = makeRuntime()
    try {
      expect((await list(runtime as Runtime)).map(task => task.threadId)).toHaveLength(5)
      const created = (await runtime.request('runtime.tasks.create', {
        deviceId: 'local',
        workspacePath: workspace,
        executionRequest: { prompt: 'New conversation' },
      })) as { taskId: string }
      // Real app-server history reports an ordinary DOS path after persisting the new thread.
      threads.find(thread => thread.id === 'new-thread')!.cwd = historyPath
      for (let index = 0; index < 4; index++) {
        expect((await list(runtime as Runtime)).map(task => task.threadId)).toEqual(
          expect.arrayContaining([
            ...Array.from({ length: 5 }, (_, index) => `old-${index}`),
            'new-thread',
          ])
        )
      }
      await runtime.request('runtime.tasks.transcript', { taskId: 'kcoder:local:old-0' })
      await runtime.request('runtime.tasks.archive', { taskId: 'kcoder:local:old-0' })
      expect((await list(runtime as Runtime)).map(task => task.threadId)).not.toContain('old-0')
      expect((await list(runtime as Runtime)).map(task => task.taskId)).toContain(created.taskId)
      await runtime.dispose()
      runtime = makeRuntime()
      expect((await list(runtime as Runtime)).map(task => task.threadId).sort()).toEqual([
        'new-thread',
        'old-1',
        'old-2',
        'old-3',
        'old-4',
      ])
      expect(
        clients
          .flatMap(client => client.requests)
          .some(request => request.method === 'thread/delete')
      ).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})
