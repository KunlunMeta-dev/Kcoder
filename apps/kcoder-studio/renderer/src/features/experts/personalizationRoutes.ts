export interface ExpertSettingsScope {
  deviceId: string
  workspacePath: string
  expertId: string
}

export function expertPersonalizationRoute(scope: ExpertSettingsScope, tab = 'skills') {
  if (tab === 'channels') return channelConnectionsRoute(scope)
  return `/personalization/${tab}?${new URLSearchParams({ ...scope })}`
}

export function channelConnectionsRoute(scope?: { deviceId: string; workspacePath?: string }) {
  if (!scope?.deviceId) return '/channels'
  return `/channels?${new URLSearchParams({
    deviceId: scope.deviceId,
    ...(scope.workspacePath ? { workspacePath: scope.workspacePath } : {}),
  })}`
}

export function readExpertSettingsScope(search: string): ExpertSettingsScope | null {
  const query = new URLSearchParams(search)
  const deviceId = query.get('deviceId')
  const workspacePath = query.get('workspacePath')
  const expertId = query.get('expertId')
  return deviceId && workspacePath && expertId ? { deviceId, workspacePath, expertId } : null
}
