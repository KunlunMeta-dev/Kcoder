import { createRandomUuid } from '@/lib/random-id'
import { captureAccountContextRevision } from './accountContextEvents'
import { getRuntimeConfig } from '@/config/runtime'
import { createMigrationSourceDirectoryIntent, type MigrationSourceLocation } from './migrationSourceDirectoryIntent'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './gatewayMigrationSourceSessions'
import { isMigrationHistorySourcesResult } from '../../../shared/generated/contracts'
import { HistoryFamilyCache, validHistorySources, type HistoryFamilyGroup } from '../../../shared/migrationHistoryFamilies'
import type { HistorySourceSummary, MigrationHistorySourcesResult, MigrationSourceKind, MigrationSourceSelectionV1, MigrationSourceSessionParams } from '../../../shared/generated/contracts'

interface OwnedCatalog {
  client: ReturnType<typeof createMigrationSourceSessionClient>
  session: MigrationSourceSessionParams
  kind: MigrationSourceKind
  released: boolean
  cursors: Array<string | null>
  directory: ReturnType<typeof createMigrationSourceDirectoryIntent>
  families: HistoryFamilyCache | null
  familyScope: string
}
interface Snapshot {
  busy: boolean
  error: string | null
  releasePending: boolean
  session: MigrationSourceSessionParams | null
  page: MigrationHistorySourcesResult | null
  pageIndex: number
  selected: HistorySourceSummary[]
  familyGroups: HistoryFamilyGroup[] | null
  familyMode: boolean
}
const empty = (): Snapshot => ({ busy: false, error: null, releasePending: false, session: null, page: null, pageIndex: 0, selected: [], familyGroups: null, familyMode: false })
function fail(code: string): never { throw new MigrationSourceHttpError(code, false) }

