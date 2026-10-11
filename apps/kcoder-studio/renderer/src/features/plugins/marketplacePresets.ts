import presets from './marketplacePresets.json'

export const marketplacePresets = presets

// Match repository identity, never a display name or a marketplace manifest ID.
export function canonicalMarketplaceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined
    if (url.hostname === 'work.trae.cn' && url.pathname.replace(/\/+$/, '') === '/marketplace')
      return 'https://api.trae.com.cn/extensions/api/-/plugin/list'
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
    if (url.hostname === 'github.com') {
      if (!/^\/[^/]+\/[^/]+$/.test(path)) return undefined
      return `https://github.com${path.toLowerCase()}`
    }
    return `${url.origin}${path}`
  } catch {
    return undefined
  }
}
