export type IntegrationControlCapability = 'integrationScopeV1' | 'memoryReviewV1'
  | 'integrationTaskStateV1' | 'nativeCodeServicesV1'
  | 'integrationOperationReceiptsV1' | 'knowledgePublicationsV1' | 'automationTemplatesV1'
  | 'automationTaskModelsV1' | 'automationPeriodBudgetsV1'
  | 'officeWorkspaceV1' | 'officeExportAcknowledgementV1' | 'officeExportReceiptV1' | 'remoteOperationControlV1'
  | 'browserProfilesV1'
  | 'browserProfileSessionsV1'
  | 'officeSettingsV1' | 'knowledgeSettingsV1' | 'connectivitySettingsV1' | 'modelPoliciesV1' | 'modelHealthV1' | 'modelUsageV1' | 'modelPolicySettingsV1'
  | 'taskWorkspaceV1' | 'taskWorkspaceSourcesV1'
  | 'taskSourceDirectoryV1' | 'taskSourcesV1' | 'taskResourceBindingsV1' | 'taskSourceChoicesV1' | 'connectivityV1'
export const INTEGRATION_CONTROL_CAPABILITIES: readonly IntegrationControlCapability[]
export function integrationControlCapability(method: unknown): IntegrationControlCapability | null
