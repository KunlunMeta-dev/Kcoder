import * as C from './generated/contracts'
import type { HistorySourceGroup } from './migrationHistoryGroups'

export const HISTORY_FAMILIES_METHOD = 'migration/history/families/discover'
export const HISTORY_FAMILIES_CAPABILITY = 'migrationHistoryFamilyIndexV1'
export const validHistoryFamiliesInput = (input: unknown): input is C.MigrationHistoryDiscoverParams =>
  C.isMigrationHistoryDiscoverParams(input) && input.source === 'codex'
export function validHistoryFamilies(input: unknown, result?: unknown) {
  return validHistoryFamiliesInput(input) && (arguments.length === 1 || validHistorySources('codex', result))
}
type Invoke = <T>(method: string, input: object, options?: { signal?: AbortSignal }) => Promise<T>
export function createHistoryFamiliesApi(invoke: Invoke) {
  return { historyFamilies: async (input: C.MigrationHistoryDiscoverParams, options?: { signal?: AbortSignal }) => {
    if (!validHistoryFamiliesInput(input)) throw new Error('migration_invalid_parameters')
    const result = await invoke<C.MigrationHistorySourcesResult>(HISTORY_FAMILIES_METHOD, input, options)
    if (!validHistoryFamilies(input, result)) throw new Error('migration_invalid_response')
    return result
  } }
}
export type HistoryFamilyIssue = 'missing_parent' | 'conflict' | 'cycle' | 'unobserved'
export interface HistoryFamilyGroup extends HistorySourceGroup {
  parentObserved: boolean
  lineageIssue: HistoryFamilyIssue | null
}
type Expected = { catalogId: string; totalItems?: number; cursor?: string | null; firstPage?: boolean }
const bytes = (value: string) => new TextEncoder().encode(value).length

/** Only original physical rows are returned; catalogs and opaque cursors remain Native authority. */
export function validHistorySources(source: C.MigrationSourceKind, value: unknown, expected?: Expected): value is C.MigrationHistorySourcesResult {
  if (!C.isMigrationHistorySourcesResult(value) || !value.catalogId || bytes(value.catalogId) > 1024
    || value.items.length > 10 || value.totalItems > 10_000 || value.totalItems < value.items.length
    || value.totalItems > 0 && !value.items.length || value.items.some(row => row.source !== source || !row.sourceHandle)
    || new Set(value.items.map(row => row.sourceHandle)).size !== value.items.length
    || value.nextCursor != null && (!value.nextCursor || bytes(value.nextCursor) > 16 * 1024)) return false
  if (expected && (value.catalogId !== expected.catalogId || expected.totalItems != null && value.totalItems !== expected.totalItems
    || value.nextCursor != null && value.nextCursor === expected.cursor)) return false
  if (expected?.firstPage ?? expected?.cursor == null) return value.items.length === Math.min(10, value.totalItems)
    && Boolean(value.nextCursor) === (value.totalItems > value.items.length)
  return true
}

function invalid(): never { throw new Error('source_transfer_history_catalog_unavailable') }
const signature = (row: C.HistorySourceSummary) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
type Root = { id: string; key: string; observed: boolean; issue: HistoryFamilyIssue | null }

/** Catalog-scoped display metadata. It grants neither source reads nor selection of an ancestor. */
export class HistoryFamilyCache {
  private catalog: string | null = null
  private total: number | null = null
  private readonly rows = new Map<string, { row: C.HistorySourceSummary; signature: string }>()
  private readonly scope: string
  private cost = 0
  constructor(scope: string) { if (!scope) invalid(); this.scope = scope }
  observe(scope: string, page: C.MigrationHistorySourcesResult): HistoryFamilyGroup[] {
    if (scope !== this.scope || !validHistorySources('codex', page,
      this.catalog === null ? undefined : { catalogId: this.catalog, totalItems: this.total!, firstPage: false })) invalid()
    const additions: Array<[string, { row: C.HistorySourceSummary; signature: string }]> = []
    let cost = this.cost
    for (const row of page.items) {
      const encoded = signature(row), previous = this.rows.get(row.sourceHandle)
      if (previous && previous.signature !== encoded) invalid()
      if (!previous) { cost += bytes(encoded) + bytes(row.sourceHandle) + 64; additions.push([row.sourceHandle, { row: structuredClone(row), signature: encoded }]) }
    }
    if (cost > 16 * 1024 * 1024 || this.rows.size + additions.length > 10_000 || this.rows.size + additions.length > page.totalItems) invalid()
    for (const [key, value] of additions) this.rows.set(key, value)
    this.cost = cost; this.catalog = page.catalogId; this.total = page.totalItems
    const sessions = new Map<string, C.HistorySourceSummary[]>()
    for (const { row } of this.rows.values()) {
      const existing = sessions.get(row.sourceSessionId)
      if (existing) existing.push(row); else sessions.set(row.sourceSessionId, [row])
    }
    const resolved = new Map<string, Root>()
    const nativeIncomplete = page.problems.some(problem => ['history_discovery_family_budget_exceeded', 'history_discovery_family_metadata_incomplete',
      'history_discovery_family_parent_conflict', 'history_discovery_family_cycle'].includes(problem.code))
    const rootFor = (start: string) => {
      const path: string[] = [], positions = new Map<string, number>()
      let id = start, root: Root
      for (;;) {
        const known = resolved.get(id)
        if (known) { root = known; break }
        const position = positions.get(id)
        if (position !== undefined) {
          const cycle = path.slice(position).sort()[0]
          root = { id: cycle, key: `cycle:${cycle}`, observed: false, issue: 'cycle' }; break
        }
        positions.set(id, path.length); path.push(id)
        const rows = sessions.get(id)
        if (!rows) { root = { id, key: `missing:${id}`, observed: false, issue: 'missing_parent' }; break }
        const parents = new Set(rows.map(row => row.parentSessionId ?? null))
        if (parents.size > 1) { root = { id, key: `conflict:${id}`, observed: false, issue: 'conflict' }; break }
        const parent = rows[0].parentSessionId
        if (!parent) {
          // Native clears unresolved parent claims. Its catalog diagnostics and
          // incomplete physical metadata must not be mistaken for a proven root.
          const unknown = rows.some(row => row.agentId != null || nativeIncomplete && row.previewIncomplete)
          root = { id, key: `root:${id}`, observed: !unknown, issue: unknown ? 'unobserved' : null }; break
        }
        id = parent
      }
      for (const item of path) resolved.set(item, root)
      return root
    }
    const groups = new Map<string, HistoryFamilyGroup>()
    for (const item of page.items) {
      const root = rootFor(item.sourceSessionId), key = JSON.stringify([this.scope, page.catalogId, root.key])
      let group = groups.get(key)
      if (!group) {
        const originals = (sessions.get(root.id) ?? []).filter(row => !row.parentSessionId && !row.agentId)
        group = { key, sessionId: root.id, title: root.observed && originals.length === 1 ? originals[0].title ?? null : null,
          parentOnPage: root.observed && page.items.some(row => row.sourceSessionId === root.id && !row.parentSessionId && !row.agentId),
          parentObserved: root.observed, lineageIssue: root.issue, related: false, items: [] }
        groups.set(key, group)
      }
      group.related ||= item.parentSessionId != null || item.agentId != null || item.sourceSessionId !== root.id
      group.items.push(structuredClone(item))
    }
    return [...groups.values()]
  }
}
