import type { PluginProxySettings } from '@/api/local/codexPlugins'

/** Optional fields preserve compatibility with targets exposing the original protocol. */
export type PluginProxyDiagnostics = PluginProxySettings & {
  source?: 'cache' | 'scan' | 'configured'
  targetHosts?: string[]
  checkedCandidates?: number
  quickChecks?: number
  cacheAgeMs?: number | null
  durationMs?: number
}

export function proxyDisplayUrl(value: string | null | undefined): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) return ''
    return `${url.protocol}//${url.host}`
  } catch {
    return ''
  }
}

export function proxyTargetHosts(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).flatMap(value => {
        try {
          const url = new URL(value)
          return url.protocol === 'https:' ? [url.host] : []
        } catch {
          return []
        }
      })
    ),
  ].slice(0, 9)
}
