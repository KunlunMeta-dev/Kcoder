import { afterEach, describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as InstalledGatewayRuntime } from './installGatewayRuntime'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

const installedRuntimes: InstalledGatewayRuntime[] = []
afterEach(() => {
  installedRuntimes.splice(0).forEach(runtime => runtime.dispose())
})

describe.each(['modular', 'installed'] as const)(
  '%s gateway task archive synchronization',
  runtimeKind => {
    test.each(['archive', 'unarchive'] as const)(
      'serializes %s with an already pending authoritative task refresh',
      async action => {
        const taskId = 'kcoder:local:archive-race'
        const archivedAt = action === 'unarchive' ? '2026-09-01T00:00:00Z' : null
        const persistedThreads: Array<Record<string, unknown>> = [
          {
            id: 'archive-race',
            cwd: '/workspace',
            status: 'idle',
            title: 'Archive race',
            metadata: {
              schema: 'kcoder.thread-metadata',
              version: 1,
              revision: 1,
              title: 'Archive race',
              archivedAt,
              model: null,
              parent: null,
            },
          },
        ]
        let delayNextList = false
        let releaseList!: () => void
        const listGate = new Promise<void>(resolve => {
          releaseList = resolve
        })
        const listStarted = vi.fn()
        const metadataUpdates = vi.fn()
        const options = {
          loadServers: async () => [localGatewayServer()],
          createClient: () => {
            const client = new FakeGatewayClient(null)
            client.threadResumeSupported = true
            client.persistedThreads = persistedThreads
            const request = client.request.bind(client)
            client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
              if (method === 'thread/list' && delayNextList) {
                delayNextList = false
                const staleSnapshot = JSON.parse(JSON.stringify(await request(method, params)))
                listStarted()
                await listGate
                return staleSnapshot as T
              }
              if (method === 'thread/metadata/update') metadataUpdates()
              return request<T>(method, params)
            }
            return client
          },
        }
        const runtime =
          runtimeKind === 'modular'
            ? createTestGatewayRuntime('token', options)
            : new InstalledGatewayRuntime('token', options)
        if (runtime instanceof InstalledGatewayRuntime) installedRuntimes.push(runtime)
        await runtime.request('runtime.tasks.list', {})
        delayNextList = true
        const refresh = runtime.request('runtime.tasks.list', {})
        await vi.waitFor(() => expect(listStarted).toHaveBeenCalledOnce())
        const mutation = runtime.request(
          action === 'archive'
            ? 'runtime.tasks.archive'
            : 'runtime.archived_conversations.unarchive',
          { taskId }
        )
        try {
          await new Promise(resolve => setTimeout(resolve, 20))
          expect(metadataUpdates).not.toHaveBeenCalled()
        } finally {
          releaseList()
          await refresh
          await mutation
        }
        expect(metadataUpdates).toHaveBeenCalledOnce()
        const result = await runtime.request('runtime.tasks.list', {})
        expect(result).toMatchObject({
          workspaces: [
            { tasks: action === 'archive' ? [] : [expect.objectContaining({ taskId })] },
          ],
        })
        await expect(
          runtime.request('runtime.archived_conversations.list', {})
        ).resolves.toMatchObject({
          total: action === 'archive' ? 1 : 0,
        })
      }
    )
  }
)
