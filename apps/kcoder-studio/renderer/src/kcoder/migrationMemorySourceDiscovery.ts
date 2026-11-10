import { createRandomUuid } from '@/lib/random-id'
import { getRuntimeConfig } from '@/config/runtime'
import { captureAccountContextRevision } from './accountContextEvents'
import { createMigrationSourceDirectoryIntent } from './migrationSourceDirectoryIntent'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './gatewayMigrationSourceSessions'
import { isMigrationMemorySourcesResult, type MigrationMemorySourcesResult, type ImportedMemorySourceSummary,
  type MigrationSourceKind, type MigrationSourceSelectionV1, type MigrationSourceSessionParams } from '../../../shared/generated/contracts'

interface Resource {
  client: ReturnType<typeof createMigrationSourceSessionClient>; session: MigrationSourceSessionParams;
  kind: MigrationSourceKind; released: boolean; epoch: number; cursors: Array<string | null>;
  directory: ReturnType<typeof createMigrationSourceDirectoryIntent>
}
type RootSelection = Parameters<typeof createMigrationSourceDirectoryIntent>[1]
interface Snapshot {
  busy: boolean; error: string | null; releasePending: boolean; session: MigrationSourceSessionParams | null;
  page: MigrationMemorySourcesResult | null; pageIndex: number; selected: ImportedMemorySourceSummary[]
}
const empty = (): Snapshot => ({ busy: false, error: null, releasePending: false, session: null, page: null, pageIndex: 0, selected: [] })
function fail(): never { throw new MigrationSourceHttpError('source_transfer_memory_catalog_unavailable', false) }

/** Memory grants and source bindings stay in one owned child. Source labels never become target paths. */
export class MigrationMemorySourceDiscovery {
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
  private validate(value: unknown, resource: Resource, previous?: MigrationMemorySourcesResult, cursor?: string | null): MigrationMemorySourcesResult {
    if (!isMigrationMemorySourcesResult(value) || !value.catalogId || value.items.length > 10
      || previous && value.catalogId !== previous.catalogId
      || value.items.some(row => row.source !== resource.kind || !row.sourceId)
      || new Set(value.items.map(row => row.sourceId)).size !== value.items.length
      || value.nextCursor && (value.nextCursor === cursor || !value.items.length)) fail()
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
      const value = await selected.client.query({ session: selected.session, query: { kind: 'memory', params: { source: kind } } })
      if (this.current(selected)) this.update({ page: this.validate(value, selected) })
    } catch (error) {
      this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_memory_catalog_unavailable', page: null, selected: [] })
    } finally {
      if (resource && !this.current(resource)) { resource.released = false; await this.release(resource) }
      this.flight = false; this.update({ busy: false })
    }
  }
  changePage = async (direction: 'previous' | 'next') => {
    const resource = this.resource, previous = this.state.page
    if (!resource || !previous || !this.current(resource) || this.flight) return
    const index = this.state.pageIndex + (direction === 'next' ? 1 : -1)
    if (index < 0 || index >= 1024 || direction === 'next' && !previous.nextCursor) return
    const cursor = direction === 'next' ? previous.nextCursor : resource.cursors[index]
    if (cursor === undefined) return
    this.flight = true; this.update({ busy: true, error: null })
    try {
      const value = await resource.client.query({ session: resource.session, query: { kind: 'memory_page', params: { catalogId: previous.catalogId, cursor } } })
      if (!this.current(resource)) return
      const page = this.validate(value, resource, previous, cursor)
      if (direction === 'next' && page.nextCursor && resource.cursors.slice(0, index + 1).includes(page.nextCursor)) fail()
      resource.cursors[index] = cursor; this.update({ page, pageIndex: index })
    } catch { this.update({ error: 'source_transfer_memory_catalog_unavailable', page: null, selected: [] }) }
    finally { this.flight = false; this.update({ busy: false }) }
  }
  select = (sourceId: string, checked: boolean) => {
    const resource = this.resource
    if (!resource || !this.current(resource) || this.flight || !this.state.page) return
    const row = this.state.page.items.find(row => row.sourceId === sourceId)
    if (!row || !row.files) return
    const selected = this.state.selected.filter(row => row.sourceId !== sourceId)
    if (checked) { if (selected.length >= 64) return; selected.push(row) }
    this.update({ selected })
  }
  selections = async (): Promise<MigrationSourceSelectionV1[]> => {
    const resource = this.resource
    if (!resource || !this.current(resource) || this.flight || !this.state.page || !this.state.selected.length || this.state.selected.length > 64) fail()
    this.flight = true; this.update({ busy: true, error: null })
    try {
      const ids = this.state.selected.map(row => row.sourceId), selected: MigrationSourceSelectionV1[] = []
      for (let start = 0; start < ids.length; start += 10) {
        const expected = ids.slice(start, start + 10), page = await resource.client.bindings(resource.session, expected)
        if (!this.current(resource)) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
        if (page.bindings.length !== expected.length || page.bindings.some((row, index) => row.sourceId !== expected[index] || row.family !== 'assets')) fail()
        selected.push(...page.bindings.map(row => ({ kind: 'assets' as const, sourceId: row.sourceId })))
      }
      return selected
    } catch (error) { this.update({ error: 'source_transfer_memory_catalog_unavailable', selected: [] }); throw error }
    finally { this.flight = false; this.update({ busy: false }) }
  }
}
