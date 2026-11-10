import {
  isMigrationProjectMcpCatalogParams, isMigrationProjectMcpCatalogResult,
  type MigrationProjectMcpCatalogParams, type MigrationProjectMcpCatalogResult,
  type MigrationProjectMcpInheritanceSelection,
} from './generated/contracts'

export const PROJECT_MCP_METHOD = 'migration/project/mcp/catalog'
export const PROJECT_MCP_CAPABILITY = 'migrationProjectMcpInheritanceV1'
// Match Rust str::trim, which includes U+0085 and does not trim U+FEFF.
const edgeWhitespace = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u

/** A page proves names in one revision, never inherited definitions or credentials. */
export function validProjectMcpCatalog(input: unknown, value?: unknown): boolean {
  if (!isMigrationProjectMcpCatalogParams(input) || (input.pageIndex ?? 0) > 102 ||
    (input.pageIndex ?? 0) > 0 && !/^[a-f0-9]{64}$/.test(input.expectedRevision ?? '')) return false
  if (arguments.length === 1) return true
  if (!isMigrationProjectMcpCatalogResult(value) || value.jobId !== input.jobId || value.totalNames > 1024) return false
  if (value.status !== 'selection_required') return (input.pageIndex ?? 0) === 0 &&
    !input.expectedRevision && value.names.length === 0 && value.totalNames === 0 &&
    value.revision == null && value.nextPageIndex == null
  const offset = (input.pageIndex ?? 0) * 10
  return /^[a-f0-9]{64}$/.test(value.revision ?? '') &&
    (!input.expectedRevision || input.expectedRevision === value.revision) &&
    (offset === 0 || offset < value.totalNames) &&
    value.names.length === Math.min(10, value.totalNames - offset) &&
    new Set(value.names).size === value.names.length &&
    value.names.every(name => name.length > 0 && !edgeWhitespace.test(name) && !/[\u0000-\u001f\u007f-\u009f]/.test(name) && new TextEncoder().encode(name).length <= 128) &&
    (value.nextPageIndex ?? null) === (offset + 10 < value.totalNames ? (input.pageIndex ?? 0) + 1 : null)
}

type ReadCatalog = (input: MigrationProjectMcpCatalogParams) => Promise<MigrationProjectMcpCatalogResult>
export function createProjectMcpApi(invoke: <T>(method: string, input: object, options?: { signal?: AbortSignal }) => Promise<T>) {
  return {
    async projectMcpCatalog(input: MigrationProjectMcpCatalogParams, options?: { signal?: AbortSignal }): Promise<MigrationProjectMcpCatalogResult> {
      if (!validProjectMcpCatalog(input)) throw new Error('migration_invalid_parameters')
      const value = await invoke<MigrationProjectMcpCatalogResult>(PROJECT_MCP_METHOD, input, options)
      if (!validProjectMcpCatalog(input, value)) throw new Error('migration_invalid_response')
      return value
    },
  }
}
export interface ProjectMcpCatalogState {
  page: MigrationProjectMcpCatalogResult | null
  pageIndex: number
  selected: string[]
  confirmed: boolean
  busy: boolean
  error: string
}

/** This is an unsent choice. Native planning rechecks the revision under its writer. */
export class ProjectMcpCatalogController {
  private readonly jobId: string
  private readonly read: ReadCatalog
  private readonly current: () => boolean
  private epoch = 0
  private known = new Set<string>()
  private listeners = new Set<() => void>()
  private value: ProjectMcpCatalogState = { page: null, pageIndex: 0, selected: [], confirmed: false, busy: false, error: '' }
  constructor(jobId: string, read: ReadCatalog, current: () => boolean) {
    this.jobId = jobId; this.read = read; this.current = current
  }
  snapshot = (): ProjectMcpCatalogState => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private update(change: Partial<ProjectMcpCatalogState>): void {
    this.value = { ...this.value, ...change }; for (const listener of this.listeners) listener()
  }
  invalidate(): void { this.epoch++; this.known.clear(); this.update({ page: null, pageIndex: 0, selected: [], confirmed: false, busy: false, error: '' }) }
  async load(pageIndex = 0, refresh = false): Promise<void> {
    if (!this.current() || this.value.busy) return
    if (refresh) this.invalidate()
    const epoch = ++this.epoch
    const revision = this.value.page?.revision
    const input = { jobId: this.jobId, pageIndex, ...(revision ? { expectedRevision: revision } : {}) }
    this.update({ busy: true, error: '' })
    try {
      if (!validProjectMcpCatalog(input)) throw new Error('migration_invalid_parameters')
      const page = await this.read(input)
      if (epoch !== this.epoch || !this.current()) return
      if (!validProjectMcpCatalog(input, page)) throw new Error('migration_invalid_response')
      for (const name of page.names) this.known.add(name)
      if (this.known.size > 1024) throw new Error('migration_invalid_response')
      this.update({ page, pageIndex, busy: false })
    } catch (cause) {
      if (epoch !== this.epoch || !this.current()) return
      this.known.clear()
      const message = cause instanceof Error ? cause.message : ''
      const error = /^migration_[a-z_]{1,100}$/.test(message) ? message : 'migration_operation_failed'
      this.update({ page: null, selected: [], confirmed: false, busy: false, error })
    }
  }
  choose(name: string): void {
    if (!this.current() || this.value.busy || !this.known.has(name)) return
    const selected = new Set(this.value.selected)
    if (!selected.delete(name)) selected.add(name)
    this.update({ selected: [...selected].sort(), confirmed: false })
  }
  confirm(value: boolean): void {
    if (!this.current() || this.value.busy || this.value.page?.status !== 'selection_required') return
    this.update({ confirmed: value })
  }
  selection(): MigrationProjectMcpInheritanceSelection | undefined {
    if (!this.current() || this.value.busy || !this.value.confirmed || !this.value.page?.revision) return undefined
    return { names: [...this.value.selected], expectedRevision: this.value.page.revision }
  }
}
