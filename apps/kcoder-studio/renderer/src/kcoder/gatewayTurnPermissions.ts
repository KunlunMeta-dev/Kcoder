export function turnPermissionParams(
  execution: Record<string, unknown>,
  client: { supportsExperimental?: (name: string) => boolean }
): { permissionMode?: string } {
  const config = execution.model_config as Record<string, unknown> | undefined
  const mode = config?.permission_mode
  if (mode === undefined || mode === null || mode === 'default') return {}
  if (
    typeof mode !== 'string' ||
    !['ask', 'auto', 'accept_edits', 'dont_ask', 'bypass', 'yolo'].includes(mode)
  ) {
    throw new Error('Unsupported permission mode')
  }
  if (client.supportsExperimental?.('turnPermissions') !== true) {
    throw new Error(
      'This KCoder server does not support per-turn permissions. Update the server first.'
    )
  }
  return { permissionMode: mode }
}
