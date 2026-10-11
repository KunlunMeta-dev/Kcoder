import { describe, expect, it } from 'vitest'
import { canonicalMarketplaceUrl, marketplacePresets } from './marketplacePresets'

describe('marketplace preset identity', () => {
  it('matches GitHub aliases without treating IDs or local paths as trusted sources', () => {
    expect(canonicalMarketplaceUrl('https://github.com/OpenAI/Plugins.git/')).toBe(
      'https://github.com/openai/plugins'
    )
    for (const source of [
      'openai-curated',
      '/cache/openai',
      'https://github.com/openai/plugins#branch',
      'https://user@github.com/openai/plugins',
      'http://github.com/openai/plugins',
    ]) {
      expect(canonicalMarketplaceUrl(source)).toBeUndefined()
    }
  })
  it('keeps mirror paths case sensitive and catalog identities unique', () => {
    const urls = marketplacePresets.map(preset => canonicalMarketplaceUrl(preset.url))
    expect(urls.every(Boolean)).toBe(true)
    expect(new Set(urls).size).toBe(urls.length)
    expect(canonicalMarketplaceUrl('https://mirror.example/Repo')).not.toBe(
      canonicalMarketplaceUrl('https://mirror.example/repo')
    )
  })
})
