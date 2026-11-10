import type { MigrationBatchProjectSource, MigrationProjectSourcesResult, MigrationProjectSourceSummary, MigrationSourceKind } from './generated/contracts'

type Api = {
  discover(source: MigrationSourceKind): Promise<MigrationProjectSourcesResult>
  page(catalogId: string, pageIndex: number): Promise<MigrationProjectSourcesResult>
  prepare(sources: MigrationBatchProjectSource[]): Promise<string>
}
const empty = () => ({ busy: false, error: null as string | null, page: null as MigrationProjectSourcesResult | null,
  kind: 'claude-code' as MigrationSourceKind, selected: [] as MigrationProjectSourceSummary[], partial: false, unknown: false })

/** Only observed handles in the original catalog can enter an ordinary batch. */
export class ProjectSourcesController {
  private value = empty()
  private active = true
  private generation = 0
  private readonly api: Api
  private readonly currentScope: () => boolean
  private readonly listeners = new Set<() => void>()
  constructor(api: Api, current: () => boolean) { this.api = api; this.currentScope = current }
  snapshot = () => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  activate = () => { this.active = true }
  dispose = () => { this.active = false; this.generation++ }
  current = () => this.active && this.currentScope()
  private patch(value: Partial<ReturnType<typeof empty>>) { if (this.current()) { this.value = { ...this.value, ...value }; for (const listener of this.listeners) listener() } }
  configure = (kind: MigrationSourceKind) => { if (!this.value.busy && !this.value.unknown) this.patch({ ...empty(), kind }) }
  consent = (partial: boolean) => { if (!this.value.busy) this.patch({ partial }) }
  select = (handle: string) => {
    if (!this.current() || this.value.busy || this.value.unknown) return
    const row = this.value.page?.items.find(row => row.sourceHandle === handle)
    if (!row) return
    const selected = this.value.selected.filter(row => row.sourceHandle !== handle)
    if (selected.length === this.value.selected.length) { if (selected.length >= 64) return; selected.push(row) }
    this.patch({ selected })
  }
  discover = async () => {
    if (!this.current() || this.value.busy || this.value.unknown) return
    const epoch = ++this.generation, kind = this.value.kind
    this.patch({ busy: true, error: null, page: null, selected: [], partial: false })
    try { const page = await this.api.discover(kind); if (epoch === this.generation && this.current()) this.patch({ page }) }
    catch (error) { if (epoch === this.generation) this.patch({ error: error instanceof Error && error.message === 'migration_projects_update_required' ? 'updateRequired' : 'failed' }) }
    finally { if (epoch === this.generation) this.patch({ busy: false }) }
  }
  page = async (pageIndex: number) => {
    const previous = this.value.page
    if (!previous || !this.current() || this.value.busy || this.value.unknown) return
    const epoch = this.generation
    this.patch({ busy: true, error: null })
    try {
      const page = await this.api.page(previous.catalogId, pageIndex)
      if (epoch !== this.generation || !this.current()) return
      if (page.catalogId !== previous.catalogId || page.source !== previous.source || page.totalItems !== previous.totalItems
        || page.items.some(row => { const old = this.value.selected.find(old => old.sourceHandle === row.sourceHandle); return old && JSON.stringify(old) !== JSON.stringify(row) })) throw new Error('changed')
      this.patch({ page })
    } catch { if (epoch === this.generation) this.patch({ error: 'changed', page: null, selected: [] }) }
    finally { if (epoch === this.generation) this.patch({ busy: false }) }
  }
  prepare = async (): Promise<string | null> => {
    const page = this.value.page
    if (!page || !this.current() || this.value.busy || this.value.unknown || !this.value.selected.length
      || (!page.knownRowsComplete || page.problems.length > 0) && !this.value.partial) return null
    const epoch = this.generation
    this.patch({ busy: true, error: null })
    try {
      const id = await this.api.prepare(this.value.selected.map(row => ({ catalogId: page.catalogId, sourceHandle: row.sourceHandle })))
      return epoch === this.generation && this.current() ? id : null
    } catch { if (epoch === this.generation) this.patch({ unknown: true, error: 'unknown' }); return null }
    finally { if (epoch === this.generation) this.patch({ busy: false }) }
  }
}
