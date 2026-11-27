import { isMigrationHistorySourcesResult, type MigrationBatchHistorySource, type MigrationHistorySourcesResult,
  type MigrationSourceKind } from '../../../shared/generated/contracts'
import { HistoryFamilyCache, validHistorySources, type HistoryFamilyGroup } from '../../../shared/migrationHistoryFamilies'
import type { createMigrationApi } from './gatewayMigration'

const empty = () => ({ catalog: null as MigrationHistorySourcesResult | null, selections: [] as MigrationBatchHistorySource[], page: 0,
  busy: false, error: '', familyGroups: null as HistoryFamilyGroup[] | null, familyMode: false })
const inactive = empty()

/** One API/target and source choice own the entire cursor and display-cache lifetime. */
export class MigrationBatchHistoryDiscovery {
  private state = empty()
  private readonly listeners = new Set<() => void>()
  private readonly api: ReturnType<typeof createMigrationApi>
  readonly kind: MigrationSourceKind
  private valid: () => boolean = () => false
  private active = true
  private epoch = 0
  private pending: AbortController | null = null
  private cursors: Array<string | undefined> = [undefined]
  private family: { scope: string; cache: HistoryFamilyCache } | null = null
  constructor(api: ReturnType<typeof createMigrationApi>, kind: MigrationSourceKind) { this.api = api; this.kind = kind }
  current(valid: () => boolean) {
    const wasCurrent = this.visible(); this.valid = valid
    if (wasCurrent && !this.visible()) { this.epoch++; this.pending?.abort(); this.pending = null; this.family = null; this.state = empty() }
    for (const listener of this.listeners) listener()
  }
  private visible() { return this.active && this.valid() }
  snapshot = () => this.visible() ? this.state : inactive
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<ReturnType<typeof empty>>) {
    if (!this.visible()) return
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener()
  }
  reset = () => {
    this.epoch++; this.pending?.abort(); this.pending = null; this.cursors = [undefined]; this.family = null
    this.update(empty())
  }
  activate = () => { if (!this.active) { this.active = true; this.reset() } }
  dispose = () => { this.active = false; this.epoch++; this.pending?.abort(); this.pending = null; this.family = null; this.state = empty() }
  private async load(index?: number, families = this.state.familyMode) {
    if (!this.visible() || this.state.busy || index != null && !this.state.catalog) return
    const revision = this.epoch, previous = this.state.catalog, controller = new AbortController()
    this.pending = controller
    if (index == null) {
      const scope = JSON.stringify([this.kind, revision, this.cursors])
      this.family = families ? { scope, cache: new HistoryFamilyCache(scope) } : null
      this.cursors = [undefined]; this.update({ catalog: null, selections: [], page: 0, familyGroups: null, familyMode: families })
    }
    const family = this.family
    this.update({ busy: true, error: '' })
    try {
      if (families && this.kind !== 'codex') throw new Error('migration_invalid_history_catalog')
      const value = index == null ? families ? await this.api.historyFamilies({ source: 'codex' }, { signal: controller.signal })
        : await this.api.historyDiscover({ source: this.kind }, { signal: controller.signal })
        : await this.api.historySources({ catalogId: previous!.catalogId, cursor: this.cursors[index] }, { signal: controller.signal })
      if (!this.visible() || revision !== this.epoch || controller.signal.aborted) return
      if (!isMigrationHistorySourcesResult(value) || value.items.length > 10 || value.items.some(item => item.source !== this.kind)
        || index != null && value.catalogId !== previous?.catalogId) throw new Error('migration_invalid_history_catalog')
      if (families && !validHistorySources('codex', value, index == null ? undefined : { catalogId: previous!.catalogId,
        totalItems: previous!.totalItems, cursor: this.cursors[index] })) throw new Error('migration_invalid_history_catalog')
      const groups = family?.cache.observe(family.scope, value) ?? null, current = index ?? 0
      if (value.nextCursor && this.cursors.slice(0, current + 1).includes(value.nextCursor)) throw new Error('migration_invalid_history_catalog')
      if (value.nextCursor) this.cursors[current + 1] = value.nextCursor; else this.cursors.length = current + 1
      this.update({ catalog: value, familyGroups: groups, page: current })
    } catch (cause) {
      if (!this.visible() || revision !== this.epoch || controller.signal.aborted) return
      const raw = cause instanceof Error ? cause.message : ''
      const unavailable = ['source_transfer_history_catalog_unavailable', 'source_transfer_catalog_expired',
        'history_discovery_family_metadata_changed', 'history_discovery_catalog_unavailable', 'history_discovery_expired'].includes(raw)
      if (families || unavailable) { this.family = null; this.update({ catalog: null, selections: [], familyGroups: null }) }
      this.update({ error: unavailable ? 'history_discovery_catalog_unavailable' : raw.match(/\b(?:migration|history)_[a-z_]+\b/)?.[0] ?? 'error' })
    } finally {
      if (revision === this.epoch) { this.pending = null; this.update({ busy: false }) }
    }
  }
  discover = () => this.load(undefined, false)
  discoverFamilies = () => this.load(undefined, true)
  paginate = (direction: -1 | 1) => this.state.catalog && this.state.page + direction >= 0
    && (direction < 0 || this.state.catalog.nextCursor) ? this.load(this.state.page + direction) : Promise.resolve()
  checked = (handle: string) => Boolean(this.state.catalog && this.state.selections.some(row => row.catalogId === this.state.catalog!.catalogId && row.sourceHandle === handle))
  toggle = (handle: string, checked: boolean) => {
    const catalog = this.state.catalog
    if (!this.visible() || this.state.busy || !catalog || !catalog.items.some(item => item.sourceHandle === handle && item.importIssues.length === 0)) return
    const selections = this.state.selections.filter(row => row.sourceHandle !== handle)
    if (checked && selections.length < 64) selections.push({ catalogId: catalog.catalogId, sourceHandle: handle })
    this.update({ selections })
  }
}
