import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'

export function installedPluginTags(
  plugin: InstalledPlugin,
  catalog?: PluginMarketplaceItem
): string[] {
  const manifests = [plugin.spec.manifest, catalog?.manifest]
  return [
    ...new Set(
      manifests.flatMap(manifest => {
        const tags = manifest?.keywords ?? manifest?.tags
        return Array.isArray(tags)
          ? tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()))
          : []
      })
    ),
  ]
}
