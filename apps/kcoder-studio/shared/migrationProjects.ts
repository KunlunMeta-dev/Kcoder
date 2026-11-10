import {
  isMigrationProjectReceivedMetadata,
  isMigrationProjectsDiscoverParams, isMigrationProjectsSourcesParams, isMigrationProjectSourcesResult,
  isMigrationProjectSourceRootsParams, isMigrationProjectSourceRootsResult,
  isMigrationProjectTargetsParams, isMigrationProjectTargetsResult,
  isMigrationProjectTargetRootsParams, isMigrationProjectTargetRootsResult,
  isMigrationProjectReportParams, isMigrationProjectReportResult,
  type MigrationProjectsDiscoverParams, type MigrationProjectsSourcesParams, type MigrationProjectSourcesResult,
  type MigrationProjectSourceRootsParams, type MigrationProjectSourceRootsResult,
  type MigrationProjectTargetsParams, type MigrationProjectTargetsResult,
  type MigrationProjectTargetRootsParams, type MigrationProjectTargetRootsResult,
  type MigrationProjectReportParams, type MigrationProjectReportResult,
} from './generated/contracts'

export const PROJECTS_CAPABILITY = 'migrationProjectsV1'
export const PROJECTS_METHODS = Object.freeze({
  discover: 'migration/projects/discover', sources: 'migration/projects/sources', sourceRoots: 'migration/projects/source-roots',
  targets: 'migration/projects/targets', targetRoots: 'migration/projects/target-roots', report: 'migration/projects/report',
})
const atom = (value: string) => value.length > 0 && value.length <= 128 && !/[\p{Cc}]/u.test(value)
const text = (value: string, maximum: number) => new TextEncoder().encode(value).length <= maximum && !/[\p{Cc}]/u.test(value)
const unique = (values: string[]) => values.every(atom) && new Set(values).size === values.length
function page(index: number, count: number, total: number, next: number | null | undefined, maximum: number): boolean {
  const offset = index * 10
  return Number.isSafeInteger(index) && index >= 0 && Number.isSafeInteger(total) && total >= 0 && total <= maximum
    && offset <= total && count === Math.min(10, total - offset)
    && (next ?? null) === (offset + count < total ? index + 1 : null)
}
const sourcePage = (value: MigrationProjectSourcesResult, index: number) => value.pageIndex === index
  && page(index, value.items.length, value.totalItems, value.nextPage, 4096)
  && unique(value.items.map(row => row.sourceHandle))
  && value.items.every(row => text(row.displayName, 4096) && row.roots <= 16)
  && (!value.knownRowsComplete || value.formatRevision === (value.source === 'codex' ? 'codex-project-registry/sqlite/1' : 'claude-project-registry/json/1') && value.problems.length === 0)

