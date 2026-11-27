import {
  createBatchControlApi,
  batchControlMethod,
  BATCH_CONTROL_METHODS,
  BATCH_CONTROL_CAPABILITY,
  validBatchControlCall,
} from '../../../shared/migrationBatchControl'
import {
  createResourceAttachmentApi,
  RESOURCE_ATTACHMENT_CAPABILITY,
  RESOURCE_ATTACHMENT_METHODS,
  resourceAttachmentMethod,
  validResourceAttachment,
} from '../../../shared/migrationResourceAttachment'
import {
  createProjectsApi,
  PROJECTS_METHODS,
  PROJECTS_CAPABILITY,
  validProjectCall,
} from '../../../shared/migrationProjects'
import {
  createHistoryResourceApi,
  HISTORY_RESOURCE_CAPABILITY,
  HISTORY_RESOURCE_METHODS,
  historyResourceMethod,
  validHistoryResourceCall,
} from '../../../shared/migrationHistoryResourceBudget'
import {
  createAgentApi,
  AGENT_PREVIEW_METHOD,
  AGENT_CAPABILITY,
  hasAgentAdaptations,
  validAgentPreview,
} from '../../../shared/migrationAgents'
import { createInstructionApi } from '../../../shared/migrationInstructionApi'
import {
  createProjectMcpApi,
  PROJECT_MCP_METHOD,
  PROJECT_MCP_CAPABILITY,
  validProjectMcpCatalog,
} from '../../../shared/migrationProjectMcp'
import {
  INSTRUCTION_CAPABILITY,
  INSTRUCTION_METHODS,
  validInstructionCall,
} from '../../../shared/migrationInstructions.mjs'
import {
  createResourceBudgetApi,
  RESOURCE_BUDGET_METHODS,
  RESOURCE_BUDGET_CAPABILITY,
  resourceBudgetReadOnly,
  validResourceCall,
} from './gatewayMigrationResources'
import {
  createHistoryFamiliesApi,
  HISTORY_FAMILIES_METHOD,
  HISTORY_FAMILIES_CAPABILITY,
  validHistoryFamilies,
} from '../../../shared/migrationHistoryFamilies'
import {
  createCredentialSourcesApi,
  CREDENTIAL_SOURCES_METHOD,
  CREDENTIAL_SOURCES_CAPABILITY,
  validCredentialSources,
} from '../../../shared/migrationCredentialSources'
import {
  createDefinitionsApi,
  DEFINITION_METHODS,
  DEFINITIONS_CAPABILITY,
  validDefinitionCall,
} from './gatewayMigrationDefinitions'
import {
  createSourceProductApi,
  SOURCE_PRODUCT_METHODS,
  SOURCE_PRODUCT_CAPABILITY,
  sourceProductReadOnly,
  validSourceProductCall,
} from './gatewayMigrationSourceProduct'
import {
  createSourceUploadApi,
  SOURCE_UPLOAD_METHODS,
  SOURCE_UPLOAD_CAPABILITY,
  sourceUploadReadOnly,
  validSourceUploadCall,
} from './gatewayMigrationSourceUpload'
import { isMigrationCodexLayersSelectParams } from '../../../shared/generated/contracts'
import { createCodexLayersApi } from './gatewayMigrationCodexLayers'
import {
  createMemoryApi,
  MEMORY_METHODS,
  MEMORY_CAPABILITY,
  memoryReadOnly,
  validMemoryCall,
} from './gatewayMigrationMemory'
import {
  createUploadCollectionApi,
  UPLOAD_COLLECTION_METHODS,
} from './gatewayMigrationUploadCollection'
import {
  createHistoryLifecycleApi,
  HISTORY_LIFECYCLE_METHODS,
  validateHistoryRetirement,
} from './gatewayMigrationHistoryLifecycle'
import {
  existingHistoryView,
  openHistoryView,
  HISTORY_VIEW_METHODS,
} from './gatewayMigrationViewRouting'
import {
  validConfigurationLayers,
  CONFIGURATION_LAYERS_CAPABILITY,
} from '../../../shared/migrationConfigurationLayers'
import {
  isMigrationConfigurationLayersParams,
  isMigrationConfigurationLayersResult,
} from '../../../shared/generated/contracts'
import { normalizeHistoryExecution } from './migrationHistoryExecution'
import { requestLocalExecutor } from '@/host/localExecutor'
import { captureAccountContextRevision } from './accountContextEvents'
import { continuationSourceClient } from './gatewayMigrationContinuationSource'
import { hookTargetScope } from './gatewayHookConfiguration'
import { GatewayRpcError } from './gatewayRpc'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type {
  MigrationConfigurationLayersParams,
  MigrationConfigurationLayersResult,
  MigrationLocalAttachmentPrepareParams,
  MigrationLocalAttachmentReadParams,
  MigrationLocalAttachmentBeginParams,
  MigrationLocalAttachmentPartParams,
  MigrationLocalAttachmentRunParams,
  MigrationLocalAttachmentListParams,
  MigrationLocalAttachmentChunkParams,
  MigrationLocalAttachmentListResult,
  MigrationLocalAttachmentStateResult,
  MigrationHistoryReinterpretPreviewParams,
  MigrationHistoryReinterpretPreviewResult,
  MigrationHistoryReinterpretCreateParams,
  MigrationHistoryUndoLookupParams,
  MigrationHistoryUndoLookupResult,
  MigrationHistoryUndoPreviewParams,
  MigrationHistoryUndoPreviewResult,
  MigrationHistoryUndoCreateParams,
  MigrationHistoryUndoReadParams,
  MigrationHistoryUndoRunParams,
  MigrationHistoryUndoStateResult,
  MigrationHistorySearchParams,
  MigrationHistorySearchResult,
  MigrationContinuationSourceParams,
  MigrationContinuationSourceResult,
  MigrationContinuationCreateParams,
  MigrationContinuationReadParams,
  MigrationContinuationRunParams,
  MigrationContinuationStateResult,
  MigrationDiscoverParams,
  MigrationDiscoverResult,
  MigrationScanParams,
  MigrationJobReadResult,
  MigrationItemsParams,
  MigrationItemsResult,
  MigrationProviderPlanParams,
  MigrationProviderOperationParams,
  MigrationCancelParams,
  MigrationMcpPlanParams,
  MigrationAssetPlanParams,
  MigrationAssetPreviewParams,
  MigrationAssetPreviewResult,
  MigrationBatchScanParams,
  MigrationBatchPlanParams,
  MigrationBatchOperationParams,
  MigrationBatchRunParams,
  MigrationBatchStateResult,
  MigrationJobsListParams,
  MigrationJobsListResult,
  MigrationBatchItemPlanParams,
  MigrationBatchItemPlanResult,
  MigrationCredentialPlanParams,
  MigrationCredentialOperationParams,
  MigrationMcpCredentialPlanParams,
  MigrationMcpCredentialsResult,
  MigrationHistoryDiscoverParams,
  MigrationHistorySourcesParams,
  MigrationHistorySourcesResult,
  MigrationHistoryCreateParams,
  MigrationHistoryRunParams,
  MigrationHistoryJobResult,
  MigrationHistoryJobsResult,
  MigrationTranscriptPageParams,
  MigrationTranscriptPageResult,
  MigrationTranscriptBlocksParams,
  MigrationTranscriptBlocksResult,
  MigrationTranscriptTextParams,
  MigrationTranscriptTextResult,
  MigrationBranchPrepareParams,
  MigrationBranchOperationParams,
  MigrationBranchReadParams,
  MigrationBranchResumeParams,
  MigrationBranchStateResult,
  MigrationBranchCancelResult,
  MigrationBranchPageParams,
  MigrationBranchPageResult,
  MigrationBranchBlocksParams,
  MigrationBranchTextParams,
  MigrationBranchToolsStateResult,
  MigrationBranchToolsPageParams,
  MigrationBranchToolsPageResult,
  MigrationHistoryAttachmentParams,
  MigrationHistoryAttachmentResumeParams,
  MigrationHistoryAttachmentStateResult,
  MigrationHistoryAttachmentChunkParams,
  MigrationHistoryAttachmentChunkResult,
  MigrationHistoryToolAttachmentItemsParams,
  MigrationHistoryToolAttachmentItemsResult,
} from '../../../shared/generated/contracts'

