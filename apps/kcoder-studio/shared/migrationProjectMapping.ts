import type { MigrationBatchChoice, MigrationProjectReportResult, MigrationProjectReportRow,
  MigrationProjectTargetsResult, MigrationProjectTargetRootsResult, MigrationProjectTargetRoot, MigrationProjectTargetSummary } from './generated/contracts'
import type { createProjectsApi } from './migrationProjects'

type Api = ReturnType<typeof createProjectsApi>
type SourceRoot = { id: string; ordinal: number; path: string }
export type ProjectMappingSnapshot = Readonly<{
  busy: boolean; error: string | null; unsupported: boolean; report: MigrationProjectReportRow[];
  sourceRoots: SourceRoot[]; targets: MigrationProjectTargetsResult | null; selectedTarget: string | null;
  targetRoots: MigrationProjectTargetRootsResult | null; mappings: Readonly<Record<string, string>>; canSave: boolean;
}>
const empty = (): ProjectMappingSnapshot => ({ busy: false, error: null, unsupported: false, report: [], sourceRoots: [], targets: null,
  selectedTarget: null, targetRoots: null, mappings: {}, canSave: false })

/** One batch reuses its own readonly Native catalog; this cache grants no filesystem authority. */
export class ProjectTargetCatalogCache {
  private id: string | null = null
  readonly scope: string
  constructor(scope: string) { this.scope = scope }
  read() { return this.id }
  accept(id: string) { this.id = id }
  reset() { this.id = null }
}

