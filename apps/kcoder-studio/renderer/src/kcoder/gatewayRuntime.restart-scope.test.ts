import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('gateway restart request scope', RuntimeClass => {
  test.each([
    { global: false, selected: 'local' },
    { global: false, selected: 'remote' },
    { global: true, selected: 'local' },
  ])(
    'isolates target restarts with global=$global and selected=$selected',
    async ({ global, selected }) => {
      let releaseRestart!: () => void
      const gate = new Promise<void>(resolve => {
        releaseRestart = resolve
      })
      const restartStarted = vi.fn()
      const clients: Array<{ serverId: string; client: FakeGatewayClient }> = []
      const runtime = new RuntimeClass('token', {
        loadServers: async () =>
          [
            localGatewayServer({ id: 'local', workspacePath: '/local' }),
            localGatewayServer({ id: 'remote', workspacePath: '/remote' }),
          ].sort((a, b) => Number(b.id === selected) - Number(a.id === selected)),
        createClient: serverId => {
          const client = new FakeGatewayClient(`thread-${serverId}`)
          const request = client.request.bind(client)
          client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
            if (method === 'gateway/app-server/restart') {
              restartStarted()
              await gate
            }
            if (method === 'runtime.providers.list') return { profiles: [] } as T
            if (method === 'runtime.providers.validate') return { valid: true } as T
            return request<T>(method, params)
          }
          clients.push({ serverId, client })
          return client
        },
      })
      let restart: Promise<unknown> | undefined
      try {
        await runtime.request('runtime.tasks.create', {
          deviceId: 'remote',
          taskId: 'idle-remote-task',
          executionRequest: { prompt: 'Complete before restarting this target' },
        })
        const remoteTaskClient = clients.find(item => item.serverId === 'remote')!.client
        remoteTaskClient.emitNotification('turn/completed', {
          threadId: 'thread-remote',
          turnId: 'thread-remote-turn',
          turn: { id: 'thread-remote-turn', status: 'completed' },
        })
        await new Promise(resolve => setTimeout(resolve, 0))
        await runtime.request('runtime.providers.request', {
          serverId: 'remote',
          method: 'runtime.providers.list',
          params: {},
        })
        restart = runtime.request(
          global ? 'runtime.app_server.restart' : 'runtime.providers.restart',
          global ? {} : { serverId: 'remote' }
        )
        await vi.waitFor(() => expect(restartStarted).toHaveBeenCalledOnce())
        remoteTaskClient.close()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(
          clients.some(
            item =>
              item.serverId === 'remote' &&
              item.client.requests.some(request => request.method === 'thread/resume')
          )
        ).toBe(false)
        await expect(
          runtime.request('runtime.providers.request', {
            serverId: 'remote',
            method: 'runtime.providers.list',
            params: {},
          })
        ).rejects.toThrow('restart is in progress')
        await expect(
          runtime.request('runtime.tasks.create', {
            deviceId: 'remote',
            taskId: 'blocked-remote-task',
            executionRequest: { prompt: 'Blocked' },
          })
        ).rejects.toThrow('restart is in progress')
        const create = runtime.request('runtime.tasks.create', {
          deviceId: 'local',
          taskId: 'local-during-remote-restart',
          executionRequest: { prompt: 'Keep the other target usable' },
        })
        if (global) {
          await expect(create).rejects.toThrow('restart is in progress')
          await expect(runtime.status()).rejects.toThrow('restart is in progress')
        } else {
          const created = (await create) as { taskId: string }
          const taskClient = clients.find(
            item =>
              item.serverId === 'local' &&
              item.client.requests.some(request => request.method === 'turn/start')
          )!.client
          taskClient.emitNotification('turn/completed', {
            threadId: 'thread-local',
            turnId: 'thread-local-turn',
            turn: { id: 'thread-local-turn', status: 'completed' },
          })
          await new Promise(resolve => setTimeout(resolve, 0))
          await expect(
            runtime.request('runtime.tasks.send', {
              taskId: created.taskId,
              executionRequest: { prompt: 'Send while the other target restarts' },
            })
          ).resolves.toMatchObject({ accepted: true })
          if (selected === 'local') {
            await expect(runtime.status()).resolves.toMatchObject({
              ready: true,
              deviceId: 'local',
            })
          } else {
            await expect(runtime.status()).rejects.toThrow('restart is in progress')
          }
          taskClient.close()
          await vi.waitFor(() =>
            expect(
              clients.some(
                item =>
                  item.serverId === 'local' &&
                  item.client !== taskClient &&
                  item.client.requests.some(request => request.method === 'thread/resume')
              )
            ).toBe(true)
          )
          await expect(
            runtime.request('runtime.tasks.send', {
              taskId: created.taskId,
              executionRequest: { prompt: 'Send after independent recovery' },
            })
          ).resolves.toMatchObject({ accepted: true })
          await expect(
            runtime.request('runtime.providers.restart', { serverId: 'local' })
          ).rejects.toThrow('restart is in progress')
        }
      } finally {
        releaseRestart()
        await restart
        runtime.dispose()
      }
    }
  )
})
