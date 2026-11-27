import { createRandomUuid } from '@/lib/random-id'
import { getRuntimeConfig } from '@/config/runtime'
import { captureAccountContextRevision } from './accountContextEvents'
import { createMigrationSourceDirectoryIntent } from './migrationSourceDirectoryIntent'
import {
  createMigrationSourceSessionClient,
  MigrationSourceHttpError,
} from './gatewayMigrationSourceSessions'
import { transferablePlugin, validPluginDiscovery } from '../../../shared/migrationPlugins'
import type {
  MigrationPluginCandidate,
  MigrationPluginDiscoverResult,
  MigrationSourceKind,
  MigrationSourceSelectionV1,
  MigrationSourceSessionParams,
} from '../../../shared/generated/contracts'

type Root = Parameters<typeof createMigrationSourceDirectoryIntent>[1]
interface Resource {
  client: ReturnType<typeof createMigrationSourceSessionClient>
  session: MigrationSourceSessionParams
  kind: MigrationSourceKind
  includeProject: boolean
  uploaded: boolean
  released: boolean
  epoch: number
  directory: ReturnType<typeof createMigrationSourceDirectoryIntent>
  pages: MigrationPluginDiscoverResult[]
  cursors: Array<string | undefined>
}
interface Snapshot {
  busy: boolean
  error: string | null
  releasePending: boolean
  session: MigrationSourceSessionParams | null
  page: MigrationPluginDiscoverResult | null
  pageIndex: number
  selected: MigrationPluginCandidate[]
}
const empty = (): Snapshot => ({
  busy: false,
  error: null,
  releasePending: false,
  session: null,
  page: null,
  pageIndex: 0,
  selected: [],
})
const unavailable = () =>
  new MigrationSourceHttpError('source_transfer_plugin_catalog_unavailable', false)

