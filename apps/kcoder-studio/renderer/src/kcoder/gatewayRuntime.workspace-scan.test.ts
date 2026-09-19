import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

type Page = {
  threads: Array<Record<string, unknown>>
  nextCursor: string | null
  completeness?: 'complete' | 'partial'
  issueCount?: number
}
type WorkspaceResult = {
  workspaces: Array<{
    deviceId: string
    workspacePath: string
    available: boolean
    deviceStatus: string
    threadsComplete?: boolean
    threadListIssueCount?: number
    threadListSyncFailed?: boolean
    tasks: Array<{ taskId: string }>
  }>
}
type ProgressiveResult = WorkspaceResult & { scanId: string; revision: number; complete: boolean }
const paths = ['/workspace', '/workspace/second', '/workspace/third']
const servers = ['local', 'remote']
const thread = (path: string, suffix: string) => ({
  id: `${path}-${suffix}`,
  cwd: path,
  title: suffix,
  status: 'idle',
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(release => {
    resolve = release
  })
  return { promise, resolve }
}

async function dispose(runtime: Runtime | InstalledRuntime) {
  runtime.dispose()
  if (runtime instanceof Runtime) await runtime.disposeAsync()
}

function fixture(
  RuntimeClass: typeof Runtime | typeof InstalledRuntime,
  list: (serverId: string, path: string, cursor: unknown) => Promise<Page>,
  registry?: (serverId: string) => Promise<void>,
  targetIds = servers,
  completenessCapability = false
) {
  const clients: FakeGatewayClient[] = []
  const directory = targetIds.map(id => localGatewayServer({ id }))
  let peakClients = 0
  const starts: Array<{ serverId: string; path: string; cursor: unknown; allowPartial: unknown }> =
    []
  localStorage.setItem('kcoder-studio:selected-server', 'local')
  const runtime = new RuntimeClass('fixture-token', {
    loadServers: async () => directory.slice(),
    createClient: (serverId, _token, _channel, workspacePath) => {
      const path = workspacePath ?? paths[0]
      const client = new FakeGatewayClient(null)
      client.threadResumeSupported = true
      const supports = client.supportsExperimental.bind(client)
      client.supportsExperimental = capability =>
        capability === 'threadListCompleteness' ? completenessCapability : supports(capability)
      client.workspaceItems = paths.slice(1).map(workspacePath => ({ workspacePath }))
      const request = client.request.bind(client)
      client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
        if (method === 'runtime.workspaces.list') await registry?.(serverId)
        if (method === 'thread/list') {
          starts.push({ serverId, path, cursor: params.cursor, allowPartial: params.allowPartial })
          return (await list(serverId, path, params.cursor)) as T
        }
        return request<T>(method, params)
      }
      clients.push(client)
      peakClients = Math.max(peakClients, clients.filter(value => !value.closed).length)
      return client
    },
  })
  return { runtime, clients, starts, directory, peakClients: () => peakClients }
}