export const MIGRATION_CAPABILITY = 'migrationProvidersV1'
const METHODS = new Set([
  ...Object.values(BATCH_CONTROL_METHODS),
  AGENT_PREVIEW_METHOD,
  PROJECT_MCP_METHOD,
  HISTORY_FAMILIES_METHOD,
  CREDENTIAL_SOURCES_METHOD,
  ...Object.values(RESOURCE_ATTACHMENT_METHODS),
  ...RESOURCE_BUDGET_METHODS,
  ...Object.values(HISTORY_RESOURCE_METHODS),
  ...MEMORY_METHODS,
  ...Object.values(PROJECTS_METHODS),
  ...DEFINITION_METHODS,
  INSTRUCTION_METHODS.page,
  INSTRUCTION_METHODS.body,
  ...SOURCE_UPLOAD_METHODS,
  ...SOURCE_PRODUCT_METHODS,
  ...HISTORY_LIFECYCLE_METHODS,
  'migration/codex/layers/select',
  'migration/codex/layers/read',
  ...UPLOAD_COLLECTION_METHODS,
  'migration/configuration/layers',
  ...['discover', 'plan', 'capture', 'read', 'apply', 'undo', 'cancel', 'resume', 'list'].map(
    name => `migration/plugin/${name}`
  ),
  ...['prepare', 'begin', 'part', 'finish', 'read', 'resume', 'run', 'cancel', 'list', 'chunk'].map(
    name => `migration/history/local-attachment/${name}`
  ),
  'migration/history/reinterpret/preview',
  'migration/history/reinterpret/create',
  'migration/history/undo/lookup',
  'migration/history/undo/preview',
  'migration/history/undo/create',
  'migration/history/undo/read',
  'migration/history/undo/run',
  'migration/history/undo/cancel',
  'migration/history/search',
  'migration/history/continuation/source',
  'migration/history/continuation/create',
  'migration/history/continuation/read',
  'migration/history/continuation/run',
  'migration/history/continuation/resume',
  'migration/history/continuation/cancel',
  'migration/history/tool-attachments/read',
  'migration/history/tool-attachments/run',
  'migration/history/tool-attachments/resume',
  'migration/history/tool-attachments/cancel',
  'migration/history/tool-attachments/chunk',
  'migration/history/tool-attachments/items',
  'migration/history/attachment/read',
  'migration/history/attachment/run',
  'migration/history/attachment/resume',
  'migration/history/attachment/cancel',
  'migration/history/attachment/chunk',
  'migration/history/branch/tools/read',
  'migration/history/branch/tools/run',
  'migration/history/branch/tools/resume',
  'migration/history/branch/tools/cancel',
  'migration/history/branch/tools/page',
  'migration/history/branch/prepare',
  'migration/history/branch/read',
  'migration/history/branch/run',
  'migration/history/branch/cancel',
  'migration/history/branch/resume',
  'migration/history/branch/page',
  'migration/history/branch/blocks',
  'migration/history/branch/text',
  'migration/history/transcript',
  'migration/history/blocks',
  'migration/history/text',
  'migration/history/discover',
  'migration/history/sources',
  'migration/history/create',
  'migration/history/read',
  'migration/history/concurrency',
  'migration/history/run',
  'migration/history/cancel',
  'migration/history/resume',
  'migration/history/jobs',
  'migration/discover',
  'migration/scan',
  'migration/read',
  'migration/items',
  'migration/provider/plan',
  'migration/provider/apply',
  'migration/provider/rollback',
  'migration/cancel',
  'migration/mcp/plan',
  'migration/mcp/apply',
  'migration/mcp/rollback',
  'migration/asset/plan',
  'migration/asset/apply',
  'migration/asset/rollback',
  'migration/asset/preview',
  'migration/batch/scan',
  'migration/batch/plan',
  'migration/batch/apply',
  'migration/batch/run',
  'migration/batch/read',
  'migration/batch/rollback',
  'migration/batch/item/plan',
  'migration/jobs/list',
  'migration/mcp/credential/read',
  'migration/batch/mcp/credential/read',
  'migration/mcp/credential/plan',
  'migration/mcp/credential/apply',
  'migration/mcp/credential/undo',
  'migration/credential/plan',
  'migration/credential/apply',
  'migration/credential/undo',
])

