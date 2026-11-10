import { PROJECTS_METHODS, validProjectCall } from '../../../../shared/migrationProjects'
import { createInstructionSourceApi, isInstructionSourceQuery, validInstructionSourceQuery } from '../../../../shared/migrationInstructionSourceApi'
import type * as InstructionContracts from '../../../../shared/generated/contracts'
import { validPluginDiscovery } from '../../../../shared/migrationPlugins'
import type { MigrationPluginDiscoverParams, MigrationPluginDiscoverResult } from '../../../../shared/generated/contracts'
import { validDefinitionCall } from '../../../../shared/migrationDefinitions'
import { isMigrationDefinitionsDiscoverResult, type MigrationDefinitionsDiscoverParams, type MigrationDefinitionsDiscoverResult } from '../../../../shared/generated/contracts'
import {
  isMigrationDiscoverResult,
  isMigrationHistorySourcesResult,
  isMigrationSourceSessionCloseResult,
  isMigrationSourceSessionOpenParams,
  isMigrationSourceSessionParams,
  isMigrationSourceSessionQueryParams,
  isMigrationSourceSessionStateResult,
  isMigrationSourceBindingsResult,
  isMigrationCodexLayersSelectResult,
  isMigrationCodexLayersReadResult,
  isMigrationSourceDirectoryResult,
  isMigrationSourceProductSelectResult,
  isMigrationMemorySourcesResult,
  isMigrationConfigurationLayersResult,
  type MigrationDiscoverResult,
  type MigrationHistorySourcesResult,
  type MigrationSourceSessionCloseResult,
  type MigrationSourceSessionOpenParams,
  type MigrationSourceSessionParams,
  type MigrationSourceSessionQueryParams,
  type MigrationSourceSessionStateResult,
  type MigrationSourceBindingsResult,
  type MigrationCodexLayersSelectParams,
  type MigrationCodexLayersSelectResult,
  type MigrationCodexLayersReadResult,
  type MigrationSourceCodexLayersReadParams,
  type MigrationSourceDirectorySelectParams,
  type MigrationSourceDirectoryResult,
  type MigrationSourceProductParams,
  type MigrationSourceProductSelectResult,
  type MigrationMemorySourcesResult,
  type MigrationConfigurationLayersResult,
  type MigrationSourceConfigurationLayersReadParams,
} from '../../../../shared/generated/contracts'
import { validCodexLayerSelection, validCodexLayerReport } from '../../../../shared/migrationCodexLayers'
import { validConfigurationLayers } from '../../../../shared/migrationConfigurationLayers'
import { validHistoryFamiliesInput, validHistorySources } from '../../../../shared/migrationHistoryFamilies'

import { createMigrationSourceHttpTransport, type MigrationSourceHttpOptions } from './http'
export { MigrationSourceHttpError } from './http'

type ProjectDiscoveryResult = import('../../../../shared/generated/contracts').MigrationProjectSourcesResult | import('../../../../shared/generated/contracts').MigrationProjectSourceRootsResult
const projectMethod = (kind: string) => kind === 'projects' ? PROJECTS_METHODS.discover : kind === 'projects_page' ? PROJECTS_METHODS.sources : kind === 'project_roots' ? PROJECTS_METHODS.sourceRoots : null
const validProjectQuery = (input: MigrationSourceSessionQueryParams, value: unknown) => {
  const method = projectMethod(input.query.kind)
  return !!method && validProjectCall(method, input.query.params, value)
}
type DiscoveryResult = ProjectDiscoveryResult | InstructionContracts.MigrationInstructionCaptureResult | InstructionContracts.MigrationInstructionPageResult | InstructionContracts.MigrationInstructionBodyResult | MigrationPluginDiscoverResult | MigrationDiscoverResult | MigrationHistorySourcesResult | MigrationSourceBindingsResult
  | MigrationCodexLayersSelectResult | MigrationCodexLayersReadResult | MigrationSourceDirectoryResult
  | MigrationSourceProductSelectResult | MigrationMemorySourcesResult
  | MigrationConfigurationLayersResult | MigrationDefinitionsDiscoverResult

