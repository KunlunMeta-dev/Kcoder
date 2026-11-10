import { isRemoteOperationControlMethod } from './remotes/controlContracts.mjs';
import { isContract } from './generated/validator.mjs';

export const INTEGRATION_CONTROL_CAPABILITIES = Object.freeze([
  'integrationScopeV1', 'memoryReviewV1', 'integrationOperationReceiptsV1',
  'integrationTaskStateV1', 'nativeCodeServicesV1',
  'knowledgePublicationsV1', 'automationTemplatesV1', 'automationTaskModelsV1', 'automationPeriodBudgetsV1',
  'officeWorkspaceV1', 'officeExportAcknowledgementV1', 'officeExportReceiptV1', 'remoteOperationControlV1',
  'browserProfilesV1',
  'browserProfileSessionsV1',
  'officeSettingsV1', 'knowledgeSettingsV1', 'connectivitySettingsV1', 'modelPoliciesV1', 'modelHealthV1', 'modelUsageV1', 'modelPolicySettingsV1',
  'taskWorkspaceV1', 'taskWorkspaceSourcesV1',
  'taskSourceDirectoryV1', 'taskSourcesV1', 'taskResourceBindingsV1', 'taskSourceChoicesV1', 'connectivityV1',
]);

/** Generated Rust method enums are the finite public control surface. */
export function integrationControlCapability(method) {
  if (method === 'integrations/scope/read') return 'integrationScopeV1';
  if (method === 'integrations/operation/read') return 'integrationOperationReceiptsV1';
  if (method === 'integrations/runtime/readTaskState' || method === 'integrations/runtime/taskStateChanged') return 'integrationTaskStateV1';
  if (isContract('NativeCodeServiceMethod', method)) return 'nativeCodeServicesV1';
  if (isContract('IntegrationMemoryMethod', method)) return 'memoryReviewV1';
  if (isContract('BrowserProfilesMethod', method)) return 'browserProfilesV1';
  if (isContract('IntegrationKnowledgeMethod', method)) return 'knowledgePublicationsV1';
  if (isContract('IntegrationAutomationMethod', method)) return 'automationTemplatesV1';
  if (method === 'integrations/artifact/acknowledgeExport' && isContract('OfficeMethod', method)) return 'officeExportAcknowledgementV1';
  if (isContract('OfficeMethod', method)) return 'officeWorkspaceV1';
  if (method === 'integrations/models/readHealth' && isContract('ModelPoliciesMethod', method)) return 'modelHealthV1';
  if (method === 'integrations/models/readUsage' && isContract('ModelPoliciesMethod', method)) return 'modelUsageV1';
  if (isContract('ModelPoliciesMethod', method)) return 'modelPoliciesV1';
  if (isContract('ModelPolicySettingsMethod', method)) return 'modelPolicySettingsV1';
  if (isRemoteOperationControlMethod(method)) return 'remoteOperationControlV1';
  if (isContract('TaskWorkspaceMethod', method)) return 'taskWorkspaceV1';
  if (isContract('TaskCapabilityScopeDirectoryMethod', method)) return 'taskSourceDirectoryV1';
  if (isContract('TaskCapabilitySourceChoicesMethod', method)) return 'taskSourceChoicesV1';
  if (isContract('TaskCapabilityScopeMethod', method)) return 'taskSourcesV1';
  if (isContract('ConnectivityControlMethod', method)) return 'connectivityV1';
  return null;
}
