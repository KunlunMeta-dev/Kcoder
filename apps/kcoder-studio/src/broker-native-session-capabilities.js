// These settings need a dedicated native connection, not a shared backend.
const DEDICATED = Object.freeze([
  'approvalToolCallIdentityV1', 'disableUserElicitationV1', 'threadMcpServersV1',
  'migrationSourceTransferInternalV1',
  'migrationSourceTransferParentLaunchV1',
  'migrationSourceTransferTargetRecoveryV1',
  'migrationSourceTransferAttemptsV1',
  'migrationSourceTransferAssetIdentityV1',
  'migrationSourceTransferAdoptionV1',
  'migrationSourceTransferPrivateCredentialsV1',
  'migrationSourceTransferPrivateCredentialPreparationsV1',
  'migrationSourceTransferPrivateCredentialBundlesV1',
  'migrationSourceTransferPrivateCredentialSourceObservationV1',
]);

export function publicSharedCapabilities(experimental = {}) {
  const result = { ...experimental };
  for (const name of DEDICATED) delete result[name];
  return result;
}

export function requestsDedicatedCapabilities(params) {
  return DEDICATED.some(name => params?.capabilities?.experimental?.[name] === true);
}

export function requestsNativeManagement(params) {
  const flags = params?.capabilities?.experimental;
  return flags?.taskSourcesV1 === false && flags?.threadRuntimeHandoffV1 === false
    && flags?.gatewaySharedThreadsV1 !== true;
}

export function nativeManagementMethodAllowed(method) {
  return method === 'initialize' || method === 'initialized'
    || /^integrations\/(scope\/read|operation\/read|connectivity\/|services\/channel\/)/.test(method);
}

export function suppliesTemporaryThreadMcp(request) {
  if (request.method !== 'thread/start' || !Object.hasOwn(request.params ?? {}, 'mcpServers')) return false;
  return !Array.isArray(request.params.mcpServers) || request.params.mcpServers.length > 0;
}