/** A chooser owns metadata only. Original paths are never passed to the workspace writer. */
export class ProjectMappingController {
  private value = empty()
  private generation = 0
  private abort: AbortController | null = null
  private readonly listeners = new Set<() => void>()
  private readonly targets = new Map<string, MigrationProjectTargetSummary>()
  private readonly roots = new Map<string, MigrationProjectTargetRoot>()
  private readonly catalog: ProjectTargetCatalogCache | undefined
  private readonly api: Api
  private readonly available: () => boolean
  private readonly isCurrent: () => boolean
  private readonly errorCode: (error: unknown) => string
  constructor(api: Api, available: () => boolean, isCurrent: () => boolean, errorCode: (error: unknown) => string, catalog?: ProjectTargetCatalogCache) {
    this.api = api; this.available = available; this.isCurrent = isCurrent; this.errorCode = errorCode; this.catalog = catalog
  }
  snapshot = () => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: ProjectMappingSnapshot) { this.value = value; for (const listener of this.listeners) listener() }
  private patch(value: Partial<ProjectMappingSnapshot>) { this.publish({ ...this.value, ...value }) }
  dispose() { this.generation++; this.abort?.abort(); this.abort = null }
  private async work(run: (active: () => void, signal: AbortSignal) => Promise<void>) {
    if (this.value.busy || !this.isCurrent()) return
    const generation = ++this.generation, abort = new AbortController()
    this.abort?.abort(); this.abort = abort
    const active = () => { if (generation !== this.generation || !this.isCurrent()) throw new Error('migration_wrong_target') }
    this.patch({ busy: true, error: null })
    try { await run(active, abort.signal); active() }
    catch (error) { if (generation === this.generation && this.isCurrent()) this.patch({ error: this.errorCode(error), canSave: false }) }
    finally { if (generation === this.generation && this.isCurrent()) this.patch({ busy: false }) }
  }
  async load(jobId: string, itemId: string, withTargets = true) {
    this.dispose(); this.targets.clear(); this.roots.clear(); this.publish(empty())
    if (!this.available()) { this.patch({ unsupported: true }); return }
    await this.work(async (active, signal) => {
      const fields: MigrationProjectReportRow[] = []
      let page = 0
      while (true) {
        const result: MigrationProjectReportResult = await this.api.projectReport({ jobId, itemId, pageIndex: page }, { signal }); active()
        fields.push(...result.fields)
        if (fields.length > 64) throw new Error('migration_invalid_response')
        if (result.nextPage == null) break
        page = result.nextPage
      }
      const sourceRoots = fields.filter(row => row.field === 'source_root').map(row => {
        const id = 'sourceRootId' in row ? row.sourceRootId : null
        if (typeof id !== 'string' || !id || row.ordinal == null || typeof row.value !== 'string') throw new Error('migration_projects_update_required')
        return { id, ordinal: row.ordinal, path: row.value }
      }).sort((a, b) => a.ordinal - b.ordinal)
      if (sourceRoots.length > 16 || new Set(sourceRoots.map(row => row.id)).size !== sourceRoots.length
        || sourceRoots.some((row, i) => row.ordinal !== i)) throw new Error('migration_invalid_response')
      this.patch({ report: fields, sourceRoots })
      if (!withTargets) return
      const original = this.catalog?.read()
      const targets = await this.api.projectTargets({ ...(original ? { targetCatalogId: original } : {}), pageIndex: 0 }, { signal }); active()
      this.catalog?.accept(targets.targetCatalogId)
      for (const row of targets.items) this.targets.set(row.targetHandle, row)
      this.patch({ report: fields, sourceRoots, targets, mappings: {}, selectedTarget: null, targetRoots: null, canSave: false })
    })
  }
  async targetPage(pageIndex: number) {
    const catalog = this.value.targets?.targetCatalogId
    if (!catalog) return
    await this.work(async (active, signal) => {
      const targets = await this.api.projectTargets({ targetCatalogId: catalog, pageIndex }, { signal }); active()
      for (const row of targets.items) this.targets.set(row.targetHandle, row)
      this.patch({ targets })
    })
  }
  async selectTarget(targetHandle: string) {
    const catalog = this.value.targets?.targetCatalogId
    if (this.value.busy || !this.isCurrent() || !catalog || !this.targets.has(targetHandle)) return
    this.roots.clear(); this.patch({ selectedTarget: targetHandle, mappings: {}, targetRoots: null, canSave: false })
    await this.rootPage(0)
  }
  async rootPage(pageIndex: number) {
    const catalog = this.value.targets?.targetCatalogId, selected = this.value.selectedTarget
    if (!catalog || !selected) return
    await this.work(async (active, signal) => {
      const result = await this.api.projectTargetRoots({ targetCatalogId: catalog, targetHandle: selected, pageIndex }, { signal }); active()
      if (this.value.selectedTarget !== selected) throw new Error('migration_wrong_target')
      for (const row of result.roots) {
        const old = this.roots.get(row.targetRootHandle)
        if (old && (old.path !== row.path || old.ordinal !== row.ordinal)) throw new Error('migration_project_target_changed')
        this.roots.set(row.targetRootHandle, row)
      }
      this.patch({ targetRoots: result }); this.validate()
    })
  }
  map(sourceRootId: string, targetRootHandle: string) {
    if (this.value.busy || !this.isCurrent() || !this.value.sourceRoots.some(row => row.id === sourceRootId)) return
    const target = this.roots.get(targetRootHandle)
    if (!target?.trusted || !target.available) return
    if (Object.entries(this.value.mappings).some(([source, root]) => source !== sourceRootId && root === targetRootHandle)) return
    this.patch({ mappings: { ...this.value.mappings, [sourceRootId]: targetRootHandle } }); this.validate()
  }
  private validate() {
    const primary = [...this.roots.values()].find(row => row.ordinal === 0)
    const complete = !!primary?.trusted && primary.available && this.value.sourceRoots.every(row => {
      const target = this.roots.get(this.value.mappings[row.id]); return !!target?.trusted && target.available
    })
    this.patch({ canSave: !!this.value.selectedTarget && complete })
  }
  choice(itemId: string): MigrationBatchChoice | null {
    if (!this.value.canSave || this.value.busy || !this.isCurrent() || !this.value.targets || !this.value.selectedTarget) return null
    return { kind: 'project', itemId, mapping: { targetCatalogId: this.value.targets.targetCatalogId, targetHandle: this.value.selectedTarget,
      mappings: this.value.sourceRoots.map(row => ({ sourceRootId: row.id, targetRootHandle: this.value.mappings[row.id] })) } }
  }
}
