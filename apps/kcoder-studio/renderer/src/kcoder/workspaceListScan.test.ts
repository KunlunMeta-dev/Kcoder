import { expect, test, vi } from 'vitest'
import { WorkspaceListScan } from './workspaceListScan'

test.each(['discover', 'project'] as const)(
  'stops queued jobs and retains the original %s error',
  async failing => {
    const servers = Array.from({ length: 8 }, (_, id) => ({ id }))
    const scan = new WorkspaceListScan<
      (typeof servers)[number],
      { server: (typeof servers)[number]; projectActive: boolean }
    >()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const failure = new Error(`${failing} fixture failure`)
    const writes: number[] = []
    const discover = vi.fn(async (server: (typeof servers)[number], cancelled: () => boolean) => {
      if (server.id !== 0) await gate
      if (failing === 'discover' && server.id === 0) throw failure
      if (!cancelled()) writes.push(server.id)
      return [{ server, projectActive: server.id === 0 }]
    })
    const options = {
      servers,
      discover,
      hydrate: async () => undefined,
      project: (workspaces: unknown[]) => {
        if (failing === 'project') throw failure
        return { workspaces }
      },
      disposed: () => false,
    }
    try {
      const first = scan.read(servers[0], { progressive: true }, options)
      const second = scan.read(servers[0], {}, options)
      await expect(first).rejects.toBe(failure)
      await expect(second).rejects.toBe(failure)
      const callsAfterFailure = discover.mock.calls.length
      const writesAfterFailure = writes.length
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(discover).toHaveBeenCalledTimes(callsAfterFailure)
      expect(writes).toHaveLength(writesAfterFailure)
      await expect(
        scan.read(
          servers[0],
          {},
          {
            ...options,
            servers: [servers[0]],
            discover: async server => [{ server, projectActive: true }],
            project: workspaces => ({ workspaces }),
          }
        )
      ).resolves.toMatchObject({ workspaces: [{ server: servers[0] }] })
    } finally {
      release()
      scan.invalidate()
    }
  }
)