/** The caller supplies an account/connection revision, never a credential. */
export function createMigrationSourceSessionClient(options: MigrationSourceHttpOptions) {
  const request = createMigrationSourceHttpTransport(options, 'source-session', new Set(['read', 'query']))
  const directoryRequest = createMigrationSourceHttpTransport(options, 'source-session', new Set<string>())
  const selectedDirectory = (params: MigrationSourceDirectorySelectParams, value: unknown): value is MigrationSourceDirectoryResult =>
    isMigrationSourceDirectoryResult(value) && value.selectionId === params.selectionId && value.source === params.source && value.remainingMs <= 600_000
  const selectedUploaded = (params: MigrationSourceProductParams, value: unknown): value is MigrationSourceProductSelectResult =>
    isMigrationSourceProductSelectResult(value) && value.operationId === params.operationId && value.manifestSha256 === params.manifestSha256
    && value.origin === 'user_supplied' && value.remainingMs > 0 && value.remainingMs <= 600_000
  const memoryPage = (input: MigrationSourceSessionQueryParams, value: unknown): value is MigrationMemorySourcesResult => {
    const query = input.query
    return isMigrationMemorySourcesResult(value) && !!value.catalogId && value.items.length <= 10 &&
    new Set(value.items.map(item => item.sourceId)).size === value.items.length &&
    (query.kind === 'memory' ? value.items.every(item => item.source === query.params.source)
      : query.kind === 'memory_page' && value.catalogId === query.params.catalogId
        && (value.nextCursor == null || value.nextCursor !== query.params.cursor))
  }
  const bindingsFor = (ids: string[], value: unknown): value is MigrationSourceBindingsResult =>
    isMigrationSourceBindingsResult(value) && value.bindings.length === ids.length
    && value.bindings.every((binding, index) => binding.sourceId === ids[index])
  return {
    ...createInstructionSourceApi(request, directoryRequest),
    historyFamilies: (session: MigrationSourceSessionParams, params: import('../../../../shared/generated/contracts').MigrationHistoryDiscoverParams, signal?: AbortSignal) =>
      request<MigrationHistorySourcesResult>('query', { session, query: { kind: 'history_families', params } },
        value => validHistoryFamiliesInput(params) && isMigrationSourceSessionQueryParams(value),
        (value): value is MigrationHistorySourcesResult => validHistorySources('codex', value), signal),
    open: (input: MigrationSourceSessionOpenParams, signal?: AbortSignal) => request<MigrationSourceSessionStateResult>(
      'open', input, isMigrationSourceSessionOpenParams, isMigrationSourceSessionStateResult, signal),
    read: (input: MigrationSourceSessionParams, signal?: AbortSignal) => request<MigrationSourceSessionStateResult>(
      'read', input, isMigrationSourceSessionParams, isMigrationSourceSessionStateResult, signal),
    close: (input: MigrationSourceSessionParams, signal?: AbortSignal) => request<MigrationSourceSessionCloseResult>(
      'close', input, isMigrationSourceSessionParams, isMigrationSourceSessionCloseResult, signal),
    bindings: (session: MigrationSourceSessionParams, sourceIds: string[], signal?: AbortSignal) => request<MigrationSourceBindingsResult>(
      'query', { session, query: { kind: 'source_bindings', params: { sourceIds } } }, isMigrationSourceSessionQueryParams,
      (value): value is MigrationSourceBindingsResult => bindingsFor(sourceIds, value), signal),
    selectDirectory: (session: MigrationSourceSessionParams, params: MigrationSourceDirectorySelectParams, signal?: AbortSignal) => directoryRequest<MigrationSourceDirectoryResult>(
      'query', { session, query: { kind: 'directory_select', params } }, isMigrationSourceSessionQueryParams,
      (value): value is MigrationSourceDirectoryResult => selectedDirectory(params, value), signal),
    selectUploaded: (session: MigrationSourceSessionParams, params: MigrationSourceProductParams, signal?: AbortSignal) => directoryRequest<MigrationSourceProductSelectResult>(
      'query', { session, query: { kind: 'uploaded_select', params } }, isMigrationSourceSessionQueryParams,
      (value): value is MigrationSourceProductSelectResult => selectedUploaded(params, value), signal),
    codexLayersSelect: (session: MigrationSourceSessionParams, params: MigrationCodexLayersSelectParams, signal?: AbortSignal) => directoryRequest<MigrationCodexLayersSelectResult>(
      'query', { session, query: { kind: 'codex_layers_select', params } }, isMigrationSourceSessionQueryParams,
      (value): value is MigrationCodexLayersSelectResult => isMigrationCodexLayersSelectResult(value) && validCodexLayerSelection(params, value), signal),
    codexLayersRead: (session: MigrationSourceSessionParams, params: MigrationSourceCodexLayersReadParams, signal?: AbortSignal) => request<MigrationCodexLayersReadResult>(
      'query', { session, query: { kind: 'codex_layers_read', params } }, isMigrationSourceSessionQueryParams,
      (value): value is MigrationCodexLayersReadResult => isMigrationCodexLayersReadResult(value) && validCodexLayerReport({ target: { kind: 'source', sourceId: params.sourceId }, pageIndex: params.pageIndex }, value), signal),
    plugins: (session: MigrationSourceSessionParams, params: MigrationPluginDiscoverParams, signal?: AbortSignal) => request<MigrationPluginDiscoverResult>('query', { session, query: { kind: 'plugins', params } }, isMigrationSourceSessionQueryParams, (value): value is MigrationPluginDiscoverResult => validPluginDiscovery(params, value), signal),
    definitionsDiscover: (session: MigrationSourceSessionParams, params: MigrationDefinitionsDiscoverParams, signal?: AbortSignal) => request<MigrationDefinitionsDiscoverResult>('query', { session, query: { kind: 'definitions', params } }, isMigrationSourceSessionQueryParams, (value): value is MigrationDefinitionsDiscoverResult => isMigrationDefinitionsDiscoverResult(value) && validDefinitionCall('migration/definitions/discover', params, value), signal),
    configurationLayersRead: (session: MigrationSourceSessionParams, params: MigrationSourceConfigurationLayersReadParams, signal?: AbortSignal) => request<MigrationConfigurationLayersResult>(
      'query', { session, query: { kind: 'configuration_layers_read', params } }, isMigrationSourceSessionQueryParams,
      (value): value is MigrationConfigurationLayersResult => isMigrationConfigurationLayersResult(value) && validConfigurationLayers({ target: { kind: 'source', sourceId: params.sourceId }, pageIndex: params.pageIndex }, value), signal),
    query: (input: MigrationSourceSessionQueryParams, signal?: AbortSignal) => (['instructions_capture', 'directory_select', 'uploaded_select', 'codex_layers_select'].includes(input.query.kind) ? directoryRequest : request)<DiscoveryResult>(
      'query', input, value => isMigrationSourceSessionQueryParams(value) && (!isInstructionSourceQuery(value.query) || validInstructionSourceQuery(value)),
      (value): value is DiscoveryResult => projectMethod(input.query.kind) ? validProjectQuery(input, value) : isInstructionSourceQuery(input.query) ? validInstructionSourceQuery(input, value) :
        input.query.kind === 'history_families' ? validHistoryFamiliesInput(input.query.params) && validHistorySources('codex', value)
          : input.query.kind === 'history' ? validHistorySources(input.query.params.source, value)
          : input.query.kind === 'history_page' ? isMigrationHistorySourcesResult(value) && validHistorySources(value.items[0]?.source ?? 'codex', value, input.query.params)
          : input.query.kind === 'plugins' ? validPluginDiscovery(input.query.params, value)
          : input.query.kind === 'definitions' ? isMigrationDefinitionsDiscoverResult(value) && validDefinitionCall('migration/definitions/discover', input.query.params, value)
          : input.query.kind === 'configuration' ? isMigrationDiscoverResult(value)
          : input.query.kind === 'directory_select' ? selectedDirectory(input.query.params, value)
          : input.query.kind === 'uploaded_select' ? selectedUploaded(input.query.params, value)
          : input.query.kind === 'source_bindings' ? bindingsFor(input.query.params.sourceIds, value)
          : input.query.kind === 'memory' || input.query.kind === 'memory_page' ? memoryPage(input, value)
          : input.query.kind === 'codex_layers_select' ? isMigrationCodexLayersSelectResult(value) && validCodexLayerSelection(input.query.params, value)
          : input.query.kind === 'codex_layers_read' ? isMigrationCodexLayersReadResult(value) && validCodexLayerReport({ target: { kind: 'source', sourceId: input.query.params.sourceId }, pageIndex: input.query.params.pageIndex }, value)
          : input.query.kind === 'configuration_layers_read' ? isMigrationConfigurationLayersResult(value) && validConfigurationLayers({ target: { kind: 'source', sourceId: input.query.params.sourceId }, pageIndex: input.query.params.pageIndex }, value)
          : isMigrationHistorySourcesResult(value), signal),
  }
}
