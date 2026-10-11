import type { PluginMarketplaceItem } from '@/types/api'
import { pluginFailureDetails } from '@/components/plugins/plugin-errors'
import { credentialNames, type PluginActivationSnapshot } from './pluginLifecycle'

/** Credentials are recoverable configuration, unlike corrupt/unusable packages. */
export function needsPluginCredentials(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') return false
  const policy = (manifest as { installationAvailability?: { originalInstallPolicy?: unknown } })
    .installationAvailability?.originalInstallPolicy
  if (policy === 'NOT_AVAILABLE' || policy === 'not_available') return false
  const issues = (manifest as { compatibility?: { issues?: unknown } }).compatibility?.issues
  if (!Array.isArray(issues)) return false
  const blocks = issues.filter(
    issue => issue && typeof issue.code === 'string' && issue.code.startsWith('installation_')
  )
  const credential = (issue: { code: string; message?: unknown }) =>
    issue.code === 'installation_credentials' ||
    (issue.code === 'installation_configuration' &&
      typeof issue.message === 'string' &&
      /^MCP (?:environment variable `[^`]+` is not set|connector credential `[^`]+` is not configured)/.test(
        issue.message
      ))
  return blocks.length > 0 && blocks.every(credential)
}

/** Catalog strings remain quoted data. Do not forward manifests, headers or secrets. */
export function pluginInstallationContext(
  item: PluginMarketplaceItem,
  marketplace: {
    id: string
    name: string
    path?: string
    sourceUrl?: string
    manifestPath?: string
  },
  target: { deviceId?: string; workspacePath?: string }
) {
  const bounded = (value: string) => pluginFailureDetails(new Error(value)).slice(0, 2000)
  const source: Record<string, string> = {}
  const raw = item.manifest.source
  if (raw && typeof raw === 'object') {
    for (const key of ['type', 'url', 'path', 'ref_name', 'refName', 'sha', 'id', 'version']) {
      const value = (raw as Record<string, unknown>)[key]
      if (typeof value === 'string') source[key] = bounded(value)
    }
  }
  const compatibility = item.manifest.compatibility as
    { issues?: Array<{ code?: string; message?: string }> } | undefined
  const missing = (Array.isArray(compatibility?.issues) ? compatibility.issues : [])
    .filter(
      issue =>
        typeof issue?.code === 'string' &&
        ['installation_credentials', 'installation_configuration'].includes(issue.code)
    )
    .map(issue => (typeof issue.message === 'string' ? bounded(issue.message) : ''))
    .filter(Boolean)
  return JSON.stringify(
    {
      plugin: bounded(item.name),
      pluginId: bounded(String(item.id)),
      version: item.version ?? null,
      marketplace: bounded(marketplace.name),
      marketplaceId: bounded(marketplace.id),
      marketplaceAddress: marketplace.sourceUrl
        ? bounded(marketplace.sourceUrl)
        : marketplace.path?.startsWith('https://')
          ? bounded(marketplace.path)
          : null,
      marketplacePath: marketplace.manifestPath
        ? bounded(marketplace.manifestPath)
        : marketplace.path && !marketplace.path.startsWith('https://')
          ? bounded(marketplace.path)
          : null,
      source,
      target: target.deviceId ?? null,
      workspacePath: target.workspacePath ?? null,
      missingCredentials: missing,
      missingCredentialNames:
        pluginMissingCredentialSnapshot(item.manifest)?.components.flatMap(
          component => component.missingNames ?? []
        ) ?? [],
    },
    null,
    2
  )
}

/** Missing identifiers are configuration facts; credential values never belong here. */
export function pluginMissingCredentialSnapshot(
  manifest: unknown
): PluginActivationSnapshot | null {
  if (!needsPluginCredentials(manifest)) return null
  const value = manifest as {
    installationAvailability?: { missingNames?: unknown; credentialScope?: unknown }
    compatibility?: { issues?: Array<{ message?: string }> }
  }
  const declared = value.installationAvailability?.missingNames
  const names = credentialNames(
    Array.isArray(declared)
      ? declared
      : (value.compatibility?.issues ?? []).flatMap(issue => {
          const match =
            typeof issue.message === 'string'
              ? issue.message.match(/^MCP environment variable `([^`]+)` is not set/)
              : null
          return match ? [match[1]] : []
        })
  )
  return {
    generation: 0,
    ...(typeof value.installationAvailability?.credentialScope === 'string'
      ? { credentialScope: value.installationAvailability.credentialScope }
      : {}),
    phase: 'credentials_required',
    components: [
      { kind: 'mcp', name: 'credentials', phase: 'credentials_required', missingNames: names },
    ],
  }
}
