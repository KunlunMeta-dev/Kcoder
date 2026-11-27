import type { InstalledPlugin } from '@/types/api'

function sourcePayload(plugin: InstalledPlugin): Record<string, unknown> {
  const payload = plugin.spec.sourcePayload
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function pluginMentionPath(plugin: InstalledPlugin): string | null {
  const payload = sourcePayload(plugin)
  const pluginName =
    (typeof payload.pluginName === 'string' && payload.pluginName.trim()) ||
    (typeof payload.remotePluginId === 'string' && payload.remotePluginId.trim()) ||
    plugin.spec.source.pluginKey
  const marketplaceName =
    (typeof payload.marketplaceName === 'string' && payload.marketplaceName.trim()) ||
    plugin.metadata.namespace
  if (typeof pluginName !== 'string' || !pluginName.trim()) return null
  if (typeof marketplaceName !== 'string' || !marketplaceName.trim()) return null
  return `plugin://${pluginName}@${marketplaceName}`
}

/** Explicit intent only; selecting a plugin never changes installation or permission state. */
export function pluginReference(plugin: InstalledPlugin): string | null {
  const path = pluginMentionPath(plugin)
  const name = plugin.spec.displayName || plugin.spec.source.pluginKey
  return path && name ? `[$${name}](${path})` : null
}