/** Opaque catalogs stay in one source child; explicit directories require separate Native authorization. */
export class MigrationHistorySourceDiscovery {
  private state = empty()
  private readonly listeners = new Set<() => void>()
  private resource: OwnedCatalog | null = null
  private active = true
  private flight = false
  private readonly targetId: string
  private readonly workspacePath: string | undefined
  private readonly isCurrent: () => boolean
  constructor(targetId: string, workspacePath: string | undefined, isCurrent: () => boolean) {
    this.targetId = targetId; this.workspacePath = workspacePath; this.isCurrent = isCurrent
  }
  snapshot = (): Snapshot => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  activate = () => { this.active = true }
  private visible() { return this.active && this.isCurrent() }
  private update(patch: Partial<Snapshot>) {
    if (!this.visible()) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private async release(resource: OwnedCatalog) {
    if (resource.released) return true
    try { resource.released = (await resource.client.close(resource.session)).status === 'released' } catch {
      // Keep the original owner when cleanup is unconfirmed. Never retarget it.
    }
    return resource.released
  }
  dispose = () => {
    this.active = false
    if (this.resource) void this.release(this.resource)
  }
  close = async () => {
    if (this.flight || !this.visible() || !this.resource) return
    const resource = this.resource
    this.flight = true; this.update({ busy: true })
    const released = await this.release(resource)
    if (released) { this.resource = null; this.update({ ...empty() }) }
    else this.update({ releasePending: true, busy: false, page: null, selected: [], familyGroups: null })
    this.flight = false
  }
  private validate(page: MigrationHistorySourcesResult, resource: OwnedCatalog, previous?: MigrationHistorySourcesResult, cursor?: string | null) {
    if (!page.catalogId || page.items.length > 10 || !Number.isSafeInteger(page.totalItems) || page.totalItems < page.items.length ||
      previous && (page.catalogId !== previous.catalogId || page.totalItems !== previous.totalItems) ||
      page.items.some(item => item.source !== resource.kind || !item.sourceHandle) ||
      new Set(page.items.map(item => item.sourceHandle)).size !== page.items.length ||
      page.totalItems > 0 && !page.items.length ||
      page.nextCursor && page.nextCursor === cursor) fail('source_transfer_history_catalog_unavailable')
    if (resource.families && !validHistorySources('codex', page, previous ? { catalogId: previous.catalogId, totalItems: previous.totalItems, cursor } : undefined)) fail('source_transfer_history_catalog_unavailable')
    return page
  }
  discover = async (kind: MigrationSourceKind, directory?: MigrationSourceLocation, families = false) => {
    if (!this.visible() || this.flight) return
    this.flight = true; this.update({ busy: true, error: null, page: null, selected: [], pageIndex: 0, familyGroups: null, familyMode: families })
    let resource: OwnedCatalog | null = null
    try {
      if (families && kind !== 'codex') fail('source_transfer_history_catalog_unavailable')
      const desired = createMigrationSourceDirectoryIntent(kind, directory), previous = this.resource
      const retry = previous && !previous.released && Boolean(previous.families) === families && previous.directory.pending() && previous.directory.matches(kind, directory)
      if (previous && !retry && !await this.release(previous)) {
        this.update({ releasePending: true }); fail('source_transfer_release_pending')
      }
      if (!this.visible()) return
      if (retry) resource = previous
      else {
        const accountCurrent = captureAccountContextRevision(), id = createRandomUuid(), mount = getRuntimeConfig().appBasePath
        const client = createMigrationSourceSessionClient({ captureScope: () => accountCurrent(this.targetId) && getRuntimeConfig().appBasePath === mount ? id : '' })
        const familyScope = JSON.stringify([id, this.targetId, this.workspacePath ?? null])
        resource = { client, session: { sessionId: id, purpose: 'source', targetId: this.targetId,
          ...(this.workspacePath === undefined ? {} : { workspacePath: this.workspacePath }) }, kind, released: false, cursors: [null], directory: desired,
          families: families ? new HistoryFamilyCache(familyScope) : null, familyScope }
      }
      this.resource = resource; this.update({ session: resource.session, releasePending: false })
      if ((await resource.client.open(resource.session)).status !== 'ready') fail('source_transfer_source_not_ready')
      if (!this.visible()) return
      const selected = resource
      await selected.directory.authorize(selected.client, selected.session, () => this.visible() && this.resource === selected)
      if (!this.visible() || this.resource !== selected) fail('source_transfer_authority_changed')
      const value = families ? await selected.client.historyFamilies(selected.session, { source: 'codex' })
        : await selected.client.query({ session: selected.session, query: { kind: 'history', params: { source: kind } } })
      if (!isMigrationHistorySourcesResult(value)) fail('source_transfer_history_catalog_unavailable')
      const page = this.validate(value, resource)
      const familyGroups = resource.families?.observe(resource.familyScope, page) ?? null
      if (this.resource === resource) this.update({ page, familyGroups })
    } catch (error) {
      this.update({ error: error instanceof MigrationSourceHttpError ? error.code : 'source_transfer_history_catalog_unavailable', page: null, selected: [], familyGroups: null })
    } finally {
      if (!this.visible() && resource) {
        // The initial close may have raced the pending open; reconcile only this original session.
        resource.released = false; await this.release(resource)
      }
      this.flight = false; this.update({ busy: false })
    }
  }
  page = async (direction: 'previous' | 'next') => {
    const resource = this.resource, previous = this.state.page
    if (!resource || !previous || this.flight || !this.visible()) return
    const index = this.state.pageIndex + (direction === 'next' ? 1 : -1)
    if (index < 0 || index >= 1024 || direction === 'next' && !previous.nextCursor) return
    const cursor = direction === 'next' ? previous.nextCursor : resource.cursors[index]
    if (cursor === undefined) return
    this.flight = true; this.update({ busy: true, error: null })
    try {
      const value = await resource.client.query({ session: resource.session, query: { kind: 'history_page', params: { catalogId: previous.catalogId, cursor } } })
      if (!this.visible() || this.resource !== resource) return
      if (!isMigrationHistorySourcesResult(value)) fail('source_transfer_history_catalog_unavailable')
      const page = this.validate(value, resource, previous, cursor), stored = resource.cursors
      // A previously visited next cursor is valid when moving backwards, but never a cycle forwards.
      if (direction === 'next' && page.nextCursor && stored.slice(0, index + 1).includes(page.nextCursor)) fail('source_transfer_history_catalog_unavailable')
      resource.cursors[index] = cursor
      resource.cursors.length = Math.max(resource.cursors.length, index + 1)
      const familyGroups = resource.families?.observe(resource.familyScope, page) ?? null
      this.update({ page, pageIndex: index, familyGroups })
    } catch (error) {
      // Expired/invalid catalogs cannot retain transferable selections. Rediscovery is explicit.
      this.update({ error: error instanceof MigrationSourceHttpError && error.code === 'source_transfer_catalog_expired' ? error.code : 'source_transfer_history_catalog_unavailable', page: null, selected: [], familyGroups: null })
    } finally { this.flight = false; this.update({ busy: false }) }
  }
  select = (handle: string, checked: boolean) => {
    if (!this.visible() || this.flight || !this.state.page || !this.resource || this.resource.released) return
    const item = this.state.page.items.find(row => row.sourceHandle === handle)
    if (!item || item.importIssues.length) return
    const selected = this.state.selected.filter(row => row.sourceHandle !== handle)
    if (checked) { if (selected.length >= 64) return; selected.push(item) }
    this.update({ selected })
  }
  selections = (): MigrationSourceSelectionV1[] => {
    if (!this.visible() || this.flight || !this.resource || this.resource.released || !this.state.page || !this.state.selected.length || this.state.selected.length > 64) fail('source_transfer_history_catalog_unavailable')
    return this.state.selected.map(item => ({ kind: 'history', catalogId: this.state.page!.catalogId, sourceHandle: item.sourceHandle }))
  }
}