/** Bind source grants and mutations to the explicitly selected target and account epoch. */
export async function requestNativeMigration(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) {
  const valid = captureAccountContextRevision()
  const method = text(params.method)
  if (!method || !METHODS.has(method) || !text(params.deviceId))
    throw new Error('migration_invalid_operation')
  if (HISTORY_VIEW_METHODS.includes(method)) {
    const existing = existingHistoryView(this, params, options)
    if (existing) return existing
  }
  const target = await this.serverForParams(params)
  const scope = hookTargetScope(target)
  const assertScope = () => {
    if (this.disposed || !valid(target.id))
      throw new GatewayRpcError('migration_scope_changed', -32049, {
        kind: 'migration_scope_changed',
      })
  }
  assertScope()
  const sourceRouting =
    method === 'migration/history/continuation/source'
      ? await continuationSourceClient(this, target, params, options)
      : null
  const client =
    sourceRouting?.client ??
    (await this.commandClient(target, text(params.workspacePath) ?? undefined))
  assertScope()
  sourceRouting?.assertCurrent()
  if (
    method === 'migration/history/branch/prepare' &&
    record(params.params).reconstructReadable === true &&
    !client.supportsExperimental?.('migrationHistoryReconstructionV1')
  )
    throw new Error('migration_history_reconstruction_update_required')
  if (method === 'migration/history/concurrency') {
    if (!client.supportsExperimental?.('migrationHistoryJobsV1'))
      throw new Error('migration_update_required')
    if (hookTargetScope(await this.serverForParams(params)) !== scope)
      throw new Error('migration_scope_changed')
    assertScope()
    const supports64 = client.supportsExperimental?.('migrationHistoryConcurrency64V1') === true
    const supports32 = client.supportsExperimental?.('migrationHistoryConcurrency32V1') === true
    // Old targets never receive an optimistic burst based on a client-side default.
    return { maxConcurrentJobs: supports64 ? 64 : supports32 ? 32 : 1, requiresUpdate: !supports64 }
  }
  if (batchControlMethod(method)) {
    if (!client.supportsExperimental?.(BATCH_CONTROL_CAPABILITY))
      throw new Error('migration_batch_control_update_required')
    if (!validBatchControlCall(method, params.params))
      throw new Error('migration_invalid_parameters')
  }
  if (
    method === AGENT_PREVIEW_METHOD ||
    (method === 'migration/batch/plan' && hasAgentAdaptations(params.params))
  ) {
    if (!client.supportsExperimental?.(AGENT_CAPABILITY))
      throw new Error('migration_agent_update_required')
    if (method === AGENT_PREVIEW_METHOD && !validAgentPreview(params.params))
      throw new Error('migration_invalid_parameters')
  }
  if (
    method === PROJECT_MCP_METHOD ||
    (method === 'migration/batch/plan' && record(params.params).projectMcpInheritance != null)
  ) {
    if (!client.supportsExperimental?.(PROJECT_MCP_CAPABILITY))
      throw new Error('migration_project_mcp_update_required')
    if (method === PROJECT_MCP_METHOD && !validProjectMcpCatalog(params.params))
      throw new Error('migration_invalid_parameters')
  }
  if (method === HISTORY_FAMILIES_METHOD) {
    if (!client.supportsExperimental?.(HISTORY_FAMILIES_CAPABILITY))
      throw new Error('migration_history_family_index_update_required')
    if (!validHistoryFamilies(params.params)) throw new Error('migration_invalid_parameters')
  }
  if (method === CREDENTIAL_SOURCES_METHOD) {
    if (!client.supportsExperimental?.(CREDENTIAL_SOURCES_CAPABILITY))
      throw new Error('private_credentials_update_required')
    if (!validCredentialSources(params.params)) throw new Error('migration_invalid_parameters')
  }
  if (
    RESOURCE_BUDGET_METHODS.includes(method as (typeof RESOURCE_BUDGET_METHODS)[number]) ||
    (method === 'migration/batch/scan' && record(params.params).resourceLimits !== undefined)
  ) {
    if (!client.supportsExperimental?.(RESOURCE_BUDGET_CAPABILITY))
      throw new Error('migration_resource_budget_update_required')
    if (method !== 'migration/batch/scan' && !validResourceCall(method, params.params))
      throw new Error('migration_invalid_parameters')
  }
  if (
    method === 'migration/history/create' &&
    record(params.params).resourceLimits !== undefined &&
    !client.supportsExperimental?.('migrationHistoryResourceBudgetV1')
  )
    throw new Error('migration_resource_budget_update_required')
  if (resourceAttachmentMethod(method)) {
    if (!client.supportsExperimental?.(RESOURCE_ATTACHMENT_CAPABILITY))
      throw new Error('migration_resource_budget_update_required')
    if (!validResourceAttachment(method, params.params))
      throw new Error('migration_invalid_parameters')
  }
  if (historyResourceMethod(method)) {
    if (!client.supportsExperimental?.(HISTORY_RESOURCE_CAPABILITY))
      throw new Error('migration_resource_budget_update_required')
    if (!validHistoryResourceCall(method, params.params))
      throw new Error('migration_invalid_parameters')
  }
  if (SOURCE_PRODUCT_METHODS.includes(method)) {
    if (!client.supportsExperimental?.(SOURCE_PRODUCT_CAPABILITY))
      throw new Error('migration_source_uploaded_update_required')
    if (!validSourceProductCall(method, params.params))
      throw new Error('migration_invalid_parameters')
  }
  if (SOURCE_UPLOAD_METHODS.includes(method)) {
    if (!client.supportsExperimental?.(SOURCE_UPLOAD_CAPABILITY))
      throw new Error('migration_source_upload_update_required')
    if (!validSourceUploadCall(method, params.params))
      throw new Error('migration_invalid_parameters')
  }
  if (method === INSTRUCTION_METHODS.page || method === INSTRUCTION_METHODS.body) {
    if (!client.supportsExperimental?.(INSTRUCTION_CAPABILITY))
      throw new Error('migration_instructions_update_required')
    if (!validInstructionCall(method, params.params))
      throw new Error('migration_invalid_parameters')
  }
  const projectParams = record(params.params)
  const projectSources = projectParams.projectSources,
    projectChoices = projectParams.choices
  if (
    ((method === 'migration/batch/scan' &&
      Array.isArray(projectSources) &&
      projectSources.length > 0) ||
      (method === 'migration/batch/plan' &&
        Array.isArray(projectChoices) &&
        projectChoices.some((row: unknown) => record(row).kind === 'project'))) &&
    !client.supportsExperimental?.(PROJECTS_CAPABILITY)
  )
    throw new Error('migration_projects_update_required')
  if (Object.values(PROJECTS_METHODS).some(value => value === method)) {
    if (!client.supportsExperimental?.(PROJECTS_CAPABILITY))
      throw new Error('migration_projects_update_required')
    if (!validProjectCall(method, params.params)) throw new Error('migration_invalid_parameters')
  }
  if (DEFINITION_METHODS.includes(method)) {
    if (!client.supportsExperimental?.(DEFINITIONS_CAPABILITY))
      throw new Error('migration_definitions_update_required')
    if (!validDefinitionCall(method, params.params)) throw new Error('migration_invalid_parameters')
  }
  if (MEMORY_METHODS.includes(method)) {
    if (!client.supportsExperimental?.(MEMORY_CAPABILITY))
      throw new Error('migration_memory_update_required')
    if (!validMemoryCall(method, params.params)) throw new Error('migration_invalid_parameters')
  }
  if (
    ((method === 'migration/asset/plan' && record(params.params).memoryMapping != null) ||
      (method === 'migration/batch/plan' &&
        Array.isArray(record(params.params).choices) &&
        (record(params.params).choices as unknown[]).some(
          choice => record(choice).memoryMapping != null
        ))) &&
    !client.supportsExperimental?.(MEMORY_CAPABILITY)
  )
    throw new Error('migration_memory_update_required')
  if (hookTargetScope(await this.serverForParams(params)) !== scope)
    throw new Error('migration_scope_changed')
  assertScope()
  if (method === 'migration/configuration/layers') {
    if (!client.supportsExperimental?.(CONFIGURATION_LAYERS_CAPABILITY))
      throw new Error('migration_configuration_layers_update_required')
    if (!isMigrationConfigurationLayersParams(params.params))
      throw new Error('migration_invalid_parameters')
  }
  if (
    method.startsWith('migration/codex/layers/') &&
    !client.supportsExperimental?.('migrationCodexLayersV1')
  )
    throw new Error('migration_codex_layers_update_required')
  if (
    (method === 'migration/codex/layers/select' &&
      (!isMigrationCodexLayersSelectParams(params.params) ||
        params.params.includeProject !== true)) ||
    (method === 'migration/codex/layers/read' &&
      !isMigrationConfigurationLayersParams(params.params))
  )
    throw new Error('migration_invalid_parameters')
  if (!client.supportsExperimental?.(MIGRATION_CAPABILITY))
    throw new Error('migration_update_required')
  if (HISTORY_VIEW_METHODS.includes(method)) {
    if (!client.supportsExperimental?.('migrationHistoryViewV1'))
      throw new Error('migration_history_view_update_required')
    return openHistoryView(this, client, params, options)
  }
  if (
    method.startsWith('migration/history/retirement/') &&
    !client.supportsExperimental?.('migrationArchiveRetirementV1')
  )
    throw new Error('migration_history_retirement_update_required')
  if (
    method === 'migration/plugin/discover' &&
    (params.params as { includeUploaded?: boolean }).includeUploaded === true &&
    !client.supportsExperimental?.('migrationSourceUploadedPluginsV1')
  )
    throw new Error('migration_plugins_update_required')
  if (
    ((method === 'migration/plugin/discover' &&
      (params.params as { includeProject?: boolean }).includeProject === true) ||
      (method === 'migration/plugin/plan' &&
        (params.params as { projectMapping?: string }).projectMapping !== undefined)) &&
    !client.supportsExperimental?.('migrationPluginProjectsV1')
  )
    throw new Error('migration_plugins_update_required')
  if (
    method.startsWith('migration/plugin/') &&
    !client.supportsExperimental?.('migrationLocalPluginsV1')
  )
    throw new Error('migration_plugins_update_required')
  if (
    method.startsWith('migration/history/') &&
    !client.supportsExperimental?.('migrationHistoryJobsV1')
  )
    throw new Error('migration_update_required')
  if (
    method.startsWith('migration/history/reinterpret/') &&
    !client.supportsExperimental?.('migrationHistoryReinterpretationV1')
  )
    throw new Error('migration_history_reinterpretation_update_required')
  if (
    method.startsWith('migration/history/upload-collection/') &&
    !client.supportsExperimental?.('migrationUploadCollectionV1')
  )
    throw new Error('migration_upload_collection_update_required')
  if (
    method.startsWith('migration/history/local-attachment/') &&
    !client.supportsExperimental?.('migrationLocalAttachmentsV1')
  )
    throw new Error('migration_local_attachments_update_required')
  if (
    method.startsWith('migration/history/undo/') &&
    !client.supportsExperimental?.('migrationContinuationUndoV1')
  )
    throw new Error('migration_history_undo_update_required')
  if (
    method === 'migration/history/search' &&
    !client.supportsExperimental?.('migrationHistorySearchV1')
  )
    throw new Error('migration_history_search_update_required')
  if (
    method.startsWith('migration/history/branch/') &&
    !client.supportsExperimental?.('migrationHistoryBranchesV1')
  )
    throw new Error('migration_branch_update_required')
  if (
    method.startsWith('migration/history/tool-attachments/') &&
    !client.supportsExperimental?.('migrationHistoryToolAttachmentsV1')
  )
    throw new Error('migration_history_tool_attachments_update_required')
  if (
    method === 'migration/history/continuation/source' &&
    !client.supportsExperimental?.('migrationContinuationSourceV1')
  )
    throw new Error('migration_continuation_source_update_required')
  if (
    method.startsWith('migration/history/continuation/') &&
    !client.supportsExperimental?.('migrationContinuationV1')
  )
    throw new Error('migration_continuation_update_required')
  if (
    method === 'migration/history/continuation/create' &&
    Array.isArray(record(record(params.params).options).localAttachments) &&
    (record(record(params.params).options).localAttachments as unknown[]).length > 0 &&
    !client.supportsExperimental?.('migrationLocalAttachmentsV1')
  )
    throw new Error('migration_local_attachments_update_required')
  if (
    method.startsWith('migration/history/attachment/') &&
    !client.supportsExperimental?.('migrationHistoryAttachmentsV1')
  )
    throw new Error('migration_history_attachments_update_required')
  if (
    method.startsWith('migration/history/branch/tools/') &&
    !client.supportsExperimental?.('migrationBranchToolsV1')
  )
    throw new Error('migration_branch_tools_update_required')
  if (
    ['migration/history/transcript', 'migration/history/blocks', 'migration/history/text'].includes(
      method
    ) &&
    !client.supportsExperimental?.('migrationHistoryReadV1')
  )
    throw new Error('migration_history_read_update_required')
  if (method.startsWith('migration/mcp/') && !client.supportsExperimental?.('migrationMcpV1'))
    throw new Error('migration_update_required')
  if (method.startsWith('migration/asset/') && !client.supportsExperimental?.('migrationAssetsV1'))
    throw new Error('migration_update_required')
  if (
    (method.startsWith('migration/batch/') || method === 'migration/jobs/list') &&
    !client.supportsExperimental?.('migrationBatchV1')
  )
    throw new Error('migration_update_required')
  if (
    ['migration/batch/run', 'migration/batch/read'].includes(method) &&
    !client.supportsExperimental?.('migrationBatchWorkersV1')
  )
    throw new Error('migration_batch_workers_update_required')
  if (
    method === 'migration/batch/plan' &&
    Array.isArray(record(params.params).choices) &&
    (record(params.params).choices as unknown[]).some(choice => record(choice).kind === 'plugin') &&
    !client.supportsExperimental?.('migrationBatchPluginsV1')
  )
    throw new Error('migration_batch_plugins_update_required')
  if (
    method === 'migration/batch/scan' &&
    Array.isArray(record(params.params).pluginSources) &&
    (record(params.params).pluginSources as unknown[]).length > 0 &&
    !client.supportsExperimental?.('migrationBatchPluginsV1')
  )
    throw new Error('migration_batch_plugins_update_required')
  if (
    method === 'migration/batch/scan' &&
    Array.isArray(record(params.params).historySources) &&
    (record(params.params).historySources as unknown[]).length > 0 &&
    !client.supportsExperimental?.('migrationBatchWorkersV1')
  )
    throw new Error('migration_batch_workers_update_required')
  if (
    method === 'migration/batch/plan' &&
    record(params.params).reuseExisting === true &&
    !client.supportsExperimental?.('migrationReuseV1')
  )
    throw new Error('migration_update_required')
  if (
    method.startsWith('migration/mcp/credential/') &&
    !client.supportsExperimental?.('migrationMcpCredentialsV1')
  )
    throw new Error('migration_update_required')
  const readOnly =
    method === BATCH_CONTROL_METHODS.read ||
    method === PROJECT_MCP_METHOD ||
    method === HISTORY_FAMILIES_METHOD ||
    method === CREDENTIAL_SOURCES_METHOD ||
    resourceBudgetReadOnly(method) ||
    resourceAttachmentMethod(method) ||
    method === HISTORY_RESOURCE_METHODS.read ||
    method === AGENT_PREVIEW_METHOD ||
    Object.values(PROJECTS_METHODS).some(value => value === method) ||
    DEFINITION_METHODS.includes(method) ||
    method === INSTRUCTION_METHODS.page ||
    method === INSTRUCTION_METHODS.body ||
    sourceProductReadOnly(method) ||
    sourceUploadReadOnly(method) ||
    memoryReadOnly(method) ||
    [
      'migration/history/retirement/preview',
      'migration/history/retirement/read',
      'migration/history/retirement/list',
      'migration/codex/layers/select',
      'migration/codex/layers/read',
      'migration/configuration/layers',
      'migration/plugin/discover',
      'migration/plugin/read',
      'migration/plugin/list',
      'migration/batch/read',
      'migration/history/upload-collection/attachment',
      'migration/history/upload-collection/read',
      'migration/history/upload-collection/list',
      'migration/history/local-attachment/read',
      'migration/history/local-attachment/list',
      'migration/history/local-attachment/chunk',
      'migration/history/reinterpret/preview',
      'migration/history/undo/lookup',
      'migration/history/undo/preview',
      'migration/history/undo/read',
      'migration/history/search',
      'migration/history/continuation/source',
      'migration/history/continuation/read',
      'migration/history/tool-attachments/read',
      'migration/history/tool-attachments/chunk',
      'migration/history/tool-attachments/items',
      'migration/history/attachment/read',
      'migration/history/attachment/chunk',
      'migration/history/branch/tools/read',
      'migration/history/branch/tools/page',
      'migration/history/branch/read',
      'migration/history/branch/page',
      'migration/history/branch/blocks',
      'migration/history/branch/text',
      'migration/history/transcript',
      'migration/history/blocks',
      'migration/history/text',
      'migration/history/discover',
      'migration/history/sources',
      'migration/history/read',
      'migration/history/jobs',
      'migration/mcp/credential/read',
      'migration/batch/mcp/credential/read',
      'migration/discover',
      'migration/read',
      'migration/items',
      'migration/asset/preview',
      'migration/jobs/list',
      'migration/batch/item/plan',
    ].includes(method)
  if (
    method === 'migration/batch/plan' &&
    Array.isArray(record(params.params).credentials) &&
    (record(params.params).credentials as unknown[]).length > 0 &&
    !client.supportsExperimental?.('migrationBatchCredentialsV1')
  )
    throw new Error('migration_update_required')
  if (
    method.startsWith('migration/credential/') &&
    !client.supportsExperimental?.('migrationCredentialsV1')
  )
    throw new Error('migration_update_required')
  let forwarded = record(params.params)
  if (
    (method === 'migration/batch/mcp/credential/read' ||
      (method === 'migration/batch/plan' &&
        Array.isArray(forwarded.mcpCredentials) &&
        forwarded.mcpCredentials.length > 0)) &&
    !client.supportsExperimental?.('migrationBatchMcpCredentialsV1')
  )
    throw new Error('migration_update_required')
  // Empty optional fields must not make ordinary plans incompatible with older targets.
  if (
    method === 'migration/batch/plan' &&
    Array.isArray(forwarded.mcpCredentials) &&
    forwarded.mcpCredentials.length === 0
  ) {
    forwarded = { ...forwarded }
    delete forwarded.mcpCredentials
  }
  if (
    method === 'migration/batch/item/plan' &&
    forwarded.includeTemplate === true &&
    !client.supportsExperimental?.('migrationTemplateReuseV1')
  ) {
    forwarded = { ...forwarded }
    delete forwarded.includeTemplate
  }
  if (
    method === 'migration/items' &&
    forwarded.includeTemplates === true &&
    !client.supportsExperimental?.('migrationTemplatesV1')
  ) {
    forwarded = { ...forwarded }
    delete forwarded.includeTemplates
  }
  if (
    method === 'migration/batch/plan' &&
    Array.isArray(forwarded.choices) &&
    forwarded.choices.some(choice => record(choice).kind === 'template') &&
    !client.supportsExperimental?.('migrationTemplatesV1')
  )
    throw new Error('migration_update_required')
  if (
    method === 'migration/batch/plan' &&
    forwarded.reuseExisting === true &&
    Array.isArray(forwarded.choices) &&
    forwarded.choices.some(choice => record(choice).kind === 'template') &&
    !client.supportsExperimental?.('migrationTemplateReuseV1')
  )
    throw new Error('migration_template_reuse_update_required')
  if (
    method.startsWith('migration/history/retirement/') &&
    !validateHistoryRetirement(method, forwarded)
  )
    throw new Error('migration_invalid_parameters')
  const result = await client.request(method, forwarded, readOnly ? options : undefined)
  sourceRouting?.assertCurrent()
  if (batchControlMethod(method) && !validBatchControlCall(method, forwarded, result))
    throw new Error('migration_invalid_response')
  assertScope()
  if (method === AGENT_PREVIEW_METHOD && !validAgentPreview(forwarded, result))
    throw new Error('migration_invalid_response')
  if (method === PROJECT_MCP_METHOD && !validProjectMcpCatalog(forwarded, result))
    throw new Error('migration_invalid_response')
  if (method === HISTORY_FAMILIES_METHOD && !validHistoryFamilies(forwarded, result))
    throw new Error('migration_invalid_response')
  if (method === CREDENTIAL_SOURCES_METHOD && !validCredentialSources(forwarded, result))
    throw new Error('migration_invalid_response')
  if (
    RESOURCE_BUDGET_METHODS.includes(method as (typeof RESOURCE_BUDGET_METHODS)[number]) &&
    !validResourceCall(method, forwarded, result)
  )
    throw new Error('migration_invalid_response')
  if (resourceAttachmentMethod(method) && !validResourceAttachment(method, forwarded, result))
    throw new Error('migration_invalid_response')
  if (historyResourceMethod(method) && !validHistoryResourceCall(method, forwarded, result))
    throw new Error('migration_invalid_response')
  if (SOURCE_PRODUCT_METHODS.includes(method) && !validSourceProductCall(method, forwarded, result))
    throw new Error('migration_invalid_response')
  if (SOURCE_UPLOAD_METHODS.includes(method) && !validSourceUploadCall(method, forwarded, result))
    throw new Error('migration_invalid_response')
  if (
    (method === INSTRUCTION_METHODS.page || method === INSTRUCTION_METHODS.body) &&
    !validInstructionCall(method, forwarded, result)
  )
    throw new Error('migration_invalid_response')
  if (
    Object.values(PROJECTS_METHODS).some(value => value === method) &&
    !validProjectCall(method, forwarded, result)
  )
    throw new Error('migration_invalid_response')
  if (DEFINITION_METHODS.includes(method) && !validDefinitionCall(method, forwarded, result))
    throw new Error('migration_invalid_response')
  if (MEMORY_METHODS.includes(method) && !validMemoryCall(method, forwarded, result))
    throw new Error('migration_invalid_response')
  if (
    method.startsWith('migration/history/retirement/') &&
    !validateHistoryRetirement(method, forwarded, result)
  )
    throw new Error('migration_invalid_response')
  if (hookTargetScope(await this.serverForParams(params)) !== scope)
    throw new Error('migration_scope_changed')
  assertScope()
  if (
    method === 'migration/configuration/layers' &&
    (!isMigrationConfigurationLayersResult(result) ||
      !validConfigurationLayers(params.params as MigrationConfigurationLayersParams, result))
  )
    throw new Error('migration_invalid_response')
  const workerState = client.supportsExperimental?.('migrationHistoryWorkerStateV1') === true
  if (
    workerState &&
    [
      'migration/history/create',
      'migration/history/read',
      'migration/history/run',
      'migration/history/cancel',
      'migration/history/resume',
      'migration/history/reinterpret/create',
    ].includes(method) &&
    record(result).job
  ) {
    return normalizeHistoryExecution(result as MigrationHistoryJobResult, true)
  }
  if (workerState && method === 'migration/history/jobs' && Array.isArray(record(result).jobs)) {
    const jobs = result as MigrationHistoryJobsResult
    return { ...jobs, jobs: jobs.jobs.map(job => normalizeHistoryExecution(job, true)) }
  }
  return result
}

