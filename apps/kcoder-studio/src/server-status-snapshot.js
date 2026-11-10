export function diagnosticBuildVersion(value) {
  return typeof value === "string" && value.length <= 128 &&
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : null;
}

export function diagnosticProtocolVersion(value) {
  return typeof value === "string" && value.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
    ? value
    : null;
}

export async function respondWithServerStatusSnapshot({
  response,
  sendJson,
  targets,
  statuses,
  statusScopes,
  currentScopeFor,
  accountIdentityFor,
  gatewayRuntimeVersion,
}) {
  const runtimeVersion = await gatewayRuntimeVersion();
  const targetsById = new Map(targets.map(target => [target.id, target]));
  const currentStatuses = statuses.map(item => {
    const target = targetsById.get(item.id);
    const originalScope = statusScopes.get(item.id);
    const scopeChanged = target?.security && originalScope !== currentScopeFor(target);
    const status = scopeChanged ? {
      id: item.id,
      status: "offline",
      latencyMs: 0,
      appServerVersion: null,
      protocolVersion: null,
      error: "账号状态在检查期间已变更，请重新检查",
    } : item;
    const accountIdentity = accountIdentityFor(item.id);
    return { ...status, ...(accountIdentity ? { accountIdentity } : {}) };
  });
  sendJson(response, 200, { gatewayRuntimeVersion: runtimeVersion, statuses: currentStatuses });
}
