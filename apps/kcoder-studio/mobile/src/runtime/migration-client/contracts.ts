import { BATCH_CONTROL_CALLS, type BatchControlCalls } from './batch-control-contracts';
import { PROJECTS_CALLS, type ProjectsCalls } from './projects-contracts';
import { INSTRUCTION_CALLS, type InstructionCalls } from './instruction-contracts';
import { RESOURCE_CALLS, type ResourceCalls } from './resource-contracts';
import { DEFINITIONS_CALLS, type DefinitionsCalls } from './definitions-contracts';
import * as C from "../../../../shared/generated/contracts";
import { HISTORICAL_CALLS, type HistoricalCalls } from "./history-contracts";
import { HISTORY_LIFECYCLE_CALLS, type HistoryLifecycleCalls } from './history-lifecycle-contracts';
import { MEMORY_CALLS, type MemoryCalls } from './memory-contracts';
import { SOURCE_UPLOAD_CALLS, type SourceUploadCalls } from './source-upload-contracts';
import { CREDENTIAL_SOURCES_CALLS, type CredentialSourcesCalls } from './credential-sources-contracts';
import { HISTORY_FAMILIES_CALLS, type HistoryFamiliesCalls } from './history-families-contracts';

export interface MigrationCalls extends BatchControlCalls, ProjectsCalls, InstructionCalls, ResourceCalls, DefinitionsCalls, HistoricalCalls, HistoryLifecycleCalls, MemoryCalls, SourceUploadCalls, CredentialSourcesCalls, HistoryFamiliesCalls {
  agentPreview: [C.MigrationAgentPreviewParams, C.MigrationAgentPreviewResult];
  projectMcpCatalog: [C.MigrationProjectMcpCatalogParams, C.MigrationProjectMcpCatalogResult];
  codexLayersSelect: [C.MigrationCodexLayersSelectParams,C.MigrationCodexLayersSelectResult];
  codexLayersRead: [C.MigrationConfigurationLayersParams,C.MigrationCodexLayersReadResult];
  configurationLayers: [C.MigrationConfigurationLayersParams, C.MigrationConfigurationLayersResult];
  jobs: [C.MigrationJobsListParams, C.MigrationJobsListResult];
  discover: [C.MigrationDiscoverParams, C.MigrationDiscoverResult];
  scan: [C.MigrationBatchScanParams, C.MigrationJobReadResult];
  items: [C.MigrationItemsParams, C.MigrationItemsResult];
  plan: [C.MigrationBatchPlanParams, C.MigrationJobReadResult];
  batchRead: [C.MigrationOperationParams, C.MigrationBatchStateResult];
  batchRun: [C.MigrationBatchRunParams, C.MigrationBatchStateResult];
  cancel: [C.MigrationCancelParams, C.MigrationJobReadResult];
  historyDiscover: [C.MigrationHistoryDiscoverParams, C.MigrationHistorySourcesResult];
  historySources: [C.MigrationHistorySourcesParams, C.MigrationHistorySourcesResult];
  pluginDiscover: [C.MigrationPluginDiscoverParams, C.MigrationPluginDiscoverResult];
  pluginPlan: [C.MigrationPluginPlanParams, C.MigrationPluginStateResult];
  pluginRead: [C.MigrationPluginReadParams, C.MigrationPluginStateResult];
  pluginCapture: [C.MigrationPluginOperationParams, C.MigrationPluginStateResult];
  pluginCancel: [C.MigrationPluginOperationParams, C.MigrationPluginStateResult];
  pluginResume: [C.MigrationPluginOperationParams, C.MigrationPluginStateResult];
  pluginUndo: [C.MigrationPluginOperationParams, C.MigrationPluginStateResult];
  pluginList: [C.MigrationPluginListParams, C.MigrationPluginListResult];
  mcpCredentials: [C.MigrationOperationParams, C.MigrationMcpCredentialsResult];
  itemPlan: [C.MigrationBatchItemPlanParams, C.MigrationBatchItemPlanResult];
  assetPreview: [C.MigrationAssetPreviewParams, C.MigrationAssetPreviewResult];
}
interface Rule { method: string; caps: string[]; read: boolean; transient?: boolean; params(value: unknown): boolean; result(value: unknown): boolean; rows?: string[] }
const batch = ["migrationBatchV1"];
const plugins = ["migrationLocalPluginsV1"];
export const CALLS: Record<keyof MigrationCalls, Rule> = {
  agentPreview: { method: 'migration/agent/preview', caps: ['migrationAgentAdaptationV1'], read: true, params: C.isMigrationAgentPreviewParams, result: C.isMigrationAgentPreviewResult },
  projectMcpCatalog: { method: 'migration/project/mcp/catalog', caps: ['migrationProjectMcpInheritanceV1'], read: true, params: C.isMigrationProjectMcpCatalogParams, result: C.isMigrationProjectMcpCatalogResult, rows: ['names'] },
  ...BATCH_CONTROL_CALLS,
  ...PROJECTS_CALLS,
  ...RESOURCE_CALLS,
  ...CREDENTIAL_SOURCES_CALLS,
  ...MEMORY_CALLS,
  ...SOURCE_UPLOAD_CALLS,
  ...INSTRUCTION_CALLS, ...DEFINITIONS_CALLS,
  ...HISTORICAL_CALLS,
  ...HISTORY_LIFECYCLE_CALLS,
  ...HISTORY_FAMILIES_CALLS,
  codexLayersSelect: { method:"migration/codex/layers/select",caps:["migrationCodexLayersV1"],read:true,params:C.isMigrationCodexLayersSelectParams,result:C.isMigrationCodexLayersSelectResult },
  codexLayersRead: { method:"migration/codex/layers/read",caps:["migrationCodexLayersV1"],read:true,params:C.isMigrationConfigurationLayersParams,result:C.isMigrationCodexLayersReadResult,rows:["fields"] },
  configurationLayers: { method: "migration/configuration/layers", caps: ["migrationConfigurationLayersV1"], read: true, params: C.isMigrationConfigurationLayersParams, result: C.isMigrationConfigurationLayersResult, rows: ["fields"] },
  jobs: { method: "migration/jobs/list", caps: batch, read: true, params: C.isMigrationJobsListParams, result: C.isMigrationJobsListResult, rows: ["jobs"] },
  discover: { method: "migration/discover", caps: ["migrationProvidersV1"], read: true, params: C.isMigrationDiscoverParams, result: C.isMigrationDiscoverResult },
  scan: { method: "migration/batch/scan", caps: batch, read: false, params: C.isMigrationBatchScanParams, result: C.isMigrationJobReadResult },
  items: { method: "migration/items", caps: ["migrationProvidersV1"], read: true, params: C.isMigrationItemsParams, result: C.isMigrationItemsResult, rows: ["items", "providers", "mcps", "assets", "templates", "drafts", "planned"] },
  plan: { method: "migration/batch/plan", caps: batch, read: false, params: C.isMigrationBatchPlanParams, result: C.isMigrationJobReadResult },
  batchRead: { method: "migration/batch/read", caps: [...batch, "migrationBatchWorkersV1"], read: true, params: C.isMigrationOperationParams, result: C.isMigrationBatchStateResult },
  batchRun: { method: "migration/batch/run", caps: [...batch, "migrationBatchWorkersV1"], read: false, params: C.isMigrationBatchRunParams, result: C.isMigrationBatchStateResult },
  cancel: { method: "migration/cancel", caps: ["migrationProvidersV1"], read: false, params: C.isMigrationCancelParams, result: C.isMigrationJobReadResult },
  historyDiscover: { method: "migration/history/discover", caps: ["migrationHistoryJobsV1"], read: true, params: C.isMigrationHistoryDiscoverParams, result: C.isMigrationHistorySourcesResult, rows: ["items"] },
  historySources: { method: "migration/history/sources", caps: ["migrationHistoryJobsV1"], read: true, params: C.isMigrationHistorySourcesParams, result: C.isMigrationHistorySourcesResult, rows: ["items"] },
  pluginDiscover: { method: "migration/plugin/discover", caps: plugins, read: true, params: C.isMigrationPluginDiscoverParams, result: C.isMigrationPluginDiscoverResult, rows: ["candidates"] },
  pluginPlan: { method: "migration/plugin/plan", caps: plugins, read: false, params: C.isMigrationPluginPlanParams, result: C.isMigrationPluginStateResult },
  pluginRead: { method: "migration/plugin/read", caps: plugins, read: true, params: C.isMigrationPluginReadParams, result: C.isMigrationPluginStateResult },
  pluginCapture: { method: "migration/plugin/capture", caps: plugins, read: false, params: C.isMigrationPluginOperationParams, result: C.isMigrationPluginStateResult },
  pluginCancel: { method: "migration/plugin/cancel", caps: plugins, read: false, params: C.isMigrationPluginOperationParams, result: C.isMigrationPluginStateResult },
  pluginResume: { method: "migration/plugin/resume", caps: plugins, read: false, params: C.isMigrationPluginOperationParams, result: C.isMigrationPluginStateResult },
  pluginUndo: { method: "migration/plugin/undo", caps: plugins, read: false, params: C.isMigrationPluginOperationParams, result: C.isMigrationPluginStateResult },
  pluginList: { method: "migration/plugin/list", caps: plugins, read: true, params: C.isMigrationPluginListParams, result: C.isMigrationPluginListResult, rows: ["items"] },
  mcpCredentials: { method: "migration/batch/mcp/credential/read", caps: ["migrationBatchMcpCredentialsV1"], read: true, params: C.isMigrationOperationParams, result: C.isMigrationMcpCredentialsResult },
  itemPlan: { method: "migration/batch/item/plan", caps: batch, read: true, params: C.isMigrationBatchItemPlanParams, result: C.isMigrationBatchItemPlanResult },
  assetPreview: { method: "migration/asset/preview", caps: ["migrationAssetsV1"], read: true, params: C.isMigrationAssetPreviewParams, result: C.isMigrationAssetPreviewResult },
};
export type { MigrationBatchChoice, MigrationBatchCredentialChoice, MigrationBatchMcpCredentialChoice, MigrationJobReadResult, MigrationItemsResult, MigrationPluginStateResult, MigrationPluginJob, MigrationPluginCandidate, MigrationSourceSummary, MigrationSourceKind, MigrationHistorySourcesResult, MigrationBatchHistorySource, MigrationBatchPluginSource } from "../../../../shared/generated/contracts";