/** Native candidate IDs remain bound to the same owned source child and cursor catalog. */
export class MigrationPluginSourceDiscovery {
  private state = empty()
  private readonly listeners = new Set<() => void>()
  private resource: Resource | null = null
  private active = true
  private flight = false
  private epoch = 0
  private readonly targetId: string
  private readonly workspacePath: string | undefined
  private readonly isCurrent: () => boolean
  constructor(targetId: string, workspacePath: string | undefined, isCurrent: () => boolean) {
    this.targetId = targetId
    this.workspacePath = workspacePath
    this.isCurrent = isCurrent
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  activate = () => {
    this.active = true
  }
  private visible() {
    return this.active && this.isCurrent()
  }
  private current(owner: Resource) {
    return this.visible() && this.resource === owner && owner.epoch === this.epoch
  }
  private update(patch: Partial<Snapshot>) {
    if (!this.visible()) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private async release(owner: Resource) {
    if (owner.released) return true
    try {
      owner.released = (await owner.client.close(owner.session)).status === 'released'
    } catch {
      // An unknown close retains this exact child; it never selects a replacement target.
    }
    return owner.released
  }
  dispose = () => {
    this.active = false
    this.epoch++
    if (this.resource) void this.release(this.resource)
  }
  close = async () => {
    const owner = this.resource
    if (!owner || !this.visible() || this.flight) return
    this.flight = true
    this.update({ busy: true })
    if (await this.release(owner)) {
      this.resource = null
      this.update(empty())
    } else this.update({ busy: false, releasePending: true, page: null, selected: [] })
    this.flight = false
  }
  discover = async (kind: MigrationSourceKind, includeProject: boolean, root?: Root) => {
    if (!this.visible() || this.flight) return
    this.flight = true
    this.update({ busy: true, error: null, page: null, selected: [], pageIndex: 0 })
    let owner: Resource | null = null
    try {
      const desired = createMigrationSourceDirectoryIntent(kind, root),
        previous = this.resource
      const retry =
        previous &&
        previous.epoch === this.epoch &&
        !previous.released &&
        previous.directory.pending() &&
        previous.directory.matches(kind, root) &&
        previous.includeProject === includeProject
      if (previous && !retry && !(await this.release(previous))) {
        this.update({ releasePending: true })
        throw new MigrationSourceHttpError('source_transfer_release_pending', false)
      }
      if (!this.visible()) return
      if (retry) owner = previous
      else {
        const identity = createRandomUuid(),
          account = captureAccountContextRevision(),
          mount = getRuntimeConfig().appBasePath
        owner = {
          client: createMigrationSourceSessionClient({
            captureScope: () =>
              account(this.targetId) && getRuntimeConfig().appBasePath === mount ? identity : '',
          }),
          session: {
            sessionId: identity,
            purpose: 'source',
            targetId: this.targetId,
            ...(this.workspacePath === undefined ? {} : { workspacePath: this.workspacePath }),
          },
          kind,
          includeProject,
          uploaded: typeof root === 'object',
          released: false,
          epoch: this.epoch,
          directory: desired,
          pages: [],
          cursors: [undefined],
        }
      }
      const selected = owner
      this.resource = selected
      this.update({ session: selected.session, releasePending: false })
      if ((await selected.client.open(selected.session)).status !== 'ready') throw unavailable()
      if (!this.current(selected)) return
      await selected.directory.authorize(selected.client, selected.session, () =>
        this.current(selected)
      )
      if (!this.current(selected)) return
      const params = {
          sources: [kind],
          includeProject,
          ...(selected.uploaded ? { includeUploaded: true } : {}),
        },
        page = await selected.client.plugins(selected.session, params)
      if (!validPluginDiscovery(params, page)) throw unavailable()
      if (this.current(selected)) {
        selected.pages = [page]
        selected.cursors = [undefined]
        this.update({ page })
      }
    } catch (error) {
      this.update({
        error: error instanceof MigrationSourceHttpError ? error.code : unavailable().code,
        page: null,
        selected: [],
      })
    } finally {
      if (owner && !this.current(owner)) {
        owner.released = false
        await this.release(owner)
      }
      this.flight = false
      this.update({ busy: false })
    }
  }
  changePage = async (direction: 'previous' | 'next') => {
    const owner = this.resource,
      previous = this.state.page
    if (!owner || !previous || !this.current(owner) || this.flight) return
    const index = this.state.pageIndex + (direction === 'next' ? 1 : -1)
    if (index < 0 || index >= 410 || (direction === 'next' && previous.nextCursor == null)) return
    if (owner.pages[index]) {
      this.update({ page: owner.pages[index], pageIndex: index })
      return
    }
    this.flight = true
    this.update({ busy: true, error: null })
    try {
      const cursor = previous.nextCursor!
      if (owner.cursors.includes(cursor)) throw unavailable()
      const params = {
        sources: [owner.kind],
        includeProject: owner.includeProject,
        ...(owner.uploaded ? { includeUploaded: true } : {}),
        cursor,
      }
      const page = await owner.client.plugins(owner.session, params)
      if (!this.current(owner)) return
      if (
        !validPluginDiscovery(params, page) ||
        page.candidates.some(row =>
          owner.pages.some(old => old.candidates.some(item => item.candidateId === row.candidateId))
        )
      )
        throw unavailable()
      owner.pages[index] = page
      owner.cursors[index] = cursor
      this.update({ page, pageIndex: index })
    } catch {
      this.update({ error: unavailable().code, page: null, selected: [] })
    } finally {
      this.flight = false
      this.update({ busy: false })
    }
  }
  select = (candidateId: string, checked: boolean) => {
    const owner = this.resource
    if (!owner || !this.current(owner) || this.flight || !this.state.page) return
    const row = this.state.page.candidates.find(row => row.candidateId === candidateId)
    if (
      !row ||
      !transferablePlugin(row) ||
      (row.scope !== 'user' && !owner.includeProject && !owner.uploaded)
    )
      return
    const selected = this.state.selected.filter(item => item.candidateId !== candidateId)
    if (checked) {
      if (selected.length >= 64) return
      selected.push(row)
    }
    this.update({ selected })
  }
  selections = (): MigrationSourceSelectionV1[] => {
    const owner = this.resource
    if (
      !owner ||
      !this.current(owner) ||
      this.flight ||
      !this.state.page ||
      !this.state.selected.length
    )
      throw unavailable()
    // The Host resolves each opaque candidate again against this child's original catalog.
    return this.state.selected.map(row => ({ kind: 'plugin', candidateId: row.candidateId }))
  }
}