/** Exact schema guards are followed by original request/page/handle binding, never inferred paths. */
export function validProjectCall(method: string, input: unknown, value?: unknown): boolean {
  const response = arguments.length >= 3
  switch (method) {
    case PROJECTS_METHODS.discover:
      return isMigrationProjectsDiscoverParams(input) && (!response || isMigrationProjectSourcesResult(value)
        && value.source === input.source && sourcePage(value, 0))
    case PROJECTS_METHODS.sources:
      return isMigrationProjectsSourcesParams(input) && atom(input.catalogId) && (!response || isMigrationProjectSourcesResult(value)
        && value.catalogId === input.catalogId && sourcePage(value, input.pageIndex ?? 0))
    case PROJECTS_METHODS.sourceRoots:
      return isMigrationProjectSourceRootsParams(input) && atom(input.catalogId) && atom(input.sourceHandle) && (!response || isMigrationProjectSourceRootsResult(value)
        && value.catalogId === input.catalogId && value.sourceHandle === input.sourceHandle && value.pageIndex === (input.pageIndex ?? 0)
        && page(value.pageIndex, value.roots.length, value.totalRoots, value.nextPage, 16)
        && unique(value.roots.map(row => row.sourceRootId)) && value.roots.every((row, index) => row.ordinal === value.pageIndex * 10 + index && text(row.originalPath, 4096)))
    case PROJECTS_METHODS.targets:
      return isMigrationProjectTargetsParams(input) && (!response || isMigrationProjectTargetsResult(value)
        && (input.targetCatalogId == null || value.targetCatalogId === input.targetCatalogId) && value.pageIndex === (input.pageIndex ?? 0)
        && page(value.pageIndex, value.items.length, value.totalItems, value.nextPage, 4097)
        && unique(value.items.map(row => row.targetHandle)) && value.items.every(row => row.roots > 0 && row.roots <= 64 && text(row.displayName, 4096)))
    case PROJECTS_METHODS.targetRoots:
      return isMigrationProjectTargetRootsParams(input) && (!response || isMigrationProjectTargetRootsResult(value)
        && value.targetCatalogId === input.targetCatalogId && value.targetHandle === input.targetHandle && value.pageIndex === (input.pageIndex ?? 0)
        && page(value.pageIndex, value.roots.length, value.totalRoots, value.nextPage, 64)
        && unique(value.roots.map(row => row.targetRootHandle)) && value.roots.every((row, index) => row.ordinal === value.pageIndex * 10 + index && text(row.path, 4096)))
    case PROJECTS_METHODS.report:
      return isMigrationProjectReportParams(input) && (!response || isMigrationProjectReportResult(value)
        && value.jobId === input.jobId && value.itemId === input.itemId && value.pageIndex === (input.pageIndex ?? 0)
        && page(value.pageIndex, value.fields.length, value.totalFields, value.nextPage, 64))
    default: return false
  }
}
type Invoke = <T>(method: string, input: object, options?: { signal?: AbortSignal }) => Promise<T>
export function createProjectsApi(invoke: Invoke) {
  const call = async <T>(method: string, input: object, options?: { signal?: AbortSignal }): Promise<T> => {
    if (!validProjectCall(method, input)) throw new Error('migration_invalid_parameters')
    const value = await invoke<T>(method, input, options)
    if (!validProjectCall(method, input, value)) throw new Error('migration_invalid_response')
    return value
  }
  return {
    projectsDiscover: (input: MigrationProjectsDiscoverParams, options?: { signal?: AbortSignal }) => call<MigrationProjectSourcesResult>(PROJECTS_METHODS.discover, input, options),
    projectsSources: (input: MigrationProjectsSourcesParams, options?: { signal?: AbortSignal }) => call<MigrationProjectSourcesResult>(PROJECTS_METHODS.sources, input, options),
    projectSourceRoots: (input: MigrationProjectSourceRootsParams, options?: { signal?: AbortSignal }) => call<MigrationProjectSourceRootsResult>(PROJECTS_METHODS.sourceRoots, input, options),
    projectTargets: (input: MigrationProjectTargetsParams, options?: { signal?: AbortSignal }) => call<MigrationProjectTargetsResult>(PROJECTS_METHODS.targets, input, options),
    projectTargetRoots: (input: MigrationProjectTargetRootsParams, options?: { signal?: AbortSignal }) => call<MigrationProjectTargetRootsResult>(PROJECTS_METHODS.targetRoots, input, options),
    projectReport: (input: MigrationProjectReportParams, options?: { signal?: AbortSignal }) => call<MigrationProjectReportResult>(PROJECTS_METHODS.report, input, options),
  }
}

/** Project provenance is required only for that new class and never implies current-workspace mapping. */
export function validReceivedProjectRows(items: import('./generated/contracts').MigrationSourceReceivedItem[]): boolean {
  return items.every(item => item.class !== 'project' ? item.project == null : item.category === 'project' && !item.projectScoped
    && isMigrationProjectReceivedMetadata(item.project) && item.project.roots <= 16 && !!item.project.displayName
    && text(item.project.displayName,4096) && item.project.formatRevision === (item.source === 'codex'
      ? 'codex-project-registry/sqlite/1' : 'claude-project-registry/json/1'))
}