// Transport gates exercise real runtime scheduling and identity, not model behavior.
describe.each([Runtime, InstalledRuntime])('bounded runtime workspace hydration', RuntimeClass => {
  test.each(['complete with issues', 'changed completeness', 'changed issue count'])(
    'rejects inconsistent snapshot metadata: %s',
    async invalid => {
      let seeded = false
      const { runtime } = fixture(
        RuntimeClass,
        async (_server, path, cursor) => {
          if (!seeded)
            return {
              threads: [thread(path, 'A'), thread(path, 'B')],
              nextCursor: null,
              completeness: 'complete',
              issueCount: 0,
            }
          if (invalid === 'complete with issues')
            return {
              threads: [thread(path, 'A')],
              nextCursor: null,
              completeness: 'complete',
              issueCount: 2,
            }
          return {
            threads: [thread(path, 'A')],
            nextCursor: cursor ? null : 'next',
            completeness: invalid === 'changed completeness' && !cursor ? 'complete' : 'partial',
            issueCount: invalid === 'changed completeness' ? (cursor ? 1 : 0) : cursor ? 2 : 1,
          }
        },
        undefined,
        ['local'],
        true
      )
      try {
        await runtime.request('runtime.tasks.list', {})
        seeded = true
        const result = (await runtime.request('runtime.tasks.list', {})) as WorkspaceResult
        for (const workspace of result.workspaces) {
          expect(workspace.threadsComplete).toBe(false)
          expect(workspace.tasks).toHaveLength(2)
        }
        expect(console.warn).toHaveBeenCalledTimes(paths.length)
        vi.mocked(console.warn).mockClear()
      } finally {
        await dispose(runtime)
      }
    }
  )

  test.each(['missing completeness', 'invalid issue count'])(
    'marks an opted-in response with %s incomplete without clearing tasks',
    async invalid => {
      let seeded = false
      const { runtime } = fixture(
        RuntimeClass,
        async (_server, path) => {
          if (!seeded)
            return {
              threads: [thread(path, 'A'), thread(path, 'B')],
              nextCursor: null,
              completeness: 'complete',
              issueCount: 0,
            }
          return {
            threads: [thread(path, 'A')],
            nextCursor: null,
            ...(invalid === 'missing completeness'
              ? { issueCount: 0 }
              : { completeness: 'complete' as const, issueCount: -1 }),
          }
        },
        undefined,
        ['local'],
        true
      )
      try {
        await runtime.request('runtime.tasks.list', {})
        seeded = true
        const result = (await runtime.request('runtime.tasks.list', {})) as WorkspaceResult
        for (const workspace of result.workspaces) {
          expect(workspace).toMatchObject({
            threadsComplete: false,
            threadListIssueCount: 1,
            threadListSyncFailed: true,
          })
          expect(workspace.tasks).toHaveLength(2)
        }
        expect(console.warn).toHaveBeenCalledTimes(paths.length)
        vi.mocked(console.warn).mockClear()
      } finally {
        await dispose(runtime)
      }
    }
  )

  test('retains missing live and archived threads through repeated partial snapshots, then cleans only complete scans', async () => {
    let mode: 'seed' | 'partial' | 'complete' = 'seed'
    const { runtime, starts } = fixture(
      RuntimeClass,
      async (_server, path, cursor) => {
        if (mode === 'seed')
          return {
            threads: [
              thread(path, 'A'),
              thread(path, 'B'),
              { ...thread(path, 'archived'), archivedAt: '2026-01-01T00:00:00Z' },
            ],
            nextCursor: null,
            completeness: 'complete',
            issueCount: 0,
          }
        return {
          threads: cursor ? [] : [thread(path, 'A')],
          nextCursor: cursor ? null : 'next',
          completeness: mode,
          issueCount: mode === 'partial' ? 3 : 0,
        }
      },
      undefined,
      ['local'],
      true
    )
    const load = () => runtime.request('runtime.tasks.list', {}) as Promise<WorkspaceResult>
    try {
      await load()
      mode = 'partial'
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await load()
        for (const workspace of result.workspaces) {
          expect(workspace).toMatchObject({ threadsComplete: false, threadListIssueCount: 3 })
          expect(workspace.tasks.map(task => task.taskId).sort()).toEqual(
            ['A', 'B'].map(id => `kcoder:local:${workspace.workspacePath}-${id}`)
          )
        }
        const archived = (await runtime.request('runtime.archived_conversations.list', {})) as {
          items: unknown[]
        }
        expect(archived.items).toHaveLength(paths.length)
      }
      expect(starts.every(request => request.allowPartial === true)).toBe(true)
      mode = 'complete'
      await load()
      const result = await load()
      for (const workspace of result.workspaces) {
        expect(workspace).toMatchObject({ threadsComplete: true, threadListIssueCount: 0 })
        expect(workspace.tasks).toHaveLength(1)
      }
      const archived = (await runtime.request('runtime.archived_conversations.list', {})) as {
        items: unknown[]
      }
      expect(archived.items).toHaveLength(0)
    } finally {
      await dispose(runtime)
    }
  })

  test('keeps legacy requests opt-out and marks failed pagination incomplete without keeping scan scheduling open', async () => {
    const { runtime, starts } = fixture(
      RuntimeClass,
      async (_server, path, cursor) => {
        if (cursor) throw new Error('partial page unavailable')
        return { threads: [thread(path, 'A')], nextCursor: 'next' }
      },
      undefined,
      ['local']
    )
    try {
      let result = (await runtime.request('runtime.tasks.list', {
        progressive: true,
      })) as ProgressiveResult
      while (!result.complete)
        result = (await runtime.request('runtime.tasks.list', {
          progressive: true,
          scanId: result.scanId,
          afterRevision: result.revision,
        })) as ProgressiveResult
      expect(result.complete).toBe(true)
      for (const workspace of result.workspaces)
        expect(workspace).toMatchObject({
          threadsComplete: false,
          threadListIssueCount: 1,
          threadListSyncFailed: true,
        })
      expect(starts.every(request => request.allowPartial === undefined)).toBe(true)
      expect(console.warn).toHaveBeenCalledTimes(paths.length)
      vi.mocked(console.warn).mockClear()
    } finally {
      await dispose(runtime)
    }
  })

  test('publishes fast projects before a slow target and shares the scan with complete-mode readers', async () => {
    const gate = deferred()
    const { runtime, starts } = fixture(
      RuntimeClass,
      async (_serverId, path) => ({ threads: [thread(path, 'existing')], nextCursor: null }),
      async serverId => {
        if (serverId === 'remote') await gate.promise
      }
    )
    let first: ProgressiveResult | undefined
    const initial = runtime.request('runtime.tasks.list', { progressive: true }).then(value => {
      first = value as ProgressiveResult
      return first
    })
    let complete: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(first?.workspaces.length).toBeGreaterThan(0))
      expect(first!.complete).toBe(false)
      expect(first!.scanId).toEqual(expect.any(String))
      expect(first!.workspaces.every(workspace => workspace.deviceId === 'local')).toBe(true)
      expect(first!.workspaces.every(workspace => workspace.tasks.length === 1)).toBe(true)
      let completed = false
      complete = runtime.request('runtime.tasks.list', {}).then(value => {
        completed = true
        return value
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(completed).toBe(false)
      gate.resolve()
      let update = first!
      while (!update.complete) {
        update = (await runtime.request('runtime.tasks.list', {
          progressive: true,
          scanId: update.scanId,
          afterRevision: update.revision,
        })) as ProgressiveResult
      }
      expect(update.workspaces).toHaveLength(6)
      expect(await complete).toEqual({ workspaces: update.workspaces })
      expect(starts).toHaveLength(6)
    } finally {
      gate.resolve()
      await Promise.allSettled([initial, ...(complete ? [complete] : [])])
      await dispose(runtime)
    }
  })

  test.each(['configuration', 'selection', 'disposal'] as const)(
    'invalidates progressive tokens and wakes pending readers on %s',
    async reason => {
      const gate = deferred()
      const { runtime } = fixture(
        RuntimeClass,
        async (_serverId, path) => ({ threads: [thread(path, 'existing')], nextCursor: null }),
        async serverId => {
          if (serverId === 'remote') await gate.promise
        }
      )
      let first: ProgressiveResult | undefined
      const initial = runtime.request('runtime.tasks.list', { progressive: true }).then(value => {
        first = value as ProgressiveResult
        return first
      })
      try {
        await vi.waitFor(() => expect(first).toBeDefined())
        await new Promise(resolve => setTimeout(resolve, 0))
        const latest = (await runtime.request('runtime.tasks.list', {
          progressive: true,
          scanId: first!.scanId,
          afterRevision: 0,
        })) as ProgressiveResult
        const pending = runtime.request('runtime.tasks.list', {
          progressive: true,
          scanId: latest.scanId,
          afterRevision: latest.revision,
        })
        const rejected = expect(pending).rejects.toMatchObject({
          name: 'AbortError',
          code: 'KCODER_WORKSPACE_SCAN_CANCELLED',
        })
        if (reason === 'configuration') window.dispatchEvent(new Event('kcoder:servers-changed'))
        else if (reason === 'selection')
          await runtime.request('runtime.sidebar.projects.activate', { deviceId: 'remote' })
        else runtime.dispose()
        await rejected
        await expect(
          runtime.request('runtime.tasks.list', {
            progressive: true,
            scanId: latest.scanId,
            afterRevision: latest.revision,
          })
        ).rejects.toThrow()
      } finally {
        gate.resolve()
        await initial.catch(() => undefined)
        await dispose(runtime)
      }
    }
  )

  test('rejects invalid progressive cursors without opening clients', async () => {
    const { runtime, clients } = fixture(RuntimeClass, async () => ({
      threads: [],
      nextCursor: null,
    }))
    try {
      for (const params of [
        { progressive: true, afterRevision: 1 },
        { progressive: true, scanId: 'unknown', afterRevision: 0 },
        { progressive: true, scanId: 'unknown', afterRevision: -1 },
        { progressive: true, scanId: 5, afterRevision: 0 },
      ])
        await expect(runtime.request('runtime.tasks.list', params)).rejects.toThrow()
      expect(clients).toHaveLength(0)
    } finally {
      await dispose(runtime)
    }
  })

  test('retains unavailable nested projects and their sessions after a target registry failure', async () => {
    let unavailable = false
    const { runtime } = fixture(
      RuntimeClass,
      async (_serverId, path) => ({ threads: [thread(path, 'existing')], nextCursor: null }),
      async serverId => {
        if (unavailable && serverId === 'remote') throw new Error('remote registry unavailable')
      }
    )
    try {
      const initial = (await runtime.request('runtime.tasks.list', {})) as WorkspaceResult
      expect(initial.workspaces.filter(item => item.deviceId === 'remote')).toHaveLength(3)
      unavailable = true
      const result = (await runtime.request('runtime.tasks.list', {})) as WorkspaceResult
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/无法读取 .* 的工作区注册表/),
        new Error('remote registry unavailable')
      )
      vi.mocked(console.warn).mockClear()
      const remote = result.workspaces.filter(item => item.deviceId === 'remote')
      expect(remote.map(item => item.workspacePath)).toEqual(paths)
      for (const workspace of remote) {
        expect(workspace).toMatchObject({ available: false, deviceStatus: 'offline' })
        expect(workspace.tasks).toEqual([
          expect.objectContaining({ taskId: `kcoder:remote:${workspace.workspacePath}-existing` }),
        ])
      }
    } finally {
      await dispose(runtime)
    }
  })

  test('does not restore old target projects after replacing a configuration object with the same id', async () => {
    let unavailable = false
    const { runtime, directory } = fixture(
      RuntimeClass,
      async (_serverId, path) => ({ threads: [thread(path, 'existing')], nextCursor: null }),
      async serverId => {
        if (unavailable && serverId === 'remote') throw new Error('replacement target unavailable')
      }
    )
    try {
      const initial = (await runtime.request('runtime.tasks.list', {})) as WorkspaceResult
      expect(initial.workspaces.filter(item => item.deviceId === 'remote')).toHaveLength(3)
      directory[1] = localGatewayServer({
        id: 'remote',
        workspacePath: '/replacement',
        transport: 'ssh',
      })
      unavailable = true
      window.dispatchEvent(new Event('kcoder:servers-changed'))
      const result = (await runtime.request('runtime.tasks.list', {})) as WorkspaceResult
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/无法读取 .* 的工作区注册表/),
        new Error('replacement target unavailable')
      )
      vi.mocked(console.warn).mockClear()
      expect(result.workspaces.filter(item => item.deviceId === 'remote')).toEqual([
        expect.objectContaining({ workspacePath: '/replacement', tasks: [] }),
      ])
    } finally {
      await dispose(runtime)
    }
  })

  test('discovers other target registries while the selected registry waits without changing result order', async () => {
    const gate = deferred()
    const visited: string[] = []
    const { runtime } = fixture(
      RuntimeClass,
      async (_serverId, path) => ({ threads: [thread(path, 'existing')], nextCursor: null }),
      async serverId => {
        visited.push(serverId)
        if (serverId === 'local') await gate.promise
      }
    )
    const loading = runtime.request('runtime.tasks.list', {}) as Promise<WorkspaceResult>
    try {
      await vi.waitFor(() => expect(visited).toEqual(['local', 'remote']))
      gate.resolve()
      expect((await loading).workspaces.map(workspace => workspace.deviceId)).toEqual([
        'local',
        'local',
        'local',
        'remote',
        'remote',
        'remote',
      ])
    } finally {
      gate.resolve()
      await loading.catch(() => undefined)
      await dispose(runtime)
    }
  })

  test('does not retry a failed target registry during hydration or delete its known sessions', async () => {
    let offline = false
    const { runtime, starts } = fixture(
      RuntimeClass,
      async (_serverId, path) => ({ threads: [thread(path, 'existing')], nextCursor: null }),
      async serverId => {
        if (offline && serverId === 'remote') throw new Error('remote registry unavailable')
      }
    )
    try {
      await runtime.request('runtime.tasks.list', {})
      offline = true
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = starts.filter(item => item.serverId === 'remote').length
        const result = (await runtime.request('runtime.tasks.list', {})) as WorkspaceResult
        expect(starts.filter(item => item.serverId === 'remote')).toHaveLength(before)
        expect(result.workspaces.find(workspace => workspace.deviceId === 'remote')?.tasks).toEqual(
          [expect.objectContaining({ taskId: 'kcoder:remote:/workspace-existing' })]
        )
      }
      expect(console.warn).toHaveBeenCalledTimes(2)
      for (const [message, error] of vi.mocked(console.warn).mock.calls) {
        expect(message).toMatch(/无法读取 .* 的工作区注册表/)
        expect(error).toEqual(new Error('remote registry unavailable'))
      }
      vi.mocked(console.warn).mockClear()
    } finally {
      await dispose(runtime)
    }
  })

  test('coalesces overlapping list requests instead of repeating each workspace scan', async () => {
    const gate = deferred()
    const registry = vi.fn(async () => undefined)
    const { runtime, starts } = fixture(
      RuntimeClass,
      async (_serverId, path) => {
        await gate.promise
        return { threads: [thread(path, 'existing')], nextCursor: null }
      },
      registry
    )
    const first = runtime.request('runtime.tasks.list', {})
    let second: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(starts).toHaveLength(4))
      second = runtime.request('runtime.tasks.list', {})
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(registry).toHaveBeenCalledTimes(2)
      gate.resolve()
      await Promise.all([first, second])
      for (const serverId of servers)
        for (const path of paths) {
          expect(
            starts.filter(item => item.serverId === serverId && item.path === path)
          ).toHaveLength(1)
        }
      await runtime.request('runtime.tasks.list', {})
      expect(registry).toHaveBeenCalledTimes(4)
      for (const serverId of servers)
        for (const path of paths) {
          expect(
            starts.filter(item => item.serverId === serverId && item.path === path)
          ).toHaveLength(2)
        }
    } finally {
      gate.resolve()
      await Promise.allSettled([first, ...(second ? [second] : [])])
      await dispose(runtime)
    }
  })

  test('starts other workspace scans while the active workspace waits and preserves every page owner', async () => {
    const slow = deferred()
    const { runtime, starts } = fixture(RuntimeClass, async (serverId, path, cursor) => {
      if (serverId === 'local' && path === paths[0]) await slow.promise
      return cursor
        ? { threads: [thread(path, 'second-page')], nextCursor: null }
        : { threads: [thread(path, 'first-page')], nextCursor: 'next' }
    })
    const loading = runtime.request('runtime.tasks.list', {}) as Promise<WorkspaceResult>
    try {
      await vi.waitFor(() => {
        expect(starts.some(item => item.serverId === 'local' && item.path === paths[0])).toBe(true)
        expect(starts.some(item => item.path !== paths[0])).toBe(true)
        expect(starts.some(item => item.serverId === 'remote')).toBe(true)
      })
      slow.resolve()
      const result = await loading
      expect(result.workspaces).toHaveLength(6)
      for (const workspace of result.workspaces) {
        expect(workspace.tasks.map(task => task.taskId).sort()).toEqual(
          ['first-page', 'second-page']
            .map(suffix => `kcoder:${workspace.deviceId}:${workspace.workspacePath}-${suffix}`)
            .sort()
        )
        expect(
          starts
            .filter(
              item => item.serverId === workspace.deviceId && item.path === workspace.workspacePath
            )
            .map(item => item.cursor)
        ).toEqual([undefined, 'next'])
      }
    } finally {
      slow.resolve()
      await loading.catch(() => undefined)
      await dispose(runtime)
    }
  })

  test('retains previous tasks on incomplete pagination and counts deletion misses only after complete scans', async () => {
    let mode: 'seed' | 'incomplete' | 'complete' = 'seed'
    const { runtime } = fixture(RuntimeClass, async (_serverId, path, cursor) => {
      if (mode === 'seed') return { threads: [thread(path, 'old')], nextCursor: null }
      if (!cursor) return { threads: [thread(path, 'first-page')], nextCursor: 'next' }
      if (mode === 'incomplete') throw new Error('second page unavailable')
      return { threads: [thread(path, 'second-page')], nextCursor: null }
    })
    const load = () => runtime.request('runtime.tasks.list', {}) as Promise<WorkspaceResult>
    const expectOld = (result: WorkspaceResult, present: boolean) => {
      for (const workspace of result.workspaces) {
        expect(
          workspace.tasks.some(
            task => task.taskId === `kcoder:${workspace.deviceId}:${workspace.workspacePath}-old`
          )
        ).toBe(present)
      }
    }
    try {
      expectOld(await load(), true)
      mode = 'incomplete'
      expectOld(await load(), true)
      expectOld(await load(), true)
      expect(console.warn).toHaveBeenCalledTimes(12)
      for (const [message, error] of vi.mocked(console.warn).mock.calls) {
        expect(message).toMatch(/无法同步 .* 的持久任务/)
        expect(error).toEqual(new Error('second page unavailable'))
      }
      vi.mocked(console.warn).mockClear()
      mode = 'complete'
      expectOld(await load(), true)
      const final = await load()
      expectOld(final, false)
      for (const workspace of final.workspaces) expect(workspace.tasks).toHaveLength(2)
    } finally {
      await dispose(runtime)
    }
  })

  test('does not create clients for queued workspaces after disposal', async () => {
    const gate = deferred()
    const { runtime, starts, clients } = fixture(RuntimeClass, async (_serverId, path) => {
      await gate.promise
      return { threads: [thread(path, 'existing')], nextCursor: null }
    })
    const loading = runtime.request('runtime.tasks.list', {})
    try {
      await vi.waitFor(() => expect(starts).toHaveLength(4))
      const clientsBeforeDispose = clients.length
      const rejected = expect(loading).rejects.toThrow('Workspace scan invalidated')
      runtime.dispose()
      gate.resolve()
      await rejected
      expect(starts).toHaveLength(4)
      expect(clients).toHaveLength(clientsBeforeDispose)
      expect(clients.every(client => client.closed)).toBe(true)
    } finally {
      runtime.dispose()
      gate.resolve()
      await loading.catch(() => undefined)
      await dispose(runtime)
    }
  })

  test('bounds discovery and hydration together across four targets', async () => {
    const gate = deferred()
    const { runtime, starts, peakClients } = fixture(
      RuntimeClass,
      async (_serverId, path) => {
        await gate.promise
        return { threads: [thread(path, 'existing')], nextCursor: null }
      },
      undefined,
      ['local', 'remote', 'third', 'fourth']
    )
    const loading = runtime.request('runtime.tasks.list', {}) as Promise<WorkspaceResult>
    try {
      await vi.waitFor(() => expect(starts).toHaveLength(4))
      expect(peakClients()).toBeLessThanOrEqual(4)
      gate.resolve()
      expect((await loading).workspaces).toHaveLength(12)
      expect(peakClients()).toBeLessThanOrEqual(4)
    } finally {
      gate.resolve()
      await loading.catch(() => undefined)
      await dispose(runtime)
    }
  })
})
