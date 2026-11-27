import { isMigrationPluginDiscoverResult, type MigrationPluginDiscoverParams, type MigrationPluginDiscoverResult,
  type MigrationPluginCandidate } from './generated/contracts'

export function validPluginDiscovery(params: MigrationPluginDiscoverParams, value: unknown): value is MigrationPluginDiscoverResult {
  return isMigrationPluginDiscoverResult(value) && value.candidates.length <= 10
    && new Set(value.candidates.map(row => row.candidateId)).size === value.candidates.length
    && value.candidates.every(row => !!row.candidateId && row.candidateId.length <= 128 && !/[\p{Cc}]/u.test(row.candidateId)
      && (!params.sources?.length || params.sources.includes(row.source)))
    && (value.nextCursor == null || !!value.nextCursor && value.nextCursor.length <= 512
      && !/[\p{Cc}]/u.test(value.nextCursor) && value.nextCursor !== params.cursor)
}

/** Mapping is destination consent; it does not make unknown packages compatible. */
export function transferablePlugin(row: MigrationPluginCandidate): boolean {
  return ['user', 'project', 'local'].includes(row.scope) && row.pending.every(code => code === 'plugin_project_mapping_required')
}
