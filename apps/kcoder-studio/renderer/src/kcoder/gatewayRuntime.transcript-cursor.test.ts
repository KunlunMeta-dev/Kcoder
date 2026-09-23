import { afterEach, describe, expect, test, vi } from 'vitest'
import { GatewayRpcError } from './gatewayRpc'
import { KCoderGatewayRuntime as InstalledGatewayRuntime } from './installGatewayRuntime'
import {
  createTestGatewayRuntime,
  FakeGatewayClient,
  localGatewayServer,
} from './gatewayRuntime.test-support'

/**
 * A transcript cursor can be invalidated while a multi-page read is in flight
 * (compaction or rollback between two pages). The server answers with
 * TRANSCRIPT_CURSOR_STALE (-32041); the client must restart the read from an
 * authoritative cursor-less snapshot instead of silently dropping the task from
 * the search results (S2/R036, R038).
 */
// The installed adapter carries its own copy of the runtime, so both copies must
// be exercised instead of testing one twice.
const installedRuntimes: InstalledGatewayRuntime[] = []
afterEach(() => {
  installedRuntimes.splice(0).forEach(runtime => runtime.dispose())
})

const scenario = {
  persistedThreads: [
    {
      id: 'cursor-thread',
      cwd: '/workspace',
      status: 'idle',
      title: 'Cursor window',
      metadata: {
        schema: 'kcoder.thread-metadata',
        version: 1,
        revision: 1,
        title: 'Cursor window',
        archivedAt: null,
        model: null,
        parent: null,
      },
    },
  ],
}

function staleCursor() {
  return new GatewayRpcError('TRANSCRIPT_CURSOR_STALE', -32041, {})
}

describe.each(['modular', 'installed'] as const)(
  '%s gateway paginated transcript reads',
  runtimeKind => {
    const createRuntime = (client: FakeGatewayClient) => {
      const options = {
        loadServers: async () => [localGatewayServer()],
        createClient: () => client,
      }
      if (runtimeKind === 'modular') return createTestGatewayRuntime('token', options)
      const runtime = new InstalledGatewayRuntime('token', options)
      installedRuntimes.push(runtime)
      return runtime
    }

    test('uses the read snapshot execution state instead of the older cached thread list', async () => {
      const client = new FakeGatewayClient(null)
      client.threadResumeSupported = true
      client.persistedThreads = scenario.persistedThreads
      const originalRequest = client.request.bind(client)
      client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
        if (method !== 'thread/read') return originalRequest<T>(method, params)
        return {
          thread: { id: 'cursor-thread', status: 'running' },
          messages: [],
          hasMoreBefore: false,
        } as T
      }
      const runtime = createRuntime(client)
      const result = (await runtime.request('runtime.tasks.transcript', {
        taskId: 'kcoder:local:cursor-thread',
      })) as { running: boolean }
      expect(result.running).toBe(true)
    })

    test('restarts from a cursor-less snapshot when the cursor went stale', async () => {
      const client = new FakeGatewayClient(null)
      client.threadResumeSupported = true
      client.persistedThreads = scenario.persistedThreads
      const pageRequests: Array<Record<string, unknown>> = []
      const originalRequest = client.request.bind(client)
      client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
        if (method !== 'thread/read') return originalRequest<T>(method, params)
        pageRequests.push(params)
        if (!params.beforeCursor) {
          return {
            messages: [
              {
                id: 'newest',
                role: 'assistant',
                content: 'the newest answer has no marker',
                timestampMs: 1_700_000_002_000,
              },
            ],
            hasMoreBefore: true,
            beforeCursor: 'tp1:generation:7',
          } as T
        }
        // The first window read loses its cursor to a concurrent compaction.
        if (pageRequests.filter(entry => entry.beforeCursor).length === 1) throw staleCursor()
        return {
          messages: [
            {
              id: 'older',
              role: 'assistant',
              content: 'the durable transcript keeps a nebula-marker here',
              timestampMs: 1_700_000_001_000,
            },
          ],
          hasMoreBefore: false,
          beforeCursor: null,
        } as T
      }

      const runtime = createRuntime(client)
      await expect(runtime.request('runtime.tasks.list', {})).resolves.toBeDefined()
      const result = (await runtime.request('runtime.tasks.search', {
        query: 'nebula-marker',
        limit: 20,
      })) as { items: Array<Record<string, unknown>> }

      expect(result.items).toHaveLength(1)
      expect(result.items[0].snippet).toContain('nebula-marker')
      // The restart re-reads the newest window without a cursor first, so the
      // ordering comes from the authoritative snapshot rather than a stale
      // cursor or a timestamp comparison.
      expect(pageRequests.map(entry => entry.beforeCursor ?? null)).toEqual([
        null,
        'tp1:generation:7',
        null,
        'tp1:generation:7',
      ])
      runtime.dispose()
    })

    test('gives up after one restart when the cursor never stabilizes', async () => {
      const client = new FakeGatewayClient(null)
      client.threadResumeSupported = true
      client.persistedThreads = scenario.persistedThreads
      let windowReads = 0
      let cursorReads = 0
      const originalRequest = client.request.bind(client)
      client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
        if (method !== 'thread/read') return originalRequest<T>(method, params)
        if (!params.beforeCursor) {
          windowReads += 1
          return {
            messages: [
              {
                id: 'newest',
                role: 'assistant',
                content: 'no marker',
                timestampMs: 1_700_000_002_000,
              },
            ],
            hasMoreBefore: true,
            beforeCursor: `tp1:generation:${windowReads}`,
          } as T
        }
        cursorReads += 1
        throw staleCursor()
      }

      const runtime = createRuntime(client)
      await expect(runtime.request('runtime.tasks.list', {})).resolves.toBeDefined()
      const result = (await runtime.request('runtime.tasks.search', {
        query: 'nebula-marker',
        limit: 20,
      })) as { items: Array<Record<string, unknown>> }

      // A permanently stale cursor must not loop: one authoritative restart is
      // all the client is allowed to attempt, and the task simply has no match.
      expect(result.items).toEqual([])
      expect(windowReads).toBe(2)
      expect(cursorReads).toBe(2)
      expect(console.warn).toHaveBeenCalledTimes(1)
      vi.mocked(console.warn).mockClear()
      runtime.dispose()
    })
  }
)
