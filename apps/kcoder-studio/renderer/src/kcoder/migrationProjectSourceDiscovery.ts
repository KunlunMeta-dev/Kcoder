import { PROJECTS_METHODS, validProjectCall } from '../../../shared/migrationProjects'
import { createRandomUuid } from '@/lib/random-id'
import { getRuntimeConfig } from '@/config/runtime'
import { captureAccountContextRevision } from './accountContextEvents'
import { createMigrationSourceDirectoryIntent } from './migrationSourceDirectoryIntent'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './gatewayMigrationSourceSessions'
import { isMigrationProjectSourcesResult, type MigrationProjectSourcesResult, type MigrationProjectSourceSummary,
  type MigrationSourceKind, type MigrationSourceSelectionV1, type MigrationSourceSessionParams } from '../../../shared/generated/contracts'

interface Resource {
  client: ReturnType<typeof createMigrationSourceSessionClient>; session: MigrationSourceSessionParams;
  kind: MigrationSourceKind; released: boolean; epoch: number; cursors: Array<string | null>;
  directory: ReturnType<typeof createMigrationSourceDirectoryIntent>
}
type RootSelection = Parameters<typeof createMigrationSourceDirectoryIntent>[1]
interface Snapshot {
  busy: boolean; error: string | null; releasePending: boolean; session: MigrationSourceSessionParams | null;
  page: MigrationProjectSourcesResult | null; pageIndex: number; selected: MigrationProjectSourceSummary[]
}
const empty = (): Snapshot => ({ busy: false, error: null, releasePending: false, session: null, page: null, pageIndex: 0, selected: [] })
function fail(): never { throw new MigrationSourceHttpError('source_transfer_project_catalog_unavailable', false) }

/** Project rows and source bindings stay in one owned child. Source labels never become target paths. */
export class MigrationProjectSourceDiscovery {
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
    this.targetId = targetId; this.workspacePath = workspacePath; this.isCurrent = isCurrent
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  activate = () => { this.active = true }
  private visible() { return this.active && this.isCurrent() }
  private current(resource: Resource) { return this.visible() && this.resource === resource && resource.epoch === this.epoch }
  private update(patch: Partial<Snapshot>) {
    if (!this.visible()) return
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener()
  }
  private async release(resource: Resource) {
    if (resource.released) return true
    try { resource.released = (await resource.client.close(resource.session)).status === 'released' } catch {
      // Retain the original child identity when close is unknown; never close a peer session.
    }
    return resource.released
  }
  dispose = () => { this.active = false; this.epoch++; if (this.resource) void this.release(this.resource) }
  close = async () => {
    const resource = this.resource
    if (!resource || !this.visible() || this.flight) return
    this.flight = true; this.update({ busy: true })
    const released = await this.release(resource)
    if (released) { this.resource = null; this.update(empty()) }
    else this.update({ busy: false, releasePending: true, page: null, selected: [] })
    this.flight = false
  }
  private validate(value: unknown, resource: Resource, previous?: MigrationProjectSourcesResult, index = 0): MigrationProjectSourcesResult {
    const method = previous ? PROJECTS_METHODS.sources : PROJECTS_METHODS.discover
    const params = previous ? { catalogId: previous.catalogId, pageIndex: index } : { source: resource.kind }
    if (!isMigrationProjectSourcesResult(value) || !validProjectCall(method, params, value) || value.source !== resource.kind
      || previous && (value.totalItems !== previous.totalItems || value.formatRevision !== previous.formatRevision)
      || value.items.some(row => { const old = this.state.selected.find(old => old.sourceHandle === row.sourceHandle); return old && JSON.stringify(old) !== JSON.stringify(row) })) fail()
    return value
  }
  discover = async (kind: MigrationSourceKind, root?: RootSelection) => {
    if (!this.visible() || this.flight) return
    this.flight = true; this.update({ busy: true, error: null, page: null, selected: [], pageIndex: 0 })
    let resource: Resource | null = null
    try {
      const desired = createMigrationSourceDirectoryIntent(kind, root), previous = this.resource
      const retry = previous && previous.epoch === this.epoch && !previous.released && previous.directory.pending() && previous.directory.matches(kind, root)
      if (previous && !retry && !await this.release(previous)) {
        this.update({ releasePending: true }); throw new MigrationSourceHttpError('source_transfer_release_pending', false)
      }
      if (!this.visible()) return
      if (retry) resource = previous
      else {
        const identity = createRandomUuid(), account = captureAccountContextRevision(), mount = getRuntimeConfig().appBasePath
        const client = createMigrationSourceSessionClient({ captureScope: () => account(this.targetId) && getRuntimeConfig().appBasePath === mount ? identity : '' })
        resource = { client, session: { sessionId: identity, purpose: 'source', targetId: this.targetId, ...(this.workspacePath === undefined ? {} : { workspacePath: this.workspacePath }) },
          kind, directory: desired, released: false, epoch: this.epoch, cursors: [null] }
      }
      const selected = resource
      this.resource = selected; this.update({ session: selected.session, releasePending: false })
      if ((await selected.client.open(selected.session)).status !== 'ready') throw new MigrationSourceHttpError('source_transfer_source_not_ready', false)
      if (!this.current(selected)) return
      await selected.directory.authorize(selected.client, selected.session, () => this.current(selected))
      if (!this.current(selected)) return
      const value = await selected.client.query({ session: selected.session, query: { kind: 'projects', params: { source: kind } } })
      if (this.current(selected)) this.update({ page: this.validate(value, selected) })
    } catch (error) {
      this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_project_catalog_unavailable', page: null, selected: [] })
    } finally {
      if (resource && !this.current(resource)) { resource.released = false; await this.release(resource) }
      this.flight = false; this.update({ busy: false })
    }
  }
  changePage = async (direction: 'previous' | 'next') => {
    const resource = this.resource, previous = this.state.page
    if (!resource || !previous || !this.current(resource) || this.flight) return
    const index = this.state.pageIndex + (direction === 'next' ? 1 : -1)
    if (index < 0 || index >= 1024 || direction === 'next' && previous.nextPage == null) return
    this.flight = true; this.update({ busy: true, error: null })
    try {
      const value = await resource.client.query({ session: resource.session, query: { kind: 'projects_page', params: { catalogId: previous.catalogId, pageIndex: index } } })
      if (!this.current(resource)) return
      const page = this.validate(value, resource, previous, index)
      this.update({ page, pageIndex: index })
    } catch { this.update({ error: 'source_transfer_project_catalog_unavailable', page: null, selected: [] }) }
    finally { this.flight = false; this.update({ busy: false }) }
  }
  select = (sourceHandle: string, checked: boolean) => {
    const resource = this.resource
    if (!resource || !this.current(resource) || this.flight || !this.state.page) return
    const row = this.state.page.items.find(row => row.sourceHandle === sourceHandle)
    if (!row) return
    const selected = this.state.selected.filter(row => row.sourceHandle !== sourceHandle)
    if (checked) { if (selected.length >= 64) return; selected.push(row) }
    this.update({ selected })
  }
  selections = async (): Promise<MigrationSourceSelectionV1[]> => {
    const resource = this.resource, page = this.state.page
    if (!resource || !page || !this.current(resource) || this.flight || !this.state.selected.length || this.state.selected.length > 64) fail()
    return this.state.selected.map(row => ({ kind: 'projects', catalogId: page.catalogId, sourceHandle: row.sourceHandle }))
  }
}
