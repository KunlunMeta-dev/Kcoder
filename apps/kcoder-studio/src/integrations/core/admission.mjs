import { isRemoteOperationControlParams, isRemoteOperationListParams } from '../../../shared/remotes/controlContracts.mjs';
import { isContract } from '../../../shared/generated/validator.mjs';
import { INTEGRATION_CONTROL_CAPABILITIES, integrationControlCapability } from '../../../shared/integrationControlMethods.mjs';
import { isTaskStateObservation } from '../../../shared/taskStateObservations.mjs';

export const INTEGRATION_CLIENT_CAPABILITIES = INTEGRATION_CONTROL_CAPABILITIES;

export const integrationCapability = integrationControlCapability;

/** Only the negotiated Native producer may emit task metadata to this client. */
export function projectTaskStateNotification(message, client, experimental) {
  if (message.method !== 'integrations/runtime/taskStateChanged') return message;
  if (!client?.initialized || client?.integrationScopeV1 !== true || client?.integrationTaskStateV1 !== true
    || experimental?.integrationScopeV1 !== true || experimental?.integrationTaskStateV1 !== true
    || !isTaskStateObservation(message.params)) return null;
  return message;
}

export function projectIntegrationCapabilities(experimental, client) {
  const result = { ...experimental };
  const scopeReady = experimental.integrationScopeV1 === true && client?.integrationScopeV1 === true;
  for (const capability of INTEGRATION_CLIENT_CAPABILITIES) {
    if (Object.hasOwn(result, capability)) result[capability] = scopeReady && result[capability] === true && client?.[capability] === true;
  }
  if (Object.hasOwn(result, 'officeExportAcknowledgementV1'))
    result.officeExportAcknowledgementV1 = result.officeExportAcknowledgementV1 === true
      && result.officeWorkspaceV1 === true && result.automationTemplatesV1 === true;
  if (Object.hasOwn(result, 'officeExportReceiptV1'))
    result.officeExportReceiptV1 = result.officeExportReceiptV1 === true && result.officeWorkspaceV1 === true;
  return result;
}

export class IntegrationAdmissionError extends Error {
  constructor(code = -32071, message = 'INTEGRATION_CAPABILITY_UNAVAILABLE') {
    super(message);
    this.code = code;
  }
}

/** Validate at the actual send boundary; peer opt-ins never authorize this client. */
export function assertIntegrationAdmission(message, client, experimental, attached) {
  const profiledStart = message?.method === 'browser/start' && message.params?.profile != null;
  const profileControl = ['browser/profile/handoff','browser/profile/humanAction','browser/profile/controlRead'].includes(message?.method);
  const ordinaryOfficeAck = message?.method === 'integrations/artifact/acknowledgeExport'
    && !Object.hasOwn(message.params?.payload ?? {}, 'automationRunId');
  const capability = ordinaryOfficeAck ? 'officeExportReceiptV1'
    : profiledStart || profileControl ? 'browserProfileSessionsV1' : integrationCapability(message?.method);
  if (!capability) return;
  if (!attached || client?.initialized !== true || client?.[capability] !== true
    || client?.integrationScopeV1 !== true || experimental?.[capability] !== true
    || experimental?.integrationScopeV1 !== true) throw new IntegrationAdmissionError();
  const name = profiledStart ? 'BrowserProfileSelection' : profileControl ? (message.method === 'browser/profile/handoff' ? 'BrowserHandoffParams' : message.method === 'browser/profile/controlRead' ? 'BrowserControlReadParams' : 'BrowserHumanActionParams') : capability === 'integrationScopeV1' ? 'IntegrationScopeReadParams' : capability === 'integrationTaskStateV1' ? 'IntegrationTaskStateReadParams' : 'IntegrationRequest';
  if (message.method === 'integrations/runtime/taskStateChanged') throw new IntegrationAdmissionError(-32600, 'INTEGRATION_NOTIFICATION_IS_NATIVE_ONLY');
  if (!Object.hasOwn(message, 'id') || !(capability === 'remoteOperationControlV1' ? (message.method === 'integrations/remotes/listOperations' ? isRemoteOperationListParams(message.params) : isRemoteOperationControlParams(message.params)) : isContract(name, profiledStart ? message.params.profile : message.params))) {
    throw new IntegrationAdmissionError(-32602, 'INTEGRATION_REQUEST_INVALID');
  }
  if (capability === 'nativeCodeServicesV1') {
    const prepare = message.method === 'integrations/services/code/prepare';
    if (!isContract(prepare ? 'NativeCodeServicePreparePayload' : 'NativeCodeServiceLocator', message.params.payload)
      || prepare && (message.params.payload.explicitBackgroundConsent !== true
        || !Number.isSafeInteger(message.params.payload.expiresInMs) || message.params.payload.expiresInMs < 1 || message.params.payload.expiresInMs > 86400000
        || !Number.isSafeInteger(message.params.payload.codeWorkflow.version) || message.params.payload.codeWorkflow.version < 1)
      || message.method !== 'integrations/services/code/read' && !message.params.operationId
      || ['integrations/services/code/start','integrations/services/code/revoke'].includes(message.method) && !message.params.expectedRevision)
      throw new IntegrationAdmissionError(-32602, 'NATIVE_CODE_SERVICE_REQUEST_INVALID');
  }
  if (capability === 'officeExportAcknowledgementV1' || capability === 'officeExportReceiptV1') {
    if (client?.officeWorkspaceV1 !== true || experimental?.officeWorkspaceV1 !== true
      || capability === 'officeExportAcknowledgementV1'
        && (client?.automationTemplatesV1 !== true || experimental?.automationTemplatesV1 !== true))
      throw new IntegrationAdmissionError();
    if (!message.params.operationId || !isContract('OfficeExportAcknowledgementParams', message.params.payload))
      throw new IntegrationAdmissionError(-32602, 'OFFICE_EXPORT_ACKNOWLEDGEMENT_INVALID');
  }

}