export function createMigrationApi(
  deviceId: string,
  workspacePath?: string,
  toolAttachments = false
) {
  const attachmentPrefix = toolAttachments
    ? 'migration/history/tool-attachments'
    : 'migration/history/attachment'
  const invoke = <T>(method: string, params: object, options?: { signal?: AbortSignal }) => {
    const payload = { deviceId, workspacePath, method, params }
    return options
      ? requestLocalExecutor<T>('runtime.migration.request', payload, options)
      : requestLocalExecutor<T>('runtime.migration.request', payload)
  }
  return {
    ...createBatchControlApi(invoke),
    ...createProjectMcpApi(invoke),
    ...createCredentialSourcesApi(invoke),
    ...createResourceBudgetApi(invoke),
    ...createHistoryResourceApi(invoke),
    ...createResourceAttachmentApi(invoke),
    ...createMemoryApi(invoke),
    ...createProjectsApi(invoke),
    ...createDefinitionsApi(invoke),
    ...createAgentApi(invoke),
    ...createInstructionApi(invoke),
    ...createSourceUploadApi(invoke),
    ...createSourceProductApi(invoke),
    ...createHistoryLifecycleApi(invoke),
    ...createCodexLayersApi(invoke),
    ...createUploadCollectionApi(invoke),
    configurationLayers: (
      params: MigrationConfigurationLayersParams,
      options?: { signal?: AbortSignal }
    ) =>
      invoke<MigrationConfigurationLayersResult>('migration/configuration/layers', params, options),
    localAttachmentPrepare: (params: MigrationLocalAttachmentPrepareParams) =>
      invoke<MigrationLocalAttachmentStateResult>(
        'migration/history/local-attachment/prepare',
        params
      ),
    localAttachmentBegin: (params: MigrationLocalAttachmentBeginParams) =>
      invoke<MigrationLocalAttachmentStateResult>(
        'migration/history/local-attachment/begin',
        params
      ),
    localAttachmentPart: (params: MigrationLocalAttachmentPartParams) =>
      invoke<MigrationLocalAttachmentStateResult>(
        'migration/history/local-attachment/part',
        params
      ),
    localAttachmentFinish: (params: MigrationLocalAttachmentRunParams) =>
      invoke<MigrationLocalAttachmentStateResult>(
        'migration/history/local-attachment/finish',
        params
      ),
    localAttachmentRead: (
      params: MigrationLocalAttachmentReadParams,
      options?: { signal?: AbortSignal }
    ) =>
      invoke<MigrationLocalAttachmentStateResult>(
        'migration/history/local-attachment/read',
        params,
        options
      ),
    localAttachmentResume: (params: MigrationLocalAttachmentRunParams) =>
      invoke<MigrationLocalAttachmentStateResult>(
        'migration/history/local-attachment/resume',
        params
      ),
    localAttachmentRun: (params: MigrationLocalAttachmentRunParams) =>
      invoke<MigrationLocalAttachmentStateResult>('migration/history/local-attachment/run', params),
    localAttachmentCancel: (params: MigrationLocalAttachmentReadParams) =>
      invoke<MigrationLocalAttachmentStateResult>(
        'migration/history/local-attachment/cancel',
        params
      ),
    localAttachmentList: (
      params: MigrationLocalAttachmentListParams,
      options?: { signal?: AbortSignal }
    ) =>
      invoke<MigrationLocalAttachmentListResult>(
        'migration/history/local-attachment/list',
        params,
        options
      ),
    localAttachmentChunk: (
      params: MigrationLocalAttachmentChunkParams,
      options?: { signal?: AbortSignal }
    ) =>
      invoke<MigrationHistoryAttachmentChunkResult>(
        'migration/history/local-attachment/chunk',
        params,
        options
      ),
    undoLookup: (params: MigrationHistoryUndoLookupParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationHistoryUndoLookupResult>('migration/history/undo/lookup', params, options),
    undoPreview: (params: MigrationHistoryUndoPreviewParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationHistoryUndoPreviewResult>('migration/history/undo/preview', params, options),
    undoCreate: (params: MigrationHistoryUndoCreateParams) =>
      invoke<MigrationHistoryUndoStateResult>('migration/history/undo/create', params),
    undoRead: (params: MigrationHistoryUndoReadParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationHistoryUndoStateResult>('migration/history/undo/read', params, options),
    undoRun: (params: MigrationHistoryUndoRunParams) =>
      invoke<MigrationHistoryUndoStateResult>('migration/history/undo/run', params),
    undoCancel: (params: MigrationHistoryUndoReadParams) =>
      invoke<MigrationHistoryUndoStateResult>('migration/history/undo/cancel', params),
    historySearch: (params: MigrationHistorySearchParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationHistorySearchResult>('migration/history/search', params, options),
    continuationSource: (
      params: MigrationContinuationSourceParams,
      options?: { signal?: AbortSignal }
    ) =>
      invoke<MigrationContinuationSourceResult>(
        'migration/history/continuation/source',
        params,
        options
      ),
    continuationCreate: (params: MigrationContinuationCreateParams) =>
      invoke<MigrationContinuationStateResult>('migration/history/continuation/create', params),
    continuationRead: (
      params: MigrationContinuationReadParams,
      options?: { signal?: AbortSignal }
    ) =>
      invoke<MigrationContinuationStateResult>(
        'migration/history/continuation/read',
        params,
        options
      ),
    continuationRun: (params: MigrationContinuationRunParams) =>
      invoke<MigrationContinuationStateResult>('migration/history/continuation/run', params),
    continuationResume: (params: MigrationContinuationRunParams) =>
      invoke<MigrationContinuationStateResult>('migration/history/continuation/resume', params),
    continuationCancel: (params: MigrationContinuationReadParams) =>
      invoke<MigrationContinuationStateResult>('migration/history/continuation/cancel', params),
    historyAttachmentItems: (
      params: MigrationHistoryToolAttachmentItemsParams,
      options?: { signal?: AbortSignal }
    ) =>
      invoke<MigrationHistoryToolAttachmentItemsResult>(
        'migration/history/tool-attachments/items',
        params,
        options
      ),
    historyAttachmentRead: (
      params: MigrationHistoryAttachmentParams,
      options?: { signal?: AbortSignal }
    ) => invoke<MigrationHistoryAttachmentStateResult>(`${attachmentPrefix}/read`, params, options),
    historyAttachmentRun: (params: MigrationHistoryAttachmentParams) =>
      invoke<MigrationHistoryAttachmentStateResult>(`${attachmentPrefix}/run`, params),
    historyAttachmentResume: (params: MigrationHistoryAttachmentResumeParams) =>
      invoke<MigrationHistoryAttachmentStateResult>(`${attachmentPrefix}/resume`, params),
    historyAttachmentCancel: (params: MigrationHistoryAttachmentParams) =>
      invoke<MigrationHistoryAttachmentStateResult>(`${attachmentPrefix}/cancel`, params),
    historyAttachmentChunk: (
      params: MigrationHistoryAttachmentChunkParams,
      options?: { signal?: AbortSignal }
    ) =>
      invoke<MigrationHistoryAttachmentChunkResult>(`${attachmentPrefix}/chunk`, params, options),
    branchToolsRead: (params: MigrationBranchOperationParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationBranchToolsStateResult>(
        'migration/history/branch/tools/read',
        params,
        options
      ),
    branchToolsRun: (params: MigrationBranchOperationParams) =>
      invoke<MigrationBranchToolsStateResult>('migration/history/branch/tools/run', params),
    branchToolsResume: (params: MigrationBranchResumeParams) =>
      invoke<MigrationBranchToolsStateResult>('migration/history/branch/tools/resume', params),
    branchToolsCancel: (params: MigrationBranchOperationParams) =>
      invoke<MigrationBranchCancelResult>('migration/history/branch/tools/cancel', params),
    branchToolsPage: (params: MigrationBranchToolsPageParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationBranchToolsPageResult>(
        'migration/history/branch/tools/page',
        params,
        options
      ),
    branchPrepare: (params: MigrationBranchPrepareParams) =>
      invoke<MigrationBranchStateResult>('migration/history/branch/prepare', params),
    branchRead: (params: MigrationBranchReadParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationBranchStateResult>('migration/history/branch/read', params, options),
    branchRun: (params: MigrationBranchOperationParams) =>
      invoke<MigrationBranchStateResult>('migration/history/branch/run', params),
    branchCancel: (params: MigrationBranchOperationParams) =>
      invoke<MigrationBranchCancelResult>('migration/history/branch/cancel', params),
    branchResume: (params: MigrationBranchResumeParams) =>
      invoke<MigrationBranchStateResult>('migration/history/branch/resume', params),
    branchPage: (params: MigrationBranchPageParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationBranchPageResult>('migration/history/branch/page', params, options),
    branchBlocks: (params: MigrationBranchBlocksParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationTranscriptBlocksResult>('migration/history/branch/blocks', params, options),
    branchText: (params: MigrationBranchTextParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationTranscriptTextResult>('migration/history/branch/text', params, options),
    transcriptPage: (params: MigrationTranscriptPageParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationTranscriptPageResult>('migration/history/transcript', params, options),
    transcriptBlocks: (
      params: MigrationTranscriptBlocksParams,
      options?: { signal?: AbortSignal }
    ) => invoke<MigrationTranscriptBlocksResult>('migration/history/blocks', params, options),
    transcriptText: (params: MigrationTranscriptTextParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationTranscriptTextResult>('migration/history/text', params, options),
    ...createHistoryFamiliesApi(invoke),
    historyConcurrency: (options?: { signal?: AbortSignal }) =>
      invoke<{ maxConcurrentJobs: number; requiresUpdate: boolean }>(
        'migration/history/concurrency',
        {},
        options
      ),
    historyDiscover: (params: MigrationHistoryDiscoverParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationHistorySourcesResult>('migration/history/discover', params, options),
    historySources: (params: MigrationHistorySourcesParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationHistorySourcesResult>('migration/history/sources', params, options),
    historyCreate: (params: MigrationHistoryCreateParams) =>
      invoke<MigrationHistoryJobResult>('migration/history/create', params),
    historyReinterpretPreview: (
      params: MigrationHistoryReinterpretPreviewParams,
      options?: { signal?: AbortSignal }
    ) =>
      invoke<MigrationHistoryReinterpretPreviewResult>(
        'migration/history/reinterpret/preview',
        params,
        options
      ),
    historyReinterpretCreate: (params: MigrationHistoryReinterpretCreateParams) =>
      invoke<MigrationHistoryJobResult>('migration/history/reinterpret/create', params),
    historyRead: (jobId: string, options?: { signal?: AbortSignal }) =>
      invoke<MigrationHistoryJobResult>('migration/history/read', { jobId }, options),
    historyRun: (params: MigrationHistoryRunParams) =>
      invoke<MigrationHistoryJobResult>('migration/history/run', params),
    historyCancel: (jobId: string) =>
      invoke<MigrationHistoryJobResult>('migration/history/cancel', { jobId }),
    historyResume: (params: MigrationHistoryRunParams) =>
      invoke<MigrationHistoryJobResult>('migration/history/resume', params),
    historyJobs: (params: MigrationJobsListParams, options?: { signal?: AbortSignal }) =>
      invoke<MigrationHistoryJobsResult>('migration/history/jobs', params, options),
    readBatchMcpCredentials: (jobId: string, options?: { signal?: AbortSignal }) =>
      invoke<MigrationMcpCredentialsResult>(
        'migration/batch/mcp/credential/read',
        { jobId },
        options
      ),
    readMcpCredentials: (jobId: string, options?: { signal?: AbortSignal }) =>
      invoke<MigrationMcpCredentialsResult>('migration/mcp/credential/read', { jobId }, options),
    planMcpCredentials: (params: MigrationMcpCredentialPlanParams) =>
      invoke<MigrationMcpCredentialsResult>('migration/mcp/credential/plan', params),
    applyMcpCredentials: (params: MigrationCredentialOperationParams) =>
      invoke<MigrationMcpCredentialsResult>('migration/mcp/credential/apply', params),
    undoMcpCredentials: (params: MigrationCredentialOperationParams) =>
      invoke<MigrationMcpCredentialsResult>('migration/mcp/credential/undo', params),
    planCredential: (params: MigrationCredentialPlanParams) =>
      invoke<MigrationJobReadResult>('migration/credential/plan', params),
    applyCredential: (params: MigrationCredentialOperationParams) =>
      invoke<MigrationJobReadResult>('migration/credential/apply', params),
    undoCredential: (params: MigrationCredentialOperationParams) =>
      invoke<MigrationJobReadResult>('migration/credential/undo', params),
    scanBatch: (params: MigrationBatchScanParams) =>
      invoke<MigrationJobReadResult>('migration/batch/scan', params),
    planBatch: (params: MigrationBatchPlanParams) =>
      invoke<MigrationJobReadResult>('migration/batch/plan', params),
    applyBatch: (params: MigrationBatchOperationParams) =>
      invoke<MigrationJobReadResult>('migration/batch/apply', params),
    runBatch: (params: MigrationBatchRunParams) =>
      invoke<MigrationBatchStateResult>('migration/batch/run', params),
    readBatch: (jobId: string, options?: { signal?: AbortSignal }) =>
      invoke<MigrationBatchStateResult>('migration/batch/read', { jobId }, options),
    rollbackBatch: (params: MigrationBatchOperationParams) =>
      invoke<MigrationJobReadResult>('migration/batch/rollback', params),
    listJobs: (params: MigrationJobsListParams) =>
      invoke<MigrationJobsListResult>('migration/jobs/list', params),
    readBatchItem: (params: MigrationBatchItemPlanParams) =>
      invoke<MigrationBatchItemPlanResult>('migration/batch/item/plan', params),
    planAsset: (params: MigrationAssetPlanParams) =>
      invoke<MigrationJobReadResult>('migration/asset/plan', params),
    applyAsset: (params: MigrationProviderOperationParams) =>
      invoke<MigrationJobReadResult>('migration/asset/apply', params),
    rollbackAsset: (params: MigrationProviderOperationParams) =>
      invoke<MigrationJobReadResult>('migration/asset/rollback', params),
    previewAsset: (params: MigrationAssetPreviewParams) =>
      invoke<MigrationAssetPreviewResult>('migration/asset/preview', params),
    planMcp: (params: MigrationMcpPlanParams) =>
      invoke<MigrationJobReadResult>('migration/mcp/plan', params),
    applyMcp: (params: MigrationProviderOperationParams) =>
      invoke<MigrationJobReadResult>('migration/mcp/apply', params),
    rollbackMcp: (params: MigrationProviderOperationParams) =>
      invoke<MigrationJobReadResult>('migration/mcp/rollback', params),
    discover: (params: MigrationDiscoverParams) =>
      invoke<MigrationDiscoverResult>('migration/discover', params),
    scan: (params: MigrationScanParams) => invoke<MigrationJobReadResult>('migration/scan', params),
    read: (jobId: string) => invoke<MigrationJobReadResult>('migration/read', { jobId }),
    items: (params: MigrationItemsParams) =>
      invoke<MigrationItemsResult>('migration/items', params),
    plan: (params: MigrationProviderPlanParams) =>
      invoke<MigrationJobReadResult>('migration/provider/plan', params),
    apply: (params: MigrationProviderOperationParams) =>
      invoke<MigrationJobReadResult>('migration/provider/apply', params),
    rollback: (params: MigrationProviderOperationParams) =>
      invoke<MigrationJobReadResult>('migration/provider/rollback', params),
    cancel: (params: MigrationCancelParams) =>
      invoke<MigrationJobReadResult>('migration/cancel', params),
  }
}
