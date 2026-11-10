import { createRandomUuid } from '@/lib/random-id'
import { getRuntimeConfig } from '@/config/runtime'
import { captureAccountContextRevision } from './accountContextEvents'
import { createMigrationSourceDirectoryIntent } from './migrationSourceDirectoryIntent'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './gatewayMigrationSourceSessions'
import { isMigrationDefinitionsDiscoverResult, type MigrationDefinitionsDiscoverResult, type MigrationSourceSummary,
  type MigrationSourceKind, type MigrationSourceSelectionV1, type MigrationSourceSessionParams } from '../../../shared/generated/contracts'

interface Resource {
  client: ReturnType<typeof createMigrationSourceSessionClient>; session: MigrationSourceSessionParams;
  kind: MigrationSourceKind; released: boolean; epoch: number; includeProject: boolean;
  directory: ReturnType<typeof createMigrationSourceDirectoryIntent>
}
type RootSelection = Parameters<typeof createMigrationSourceDirectoryIntent>[1]
interface Snapshot {
  busy: boolean; error: string | null; releasePending: boolean; session: MigrationSourceSessionParams | null;
  page: MigrationDefinitionsDiscoverResult | null; pageIndex: number; selected: MigrationSourceSummary[]
}
const empty = (): Snapshot => ({ busy: false, error: null, releasePending: false, session: null, page: null, pageIndex: 0, selected: [] })
function fail(): never { throw new MigrationSourceHttpError('source_transfer_definition_catalog_unavailable', false) }

/** Passive definition grants and source bindings stay in one owned child. Source labels never become target paths. */
export class MigrationDefinitionSourceDiscovery {
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
  private validate(value: unknown, resource: Resource, previous?: MigrationDefinitionsDiscoverResult, index = 0): MigrationDefinitionsDiscoverResult {
    if (!isMigrationDefinitionsDiscoverResult(value) || !value.catalogId || value.sources.length > 10
      || previous && value.catalogId !== previous.catalogId
      || value.sources.some(row => row.kind !== resource.kind || !row.sourceId)
      || new Set(value.sources.map(row => row.sourceId)).size !== value.sources.length
      || value.nextPage != null && (value.nextPage !== index + 1 || !value.sources.length)
      || previous && value.totalSources !== previous.totalSources
      || value.totalSources < index * 10 + value.sources.length) fail()
    return value
  }
  discover = async (kind: MigrationSourceKind, includeProject: boolean, root?: RootSelection) => {
    if (!this.visible() || this.flight) return
    this.flight = true; this.update({ busy: true, error: null, page: null, selected: [], pageIndex: 0 })
    let resource: Resource | null = null
    try {
      const desired = createMigrationSourceDirectoryIntent(kind, root), previous = this.resource
      const retry = previous && previous.epoch === this.epoch && !previous.released && previous.directory.pending() && previous.directory.matches(kind, root) && previous.includeProject === includeProject
      if (previous && !retry && !await this.release(previous)) {
        this.update({ releasePending: true }); throw new MigrationSourceHttpError('source_transfer_release_pending', false)
      }
      if (!this.visible()) return
      if (retry) resource = previous
      else {
        const identity = createRandomUuid(), account = captureAccountContextRevision(), mount = getRuntimeConfig().appBasePath
        const client = createMigrationSourceSessionClient({ captureScope: () => account(this.targetId) && getRuntimeConfig().appBasePath === mount ? identity : '' })
        resource = { client, session: { sessionId: identity, purpose: 'source', targetId: this.targetId, ...(this.workspacePath === undefined ? {} : { workspacePath: this.workspacePath }) },
          kind, directory: desired, released: false, epoch: this.epoch, includeProject }
      }
      const selected = resource
      this.resource = selected; this.update({ session: selected.session, releasePending: false })
      if ((await selected.client.open(selected.session)).status !== 'ready') throw new MigrationSourceHttpError('source_transfer_source_not_ready', false)
      if (!this.current(selected)) return
      await selected.directory.authorize(selected.client, selected.session, () => this.current(selected))
      if (!this.current(selected)) return
      const value = await selected.client.definitions(selected.session, { sources: [kind], includeProject, pageIndex: 0 })
      if (this.current(selected)) this.update({ page: this.validate(value, selected) })
    } catch (error) {
      this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_definition_catalog_unavailable', page: null, selected: [] })
    } finally {
      if (resource && !this.current(resource)) { resource.released = false; await this.release(resource) }
      this.flight = false; this.update({ busy: false })
    }
  }
  changePage = async (direction: 'previous' | 'next') => {
    const resource = this.resource, previous = this.state.page
    if (!resource || !previous || !this.current(resource) || this.flight) return
    const index = this.state.pageIndex + (direction === 'next' ? 1 : -1)
    if (index < 0 || index >= 26 || direction === 'next' && previous.nextPage == null) return
    this.flight = true; this.update({ busy: true, error: null })
    try {
      const value = await resource.client.definitions(resource.session, { sources: [resource.kind], includeProject: resource.includeProject, catalogId: previous.catalogId, pageIndex: index })
      if (!this.current(resource)) return
      const page = this.validate(value, resource, previous, index)
      if (page.sources.some(row => { const old = this.state.selected.find(old => old.sourceId === row.sourceId); return old && JSON.stringify(old) !== JSON.stringify(row) })) fail()
      this.update({ page, pageIndex: index })
    } catch { this.update({ error: 'source_transfer_definition_catalog_unavailable', page: null, selected: [] }) }
    finally { this.flight = false; this.update({ busy: false }) }
  }
  select = (sourceId: string, checked: boolean) => {
    const resource = this.resource
    if (!resource || !this.current(resource) || this.flight || !this.state.page) return
    const row = this.state.page.sources.find(row => row.sourceId === sourceId)
    if (!row) return
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
    } catch (error) { this.update({ error: 'source_transfer_definition_catalog_unavailable', selected: [] }); throw error }
    finally { this.flight = false; this.update({ busy: false }) }
  }
}
