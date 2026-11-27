import { pluginFailureDetails } from './plugin-errors'

const reasonKeys: Record<string, string> = {
  installation_package_integrity: 'pluginNetwork.blockedPackage',
  installation_missing_manifest: 'pluginNetwork.blockedManifest',
  installation_download_unverified: 'pluginNetwork.blockedDownload',
  installation_unsupported: 'pluginNetwork.blockedUnsupported',
  installation_credentials: 'pluginNetwork.blockedCredentials',
  installation_configuration: 'pluginNetwork.blockedConfiguration',
  installation_no_components: 'pluginNetwork.blockedEmpty',
  installation_unavailable: 'pluginNetwork.blockedPolicy',
}

export function marketplaceBlockReason(manifest: unknown) {
  if (!manifest || typeof manifest !== 'object') return undefined
  const compatibility = (manifest as { compatibility?: { issues?: unknown } }).compatibility
  if (!Array.isArray(compatibility?.issues)) return undefined
  for (const issue of compatibility.issues) {
    if (!issue || typeof issue !== 'object' || typeof issue.code !== 'string') continue
    const key = reasonKeys[issue.code]
    if (key)
      return {
        key,
        details:
          typeof issue.message === 'string' ? pluginFailureDetails(new Error(issue.message)) : '',
      }
  }
  return undefined
}
