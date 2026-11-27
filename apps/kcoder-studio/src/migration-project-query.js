import { isContract } from '../shared/generated/validator.mjs';

export const PROJECT_SOURCE_METHODS = Object.freeze({
  projects: 'migration/projects/discover',
  projects_page: 'migration/projects/sources',
  project_roots: 'migration/projects/source-roots',
});
const atom = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\p{Cc}]/u.test(value);
const unique = values => values.every(atom) && new Set(values).size === values.length;
const page = (index, count, total, next, maximum) => Number.isSafeInteger(index) && index >= 0
  && Number.isSafeInteger(total) && total >= 0 && total <= maximum && index * 10 <= total
  && count === Math.min(10, total - index * 10) && (next ?? null) === (index * 10 + count < total ? index + 1 : null);

/** Source children expose only opaque source inventory. Target catalogs and jobs are never routed here. */
export function validProjectSourceCall(method, input, result) {
  const schema = method === PROJECT_SOURCE_METHODS.projects ? 'MigrationProjectsDiscoverParams'
    : method === PROJECT_SOURCE_METHODS.projects_page ? 'MigrationProjectsSourcesParams'
    : method === PROJECT_SOURCE_METHODS.project_roots ? 'MigrationProjectSourceRootsParams' : null;
  if (!schema || !isContract(schema, input)) return false;
  if (method !== PROJECT_SOURCE_METHODS.projects && !atom(input.catalogId)) return false;
  if (method === PROJECT_SOURCE_METHODS.project_roots && !atom(input.sourceHandle)) return false;
  if (arguments.length < 3) return true;
  const index = method === PROJECT_SOURCE_METHODS.projects ? 0 : input.pageIndex ?? 0;
  if (method === PROJECT_SOURCE_METHODS.project_roots) return isContract('MigrationProjectSourceRootsResult', result)
    && result.catalogId === input.catalogId && result.sourceHandle === input.sourceHandle && result.pageIndex === index
    && page(index, result.roots.length, result.totalRoots, result.nextPage, 16) && unique(result.roots.map(row => row.sourceRootId))
    && result.roots.every((row, i) => row.ordinal === index * 10 + i && Buffer.byteLength(row.originalPath) <= 4096 && !/[\p{Cc}]/u.test(row.originalPath));
  return isContract('MigrationProjectSourcesResult', result) && atom(result.catalogId) && result.pageIndex === index
    && (method === PROJECT_SOURCE_METHODS.projects ? result.source === input.source : result.catalogId === input.catalogId)
    && page(index, result.items.length, result.totalItems, result.nextPage, 4096) && unique(result.items.map(row => row.sourceHandle))
    && result.items.every(row => row.roots <= 16 && Buffer.byteLength(row.displayName) <= 4096 && !/[\p{Cc}]/u.test(row.displayName))
    && (!result.knownRowsComplete || result.problems.length === 0 && result.formatRevision === (result.source === 'codex'
      ? 'codex-project-registry/sqlite/1' : 'claude-project-registry/json/1'));
}
