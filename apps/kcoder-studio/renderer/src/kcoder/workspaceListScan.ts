import { WorkspaceScanProgress } from './workspaceScanProgress'
import { createRandomUuid } from '@/lib/random-id'
import { WorkspaceScanCancelledError } from './workspaceScanError'

type Snapshot = { workspaces: unknown[] }
type Job = { priority: number; run: () => Promise<void>; reject: (error: Error) => void }

// Discovery and hydration share slots; discovery never holds a slot while awaiting hydration.
class ScanQueue {
  private active = 0
  private readonly jobs: Job[] = []

  run<T>(priority: number, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        priority,
        reject,
        run: async () => {
          resolve(await task())
        },
      })
      this.jobs.sort((a, b) => a.priority - b.priority)
      this.drain()
    })
  }

  private drain() {
    while (this.active < 4 && this.jobs.length > 0) {
      const job = this.jobs.shift()!
      this.active += 1
      void job
        .run()
        .catch(job.reject)
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }
}

interface Session<S> {
  owner: S
  progress: WorkspaceScanProgress<Snapshot>
  invalidated: boolean
  complete: boolean
  failure: Error | null
}

export class WorkspaceListScan<S extends object, W extends { server: S; projectActive: boolean }> {
  private readonly queue = new ScanQueue()
  private readonly sessions = new Map<string, Session<S>>()
  private readonly cancelledIds = new Set<string>()
  private active: { id: string; session: Session<S> } | null = null

  invalidate(): void {
    for (const [id, session] of this.sessions) {
      this.cancelledIds.add(id)
      while (this.cancelledIds.size > 32)
        this.cancelledIds.delete(this.cancelledIds.values().next().value!)
      session.invalidated = true
      session.progress.fail(new WorkspaceScanCancelledError())
    }
    this.sessions.clear()
    this.active = null
  }

  async read(
    owner: S,
    params: Record<string, unknown>,
    options: {
      servers: readonly S[]
      discover: (server: S, cancelled: () => boolean) => Promise<W[]>
      hydrate: (workspace: W, cancelled: () => boolean) => Promise<void>
      project: (workspaces: W[]) => Snapshot
      disposed: () => boolean
    }
  ): Promise<unknown> {
    if (options.disposed()) throw new WorkspaceScanCancelledError()
    const progressive = params.progressive === true
    if (params.progressive !== undefined && typeof params.progressive !== 'boolean') {
      throw new Error('Invalid workspace scan mode')
    }
    const hasCursor = params.scanId !== undefined || params.afterRevision !== undefined
    if (hasCursor) {
      if (
        !progressive ||
        typeof params.scanId !== 'string' ||
        !params.scanId ||
        !Number.isSafeInteger(params.afterRevision) ||
        Number(params.afterRevision) < 0
      ) {
        throw new Error('Invalid workspace scan cursor')
      }
      const session = this.sessions.get(params.scanId)
      if (this.cancelledIds.has(params.scanId)) throw new WorkspaceScanCancelledError()
      if (!session || session.owner !== owner || session.invalidated)
        throw new Error('Invalid workspace scan token')
      const update = await session.progress.read(Number(params.afterRevision))
      if (session.invalidated || options.disposed()) throw new WorkspaceScanCancelledError()
      return {
        ...update.snapshot,
        scanId: params.scanId,
        revision: update.revision,
        complete: update.complete,
      }
    }

    if (this.active && this.active.session.owner !== owner) this.invalidate()
    if (this.active?.session.complete) this.active = null
    if (!this.active) {
      // Completed cursors remain readable across explicit refreshes, within a fixed budget.
      while (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!)
      const session: Session<S> = {
        owner,
        progress: new WorkspaceScanProgress(),
        invalidated: false,
        complete: false,
        failure: null,
      }
      const id = createRandomUuid()
      this.sessions.set(id, session)
      this.active = { id, session }
      const cancelled = () => session.invalidated || session.failure !== null || options.disposed()
      const fail = (error: unknown) => {
        session.failure ??= error instanceof Error ? error : new Error(String(error))
        session.progress.fail(session.failure)
      }
      const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation()
        } catch (error) {
          // Mark failure inside the slot before the queue can start another job.
          fail(error)
          throw error
        }
      }
      const discovered = new Map<S, W[]>()
      const completed = new Set<W>()
      const snapshot = () =>
        options.project(
          options.servers.flatMap(server =>
            (discovered.get(server) ?? []).filter(workspace => completed.has(workspace))
          )
        )
      const run = async () => {
        const servers = [...options.servers].sort(
          (a, b) => Number(b === owner) - Number(a === owner)
        )
        await Promise.all(
          servers.map(async server => {
            const workspaces = await this.queue.run(server === owner ? 0 : 2, () =>
              guarded(async () => {
                if (cancelled()) return []
                return options.discover(server, cancelled)
              })
            )
            if (cancelled()) return
            discovered.set(server, workspaces)
            const ordered = [...workspaces].sort(
              (a, b) => Number(b.projectActive) - Number(a.projectActive)
            )
            await Promise.all(
              ordered.map(workspace =>
                this.queue.run(workspace.projectActive ? 0 : 1, () =>
                  guarded(async () => {
                    if (cancelled()) return
                    await options.hydrate(workspace, cancelled)
                    if (cancelled()) return
                    completed.add(workspace)
                    session.progress.publish(snapshot())
                  })
                )
              )
            )
          })
        )
        if (cancelled()) return
        session.progress.finish(snapshot())
        session.complete = true
      }
      void run()
        .catch(fail)
        .finally(() => {
          if (this.active?.session === session) this.active = null
        })
    }
    const { id, session } = this.active
    let update = await session.progress.read(0)
    while (!progressive && !update.complete) update = await session.progress.read(update.revision)
    if (session.invalidated || options.disposed()) throw new WorkspaceScanCancelledError()
    return progressive
      ? { ...update.snapshot, scanId: id, revision: update.revision, complete: update.complete }
      : update.snapshot
  }
}
